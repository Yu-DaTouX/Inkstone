/**
 * **用户工作树**（方案 §6.2，W1）。
 *
 * ── 与子代理隔离工作树的区别（重要，别把两者合并）──
 * `subagent-isolation.ts` 建的是**一次性**工作树：`mkdtemp` 在系统临时目录、
 * `--detach`、用完 `git worktree remove --force` + `rm -rf` 容器。它的前提是
 * 「里面的东西都是这次任务产生的，可以无条件丢掉」。
 *
 * 用户工作树的前提**正好相反**：用户会在里面干活、改文件、提交。所以：
 *   · 建在**用户看得见**的地方（仓库旁边的 `<仓库名>-worktrees/<分支>`），
 *     不是临时目录 —— 关掉窗口它还在
 *   · 删除前**逐项检查**（有任务在跑 / 有未提交改动 / 有未推送提交）并拒绝，
 *     必要时让用户自己去处理
 *   · `git worktree remove` **不带 `--force`** —— 让 git 自己的检查兜最后一道
 *   · **绝不**复用 `cleanupWorkspace()`（那个函数就是 `--force` + `rm -rf`）
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { classifyGitFailure, validateBranchName } from '../shared/git-actions'
import type { GitFailure } from '../shared/git-actions'
import { gitRun, refExists, resolveRepo } from './git-service'

export interface WorktreeInfo {
  /** 绝对路径 */
  path: string
  /** HEAD 的 sha */
  head: string
  /** 分支名（detached 时为 null） */
  branch: string | null
  bare: boolean
  /** 仓库的主工作树（一个仓库只有一个，不能删） */
  main: boolean
  /** git 标记为 locked（用户手动锁过，说明有特殊用途） */
  locked: boolean
  /** 目录已经不在磁盘上（git 还记着） */
  prunable: boolean
  /** 看起来是**由砚创建**的（落在默认的 `<仓库名>-worktrees` 目录下） */
  ours: boolean
}

export interface WorktreeListing {
  ok: boolean
  repoRoot: string
  worktrees: WorktreeInfo[]
  error?: string
}

/**
 * 默认目标目录：**仓库旁边**的 `<仓库名>-worktrees/<分支 slug>`。
 *
 * 为什么不在临时目录（子代理那样）：用户要在里面长期干活，路径得找得到、
 * 关掉应用还在。为什么不放在仓库内部：那会让工作树出现在自己的父仓库里，
 * 变成未跟踪文件（还可能被下一次 `git add -A` 收进去）。
 */
export function defaultWorktreeContainer(repoRoot: string, repoName: string): string {
  return join(dirname(repoRoot), `${repoName}-worktrees`)
}

/**
 * 分支名 → 目录名。
 *
 * `feat/git-review` 这种带 `/` 的分支名如果直接当目录名，会在默认容器里
 * 多出一层（`feat/git-review`），用户看不见 `feat` 这层是怎么来的；
 * 而且 Windows 上还有一批非法字符。宁可 slug 之后再撞车（那由「目标已存在」
 * 拦下并让用户改名），也不要让路径结构随分支名的写法漂移。
 */
export function slugBranch(branch: string): string {
  const cleaned = String(branch ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 80)
  return cleaned || 'worktree'
}

/**
 * 解析 `git worktree list --porcelain -z` 的输出（纯解析，能单测）。
 *
 * ⚠️ `-z` 的语义是**每一行都以 NUL 结尾**（字段之间也是 NUL），
 * 不是「记录之间用 NUL、记录内部用换行」。按后者解析的话整份输出会被当成
 * 一条记录：只有第一条能认出来，`branch` 永远是 null —— 这个错误让
 * 「分支被其它工作树占用」不会亮、删除检查里的未推送判断被整段跳过。
 *
 * 这里外层按 NUL 切、内层再按换行切一次：两种格式都能吃（不同 git 版本
 * 与不同子命令的换行处理并不完全一致，多切一次没有代价）。
 */
