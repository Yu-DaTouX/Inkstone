/**
 * Git 审查的**共享类型 + 纯解析逻辑**。
 *
 * 为什么解析放在 shared 而不是主进程：这些函数必须能在没有 Electron、
 * 没有真实仓库的环境下被单测（`scripts/test-git-review.mjs`）。Git 的输出
 * 格式有一堆反直觉的地方（`-z` 下的 NUL 分段、rename 多占一格、
 * 二进制是 `-` 而不是 0），把它们和 `execFile` 混在一起就没法单测，
 * 只能靠真实仓库碰运气。
 *
 * ⚠️ 本模块**不做任何 IO**，也不 import node 内置模块：渲染端也会 import 它
 *（行号计算、状态着色、范围文案）。
 *
 * 范围语义（方案 §4.1）：
 *   working   HEAD → 工作区最终内容（另含未跟踪文件，单列）
 *   unstaged  index → 工作区
 *   staged    HEAD → index（无首提交时相对空树）
 *   range     任意两个 ref 的最终树
 */

/* ── 范围 ───────────────────────────────────────────────── */

export type GitScopeKind = 'working' | 'unstaged' | 'staged' | 'range'

export interface GitScopeRequest {
  kind: GitScopeKind
  /** kind === 'range' 时的比较基准（左侧 / 旧） */
  base?: string
  /** kind === 'range' 时的目标（右侧 / 新）；省略表示工作区 */
  target?: string
}

/** 传给 git 的参数；`null` 表示这个范围不合法（缺 base/target）。 */
export interface GitScopeArgs {
  /** `git status` 是否需要（只有 working / unstaged / staged 需要未跟踪文件） */
  needStatus: boolean
  /** `git diff` 的 ref 参数（在 `--` 之前） */
  refs: string[]
  /** 无首提交时 staged 要相对空树 */
  emptyTree: boolean
}

/**
 * 把范围映射成 git 参数。
 *
 * 单独一个函数是为了能单测「范围 → 参数」这层映射：写错一个 `--cached`
 * 就会把「已暂存」显示成「工作区」，而界面上两者长得很像。
 */
