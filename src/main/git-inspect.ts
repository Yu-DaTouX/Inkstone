import { lstat, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { gitRun, resolveRepo } from './git-service'
import { parseStatusV2 } from '../shared/git'
import type { GitChangeEntry, GitChangesResult, GitDiffResult } from '../shared/git'

export type AuthorizeReadCwd = (
  cwd: string
) => Promise<{ ok: true; cwd: string } | { ok: false; error: string }>

const MAX_CHANGES_FILES = 2000
const MAX_DIFF_BYTES = 1_500_000
const MAX_UNTRACKED_BYTES = 1_000_000
const BINARY_SNIFF_BYTES = 8000
const DIFF_TIMEOUT_MS = 15_000
const MAX_UNTRACKED_LINE_COUNTS = 200

const READ_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1'
}

const READ_GLOBALS = ['--no-optional-locks', '--no-pager', '--literal-pathspecs'] as const

const DIFF_FLAGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'] as const

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

function isWithin(root: string, candidate: string): boolean {
  const r = pathKey(root)
  const c = pathKey(candidate)
  return c === r || c.startsWith(r + '/')
}

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

async function readStatusReadOnly(root: string, safety: string[]): Promise<ReturnType<typeof parseStatusV2>> {
  const res = await gitRun(
    root,
    [...READ_GLOBALS, ...safety, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    { allowFailure: true, timeout: DIFF_TIMEOUT_MS, env: READ_ENV }
  )
  if (!res.ok && !res.stdout) throw new Error(res.error ?? 'git status 失败')
  return parseStatusV2(res.stdout)
}

function entryToScope(entry: ReturnType<typeof parseStatusV2>['entries'][number], scope: InspectScope): GitChangeEntry | null {
  if (entry.ignored) return null
  const abs = resolve(scope.root, entry.path)
  if (!isWithin(scope.scopeAbs, abs)) return null
  const rel = normSlashes(relative(scope.scopeAbs, abs))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const unstaged = entry.unmerged || (entry.y !== '.' && entry.y !== ' ')
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
    staged: !entry.untracked && (entry.unmerged || (entry.x !== '.' && entry.x !== ' ')),
    unstaged
  }
}

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
    const totals = await readLineTotals(scope, safety, files, status.unborn).catch(() => null)
    return {
      ...(totals ?? {}),
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

function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>()
  for (const record of stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n+/, ''))
    if (!m) continue
    out.set(m[3], { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) })
  }
  return out
}

async function countUntrackedLines(abs: string): Promise<number> {
  const content = await readUntrackedContent(abs)
  if (!content.ok || content.binary || !content.text) return 0
  const breaks = content.text.split('\n').length - 1
  return content.text.endsWith('\n') ? breaks : breaks + 1
}

async function readLineTotals(
  scope: InspectScope,
  safety: string[],
  files: GitChangeEntry[],
  unborn: boolean
): Promise<{ added: number; removed: number }> {
  const base = unborn ? ['--cached'] : ['HEAD']
  const pathspec = scope.scopeRel === '.' ? [] : ['--', scope.scopeRel]
  const res = await gitRun(
    scope.root,
    [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--numstat', '-z', ...base, ...pathspec],
    { allowFailure: true, timeout: DIFF_TIMEOUT_MS, env: READ_ENV }
  )
  const stats = parseNumstat(res.stdout)
  let added = 0
  let removed = 0
  let untrackedCounted = 0
  for (const file of files) {
    const abs = resolve(scope.scopeAbs, file.path)
    if (file.untracked) {
      if (untrackedCounted >= MAX_UNTRACKED_LINE_COUNTS) continue
      untrackedCounted += 1
      const lines = await countUntrackedLines(abs)
      file.added = lines
      file.removed = 0
      added += lines
      continue
    }
    const rootRel = normSlashes(relative(scope.root, abs))
    const stat = stats.get(rootRel)
    if (!stat) continue
    file.added = stat.added
    file.removed = stat.removed
    added += stat.added
    removed += stat.removed
  }
  return { added, removed }
}

async function isTracked(root: string, rootRel: string, safety: string[]): Promise<boolean> {
  const res = await gitRun(root, [...READ_GLOBALS, ...safety, 'ls-files', '--cached', '-z', '--', rootRel], {
    allowFailure: true,
    timeout: DIFF_TIMEOUT_MS,
    env: READ_ENV
  })
  return res.stdout.split('\0').some((path) => path === rootRel)
}

async function isUntracked(root: string, rootRel: string, safety: string[]): Promise<boolean> {
  const res = await gitRun(
    root,
    [...READ_GLOBALS, ...safety, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', rootRel],
    { allowFailure: true, timeout: DIFF_TIMEOUT_MS, env: READ_ENV }
  )
  return res.stdout.split('\0').some((seg) => seg.startsWith('? '))
}

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

function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  let cut = buf.subarray(0, maxBytes).lastIndexOf(0x0a)
  if (cut <= 0) cut = maxBytes
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true }
}

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

  if (!(await isRealWithinScope(scope.scopeAbs, abs))) return failDiff(rawPath, '路径超出授权范围')
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
