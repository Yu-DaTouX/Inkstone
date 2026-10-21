import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

export type SyncOutcome =
  | { ok: true; action: 'merged' | 'nothing'; detail?: string }
  | { ok: false; action: 'blocked'; detail: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : ''
}

export function isolationCwdKey(value: string): string {
  return String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function autoIsolationBranch(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
  return `yan/auto-${stamp}`
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
  private now: () => number
  private records: AutoIsolationRecord[] = []
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
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
    return this.records.find((r) => isolationCwdKey(r.worktree) === key) ?? null
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

  async markSynced(worktree: string): Promise<void> {
    await this.load()
    const key = isolationCwdKey(worktree)
    const hit = this.records.find((r) => isolationCwdKey(r.worktree) === key)
    if (!hit) return
    hit.syncedAt = this.now()
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

async function identityArgs(cwd: string): Promise<string[]> {
  const [email, name] = await Promise.all([
    gitRun(cwd, ['config', '--get', 'user.email'], { allowFailure: true, timeout: 10_000 }),
    gitRun(cwd, ['config', '--get', 'user.name'], { allowFailure: true, timeout: 10_000 })
  ])
  const args: string[] = []
  if (!email.stdout.trim()) args.push('-c', 'user.email=yan@localhost')
  if (!name.stdout.trim()) args.push('-c', 'user.name=Inkstone')
  return args
}

export async function isolateCwdForConflict(
  cwd: string,
  options: { sessionId?: string; now?: Date } = {}
): Promise<IsolationOutcome> {
  const dir = resolve(cwd)
  const repo = await resolveRepo(dir)
  if (!repo) {
    return { ok: false, reason: '这个目录不是 Git 仓库，没有安全的隔离与合并基线' }
  }
  const baseBranch = await currentBranch(repo.root)
  if (!baseBranch) {
    return { ok: false, reason: '主工作树处于 detached HEAD，无法确定该合回哪个分支' }
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
    return { ok: false, reason: created.failure?.message ?? '创建工作树失败' }
  }

  return {
    ok: true,
    record: {
      worktree: created.path,
      repoRoot: repo.root,
      mainCwd: dir,
      branch,
      baseBranch,
      sessionId: text(options.sessionId),
      createdAt: Date.now()
    }
  }
}

export async function syncIsolationBack(record: AutoIsolationRecord): Promise<SyncOutcome> {
  if (!existsSync(record.worktree)) {
    return { ok: false, action: 'blocked', detail: '隔离工作树已经不在磁盘上（可能已被移除）' }
  }
  const short = record.branch.replace(/^yan\/auto-/, '').slice(-6) || record.branch

  const dirty = await gitRun(record.worktree, ['status', '--porcelain'], { allowFailure: true, timeout: 30_000 })
  if (!dirty.ok) {
    return { ok: false, action: 'blocked', detail: dirty.error ?? '读不出隔离工作树的状态' }
  }
  if (dirty.stdout.trim()) {
    const add = await gitRun(record.worktree, ['add', '-A', '--', '.'], {
      allowFailure: true,
      timeout: GIT_WRITE_TIMEOUT
    })
    if (!add.ok) {
      return { ok: false, action: 'blocked', detail: add.error ?? '隔离工作树暂存失败' }
    }
    const commit = await gitRun(
      record.worktree,
      [
        ...(await identityArgs(record.worktree)),
        'commit',
        '--no-verify',
        '-m',
        `砚：隔离会话自动提交（${short}）`
      ],
      { allowFailure: true, timeout: GIT_WRITE_TIMEOUT }
    )
    if (!commit.ok) {
      return { ok: false, action: 'blocked', detail: commit.error ?? '隔离工作树自动提交失败' }
    }
  }

  const mainUnmerged = await gitRun(record.mainCwd, ['diff', '--name-only', '--diff-filter=U'], {
    allowFailure: true,
    timeout: 30_000
  })
  if (mainUnmerged.stdout.trim()) {
    return { ok: false, action: 'blocked', detail: '主工作目录还有未解决的冲突，先处理它' }
  }

  const ahead = await gitRun(record.mainCwd, ['rev-list', '--count', `HEAD..${record.branch}`], {
    allowFailure: true,
    timeout: 30_000
  })
  if (!ahead.ok) {
    return { ok: false, action: 'blocked', detail: ahead.error ?? `找不到隔离分支 ${record.branch}` }
  }
  if (Number(ahead.stdout.trim() || '0') === 0) {
    return { ok: true, action: 'nothing' }
  }

  const mainHead = await currentBranch(record.mainCwd)
  if (!mainHead || mainHead === record.branch) {
    return {
      ok: false,
      action: 'blocked',
      detail: `主工作目录当前在 ${mainHead || 'detached HEAD'}，与隔离分支不构成可合并的一对`
    }
  }
  if (record.baseBranch && mainHead !== record.baseBranch) {
    return {
      ok: false,
      action: 'blocked',
      detail: `主工作目录现在在 ${mainHead}，隔离基线是 ${record.baseBranch}；切回基线分支后会自动接着合回`
    }
  }

  const merge = await gitRun(
    record.mainCwd,
    [
      ...(await identityArgs(record.mainCwd)),
      'merge',
      '--no-ff',
      '--no-edit',
      '--no-verify',
      '-m',
      `砚：把隔离工作树 ${record.branch} 合回 ${mainHead}`,
      record.branch
    ],
    { allowFailure: true, timeout: GIT_WRITE_TIMEOUT }
  )
  if (!merge.ok) {
    await gitRun(record.mainCwd, ['merge', '--abort'], { allowFailure: true, timeout: 60_000 })
    return {
      ok: false,
      action: 'blocked',
      detail: (merge.error ?? '合并失败').split(/\r?\n/).slice(0, 4).join(' / ')
    }
  }
  return { ok: true, action: 'merged' }
}
