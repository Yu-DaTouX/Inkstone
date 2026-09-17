/**
 * Git 审查的数据层：清单、统计、单文件 diff、两侧内容。
 *
 * 与 `git-service.ts` 的分工：那边管「仓库是谁、现在什么状态」（每会话一次），
 * 这边管「这个范围里改了哪些文件、每个文件长什么样」（每次打开/刷新/点文件）。
 *
 * 三条硬约束（方案 §2.1 / §11）：
 *   1. **只读**：不 add / commit / checkout / reset / stash。打开审查不能
 *      改变用户的暂存区 —— 这是与 `subagent-isolation.collectDiff()` 的
 *      根本区别，那条路径在隔离 worktree 里 `add -A`，主工作区不能用。
 *   2. **不带正文进全局快照**：清单只回路径、状态与行数；正文按文件懒加载，
 *      否则一个 10MB 的 diff 会塞进每次 IPC 响应。
 *   3. **不做无限量的工作**：文件数与单文件正文都有上限，超了明确标记
 *      `truncated`（而不是假装完整）。
 */
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import type {
  GitContentSide,
  GitDiffHunk,
  GitFileContent,
  GitFileKind,
  GitFilePatch,
  GitReviewSnapshot,
  GitScopeArgs,
  GitScopeRequest
} from '../shared/git'
import {
  buildChangedFiles,
  classifyKind,
  countDiffLines,
  imageExtOf,
  mimeOfExt,
  parseDiffRaw,
  parseNumstat,
  parseUnifiedDiff,
  scopeToArgs,
  scopeHasUntracked,
  summarize
} from '../shared/git'
import {
  gitRun,
  readRepoState,
  readStatus,
  readUntrackedMeta,
  refExists,
  resolveRepo,
  safeRepoPath,
  type RepoIdentity
} from './git-service'

const execFileAsync = promisify(execFile)

/** 清单最多回多少个文件（超了截断；界面明确说「还有 N 个未列出」） */
const MAX_FILES = 800
/** 单文件正文上限：超过就不加载，只给类型与大小 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/* ── 二进制输出（图片） ─────────────────────────────────── */

/**
 * 读 git 对象时**必须**用 buffer 编码：`encoding: 'utf8'` 会把 PNG 的
 * 非 UTF-8 字节替换成 U+FFFD，图片就毁了（而且看起来「读到了」）。
 */
async function gitBinary(cwd: string, args: string[]): Promise<Buffer | null> {
  try {
    const res = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: MAX_IMAGE_BYTES + 1024 * 1024,
      encoding: 'buffer'
    })
    return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout))
  } catch {
    return null
  }
}

/* ── 清单 ───────────────────────────────────────────────── */

/** 取一次仓库状态（给失败响应也带上 repo，界面仍能显示分支等信息） */
async function repoStateOf(cwd: string) {
  return readRepoState(cwd, { withRefs: false })
}

export interface ReviewQuery {
  /** 会话的工作目录（主进程按已登记项目解析，渲染端只能传它） */
  cwd: string
  scope: GitScopeRequest
  requestId: string
  /** 有任务在写这个仓库时由调用方置位（G2 的写操作会用它做阻断） */
  busy?: boolean
}

function emptyStats(truncated = false) {
  return { files: 0, additions: 0, deletions: 0, binary: 0, truncated }
}