export function scopeToArgs(scope: GitScopeRequest, hasHead: boolean): GitScopeArgs | null {
  switch (scope.kind) {
    case 'working':
      /* HEAD 缺失（无首提交）时 `git diff HEAD` 直接报错，退回对 index 的比较，
         未跟踪文件仍由 status 提供 —— 这与 `git diff --cached` 的结果同源。 */
      return hasHead
        ? { needStatus: true, refs: ['HEAD'], emptyTree: false }
        : { needStatus: true, refs: [], emptyTree: false }
    case 'unstaged':
      return { needStatus: true, refs: [], emptyTree: false }
    case 'staged':
      /* 无首提交时 index 要相对**空树**比较 —— `git diff --cached` 在
         某些版本会直接报 `ambiguous argument 'HEAD'`，显式给空树才确定。 */
      return hasHead
        ? { needStatus: true, refs: ['--cached'], emptyTree: false }
        : { needStatus: true, refs: ['--cached', EMPTY_TREE], emptyTree: true }
    case 'range': {
      const base = (scope.base ?? '').trim()
      const target = (scope.target ?? '').trim()
      if (!base || !target) return null
      return { needStatus: false, refs: [base, target], emptyTree: false }
    }
    default:
      return null
  }
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/* ── 单文件详情 ─────────────────────────────────────────── */

/** 单文件的 diff（结构化 hunk；渲染端做折叠、行号、高亮） */
export interface GitFilePatch {
  ok: boolean
  error?: string
  path: string
  oldPath?: string
  kind: GitFileKind
  status: GitChangeStatus | null
  binary: boolean
  truncated: boolean
  hunks: GitDiffHunk[]
  header: string[]
  additions: number
  deletions: number
  /** 未跟踪文件：内容是我们自己数出来的（不是 git diff 的输出） */
  synthesized: boolean
  requestId: string
}

/** 读某一侧的文件内容（图片预览 / 「显示完整文件」/ 缺失侧判断） */
export type GitContentSide = 'old' | 'new'

export interface GitFileContent {
  ok: boolean
  error?: string
  path: string
  side: GitContentSide
  kind: GitFileKind
  /** 该侧不存在（新增文件的旧侧 / 删除文件的新侧）——不是错误 */
  missing: boolean
  /** kind === 'text' 时的正文 */
  text?: string
  /** kind === 'image' 时的 base64（不含 `data:` 前缀） */
  base64?: string
  mimeType?: string
  bytes: number
  truncated: boolean
  requestId: string
}

/** 范围是否可能包含未跟踪文件（只有工作区侧的比较才有） */
export function scopeHasUntracked(scope: GitScopeRequest): boolean {
  return scope.kind === 'working' || scope.kind === 'unstaged'
}

/* ── 状态 / 文件 ────────────────────────────────────────── */

export type GitChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'untracked'
  | 'unknown'

/** 内容形态。决定界面用哪种呈现（文本 diff / 图片对照 / 明确的不支持说明）。 */
export type GitFileKind = 'text' | 'image' | 'binary' | 'submodule' | 'symlink' | 'lfs' | 'large'

export interface GitChangedFile {
  /** 新路径（deleted 时就是被删的那个路径）；统一用 `/` 分隔 */
  path: string
  /** rename / copy 的旧路径 */
  oldPath?: string
  status: GitChangeStatus
  /** 该文件在 index 里的状态（working 范围下与 unstaged 可能同时存在） */
  staged: GitChangeStatus | null
  /** 该文件在工作区里的状态 */
  unstaged: GitChangeStatus | null
  untracked: boolean
  unmerged: boolean
  kind: GitFileKind
  additions: number
  deletions: number
  /**
   * 两侧内容的指纹（git blob sha；未跟踪文件用 `size:mtime`）。
   * 「已查看」标记靠它失效 —— diff 一变，指纹就变，标记自动作废。
   */
  oldFingerprint: string
  newFingerprint: string
}

export interface GitFileStats {
  files: number
  additions: number
  deletions: number
  /** 无法给出行数的文件数（二进制 / 子模块） */
  binary: number
  truncated: boolean
}

export interface GitRefOption {
  ref: string
  label: string
  kind: 'local' | 'remote' | 'tag' | 'head'
  current: boolean
}

export interface GitRepoState {
  /** 工作树根目录的规范化路径（渲染端只用来显示与分组，不做拼接） */
  root: string
  name: string
  /** 仓库身份（git 的 common dir）+ 工作树身份，两者分开：worktree 共享前者 */
  repoId: string
  worktreeId: string
  branch: string | null
  detached: boolean
  unborn: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** 当前分支是否被**别的**工作树占用（切换分支前的提示来源） */
  busyBranches: string[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  /** 未推送到 upstream 的提交数；没有 upstream 时为 null */
  unpushedCount: number | null
  hasCommit: boolean
}

export interface GitReviewSnapshot {
  ok: boolean
  error?: string
  repo: GitRepoState | null
  scope: GitScopeRequest
  files: GitChangedFile[]
  stats: GitFileStats
  /** 面向用户的补充说明（无共同祖先、基准含未提交内容等） */
  notes: string[]
  /** 是否因为文件数超限而截断 */
  truncated: boolean
  /** 请求身份：渲染端切项目后丢弃迟到结果 */
  requestId: string
  generatedAt: number
}

/* ── 图片 ───────────────────────────────────────────────── */

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng'
])

export function imageExtOf(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  if (!m) return null
  const ext = m[1].toLowerCase()
  return IMAGE_EXT.has(ext) ? ext : null
}

export function mimeOfExt(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'avif':
      return 'image/avif'
    case 'apng':
      return 'image/apng'
    default:
      return 'application/octet-stream'
  }
}

/* ── git status --porcelain=v2 -z 解析 ──────────────────── */

export interface GitStatusEntry {
  /** 两位 XY：index 位 + 工作区位（`.` 表示无变化） */
  x: string
  y: string
  path: string
  /** rename / copy 的旧路径 */
  origPath?: string
  untracked: boolean
  ignored: boolean
  unmerged: boolean
}

