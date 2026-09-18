/**
 * Git **写操作**的契约与纯逻辑（方案 §5，G2 阶段）。
 *
 * ── 为什么与 `git.ts` 分开 ──
 * `git.ts` 是「读」的解析器：它把 git 的输出变成结构化数据，任何时刻都能重跑，
 * 失败也无副作用。这里是「写」：一次调用就可能改用户的 index / HEAD / 远程。
 * 两者的共同点只有「都要解析 git 输出」，而写路径最需要的是**另一套东西** ——
 * 失败原因的分类（要显示给人看）、重试是否安全、命令参数怎么拼才不会被
 * 用户消息里的内容改变语义。混在一起会让读路径背上写路径的复杂度。
 *
 * ── 本文件里没有 IO ──
 * 全是纯函数，所以能被 `test-git-actions.mjs` 直接喂字符串测。
 * 真正跑 git 的在 `main/git-actions.ts`。
 */

import type { GitRepoState } from './git'

/* ── 请求 ───────────────────────────────────────────────── */

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

/**
 * 乐观并发用的**预期版本**。
 *
 * ── 复核到哪一层取决于动作（见 main/git-actions.ts 的 GuardLevel）──
 * 这条不是实现细节，是**设计决定**，理由来自真实运行：
 *
 *   · `commit` → 全比（HEAD + index + 工作区）。它是唯一「会把用户没看过的
 *     内容写进历史」的动作 —— 点提交时看到的预览必须就是将要提交的东西
 *     （方案 §5.2）。`indexDigest` 是这件事唯一可靠的判据：只看 HEAD 与
 *     status 抓不住「内容被换了但状态码没变」
 *   · `create-branch`（未指定起点）→ 只看 HEAD。新分支从 HEAD 长出来，
 *     期间的提交会让它长在别处
 *   · 其余动作（暂存 / 取消暂存 / 切换分支 / 拉取 / 推送）→ **不复核**。
 *     它们要么幂等（暂存就是「把当前内容放进 index」），要么完全由 git
 *     自己的检查兜住（切换分支的脏工作区、推送的非快进）
 *
 * 为什么宁可少比：初版让**每个**动作都比三件套，结果用户连点两个文件的
 * 「暂存」时第二个必被拒（index 已被自己改过），提交后立刻推送也被拒
 * （HEAD 已被自己改过）—— 全是假冲突。假冲突的代价不是「更安全」，
 * 而是用户学会无视那句「状态已变化」。
 */
export interface GitActionExpected {
  head: string | null
  indexDigest: string
  statusDigest: string
}

interface BaseRequest {
  /** 渲染端生成，用于丢弃迟到响应（与只读查询同一套机制） */
  requestId: string
  cwd: string
  expected: GitActionExpected
}

export interface GitStageRequest extends BaseRequest {
  kind: 'stage' | 'unstage'
  /** 仓库内相对路径（主进程会过 `safeRepoPath`） */
  paths: string[]
}

export interface GitBulkRequest extends BaseRequest {
  kind: 'stage-all' | 'unstage-all'
}

export interface GitCommitRequest extends BaseRequest {
  kind: 'commit'
  /** 提交说明。校验在 `validateCommitMessage`，不靠 git 报错来兜底 */
  message: string
}

export interface GitSwitchBranchRequest extends BaseRequest {
  kind: 'switch-branch'
  branch: string
}

export interface GitCreateBranchRequest extends BaseRequest {
  kind: 'create-branch'
  branch: string
  /** 起点；null 表示当前 HEAD */
  startPoint: string | null
  /** 创建后是否切过去 */
  checkout: boolean
}

/** fetch 不动 index / HEAD，所以**不需要**预期版本 */
export interface GitFetchRequest {
  requestId: string
  cwd: string
  kind: 'fetch'
  remote?: string | null
}