export async function reviewSnapshot(q: ReviewQuery): Promise<GitReviewSnapshot> {
  const base: GitReviewSnapshot = {
    ok: true,
    repo: null,
    scope: q.scope,
    files: [],
    stats: emptyStats(),
    notes: [],
    truncated: false,
    requestId: q.requestId,
    generatedAt: Date.now()
  }

  const repo = await resolveRepo(q.cwd)
  if (!repo) {
    /* 非 Git 项目不是错误：界面显示「未使用 Git」并保留文件来源等功能 */
    return { ...base, notes: ['这个目录不在 Git 仓库里'] }
  }

  let status
  try {
    status = await readStatus(repo.root)
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error), repo: null }
  }

  if (q.scope.kind === 'range') {
    const okBase = await refExists(repo.root, q.scope.base ?? '')
    const okTarget = await refExists(repo.root, q.scope.target ?? '')
    if (!okBase || !okTarget) {
      return {
        ...base,
        ok: false,
        error: `比较的基准或目标不存在：${q.scope.base ?? '(空)'} → ${q.scope.target ?? '(空)'}`,
        repo: await repoStateOf(q.cwd)
      }
    }
  }

  const args = scopeToArgs(q.scope, !status.unborn)
  if (!args) {
    return { ...base, ok: false, error: '比较范围不完整（需要基准与目标两端）', repo: await repoStateOf(q.cwd) }
  }

  const diffArgs = diffArgv(args)
  const [rawRes, numstatRes] = await Promise.all([
    gitRun(repo.root, ['diff', '--raw', '-z', '-M', '--no-color', ...diffArgs], { allowFailure: true }),
    gitRun(repo.root, ['diff', '--numstat', '-z', '-M', '--no-color', ...diffArgs], { allowFailure: true })
  ])
  if (!rawRes.ok && !numstatRes.ok && !rawRes.stdout && !numstatRes.stdout) {
    return {
      ...base,
      ok: false,
      error: rawRes.error ?? numstatRes.error ?? 'git diff 失败',
      repo: await repoStateOf(q.cwd)
    }
  }

  const raw = parseDiffRaw(rawRes.stdout)
  const numstat = parseNumstat(numstatRes.stdout)

  /*
   * `git status` 给出的是**仓库全局**状态，而我们要的是**这个范围**里的文件。
   * 不过滤的后果很具体（真实仓库测试抓到的）：选了「未暂存」却把
   * 只暂存过的文件也列出来，选了「已暂存」还把未跟踪文件混在里面 ——
   * 两个范围给出同一份清单，用户根本分不出自己在看什么。
   */
  const statusForScope: typeof status = {
    ...status,
    entries: args.needStatus
      ? status.entries.filter((e) => {
          if (e.ignored) return false
          if (e.untracked) return scopeHasUntracked(q.scope)
          if (e.unmerged) return true
          const inIndex = e.x !== '.' && e.x !== ' '
          const inWorktree = e.y !== '.' && e.y !== ' '
          if (q.scope.kind === 'staged') return inIndex
          if (q.scope.kind === 'unstaged') return inWorktree
          return true
        })
      : []
  }

  /* 未跟踪文件：只在工作区侧的范围里出现，且**只能**从 status 拿 */
  const untrackedLines: Record<string, number> = {}
  const untrackedMeta: Record<string, { size: number; mtimeMs: number; binary?: boolean }> = {}
  const lfsPaths: string[] = []
  if (scopeHasUntracked(q.scope)) {
    const untracked = status.entries.filter((e) => e.untracked).slice(0, MAX_FILES)
    await Promise.all(
      untracked.map(async (e) => {
        const meta = await readUntrackedMeta(join(repo.root, e.path))
        if (!meta) return
        untrackedLines[e.path] = meta.lines
        untrackedMeta[e.path] = { size: meta.size, mtimeMs: meta.mtimeMs, binary: meta.binary }
        if (meta.lfs) lfsPaths.push(e.path)
      })
    )
  }

  const all = buildChangedFiles({
    raw,
    numstat,
    status: statusForScope,
    untrackedLines,
    untrackedMeta,
    lfsPaths
  })
  const files = all.slice(0, MAX_FILES)
  const truncated = all.length > files.length
  const stats = summarize(files, truncated)

  const notes: string[] = []
  if (q.scope.kind === 'working' && files.some((f) => f.staged && f.unstaged)) {
    /*
     * 方案 §4.1 明确要求：总览**不能**把已暂存与未暂存的行数相加 ——
     * 同一段内容可能被两处同时算到。这里给用户一句实话。
     */
    notes.push('有些文件同时有已暂存与未暂存的部分，行数统计按最终内容算，不重复相加')
  }
  if (q.scope.kind === 'range') {
    const mergeBase = await gitRun(repo.root, ['merge-base', q.scope.base!, q.scope.target!], {
      allowFailure: true,
      timeout: 8000
    })
    if (!mergeBase.ok || !mergeBase.stdout.trim()) {
      notes.push('两端没有共同祖先，显示的是两棵最终树的直接差异（不是「分支改动」）')
    } else {
      notes.push('这是两端最终树的直接差异，不含未提交内容')
    }
    if (status.entries.length) {
      notes.push('工作区还有未提交改动，它们不在这个比较里')
    }
  }
  if (q.busy) notes.push('这个仓库里有任务正在写入，切换分支或提交前请先等它停下')

  return {
    ok: true,
    repo: await repoStateOf(q.cwd),
    scope: q.scope,
    files,
    stats,
    notes,
    truncated,
    requestId: q.requestId,
    generatedAt: Date.now()
  }
}