export interface GitStatusParse {
  entries: GitStatusEntry[]
  branch: string | null
  detached: boolean
  unborn: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/**
 * 解析 `git status --porcelain=v2 -z --branch --untracked-files=all`。
 *
 * `-z` 的坑：路径是**原样**输出（不转义、不加引号），所以带空格 / 中文 /
 * 换行的路径都安全；代价是分段要用 NUL，而且 rename 条目**多占一段**
 * （`R` 条目的新路径与旧路径是两段）。
 *
 * 头部行（`# branch.*`）在 `-z` 下同样以 NUL 结尾，所以能和其他条目
 * 一样按段处理 —— 这一点和 `--porcelain=v1` 不同，别照抄旧代码。
 */
export function parseStatusV2(stdout: string): GitStatusParse {
  const out: GitStatusParse = {
    entries: [],
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0
  }
  const segs = stdout.split('\0')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg) continue
    if (seg.startsWith('# ')) {
      const rest = seg.slice(2)
      if (rest.startsWith('branch.oid ')) {
        const oid = rest.slice('branch.oid '.length).trim()
        if (oid === '(initial)') out.unborn = true
        else if (oid) out.head = oid
      } else if (rest.startsWith('branch.head ')) {
        const name = rest.slice('branch.head '.length).trim()
        if (name === '(detached)') out.detached = true
        else if (name) out.branch = name
      } else if (rest.startsWith('branch.upstream ')) {
        out.upstream = rest.slice('branch.upstream '.length).trim() || null
      } else if (rest.startsWith('branch.ab ')) {
        const m = /^\+(-?\d+)\s+-(-?\d+)$/.exec(rest.slice('branch.ab '.length).trim())
        if (m) {
          out.ahead = Number(m[1])
          out.behind = Number(m[2])
        }
      }
      continue
    }
    const code = seg[0]
    if (code === '1' || code === '2') {
      /*
       * 固定字段计数切分（path 里可能有空格，不能最后再 join 猜）：
       *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>            → 8 段
       *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> → 9 段
       */
      const fields = code === '1' ? 8 : 9
      const parts = seg.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(fields).join(' ')
      const entry: GitStatusEntry = {
        x: xy[0] ?? '.',
        y: xy[1] ?? '.',
        path,
        untracked: false,
        ignored: false,
        unmerged: false
      }
      if (code === '2') {
        /* 旧路径在**下一段**（-z 专有的排列） */
        const orig = segs[i + 1] ?? ''
        if (orig) entry.origPath = orig
        i++
      }
      out.entries.push(entry)
      continue
    }
    if (code === 'u') {
      /* u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> → 10 段 */
      const parts = seg.split(' ')
      const xy = parts[1] ?? 'UU'
      out.entries.push({
        x: xy[0] ?? 'U',
        y: xy[1] ?? 'U',
        path: parts.slice(10).join(' '),
        untracked: false,
        ignored: false,
        unmerged: true
      })
      continue
    }
    if (code === '?' || code === '!') {
      const path = seg.slice(2)
      if (!path) continue
      out.entries.push({
        x: code,
        y: code,
        path,
        untracked: code === '?',
        ignored: code === '!',
        unmerged: false
      })
      continue
    }
  }
  return out
}

/* ── git diff --raw -z 解析 ────────────────────────────── */

export interface GitRawEntry {
  oldMode: string
  newMode: string
  oldSha: string
  newSha: string
  /** R100 / C75 / M / A / D / T 等 */
  code: string
  path: string
  oldPath?: string
}

/**
 * 解析 `git diff --raw -z -M`。
 *
 * 段排列：`:100644 100644 <old> <new> <code>` 然后 NUL，然后 path；
 * rename / copy 的 code 带相似度（`R100`），其后**两段**分别是旧路径与新路径。
 * mode `160000` 是子模块，`120000` 是符号链接 —— 判断它们只能从这里拿。
 */
