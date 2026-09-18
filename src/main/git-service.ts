/**
 * Git 只读查询服务（审查面板的数据源）。
 *
 * ── 与 `subagent-isolation.ts` 的边界（重要）──
 * 那个模块的 `collectDiff()` 会在**隔离 worktree** 里执行 `git add -A`
 * 来生成归档补丁。主工作区审查**绝不能**走那条路径 —— 打开一次审查就会
 * 改变用户的暂存区，而用户并没有做任何写操作。
 * 所以本模块里**没有 `add` / `commit` / `checkout` / `reset` / `stash`**：
 * G1 阶段它是纯只读的，写操作在 `git-actions.ts`（G2）里单独实现。
 *
 * ── 为什么要一个独立模块而不是复用 subagent 的 `git()` ──
 * 那个封装把「非零退出」一律抛成异常，而这里很多调用**必须**容忍非零退出：
 * `rev-parse` 在非 Git 目录里就是要失败、`merge-base` 在无共同祖先时也是。
 * 而且它没有 `-z` / `core.quotepath` / 超时分层这些只读查询才需要的参数。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import type { GitActionExpected } from '../shared/git-actions'
import { digestOf } from '../shared/git-actions'
import type { GitRefOption, GitRepoState, GitStatusParse } from '../shared/git'
import { parseStatusV2 } from '../shared/git'

const execFileAsync = promisify(execFile)

/** 只读查询的缓冲上限：大仓库的 `diff` 可能很大，但不需要无限 */
const MAX_BUFFER = 48 * 1024 * 1024
const DEFAULT_TIMEOUT = 20_000

export interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 非零退出时的 git 原始错误（stderr 优先） */
  error?: string
}

/**
 * 执行 git。
 *
 * ⚠️ 一律用 `execFile` + **参数数组**，不拼 shell 字符串：路径与 ref 都
 * 可能含空格 / 引号 / 中文，走 shell 就是一个注入面（方案 §11）。
 * `--` 分隔符也在调用方逐个加，别指望这个封装。
 *
 * `allowFailure` 为 true 时非零退出**不抛异常**，而是照实返回 stdout/stderr ——
 * 只读查询里「失败」经常是正常结果（非 Git 目录、无共同祖先）。
 */
export async function gitRun(
  cwd: string,
  args: string[],
  opts: { timeout?: number; allowFailure?: boolean; env?: Record<string, string> } = {}
): Promise<GitRunResult> {
  const full = ['-c', 'core.quotepath=false', '-c', 'core.pager=cat', ...args]
  try {
    const res = await execFileAsync('git', full, {
      cwd,
      windowsHide: true,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      /*
       * 关掉 external diff 与 textconv 的**环境侧**兜底：
       * 用户可以在 ~/.gitconfig 里配一个 external diff 程序，那会让
       * 我们的解析拿到完全不是 unified diff 的输出（甚至弹窗）。
       * 参数里还会再显式关一次（`--no-ext-diff`），两道都要。
       */
      env: {
        ...process.env,
        GIT_EXTERNAL_DIFF: '',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        ...(opts.env ?? {})
      }
    })
    return { ok: true, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const stdout = String(e.stdout ?? '')
    const stderr = String(e.stderr ?? '')
    if (opts.allowFailure) {
      return { ok: false, stdout, stderr, error: (stderr || stdout).trim() || undefined }
    }
    throw new Error((stderr || stdout || String(e.message ?? error)).trim() || 'git 命令失败')
  }
}

/* ── 仓库发现 ───────────────────────────────────────────── */

export interface RepoIdentity {
  root: string
  gitDir: string
  commonDir: string
  repoId: string
  worktreeId: string
  name: string
}

/*
 * 仓库发现的缓存。
 *
 * 为什么需要：审查面板每次刷新（打开、重新获焦、工具结束）都会问一次
 * 「这是不是 Git 仓库」，而 rev-parse 要起一个进程 —— 在一个会话里
 * 几十次刷新的场景下这是白白的主进程负担。
 * 失效策略给两条：TTL（30s）与「.git 目录的 mtime 变了」——
 * `git init` / 删除 .git 都会被第二条立刻发现。
 */
const repoCache = new Map<string, { at: number; value: RepoIdentity | null; gitDirMtime: number }>()
const REPO_TTL = 30_000

function hashId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}