export interface GitPushRequest extends BaseRequest {
  kind: 'push'
  /** 目标 remote；null 表示用 upstream 里记的那个 */
  remote: string | null
  /** 首次推送时设置 upstream（`git push -u`） */
  setUpstream: boolean
  /** 分支名（来自界面显示的那个） */
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

/* ── 结果 ───────────────────────────────────────────────── */

/**
 * 失败分类。
 *
 * 每一个码背后都是「用户要看到不同的话、或要做不同的事」：
 * 身份未配置要去设置里填，hook 被拒要去看 hook 的输出，认证失败要在终端登录，
 * lock 冲突要等或删 `.git/index.lock`，非快进要先拉。把它们统一成
 * 「操作失败」等于把排查成本全推给用户。
 */
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
  /** 携带未提交改动被拒（源仓库有冲突 / 子模块 / 文件太大 / 应用失败已回滚） */
  | 'carry-rejected'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'unknown'

export interface GitFailure {
  code: GitFailureCode
  /** 给人看的一句话 */
  message: string
  /** 原样保留的 git 输出（折叠展示，永远是排查的第一现场） */
  detail?: string
  /** 可执行的下一步（没有就不显示） */
  hint?: string
  /**
   * 重试是否**安全**。
   *
   * 方案 §5.4 的硬要求：超时或取消之后不能无条件重试 —— 提交可能已经完成
   * （`timeout` / `cancelled` / `unknown` 都标 false）。而「身份未配置」这类
   * 明确没做任何事的失败，配好身份后重试完全安全。
   */
  retrySafe: boolean
}

export interface GitActionResult {
  ok: boolean
  /**
   * 动作**之后**的仓库状态。
   * 由主进程顺手读一次（比让渲染端再发一个请求更快，而且不会先闪一下旧数）。
   */
  state?: GitRepoState
  /** 成功时的一行结果（「已暂存 3 个文件」） */
  summary?: string
  failure?: GitFailure
  /** 动作前后的 HEAD —— 超时后用它判断提交到底完成没有 */
  headBefore?: string | null
  headAfter?: string | null
  /** 提交成功时的 short sha（界面要立刻显示） */
  commit?: string | null
  /**
   * 提交 / 推送是否**已经发生**。
   * 超时路径下这是唯一能给用户的确定信息：`true` 就不要再点一次。
   */
  committed?: boolean
  pushed?: boolean
}

/* ── 纯函数：失败分类 ───────────────────────────────────── */

/*
 * 匹配用**小写**后的输出。git 的文案随版本变化，所以每条都写多个候选，
 * 且尽量锚在不会变的部分上（例如 hook 名、`index.lock`、`non-fast-forward`）。
 */
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

/**
 * 把 git 的 stderr（+ 退出码）变成结构化失败。
 *
 * `detail` 永远保留原文：分类只是**附加**的解读，用户与我们都可能看错，
 * 原始输出是唯一的第一现场。分类不中就是 `unknown`（并要求用户去看原文），
 * **不要**编一个像样的原因 —— 那会把排查引向错方向。
 */
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
  /* 超时与取消由主进程直接构造（它们没有 stderr），走不到这里 */
  return {
    code: 'unknown',
    message: 'Git 操作失败',
    detail: raw || (exitCode === null ? '' : `退出码 ${exitCode}`),
    hint: '看上面的原始输出；如果不确定，先在终端里跑同一条命令',
    retrySafe: false
  }
}

/**
 * hook 拒绝。
 *
 * ⚠️ 这是**唯一**不能只靠文本识别的失败：真 git 在 pre-commit 拒绝时
 * **只把 hook 自己的输出透传出去**，不加任何前缀（实测：hook 里 echo 一句
 * 然后 exit 1，git 的 stderr 就是那一句，退出码 1）。所以
 * `classifyGitFailure` 只能认出会自报家门的（husky 那类）；
 * 其余由调用方**查一次仓库里有没有 hook 文件**再下判断 ——
 * 依据是事实（文件在），不是猜测，而且 message 里会说「很可能」。
 */
