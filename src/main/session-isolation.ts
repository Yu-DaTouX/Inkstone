/**
 * 同一工作目录的会话冲突 → 自动隔离与自动合回。
 *
 * ══════════════════════════════════════════════════════════
 * 这个模块补的是哪一段
 * ══════════════════════════════════════════════════════════
 * `runners.ts` 有一条硬防线：**同一物理 cwd 不能同时跑两个会话**
 * （两个同时写文件的回合会互相覆盖）。用户想「同时开两份工作」时，那条防线
 * 只是一句报错，用户得自己去环境菜单建工作树、想分支名、再派生会话。
 *
 * 这里把它做成全自动：冲突时**换一个不冲突的物理目录继续**（仓库旁边的
 * `<仓库名>-worktrees/<分支>`），并在两边都空闲时把隔离分支的提交合回主干。
 *
 * ── 与另两条既有路径的边界（别合并）──
 *   · `subagent-isolation.ts`：**一次性**临时工作树，用完 `--force` + `rm -rf`
 *     丢掉。前提是「里面的改动全是这次任务产生的」。用户工作树的前提正好相反。
 *   · `git-worktree.ts` + 环境菜单：**用户手动**建的工作树，合并/删除都由用户
 *     点。这个模块复用它建树（同一套目录约定与分支校验），只是把「建 + 关联 +
 *     合回」自动化，且只处理**自己建的那几个**（`auto-isolation.json`）。
 *
 * ── 三条不变量 ──
 *   ① 主工作树的 index 与工作区**只在合并那一刻**被动过，且只在两边都空闲时；
 *      合并失败一律 `merge --abort`，不留半个合并态。
 *   ② 任何一步失败都**不会**把隔离目录里的东西丢掉 —— 最坏结果是「改动留在
 *      隔离工作树里」，用户可以在环境菜单里继续处理。
 *   ③ 不是 Git 仓库就**拒绝**（fail closed）：那种目录里没有安全的合并基线，
 *      退回「等它有空的伪隔离」比报错更糟。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gitRun, resolveRepo } from './git-service'
import { createWorktree } from './git-worktree'
import { YAN_DIR } from './paths'

export const AUTO_ISOLATION_FILE_NAME = 'auto-isolation.json'
const MAX_RECORDS = 500
const MAX_TEXT = 4096
/** 自动提交 / 合并的超时：用户可能挂了 pre-commit 之类的钩子 */
const GIT_WRITE_TIMEOUT = 120_000