/**
 * 找 cwd 所属的 Git 仓库。非 Git 目录返回 null（**不是错误** ——
 * 界面要显示「未使用 Git」并继续提供文件来源等功能）。
 */
export async function resolveRepo(cwd: string): Promise<RepoIdentity | null> {
  const dir = resolve(cwd)
  const cached = repoCache.get(dir)
  if (cached && Date.now() - cached.at < REPO_TTL) {
    if (cached.value) {
      const mtime = await stat(cached.value.gitDir).then(
        (s) => s.mtimeMs,
        () => -1
      )
      if (mtime === cached.gitDirMtime) return cached.value
    } else {
      return null
    }
  }

  const res = await gitRun(
    dir,
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    { allowFailure: true, timeout: 8000 }
  )
  if (!res.ok) {
    repoCache.set(dir, { at: Date.now(), value: null, gitDirMtime: -1 })
    return null
  }
  const lines = res.stdout.trim().split(/\r?\n/)
  const rootRaw = lines[0]
  const gitDirRaw = lines[1]
  const commonRaw = lines[2]
  if (!rootRaw || !gitDirRaw) {
    repoCache.set(dir, { at: Date.now(), value: null, gitDirMtime: -1 })
    return null
  }
  /* `--git-common-dir` 在普通仓库里给出的常常是相对路径（`.git`） */
  const commonDir = resolve(dir, commonRaw && commonRaw !== '.git' ? commonRaw : gitDirRaw)
  const root = await realpath(rootRaw).catch(() => resolve(rootRaw))
  const gitDir = await realpath(gitDirRaw).catch(() => resolve(gitDirRaw))
  const value: RepoIdentity = {
    root,
    gitDir,
    commonDir,
    /* repoId 用 commonDir：同一个仓库的多个 worktree 共享它，
       而 worktreeId 用 gitDir（每个 worktree 的 .git 文件指向不同的目录） */
    repoId: hashId(commonDir.toLowerCase()),
    worktreeId: hashId(gitDir.toLowerCase()),
    name: basename(root)
  }
  const mtime = await stat(gitDir).then(
    (s) => s.mtimeMs,
    () => -1
  )
  repoCache.set(dir, { at: Date.now(), value, gitDirMtime: mtime })
  return value
}

/** 测试与「用户手动刷新仓库身份」用；正常路径不需要 */
export function clearRepoCache(): void {
  repoCache.clear()
}

/* ── 状态 ───────────────────────────────────────────────── */

export async function readStatus(root: string): Promise<GitStatusParse> {
  const res = await gitRun(
    root,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-optional-locks'],
    { allowFailure: true }
  )
  if (!res.ok && !res.stdout) {
    /*
     * `--no-optional-locks` 让 status **不刷新 index**（只读查询不该写盘）。
     * 极旧的 git 不认这个选项时会整条失败 —— 那就退回不带它的调用，
     * 而不是把「仓库状态读不出来」报给用户。
     */
    const fallback = await gitRun(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      allowFailure: true
    })
    if (!fallback.ok && !fallback.stdout) {
      throw new Error(res.error ?? fallback.error ?? 'git status 失败')
    }
    return parseStatusV2(fallback.stdout)
  }
  return parseStatusV2(res.stdout)
}

export interface RefListing {
  refs: GitRefOption[]
  /** 被**其它**工作树占用的分支（切换分支前要提示） */
  busyBranches: string[]
  currentBranch: string | null
}

/**
 * 列出可选基准（本地 / 远程跟踪 / 标签）与被占用的分支。
 *
 * 排序：本地分支在前（按最近提交时间倒序）、再远程跟踪、最后标签。
 * 「最近提交」用 `-committerdate` —— 用户要找的基准几乎总是刚动过的那个。
 */
