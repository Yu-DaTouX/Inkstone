/**
 * 会话稳定编号（v3 WP-10）。
 *
 * `YAN_DIR/session-codes.json` 维护 `scopeId → S数字 / T数字 / R数字`：
 *   · 会话：S12，按创建顺序递增、不复用；
 *   · 定时任务：T03；
 *   · 代码评审：R04；
 *   · 子 Agent 不占号，沿用父运行编号加 `·n`（由 registry 计算）。
 *
 * 编号**不写进 pi 会话文件**，只是砚自己的显示标识。首次启用 v3 时由上层调用
 * `backfill()` 按创建时间给旧会话补号。
 *
 * ── 失败语义 ──
 * 先落盘、成功后再提交内存（与 `space-store.ts` 一致）：写盘失败时编号不会
 * 先出现在内存里，registry 也就不会发布一个「其实没持久化」的编号。
 * 路径由调用方注入根目录，测试用隔离目录，绝不猜用户目录。
 */
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parsePersistedDocument } from '../persisted-document'
import { writeFileDurable } from '../write-file-durable'
import { YAN_DIR } from '../paths'

export type CodeKind = 'session' | 'scheduled' | 'review'

export interface SessionCodeEntry {
  scopeId: string
  kind: CodeKind
  code: string
  createdAt: number
}

export interface SessionCodeDocument {
  version: 1
  entries: SessionCodeEntry[]
}

export const SESSION_CODES_FILE = 'session-codes.json'

export function sessionCodesPath(root: string = YAN_DIR): string {
  return join(root, SESSION_CODES_FILE)
}

const CODE_KINDS: ReadonlySet<string> = new Set(['session', 'scheduled', 'review'])

function sanitizeEntry(raw: unknown): SessionCodeEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.scopeId !== 'string' || !o.scopeId.trim()) return null
  if (typeof o.kind !== 'string' || !CODE_KINDS.has(o.kind)) return null
  if (typeof o.code !== 'string' || !o.code.trim()) return null
  return {
    scopeId: o.scopeId.trim().slice(0, 200),
    kind: o.kind as CodeKind,
    code: o.code.trim().slice(0, 40),
    createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : Date.now()
  }
}

/** 读盘容错：坏条目丢掉，不让一份坏文档拦住启动。 */
export function sanitizeSessionCodes(raw: unknown): SessionCodeDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<SessionCodeDocument>) : {}
  const entries: SessionCodeEntry[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(source.entries) ? source.entries : []) {
    const entry = sanitizeEntry(item)
    if (!entry || seen.has(entry.scopeId)) continue
    seen.add(entry.scopeId)
    entries.push(entry)
  }
  return { version: 1, entries }
}

export function formatRunCode(kind: CodeKind, n: number): string {
  if (kind === 'scheduled') return `T${String(n).padStart(2, '0')}`
  if (kind === 'review') return `R${String(n).padStart(2, '0')}`
  return `S${n}`
}

export interface SessionCodeStoreOptions {
  root?: string
  now?: () => number
  /** 注入落盘实现（测试用）；缺省临时文件 + rename */
  write?: (path: string, text: string, mode: 'create') => Promise<void>
}

export class SessionCodeStore {
  private readonly root: string
  private readonly now: () => number
  private readonly write?: (path: string, text: string, mode: 'create') => Promise<void>
  private doc: SessionCodeDocument = { version: 1, entries: [] }
  private byScope = new Map<string, SessionCodeEntry>()
  private loadPromise?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: SessionCodeStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.write = options.write
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const text = await readFile(sessionCodesPath(this.root), 'utf8')
          this.commit(sanitizeSessionCodes(parsePersistedDocument(text, { entries: 'array' })))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.commit({ version: 1, entries: [] })
            return
          }
          throw new Error('会话编号文件读取或解析失败，已拒绝覆盖', { cause: error })
        }
      })()
    }
    return this.loadPromise
  }

  codeFor(scopeId: string): string | undefined {
    return this.byScope.get(scopeId)?.code
  }

  entries(): SessionCodeEntry[] {
    return [...this.doc.entries]
  }

  /** 分配或返回已有编号；首次落盘成功后才提交内存。 */
  assign(scopeId: string, kind: CodeKind, createdAt?: number): Promise<string> {
    const existing = this.byScope.get(scopeId)
    if (existing) return Promise.resolve(existing.code)
    return this.enqueue(async () => {
      await this.load()
      const cached = this.byScope.get(scopeId)
      if (cached) return cached.code
      const at = createdAt ?? this.now()
      const entry: SessionCodeEntry = { scopeId, kind, code: this.nextCode(kind), createdAt: at }
      const candidate: SessionCodeDocument = { version: 1, entries: [...this.doc.entries, entry] }
      await this.flush(candidate)
      this.commit(candidate)
      return entry.code
    })
  }

  /**
   * 按创建时间给旧会话补号；返回新分配的条数。已存在的编号不动。
   *
   * 确定性与安全边界：
   *   · 同一 scopeId 重复出现只取一条（createdAt 最早；再同则 kind 字典序），
   *     避免一次 backfill 给同一会话发出两个编号、白耗号段；
   *   · 排序用 createdAt + scopeId 作为稳定并列键，与输入顺序无关；
   *   · 编号取现有同类的最大号 +1，绝不与已有编号冲突；
   *   · 已存在的 scopeId 全部跳过，重复启动结果相同。
   */
  backfill(items: { scopeId: string; kind: CodeKind; createdAt: number }[]): Promise<number> {
    return this.enqueue(async () => {
      await this.load()
      const unique = new Map<string, { scopeId: string; kind: CodeKind; createdAt: number }>()
      for (const item of items) {
        if (!item.scopeId || this.byScope.has(item.scopeId)) continue
        const current = unique.get(item.scopeId)
        if (
          !current ||
          item.createdAt < current.createdAt ||
          (item.createdAt === current.createdAt && item.kind < current.kind)
        ) {
          unique.set(item.scopeId, item)
        }
      }
      const missing = [...unique.values()].sort(
        (a, b) => a.createdAt - b.createdAt || (a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0)
      )
      if (missing.length === 0) return 0
      const entries = [...this.doc.entries]
      for (const item of missing) {
        entries.push({ scopeId: item.scopeId, kind: item.kind, code: this.nextCode(item.kind, entries), createdAt: item.createdAt })
      }
      const candidate: SessionCodeDocument = { version: 1, entries }
      await this.flush(candidate)
      this.commit(candidate)
      return missing.length
    })
  }

  whenIdle(): Promise<void> {
    return this.tail.then(() => undefined)
  }

  private nextCode(kind: CodeKind, entries: SessionCodeEntry[] = this.doc.entries): string {
    let max = 0
    for (const entry of entries) {
      if (entry.kind !== kind) continue
      const n = Number.parseInt(entry.code.replace(/^[STR]/, ''), 10)
      if (Number.isFinite(n) && n > max) max = n
    }
    return formatRunCode(kind, max + 1)
  }

  private commit(doc: SessionCodeDocument): void {
    this.doc = doc
    this.byScope = new Map(doc.entries.map((entry) => [entry.scopeId, entry]))
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async flush(candidate: SessionCodeDocument): Promise<void> {
    const target = sessionCodesPath(this.root)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    const payload = JSON.stringify(candidate, null, 2)
    if (this.write) {
      await this.write(temp, payload, 'create')
    } else {
      await writeFileDurable(temp, payload)
    }
    try {
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
