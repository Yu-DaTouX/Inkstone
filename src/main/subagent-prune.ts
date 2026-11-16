import { existsSync, type Dirent } from 'node:fs'
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeSubagentId } from '../shared/subagent-id'
import type { SubagentStorageUsage } from '../shared/ipc'
import { cleanupWorkspace } from './subagent-isolation'
import { savedOutputsAt } from './subagent-outputs-stamp'
import { subagentWorktreeRoot } from './subagent-worktree-root'
import { planSubagentPrune, type PruneItem } from './subagent-resume'

const DAY_MS = 24 * 60 * 60 * 1000
const READ_CONCURRENCY = 4
const TERMINAL = new Set(['done', 'error', 'cancelled'])
const SETTLED_REVIEWS = new Set(['none', 'merged', 'discarded'])
const ERROR_SETTLE_DAYS = 30
const ARCHIVED_KEEP_DAYS = 60
const ARCHIVED_KEEP_COUNT = 20
const RECENT_KEEP_DAYS = 7
const SETTLED_KEEP_COUNT = 100
const USAGE_CACHE_MS = 5 * 60 * 1000
const MB = 1024 * 1024

export interface SubagentPruneOptions {
  now?: number
  keepDays?: number
  keepCount?: number
  liveIds?: ReadonlySet<string>
  maxBytes?: number
  protect?: (id: string) => boolean
  errorSettleDays?: number
  archivedKeepDays?: number
  archivedKeepCount?: number
  recentKeepDays?: number
  settledKeepCount?: number
  log?: (line: string) => void
}

interface StoredRecord {
  status?: unknown
  review?: unknown
  hidden?: unknown
  dismissedAt?: unknown
  endedAt?: unknown
  isolation?: unknown
  cwd?: unknown
  rootCwd?: unknown
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function subagentStoragePolicy(): { maxBytes: number } {
  return { maxBytes: envNumber('YAN_SUBAGENT_MAX_MB', 5120) * MB }
}

function recordEndedAt(record: StoredRecord, fallback: number): number {
  return typeof record.endedAt === 'number' && Number.isFinite(record.endedAt) && record.endedAt > 0 ? record.endedAt : fallback
}

export function settledForPrune(
  record: StoredRecord,
  options: { now?: number; endedAt?: number; errorSettleDays?: number } = {}
): { terminal: boolean; reviewed: boolean; archived: boolean } {
  const status = typeof record.status === 'string' ? record.status : ''
  const review = typeof record.review === 'string' ? record.review : 'none'
  const terminal = TERMINAL.has(status)
  const endedAt = options.endedAt ?? recordEndedAt(record, Number.NaN)
  const errorAged = options.now !== undefined && Number.isFinite(endedAt) && options.now - endedAt >= (options.errorSettleDays ?? ERROR_SETTLE_DAYS) * DAY_MS
  const handled = status !== 'error' || record.hidden === true || typeof record.dismissedAt === 'number' || errorAged
  return { terminal, reviewed: SETTLED_REVIEWS.has(review) && handled, archived: review === 'archived' && handled }
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

function patchOwner(name: string, known: ReadonlySet<string>): string | null {
  if (!name.endsWith('.patch')) return null
  const base = name.slice(0, -'.patch'.length)
  if (known.has(base)) return base
  for (const marker of ['-idle-', '-recovered-']) {
    const at = base.lastIndexOf(marker)
    if (at > 0 && known.has(base.slice(0, at))) return base.slice(0, at)
  }
  return null
}

interface StorageScan {
  entries: Dirent[]
  records: Map<string, { mtime: number; bytes: number }>
  sessionBytes: number
  patchBytes: number
  recordBytes: number
  untracked: number
}

async function scanSubagentStorage(dir: string): Promise<StorageScan> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const records = new Map<string, { mtime: number; bytes: number }>()
  let recordBytes = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = normalizeSubagentId(entry.name.slice(0, -5))
    if (!id) continue
    const info = await stat(join(dir, entry.name)).catch(() => undefined)
    if (!info) continue
    records.set(id, { mtime: info.mtimeMs, bytes: info.size })
    recordBytes += info.size
  }
  let untracked = 0
  let patchBytes = 0
  const known = new Set(records.keys())
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const owner = patchOwner(entry.name, known)
    if (!owner && !entry.name.endsWith('.patch')) continue
    const info = await stat(join(dir, entry.name)).catch(() => undefined)
    if (!info) continue
    patchBytes += info.size
    const record = owner ? records.get(owner) : undefined
    if (record) record.bytes += info.size
    else untracked += info.size
  }
  let sessionBytes = 0
  const sessions = await readdir(join(dir, 'sessions'), { withFileTypes: true }).catch(() => [])
  for (const entry of sessions) {
    const path = join(dir, 'sessions', entry.name)
    const bytes = entry.isDirectory() ? await outputsTreeBytes(path) : entry.isFile() ? (await stat(path).catch(() => undefined))?.size ?? 0 : 0
    sessionBytes += bytes
    const record = records.get(entry.name)
    if (record && entry.isDirectory()) record.bytes += bytes
    else untracked += bytes
  }
  return { entries, records, sessionBytes, patchBytes, recordBytes, untracked }
}

