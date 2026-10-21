import { spawn } from 'node:child_process'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { gitRun, killProcessTree, resolveRepo } from './git-service'
import { isWithin } from './file-path-gate'
import { GIT_READ_CONFIG, createGitDeadline, sanitizedGitEnv } from './git-run-policy'
import type { GitDeadline } from './git-run-policy'
import {
  EMPTY_TREE,
  IMAGE_SIDE_BYTES,
  PATCH_PREFILL_FILES,
  PATCH_SINGLE_FILE_BYTES,
  allocatePatches,
  baseCandidates,
  imageMimeOf,
  isBinaryPatch,
  normalizeChangesScope,
  parseNameStatus,
  splitPatch
} from './git-changes-model'
import { parseStatusV2 } from '../shared/git'
import type {
  GitChangeEntry,
  GitChangesOptions,
  GitChangesResult,
  GitChangesScope,
  GitDiffResult,
  GitImageSide,
  GitStatusEntry
} from '../shared/git'

export type AuthorizeReadCwd = (
  cwd: string
) => Promise<{ ok: true; cwd: string } | { ok: false; error: string }>

const MAX_CHANGES_FILES = 2000
const MAX_DIFF_BYTES = 1_500_000
const MAX_UNTRACKED_BYTES = 1_000_000
const BINARY_SNIFF_BYTES = 8000
const DIFF_TIMEOUT_MS = 15_000
const QUERY_DEADLINE_MS = 20_000
const MAX_UNTRACKED_LINE_COUNTS = 32
const MAX_PREFILL_LINES = 2000
const PREFILL_PATHSPEC_CHARS = 8000

const READ_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1'
}

const READ_GLOBALS = ['--no-optional-locks', '--no-pager', '--literal-pathspecs'] as const

const DIFF_FLAGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'] as const

function readOpts(deadline?: GitDeadline, timeout = DIFF_TIMEOUT_MS): { allowFailure: true; timeout: number; env: Record<string, string>; deadline?: GitDeadline } {
  return { allowFailure: true, timeout, env: READ_ENV, ...(deadline ? { deadline } : {}) }
}

