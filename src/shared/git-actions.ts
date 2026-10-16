import type { GitRepoState } from './git'

export type GitActionKind =
  | 'stage'
  | 'unstage'
  | 'stage-all'
  | 'unstage-all'
  | 'commit'
  | 'switch-branch'
  | 'create-branch'
  | 'fetch'
  | 'push'

export interface GitActionExpected {
  head: string | null
  indexDigest: string
  statusDigest: string
}

interface BaseRequest {
  requestId: string
  cwd: string
  expected: GitActionExpected
}

export interface GitStageRequest extends BaseRequest {
  kind: 'stage' | 'unstage'
  paths: string[]
}

export interface GitBulkRequest extends BaseRequest {
  kind: 'stage-all' | 'unstage-all'
}

export interface GitCommitRequest extends BaseRequest {
  kind: 'commit'
  message: string
}

export interface GitSwitchBranchRequest extends BaseRequest {
  kind: 'switch-branch'
  branch: string
}

export interface GitCreateBranchRequest extends BaseRequest {
  kind: 'create-branch'
  branch: string
  startPoint: string | null
  checkout: boolean
}

export interface GitFetchRequest {
  requestId: string
  cwd: string
  kind: 'fetch'
  remote?: string | null
}

export interface GitPushRequest extends BaseRequest {
  kind: 'push'
  remote: string | null
  setUpstream: boolean
  branch: string | null
}

export type GitActionRequest =
  | GitStageRequest
  | GitBulkRequest
  | GitCommitRequest
  | GitSwitchBranchRequest
  | GitCreateBranchRequest
  | GitFetchRequest
  | GitPushRequest

export type GitFailureCode =
  | 'stale'
  | 'not-a-repo'
  | 'identity'
  | 'hook'
  | 'sign'
  | 'lock'
  | 'conflict'
  | 'auth'
  | 'no-remote'
  | 'non-fast-forward'
  | 'no-upstream'
  | 'dirty-blocks-switch'
  | 'branch-exists'
  | 'branch-missing'
  | 'branch-in-use'
  | 'invalid-input'
  | 'unborn'
  | 'nothing-to-commit'
  | 'empty-message'
  | 'path-rejected'
  | 'carry-rejected'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'unknown'

export interface GitFailure {
  code: GitFailureCode
  message: string
  detail?: string
  hint?: string
  retrySafe: boolean
}

export interface GitActionResult {
  ok: boolean
  state?: GitRepoState
  summary?: string
  failure?: GitFailure
  headBefore?: string | null
  headAfter?: string | null
  commit?: string | null
  committed?: boolean
  pushed?: boolean
}

interface Rule {
  code: GitFailureCode
  test: RegExp
  message: string
  hint?: string
  retrySafe: boolean
}

