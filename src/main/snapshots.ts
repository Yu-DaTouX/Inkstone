import { readFileSync, statSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { FileDiff, FileSnapshotSide, WorkspaceChangeFile, WorkspaceChanges } from '../shared/ipc'
import { gitRun, killProcessTree, resolveRepo } from './git-service'
import { sanitizedGitEnv } from './git-run-policy'
import { parseStatusV2 } from '../shared/git'
import type { GitStatusEntry, GitStatusParse } from '../shared/git'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 40
const MAX_DIFF_LINES = 1200
const MAX_DIFF_CELLS = 1_200_000

interface Side extends FileSnapshotSide {
  content?: string
}

export type { FileDiff, FileSnapshotSide }

interface Entry {
  path: string
  readPath: string
  before: Side
  at: number
}

const pending = new Map<string, Entry>()

export function captureSide(path: string): Side {
  let st
  try {
    st = statSync(path)
  } catch {
    return { exists: false, size: 0 }
  }
  if (!st.isFile()) return { exists: false, size: 0 }

  if (st.size > MAX_BYTES) return { exists: true, size: st.size, tooLarge: true }

  try {
    const buf = readFileSync(path)
    return {
      exists: true,
      size: buf.byteLength,
      content: buf.toString('utf8'),
      hash: createHash('sha256').update(buf).digest('hex').slice(0, 16)
    }
  } catch {
    return { exists: true, size: st.size }
  }
}

export function snapshotBefore(callId: string, path: string, readPath = path): void {
  const before = captureSide(readPath)
  pending.set(callId, { path, readPath, before, at: Date.now() })
  while (pending.size > MAX_ENTRIES) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
}

export function snapshotAfter(callId: string): FileDiff | null {
  const entry = pending.get(callId)
  if (!entry) return null
  pending.delete(callId)
  const after = captureSide(entry.readPath)
  const status: FileDiff['status'] =
    !entry.before.exists && after.exists
      ? 'created'
      : entry.before.exists && !after.exists
        ? 'deleted'
        : entry.before.content !== undefined && after.content !== undefined
          ? entry.before.content === after.content
            ? 'unchanged'
            : 'modified'
          : 'unknown'

  const stats =
    status === 'created'
      ? createdStats(after.content)
      : status === 'deleted'
        ? deletedStats(entry.before.content)
        : diffStats(entry.before.content, after.content)
  const beforeMeta = { ...entry.before, content: undefined }
  const afterMeta = { ...after, content: undefined }
  return {
    path: entry.path,
    before: beforeMeta,
    after: afterMeta,
    added: stats.added,
    removed: stats.removed,
    patch: stats.patch,
    status
  }
}

const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'multiEdit', 'apply_patch', 'patch'])

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'run', 'exec'])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