const usageCache = new Map<string, { at: number; value: Promise<SubagentStorageUsage> }>()

export function invalidateSubagentStorageUsage(): void {
  usageCache.clear()
}

export function cachedSubagentStorageUsage(dir: string, now = Date.now()): Promise<SubagentStorageUsage> {
  const hit = usageCache.get(dir)
  if (hit && now - hit.at < USAGE_CACHE_MS) return hit.value
  const value = subagentStorageUsage(dir)
  usageCache.set(dir, { at: now, value })
  value.catch(() => {
    if (usageCache.get(dir)?.value === value) usageCache.delete(dir)
  })
  return value
}

export async function subagentStorageUsage(dir: string): Promise<SubagentStorageUsage> {
  const scan = await scanSubagentStorage(dir)
  return {
    records: scan.records.size,
    recordBytes: scan.recordBytes,
    sessionBytes: scan.sessionBytes,
    patchBytes: scan.patchBytes,
    untrackedBytes: scan.untracked,
    outputsBytes: await subagentOutputsTotal(dir),
    maxBytes: subagentStoragePolicy().maxBytes,
    outputsMaxBytes: subagentOutputsPolicy().maxBytes
  }
}

async function removeRecord(dir: string, id: string, record: StoredRecord | undefined, entries: Dirent[]): Promise<number> {
  if (record) await removeWorktree(record)
  const outputs = join(dir, `${id}-outputs`)
  const outputsInfo = await lstat(outputs).catch(() => undefined)
  const outputsBytes = outputsInfo?.isDirectory() && !outputsInfo.isSymbolicLink() ? await outputsTreeBytes(outputs) : 0
  await Promise.all([
    rm(join(dir, `${id}.json`), { force: true }),
    rm(join(dir, `${id}.patch`), { force: true }),
    rm(outputs, { recursive: true, force: true }),
    ...entries.filter((entry) => entry.isFile() && (entry.name.startsWith(`${id}-idle-`) || entry.name.startsWith(`${id}-recovered-`)) && entry.name.endsWith('.patch')).map((entry) => rm(join(dir, entry.name), { force: true })),
    rm(join(dir, 'sessions', id), { recursive: true, force: true }),
    rm(join(dir, 'approvals', id), { recursive: true, force: true })
  ].map((task) => task.catch(() => undefined)))
  return outputsBytes
}

async function readStored(dir: string, id: string): Promise<StoredRecord | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as StoredRecord
  } catch {
    return null
  }
}