const RULES: Rule[] = [
  {
    code: 'identity',
    test: /please tell me who you are|unable to auto-detect email address|author identity unknown|empty ident name|committer identity unknown/,
    message: 'Git 身份未配置，无法提交',
    hint: '设置 user.name 与 user.email（可以让模型帮你跑 git config），或改仓库已有配置',
    retrySafe: true
  },
  {
    code: 'sign',
    test: /gpg failed to sign|gpg: signing failed|failed to write commit object|secret key not available|no secret key/,
    message: '提交签名失败',
    hint: '检查 gpg / SSH 签名配置，或临时关掉 commit.gpgsign',
    retrySafe: true
  },
  {
    code: 'hook',
    test: /hook declined|pre-commit hook|pre-push hook|commit-msg hook|husky|\.git\/hooks\//,
    message: '提交被 hook 拒绝',
    hint: '上面保留了 hook 的原始输出；修掉它指出的问题再提交（这里不会跳过 hook）',
    retrySafe: true
  },
  {
    code: 'lock',
    test: /unable to create '[^']*\.lock'|index\.lock.*file exists|another git process|cannot lock ref|unable to lock/,
    message: '仓库被锁住（有另一个 git 进程在写）',
    hint: '等它跑完再试；确认没有 git 在跑时，删掉对应的 .lock 文件',
    retrySafe: true
  },
  {
    code: 'conflict',
    test: /you need to resolve your current index first|unmerged files|committing is not possible because you have unmerged|needs merge|fix conflicts/,
    message: '有未解决的合并冲突',
    hint: '先解决冲突并暂存结果，再提交',
    retrySafe: true
  },
  {
    code: 'dirty-blocks-switch',
    test: /your local changes to the following files would be overwritten|please commit your changes or stash them|would be overwritten by checkout|cannot switch branch|your local changes would be overwritten/,
    message: '本地改动会被覆盖，Git 拒绝了这次切换',
    hint: '这是 Git 自己的检查结果 —— 先提交或手动备份这些文件，这里不会替你 stash 或 reset',
    retrySafe: true
  },
  {
    code: 'branch-in-use',
    test: /is already checked out at|already checked out/,
    message: '该分支已被另一个工作树占用',
    hint: '在占用它的那个工作树里切走，或换一个分支名',
    retrySafe: true
  },
  {
    code: 'branch-exists',
    test: /a branch named .* already exists|branch named .* already exists/,
    message: '分支已经存在',
    hint: '换一个名字，或直接切到已有分支',
    retrySafe: true
  },
  {
    code: 'auth',
    test: /authentication failed|could not read username|permission denied \(publickey\)|terminal prompts disabled|invalid username or password|fatal: could not read password|access denied|403 forbidden/,
    message: '远程认证失败',
    hint: '认证走系统 Git 凭证；在这里失败时请到终端完成一次登录（应用不会代你保存凭证）',
    retrySafe: true
  },
  {
    code: 'no-upstream',
    test: /has no upstream branch|no upstream configured|no tracking information for the current branch/,
    message: '当前分支没有上游',
    hint: '用「推送并设置上游」推第一次',
    retrySafe: true
  },
  {
    code: 'non-fast-forward',
    test: /non-fast-forward|fetch first|\[rejected\].*\(fetch first\)|updates were rejected/,
    message: '远程有新提交，推送被拒（快进不了）',
    hint: '先拉取并自己合并 / 变基 —— 这里不会自动 rebase，也不提供强制推送',
    retrySafe: true
  },
  {
    code: 'no-remote',
    test: /does not appear to be a git repository|could not read from remote repository|no such remote|'[^']*' does not appear/,
    message: '远程仓库不可用',
    hint: '检查 remote 地址与网络',
    retrySafe: true
  },
  {
    code: 'unborn',
    test: /does not have any commits yet|unborn branch|bad revision 'head'/,
    message: '仓库还没有第一个提交',
    hint: '先做一个初始提交',
    retrySafe: true
  },
  {
    code: 'nothing-to-commit',
    test: /nothing to commit|no changes added to commit|nothing added to commit/,
    message: '没有可提交的内容',
    retrySafe: true
  },
  {
    code: 'path-rejected',
    test: /pathspec .* did not match|did not match any files/,
    message: '文件路径已经不在仓库里（可能被删或被改了名）',
    hint: '刷新一下变更列表再操作',
    retrySafe: true
  }
]

export function classifyGitFailure(stderr: string, exitCode: number | null = null): GitFailure {
  const raw = String(stderr ?? '').trim()
  const lower = raw.toLowerCase()
  for (const rule of RULES) {
    if (rule.test.test(lower)) {
      return {
        code: rule.code,
        message: rule.message,
        ...(rule.hint ? { hint: rule.hint } : {}),
        detail: raw,
        retrySafe: rule.retrySafe
      }
    }
  }
  return {
    code: 'unknown',
    message: 'Git 操作失败',
    detail: raw || (exitCode === null ? '' : `退出码 ${exitCode}`),
    hint: '看上面的原始输出；如果不确定，先在终端里跑同一条命令',
    retrySafe: false
  }
}

export function hookFailure(detail: string, hooks: string[]): GitFailure {
  return {
    code: 'hook',
    message: `提交被 hook 拒绝（很可能是它：这个仓库有 ${hooks.join('、')}）`,
    detail,
    hint: '上面是 hook 的原始输出；修掉它指出的问题再提交（这里不会跳过 hook）',
    retrySafe: true
  }
}

export function timeoutFailure(detail?: string): GitFailure {
  return {
    code: 'timeout',
    message: 'Git 操作超时',
    ...(detail ? { detail } : {}),
    hint: '先去界面刷新看实际状态（提交可能已经完成），确认没有再重试',
    retrySafe: false
  }
}

export function staleFailure(changed: string[]): GitFailure {
  return {
    code: 'stale',
    message: '仓库状态在你操作前发生了变化，已为你刷新',
    detail: changed.join('、'),
    hint: '看一眼刷新后的内容再决定是否重做这一步',
    retrySafe: false
  }
}