export interface AutoIsolationRecord {
  /** 隔离工作树绝对路径（= 隔离会话的 cwd） */
  worktree: string
  /** 主仓库根（合并动作在 `mainCwd` 里做，这里只用于诊断与展示） */
  repoRoot: string
  /** 触发冲突的那个主工作目录 —— 合并目标 */
  mainCwd: string
  /** 隔离分支（`yan/auto-<时间戳>`） */
  branch: string
  /** 创建时主工作树检出的分支（detached 时拒绝创建，所以这里恒有值） */
  baseBranch: string
  /** 隔离会话的稳定 id；新会话在 pi 给出 id 之前是空串 */
  sessionId: string
  createdAt: number
  /** 最近一次成功合回的时间 */
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

/** 与 `runners.ts` 的并发边界同一套比较口径（斜杠、大小写、末尾分隔符） */
export function isolationCwdKey(value: string): string {
  return String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * 自动隔离用的分支名：`yan/auto-<yyyyMMdd-HHmmssSSS>`。
 *
 * 为什么带毫秒：同一秒内连着冲突两次（新建会话被连点）会撞名字，而
 * `createWorktree` 对已存在分支是**拒绝**而不是复用 —— 撞了就白跑一次。
 * `slugBranch` 会把 `/` 换成 `-` 当目录名，所以目录是
 * `<仓库名>-worktrees/yan-auto-<时间戳>`。
 */
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
    /* worktree / mainCwd / branch 是这条记录的身份：缺任一条都没有可执行的动作 */
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

export function autoIsolationDocumentPath(root: string = YAN_DIR): string {
  return join(root, AUTO_ISOLATION_FILE_NAME)
}

/**
 * 记录「哪些工作树是砚自动建的」。
 *
 * 为什么必须记：合并只对**砚自己建的**隔离分支生效。用户手动建的工作树
 *（环境菜单）里可能有他正在编的东西，自动合并过去等于替他做决定。
 */
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
      /* 文件不存在 / 坏了：当空表。丢的只是「自动合回」这条便利，会话本身不受影响 */
      this.records = []
    }
    this.loaded = true
    /* 磁盘上已经不在的工作树当场清掉：否则每次同步都要对着一个死路径跑 git */
    const alive = this.records.filter((r) => existsSync(r.worktree))
    if (alive.length !== this.records.length) {
      this.records = alive
      void this.persist().catch(() => undefined)
    }
    return this.records
  }

  /** 全部登记（自动合回扫一轮时用；调用前先 `load`） */
  async all(): Promise<AutoIsolationRecord[]> {
    return await this.load()
  }

  /** 按隔离工作树找（同步路径用：拿到某个 runner 的 cwd 后问「这是我建的吗」） */
  async byWorktree(cwd: string): Promise<AutoIsolationRecord | null> {
    const key = isolationCwdKey(cwd)
    if (!key) return null
    await this.load()
    return this.records.find((r) => isolationCwdKey(r.worktree) === key) ?? null
  }

  /** 按会话找：同一条会话再次撞到冲突时复用它已有的工作树，而不是再建一个 */
  async bySession(sessionId: string): Promise<AutoIsolationRecord | null> {
    const id = text(sessionId)
    if (!id) return null
    await this.load()
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i].sessionId === id && existsSync(this.records[i].worktree)) return this.records[i]
    }
    return null
  }

  async add(record: AutoIsolationRecord): Promise<void> {
    await this.load()
    this.records = this.records.filter((r) => isolationCwdKey(r.worktree) !== isolationCwdKey(record.worktree))
    this.records = [...this.records, record].slice(-MAX_RECORDS)
    await this.persist()
  }

  /** 新会话先建树、后拿到稳定 sessionId —— 拿到后补上，之后才能按会话找回它 */
  async bindSession(worktree: string, sessionId: string): Promise<void> {
    const id = text(sessionId)
    /* `pending:<runnerId>` 是 pi 报出真 id 之前的占位；绑它等于绑一个过期键 */
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

/** 主工作树当前检出的分支；detached / 读不到时返回空串 */
async function currentBranch(cwd: string): Promise<string> {
  const res = await gitRun(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true, timeout: 10_000 })
  return res.ok ? res.stdout.trim() : ''
}

/**
 * 缺身份时给一条固定的提交身份。
 *
 * 为什么要兜底：隔离分支上的提交是**砚自己**生成的（用户没敲过 commit），
 * 机器上没配 `user.email` 时整条自动合回链会卡死在一个与用户无关的报错上。
 * 只在缺配置时才补，不覆盖用户已有的身份。
 */
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

/**
 * 冲突时建一个隔离工作树。
 *
 * **故意不传 `createWorktree` 的忙碌闸门**：那个闸门是给「用户手动建树」用的
 *（此刻正有会话在跑，用户该等一等）；而这里的调用前提就是「主目录正忙」。
 * `git worktree add -b` 只写 refs 与 `.git/worktrees/*`，不碰主工作树的 index
 * 与工作区，也不做 carry（`carry: null`），所以在跑着的回合不会被改写。
 */
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
    /* 不带未提交改动：带过去再合回来会在主干上出现两份同样内容的改动 */
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

/**
 * 把隔离工作树里的东西合回主干。
 *
 * 顺序（每一步失败都**停在那里**，不往后走）：
 *   ① 工作树有改动 → 先自动提交（`--no-verify`：这是砚生成的检查点提交，
 *      不该触发用户给人工提交配的钩子）；
 *   ② 主干有未解决的冲突条目 → 拒绝（正在合并中的仓库不能被再合一次）；
 *   ③ `git merge --no-ff` 到主工作树当前分支；失败一律 `merge --abort`。
 *
 * 返回 `nothing` 表示「没有新东西可合」，不是失败 —— 每轮结束都会调一次。
 */
export async function syncIsolationBack(record: AutoIsolationRecord): Promise<SyncOutcome> {
  if (!existsSync(record.worktree)) {
    return { ok: false, action: 'blocked', detail: '隔离工作树已经不在磁盘上（可能已被移除）' }
  }
  const short = record.branch.replace(/^yan\/auto-/, '').slice(-6) || record.branch

  /* ① 工作树的改动先落成提交 —— 不提交就没法参与合并 */
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

  /* ② 主干正在合并中（有 unmerged 条目）时不能往上叠 */
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

  /* ③ 真合并。失败一律回滚，主工作树不留半个合并态 */
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
