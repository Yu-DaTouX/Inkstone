/**
 * 只读改动读取（`yan:git:changes` / `yan:git:diff` 的数据层）。
 *
 * ── 它存在的原因 ──
 * R4「改动」面板需要逐文件条目与单文件补丁。旧的 `yan:git:state` 只回聚合
 * 计数、`yan:git:untracked` 只回路径，界面因此看不到真实 diff。这里补上
 * **唯一**一条读通道，且只有读。
 *
 * ── 硬边界 ──
 * · **绝不**调用 `git add` / `commit` / `stash` / `reset` / `checkout` /
 *   `fetch` / `push`；也绝不走 subagent 的 `collectDiff()`（它会 `git add -A`，
 *   打开一次审查就会改用户的暂存区）。
 * · 所有命令都是**固定参数数组**（不拼 shell），带 `--no-ext-diff`
 *   `--no-textconv` `--no-color` `--no-renames`，路径前有 `--`，并用
 *   `--literal-pathspecs` 与 `GIT_LITERAL_PATHSPECS=1` 把 pathspec 当字面值。
 * · `--no-ext-diff` / `--no-textconv` **管不到** clean / process / smudge
 *   filter 与 `core.fsmonitor`（status / diff 会自行触发）。这里在每次读之前
 *   以固定 argv 的 `-c` override 关掉它们（见 `execSafetyFlags`）。
 * · 查询一律 `GIT_OPTIONAL_LOCKS=0` + 全局 `--no-optional-locks` + `--no-pager`，
 *   **不刷新 index**、不分页。
 * · 渲染端只传 cwd / 相对路径；授权由注入了 `resolveFileContext` 的调用方给。
 *
 * ── 授权 ──
 * 每次读取都先经 `authorizeReadCwd`（主进程注入的 `resolveFileContext`）确认
 * 规范 cwd；`resolveRepo` 找到的**仓库根**再授权一次 —— 用户只授权了子目录时，
 * 不能借 Git 把未授权祖先根的全部文件读出来。授权失败 fail closed，不照抄旧
 * `git.state` 的「没检查也返回」。
 */
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { gitRun, resolveRepo } from './git-service'
import { parseStatusV2 } from '../shared/git'
import type { GitChangeEntry, GitChangesResult, GitDiffResult } from '../shared/git'

/** 授权依赖：成功才返回规范 cwd（主进程接 `resolveFileContext`）。 */
export type AuthorizeReadCwd = (
  cwd: string
) => Promise<{ ok: true; cwd: string } | { ok: false; error: string }>

/** 逐文件条目上限：超过只回前 N 条并标记截断，不无限铺给界面。 */
const MAX_CHANGES_FILES = 2000
/** 单个文件补丁上限（与 DiffView 的正文软上限对齐），超过按行截断并标记。 */
const MAX_DIFF_BYTES = 1_500_000
/** 未跟踪文件的读取上限；超过只取前 N 字节并标记截断。 */
const MAX_UNTRACKED_BYTES = 1_000_000
/** 二进制嗅探窗口：与 git 自己的 `buffer_is_binary` 同口径（前 8000 字节含 NUL）。 */
const BINARY_SNIFF_BYTES = 8000
/** diff 查询超时：更大的值只会让界面等更久，明确时报超时更好。 */
const DIFF_TIMEOUT_MS = 15_000

/*
 * 查询环境：GIT_OPTIONAL_LOCKS=0 关掉「读状态顺带刷新 index」，
 * GIT_LITERAL_PATHSPECS=1 把 pathspec 全部当字面值（不做 glob / 魔法解析）。
 */
const READ_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1'
}

/** 全局只读开关（放子命令前）：不刷新 index、不分页、pathspec 当字面值。 */
const READ_GLOBALS = ['--no-optional-locks', '--no-pager', '--literal-pathspecs'] as const

/** `git diff` 的固定选项：关掉外部 diff / textconv / 颜色，并禁止改名检测。 */
const DIFF_FLAGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'] as const

/**
 * 枚举生效配置里的 filter 驱动名，生成固定 argv 的 `-c` override。
 *
 * `--no-ext-diff` / `--no-textconv` 只挡住 external diff 与 textconv；用户还
 * 可以在 `filter.<name>.clean|process|smudge` 里配任意命令，`git status` /
 * `git diff` 读工作树时会执行它们；`core.fsmonitor` 同理会执行外部钩子。
 * 这里把 clean / process / smudge 置空并 `required=false`，再把 fsmonitor 关掉。
 *
 * `git config --name-only --list` 只读**键名**（含 include.path 引入的），不取
 * 任何值、不碰凭证；枚举失败时至少保留 `core.fsmonitor=false`，不影响只读读取。
 */