export async function listRefs(root: string): Promise<RefListing> {
  const refs: GitRefOption[] = []
  const format = '%(refname)%09%(refname:short)%09%(committerdate:unix)'
  const [heads, remotes, tags, worktrees] = await Promise.all([
    gitRun(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads'], {
      allowFailure: true
    }),
    gitRun(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/remotes'], {
      allowFailure: true
    }),
    gitRun(root, ['for-each-ref', '--sort=-creatordate', `--format=${format}`, 'refs/tags'], {
      allowFailure: true
    }),
    gitRun(root, ['worktree', 'list', '--porcelain', '-z'], { allowFailure: true })
  ])

  const current = await gitRun(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
  const currentBranch = current.ok ? current.stdout.trim() || null : null
  const currentWorktree = await realpath(root).catch(() => resolve(root))

  const push = (out: string, kind: GitRefOption['kind']): void => {
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const [name, short] = line.split('\t')
      if (!short || short.endsWith('/HEAD')) continue
      refs.push({ ref: short, label: name, kind, current: kind === 'local' && short === currentBranch })
    }
  }
  push(heads.stdout, 'local')
  push(remotes.stdout, 'remote')
  push(tags.stdout, 'tag')

  /*
   * worktree list --porcelain -z：`-z` 让**每一行**都以 NUL 结尾
   *（字段之间也是 NUL），所以先按 NUL 切、再按换行切一次兼容两种写法。
   * 只按「记录之间是 NUL」解析会让整份输出变成一条记录 —— 于是
   * 「分支被其它工作树占用」永远不会亮。
   */
  const busyBranches: string[] = []
  let wtPath = ''
  for (const nulChunk of worktrees.stdout.split('\0')) {
    for (const line of nulChunk.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim()
        const short = ref.replace(/^refs\/heads\//, '')
        /* 只把**别的**工作树占用的分支算进来：自己占着自己的分支是正常的 */
        if (short && resolve(wtPath) !== currentWorktree) busyBranches.push(short)
      }
    }
  }

  if (currentBranch && refs.some((r) => r.kind === 'head' && r.ref === currentBranch)) {
    /* 已存在 head 类条目时去重（正常不会走到） */
    return { refs, busyBranches, currentBranch }
  }
  if (currentBranch) {
    refs.unshift({ ref: currentBranch, label: `refs/heads/${currentBranch}`, kind: 'head', current: true })
  }
  return { refs, busyBranches, currentBranch }
}

/** 汇总仓库状态（环境菜单与审查面板头部共用一份） */
export async function readRepoState(cwd: string, opts: { withRefs?: boolean } = {}): Promise<GitRepoState | null> {
  const repo = await resolveRepo(cwd)
  if (!repo) return null
  const status = await readStatus(repo.root)
  const refs = opts.withRefs === false ? null : await listRefs(repo.root)

  let stagedCount = 0
  let unstagedCount = 0
  let untrackedCount = 0
  for (const e of status.entries) {
    if (e.ignored) continue
    if (e.untracked) {
      untrackedCount++
      continue
    }
    if (e.unmerged || (e.x !== '.' && e.x !== ' ')) stagedCount++
    if (e.unmerged || (e.y !== '.' && e.y !== ' ')) unstagedCount++
  }

  return {
    root: repo.root,
    name: repo.name,
    repoId: repo.repoId,
    worktreeId: repo.worktreeId,
    branch: status.branch,
    detached: status.detached,
    unborn: status.unborn,
    head: status.head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    busyBranches: refs?.busyBranches ?? [],
    /*
     * 去重后的变更文件数。
     * 不能拿 `stagedCount + unstagedCount` 当总数：一个文件同时有暂存与
     * 未暂存部分时会被算两次（方案 §4.1 指出的同一类错，只是单位是文件）。
     */
    changedCount: status.entries.filter((e) => !e.ignored).length,
    stagedCount,
    unstagedCount,
    untrackedCount,
    /* 没有 upstream 时「未推送数」是**未知**（null），不是 0 ——
       显示 0 会让用户以为「都推上去了」，而他其实一次都没推过 */
    unpushedCount: status.upstream ? status.ahead : null,
    hasCommit: !status.unborn && !!status.head
  }
}

/* ── 预期版本（写操作复核用，但**读**它本身是只读的）───────── */

/**
 * 读当前的实际版本。
 *
 * 放在只读模块里的原因：审查快照要**带上**它一起返回，而写操作复核时
 * 又必须与那份快照同源 —— 两边各读一次的话，「用户看到的清单」与
 * 「复核用的版本」就是两个时刻的数据，复核会变成看运气。
 *
 * `ls-files -s` 用 `-z`：文件名可能含换行，用 
 分隔会让两个不同的
 * 仓库算出同一个摘要（摘要函数用长度前缀，但输入本身必须无歧义）。
 */
