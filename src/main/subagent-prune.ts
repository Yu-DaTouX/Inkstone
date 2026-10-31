import { existsSync } from 'node:fs'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { normalizeSubagentId } from '../shared/subagent-id'
import { cleanupWorkspace } from './subagent-isolation'
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
  if (basename(record.cwd) !== 'worktree' || !basename(dirname(record.cwd)).startsWith('yan-subagent-')) return
  if (!existsSync(record.cwd)) return
  await cleanupWorkspace({
    isolation: 'worktree',
    rootCwd: record.rootCwd,
    cwd: record.cwd,
    repoRoot: record.rootCwd,
    worktreePath: record.cwd,
    containerPath: dirname(record.cwd)
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
      rm(join(dir, 'sessions', id), { recursive: true, force: true }),
      rm(join(dir, 'approvals', id), { recursive: true, force: true })
    ].map((task) => task.catch(() => undefined)))
  }
  return doomed
}