/**
 * 组装 `git diff` 的**公共参数**。
 *
 * `--no-ext-diff`：用户在 gitconfig 里配的 external diff 程序会让输出完全
 * 不是 unified diff（甚至弹 GUI），而我们的解析依赖统一格式。
 * `--no-textconv`：它会把二进制转成文本，我们就没法正确判「这是二进制」。
 * 两个开关都在**参数里**给一遍 —— 环境变量那层只是兜底（用户在
 * 别处 spawn 的 git 不受我们控制）。
 */
function diffArgv(args: GitScopeArgs): string[] {
  return ['--no-ext-diff', '--no-textconv', ...args.refs]
}

/* ── 单文件 diff ────────────────────────────────────────── */

export interface FileQuery extends ReviewQuery {
  path: string
  oldPath?: string
  /** 未跟踪文件（不在 git diff 里，内容要自己生成） */
  untracked?: boolean
}

function failPatch(q: FileQuery, error: string): GitFilePatch {
  return {
    ok: false,
    error,
    path: q.path,
    kind: 'text',
    status: null,
    binary: false,
    truncated: false,
    hunks: [],
    header: [],
    additions: 0,
    deletions: 0,
    synthesized: false,
    requestId: q.requestId
  }
}

export async function filePatch(q: FileQuery): Promise<GitFilePatch> {
  const path = safeRepoPath(q.path)
  if (!path) return failPatch(q, '文件路径不合法')
  const repo = await resolveRepo(q.cwd)
  if (!repo) return failPatch(q, '这个目录不在 Git 仓库里')

  /* 未跟踪文件：git diff 里没有它，直接把内容合成一个「全新增」的 hunk */
  if (q.untracked) return synthesizeAdded(repo, path, q)

  const status = await readStatus(repo.root)
  const args = scopeToArgs(q.scope, !status.unborn)
  if (!args) return failPatch(q, '比较范围不完整')

  const paths = [path]
  if (q.oldPath && q.oldPath !== path && safeRepoPath(q.oldPath)) paths.push(q.oldPath)

  const res = await gitRun(
    repo.root,
    ['diff', '--no-color', '-M', ...diffArgv(args), '--', ...paths],
    { allowFailure: true }
  )
  const parsed = parseUnifiedDiff(res.stdout)
  const hit = parsed.find((f) => f.path === path || f.oldPath === path || (q.oldPath && f.path === q.oldPath)) ?? null

  if (!hit) {
    /*
     * 拿不到内容**不是失败**：可能是「只有 mode / 改名」这类没有正文的改动，
     * 也可能是路径在两侧都不同。返回空 patch 并说明，界面显示「没有文本差异」。
     */
    return {
      ok: true,
      path,
      oldPath: q.oldPath,
      kind: 'text',
      status: null,
      binary: false,
      truncated: false,
      hunks: [],
      header: res.ok ? [] : [res.error ?? ''],
      additions: 0,
      deletions: 0,
      synthesized: false,
      requestId: q.requestId
    }
  }

  const counts = countDiffLines([hit])
  const imageExt = imageExtOf(hit.path || path)
  const kind: GitFileKind = imageExt ? 'image' : hit.binary ? 'binary' : 'text'
  return {
    ok: true,
    path: hit.path || path,
    oldPath: hit.oldPath ?? q.oldPath,
    kind,
    status: null,
    binary: hit.binary,
    truncated: false,
    hunks: hit.hunks,
    header: hit.header,
    additions: counts.additions,
    deletions: counts.deletions,
    synthesized: false,
    requestId: q.requestId
  }
}