export function writePathOf(args: unknown): string | undefined {
  const a = args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return undefined
  for (const key of ['path', 'file_path', 'filePath']) {
    const v = a[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

export function clearSnapshots(): void {
  pending.clear()
  for (const tree of activeTrees.values()) tree.cancelled = true
  activeTrees.clear()
  evictedTrees.clear()
}

function lineCount(text?: string): number {
  if (text === undefined) return -1
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function createdStats(content?: string): { added: number; removed: number; patch: string } {
  const n = lineCount(content)
  if (n < 0) return { added: -1, removed: -1, patch: '' }
  const lines = (content ?? '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { added: n, removed: 0, patch: lines.map((l) => `+ ${l}`).join('\n') }
}

function deletedStats(content?: string): { added: number; removed: number; patch: string } {
  const n = lineCount(content)
  if (n < 0) return { added: -1, removed: -1, patch: '' }
  const lines = (content ?? '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { added: 0, removed: n, patch: lines.map((l) => `- ${l}`).join('\n') }
}

function diffStats(before?: string, after?: string): { added: number; removed: number; patch: string } {
  if (before === undefined || after === undefined) return { added: -1, removed: -1, patch: '' }
  if (before === after) return { added: 0, removed: 0, patch: '' }

  const a = before.split('\n')
  const b = after.split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  let added = 0
  let removed = 0

  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES || midA.length * midB.length > MAX_DIFF_CELLS) {
    const setA = new Map<string, number>()
    for (const line of midA) setA.set(line, (setA.get(line) ?? 0) + 1)
    for (const line of midB) {
      const n = setA.get(line) ?? 0
      if (n > 0) setA.set(line, n - 1)
      else added++
    }
    for (const n of setA.values()) removed += n
    return { added, removed, patch: '' }
  }

  const n = midA.length
  const m = midB.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      lines.push(`  ${midA[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${midA[i]}`)
      removed++
      i++
    } else {
      lines.push(`+ ${midB[j]}`)
      added++
      j++
    }
  }
  while (i < n) {
    lines.push(`- ${midA[i++]}`)
    removed++
  }
  while (j < m) {
    lines.push(`+ ${midB[j++]}`)
    added++
  }

  const CONTEXT = 3
  const head = start > 0 ? a.slice(Math.max(0, start - CONTEXT), start).map((l) => `  ${l}`) : []
  const tail = endA < a.length ? a.slice(endA, Math.min(a.length, endA + CONTEXT)).map((l) => `  ${l}`) : []
  const body = lines.length > 400 ? [...lines.slice(0, 400), `…（还有 ${lines.length - 400} 行差异）`] : lines

  return { added, removed, patch: [...head, ...body, ...tail].join('\n') }
}

export interface TreeEntry {
  size: number
  mtimeMs: number
  hash?: string
  content?: string
  exists?: boolean
  untracked?: boolean
}

export interface TreeSnapshot {
  root: string
  mode?: 'git' | 'walk'
  files: Map<string, TreeEntry>
  truncated: boolean
  unreadable: boolean
  unreadableDirs: number
  scanned: number
  gitRoot?: string
  relRoot?: string
  head?: string | null
}

export interface TreeChange {
  path: string
  status: WorkspaceChangeFile['status']
  beforeSize: number
  afterSize: number
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  'release',
  '.next',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  'vendor',
  '.idea',
  '.vscode',
  '.gradle',
  'obj',
  'bin'
])

const TREE_MAX_FILES = 4000
const TREE_MAX_DEPTH = 12
const TREE_CONTENT_MAX_BYTES = 256 * 1024
const TREE_CONTENT_BUDGET = 12 * 1024 * 1024
const TREE_STAT_CONCURRENCY = 64
const CHANGE_MAX_FILES = 40
const MAX_ACTIVE_TREES = 32
const MAX_EVICTED_TREES = 64

const DIRTY_MAX_FILES = TREE_MAX_FILES
const GIT_CALL_TIMEOUT = 8000
const GIT_ENV_OVERRIDE = { GIT_OPTIONAL_LOCKS: '0' }
const BLOB_FETCH_CONCURRENCY = 8

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface GitContext {
  gitRoot: string
  relRoot: string
}

async function resolveGitContext(root: string): Promise<GitContext | null> {
  try {
    const repo = await resolveRepo(root)
    if (!repo) return null
    const absRoot = await realpath(root).catch(() => resolvePath(root))
    let rel = relative(repo.root, absRoot).split(sep).join('/')
    if (rel === '.') rel = ''
    if (rel.startsWith('..')) return null
    return { gitRoot: repo.root, relRoot: rel }
  } catch {
    return null
  }
}

function gitKeyFromRepoPath(repoPath: string, relRoot: string): string | null {
  if (!relRoot) return repoPath
  if (repoPath === relRoot) return null
  const prefix = relRoot + '/'
  if (!repoPath.startsWith(prefix)) return null
  return repoPath.slice(prefix.length)
}

async function runGitStatusDirty(root: string): Promise<GitStatusParse | null> {
  const res = await gitRun(
    root,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules', '--no-renames', '--', '.'],
    { allowFailure: true, timeout: GIT_CALL_TIMEOUT, env: GIT_ENV_OVERRIDE }
  )
  if (!res.ok && !res.stdout) return null
  return parseStatusV2(res.stdout)
}

async function captureGitTree(root: string, previous: TreeSnapshot | undefined, ctx: GitContext): Promise<TreeSnapshot | null> {
  const parsed = await runGitStatusDirty(root)
  if (!parsed) return null
  const head = parsed.unborn ? null : parsed.head

  const keyed = parsed.entries
    .map((e) => ({ e, key: gitKeyFromRepoPath(e.path, ctx.relRoot) }))
    .filter((x): x is { e: GitStatusEntry; key: string } => x.key !== null)
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))

  let truncated = false
  let use = keyed
  if (keyed.length > DIRTY_MAX_FILES) {
    truncated = true
    use = keyed.slice(0, DIRTY_MAX_FILES)
  }

  const files = new Map<string, TreeEntry>()
  let budget = TREE_CONTENT_BUDGET
  for (const { e, key } of use) {
    const abs = join(root, ...key.split('/'))
    let info: { size: number; mtimeMs: number } | null = null
    try {
      const s = await stat(abs)
      if (s.isFile()) info = { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
    }
    if (!info) {
      files.set(key, { size: 0, mtimeMs: 0, exists: false, untracked: e.untracked })
      continue
    }
    const entry: TreeEntry = { size: info.size, mtimeMs: info.mtimeMs, exists: true, untracked: e.untracked }
    const known = previous?.files.get(key)
    if (known?.hash && known.exists !== false && known.size === entry.size && known.mtimeMs === entry.mtimeMs && entry.size <= budget) {
      entry.hash = known.hash
      if (known.content !== undefined) entry.content = known.content
      budget -= entry.size
    } else if (entry.size <= TREE_CONTENT_MAX_BYTES && entry.size <= budget) {
      try {
        const buf = await readFile(abs)
        entry.hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
        const text = buf.toString('utf8')
        if (!text.includes('\u0000')) entry.content = text
        budget -= buf.byteLength
      } catch {
      }
    }
    files.set(key, entry)
  }

  return {
    root,
    mode: 'git',
    files,
    truncated,
    unreadable: false,
    unreadableDirs: 0,
    scanned: use.length,
    gitRoot: ctx.gitRoot,
    relRoot: ctx.relRoot,
    head
  }
}

async function captureWalkTree(root: string, previous?: TreeSnapshot): Promise<TreeSnapshot> {
  const snap: TreeSnapshot = { root, mode: 'walk', files: new Map(), truncated: false, unreadable: false, unreadableDirs: 0, scanned: 0 }
  const found: Array<{ key: string; abs: string; size: number; mtimeMs: number }> = []
  let stopped = false

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (stopped) return
    if (depth > TREE_MAX_DEPTH) {
      snap.truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      snap.unreadableDirs++
      if (rel === '') {
        snap.unreadable = true
        snap.truncated = true
      }
      return
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    const files = entries.filter((entry) => entry.isFile())
    const dirs = entries.filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))

    const remaining = TREE_MAX_FILES - found.length
    if (remaining <= 0) {
      stopped = true
      snap.truncated = true
      return
    }
    const take = files.slice(0, remaining)
    if (take.length < files.length) snap.truncated = true
    const stats = await mapLimited(take, TREE_STAT_CONCURRENCY, async (entry) => {
      try {
        return await stat(join(abs, entry.name))
      } catch {
        return null
      }
    })
    for (let index = 0; index < take.length; index++) {
      const info = stats[index]
      if (!info) {
        snap.unreadableDirs++
        continue
      }
      const key = rel ? rel + '/' + take[index].name : take[index].name
      found.push({ key, abs: join(abs, take[index].name), size: info.size, mtimeMs: info.mtimeMs })
    }
    if (found.length >= TREE_MAX_FILES) {
      stopped = true
      snap.truncated = true
      return
    }
    for (const entry of dirs) {
      if (stopped) break
      await walk(join(abs, entry.name), rel ? rel + '/' + entry.name : entry.name, depth + 1)
    }
  }

  await walk(root, '', 0)

  let budget = TREE_CONTENT_BUDGET
  for (const file of found) {
    const entry: TreeEntry = { size: file.size, mtimeMs: file.mtimeMs }
    const known = previous?.files.get(file.key)
    if (known?.hash && known.size === file.size && known.mtimeMs === file.mtimeMs && file.size <= budget) {
      entry.hash = known.hash
      if (known.content !== undefined) entry.content = known.content
      budget -= file.size
    } else if (file.size <= TREE_CONTENT_MAX_BYTES && file.size <= budget) {
      try {
        const buf = await readFile(file.abs)
        entry.hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
        const text = buf.toString('utf8')
        if (!text.includes('\u0000')) entry.content = text
        budget -= buf.byteLength
      } catch {
      }
    }
    snap.files.set(file.key, entry)
    snap.scanned++
  }
  return snap
}