export function parseWorktreeList(raw: string, containerHint: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  let cur: WorktreeInfo | null = null
  const flush = (): void => {
    if (cur) out.push(cur)
    cur = null
  }
  for (const nulChunk of String(raw ?? '').split('\0')) {
    for (const line of nulChunk.split('\n')) {
      if (!line) continue
      if (line.startsWith('worktree ')) {
        flush()
        const path = line.slice('worktree '.length).trim()
        cur = {
          path,
          head: '',
          branch: null,
          bare: false,
          main: false,
          locked: false,
          prunable: false,
          ours: isUnder(containerHint, path)
        }
        continue
      }
      if (!cur) continue
      if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length).trim()
      else if (line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      } else if (line === 'bare') cur.bare = true
      else if (line === 'detached') cur.branch = null
      else if (line.startsWith('locked')) cur.locked = true
      else if (line.startsWith('prunable')) cur.prunable = true
    }
  }
  flush()
  /* 第一条永远是主工作树（git 的约定） */
  if (out.length > 0) out[0].main = true
  return out
}

/** 路径是否在某个目录下（大小写与分隔符都归一化；Windows 上两者都会飘） */
function isUnder(parent: string, child: string): boolean {
  const norm = (v: string): string => resolve(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const p = norm(parent)
  const c = norm(child)
  return c === p || c.startsWith(`${p}/`)
}

/* ── 列表 ───────────────────────────────────────────────── */

export async function listWorktrees(cwd: string): Promise<WorktreeListing> {
  const repo = await resolveRepo(cwd)
  if (!repo) return { ok: false, repoRoot: '', worktrees: [], error: '这个目录不是 Git 仓库' }
  const res = await gitRun(repo.root, ['worktree', 'list', '--porcelain', '-z'], { allowFailure: true })
  if (!res.ok && !res.stdout) {
    return { ok: false, repoRoot: repo.root, worktrees: [], error: res.error ?? 'git worktree list 失败' }
  }
  const container = defaultWorktreeContainer(repo.root, repo.name)
  return { ok: true, repoRoot: repo.root, worktrees: parseWorktreeList(res.stdout, container) }
}

/* ── 创建 ───────────────────────────────────────────────── */

export interface CreateWorktreeRequest {
  cwd: string
  /** 新分支名 */
  branch: string
  /** 起点 ref；null = 当前 HEAD */
  startPoint: string | null
  /** 目标目录；null = 用默认容器 + slug */
  targetPath: string | null
}

export interface CreateWorktreeResult {
  ok: boolean
  failure?: GitFailure
  /** 新工作树的绝对路径（成功时） */
  path?: string
  branch?: string
  /** 提示语（例如「未提交改动不会自动带入」这类事实说明） */
  notes?: string[]
}

export async function createWorktree(
  request: CreateWorktreeRequest,
  hasRunningTask?: (cwd: string) => boolean
): Promise<CreateWorktreeResult> {
  const branch = String(request.branch ?? '').trim()
  const invalid = validateBranchName(branch)
  if (invalid) return { ok: false, failure: { code: 'invalid-input', message: invalid, retrySafe: true } }

  const repo = await resolveRepo(request.cwd)
  if (!repo) {
    return { ok: false, failure: { code: 'not-a-repo', message: '这个目录不是 Git 仓库', retrySafe: true } }
  }

  /*
   * 起点默认是**当前 HEAD**。方案 §6.2 要求「默认从已提交状态创建」——
   * 这正是 HEAD 的含义：工作区的未提交改动**不会**被带过去。
   * 这一点必须**明说**（返回 notes），否则用户会以为改动跟着过去了。
   */
  const startPoint = request.startPoint ? String(request.startPoint).trim() : 'HEAD'
  if (!(await refExists(repo.root, startPoint))) {
    return {
      ok: false,
      failure: { code: 'branch-missing', message: `起点不存在：${startPoint}`, retrySafe: true }
    }
  }

  /* 分支已存在时**不**自动复用：用户输入的是「新分支名」，静默改成检出别的分支
     是对输入的曲解。让他自己改名，或手动在终端里用已有的分支建工作树。 */
  if (await refExists(repo.root, branch)) {
    return {
      ok: false,
      failure: {
        code: 'branch-exists',
        message: `分支已经存在：${branch}`,
        hint: '换一个分支名；已经存在的分支要先在终端里用 git worktree add 检出',
        retrySafe: true
      }
    }
  }

  const container = defaultWorktreeContainer(repo.root, repo.name)
  const target = request.targetPath
    ? resolve(String(request.targetPath))
    : join(container, slugBranch(branch))

  if (existsSync(target)) {
    return {
      ok: false,
      failure: {
        code: 'path-rejected',
        message: `目标目录已经存在：${target}`,
        hint: '换一个目录，或先把那个目录移走',
        retrySafe: true
      }
    }
  }
  if (isUnder(repo.root, target)) {
    /* 放进仓库内部会变成未跟踪文件，还可能被后续 `git add -A` 收进去 */
    return {
      ok: false,
      failure: {
        code: 'path-rejected',
        message: '目标目录不能放在仓库内部',
        hint: `放在仓库旁边（默认是 ${container}）`,
        retrySafe: true
      }
    }
  }
  if (hasRunningTask?.(repo.root)) {
    return {
      ok: false,
      failure: {
        code: 'busy',
        message: '这个仓库有任务正在运行，等它跑完再建工作树',
        hint: '新建工作树会写 .git（refs 与 worktree 元数据），与正在跑的回合争同一份状态',
        retrySafe: true
      }
    }
  }

  const res = await gitRun(repo.root, ['worktree', 'add', '-b', branch, target, startPoint], {
    allowFailure: true,
    timeout: 120_000
  })
  if (!res.ok) {
    return { ok: false, failure: classifyGitFailure(res.stderr || res.stdout) }
  }

  return {
    ok: true,
    path: target,
    branch,
    notes: [
      `从 ${startPoint} 创建，未提交改动不会自动带入`,
      `工作树在仓库旁边独立存在：${target}`,
      '关掉砚不会删除它（要删除用「移除工作树」，那里会先检查未提交与未推送内容）'
    ]
  }
}

/* ── 删除 ───────────────────────────────────────────────── */

export interface RemoveWorktreeRequest {
  cwd: string
  /** 要删除的工作树路径（必须是 git 认识的那个） */
  path: string
  /** 顺便删掉分支（只在没有未合并内容时） */
  deleteBranch?: boolean
}

export interface WorktreeBlocker {
  kind: 'running' | 'dirty' | 'unpushed' | 'main' | 'locked' | 'missing'
  message: string
  /** 相关文件数 / 提交数这类可核对的数字 */
  count?: number
}

export interface RemoveWorktreeResult {
  ok: boolean
  failure?: GitFailure
  /** 拒绝的原因（可以多条）—— 界面要逐条显示，而不是一句「不能删」 */
  blockers?: WorktreeBlocker[]
  summary?: string
}

/**
 * 删除用户工作树。
 *
 * ── 与子代理那条路径的差别就是这里的全部意义 ──
 * `cleanupWorkspace()` 是 `worktree remove --force` + `rm -rf`：对一次性容器
 * 正确，对用户工作树等于**无声删掉人家没提交的活**。所以这里先查三件事，
 * 任何一条命中就**拒绝**并把原因列清楚，让用户自己去处理（我们不替他 stash、
 * 不替他提交、也不替他丢弃）。
 */
export async function removeWorktree(
  request: RemoveWorktreeRequest,
  hasRunningTask?: (cwd: string) => boolean
): Promise<RemoveWorktreeResult> {
  const repo = await resolveRepo(request.cwd)
  if (!repo) {
    return { ok: false, failure: { code: 'not-a-repo', message: '这个目录不是 Git 仓库', retrySafe: true } }
  }
  const listing = await listWorktrees(repo.root)
  if (!listing.ok) {
    return { ok: false, failure: { code: 'unknown', message: listing.error ?? '读不到工作树列表', retrySafe: true } }
  }
  const target = resolve(String(request.path ?? ''))
  const found = listing.worktrees.find((w) => resolve(w.path) === target)
  if (!found) {
    /* **只删 git 认识的工作树**：拿不到列表里的条目就拒绝，
       否则这个接口就成了「用任意路径删目录」 */
    return {
      ok: false,
      failure: {
        code: 'path-rejected',
        message: '这个路径不在仓库的工作树列表里',
        hint: '刷新一下工作树列表；砚只会删除 git 自己登记过的工作树',
        retrySafe: true
      }
    }
  }

  const blockers: WorktreeBlocker[] = []
  if (found.main) {
    blockers.push({ kind: 'main', message: '这是仓库的主工作树，不能通过砚删除' })
  }
  if (found.locked) {
    blockers.push({ kind: 'locked', message: '这个工作树被 git 锁定（locked），先解锁再删' })
  }
  if (hasRunningTask?.(found.path)) {
    blockers.push({ kind: 'running', message: '这个工作树里有任务正在运行' })
  }

  /* 目录已经不在了：让 git 清理登记即可，不需要检查内容 */
  if (!found.prunable) {
    const status = await gitRun(found.path, ['status', '--porcelain', '--untracked-files=all'], {
      allowFailure: true,
      timeout: 20_000
    })
    const dirty = status.stdout.split(/\r?\n/).filter((l) => l.trim()).length
    if (dirty > 0) {
      blockers.push({
        kind: 'dirty',
        message: '还有未提交的改动',
        count: dirty
      })
    }
    /*
     * 未推送：有 upstream 时数 `@{u}..HEAD`；没有 upstream 时**不能**假定
     * 「都没推过」也不能假定「都推过了」—— 只有本地分支存在就说明可能有内容，
     * 这种情况按「无法判断」列出来，让用户自己确认。
     */
    const upstream = await gitRun(found.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      allowFailure: true,
      timeout: 15_000
    })
    if (upstream.ok && upstream.stdout.trim()) {
      const ahead = await gitRun(found.path, ['rev-list', '--count', `@{u}..HEAD`], { allowFailure: true, timeout: 15_000 })
      const n = Number.parseInt(ahead.stdout.trim(), 10)
      if (Number.isFinite(n) && n > 0) {
        blockers.push({ kind: 'unpushed', message: '还有没推送的提交', count: n })
      }
    } else if (found.branch) {
      blockers.push({
        kind: 'unpushed',
        message: `分支 ${found.branch} 没有上游，无法判断是否有未推送的提交`
      })
    }
  }

  if (blockers.length > 0) {
    return {
      ok: false,
      blockers,
      failure: {
        code: 'busy',
        message: '有内容挡着这次删除，已列出原因',
        hint: '先处理它们（提交 / 推送 / 停掉任务），再回来删',
        retrySafe: true
      }
    }
  }

  const args = found.prunable ? ['worktree', 'prune'] : ['worktree', 'remove', found.path]
  const res = await gitRun(repo.root, args, { allowFailure: true, timeout: 60_000 })
  if (!res.ok) return { ok: false, failure: classifyGitFailure(res.stderr || res.stdout) }

  let summary = found.prunable ? '已清理失效的工作树登记' : '已移除工作树'
  if (request.deleteBranch && found.branch) {
    /* `-d` 而不是 `-D`：只删已经合并的分支，git 会替我们拦下未合并的 */
    const del = await gitRun(repo.root, ['branch', '-d', found.branch], { allowFailure: true, timeout: 20_000 })
    if (del.ok) summary += `，并删除了分支 ${found.branch}`
    else summary += `（分支 ${found.branch} 没有删除：${(del.stderr || '').trim().split('\n')[0] || '未合并'}）`
  }
  return { ok: true, summary }
}