/** 未跟踪文件 → 一个「全部新增」的 hunk（界面与新增文件长得一样） */
async function synthesizeAdded(repo: RepoIdentity, path: string, q: FileQuery): Promise<GitFilePatch> {
  const abs = join(repo.root, path)
  const meta = await readUntrackedMeta(abs)
  if (!meta) {
    return { ...failPatch(q, '文件读不出来（可能已被删除）'), path }
  }
  const kind: GitFileKind = classifyKind(path, { size: meta.size, lfs: meta.lfs, binary: meta.binary })
  if (kind !== 'text') {
    return {
      ok: true,
      path,
      kind,
      status: 'untracked',
      binary: kind !== 'image',
      truncated: meta.truncated,
      hunks: [],
      header: [],
      additions: 0,
      deletions: 0,
      synthesized: true,
      requestId: q.requestId
    }
  }
  const text = await readFile(abs, 'utf8').catch(() => '')
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : []
  const hunks: GitDiffHunk[] =
    lines.length === 0
      ? []
      : [
          {
            header: `@@ -0,0 +1,${lines.length} @@`,
            section: '',
            oldStart: 0,
            oldCount: 0,
            newStart: 1,
            newCount: lines.length,
            lines: lines.map((l, i) => ({ type: 'add' as const, text: l, oldLine: null, newLine: i + 1 }))
          }
        ]
  return {
    ok: true,
    path,
    kind: 'text',
    status: 'untracked',
    binary: false,
    truncated: meta.truncated,
    hunks,
    header: ['untracked file'],
    additions: lines.length,
    deletions: 0,
    synthesized: true,
    requestId: q.requestId
  }
}

/* ── 某一侧的内容 ───────────────────────────────────────── */

/**
 * 读某一侧的内容。
 *
 * 两侧的来源随范围变化（方案 §4.2）：
 *   working   old = HEAD，new = 工作区
 *   unstaged  old = index，new = 工作区
 *   staged    old = HEAD，new = index
 *   range     old = base，new = target
 *
 * 「index 侧」用 `git cat-file blob :<path>`（stage 0 的写法）读取 ——
 * 直接读工作区文件会拿到未暂存的版本，那就不是「已暂存」的内容了。
 */
export interface ContentQuery extends ReviewQuery {
  path: string
  side: GitContentSide
}