export function hookFailure(detail: string, hooks: string[]): GitFailure {
  return {
    code: 'hook',
    message: `提交被 hook 拒绝（很可能是它：这个仓库有 ${hooks.join('、')}）`,
    detail,
    hint: '上面是 hook 的原始输出；修掉它指出的问题再提交（这里不会跳过 hook）',
    retrySafe: true
  }
}

/** 超时：**不能**无条件重试 —— 提交可能已经完成（方案 §5.4） */
export function timeoutFailure(detail?: string): GitFailure {
  return {
    code: 'timeout',
    message: 'Git 操作超时',
    ...(detail ? { detail } : {}),
    hint: '先去界面刷新看实际状态（提交可能已经完成），确认没有再重试',
    retrySafe: false
  }
}

/** 状态变了（乐观并发检查没过） */
export function staleFailure(changed: string[]): GitFailure {
  return {
    code: 'stale',
    message: '仓库状态在你操作前发生了变化，已为你刷新',
    detail: changed.join('、'),
    hint: '看一眼刷新后的内容再决定是否重做这一步',
    retrySafe: false
  }
}

/* ── 纯函数：输入校验 ───────────────────────────────────── */

/** 提交说明的长度上限：够写清楚，又不至于把界面撑坏 */
export const MAX_COMMIT_MESSAGE = 20_000

/** 一次操作的文件数上限（与只读清单上限一致） */
export const MAX_ACTION_PATHS = 800

/**
 * 校验提交说明。
 *
 * 空说明必须在这里拦住：交给 git 的话它会报 `Aborting commit due to
 * empty commit message`，分类到 `unknown`，用户看到的是一句英文报错而不是
 * 「提交说明不能为空」。只含空白的消息同样是空的。
 *
 * 保留首尾空白之外的**内部**换行 —— 「标题 + 空行 + 正文」是 git 的惯例，
 * 而 `-m` 会原样保留它（git 自己按第一个空行分段）。
 */
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

/**
 * 分支名的**廉价**预检。
 *
 * 这里只挡明显不合法与危险输入，**权威判据是 `git check-ref-format --branch`**
 * （主进程会再跑一次）。为什么两道都要：本地这道让界面能立刻标红，不用等一个
 * 往返；git 那道覆盖所有规则（`..`、结尾 `.lock`、以 `-` 开头、含控制字符…），
 * 我们不可能复刻得完全一致 —— 也不该假装能。
 *
 * 返回 null 表示通过。
 */
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

/* ── 纯函数：命令构造 ───────────────────────────────────── */

/*
 * 全部返回**参数数组**，由主进程交给 `execFile`（不经 shell）。
 * 路径统一带 `--` 终止符：`git add -- <path>` 让以 `-` 开头或含空格的
 * 路径不会被当成选项。参数数组挡 shell 注入，`--` 挡选项注入，两道都要。
 */

export function buildStageArgs(paths: string[]): string[] {
  return ['add', '--', ...paths]
}

export function buildStageAllArgs(): string[] {
  /* `-A` 含未跟踪文件与删除 —— 与审查面板「全部变更」的口径一致 */
  return ['add', '-A']
}

/**
 * 取消暂存。
 *
 * 无首提交（unborn HEAD）时没有 `HEAD` 可用，`reset HEAD --` 会直接报错，
 * 所以改用 `rm --cached`（保留工作区文件）。这是方案 §5.2 点名的兼容点。
 */
export function buildUnstageArgs(paths: string[], hasHead: boolean): string[] {
  if (hasHead) return ['reset', '--quiet', 'HEAD', '--', ...paths]
  return ['rm', '--cached', '--quiet', '--', ...paths]
}

export function buildUnstageAllArgs(hasHead: boolean): string[] {
  if (hasHead) return ['reset', '--quiet', 'HEAD']
  return ['rm', '--cached', '--quiet', '-r', '--ignore-unmatch', '.']
}

