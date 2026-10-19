import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parsePersistedDocument } from '../persisted-document'
import { writeFileDurable } from '../write-file-durable'
import { YAN_DIR } from '../paths'

export type CodeKind = 'session' | 'scheduled'

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

const CODE_KINDS: ReadonlySet<string> = new Set(['session', 'scheduled'])

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
  return `S${n}`
}

export interface SessionCodeStoreOptions {
  root?: string
  now?: () => number
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