async function execSafetyFlags(root: string): Promise<string[]> {
  const flags = ['-c', 'core.fsmonitor=false']
  try {
    const res = await gitRun(root, [...READ_GLOBALS, 'config', '--name-only', '--list'], {
      allowFailure: true,
      timeout: DIFF_TIMEOUT_MS,
      env: READ_ENV
    })
    const names = new Set<string>()
    for (const rawLine of res.stdout.split('\n')) {
      const m = /^filter\.(.+)\.(?:clean|process|smudge|required)$/.exec(rawLine.trim())
      if (m) names.add(m[1])
    }
    for (const name of names) {
      flags.push(
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.process=`,
        '-c',
        `filter.${name}.smudge=`,
        '-c',
        `filter.${name}.required=false`
      )
    }
  } catch {
    /* 枚举失败时保留 core.fsmonitor=false；后续读取照常进行 */
  }
  return flags
}

function normSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

function pathKey(value: string): string {
  const normalized = normSlashes(value).replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** `candidate` 是否在 `root` 之内（含相等）。只做路径字符串比较，不做 IO。 */
function isWithin(root: string, candidate: string): boolean {
  const r = pathKey(root)
  const c = pathKey(candidate)
  return c === r || c.startsWith(r + '/')
}

/**
 * `abs` 经 realpath 后是否仍在 `scopeAbs` 之内。
 *
 * `isWithin` 只是字符串前缀比较，拦不住中间层目录是 junction / 符号链接的
 * 情况。这里对**实际存在**的 `abs` 做 realpath（一次解析整条链）；若 `abs`
 * 已删除（ENOENT），逐级向上找最近存在的祖先再 realpath —— 已删除文件的删除
 * 补丁仍可读，同时不会顺着中间层连接读到范围外。
 */
async function isRealWithinScope(scopeAbs: string, abs: string): Promise<boolean> {
  let probe = abs
  for (;;) {
    try {
      const real = await realpath(probe)
      return isWithin(scopeAbs, real)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}

/**
 * 校验渲染端传来的**相对路径**并归一成显示用形式。
 *
 * `safeRepoPath` 会剥掉前导 `/`，所以**不能**直接拿它的结果当路径用 ——
 * 这里拒绝绝对路径而不是顺手剥掉。同时拒绝 NUL、盘符、`..`、`.`、空段、
 * 以 `-` / `:` / `!` / `^` 开头（options 与 pathspec 魔法），以及超长路径。
 */
export function normalizeRelPath(input: unknown): string | null {
  const raw = String(input ?? '')
  if (!raw || raw.length > 4096) return null
  if (raw.includes('\0')) return null
  if (/^[A-Za-z]:/.test(raw)) return null
  if (isAbsolute(raw)) return null
  const cleaned = normSlashes(raw)
  if (cleaned.startsWith('/')) return null
  const first = cleaned[0]
  if (first === '-' || first === ':' || first === '!' || first === '^') return null
  const parts = cleaned.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

interface InspectScope {
  root: string
  scopeAbs: string
  scopeRel: string
}

type ScopeResult =
  | { status: 'ok'; scope: InspectScope }
  | { status: 'notrepo' }
  | { status: 'denied'; error: string }

/**
 * 授权 + 解析仓库 + 定出可读范围。
 *
 * 范围取「已授权 cwd」；**另**授权仓库根一次 —— 成功时把范围放宽到根，
 * 失败时严格停在 cwd（`authorizeReadCwd` 的成功结果是规范 cwd，我们只用它）。
 */
async function resolveInspectScope(cwd: string, authorize: AuthorizeReadCwd): Promise<ScopeResult> {
  const auth = await authorize(String(cwd ?? ''))
  if (!auth.ok) return { status: 'denied', error: auth.error }
  const realCwd = await realpath(auth.cwd).catch(() => resolve(auth.cwd))
  const repo = await resolveRepo(realCwd)
  if (!repo) return { status: 'notrepo' }
  const root = await realpath(repo.root).catch(() => repo.root)
  const rootAuth = await authorize(root)
  const scopeAbs = rootAuth.ok ? root : realCwd
  if (!isWithin(root, scopeAbs)) return { status: 'denied', error: '授权范围不在仓库里' }
  const relRaw = normSlashes(relative(root, scopeAbs))
  const scopeRel = !relRaw || relRaw === '.' ? '.' : relRaw
  if (scopeRel.startsWith('..')) return { status: 'denied', error: '授权范围不在仓库里' }
  return { status: 'ok', scope: { root, scopeAbs, scopeRel } }
}

function failChanges(error: string): GitChangesResult {
  return {
    ok: false,
    root: null,
    scope: '.',
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    files: [],
    truncated: false,
    error
  }
}

function failDiff(rawPath: unknown, error: string): GitDiffResult {
  return {
    ok: false,
    path: String(rawPath ?? ''),
    patch: '',
    truncated: false,
    binary: false,
    staged: false,
    unstaged: false,
    untracked: false,
    bytes: 0,
    error
  }
}

/**
 * 只读读一次 status。
 *
 * 不走 `git-service.readStatus()`：那个函数的 `--no-optional-locks` 放在
 * 子命令之后，旧 git 直接报「unknown option」，于是回退到不带它的调用 ——
 * 那一次会刷新 index。这里把 `--no-optional-locks` 摆在全局位置，并用
 * `GIT_OPTIONAL_LOCKS=0` 兜底，然后复用 `parseStatusV2` 解析。
 */
async function readStatusReadOnly(root: string, safety: string[]): Promise<ReturnType<typeof parseStatusV2>> {
  const res = await gitRun(
    root,
    [...READ_GLOBALS, ...safety, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    { allowFailure: true, timeout: DIFF_TIMEOUT_MS, env: READ_ENV }
  )
  if (!res.ok && !res.stdout) throw new Error(res.error ?? 'git status 失败')
  return parseStatusV2(res.stdout)
}

/** 把仓库根相对的 status 条目映射到授权范围内；范围外的一律丢弃。 */
function entryToScope(entry: ReturnType<typeof parseStatusV2>['entries'][number], scope: InspectScope): GitChangeEntry | null {
  if (entry.ignored) return null
  const abs = resolve(scope.root, entry.path)
  if (!isWithin(scope.scopeAbs, abs)) return null
  const rel = normSlashes(relative(scope.scopeAbs, abs))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const unstaged = entry.unmerged || (entry.y !== '.' && entry.y !== ' ')
  /*
   * rename 的旧路径也只在授权范围内才回：否则子目录授权会借 rename 的
   * `origPath` 把祖先根里的文件名泄露出来。
   */
  let origPath: string | undefined
  if (entry.origPath && entry.origPath !== entry.path) {
    const origAbs = resolve(scope.root, entry.origPath)
    if (isWithin(scope.scopeAbs, origAbs)) {
      const origRel = normSlashes(relative(scope.scopeAbs, origAbs))
      if (origRel && !origRel.startsWith('..') && !isAbsolute(origRel)) origPath = origRel
    }
  }
  return {
    x: entry.x,
    y: entry.y,
    path: rel,
    ...(origPath ? { origPath } : {}),
    untracked: entry.untracked,
    ignored: false,
    unmerged: entry.unmerged,
    /*
     * 未跟踪条目在 porcelain=v2 里是 `? <path>`，解析出的 x/y 都是 `?`；
     * 若不特判，`x !== '.'` 会把「新文件」误标成已暂存。untracked 永远
     * 不在 index 里，staged 必须为 false。
     */
    staged: !entry.untracked && (entry.unmerged || (entry.x !== '.' && entry.x !== ' ')),
    unstaged
  }
}

/**
 * 读授权范围内的逐文件改动列表（`yan:git:changes`）。
 *
 * 只读 status，不读文件内容、不跑 diff；选中文件后再走 `readFileDiff`。
 */
export async function readChanges(cwd: string, authorize: AuthorizeReadCwd): Promise<GitChangesResult> {
  const scoped = await resolveInspectScope(cwd, authorize)
  if (scoped.status === 'denied') return failChanges(scoped.error)
  if (scoped.status === 'notrepo') {
    return { ok: true, root: null, scope: '.', branch: null, detached: false, unborn: false, head: null, files: [], truncated: false }
  }
  const scope = scoped.scope
  try {
    const safety = await execSafetyFlags(scope.root)
    const status = await readStatusReadOnly(scope.root, safety)
    const files: GitChangeEntry[] = []
    let truncated = false
    for (const entry of status.entries) {
      const mapped = entryToScope(entry, scope)
      if (!mapped) continue
      if (files.length >= MAX_CHANGES_FILES) {
        truncated = true
        break
      }
      files.push(mapped)
    }
    files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' }))
    return {
      ok: true,
      root: scope.root,
      scope: scope.scopeRel,
      branch: status.branch,
      detached: status.detached,
      unborn: status.unborn,
      head: status.head,
      files,
      truncated
    }
  } catch (error) {
    return { ...failChanges(error instanceof Error ? error.message : String(error)), root: scope.root, scope: scope.scopeRel }
  }
}

/** 该路径是否在 index 里（tracked）。 */
async function isTracked(root: string, rootRel: string, safety: string[]): Promise<boolean> {
  const res = await gitRun(root, [...READ_GLOBALS, ...safety, 'ls-files', '--cached', '-z', '--', rootRel], {
    allowFailure: true,
    timeout: DIFF_TIMEOUT_MS,
    env: READ_ENV
  })
  return res.stdout.split('\0').some((path) => path === rootRel)
}

/** 该路径是不是未跟踪（`??`）。被忽略的路径不会出现在这里（没传 --ignored）。 */
async function isUntracked(root: string, rootRel: string, safety: string[]): Promise<boolean> {
  const res = await gitRun(
    root,
    [...READ_GLOBALS, ...safety, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', rootRel],
    { allowFailure: true, timeout: DIFF_TIMEOUT_MS, env: READ_ENV }
  )
  return res.stdout.split('\0').some((seg) => seg.startsWith('? '))
}

/**
 * 读取文件内容（有界），返回 UTF-8 文本与二进制 / 截断标记。
 *
 * 只用于**未跟踪文件**的新文件补丁：git 的 diff 不覆盖未跟踪文件，若走
 * subagent 的 `collectDiff` 又会 `git add`。这里自己读、自己按统一 diff
 * 格式生成，且绝不返回 base85 大块（二进制只给一行说明）。
 */
async function readUntrackedContent(
  abs: string
): Promise<{ ok: true; text: string; binary: boolean; truncated: boolean; size: number } | { ok: false; error: string }> {
  let size: number
  try {
    const info = await stat(abs)
    if (!info.isFile()) return { ok: false, error: '不是普通文件' }
    size = info.size
  } catch {
    return { ok: false, error: '无法读取文件' }
  }
  const cap = Math.min(size, MAX_UNTRACKED_BYTES)
  let buf: Buffer
  try {
    const handle = await open(abs, 'r')
    try {
      buf = Buffer.alloc(cap)
      const { bytesRead } = await handle.read(buf, 0, cap, 0)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, error: '无法读取文件' }
  }
  const binary = buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
  return { ok: true, text: buf.toString('utf8'), binary, truncated: size > MAX_UNTRACKED_BYTES, size }
}

/** git 风格的路径引号：含空格 / 引号 / 反斜杠 / 非 ASCII / 控制符时统一加引号。 */
function gitQuotePath(path: string): string {
  if (/^[\x21-\x7e]+$/.test(path) && !path.includes('"') && !path.includes('\\')) return path
  const bytes = Buffer.from(path, 'utf8')
  let out = '"'
  for (const byte of bytes) {
    if (byte === 0x22) out += '\\"'
    else if (byte === 0x5c) out += '\\\\'
    else if (byte === 0x09) out += '\\t'
    else if (byte === 0x0a) out += '\\n'
    else if (byte === 0x0d) out += '\\r'
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`
    else out += String.fromCharCode(byte)
  }
  return out + '"'
}

/** 生成未跟踪文件的新文件补丁（真实内容，不带 base85）。 */
function buildUntrackedPatch(
  rootRel: string,
  content: { text: string; binary: boolean }
): { patch: string; binary: boolean } {
  const a = gitQuotePath(`a/${rootRel}`)
  const b = gitQuotePath(`b/${rootRel}`)
  const header = `diff --git ${a} ${b}\nnew file mode 100644\n`
  if (content.binary) {
    return {
      patch: `${header}Binary files /dev/null and ${gitQuotePath(`b/${rootRel}`)} differ\n`,
      binary: true
    }
  }
  const lines = content.text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const noNewline = content.text.length > 0 && !content.text.endsWith('\n')
  const body = lines.map((line, index) => {
    const eol = index === lines.length - 1 && noNewline ? '\n\\ No newline at end of file\n' : '\n'
    return `+${line}${eol}`
  })
  const hunk = `--- /dev/null\n+++ ${gitQuotePath(`b/${rootRel}`)}\n@@ -0,0 +1,${lines.length} @@\n`
  return { patch: header + hunk + body.join(''), binary: false }
}

/** 按 UTF-8 字节上限在行边界截断；返回是否截断。 */
function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  let cut = buf.subarray(0, maxBytes).lastIndexOf(0x0a)
  if (cut <= 0) cut = maxBytes
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true }
}

