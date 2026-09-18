/**
 * Git **写操作**（方案 §5，G2 阶段）。
 *
 * ── 与只读层的边界 ──
 * `git-service.ts` / `git-diff.ts` 保证「打开审查不会改任何东西」，
 * 它们里面**没有** `add` / `commit` / `switch` / `reset` / `stash`。
 * 写操作全部集中在**本文件**，只有它一个地方会改用户的 index / HEAD / 远程。
 * 这样「哪些代码能改用户的东西」是一个可以一眼答完的问题。
 *
 * ── 四条不可绕过的约束（方案 §5.4）──
 *   1. **按仓库串行**：同一个 `repoId`（= `.git` 共同目录，所以多工作树共享）
 *      的写操作排队执行。两个写操作并发跑 git 会撞 index.lock，而且失败信息
 *      对用户毫无意义。
 *   2. **执行前复核预期版本**：请求带着用户「看着的那份状态」的摘要，
 *      不一致就**不执行**并返回 `stale`。这是「不提交用户尚未审阅的新增内容」
 *      的实现方式 —— 不是靠界面刷新得快。
 *   3. **不覆盖用户改动**：不 stash、不 reset、不 clean、不 force push。
 *      脏工作区能不能切分支由 **git 自己**判（`dirty-blocks-switch` 分类原样转述它）。
 *   4. **超时后不无条件重试**：超时/取消之后重新读 HEAD，把「提交到底完成没有」
 *      查清楚再答复（`committed` 字段），因为 git 可能已经写完 HEAD 才被杀掉。
 */
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { GitRepoState } from '../shared/git'
import { remoteWebUrl } from '../shared/git'
import {
  buildCommitArgs,
  buildCreateBranchArgs,
  buildFetchArgs,
  buildPushArgs,
  buildSetUpstreamAfterCreateArgs,
  buildStageAllArgs,
  buildStageArgs,
  buildSwitchArgs,
  buildUnstageAllArgs,
  buildUnstageArgs,
  classifyGitFailure,
  expectedMismatch,
  hookFailure,
  MAX_ACTION_PATHS,
  staleFailure,
  summarizeFiles,
  timeoutFailure,
  validateBranchName,
  validateCommitMessage
} from '../shared/git-actions'
import type { GitActionExpected, GitActionRequest, GitActionResult, GitFailure } from '../shared/git-actions'
import { gitRun, readExpected, readRepoState, refExists, resolveRepo, safeRepoPath } from './git-service'
import type { RepoIdentity } from './git-service'

/** 写操作的超时：比只读宽松 —— hook、签名、远程握手都可能慢 */
const WRITE_TIMEOUT = 120_000
/** push / fetch 单独一层：网络不可达时不该让用户等两分钟 */
const NETWORK_TIMEOUT = 90_000

let ctx: WriteContext = {}

/**
 * 由 `index.ts` 在注册 IPC 时注入（只有它拿得到 runner 状态）。
 */
export function configureWriteContext(next: WriteContext): void {
  ctx = next
}

export interface WriteContext {
  /**
   * 该目录有没有**运行中的会话任务**。
   *
   * 切分支会把工作区文件整片换掉，而一个正在跑的模型回合可能正在读写这些文件 ——
   * 结果是一堆看起来像「模型改坏了代码」的怪现象。所以切换前必须问一次，
   * 由 `index.ts` 注入（它才拿得到 runner 状态）。
   * 不注入时（单测）视为没有运行任务。
   */
  hasRunningTask?: (cwd: string) => boolean
}

/* ── 按仓库串行 ─────────────────────────────────────────── */

/*
 * 队列按 `repoId` 分。为什么不是 `worktreeId`：index 是每个工作树独立
 * 的，但 refs / 对象库 / `.git` 共同目录是共享的 —— 两个工作树同时提交
 * 会争 refs 锁。方案 §5.4 说的「按仓库协调」就是这个粒度。
 *
 * 前一个失败**不能**卡住后面：用 `prev.then(fn, fn)`，失败与成功都继续。
 */
