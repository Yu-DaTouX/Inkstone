import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { FileDiff, FileSnapshotSide, WorkspaceChangeFile, WorkspaceChanges } from '../shared/ipc'

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

export function snapshotBefore(callId: string, path: string): void {
  const before = captureSide(path)
  pending.set(callId, { path, before, at: Date.now() })
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
  const after = captureSide(entry.path)
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
  activeTrees.clear()
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
}

export interface TreeSnapshot {
  root: string
  files: Map<string, TreeEntry>
  truncated: boolean
  unreadable: boolean
  unreadableDirs: number
  scanned: number
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
const CHANGE_MAX_FILES = 40
const MAX_ACTIVE_TREES = 8

export function captureTree(root: string): TreeSnapshot {
  const snap: TreeSnapshot = { root, files: new Map(), truncated: false, unreadable: false, unreadableDirs: 0, scanned: 0 }
  let budget = TREE_CONTENT_BUDGET

  const walk = (abs: string, rel: string, depth: number): void => {
    if (snap.files.size >= TREE_MAX_FILES || depth > TREE_MAX_DEPTH) {
      snap.truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      snap.unreadableDirs++
      if (rel === '') {
        snap.unreadable = true
        snap.truncated = true
      }
      return
    }
    for (const e of entries) {
      if (snap.files.size >= TREE_MAX_FILES) {
        snap.truncated = true
        break
      }
      const key = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(abs, e.name), key, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      let st
      try {
        st = statSync(join(abs, e.name))
      } catch {
        snap.unreadableDirs++
        continue
      }
      const entry: TreeEntry = { size: st.size, mtimeMs: st.mtimeMs }
      if (st.size <= TREE_CONTENT_MAX_BYTES && st.size <= budget) {
        try {
          const buf = readFileSync(join(abs, e.name))
          entry.hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
          const text = buf.toString('utf8')
          if (!text.includes('\u0000')) entry.content = text
          budget -= buf.byteLength
        } catch {
        }
      } else if (st.size > TREE_CONTENT_MAX_BYTES) {
        budget = Math.max(0, budget)
      }
      snap.files.set(key, entry)
      snap.scanned++
    }
  }

  walk(root, '', 0)
  return snap
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

interface ActiveTree {
  callId: string
  sessionId?: string
  root: string
  rootKey: string
  snap: TreeSnapshot
  concurrent: boolean
}

const activeTrees = new Map<string, ActiveTree>()

function treeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function beginTreeSnapshot(callId: string, root: string, sessionId?: string): void {
  if (!callId || !root) return
  const key = treeKey(root)
  let concurrent = false
  for (const other of activeTrees.values()) {
    if (other.callId !== callId && other.rootKey === key) {
      concurrent = true
      other.concurrent = true
    }
  }
  activeTrees.set(callId, { callId, sessionId, root, rootKey: key, snap: captureTree(root), concurrent })
  while (activeTrees.size > MAX_ACTIVE_TREES) {
    const oldest = activeTrees.keys().next().value
    if (oldest === undefined) break
    activeTrees.delete(oldest)
  }
}

export function hasTreeSnapshot(callId: string): boolean {
  return activeTrees.has(callId)
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

export function endTreeSnapshot(callId: string): WorkspaceChanges | null {
  const active = activeTrees.get(callId)
  if (!active) return null
  activeTrees.delete(callId)

  const after = captureTree(active.root)
  const changes = diffTrees(active.snap, after)

  let unknown: WorkspaceChanges['unknown']
  if (active.snap.unreadable && after.unreadable) unknown = 'unreadable'
  else if (active.concurrent) unknown = 'concurrent'
  else if (active.snap.truncated || after.truncated) unknown = 'truncated'

  const listed = changes.slice(0, CHANGE_MAX_FILES).map((c) => toChangeFile(active.snap, after, c))
  return {
    root: active.root,
    files: listed,
    total: changes.length,
    scanned: after.scanned,
    ...(unknown ? { unknown } : {})
  }
}