/**
 * 读单个文件的补丁（`yan:git:diff`）。
 *
 * 已跟踪：`--cached`（索引 vs HEAD，无 HEAD 也能读）+ 工作树 diff 两个**真实**
 * 片段拼接，可含多段 `diff --git`。未跟踪：读文件内容生成安全的新文件补丁。
 * 二进制只回一行说明；超大按行截断并标记 `truncated`。
 */
export async function readFileDiff(cwd: string, rawPath: unknown, authorize: AuthorizeReadCwd): Promise<GitDiffResult> {
  const scoped = await resolveInspectScope(cwd, authorize)
  if (scoped.status === 'denied') return failDiff(rawPath, scoped.error)
  if (scoped.status === 'notrepo') return failDiff(rawPath, '这个目录不在 Git 仓库里')
  const scope = scoped.scope

  const rel = normalizeRelPath(rawPath)
  if (!rel) return failDiff(rawPath, '路径不合法')
  const abs = resolve(scope.scopeAbs, rel)
  if (!isWithin(scope.scopeAbs, abs)) return failDiff(rawPath, '路径超出授权范围')
  const rootRel = normSlashes(relative(scope.root, abs))
  if (!rootRel || rootRel.startsWith('..') || isAbsolute(rootRel)) return failDiff(rawPath, '路径超出仓库范围')

  const safety = await execSafetyFlags(scope.root)

  /*
   * 中间层逃逸：只 lstat 末组件不够 —— 目录可以是指向范围外的 junction /
   * 符号链接。对实际存在的路径，或已删除文件最近存在的祖先，做 realpath
   * 校验；已删除文件因此仍能安全地看删除补丁。
   */
  if (!(await isRealWithinScope(scope.scopeAbs, abs))) return failDiff(rawPath, '路径超出授权范围')
  /*
   * 符号链接逃逸：现有只读文件边界（files.ts / file-refs.ts）都不跟随符号
   * 链接。这里也不跟随 —— 直接拒绝，避免顺着链接读到授权范围外的内容。
   * ENOENT 允许（已删除的文件仍要能看到删除补丁）。
   */
  try {
    const info = await lstat(abs)
    if (info.isSymbolicLink()) return failDiff(rawPath, '符号链接不读取')
    if (info.isDirectory()) return failDiff(rawPath, '目录不是文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return failDiff(rawPath, '无法读取文件')
  }

  const tracked = await isTracked(scope.root, rootRel, safety)
  if (!tracked) {
    const untracked = await isUntracked(scope.root, rootRel, safety)
    if (!untracked) return failDiff(rel, '这个文件被忽略或不在仓库里')
    const content = await readUntrackedContent(abs)
    if (!content.ok) return failDiff(rel, content.error)
    const built = buildUntrackedPatch(rootRel, content)
    const capped = capBytes(built.patch, MAX_DIFF_BYTES)
    return {
      ok: true,
      path: rel,
      patch: capped.text,
      truncated: content.truncated || capped.truncated,
      binary: built.binary,
      staged: false,
      unstaged: true,
      untracked: true,
      bytes: Math.max(Buffer.byteLength(built.patch, 'utf8'), content.size)
    }
  }

  const [staged, unstaged] = await Promise.all([
    gitRun(scope.root, [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--cached', '--', rootRel], {
      allowFailure: true,
      timeout: DIFF_TIMEOUT_MS,
      env: READ_ENV
    }),
    gitRun(scope.root, [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--', rootRel], {
      allowFailure: true,
      timeout: DIFF_TIMEOUT_MS,
      env: READ_ENV
    })
  ])
  if (staged.timedOut || unstaged.timedOut) return failDiff(rel, 'diff 读取超时，文件可能过大')
  if (!staged.ok && !staged.stdout && staged.error) return failDiff(rel, staged.error)
  if (!unstaged.ok && !unstaged.stdout && unstaged.error) return failDiff(rel, unstaged.error)

  const raw = [staged.stdout, unstaged.stdout].filter(Boolean).join('')
  const capped = capBytes(raw, MAX_DIFF_BYTES)
  const patch = capped.text
  return {
    ok: true,
    path: rel,
    patch,
    truncated: capped.truncated,
    binary: /(^|\n)(Binary files .+? differ|GIT binary patch)\s*(\n|$)/.test(patch),
    staged: staged.stdout.length > 0,
    unstaged: unstaged.stdout.length > 0,
    untracked: false,
    bytes: Buffer.byteLength(raw, 'utf8')
  }
}