const queues = new Map<string, Promise<unknown>>()

function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(repoId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  /* 存一个吞掉异常的尾巴，避免 unhandledRejection；调用方仍拿到真实结果 */
  queues.set(
    repoId,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

/** 仅供测试：清掉队列（不影响 git 状态） */
export function clearWriteQueues(): void {
  queues.clear()
}

/* ── 预期版本 ───────────────────────────────────────────── */

/*
 * `readExpected` 定义在 git-service.ts 里 —— 只读的审查快照也要带上它
 * （写请求的「预期版本」必须与用户看到的那份清单**同源**，否则复核会
 * 变成比两份不同时刻的数据）。这里只是转发，方便单测从一处 import。
 */
export { readExpected } from './git-service'

/**
 * 复核；不一致就返回 stale 失败（**不执行任何写操作**）。
 *
 * ── 分级（每一级都是真实运行逼出来的）──
 * 「预期版本」只该保护**这个动作真正依赖的那部分状态**：
 *
 *   · `full`（HEAD + index + 工作区）→ 只给 `commit`。它是唯一会把用户
 *     没看过的内容写进历史的动作，预览与将要提交的东西必须一致（方案 §5.2）
 *   · `head` → 给「未指定起点的新建分支」（新分支从 HEAD 长出来）
 *   · `none` → 暂存 / 取消暂存 / 切换分支 / 拉取 / 推送。它们要么幂等，
 *     要么完全由 git 自己的检查兜住（切换的脏工作区、推送的非快进）
 *
 * 初版是「每个动作都比三件套」，结果：连点两个文件的「暂存」，第二个必被
 * 拒（index 被第一个自己改了）；提交后立刻推送也必被拒（HEAD 被提交自己
 * 改了）。那是假冲突 —— 代价不是更安全，而是用户学会无视这句提示。
 */
type GuardLevel = "none" | "head" | "full"

async function guardExpected(
  root: string,
  expected: GitActionExpected,
  level: GuardLevel = "none"
): Promise<GitFailure | null> {
  if (level === "none") return null
  const actual = await readExpected(root)
  if (level === "head") {
    if (expected.head === actual.head) return null
    return staleFailure(["HEAD"])
  }
  const changed = expectedMismatch(expected, actual)
  if (!changed) return null
  return staleFailure(changed)
}

/* ── 公共脚手架 ─────────────────────────────────────────── */

/*
 * 用判别式联合而不是「可选字段」：调用方写 `if (!prep.ok) return` 时
 * TypeScript 能免费收窄出 `repo` 是否存在。
 */
type PrepareResult = { ok: true; repo: RepoIdentity } | { ok: false; failure: GitFailure }

/**
 * 每个动作的第一步：定位仓库。
 *
 * 复核**不在这里** —— 各动作要复核到哪一级不一样（见 GuardLevel），
 * 而且必须在**拿到锁之后**再比：等锁的这段时间里别人可能已经动过。
 */
async function prepare(cwd: string): Promise<PrepareResult> {
  const repo = await resolveRepo(cwd)
  if (!repo) {
    return {
      ok: false,
      failure: { code: "not-a-repo", message: "这个目录不是 Git 仓库", retrySafe: true }
    }
  }
  return { ok: true, repo }
}

/** 动作收尾：读一次新状态（界面直接用它，省一次往返，也不会闪一下旧数据） */
async function finish(
  repo: RepoIdentity,
  headBefore: string | null,
  summary: string,
  extra: Partial<GitActionResult> = {}
): Promise<GitActionResult> {
  const state: GitRepoState | null = await readRepoState(repo.root).catch(() => null)
  return {
    ok: true,
    summary,
    headBefore,
    headAfter: state?.head ?? null,
    ...(state ? { state } : {}),
    ...extra
  }
}

/**
 * 跑一条写命令，把失败分类。
 *
 * 分类不中时**不**用兜底文案代替 git 原文：原文永远在 `detail` 里，
 * 它才是排查的第一现场。
 */
async function runWrite(
  root: string,
  args: string[],
  opts: { timeout?: number } = {}
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; failure: GitFailure; timedOut: boolean }> {
  try {
    const res = await gitRun(root, args, {
      allowFailure: true,
      timeout: opts.timeout ?? WRITE_TIMEOUT
    })
    if (res.ok) return { ok: true, stdout: res.stdout, stderr: res.stderr }
    return { ok: false, failure: classifyGitFailure(res.stderr || res.stdout), timedOut: false }
  } catch (error) {
    /*
     * 走到这里说明 execFile 自己抛了（超时被 kill、进程起不来）。
     * 超时**不告诉用户「失败了」** —— 后面每个动作会重新读 HEAD，
     * 用实际状态说话（方案 §5.4）。
     */
    const message = String((error as { message?: unknown }).message ?? error)
    const timedOut = /timed? ?out|killed|SIGTERM/i.test(message)
    return {
      ok: false,
      failure: timedOut ? timeoutFailure(message) : classifyGitFailure(message),
      timedOut
    }
  }
}

/* ── 暂存 / 取消暂存 ────────────────────────────────────── */

function normalizePaths(paths: unknown): { paths: string[]; rejected: string[] } {
  const list = Array.isArray(paths) ? paths : []
  const out: string[] = []
  const rejected: string[] = []
  for (const raw of list.slice(0, MAX_ACTION_PATHS)) {
    const safe = safeRepoPath(String(raw ?? ''))
    if (!safe) rejected.push(String(raw ?? ''))
    else out.push(safe)
  }
  if (list.length > MAX_ACTION_PATHS) rejected.push(`（超过 ${MAX_ACTION_PATHS} 个的上限）`)
  return { paths: out, rejected }
}

async function stageOrUnstage(
  request: Extract<GitActionRequest, { kind: 'stage' | 'unstage' }>
): Promise<GitActionResult> {
  const prep = await prepare(request.cwd)
  if (!prep.ok) return { ok: false, failure: prep.failure }
  const repo = prep.repo

  const { paths, rejected } = normalizePaths(request.paths)
  if (paths.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'path-rejected',
        message: rejected.length ? '路径不合法或不在仓库内' : '没有选中文件',
        ...(rejected.length ? { detail: rejected.join('\n') } : {}),
        retrySafe: true
      }
    }
  }

  return withRepoLock(repo.repoId, async () => {

    const state = await readRepoState(repo.root)
    const headBefore = state?.head ?? null
    const hasHead = !!state?.hasCommit
    const args = request.kind === 'stage' ? buildStageArgs(paths) : buildUnstageArgs(paths, hasHead)
    const res = await runWrite(repo.root, args, { timeout: 30_000 })
    if (!res.ok) return { ok: false, failure: res.failure, headBefore, headAfter: headBefore }

    const verb = request.kind === 'stage' ? '已暂存' : '已取消暂存'
    return finish(repo, headBefore, summarizeFiles(verb, paths))
  })
}