function mb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)}MB`
}

export async function pruneSubagentArchive(dir: string, options: SubagentPruneOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now()
  const keepDays = options.keepDays ?? envNumber('YAN_SUBAGENT_KEEP_DAYS', 30)
  const keep = options.keepCount ?? envNumber('YAN_SUBAGENT_KEEP_COUNT', 1500)
  const maxBytes = options.maxBytes ?? subagentStoragePolicy().maxBytes
  const errorSettleDays = options.errorSettleDays ?? ERROR_SETTLE_DAYS
  const archivedKeepMs = (options.archivedKeepDays ?? ARCHIVED_KEEP_DAYS) * DAY_MS
  const archivedKeepCount = options.archivedKeepCount ?? ARCHIVED_KEEP_COUNT
  const log = options.log ?? ((line: string) => console.log(line))
  const guarded = (id: string) => !!options.liveIds?.has(id) || !!options.protect?.(id)
  const scan = await scanSubagentStorage(dir)
  const { entries } = scan
  const files = [...scan.records].filter(([id]) => !options.liveIds?.has(id)).map(([id, info]) => ({ id, mtime: info.mtime }))
  files.sort((a, b) => b.mtime - a.mtime)
  const cutoff = now - keepDays * DAY_MS
  const ranked = files.map((file, rank) => ({ ...file, rank }))
  const candidates = ranked.filter((file) => file.rank >= keep && file.mtime < cutoff)
  const records = new Map<string, StoredRecord>()
  const items: PruneItem[] = []
  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + READ_CONCURRENCY).map(async (file) => {
      const record = await readStored(dir, file.id)
      if (!record) return
      records.set(file.id, record)
      const settled = settledForPrune(record, { now, endedAt: recordEndedAt(record, file.mtime), errorSettleDays })
      items.push({ id: file.id, lastActiveAt: file.mtime, rank: file.rank, live: false, terminal: settled.terminal, reviewed: settled.reviewed })
    }))
  }
  const doomed = planSubagentPrune(items, { now, maxAgeMs: keepDays * DAY_MS, keep }).filter((id) => !guarded(id))
  let total = [...scan.records.values()].reduce((sum, item) => sum + item.bytes, 0)
  let freed = 0
  let outputsFreed = 0
  const removed: string[] = []
  for (const id of doomed) {
    if (guarded(id)) continue
    outputsFreed += await removeRecord(dir, id, records.get(id), entries)
    const bytes = scan.records.get(id)?.bytes ?? 0
    total -= bytes
    freed += bytes
    removed.push(id)
  }
  const capped: string[] = []
  if (total > maxBytes) {
    const recentMs = (options.recentKeepDays ?? RECENT_KEEP_DAYS) * DAY_MS
    const settledKeep = options.settledKeepCount ?? SETTLED_KEEP_COUNT
    const gone = new Set(removed)
    const rest = files.filter((file) => !gone.has(file.id))
    const views: { id: string; endedAt: number; bytes: number; record: StoredRecord; normal: boolean; archived: boolean }[] = []
    for (let i = 0; i < rest.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(rest.slice(i, i + READ_CONCURRENCY).map(async (file) => ({ file, record: records.get(file.id) ?? await readStored(dir, file.id) })))
      for (const { file, record } of batch) {
        if (!record || guarded(file.id)) continue
        const endedAt = recordEndedAt(record, file.mtime)
        const settled = settledForPrune(record, { now, endedAt, errorSettleDays })
        if (!settled.terminal) continue
        views.push({ id: file.id, endedAt, bytes: scan.records.get(file.id)?.bytes ?? 0, record, normal: settled.reviewed, archived: settled.archived })
      }
    }
    const newestFirst = (list: typeof views) => [...list].sort((a, b) => b.endedAt - a.endedAt)
    const keptSettled = new Set(newestFirst(views.filter((view) => view.normal)).slice(0, settledKeep).map((view) => view.id))
    const keptArchived = new Set(newestFirst(views.filter((view) => view.archived)).slice(0, archivedKeepCount).map((view) => view.id))
    const oldestFirst = (list: typeof views) => [...list].sort((a, b) => a.endedAt - b.endedAt)
    const normal = oldestFirst(views.filter((view) => view.normal && !keptSettled.has(view.id) && now - view.endedAt >= recentMs))
    const archived = oldestFirst(views.filter((view) => view.archived && !keptArchived.has(view.id) && now - view.endedAt >= Math.max(recentMs, archivedKeepMs)))
    const deletable = [...normal, ...archived].reduce((sum, view) => sum + view.bytes, 0)
    const warn = options.log ?? ((line: string) => console.warn(line))
    if (total - deletable > maxBytes) {
      warn(`[subagent] sessions and records total ${mb(total)} (plus ${mb(scan.untracked)} without a record), over the ${mb(maxBytes)} limit; deleting every eligible record would only free ${mb(deletable)}, so nothing was removed. The rest are running, unhandled, kept, recent or among the latest ${settledKeep} handled records`)
    } else {
      log(`[subagent] sessions and records total ${mb(total)}, over the ${mb(maxBytes)} limit; deleting the oldest finished and handled records (${mb(scan.untracked)} without a record is not counted)`)
      for (const view of [...normal, ...archived]) {
        if (total <= maxBytes) break
        if (guarded(view.id)) continue
        outputsFreed += await removeRecord(dir, view.id, view.record, entries)
        total -= view.bytes
        freed += view.bytes
        capped.push(view.id)
      }
    }
  }
  removed.push(...capped)
  if (removed.length) invalidateSubagentStorageUsage()
  if (removed.length) log(`[subagent] removed ${removed.length} subagent records (${removed.length - capped.length} by retention, ${capped.length} by size limit), freed ${mb(freed)} of sessions and records and ${mb(outputsFreed)} of saved outputs; ${mb(total)} left`)
  return removed
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
  if (removed.length) invalidateSubagentStorageUsage()
  if (total + inUse > maxBytes) console.warn(`[subagent] saved outputs still exceed the ${maxBytes} byte limit after pruning: ${inUse} bytes are in use and ${total} bytes are other folders kept by the retention rules; stopped without removing in-use folders`)
  return { removed, bytes: total, inUse }
}