export function parseDiffRaw(stdout: string): GitRawEntry[] {
  const out: GitRawEntry[] = []
  const segs = stdout.split('\0')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg.startsWith(':')) continue
    const parts = seg.slice(1).split(' ')
    if (parts.length < 5) continue
    const [oldMode, newMode, oldSha, newSha] = parts
    const code = parts[4]
    const isRename = code.startsWith('R') || code.startsWith('C')
    const first = segs[i + 1] ?? ''
    if (isRename) {
      const second = segs[i + 2] ?? ''
      i += 2
      out.push({ oldMode, newMode, oldSha, newSha, code, oldPath: first, path: second })
    } else {
      i += 1
      out.push({ oldMode, newMode, oldSha, newSha, code, path: first })
    }
  }
  return out
}

/* ── git diff --numstat -z 解析 ────────────────────────── */

export interface GitNumstatEntry {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

/**
 * 解析 `git diff --numstat -z -M`。
 *
 * 两种形状：
 *   普通      `12\t3\tpath\0`
 *   rename    `12\t3\t\0old\0new\0`   ← 第三列是**空**的，旧新路径各占一段
 * 二进制时前两列是 `-`（不是 0）—— 当成 0 计数会把「二进制改动」
 * 显示成「+0 -0」，用户会以为没改动。
 */
export function parseNumstat(stdout: string): GitNumstatEntry[] {
  const out: GitNumstatEntry[] = []
  const segs = stdout.split('\0')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg) continue
    const firstTab = seg.indexOf('\t')
    if (firstTab < 0) continue
    const secondTab = seg.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue
    const addRaw = seg.slice(0, firstTab)
    const delRaw = seg.slice(firstTab + 1, secondTab)
    const path = seg.slice(secondTab + 1)
    const binary = addRaw === '-' || delRaw === '-'
    const additions = binary ? 0 : Number(addRaw) || 0
    const deletions = binary ? 0 : Number(delRaw) || 0
    if (path) {
      out.push({ path, additions, deletions, binary })
      continue
    }
    /* rename / copy：旧、新各占一段 */
    const oldPath = segs[i + 1] ?? ''
    const newPath = segs[i + 2] ?? ''
    i += 2
    if (newPath) out.push({ path: newPath, oldPath, additions, deletions, binary })
  }
  return out
}

/* ── 把上面几份输出合成文件清单 ─────────────────────────── */

const STATUS_LETTER: Record<string, GitChangeStatus> = {
  M: 'modified',
  T: 'typechange',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged'
}

/** 把 porcelain 的单字符状态映射成语义状态；`.` / 空格 / `?` 返回 null。 */
export function letterToStatus(letter: string): GitChangeStatus | null {
  if (!letter || letter === '.' || letter === ' ') return null
  if (letter === '?') return 'untracked'
  return STATUS_LETTER[letter] ?? 'unknown'
}

function rawCodeToStatus(code: string): GitChangeStatus {
  const c = code[0]
  if (c === 'R') return 'renamed'
  if (c === 'C') return 'copied'
  if (c === 'A') return 'added'
  if (c === 'D') return 'deleted'
  if (c === 'T') return 'typechange'
  if (c === 'U') return 'unmerged'
  return 'modified'
}

function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 判断内容形态。**顺序有意义**：
 *   子模块 / 符号链接先判（它们由 mode 决定，扩展名会骗人），
 *   再图片、再 LFS（靠内容特征，调用方传 hint）、最后二进制。
 */
export function classifyKind(
  path: string,
  opts: { mode?: string; binary?: boolean; lfs?: boolean; size?: number; largeAt?: number } = {}
): GitFileKind {
  if (opts.mode === '160000') return 'submodule'
  if (opts.mode === '120000') return 'symlink'
  if (opts.lfs) return 'lfs'
  if (imageExtOf(path)) return 'image'
  const limit = opts.largeAt ?? 2 * 1024 * 1024
  if (typeof opts.size === 'number' && opts.size > limit) return 'large'
  if (opts.binary || extOf(path) === 'pdf') return 'binary'
  return 'text'
}