async function stageOrUnstageAll(
  request: Extract<GitActionRequest, { kind: 'stage-all' | 'unstage-all' }>
): Promise<GitActionResult> {
  const prep = await prepare(request.cwd)
  if (!prep.ok) return { ok: false, failure: prep.failure }
  const repo = prep.repo

  return withRepoLock(repo.repoId, async () => {

    const state = await readRepoState(repo.root)
    const headBefore = state?.head ?? null
    const hasHead = !!state?.hasCommit
    const args = request.kind === 'stage-all' ? buildStageAllArgs() : buildUnstageAllArgs(hasHead)
    const res = await runWrite(repo.root, args, { timeout: 60_000 })
    if (!res.ok) return { ok: false, failure: res.failure, headBefore, headAfter: headBefore }

    return finish(repo, headBefore, request.kind === 'stage-all' ? '已暂存全部变更' : '已取消暂存全部变更')
  })
}

/* ── 提交 ───────────────────────────────────────────────── */

/*
 * 只在**失败且分类不出来**的时候查一次 hook。
 *
 * 为什么不能无条件猜「是 hook 拦的」：那就成了编原因，会把用户引向错的方向。
 * 为什么又值得查：真 git 在 pre-commit 拒绝时只透传 hook 自己的输出
 * （2026-09-18 实测：hook 里 echo 一句 + exit 1，git 的 stderr 就是那一句，
 * 没有任何前缀），于是最常见的失败原因反而落进 `unknown` —— 用户看到
 * 「Git 操作失败」而真正的问题是那句他还没读的输出。文件在不在是**事实**。
 */
