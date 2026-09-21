/**
 * 「会话 ↔ 工作树」的来源关系（实施-07 S2 / 方案 §6.3 W2 的追溯那一半）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么单独一份，而不是复用会话链（`session-chains.json`）
 * ══════════════════════════════════════════════════════════
 * 会话链的语义是「**同一条会话**的多个段」（交接：后台两份、前端一条），
 * 它有一条硬不变式：**一个段只属于一条链**。而工作树这次是
 * 「A 会话派生出一个**新**会话 B，只是 B 在新目录里」—— 两者是**两条会话**，
 * 界面（侧栏）也必须当成两条。把 B 塞进 A 的链会同时破坏那条不变式与界面语义。
 *
 * 所以这里记的是一张旁挂表：新会话在工作树里、它从哪个会话的哪个目录派生。
 * 它只用于**追溯与展示**（「这个会话来自 feat-x 工作树」），不参与历史拼接。
 *
 * ⚠️ 与其它 store 同一条纪律：**不改写任何会话 JSONL**，只写
 * `YAN_DIR/worktree-links.json`；落盘失败必须让调用方知道（返回值里带 `error`），
 * 因为「界面说这是工作树会话、磁盘上没有」比「这次登记失败」糟得多。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'

/** 落盘文件名（测试与文档都按它找） */
export const WORKTREE_LINK_FILE_NAME = 'worktree-links.json'
/** 最多记多少条（与其它 store 同量级；超出丢最旧） */
const MAX_LINKS = 2000
/** 路径/字符串字段的长度上限（不可信输入从 IPC 进来） */
const MAX_TEXT = 4096

export interface WorktreeLink {
  /** 新的那个会话（它落在 `worktree` 里跑） */
  sessionId: string
  /** 新会话的 JSONL 绝对路径（pi 还没写文件时可以是空串） */
  sessionFile: string
  /** 工作树目录（= 新会话的 cwd） */
  worktree: string
  /** 工作树检出的分支（detached 时为空串） */
  branch: string
  /** 源会话（点「开新会话」之前用户所在的那个） */
  fromSessionId: string
  fromSessionFile: string
  fromCwd: string
  at: number
}

export interface WorktreeLinkDocument {
  version: 1
  links: WorktreeLink[]
  updatedAt: number
}

function text(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, MAX_TEXT)
}

/** 清洗一份文档（坏字段丢弃，不做任何猜测） */
export function sanitizeWorktreeLinkDocument(raw: unknown): WorktreeLinkDocument {
  const source = raw as { links?: unknown; updatedAt?: unknown } | null
  const list = Array.isArray(source?.links) ? source.links : []
  const links: WorktreeLink[] = []
  for (const item of list) {
    const x = item as Record<string, unknown> | null
    /* 会话 id 与工作树是这条记录的**身份**：缺了它这条记录没有意义，直接丢 */
    const sessionId = text(x?.sessionId)
    const worktree = text(x?.worktree)
    if (!sessionId || !worktree) continue
    links.push({
      sessionId,
      sessionFile: text(x?.sessionFile),
      worktree,
      branch: text(x?.branch),
      fromSessionId: text(x?.fromSessionId),
      fromSessionFile: text(x?.fromSessionFile),
      fromCwd: text(x?.fromCwd),
      at: Number.isFinite(x?.at) ? Number(x?.at) : 0
    })
  }
  return {
    version: 1,
    links: links.slice(-MAX_LINKS),
    updatedAt: Number.isFinite(source?.updatedAt) ? Number(source?.updatedAt) : 0
  }
}

export function worktreeLinkDocumentPath(root: string = YAN_DIR): string {
  return join(root, WORKTREE_LINK_FILE_NAME)
}

export interface WorktreeLinkStoreOptions {
  root?: string
  now?: () => number
}

/**
 * 一张内存表 + 一次落盘。写入串行化（`tail`），避免两次并发登记互相覆盖。
 */
export class WorktreeLinkStore {
  private readonly root: string
  private readonly now: () => number
  private doc: WorktreeLinkDocument = { version: 1, links: [], updatedAt: 0 }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: WorktreeLinkStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  /** 全部关系（界面用；调用前先 `load`） */
  links(): WorktreeLink[] {
    return this.doc.links
  }

  /** 某个会话作为**新**会话的那条关系（没有就返回 null） */
  forSession(sessionId: string): WorktreeLink | null {
    const id = text(sessionId)
    if (!id) return null
    for (let i = this.doc.links.length - 1; i >= 0; i -= 1) {
      if (this.doc.links[i].sessionId === id) return this.doc.links[i]
    }
    return null
  }

  async load(): Promise<WorktreeLinkDocument> {
    if (this.loaded) return this.doc
    try {
      const raw = await readFile(worktreeLinkDocumentPath(this.root), 'utf8')
      this.doc = sanitizeWorktreeLinkDocument(JSON.parse(raw))
    } catch {
      /* 文件不存在 / 坏了：当空表。关系丢了只是少一行追溯，不该让应用起不来 */
      this.doc = { version: 1, links: [], updatedAt: 0 }
    }
    this.loaded = true
    return this.doc
  }

  /**
   * 登记一条关系。幂等：同一个新会话再登记一次会**就地更新**
   * （pi 写文件之后我们才拿得到 `sessionFile`，那是同一条关系的信息补齐，
   * 不是第二条关系）。
   */
  async link(input: {
    sessionId: string
    sessionFile?: string
    worktree: string
    branch?: string
    fromSessionId?: string
    fromSessionFile?: string
    fromCwd?: string
  }): Promise<{ ok: boolean; link?: WorktreeLink; error?: string }> {
    await this.load()
    const sessionId = text(input.sessionId)
    const worktree = text(input.worktree)
    if (!sessionId || !worktree) return { ok: false, error: '会话 id 与工作树目录都不能为空' }

    const next: WorktreeLink = {
      sessionId,
      sessionFile: text(input.sessionFile),
      worktree,
      branch: text(input.branch),
      fromSessionId: text(input.fromSessionId),
      fromSessionFile: text(input.fromSessionFile),
      fromCwd: text(input.fromCwd),
      at: this.now()
    }
    const rest = this.doc.links.filter((x) => x.sessionId !== sessionId)
    this.doc = {
      version: 1,
      links: [...rest, next].slice(-MAX_LINKS),
      updatedAt: this.now()
    }
    try {
      await this.persist()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, link: next }
  }

  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      const file = worktreeLinkDocumentPath(this.root)
      await mkdir(dirname(file), { recursive: true })
      /* 先写临时文件再 rename：中途崩了也不会留下半个 JSON */
      const tmp = `${file}.tmp`
      await writeFile(tmp, `${JSON.stringify(this.doc, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    }
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }
}