export async function captureTree(root: string, previous?: TreeSnapshot): Promise<TreeSnapshot> {
  if (previous?.mode === 'git' && previous.gitRoot !== undefined && previous.relRoot !== undefined) {
    const ctx: GitContext = { gitRoot: previous.gitRoot, relRoot: previous.relRoot }
    const snap = await captureGitTree(root, previous, ctx)
    if (snap) return snap
    return {
      root,
      mode: 'git',
      files: new Map(),
      truncated: true,
      unreadable: true,
      unreadableDirs: 1,
      scanned: 0,
      gitRoot: ctx.gitRoot,
      relRoot: ctx.relRoot,
      head: null
    }
  }
  const ctx = await resolveGitContext(root)
  if (ctx) {
    const snap = await captureGitTree(root, previous, ctx)
    if (snap) return snap
  }
  return captureWalkTree(root, previous)
}

export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeChange[] {
  const out: TreeChange[] = []
  for (const [p, b] of after.files) {
    const a = before.files.get(p)
    if (!a) {
      out.push({ path: p, status: 'created', beforeSize: -1, afterSize: b.size })
      continue
    }
    if (a.size !== b.size) {
      out.push({ path: p, status: 'modified', beforeSize: a.size, afterSize: b.size })
      continue
    }
    if (a.hash && b.hash) {
      if (a.hash !== b.hash) out.push({ path: p, status: 'modified', beforeSize: a.size, afterSize: b.size })
      continue
    }
    if (a.mtimeMs !== b.mtimeMs) {
      out.push({ path: p, status: 'unknown', beforeSize: a.size, afterSize: b.size })
    }
  }
  for (const [p, a] of before.files) {
    if (!after.files.has(p)) out.push({ path: p, status: 'deleted', beforeSize: a.size, afterSize: -1 })
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
}

function compareDirtyEntries(b: TreeEntry, a: TreeEntry): { status: WorkspaceChangeFile['status']; beforeSize: number; afterSize: number } | null {
  const bExists = b.exists !== false
  const aExists = a.exists !== false
  if (!bExists && !aExists) return null
  if (!bExists && aExists) return { status: 'created', beforeSize: -1, afterSize: a.size }
  if (bExists && !aExists) return { status: 'deleted', beforeSize: b.size, afterSize: -1 }
  if (b.size !== a.size) return { status: 'modified', beforeSize: b.size, afterSize: a.size }
  if (b.hash && a.hash) {
    return b.hash !== a.hash ? { status: 'modified', beforeSize: b.size, afterSize: a.size } : null
  }
  if (b.mtimeMs !== a.mtimeMs) return { status: 'unknown', beforeSize: b.size, afterSize: a.size }
  return null
}

function gitBlobBuffer(root: string, spec: string, maxBytes: number): Promise<Buffer | null> {
  return new Promise((settle) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', 'cat-file', 'blob', spec], {
      cwd: root,
      windowsHide: true,
      env: sanitizedGitEnv(process.env, GIT_ENV_OVERRIDE)
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let failed = false
    const timer = setTimeout(() => {
      failed = true
      killProcessTree(child)
    }, GIT_CALL_TIMEOUT)
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
      settle(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle(code === 0 && !failed ? Buffer.concat(chunks) : null)
    })
  })
}