const HOOK_NAMES = ['pre-commit', 'prepare-commit-msg', 'commit-msg']

async function maybeHookFailure(root: string, failure: GitFailure): Promise<GitFailure> {
  if (failure.code !== 'unknown') return failure
  const found: string[] = []
  for (const name of HOOK_NAMES) {
    const res = await gitRun(root, ['rev-parse', '--git-path', `hooks/${name}`], {
      allowFailure: true,
      timeout: 8000
    })
    if (!res.ok) continue
    const rel = res.stdout.trim()
    if (!rel) continue
    const abs = isAbsolute(rel) ? rel : resolve(root, rel)
    if (await stat(abs).then((s) => s.isFile(), () => false)) found.push(name)
  }
  if (found.length === 0) return failure
  return hookFailure(failure.detail ?? '', found)
}

/**
 * 提交。
 *
 * 提交是**唯一**能产生历史记录的动作，所以这里做了三层：
 *   1. 说明非空（本地校验，不是让 git 报英文错）
 *   2. 预期版本复核（`full`）—— 尤其 `indexDigest`：用户点提交时看到的预览
 *      必须就是将要提交的内容
 *   3. 超时后重新读 HEAD，用它判断「到底提交成功没有」
 */
async function commitChanges(request: Extract<GitActionRequest, { kind: 'commit' }>): Promise<GitActionResult> {
  const invalid = validateCommitMessage(request.message)
  if (invalid) return { ok: false, failure: invalid }

  const prep = await prepare(request.cwd)
  if (!prep.ok) return { ok: false, failure: prep.failure }
  const repo = prep.repo

  return withRepoLock(repo.repoId, async () => {
    const stale = await guardExpected(repo.root, request.expected, 'full')
    if (stale) return { ok: false, failure: stale }

    const before = await readExpected(repo.root)
    const res = await runWrite(repo.root, buildCommitArgs(request.message))

    if (!res.ok) {
      /*
       * 超时 / 被杀：**先查实际状态再下结论**。
       * git 可能已经更新了 HEAD（hook 跑完、对象写完），这时报「失败」
       * 会让用户再提交一次，产生第二个提交。
       */
      if (res.timedOut) {
        const after = await readExpected(repo.root)
        const committed = after.head !== before.head
        const state = await readRepoState(repo.root).catch(() => null)
        return {
          ok: false,
          failure: committed
            ? {
                code: 'timeout',
                message: '操作超时，但提交**已经完成**',
                hint: '不需要再提交一次；刷新看历史即可',
                retrySafe: false
              }
            : res.failure,
          headBefore: before.head,
          headAfter: after.head,
          committed,
          ...(committed && state?.head ? { commit: shortOf(state.head) } : {}),
          ...(state ? { state } : {})
        }
      }
      return {
        ok: false,
        failure: await maybeHookFailure(repo.root, res.failure),
        headBefore: before.head,
        headAfter: before.head
      }
    }

    const state = await readRepoState(repo.root).catch(() => null)
    const head = state?.head ?? null
    /* git 成功时 stdout 是 `[main abc1234] 说明`，用它取 short sha 最直接 */
    const fromStdout = /\[[^\]]*?([0-9a-f]{7,40})\]/.exec(res.stdout)?.[1] ?? null
    return {
      ok: true,
      summary: '已提交',
      headBefore: before.head,
      headAfter: head,
      committed: true,
      commit: fromStdout ?? (head ? shortOf(head) : null),
      ...(state ? { state } : {})
    }
  })
}