export async function readExpected(root: string): Promise<GitActionExpected> {
  const [headRes, indexRes, statusRes] = await Promise.all([
    gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true, timeout: 8000 }),
    gitRun(root, ['ls-files', '-s', '-z'], { allowFailure: true }),
    gitRun(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-optional-locks'], {
      allowFailure: true
    })
  ])
  const head = headRes.ok ? headRes.stdout.trim() || null : null
  return {
    head,
    indexDigest: digestOf([indexRes.stdout]),
    statusDigest: digestOf([statusRes.stdout])
  }
}

/* ── 只读辅助 ───────────────────────────────────────────── */

/**
 * 校验 ref 是否可用（存在且能解析成提交）。
 *
 * 为什么必须校验：ref 由用户在下拉里选或手输，最终会进 git 命令行。
 * 参数数组已经挡住了 shell 注入，但 `--` 之前的**选项注入**还挡不住
 * （例如一个以 `-` 开头的「ref」会被 git 当选项）。
 * 所以：先拒掉可疑字符与开头，再让 `rev-parse --verify` 说它是否真的存在。
 */
export function refLooksSafe(ref: string): boolean {
  const s = ref.trim()
  if (!s) return false
  if (s.startsWith('-')) return false
  if (s.length > 250) return false
  /* git 的 ref 规则里不含空格 / 这些 shell 与 glob 字符 */
  return /^[\w./@^~{}+-]+$/.test(s)
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  if (!refLooksSafe(ref)) return false
  const res = await gitRun(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFailure: true,
    timeout: 8000
  })
  return res.ok && !!res.stdout.trim()
}

/**
 * 校验渲染端传来的仓库内**相对路径**。
 *
 * 与 `files.ts` 的 `safeJoin` 同一套规则（不能绝对、不能 `..`），
 * 额外拒绝以 `-` 开头的名字 —— 它会在 `git diff -- <path>` 里
 * 被当成选项（虽然 `--` 已经在前面，但 `-` 开头的路径在别处仍会出事）。
 */
export function safeRepoPath(path: string): string | null {
  const cleaned = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!cleaned || cleaned.length > 4096) return null
  if (cleaned.startsWith('-')) return null
  if (/^[A-Za-z]:/.test(cleaned)) return null
  if (cleaned.split('/').includes('..')) return null
  return cleaned
}

/** 读取未跟踪文件的行数（有界：只读前 512KB，超了按已读行数返回并标记截断） */
const UNTRACKED_READ_LIMIT = 512 * 1024

export interface UntrackedMeta {
  size: number
  mtimeMs: number
  lines: number
  truncated: boolean
  lfs: boolean
  /** 前 8000 字节里含 NUL —— 与 git 自己的二进制判据（buffer_is_binary）同一套 */
  binary: boolean
}

export async function readUntrackedMeta(absPath: string): Promise<UntrackedMeta | null> {
  try {
    const s = await stat(absPath)
    if (!s.isFile()) return null
    const meta: UntrackedMeta = {
      size: s.size,
      mtimeMs: s.mtimeMs,
      lines: 0,
      truncated: false,
      lfs: false,
      binary: false
    }
    if (s.size === 0) return meta
    const buf = await readFile(absPath).catch(() => null)
    if (!buf) return meta
    /*
     * 二进制嗅探用 git 的同一套判据（前 8000 字节里的 NUL）。
     * 不嗅探的后果很具体：一个未跟踪的 .bin / .exe 会被判成 text，
     * 然后 `filePatch` 用 `readFile(utf8)` 读它 —— 界面里会出现一屏乱码
     * （还是“看起来读到了”的那种）。
     */
    meta.binary = buf.subarray(0, 8000).includes(0)
    const text = buf.toString('utf8')
    meta.lfs = text.startsWith('version https://git-lfs.github.com/spec')
    const slice = buf.length > UNTRACKED_READ_LIMIT ? buf.subarray(0, UNTRACKED_READ_LIMIT).toString('utf8') : text
    let count = 0
    for (let i = 0; i < slice.length; i++) if (slice[i] === '\n') count++
    if (slice.length && !slice.endsWith('\n')) count++
    meta.lines = count
    meta.truncated = buf.length > UNTRACKED_READ_LIMIT
    return meta
  } catch {
    return null
  }
}