async function fetchBlob(
  gitRoot: string,
  rev: string,
  repoPath: string,
  budgetRef: { value: number }
): Promise<{ exists: boolean; size: number; content?: string }> {
  const spec = `${rev}:${repoPath}`
  const sized = await gitRun(gitRoot, ['cat-file', '-s', spec], { allowFailure: true, timeout: GIT_CALL_TIMEOUT, env: GIT_ENV_OVERRIDE })
  if (!sized.ok) return { exists: false, size: -1 }
  const size = Number(sized.stdout.trim())
  if (!Number.isFinite(size)) return { exists: false, size: -1 }
  if (size > TREE_CONTENT_MAX_BYTES || size > budgetRef.value) return { exists: true, size }
  const buf = await gitBlobBuffer(gitRoot, spec, TREE_CONTENT_MAX_BYTES)
  if (!buf) return { exists: true, size }
  budgetRef.value -= buf.byteLength
  const text = buf.toString('utf8')
  return text.includes('\u0000') ? { exists: true, size } : { exists: true, size, content: text }
}

async function resolveRevert(
  entry: TreeEntry,
  afterHead: string | null,
  gitRoot: string,
  repoPath: string,
  budgetRef: { value: number }
): Promise<{ status: WorkspaceChangeFile['status']; beforeSize: number; afterSize: number; afterContent?: string } | null> {
  const bExists = entry.exists !== false
  if (!afterHead) {
    return bExists ? { status: 'deleted', beforeSize: entry.size, afterSize: -1 } : null
  }
  const resolved = await fetchBlob(gitRoot, afterHead, repoPath, budgetRef)
  if (!bExists) {
    return resolved.exists ? { status: 'created', beforeSize: -1, afterSize: resolved.size, afterContent: resolved.content } : null
  }
  if (!resolved.exists) return { status: 'deleted', beforeSize: entry.size, afterSize: -1 }
  if (entry.size !== resolved.size) return { status: 'modified', beforeSize: entry.size, afterSize: resolved.size, afterContent: resolved.content }
  if (entry.content !== undefined && resolved.content !== undefined) {
    return entry.content === resolved.content
      ? null
      : { status: 'modified', beforeSize: entry.size, afterSize: resolved.size, afterContent: resolved.content }
  }
  return { status: 'unknown', beforeSize: entry.size, afterSize: resolved.size, afterContent: resolved.content }
}

