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

const WRITE_TIMEOUT = 120_000
const NETWORK_TIMEOUT = 90_000

let ctx: WriteContext = {}

export function configureWriteContext(next: WriteContext): void {
  ctx = next
}

export interface WriteContext {
  hasRunningTask?: (cwd: string) => boolean
}

const queues = new Map<string, Promise<unknown>>()

function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(repoId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    repoId,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

export function clearWriteQueues(): void {
  queues.clear()
}

export { readExpected } from './git-service'

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

type PrepareResult = { ok: true; repo: RepoIdentity } | { ok: false; failure: GitFailure }

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

async function runWrite(
  root: string,
  args: string[],
  opts: { timeout?: number } = {}
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; failure: GitFailure; timedOut: boolean }> {
  try {
    const res = await gitRun(root, args, { allowFailure: true, timeout: opts.timeout ?? WRITE_TIMEOUT })
    const timedOut = res.timedOut === true
    if (res.ok) return { ok: true, stdout: res.stdout, stderr: res.stderr }
    return {
      ok: false,
      failure: timedOut ? timeoutFailure(res.error ?? res.stderr ?? res.stdout) : classifyGitFailure(res.stderr || res.stdout),
      timedOut
    }
  } catch (error) {
    const detail = error as { message?: unknown; timedOut?: boolean }
    const message = String(detail.message ?? error)
    const timedOut = detail.timedOut === true || /timed? ?out|killed|SIGTERM/i.test(message)
    return {
      ok: false,
      failure: timedOut ? timeoutFailure(message) : classifyGitFailure(message),
      timedOut
    }
  }
}

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

  if (startPoint && !(await refExists(repo.root, startPoint))) {
    return { ok: false, failure: { code: 'branch-missing', message: `起点不存在：${startPoint}`, retrySafe: true } }
  }

  return withRepoLock(repo.repoId, async () => {
    const stale = await guardExpected(repo.root, request.expected, startPoint ? "none" : "head")
    if (stale) return { ok: false, failure: stale }

    if (request.checkout && ctx.hasRunningTask?.(repo.root)) return { ok: false, failure: runningFailure('create') }

    const before = await readExpected(repo.root)
    const res = await runWrite(repo.root, buildCreateBranchArgs(branch, startPoint, request.checkout))
    if (!res.ok) return { ok: false, failure: res.failure, headBefore: before.head, headAfter: before.head }

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

export async function listRemotes(root: string): Promise<string[]> {
  const res = await gitRun(root, ['remote'], { allowFailure: true, timeout: 8000 })
  if (!res.ok) return []
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

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

  return withRepoLock(repo.repoId, async () => {
    const before = await readExpected(repo.root)
    const res = await runWrite(repo.root, buildFetchArgs(remote), { timeout: NETWORK_TIMEOUT })
    if (!res.ok) return { ok: false, failure: res.failure, headBefore: before.head, headAfter: before.head }
    return finish(repo, before.head, remote ? `已从 ${remote} 拉取` : '已拉取所有远程')
  })
}

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
    if (branch) {
      const invalid = validateBranchName(branch) ?? (branch.startsWith('+') ? '分支名不能以 + 开头' : null)
      if (invalid) return { ok: false, failure: { code: 'invalid-input', message: invalid, retrySafe: true } }
    }
    const remote =
      request.remote && remotes.includes(request.remote)
        ? request.remote
        : state?.upstream
          ? state.upstream.split('/')[0]
          : remotes[0]

    const before = await readExpected(repo.root)
    const args = buildPushArgs(branch ?? '', remote ?? null, request.setUpstream)
    if (branch) args[args.length - 1] = `refs/heads/${branch}:refs/heads/${branch}`
    const res = await runWrite(repo.root, args, { timeout: NETWORK_TIMEOUT })

    if (!res.ok) {
      const after = await readExpected(repo.root)
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

export async function runGitAction(request: GitActionRequest): Promise<GitActionResult> {
  const suppliedCwd = typeof request.cwd === 'string' ? request.cwd.trim() : ''
  if (!suppliedCwd) {
    return {
      ok: false,
      failure: { code: 'invalid-input', message: '缺少项目目录，Git 操作已取消', retrySafe: true }
    }
  }
  const cwd = resolve(suppliedCwd)
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
    return {
      ok: false,
      failure: classifyGitFailure(String((error as { message?: unknown })?.message ?? error))
    }
  }
}