/*
 * 丢弃工作区改动 —— **本版不做**。
 *
 * 这是整个 Git 集成里唯一不可恢复的操作（方案 §5.1 明确要求不覆盖用户改动），
 * 而方案 §5.2 的动作清单里只有暂存 / 取消暂存 / 提交。要加它，先要有
 * 「哪些文件会被覆盖」的完整预览与二次确认设计 —— 那是独立的一项。
 */

/**
 * 提交参数。
 *
 * **故意不传 `--no-verify`**：方案 §5.2 要求「不静默跳过 hook」。
 * `--quiet` 也不要 —— 提交成功后 git 在 stdout 打的摘要（`[main abc1234] …`）
 * 是我们判断「是不是真的提交了」的一个额外证据。
 */
export function buildCommitArgs(message: string): string[] {
  return ['commit', '-m', message]
}

/**
 * 切换分支用 `switch` 而不是 `checkout`：
 * `checkout` 还能改文件（`checkout -- <path>`）、还能 detached，语义过载；
 * `switch` 只会切分支，不会顺手做别的事。
 */
export function buildSwitchArgs(branch: string): string[] {
  return ['switch', '--', branch]
}

/**
 * 新建分支。
 *
 * 两种走法**不一样**，别合并：
 *   · 只创建 → `git branch -- <name> [start]`（`--` 之后是名字与起点，安全）
 *   · 创建并切换 → `git switch -c <name> [start]`：名字是 `-c` 的**值**，
 *     不能塞 `--` 进去。安全性由 `validateBranchName`（拒 `-` 开头）与
 *     `refExists`（起点必须能解析成提交）保证。
 */
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
  /* `--prune` 清掉远程已删的分支 —— 否则「比较分支」里会一直列已删的
     `origin/xxx`，用户选中后报「不存在」 */
  return remote ? ['fetch', '--prune', '--', remote] : ['fetch', '--prune']
}

/**
 * 从**远程跟踪分支**新建时把上游直接设上。
 *
 * 不这么做的话，新分支推第一次还要用户自己在「设置上游」上做一次选择，
 * 而意图本来就明确（从 `origin/x` 来的新分支就该跟 `origin/x`）。
 * 判据用「是不是 refs/remotes 下的 ref」，不硬编码 `origin/` —— remote 可以叫别的名。
 */
export function buildSetUpstreamAfterCreateArgs(
  branch: string,
  startPoint: string | null,
  isRemoteTracking: boolean
): string[] {
  if (!startPoint || !isRemoteTracking) return []
  return ['branch', `--set-upstream-to=${startPoint}`, branch]
}

/* ── 纯函数：版本摘要 ───────────────────────────────────── */

/**
 * 把几段 git 输出拼成一个摘要。
 *
 * 用**长度前缀**而不是分隔符拼接：`ls-files -s` 的行里含空格、文件名里
 * 可能含任意字符（git 的 `-z` 输出里还有 NUL）。用 `\n` 或 `|` 拼会让
 * 「文件 A 叫 `x\nabc`」和「两个文件」算出同一个摘要 —— 长度前缀不会。
 */
export function digestOf(parts: string[]): string {
  let acc = ''
  for (const part of parts) acc += `${part.length}:${part};`
  /* 这里不引 crypto：本函数要能在渲染端 / 浏览器环境跑，非加密用途。
     真正的不可伪造性不重要 —— 它只用来发现「状态变了」，不防攻击者。 */
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < acc.length; i++) {
    const c = acc.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16)
}

/** 预期版本与当前实际是否一致；不一致时给出人话（哪个分量变了） */
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

/* ── 纯函数：给界面用的摘要行 ───────────────────────────── */

/** 「已暂存 3 个文件」「已取消暂存 a.txt」—— 结果行不要用英文原文 */
export function summarizeFiles(verb: string, paths: string[]): string {
  if (paths.length === 0) return verb
  if (paths.length === 1) return `${verb} ${paths[0]}`
  return `${verb} ${paths.length} 个文件`
}
