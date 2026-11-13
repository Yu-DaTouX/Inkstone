import { pick } from '../shared/ui-lang'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gitRun, resolveRepo } from './git-service'
import { createWorktree } from './git-worktree'
import { YAN_DIR } from './paths'

const AUTO_ISOLATION_FILE_NAME = 'auto-isolation.json'
const MAX_RECORDS = 500
const MAX_TEXT = 4096
const GIT_WRITE_TIMEOUT = 120_000

export interface AutoIsolationRecord {
  worktree: string
  repoRoot: string
  mainCwd: string
  branch: string
  baseBranch: string
  sessionId: string
  createdAt: number
  syncedAt?: number
}

export type IsolationOutcome =
  | { ok: true; record: AutoIsolationRecord }
  | { ok: false; reason: string }

export type PendingChanges =
  | { ok: true; files: number; commits: number }
  | { ok: false; detail: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : ''
}

export function isolationCwdKey(value: string): string {
  return String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function isolatedSessionCwd(record: Pick<AutoIsolationRecord, 'worktree' | 'repoRoot' | 'mainCwd'>): string {
  if (!record.repoRoot) return record.worktree
  const sub = relative(resolve(record.repoRoot), resolve(record.mainCwd))
  if (!sub || sub.startsWith('..') || isAbsolute(sub)) return record.worktree
  return join(record.worktree, sub)
}

export function autoIsolationBranch(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
  return `Inkstone/${stamp}`
}

export function sanitizeAutoIsolationDocument(raw: unknown): { version: 1; records: AutoIsolationRecord[] } {
  const source = raw as { records?: unknown } | null
  const list = Array.isArray(source?.records) ? source.records : []
  const records: AutoIsolationRecord[] = []
  for (const item of list) {
    const x = item as Record<string, unknown> | null
    const worktree = text(x?.worktree)
    const mainCwd = text(x?.mainCwd)
    const branch = text(x?.branch)
    if (!worktree || !mainCwd || !branch) continue
    records.push({
      worktree,
      repoRoot: text(x?.repoRoot),
      mainCwd,
      branch,
      baseBranch: text(x?.baseBranch),
      sessionId: text(x?.sessionId),
      createdAt: Number.isFinite(x?.createdAt) ? Number(x?.createdAt) : 0,
      ...(Number.isFinite(x?.syncedAt) ? { syncedAt: Number(x?.syncedAt) } : {})
    })
  }
  return { version: 1, records: records.slice(-MAX_RECORDS) }
}

function autoIsolationDocumentPath(root: string = YAN_DIR): string {
  return join(root, AUTO_ISOLATION_FILE_NAME)
}

export class AutoIsolationStore {
  private readonly root: string
  private records: AutoIsolationRecord[] = []
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? YAN_DIR
  }

  async load(): Promise<AutoIsolationRecord[]> {
    if (this.loaded) return this.records
    try {
      const raw = await readFile(autoIsolationDocumentPath(this.root), 'utf8')
      this.records = sanitizeAutoIsolationDocument(JSON.parse(raw)).records
    } catch {
      this.records = []
    }
    this.loaded = true
    const alive = this.records.filter((r) => existsSync(r.worktree))
    if (alive.length !== this.records.length) {
      this.records = alive
      void this.persist().catch(() => undefined)
    }
    return this.records
  }

  async all(): Promise<AutoIsolationRecord[]> {
    return await this.load()
  }

  async byWorktree(cwd: string): Promise<AutoIsolationRecord | null> {
    const key = isolationCwdKey(cwd)
    if (!key) return null
    await this.load()
    return this.records.find((r) => isolationCwdKey(r.worktree) === key || isolationCwdKey(isolatedSessionCwd(r)) === key) ?? null
  }

  async bySession(sessionId: string): Promise<AutoIsolationRecord | null> {
    const id = text(sessionId)
    if (!id) return null
    await this.load()
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i].sessionId === id) return this.records[i]
    }
    return null
  }

  async add(record: AutoIsolationRecord): Promise<void> {
    await this.load()
    this.records = this.records.filter((r) => isolationCwdKey(r.worktree) !== isolationCwdKey(record.worktree))
    this.records = [...this.records, record].slice(-MAX_RECORDS)
    await this.persist()
  }

  async bindSession(worktree: string, sessionId: string): Promise<void> {
    const id = text(sessionId)
    if (!id || id.startsWith('pending:')) return
    await this.load()
    const key = isolationCwdKey(worktree)
    const hit = this.records.find((r) => isolationCwdKey(r.worktree) === key)
    if (!hit || hit.sessionId === id) return
    hit.sessionId = id
    await this.persist()
  }

  async remove(worktree: string): Promise<void> {
    await this.load()
    const key = isolationCwdKey(worktree)
    const next = this.records.filter((r) => isolationCwdKey(r.worktree) !== key)
    if (next.length === this.records.length) return
    this.records = next
    await this.persist()
  }

  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      const file = autoIsolationDocumentPath(this.root)
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, `${JSON.stringify({ version: 1, records: this.records }, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    }
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }
}

async function currentBranch(cwd: string): Promise<string> {
  const res = await gitRun(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true, timeout: 10_000 })
  return res.ok ? res.stdout.trim() : ''
}

export async function isolateCwdForConflict(
  cwd: string,
  options: { sessionId?: string; now?: Date } = {}
): Promise<IsolationOutcome> {
  const dir = resolve(cwd)
  const repo = await resolveRepo(dir)
  if (!repo) {
    return { ok: false, reason: pick('这个文件夹不是 Git 仓库，开不了工作树', 'This folder is not a Git repository, so a worktree cannot be opened') }
  }
  const baseBranch = await currentBranch(repo.root)
  if (!baseBranch) {
    return { ok: false, reason: pick('项目当前在 detached HEAD 上，先切到一个分支再开工作树', 'The project is on a detached HEAD; switch to a branch before opening a worktree') }
  }

  const branch = autoIsolationBranch(options.now ?? new Date())
  const created = await createWorktree({
    cwd: repo.root,
    branch,
    startPoint: null,
    targetPath: null,
    carry: null
  })
  if (!created.ok || !created.path) {
    return { ok: false, reason: created.failure?.message ?? pick('创建工作树失败', 'Failed to create worktree') }
  }

  const record: AutoIsolationRecord = {
    worktree: created.path,
    repoRoot: repo.root,
    mainCwd: dir,
    branch,
    baseBranch,
    sessionId: text(options.sessionId),
    createdAt: Date.now()
  }
  await mkdir(isolatedSessionCwd(record), { recursive: true }).catch(() => undefined)
  return { ok: true, record }
}

export async function discardUnusedIsolation(record: AutoIsolationRecord): Promise<boolean> {
  if (existsSync(record.worktree)) {
    const dirty = await gitRun(record.worktree, ['status', '--porcelain'], { allowFailure: true, timeout: 30_000 })
    if (!dirty.ok || dirty.stdout.trim()) return false
    const ahead = await gitRun(record.mainCwd, ['rev-list', '--count', `${record.baseBranch || 'HEAD'}..${record.branch}`], {
      allowFailure: true,
      timeout: 30_000
    })
    if (!ahead.ok || Number(ahead.stdout.trim() || '0') > 0) return false
    const removed = await gitRun(record.repoRoot, ['worktree', 'remove', record.worktree], { allowFailure: true, timeout: GIT_WRITE_TIMEOUT })
    if (!removed.ok) return false
  }
  await gitRun(record.repoRoot, ['branch', '-d', record.branch], { allowFailure: true, timeout: 30_000 })
  return true
}

const GONE = (): string => pick('隔离工作树已经不在磁盘上（可能已被移除）', 'The isolated worktree is no longer on disk (it may have been removed)')

export async function pendingIsolationChanges(record: AutoIsolationRecord): Promise<PendingChanges> {
  if (!existsSync(record.worktree)) return { ok: false, detail: GONE() }
  const dirty = await gitRun(record.worktree, ['status', '--porcelain'], { allowFailure: true, timeout: 30_000 })
  if (!dirty.ok) return { ok: false, detail: dirty.error ?? pick('读不出隔离工作树的状态', 'Cannot read the isolated worktree status') }
  const files = dirty.stdout.split(/\r?\n/).filter((line) => line.trim()).length
  const base = record.baseBranch || 'HEAD'
  const ahead = await gitRun(record.repoRoot || record.mainCwd, ['rev-list', '--count', `${base}..${record.branch}`], {
    allowFailure: true,
    timeout: 30_000
  })
  if (!ahead.ok) return { ok: false, detail: ahead.error ?? pick(`找不到隔离分支 ${record.branch}`, `Isolated branch ${record.branch} not found`) }
  return { ok: true, files, commits: Number(ahead.stdout.trim() || '0') }
}