/**
 * 合成文件清单。
 *
 * `raw` 提供 mode / sha（决定子模块与指纹），`numstat` 提供行数，
 * `status` 提供未跟踪与「同一文件同时有暂存与未暂存部分」的双状态。
 *
 * 未跟踪文件**只走 status**：它们不在任何 diff 输出里，
 * 所以 numstat 的增删要用主进程数出来的行数补（这里接受调用方传进来的值）。
 */
export function buildChangedFiles(input: {
  raw: GitRawEntry[]
  numstat: GitNumstatEntry[]
  status: GitStatusParse
  /** 未跟踪文件的行数（主进程有界统计；拿不到时给 0） */
  untrackedLines: Record<string, number>
  /** 未跟踪文件的大小与 mtime，用于指纹与 kind 判定 */
  untrackedMeta: Record<string, { size: number; mtimeMs: number }>
  /** 未跟踪文件是否 LFS 指针 */
  lfsPaths?: string[]
}): GitChangedFile[] {
  const byPath = new Map<string, GitChangedFile>()
  const key = (p: string): string => p.replace(/\\/g, '/')
  const lfs = new Set(input.lfsPaths ?? [])

  const ensure = (path: string): GitChangedFile => {
    const k = key(path)
    let f = byPath.get(k)
    if (!f) {
      f = {
        path: k,
        status: 'modified',
        staged: null,
        unstaged: null,
        untracked: false,
        unmerged: false,
        kind: 'text',
        additions: 0,
        deletions: 0,
        oldFingerprint: '',
        newFingerprint: ''
      }
      byPath.set(k, f)
    }
    return f
  }

  /* 1. raw：mode 与 blob sha（指纹的来源） */
  const rawByPath = new Map<string, GitRawEntry>()
  for (const r of input.raw) {
    const f = ensure(r.path)
    rawByPath.set(key(r.path), r)
    f.oldFingerprint = r.oldSha
    f.newFingerprint = r.newSha
    if (r.oldPath) f.oldPath = key(r.oldPath)
    const st = rawCodeToStatus(r.code)
    if (f.unstaged === null && f.staged === null) f.status = st
    f.kind = classifyKind(r.path, { mode: r.newMode, size: undefined })
  }

  /* 2. numstat：行数 */
  for (const n of input.numstat) {
    const f = ensure(n.path)
    if (n.oldPath && !f.oldPath) f.oldPath = key(n.oldPath)
    f.additions = n.additions
    f.deletions = n.deletions
    if (n.binary) f.kind = f.kind === 'submodule' ? 'submodule' : 'binary'
  }

  /* 3. status：未跟踪、未合并，以及 index / 工作区的**双状态** */
  for (const e of input.status.entries) {
    if (e.ignored) continue
    const f = ensure(e.path)
    if (e.untracked) {
      f.untracked = true
      f.status = 'untracked'
      f.staged = null
      f.unstaged = 'untracked'
      const lines = input.untrackedLines[key(e.path)]
      f.additions = typeof lines === 'number' ? lines : 0
      const meta = input.untrackedMeta[key(e.path)]
      f.newFingerprint = meta ? `u:${meta.size}:${Math.round(meta.mtimeMs)}` : 'u:0:0'
      f.kind = classifyKind(e.path, {
        size: meta?.size,
        lfs: lfs.has(key(e.path))
      })
      continue
    }
    if (e.unmerged) {
      f.unmerged = true
      f.status = 'unmerged'
      f.staged = 'unmerged'
      f.unstaged = 'unmerged'
      continue
    }
    const x = letterToStatus(e.x)
    const y = letterToStatus(e.y)
    f.staged = x
    f.unstaged = y
    if (e.origPath) f.oldPath = key(e.origPath)
    /* 有未暂存改动时以工作区状态为主显示（用户看到的是磁盘上的现状） */
    const primary = y ?? x
    if (primary) f.status = primary
    if (x === 'renamed' || x === 'copied') f.status = x
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
}

export function summarize(files: GitChangedFile[], truncated: boolean): GitFileStats {
  let additions = 0
  let deletions = 0
  let binary = 0
  for (const f of files) {
    additions += f.additions
    deletions += f.deletions
    if (f.kind === 'binary' || f.kind === 'submodule' || f.kind === 'lfs' || f.kind === 'large') binary++
  }
  return { files: files.length, additions, deletions, binary, truncated }
}

/* ── unified diff 解析 ─────────────────────────────────── */

export interface GitDiffLine {
  type: 'add' | 'del' | 'ctx' | 'none'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface GitDiffHunk {
  header: string
  section: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: GitDiffLine[]
}

export interface GitFileDiff {
  path: string
  oldPath?: string
  header: string[]
  hunks: GitDiffHunk[]
  binary: boolean
  truncated: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * 解析 unified diff（`git diff` 的 stdout）。
 *
 * 为什么自己解析而不直接渲染文本：界面要「逐文件折叠 + 语法高亮 +
 * 滚动到指定行 + 记住已查看」，这些都需要行号与行类型结构。
 * 解析本身是纯函数，错了单测能立刻发现。
 *
 * `\ No newline at end of file` 归到 `none`：它不是内容行，
 * 给它算行号会让之后所有行号偏移 1。
 */
export function parseUnifiedDiff(text: string): GitFileDiff[] {
  const files: GitFileDiff[] = []
  if (!text) return files
  const lines = text.split('\n')

  let cur: GitFileDiff | null = null
  let hunk: GitDiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const push = (): void => {
    if (!cur) return
    if (hunk) cur.hunks.push(hunk)
    /* 新侧缺失（删除文件）时回退到旧侧路径，保证 path 总是可用的 */
    if (!cur.path && cur.oldPath) cur.path = cur.oldPath
    files.push(cur)
    cur = null
    hunk = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      push()
      /*
       * `diff --git a/x b/y` —— 这里**只能当兜底**。
       * 路径含空格时 git 不加引号（只有 `"` `\` 控制字符才引号转义），
       * 于是 `a/x y b/x y` 这行本身是有歧义的：贪婪匹配会把 b 侧切碎。
       * 真正可靠的路径来自下面的 `---` / `+++` 两行（各只有一个路径），
       * 所以这里用非贪婪，拿到的值稍后会被覆盖。
       */
      const m = /^diff --git (.+?) (.+)$/.exec(line)
      const newPart = m ? unquoteGitPath(m[2]) : ''
      cur = {
        path: stripAbPrefix(newPart),
        header: [line],
        hunks: [],
        binary: false,
        truncated: false
      }
      continue
    }
    if (!cur) continue

    if (line.startsWith('@@')) {
      if (hunk) cur.hunks.push(hunk)
      const m = HUNK_RE.exec(line)
      if (m) {
        hunk = {
          header: line,
          section: (m[5] ?? '').trim(),
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          lines: []
        }
        oldNo = hunk.oldStart
        newNo = hunk.newStart
      } else {
        hunk = null
      }
      continue
    }

    if (line.startsWith('--- ')) {
      cur.header.push(line)
      const p = stripAbPrefix(unquoteGitPath(line.slice(4).trim()))
      if (p && p !== '/dev/null') cur.oldPath = p
      continue
    }
    if (line.startsWith('+++ ')) {
      cur.header.push(line)
      const p = stripAbPrefix(unquoteGitPath(line.slice(4).trim()))
      /*
       * 删除文件的 `+++` 是 `/dev/null` —— 这时**新侧不存在**，
       * 路径必须以旧侧为准（否则删除的文件会用 `diff --git` 那行
       * 被空格切碎的名字，看起来像另一个文件）。
       */
      cur.path = p === '/dev/null' ? '' : p
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.binary = true
      cur.header.push(line)
      continue
    }
    if (line.startsWith('index ') || line.startsWith('new file ') || line.startsWith('deleted file ') || line.startsWith('old mode ') || line.startsWith('new mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ') || line.startsWith('copy from ') || line.startsWith('copy to ')) {
      cur.header.push(line)
      if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
        cur.oldPath = line.slice(line.indexOf(' ') + 1)
      }
      if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        /* 纯改名（内容未变）时 diff 里**没有** --- / +++ 行，
           路径只能从 rename to 拿 —— 它同时决定了这个条目挂在哪个文件名下。 */
        cur.path = line.slice(line.indexOf(' ') + 1)
      }
      continue
    }
    if (line.startsWith('\\')) {
      if (hunk) hunk.lines.push({ type: 'none', text: line, oldLine: null, newLine: null })
      continue
    }

    if (!hunk) continue
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), oldLine: null, newLine: newNo })
      newNo++
      continue
    }
    if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldLine: oldNo, newLine: null })
      oldNo++
      continue
    }
    if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldLine: oldNo, newLine: newNo })
      oldNo++
      newNo++
      continue
    }
    /* 空行（diff 末尾常见）不构成内容行 */
  }
  push()
  return files
}