function shortOf(head: string): string {
  return head.slice(0, 7)
}

/* ── 分支 ───────────────────────────────────────────────── */

/** 切换 / 新建前检查该目录有没有在跑的任务（方案 §5.1） */
function runningFailure(kind: 'switch' | 'create'): GitFailure {
  return {
    code: 'busy',
    message:
      kind === 'switch'
        ? '这个目录有正在运行的任务，暂时不能切换分支'
        : '这个目录有正在运行的任务，暂时不能新建并切换分支',
    hint: '等它跑完（或先停止该会话）再切 —— 中途换掉工作区文件会让正在跑的任务读到混乱的代码',
    retrySafe: true
  }
}

async function switchBranch(request: Extract<GitActionRequest, { kind: 'switch-branch' }>): Promise<GitActionResult> {
  const branch = String(request.branch ?? '').trim()
  const invalid = validateBranchName(branch)
  if (invalid) {
    return { ok: false, failure: { code: 'invalid-input', message: invalid, retrySafe: true } }
  }

  const prep = await prepare(request.cwd)
  if (!prep.ok) return { ok: false, failure: prep.failure }
  const repo = prep.repo

  return withRepoLock(repo.repoId, async () => {

    if (ctx.hasRunningTask?.(repo.root)) return { ok: false, failure: runningFailure('switch') }

    if (!(await refExists(repo.root, branch))) {
      return {
        ok: false,
        failure: { code: 'branch-missing', message: `分支不存在：${branch}`, retrySafe: true }
      }
    }

    const before = await readExpected(repo.root)
    /* 脏工作区**不预先阻止** —— 让 git 自己判（方案 §5.1：它的检查比我们准） */
    const res = await runWrite(repo.root, buildSwitchArgs(branch))
    if (!res.ok) {
      const state = await readRepoState(repo.root).catch(() => null)
      return {
        ok: false,
        failure: res.failure,
        headBefore: before.head,
        headAfter: before.head,
        ...(state ? { state } : {})
      }
    }
    return finish(repo, before.head, `已切换到 ${branch}`)
  })
}

async function createBranch(request: Extract<GitActionRequest, { kind: 'create-branch' }>): Promise<GitActionResult> {
  const branch = String(request.branch ?? '').trim()
  const invalid = validateBranchName(branch)
  if (invalid) {
    return { ok: false, failure: { code: 'invalid-input', message: invalid, retrySafe: true } }
  }
  const startPoint = request.startPoint ? String(request.startPoint).trim() : null

  const prep = await prepare(request.cwd)
  if (!prep.ok) return { ok: false, failure: prep.failure }
  const repo = prep.repo

  /* 起点不存在时不要硬跑：git 会报「不是有效的对象名」，对用户没帮助 */
  if (startPoint && !(await refExists(repo.root, startPoint))) {
    return { ok: false, failure: { code: 'branch-missing', message: `起点不存在：${startPoint}`, retrySafe: true } }
  }

  return withRepoLock(repo.repoId, async () => {
    /*
     * 只有「用当前 HEAD 作起点」时才复核：新分支长在哪里由它决定。
     * 显式给了起点的话，期间的提交与这次创建无关。
     */
    const stale = await guardExpected(repo.root, request.expected, startPoint ? "none" : "head")
    if (stale) return { ok: false, failure: stale }

    if (request.checkout && ctx.hasRunningTask?.(repo.root)) return { ok: false, failure: runningFailure('create') }

    const before = await readExpected(repo.root)
    const res = await runWrite(repo.root, buildCreateBranchArgs(branch, startPoint, request.checkout))
    if (!res.ok) return { ok: false, failure: res.failure, headBefore: before.head, headAfter: before.head }

    /*
     * 从远程跟踪分支新建时顺手设上游。这一步失败**不影响**创建结果
     * （分支已经建好了），所以只把它记进 summary，不报错。
     */
    const isRemote = startPoint
      ? await gitRun(repo.root, ['rev-parse', '--symbolic-full-name', startPoint], { allowFailure: true })
          .then((r) => r.ok && r.stdout.trim().startsWith('refs/remotes/'))
          .catch(() => false)
      : false
    let upstreamNote = ''
    if (isRemote) {
      const up = await runWrite(repo.root, buildSetUpstreamAfterCreateArgs(branch, startPoint, true), {
        timeout: 15_000
      })
      if (!up.ok) upstreamNote = '（上游没设上，推送时勾「设置上游」即可）'
    }

    return finish(repo, before.head, `${request.checkout ? '已新建并切换到' : '已新建分支'} ${branch}${upstreamNote}`)
  })
}