async function runHeadDiff(
  gitRoot: string,
  relRoot: string,
  beforeHead: string,
  afterHead: string
): Promise<{ entries: Map<string, string>; truncated: boolean } | null> {
  const pathspec = relRoot ? relRoot + '/' : '.'
  const res = await gitRun(gitRoot, ['diff', '--name-status', '--no-renames', beforeHead, afterHead, '--', pathspec], {
    allowFailure: true,
    timeout: GIT_CALL_TIMEOUT,
    env: GIT_ENV_OVERRIDE
  })
  if (!res.ok && !res.stdout) return null
  const entries = new Map<string, string>()
  let truncated = false
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const code = line.slice(0, tab)
    const repoPath = line.slice(tab + 1)
    const key = gitKeyFromRepoPath(repoPath, relRoot)
    if (key === null) continue
    if (entries.size >= DIRTY_MAX_FILES) {
      truncated = true
      break
    }
    entries.set(key, code[0] ?? 'M')
  }
  return { entries, truncated }
}

interface GitChangeCandidate {
  key: string
  status: WorkspaceChangeFile['status']
  beforeSize: number
  afterSize: number
  beforeContent?: string
  afterContent?: string
  beforeFetch?: string
  afterFetch?: string
}

async function buildGitWorkspaceChanges(
  before: TreeSnapshot,
  after: TreeSnapshot
): Promise<{ files: WorkspaceChangeFile[]; total: number; scanned: number; truncated: boolean }> {
  const gitRoot = before.gitRoot ?? after.gitRoot ?? ''
  const relRoot = before.relRoot ?? after.relRoot ?? ''
  const beforeHead = before.head ?? null
  const afterHead = after.head ?? null
  const beforeDirty = before.files
  const afterDirty = after.files

  let truncated = before.truncated || after.truncated
  const headDiffCodes = new Map<string, string>()
  if (beforeHead !== afterHead) {
    if (beforeHead && afterHead && gitRoot) {
      const diff = await runHeadDiff(gitRoot, relRoot, beforeHead, afterHead)
      if (diff) {
        for (const [k, c] of diff.entries) headDiffCodes.set(k, c)
        if (diff.truncated) truncated = true
      } else {
        truncated = true
      }
    } else {
      truncated = true
    }
  }

  const keys = new Set<string>([...beforeDirty.keys(), ...afterDirty.keys(), ...headDiffCodes.keys()])
  const sortedKeys = [...keys].sort()

  const candidates: GitChangeCandidate[] = []
  const pendingReverts: Array<{ key: string; entry: TreeEntry }> = []

  for (const key of sortedKeys) {
    const b = beforeDirty.get(key)
    const a = afterDirty.get(key)
    if (b && a) {
      const cmp = compareDirtyEntries(b, a)
      if (cmp) candidates.push({ key, ...cmp, beforeContent: b.content, afterContent: a.content })
      continue
    }
    if (a && !b) {
      if (a.untracked) {
        const exists = a.exists !== false
        candidates.push({ key, status: 'created', beforeSize: -1, afterSize: exists ? a.size : -1, afterContent: a.content })
      } else {
        const exists = a.exists !== false
        candidates.push({
          key,
          status: exists ? 'modified' : 'deleted',
          beforeSize: -1,
          afterSize: exists ? a.size : -1,
          afterContent: a.content,
          beforeFetch: beforeHead ?? undefined
        })
      }
      continue
    }
    if (b && !a) {
      if (b.untracked) {
        const exists = b.exists !== false
        candidates.push({ key, status: 'deleted', beforeSize: exists ? b.size : -1, afterSize: -1, beforeContent: b.content })
      } else {
        pendingReverts.push({ key, entry: b })
      }
      continue
    }
    const code = headDiffCodes.get(key) ?? 'M'
    if (code === 'A') candidates.push({ key, status: 'created', beforeSize: -1, afterSize: -1, afterFetch: afterHead ?? undefined })
    else if (code === 'D') candidates.push({ key, status: 'deleted', beforeSize: -1, afterSize: -1, beforeFetch: beforeHead ?? undefined })
    else {
      candidates.push({
        key,
        status: 'modified',
        beforeSize: -1,
        afterSize: -1,
        beforeFetch: beforeHead ?? undefined,
        afterFetch: afterHead ?? undefined
      })
    }
  }

  if (pendingReverts.length) {
    if (gitRoot) {
      const budgetRef = { value: TREE_CONTENT_BUDGET }
      const resolved = await mapLimited(pendingReverts, BLOB_FETCH_CONCURRENCY, async ({ key, entry }) => {
        const repoPath = relRoot ? relRoot + '/' + key : key
        return { key, entry, resolved: await resolveRevert(entry, afterHead, gitRoot, repoPath, budgetRef) }
      })
      for (const r of resolved) {
        if (!r.resolved) continue
        candidates.push({ key: r.key, ...r.resolved, beforeContent: r.entry.content })
      }
    } else {
      truncated = true
    }
  }

  candidates.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  const total = candidates.length
  const display = candidates.slice(0, CHANGE_MAX_FILES)

  if (gitRoot && display.some((c) => c.beforeFetch !== undefined || c.afterFetch !== undefined)) {
    const budgetRef = { value: TREE_CONTENT_BUDGET }
    await mapLimited(display, BLOB_FETCH_CONCURRENCY, async (c) => {
      const repoPath = relRoot ? relRoot + '/' + c.key : c.key
      if (c.beforeFetch !== undefined && c.beforeContent === undefined) {
        const r = await fetchBlob(gitRoot, c.beforeFetch, repoPath, budgetRef)
        if (r.exists) {
          c.beforeSize = r.size
          c.beforeContent = r.content
        }
      }
      if (c.afterFetch !== undefined && c.afterContent === undefined) {
        const r = await fetchBlob(gitRoot, c.afterFetch, repoPath, budgetRef)
        if (r.exists) {
          c.afterSize = r.size
          c.afterContent = r.content
        }
      }
    })
  }

  const files: WorkspaceChangeFile[] = display.map((c) => {
    const stats =
      c.status === 'created'
        ? createdStats(c.afterContent)
        : c.status === 'deleted'
          ? deletedStats(c.beforeContent)
          : c.status === 'modified'
            ? diffStats(c.beforeContent, c.afterContent)
            : { added: -1, removed: -1, patch: '' }
    return {
      path: c.key,
      status: c.status,
      beforeSize: c.beforeSize,
      afterSize: c.afterSize,
      added: stats.added,
      removed: stats.removed,
      patch: stats.patch
    }
  })

  return { files, total, scanned: after.scanned, truncated }
}

