import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'

export const WORKTREE_LINK_FILE_NAME = 'worktree-links.json'
const MAX_LINKS = 2000
const MAX_TEXT = 4096

export interface WorktreeLink {
  sessionId: string
  sessionFile: string
  worktree: string
  branch: string
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

export function sanitizeWorktreeLinkDocument(raw: unknown): WorktreeLinkDocument {
  const source = raw as { links?: unknown; updatedAt?: unknown } | null
  const list = Array.isArray(source?.links) ? source.links : []
  const links: WorktreeLink[] = []
  for (const item of list) {
    const x = item as Record<string, unknown> | null
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

  links(): WorktreeLink[] {
    return this.doc.links
  }

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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.doc = { version: 1, links: [], updatedAt: 0 }
    }
    this.loaded = true
    return this.doc
  }

  async link(input: {
    sessionId: string
    sessionFile?: string
    worktree: string
    branch?: string
    fromSessionId?: string
    fromSessionFile?: string
    fromCwd?: string
  }): Promise<{ ok: boolean; link?: WorktreeLink; error?: string }> {
    try {
      await this.load()
    } catch (error) {
      return { ok: false, error: `读取工作树关联表失败，未覆盖原数据：${error instanceof Error ? error.message : String(error)}` }
    }
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
      const tmp = `${file}.tmp`
      await writeFile(tmp, `${JSON.stringify(this.doc, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    }
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }
}