/* ── 远程 ───────────────────────────────────────────────── */

/** 列出可用 remote（界面下拉与校验用） */
export async function listRemotes(root: string): Promise<string[]> {
  const res = await gitRun(root, ['remote'], { allowFailure: true, timeout: 8000 })
  if (!res.ok) return []
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * remote 的托管网页地址（只读）。
 *
 * 优先 `origin`，没有就按名字取第一个 —— 与推送的默认选择一致，
 * 免得界面上一处说 origin、另一处说别的。
 */
export async function remoteWeb(cwd: string): Promise<{ ok: boolean; web?: string | null; remote?: string | null; error?: string }> {
  const repo = await resolveRepo(cwd)
  if (!repo) return { ok: false, error: '这个目录不是 Git 仓库' }
  const names = await listRemotes(repo.root)
  if (names.length === 0) return { ok: true, web: null, remote: null }
  const name = names.includes('origin') ? 'origin' : names[0]
  const res = await gitRun(repo.root, ['remote', 'get-url', name], { allowFailure: true, timeout: 8000 })
  if (!res.ok) return { ok: false, error: (res.stderr || res.stdout).trim() || '读不到 remote 地址' }
  return { ok: true, web: remoteWebUrl(res.stdout.trim()), remote: name }
}

async function fetchRemote(request: Extract<GitActionRequest, { kind: 'fetch' }>): Promise<GitActionResult> {
  const repo = await resolveRepo(request.cwd)
  if (!repo) return { ok: false, failure: { code: 'not-a-repo', message: '这个目录不是 Git 仓库', retrySafe: true } }

  const remotes = await listRemotes(repo.root)
  if (remotes.length === 0) {
    return {
      ok: false,
      failure: { code: 'no-remote', message: '这个仓库没有配置远程', hint: '添加 remote 后再拉取', retrySafe: true }
    }
  }
  const remote = request.remote && remotes.includes(request.remote) ? request.remote : null
  if (request.remote && !remote) {
    return { ok: false, failure: { code: 'no-remote', message: `没有这个远程：${request.remote}`, retrySafe: true } }
  }

  /* fetch 不改 index / HEAD，但会写对象库 —— 仍按仓库排队（并发 fetch 争 .git/objects） */
  return withRepoLock(repo.repoId, async () => {
    const before = await readExpected(repo.root)
    const res = await runWrite(repo.root, buildFetchArgs(remote), { timeout: NETWORK_TIMEOUT })
    if (!res.ok) return { ok: false, failure: res.failure, headBefore: before.head, headAfter: before.head }
    return finish(repo, before.head, remote ? `已从 ${remote} 拉取` : '已拉取所有远程')
  })
}

/**
 * 推送。
 *
 * 三件事这里不做，且是**有意的**：force、自动 rebase、自动冲突解决。
 * 「提交并推送」在渲染端拆成两步调用，所以提交成功、推送失败时提交被保留，
 * 重试只重试推送（方案 §5.3）。
 */
async function pushBranch(request: Extract<GitActionRequest, { kind: 'push' }>): Promise<GitActionResult> {
  const prep = await prepare(request.cwd)
  if (!prep.ok) return { ok: false, failure: prep.failure }
  const repo = prep.repo

  return withRepoLock(repo.repoId, async () => {

    const remotes = await listRemotes(repo.root)
    if (remotes.length === 0) {
      return { ok: false, failure: { code: 'no-remote', message: '这个仓库没有配置远程', retrySafe: true } }
    }
    const state = await readRepoState(repo.root)
    const branch = request.branch || state?.branch || null
    const remote =
      request.remote && remotes.includes(request.remote)
        ? request.remote
        : state?.upstream
          ? state.upstream.split('/')[0]
          : remotes[0]

    const before = await readExpected(repo.root)
    const args = buildPushArgs(branch ?? '', remote ?? null, request.setUpstream)
    const res = await runWrite(repo.root, args, { timeout: NETWORK_TIMEOUT })

    if (!res.ok) {
      const after = await readExpected(repo.root)
      /*
       * 推送里「成功但退出码非零」几乎不存在（多 remote 的 partial push 才有），
       * 所以这里不去猜：超时就说结果未知，非超时就照实报分类。
       * 判据留给用户看「待推送」数（= 0 就是已经推上去了）。
       */
      const next = await readRepoState(repo.root).catch(() => null)
      return {
        ok: false,
        failure: res.timedOut
          ? {
              code: 'timeout',
              message: '推送超时，结果未知',
              hint: '先刷新看「待推送」数：为 0 说明已经推上去了',
              retrySafe: false
            }
          : res.failure,
        headBefore: before.head,
        headAfter: after.head,
        pushed: false,
        ...(next ? { state: next } : {})
      }
    }

    const next = await readRepoState(repo.root).catch(() => null)
    const upToDate = /everything up-to-date/i.test(res.stdout + res.stderr)
    return {
      ok: true,
      summary: upToDate ? '远程已经是最新' : `已推送到 ${remote}${request.setUpstream ? '（并设置上游）' : ''}`,
      headBefore: before.head,
      headAfter: next?.head ?? null,
      pushed: true,
      ...(next ? { state: next } : {})
    }
  })
}

/* ── 入口 ───────────────────────────────────────────────── */

/**
 * 写操作总入口。**所有**写路径都从这里进，所以在这一处就能回答
 * 「应用会不会改用户的 Git 状态、怎么改」。
 */
export async function runGitAction(request: GitActionRequest): Promise<GitActionResult> {
  const cwd = resolve(String(request.cwd ?? ''))
  const normalized = { ...request, cwd } as GitActionRequest
  try {
    switch (normalized.kind) {
      case 'stage':
      case 'unstage':
        return await stageOrUnstage(normalized)
      case 'stage-all':
      case 'unstage-all':
        return await stageOrUnstageAll(normalized)
      case 'commit':
        return await commitChanges(normalized)
      case 'switch-branch':
        return await switchBranch(normalized)
      case 'create-branch':
        return await createBranch(normalized)
      case 'fetch':
        return await fetchRemote(normalized)
      case 'push':
        return await pushBranch(normalized)
      default: {
        const never: never = normalized
        return {
          ok: false,
          failure: { code: 'unknown', message: `不认识的操作：${JSON.stringify(never)}`, retrySafe: false }
        }
      }
    }
  } catch (error) {
    /* 兜底：任何未预料的异常都不能让 IPC 无响应（渲染端会一直等） */
    return {
      ok: false,
      failure: classifyGitFailure(String((error as { message?: unknown })?.message ?? error))
    }
  }
}