async function execSafetyFlags(root: string, deadline?: GitDeadline): Promise<string[]> {
  const flags = [...GIT_READ_CONFIG]
  try {
    const res = await gitRun(root, [...READ_GLOBALS, 'config', '--name-only', '--list'], readOpts(deadline))
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

async function readStatusReadOnly(root: string, safety: string[], deadline?: GitDeadline): Promise<ReturnType<typeof parseStatusV2>> {
  const res = await gitRun(
    root,
    [...READ_GLOBALS, ...safety, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    readOpts(deadline)
  )
  if (!res.ok && !res.stdout) throw Object.assign(new Error(res.error ?? 'git status 失败'), { code: res.code })
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

interface ResolvedRange {
  kind: 'branch' | 'commit'
  base: string
  target: string | null
  baseRef: string | null
}

async function revParseCommit(root: string, ref: string, deadline: GitDeadline): Promise<string | null> {
  const res = await gitRun(root, [...READ_GLOBALS, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], readOpts(deadline, 8000))
  const sha = res.ok ? res.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

async function resolveRange(
  root: string,
  scope: Exclude<GitChangesScope, { kind: 'working' }>,
  deadline: GitDeadline
): Promise<ResolvedRange | { error: string }> {
  if (scope.kind === 'commit') {
    const target = await revParseCommit(root, scope.sha, deadline)
    if (!target) return { error: `找不到提交：${scope.sha}` }
    const parent = await revParseCommit(root, `${target}^1`, deadline)
    return { kind: 'commit', base: parent ?? EMPTY_TREE, target, baseRef: null }
  }
  const head = await revParseCommit(root, 'HEAD', deadline)
  if (!head) return { error: '当前分支还没有提交' }
  const originHead = await gitRun(root, [...READ_GLOBALS, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], readOpts(deadline, 8000))
  for (const candidate of baseCandidates(scope.base, originHead.ok ? originHead.stdout.trim() || null : null)) {
    const sha = await revParseCommit(root, candidate, deadline)
    if (!sha) continue
    const mergeBase = await gitRun(root, [...READ_GLOBALS, 'merge-base', head, sha], readOpts(deadline))
    const base = mergeBase.ok ? mergeBase.stdout.trim() : ''
    if (/^[0-9a-f]{40,64}$/.test(base)) return { kind: 'branch', base, target: null, baseRef: candidate }
  }
  return { error: scope.base ? `找不到基线分支：${scope.base}` : '找不到可对比的基线分支' }
}

function rangeArgs(range: ResolvedRange): string[] {
  return range.target ? [range.base, range.target] : [range.base]
}

function scopePathspec(scope: InspectScope): string[] {
  return scope.scopeRel === '.' ? [] : ['--', scope.scopeRel]
}

async function readRangeEntries(
  scope: InspectScope,
  safety: string[],
  range: ResolvedRange,
  deadline: GitDeadline
): Promise<GitStatusEntry[]> {
  const res = await gitRun(
    scope.root,
    [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--name-status', '-z', ...rangeArgs(range), ...scopePathspec(scope)],
    readOpts(deadline)
  )
  if (!res.ok && !res.stdout) throw Object.assign(new Error(res.error ?? 'git diff 失败'), { code: res.code })
  const entries: GitStatusEntry[] = parseNameStatus(res.stdout).map((item) => ({
    x: item.status,
    y: '.',
    path: item.path,
    untracked: false,
    ignored: false,
    unmerged: false
  }))
  if (range.kind === 'branch') {
    const status = await readStatusReadOnly(scope.root, safety, deadline)
    const known = new Set(entries.map((entry) => entry.path))
    for (const entry of status.entries) {
      if (entry.untracked && !known.has(entry.path)) entries.push(entry)
    }
  }
  return entries
}

function mapEntries(entries: readonly GitStatusEntry[], scope: InspectScope): { files: GitChangeEntry[]; truncated: boolean } {
  const files: GitChangeEntry[] = []
  let truncated = false
  for (const entry of entries) {
    const mapped = entryToScope(entry, scope)
    if (!mapped) continue
    if (files.length >= MAX_CHANGES_FILES) {
      truncated = true
      break
    }
    files.push(mapped)
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' }))
  return { files, truncated }
}

function patchHeader(rootRel: string): string {
  return `diff --git ${gitQuotePath(`a/${rootRel}`)} ${gitQuotePath(`b/${rootRel}`)}`
}

async function prefillPatches(
  scope: InspectScope,
  safety: string[],
  files: GitChangeEntry[],
  baseArgs: string[],
  deadline: GitDeadline
): Promise<Pick<GitChangesResult, 'patches' | 'patchBudget'>> {
  const byHeader = new Map<string, string>()
  const rootRels: string[] = []
  let pathspecBudget = PREFILL_PATHSPEC_CHARS
  for (const file of files) {
    if (file.untracked) continue
    if (rootRels.length >= PATCH_PREFILL_FILES) break
    if ((file.added ?? 0) + (file.removed ?? 0) > MAX_PREFILL_LINES) continue
    const rootRel = normSlashes(relative(scope.root, resolve(scope.scopeAbs, file.path)))
    const origRel = file.origPath ? normSlashes(relative(scope.root, resolve(scope.scopeAbs, file.origPath))) : undefined
    pathspecBudget -= rootRel.length + (origRel?.length ?? 0) + 2
    if (pathspecBudget < 0) break
    byHeader.set(patchHeader(rootRel), file.path)
    rootRels.push(rootRel)
    if (origRel) {
      byHeader.set(patchHeader(origRel), file.path)
      rootRels.push(origRel)
    }
  }
  const available = new Map<string, string>()
  if (rootRels.length > 0) {
    const res = await gitRun(scope.root, [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, ...baseArgs, '--', ...rootRels], readOpts(deadline))
    if (res.ok) {
      for (const chunk of splitPatch(res.stdout)) {
        const path = byHeader.get(chunk.slice(0, chunk.indexOf('\n')))
        if (path !== undefined) available.set(path, (available.get(path) ?? '') + chunk)
      }
    }
  }
  let untrackedRead = 0
  for (const file of files) {
    if (!file.untracked || untrackedRead >= PATCH_PREFILL_FILES || deadline.expired()) continue
    untrackedRead += 1
    const abs = resolve(scope.scopeAbs, file.path)
    if (!(await isRealWithinScope(scope.scopeAbs, abs))) continue
    const content = await readUntrackedContent(abs)
    if (!content.ok || content.truncated) continue
    available.set(file.path, buildUntrackedPatch(normSlashes(relative(scope.root, abs)), content).patch)
  }
  const allocated = allocatePatches(files.map((file) => file.path), available)
  return {
    patches: allocated.patches,
    patchBudget: { inlined: allocated.inlined, bytes: allocated.bytes, deferred: allocated.deferred }
  }
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export async function readChanges(cwd: string, authorize: AuthorizeReadCwd, options: GitChangesOptions = {}): Promise<GitChangesResult> {
  const requestedScope = normalizeChangesScope(options.scope)
  if (!requestedScope) return failChanges('对比范围不合法')
  const scoped = await resolveInspectScope(cwd, authorize)
  if (scoped.status === 'denied') return failChanges(scoped.error)
  if (scoped.status === 'notrepo') {
    return { ok: true, root: null, scope: '.', branch: null, detached: false, unborn: false, head: null, files: [], truncated: false }
  }
  const scope = scoped.scope
  const deadline = createGitDeadline(QUERY_DEADLINE_MS)
  try {
    const safety = await execSafetyFlags(scope.root, deadline)
    const status = await readStatusReadOnly(scope.root, safety, deadline)
    const header = {
      ok: true,
      root: scope.root,
      scope: scope.scopeRel,
      branch: status.branch,
      detached: status.detached,
      unborn: status.unborn,
      head: status.head,
      scopeKind: requestedScope.kind
    }
    if (requestedScope.kind === 'working') {
      const { files, truncated } = mapEntries(status.entries, scope)
      const baseArgs = status.unborn ? ['--cached'] : ['HEAD']
      const totals = await readLineTotals(scope, safety, files, baseArgs, deadline).catch(() => null)
      const patches = options.patches ? await prefillPatches(scope, safety, files, baseArgs, deadline).catch(() => ({})) : {}
      return { ...(totals ?? {}), ...header, files, truncated, ...patches }
    }
    const range = await resolveRange(scope.root, requestedScope, deadline)
    if ('error' in range) return { ...failChanges(range.error), root: scope.root, scope: scope.scopeRel, scopeKind: requestedScope.kind }
    const entries = await readRangeEntries(scope, safety, range, deadline)
    const { files, truncated } = mapEntries(entries, scope)
    const baseArgs = rangeArgs(range)
    const totals = await readLineTotals(scope, safety, files, baseArgs, deadline).catch(() => null)
    const patches = options.patches ? await prefillPatches(scope, safety, files, baseArgs, deadline).catch(() => ({})) : {}
    return {
      ...(totals ?? {}),
      ...header,
      files,
      truncated,
      baseRef: range.baseRef,
      baseSha: range.base === EMPTY_TREE ? null : range.base,
      targetSha: range.target,
      ...patches
    }
  } catch (error) {
    const errorCode = errorCodeOf(error)
    return {
      ...failChanges(error instanceof Error ? error.message : String(error)),
      root: scope.root,
      scope: scope.scopeRel,
      scopeKind: requestedScope.kind,
      ...(errorCode ? { errorCode } : {})
    }
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
  baseArgs: string[],
  deadline: GitDeadline
): Promise<{ added: number; removed: number }> {
  const res = await gitRun(
    scope.root,
    [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--numstat', '-z', ...baseArgs, ...scopePathspec(scope)],
    readOpts(deadline)
  )
  const stats = parseNumstat(res.stdout)
  let added = 0
  let removed = 0
  let untrackedCounted = 0
  for (const file of files) {
    const abs = resolve(scope.scopeAbs, file.path)
    if (file.untracked) {
      if (untrackedCounted >= MAX_UNTRACKED_LINE_COUNTS || deadline.expired()) continue
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

const C_STYLE_ESCAPES: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\'
}

function needsCQuote(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f || byte === 0x22 || byte === 0x5c
}

function gitQuotePath(path: string): string {
  const bytes = Buffer.from(path, 'utf8')
  if (!bytes.some(needsCQuote)) return path
  let out = '"'
  for (const byte of bytes) {
    const escape = C_STYLE_ESCAPES[byte]
    if (escape) out += escape
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

function untrackedDiff(rel: string, rootRel: string, content: { text: string; binary: boolean; truncated: boolean; size: number }): GitDiffResult {
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

interface DiffTarget {
  scope: InspectScope
  rel: string
  rootRel: string
  abs: string
  safety: string[]
  deadline: GitDeadline
}

async function readWorkingDiff(target: DiffTarget): Promise<GitDiffResult> {
  const { scope, rel, rootRel, abs, safety, deadline } = target
  const tracked = await isTracked(scope.root, rootRel, safety)
  if (!tracked) {
    const untracked = await isUntracked(scope.root, rootRel, safety)
    if (!untracked) return failDiff(rel, '这个文件被忽略或不在仓库里')
    const content = await readUntrackedContent(abs)
    if (!content.ok) return failDiff(rel, content.error)
    return untrackedDiff(rel, rootRel, content)
  }

  const [staged, unstaged] = await Promise.all([
    gitRun(scope.root, [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--cached', '--', rootRel], readOpts(deadline)),
    gitRun(scope.root, [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, '--', rootRel], readOpts(deadline))
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
    binary: isBinaryPatch(patch),
    staged: staged.stdout.length > 0,
    unstaged: unstaged.stdout.length > 0,
    untracked: false,
    bytes: Buffer.byteLength(raw, 'utf8')
  }
}

async function readRangeDiff(target: DiffTarget, range: ResolvedRange): Promise<GitDiffResult> {
  const { scope, rel, rootRel, abs, safety, deadline } = target
  if (range.kind === 'branch' && !(await isTracked(scope.root, rootRel, safety)) && (await isUntracked(scope.root, rootRel, safety))) {
    const content = await readUntrackedContent(abs)
    if (!content.ok) return failDiff(rel, content.error)
    return untrackedDiff(rel, rootRel, content)
  }
  const res = await gitRun(scope.root, [...READ_GLOBALS, ...safety, ...DIFF_FLAGS, ...rangeArgs(range), '--', rootRel], readOpts(deadline))
  if (res.timedOut) return failDiff(rel, 'diff 读取超时，文件可能过大')
  if (!res.ok && !res.stdout && res.error) return failDiff(rel, res.error)
  const capped = capBytes(res.stdout, PATCH_SINGLE_FILE_BYTES)
  return {
    ok: true,
    path: rel,
    patch: capped.text,
    truncated: capped.truncated,
    binary: isBinaryPatch(capped.text),
    staged: false,
    unstaged: false,
    untracked: false,
    bytes: Buffer.byteLength(res.stdout, 'utf8')
  }
}

function gitBinary(root: string, args: string[], maxBytes: number, deadline: GitDeadline): Promise<Buffer | null> {
  const timeout = Math.min(DIFF_TIMEOUT_MS, deadline.remaining())
  if (timeout <= 0) return Promise.resolve(null)
  return new Promise((resolveBuffer) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...READ_GLOBALS, ...args], {
      cwd: root,
      windowsHide: true,
      env: sanitizedGitEnv(process.env, READ_ENV)
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let failed = false
    const timer = setTimeout(() => {
      failed = true
      killProcessTree(child)
    }, timeout)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        failed = true
        killProcessTree(child)
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolveBuffer(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveBuffer(code === 0 && !failed ? Buffer.concat(chunks) : null)
    })
  })
}

function dataUrlSide(bytes: Buffer, mime: string): GitImageSide {
  return { size: bytes.length, mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}

async function readBlobSide(root: string, rev: string | null, rootRel: string, mime: string, deadline: GitDeadline): Promise<GitImageSide> {
  if (!rev || rev === EMPTY_TREE) return { size: 0, missing: true }
  const spec = `${rev}:${rootRel}`
  const sized = await gitRun(root, [...READ_GLOBALS, 'cat-file', '-s', spec], readOpts(deadline, 8000))
  const size = sized.ok ? Number(sized.stdout.trim()) : NaN
  if (!Number.isFinite(size)) return { size: 0, missing: true }
  if (size > IMAGE_SIDE_BYTES) return { size, mime, tooLarge: true }
  const bytes = await gitBinary(root, ['cat-file', 'blob', spec], IMAGE_SIDE_BYTES, deadline)
  return bytes ? dataUrlSide(bytes, mime) : { size, missing: true }
}

async function readWorkingSide(abs: string, mime: string): Promise<GitImageSide> {
  try {
    const info = await lstat(abs)
    if (info.isSymbolicLink() || !info.isFile()) return { size: 0, missing: true }
    if (info.size > IMAGE_SIDE_BYTES) return { size: info.size, mime, tooLarge: true }
    return dataUrlSide(await readFile(abs), mime)
  } catch {
    return { size: 0, missing: true }
  }
}

async function readImageSides(
  target: DiffTarget,
  mime: string,
  range: ResolvedRange | null,
  unborn: boolean
): Promise<{ before: GitImageSide; after: GitImageSide }> {
  const { scope, rootRel, abs, deadline } = target
  if (!range) {
    const [before, after] = await Promise.all([
      readBlobSide(scope.root, unborn ? null : 'HEAD', rootRel, mime, deadline),
      readWorkingSide(abs, mime)
    ])
    return { before, after }
  }
  const [before, after] = await Promise.all([
    readBlobSide(scope.root, range.base, rootRel, mime, deadline),
    range.target ? readBlobSide(scope.root, range.target, rootRel, mime, deadline) : readWorkingSide(abs, mime)
  ])
  return { before, after }
}

export interface FileDiffOptions {
  scope?: unknown
  images?: boolean
}

export async function readFileDiff(
  cwd: string,
  rawPath: unknown,
  authorize: AuthorizeReadCwd,
  options: FileDiffOptions = {}
): Promise<GitDiffResult> {
  const requestedScope = normalizeChangesScope(options.scope)
  if (!requestedScope) return failDiff(rawPath, '对比范围不合法')
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

  const deadline = createGitDeadline(QUERY_DEADLINE_MS)
  const safety = await execSafetyFlags(scope.root, deadline)

  if (!(await isRealWithinScope(scope.scopeAbs, abs))) return failDiff(rawPath, '路径超出授权范围')
  try {
    const info = await lstat(abs)
    if (info.isSymbolicLink()) return failDiff(rawPath, '符号链接不读取')
    if (info.isDirectory()) return failDiff(rawPath, '目录不是文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return failDiff(rawPath, '无法读取文件')
  }

  const target: DiffTarget = { scope, rel, rootRel, abs, safety, deadline }
  let range: ResolvedRange | null = null
  if (requestedScope.kind !== 'working') {
    const resolved = await resolveRange(scope.root, requestedScope, deadline)
    if ('error' in resolved) return failDiff(rel, resolved.error)
    range = resolved
  }
  const result = range ? await readRangeDiff(target, range) : await readWorkingDiff(target)
  const mime = imageMimeOf(rel)
  if (!result.ok || !options.images || !mime) return result
  const unborn = range ? false : !(await gitRun(scope.root, [...READ_GLOBALS, 'rev-parse', '--verify', '--quiet', 'HEAD'], readOpts(deadline, 8000))).ok
  return { ...result, image: await readImageSides(target, mime, range, unborn) }
}