/** 去掉 `a/` `b/` 前缀（`/dev/null` 保持原样由调用方处理） */
export function stripAbPrefix(p: string): string {
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2)
  return p
}

/**
 * 还原 git 加引号的路径。
 *
 * `core.quotepath=false` 之外，路径**含双引号 / 反斜杠 / 控制字符**时
 * git 仍会用 C 风格转义（`"a\"b"`）。这类路径少见但不能崩 ——
 * 还原失败时原样返回，界面至少还能显示。
 *
 * 八进制转义是**字节**（`\344\270\255` = “中”的 UTF-8 三字节），
 * 不能用 `String.fromCharCode` 逐个当字符 —— 那样会得到三个乱码字符。
 * 所以统一走字节缓冲 + TextDecoder。
 */
export function unquoteGitPath(raw: string): string {
  const s = raw.trim()
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const pushChar = (ch: string): void => {
    for (const b of encoder.encode(ch)) bytes.push(b)
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      pushChar(ch)
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    switch (next) {
      case 'n': pushChar('\n'); break
      case 't': pushChar('\t'); break
      case 'r': pushChar('\r'); break
      case 'a': pushChar('\x07'); break
      case 'b': pushChar('\b'); break
      case 'f': pushChar('\f'); break
      case 'v': pushChar('\v'); break
      case '"': pushChar('"'); break
      case '\\': pushChar('\\'); break
      default:
        if (/[0-7]/.test(next)) {
          let oct = next
          for (let k = 0; k < 2 && /[0-7]/.test(body[i + 1] ?? ''); k++) oct += body[++i]
          bytes.push(parseInt(oct, 8) & 0xff)
        } else {
          pushChar(next)
        }
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/** 从 diff 文本里数出单个文件的增删（不依赖 numstat，用于 patch 响应自带统计） */
export function countDiffLines(files: GitFileDiff[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type === 'add') additions++
        else if (l.type === 'del') deletions++
      }
    }
  }
  return { additions, deletions }
}