interface ActiveTree {
  callId: string
  sessionId?: string
  root: string
  rootKey: string
  snap: TreeSnapshot
  concurrent: boolean
  cancelled: boolean
  failed: boolean
  readyAt: number
  ready: Promise<void>
}

const activeTrees = new Map<string, ActiveTree>()
const evictedTrees = new Map<string, string>()

function treeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function beginTreeSnapshot(callId: string, root: string, sessionId?: string): Promise<void> {
  if (!callId || !root) return Promise.resolve()
  const existing = activeTrees.get(callId)
  if (existing) {
    if (existing.root === root) return existing.ready
    activeTrees.delete(callId)
  }
  const key = treeKey(root)
  let concurrent = false
  for (const other of activeTrees.values()) {
    if (other.callId !== callId && other.rootKey === key) {
      concurrent = true
      other.concurrent = true
    }
  }
  const tree: ActiveTree = {
    callId,
    sessionId,
    root,
    rootKey: key,
    concurrent,
    cancelled: false,
    failed: false,
    readyAt: 0,
    snap: { root, files: new Map(), truncated: false, unreadable: false, unreadableDirs: 0, scanned: 0 },
    ready: Promise.resolve()
  }
  tree.ready = captureTree(root)
    .then((snap) => {
      if (!tree.cancelled) tree.snap = snap
      tree.readyAt = Date.now()
    })
    .catch(() => {
      tree.failed = true
      tree.snap = { root, files: new Map(), truncated: true, unreadable: true, unreadableDirs: 1, scanned: 0 }
      tree.readyAt = Date.now()
    })
  activeTrees.set(callId, tree)
  evictedTrees.delete(callId)
  while (activeTrees.size > MAX_ACTIVE_TREES) {
    const oldest = activeTrees.keys().next().value
    if (oldest === undefined) break
    const evicted = activeTrees.get(oldest)
    if (evicted) evicted.cancelled = true
    activeTrees.delete(oldest)
    evictedTrees.delete(oldest)
    evictedTrees.set(oldest, evicted?.root ?? root)
    while (evictedTrees.size > MAX_EVICTED_TREES) {
      const stale = evictedTrees.keys().next().value
      if (stale === undefined) break
      evictedTrees.delete(stale)
    }
  }
  return tree.ready
}