export async function fileContent(q: ContentQuery): Promise<GitFileContent> {
  const path = safeRepoPath(q.path)
  const fail = (error: string): GitFileContent => ({
    ok: false,
    error,
    path: q.path,
    side: q.side,
    kind: 'text',
    missing: false,
    bytes: 0,
    truncated: false,
    requestId: q.requestId
  })
  if (!path) return fail('文件路径不合法')
  const repo = await resolveRepo(q.cwd)
  if (!repo) return fail('这个目录不在 Git 仓库里')

  const spec = await sideSpec(repo, q.scope, q.side)
  if (!spec) return fail('比较范围不完整')

  const imageExt = imageExtOf(path)
  const limit = imageExt ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES

  /* 工作区（磁盘）侧：直接读文件 */
  if (spec.kind === 'worktree') {
    const abs = join(repo.root, path)
    try {
      const s = await stat(abs)
      if (!s.isFile()) {
        return { ...fail('这不是一个普通文件'), missing: true }
      }
      if (s.size > limit) {
        return {
          ok: true,
          path,
          side: q.side,
          kind: imageExt ? 'image' : 'large',
          missing: false,
          bytes: s.size,
          truncated: true,
          requestId: q.requestId
        }
      }
      const buf = await readFile(abs)
      return finishContent(q, path, buf, imageExt, limit)
    } catch {
      /* 文件不存在（例如刚被删掉）—— 这是**缺失**，不是错误 */
      return {
        ok: true,
        path,
        side: q.side,
        kind: imageExt ? 'image' : 'text',
        missing: true,
        bytes: 0,
        truncated: false,
        requestId: q.requestId
      }
    }
  }

  /* git 对象侧 */
  const spec_rev = spec.kind === 'index' ? `:${path}` : `${spec.rev}:${path}`
  const buf = await gitBinary(repo.root, ['cat-file', 'blob', spec_rev])
  if (!buf) {
    return {
      ok: true,
      path,
      side: q.side,
      kind: imageExt ? 'image' : 'text',
      missing: true,
      bytes: 0,
      truncated: false,
      requestId: q.requestId
    }
  }
  if (buf.length > limit) {
    return {
      ok: true,
      path,
      side: q.side,
      kind: imageExt ? 'image' : 'large',
      missing: false,
      bytes: buf.length,
      truncated: true,
      requestId: q.requestId
    }
  }
  return finishContent(q, path, buf, imageExt, limit)
}

function finishContent(
  q: ContentQuery,
  path: string,
  buf: Buffer,
  imageExt: string | null,
  limit: number
): GitFileContent {
  if (imageExt) {
    return {
      ok: true,
      path,
      side: q.side,
      kind: 'image',
      missing: false,
      base64: buf.toString('base64'),
      mimeType: mimeOfExt(imageExt),
      bytes: buf.length,
      truncated: false,
      requestId: q.requestId
    }
  }
  /* 二进制嗅探：NUL 字节是 git 自己的判据（`buffer_is_binary` 看前 8000 字节） */
  const probe = buf.subarray(0, 8000)
  if (probe.includes(0)) {
    return {
      ok: true,
      path,
      side: q.side,
      kind: 'binary',
      missing: false,
      bytes: buf.length,
      truncated: false,
      requestId: q.requestId
    }
  }
  return {
    ok: true,
    path,
    side: q.side,
    kind: 'text',
    missing: false,
    text: buf.toString('utf8'),
    bytes: buf.length,
    truncated: buf.length > limit,
    requestId: q.requestId
  }
}

type SideSpec = { kind: 'worktree' } | { kind: 'index' } | { kind: 'rev'; rev: string }

/**
 * 「这一侧该从哪里读」。
 *
 * `side === 'new'` 且范围含工作区时读磁盘（用户看到的是磁盘现状）；
 * `staged` 的 new 侧读 index；`range` 的 new 侧读目标提交。
 */
async function sideSpec(repo: RepoIdentity, scope: GitScopeRequest, side: GitContentSide): Promise<SideSpec | null> {
  switch (scope.kind) {
    case 'working':
      return side === 'old' ? { kind: 'rev', rev: 'HEAD' } : { kind: 'worktree' }
    case 'unstaged':
      return side === 'old' ? { kind: 'index' } : { kind: 'worktree' }
    case 'staged':
      return side === 'old' ? { kind: 'rev', rev: 'HEAD' } : { kind: 'index' }
    case 'range': {
      const ref = side === 'old' ? scope.base : scope.target
      if (!ref) return null
      if (!(await refExists(repo.root, ref))) return null
      return { kind: 'rev', rev: ref }
    }
    default:
      return null
  }
}

/** 让「已查看」的指纹有东西可算（无 HEAD 的仓库给空串） */
export async function headSha(root: string): Promise<string> {
  const res = await gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true, timeout: 8000 })
  return res.ok ? res.stdout.trim() : ''
}