/* ── 「已查看」的持久化键 ───────────────────────────────── */

/**
 * 已查看标记的身份。
 *
 * 为什么不只用路径：切换分支 / 基准之后，同名路径的内容可能完全不同；
 * 只看路径会把「已看过新版本」错误地沿用旧标记。方案 §4.3 要求
 * 键至少包含仓库、工作树、范围、两侧路径与两侧内容指纹 —— 这里就是它。
 */
export function viewedKey(input: {
  repoId: string
  worktreeId: string
  scope: string
  path: string
  oldPath?: string
  oldFingerprint: string
  newFingerprint: string
}): string {
  return [
    input.repoId,
    input.worktreeId,
    input.scope,
    input.path,
    input.oldPath ?? '',
    input.oldFingerprint,
    input.newFingerprint
  ].join('|')
}

/** 范围的身份串（进 viewedKey，也是刷新时的比较键） */
export function scopeIdentity(scope: GitScopeRequest): string {
  if (scope.kind === 'range') return `range:${scope.base ?? ''}..${scope.target ?? ''}`
  return scope.kind
}

export const GIT_SCOPE_LABELS: Record<GitScopeKind, string> = {
  working: '工作区全部改动',
  unstaged: '未暂存',
  staged: '已暂存',
  range: '两端比较'
}