export const MAX_COMMIT_MESSAGE = 20_000

export const MAX_ACTION_PATHS = 800

export function validateCommitMessage(message: string): GitFailure | null {
  const text = String(message ?? '')
  if (!text.trim()) {
    return {
      code: 'empty-message',
      message: '提交说明不能为空',
      retrySafe: true
    }
  }
  if (text.length > MAX_COMMIT_MESSAGE) {
    return {
      code: 'invalid-input',
      message: `提交说明过长（上限 ${MAX_COMMIT_MESSAGE} 字符）`,
      retrySafe: true
    }
  }
  return null
}

export function validateBranchName(name: string): string | null {
  const s = String(name ?? '').trim()
  if (!s) return '分支名不能为空'
  if (s.length > 200) return '分支名过长'
  if (s.startsWith('-')) return '分支名不能以 - 开头'
  if (s.startsWith('/') || s.endsWith('/')) return '分支名不能以 / 开头或结尾'
  if (s.endsWith('.') || s.endsWith('.lock')) return '分支名不能以 . 或 .lock 结尾'
  if (s.includes('..')) return '分支名不能含 ..'
  if (s.includes('//')) return '分支名不能含连续的 /'
  if (s.includes('@{')) return '分支名不能含 @{'
  if (/[\s~^:?*\[\\]/.test(s)) return '分支名不能含空格或 ~ ^ : ? * [ \\'
  /* eslint-disable-next-line no-control-regex */
  if (/[\u0000-\u001f\u007f]/.test(s)) return '分支名不能含控制字符'
  return null
}

export function buildStageArgs(paths: string[]): string[] {
  return ['add', '--', ...paths]
}

export function buildStageAllArgs(): string[] {
  return ['add', '-A']
}

export function buildUnstageArgs(paths: string[], hasHead: boolean): string[] {
  if (hasHead) return ['reset', '--quiet', 'HEAD', '--', ...paths]
  return ['rm', '--cached', '--quiet', '--', ...paths]
}

export function buildUnstageAllArgs(hasHead: boolean): string[] {
  if (hasHead) return ['reset', '--quiet', 'HEAD']
  return ['rm', '--cached', '--quiet', '-r', '--ignore-unmatch', '.']
}

export function buildCommitArgs(message: string): string[] {
  return ['commit', '-m', message]
}

export function buildSwitchArgs(branch: string): string[] {
  return ['switch', '--', branch]
}

export function buildCreateBranchArgs(branch: string, startPoint: string | null, checkout: boolean): string[] {
  if (checkout) return ['switch', '-c', branch, ...(startPoint ? [startPoint] : [])]
  return ['branch', '--', branch, ...(startPoint ? [startPoint] : [])]
}

export function buildPushArgs(branch: string, remote: string | null, setUpstream: boolean): string[] {
  const args = ['push']
  if (setUpstream) args.push('--set-upstream')
  if (remote) args.push('--', remote)
  if (branch) args.push(branch)
  return args
}

export function buildFetchArgs(remote: string | null): string[] {
  return remote ? ['fetch', '--prune', '--', remote] : ['fetch', '--prune']
}

export function buildSetUpstreamAfterCreateArgs(
  branch: string,
  startPoint: string | null,
  isRemoteTracking: boolean
): string[] {
  if (!startPoint || !isRemoteTracking) return []
  return ['branch', `--set-upstream-to=${startPoint}`, branch]
}

export function digestOf(parts: string[]): string {
  let acc = ''
  for (const part of parts) acc += `${part.length}:${part};`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < acc.length; i++) {
    const c = acc.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16)
}

export function expectedMismatch(
  expected: GitActionExpected,
  actual: GitActionExpected
): string[] | null {
  const changed: string[] = []
  if (expected.head !== actual.head) changed.push('HEAD')
  if (expected.indexDigest !== actual.indexDigest) changed.push('暂存区')
  if (expected.statusDigest !== actual.statusDigest) changed.push('工作区状态')
  return changed.length ? changed : null
}

export function summarizeFiles(verb: string, paths: string[]): string {
  if (paths.length === 0) return verb
  if (paths.length === 1) return `${verb} ${paths[0]}`
  return `${verb} ${paths.length} 个文件`
}
