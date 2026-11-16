import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeSubagentId } from '../shared/subagent-id'
import { cleanupWorkspace } from './subagent-isolation'
import { savedOutputsAt } from './subagent-outputs-stamp'
import { subagentWorktreeRoot } from './subagent-worktree-root'
import { planSubagentPrune, type PruneItem } from './subagent-resume'

const DAY_MS = 24 * 60 * 60 * 1000
const READ_CONCURRENCY = 4
const TERMINAL = new Set(['done', 'error', 'cancelled'])
const SETTLED_REVIEWS = new Set(['none', 'merged', 'discarded'])

export interface SubagentPruneOptions {
  now?: number
  keepDays?: number
  keepCount?: number
  liveIds?: ReadonlySet<string>
}

interface StoredRecord {
  status?: unknown
  review?: unknown
  hidden?: unknown
  dismissedAt?: unknown
  isolation?: unknown
  cwd?: unknown
  rootCwd?: unknown
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function settledForPrune(record: StoredRecord): { terminal: boolean; reviewed: boolean } {
  const status = typeof record.status === 'string' ? record.status : ''
  const review = typeof record.review === 'string' ? record.review : 'none'
  const terminal = TERMINAL.has(status)
  const handled = status !== 'error' || record.hidden === true || typeof record.dismissedAt === 'number'
  return { terminal, reviewed: SETTLED_REVIEWS.has(review) && handled }
}

async function removeWorktree(record: StoredRecord): Promise<void> {
  if (record.isolation !== 'worktree' || typeof record.cwd !== 'string' || typeof record.rootCwd !== 'string') return
  const worktreePath = subagentWorktreeRoot(record.cwd)
  if (!worktreePath || !existsSync(worktreePath)) return
  await cleanupWorkspace({
    isolation: 'worktree',
    rootCwd: record.rootCwd,
    cwd: record.cwd,
    repoRoot: record.rootCwd,
    worktreePath,
    containerPath: dirname(worktreePath)
  }).catch(() => undefined)
}

export async function pruneSubagentArchive(dir: string, options: SubagentPruneOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now()
  const keepDays = options.keepDays ?? envNumber('YAN_SUBAGENT_KEEP_DAYS', 30)
  const keep = options.keepCount ?? envNumber('YAN_SUBAGENT_KEEP_COUNT', 1500)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: { id: string; mtime: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = normalizeSubagentId(entry.name.slice(0, -5))
    if (!id || options.liveIds?.has(id)) continue
    const info = await stat(join(dir, entry.name)).catch(() => undefined)
    if (info) files.push({ id, mtime: info.mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const cutoff = now - keepDays * DAY_MS
  const ranked = files.map((file, rank) => ({ ...file, rank }))
  const candidates = ranked.filter((file) => file.rank >= keep && file.mtime < cutoff)
  const records = new Map<string, StoredRecord>()
  const items: PruneItem[] = []
  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + READ_CONCURRENCY).map(async (file) => {
      try {
        const record = JSON.parse(await readFile(join(dir, `${file.id}.json`), 'utf8')) as StoredRecord
        records.set(file.id, record)
        items.push({ id: file.id, lastActiveAt: file.mtime, rank: file.rank, live: false, ...settledForPrune(record) })
      } catch {
      }
    }))
  }
  const doomed = planSubagentPrune(items, { now, maxAgeMs: keepDays * DAY_MS, keep })
  for (const id of doomed) {
    const record = records.get(id)
    if (record) await removeWorktree(record)
    await Promise.all([
      rm(join(dir, `${id}.json`), { force: true }),
      rm(join(dir, `${id}.patch`), { force: true }),
      rm(join(dir, `${id}-outputs`), { recursive: true, force: true }),
      ...entries.filter((entry) => entry.isFile() && (entry.name.startsWith(`${id}-idle-`) || entry.name.startsWith(`${id}-recovered-`)) && entry.name.endsWith('.patch')).map((entry) => rm(join(dir, entry.name), { force: true })),
      rm(join(dir, 'sessions', id), { recursive: true, force: true }),
      rm(join(dir, 'approvals', id), { recursive: true, force: true })
    ].map((task) => task.catch(() => undefined)))
  }
  return doomed
}

const OUTPUTS_SUFFIX = '-outputs'
const OUTPUTS_FRESH_MS = DAY_MS

export interface OutputsPruneOptions {
  now?: number
  keepDays?: number
  maxBytes?: number
  keepIds?: ReadonlySet<string>
  protect?: (id: string) => boolean
}

export function subagentOutputsPolicy(): { keepDays: number; maxBytes: number } {
  return { keepDays: envNumber('YAN_SUBAGENT_OUTPUTS_KEEP_DAYS', 30), maxBytes: envNumber('YAN_SUBAGENT_OUTPUTS_MAX_MB', 5120) * 1024 * 1024 }
}

export async function outputsTreeBytes(root: string): Promise<number> {
  let bytes = 0
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      const info = await stat(path).catch(() => undefined)
      if (info) bytes += info.size
    }
  }
  return bytes
}

async function outputsDirs(dir: string): Promise<{ id: string; path: string; bytes: number; savedAt: number }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: { id: string; path: string; bytes: number; savedAt: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(OUTPUTS_SUFFIX)) continue
    const id = normalizeSubagentId(entry.name.slice(0, -OUTPUTS_SUFFIX.length))
    if (!id) continue
    const path = join(dir, entry.name)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    found.push({ id, path, bytes: await outputsTreeBytes(path), savedAt: await savedOutputsAt(path, info.mtimeMs) })
  }
  return found
}

export async function subagentOutputsTotal(dir: string): Promise<number> {
  return (await outputsDirs(dir)).reduce((sum, item) => sum + item.bytes, 0)
}

export async function pruneSubagentOutputs(dir: string, options: OutputsPruneOptions = {}): Promise<{ removed: string[]; bytes: number; inUse: number }> {
  const now = options.now ?? Date.now()
  const policy = subagentOutputsPolicy()
  const keepDays = options.keepDays ?? policy.keepDays
  const maxBytes = options.maxBytes ?? policy.maxBytes
  const guarded = (id: string) => !!options.keepIds?.has(id) || !!options.protect?.(id)
  const found = await outputsDirs(dir)
  let inUse = 0
  const dirs = found.filter((item) => {
    if (!guarded(item.id)) return true
    inUse += item.bytes
    return false
  }).sort((a, b) => a.savedAt - b.savedAt)
  let total = dirs.reduce((sum, item) => sum + item.bytes, 0)
  const cutoff = now - keepDays * DAY_MS
  const removed: string[] = []
  for (const item of dirs) {
    const info = await lstat(item.path).catch(() => undefined)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    const savedAt = await savedOutputsAt(item.path, info.mtimeMs)
    if (now - savedAt < OUTPUTS_FRESH_MS) continue
    if (savedAt >= cutoff && total <= maxBytes) continue
    if (guarded(item.id)) {
      total -= item.bytes
      inUse += item.bytes
      continue
    }
    const gone = await rm(item.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).then(() => true, () => false)
    if (!gone) continue
    total -= item.bytes
    removed.push(item.id)
  }
  if (total + inUse > maxBytes) console.warn(`[subagent] saved outputs still exceed the ${maxBytes} byte limit after pruning: ${inUse} bytes are in use and ${total} bytes are other folders kept by the retention rules; stopped without removing in-use folders`)
  return { removed, bytes: total, inUse }
}