function toChangeFile(before: TreeSnapshot, after: TreeSnapshot, change: TreeChange): WorkspaceChangeFile {
  const a = before.files.get(change.path)
  const b = after.files.get(change.path)
  let added = -1
  let removed = -1
  let patch = ''
  if (change.status === 'created' && b?.content !== undefined) {
    const s = createdStats(b.content)
    added = s.added
    removed = s.removed
    patch = s.patch
  } else if (change.status === 'deleted' && a?.content !== undefined) {
    const s = deletedStats(a.content)
    added = s.added
    removed = s.removed
    patch = s.patch
  } else if (change.status === 'modified' && a?.content !== undefined && b?.content !== undefined) {
    const s = diffStats(a.content, b.content)
    added = s.added
    removed = s.removed
    patch = s.patch
  }
  return {
    path: change.path,
    status: change.status,
    beforeSize: change.beforeSize,
    afterSize: change.afterSize,
    added,
    removed,
    patch
  }
}

export async function endTreeSnapshot(callId: string): Promise<WorkspaceChanges | null> {
  const active = activeTrees.get(callId)
  if (!active) {
    const evictedRoot = evictedTrees.get(callId)
    if (evictedRoot === undefined) return null
    evictedTrees.delete(callId)
    return { root: evictedRoot, files: [], total: 0, scanned: 0, unknown: 'truncated' }
  }
  const requestedAt = Date.now()
  activeTrees.delete(callId)

  await active.ready
  if (active.cancelled) return null
  if (active.failed) {
    return { root: active.root, files: [], total: 0, scanned: 0, unknown: 'unreadable' }
  }
  const after = await captureTree(active.root, active.snap)
  if (after.mode === 'git' && after.unreadable) {
    return { root: active.root, files: [], total: 0, scanned: 0, unknown: 'unreadable' }
  }
  if (active.snap.mode !== after.mode) {
    return { root: active.root, files: [], total: 0, scanned: after.scanned, unknown: 'truncated' }
  }

  let unknown: WorkspaceChanges['unknown']
  let files: WorkspaceChangeFile[]
  let total: number
  let scanned: number

  if (active.snap.mode === 'git' && after.mode === 'git') {
    const built = await buildGitWorkspaceChanges(active.snap, after)
    files = built.files
    total = built.total
    scanned = built.scanned
    if (active.concurrent || !active.readyAt || active.readyAt > requestedAt) unknown = 'concurrent'
    else if (built.truncated) unknown = 'truncated'
  } else {
    const changes = diffTrees(active.snap, after)
    if (active.snap.unreadable && after.unreadable) unknown = 'unreadable'
    else if (active.concurrent || !active.readyAt || active.readyAt > requestedAt) unknown = 'concurrent'
    else if (active.snap.truncated || after.truncated) unknown = 'truncated'
    files = changes.slice(0, CHANGE_MAX_FILES).map((c) => toChangeFile(active.snap, after, c))
    total = changes.length
    scanned = after.scanned
  }

  return {
    root: active.root,
    files,
    total,
    scanned,
    ...(unknown ? { unknown } : {})
  }
}
