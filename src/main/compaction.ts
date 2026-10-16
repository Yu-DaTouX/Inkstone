import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { autoCompactAt } from '../shared/context-limits'
import type { CompactionInfo, CompactionReason, CompactionRun, CompactionStatus } from '../shared/ipc'

const DEFAULTS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }

interface PartialCompaction {
  enabled?: unknown
  reserveTokens?: unknown
  keepRecentTokens?: unknown
}

function pick(v: unknown, base: typeof DEFAULTS): typeof DEFAULTS {
  const o = (v && typeof v === 'object' ? v : {}) as PartialCompaction
  const num = (x: unknown, d: number): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : d
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    reserveTokens: num(o.reserveTokens, base.reserveTokens),
    keepRecentTokens: num(o.keepRecentTokens, base.keepRecentTokens)
  }
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

export function projectTrustedFrom(trustRaw: unknown, cwd: string): boolean {
  if (!trustRaw || typeof trustRaw !== 'object' || Array.isArray(trustRaw)) return false
  const table = trustRaw as Record<string, unknown>
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  let cur = norm(cwd)
  for (;;) {
    for (const [key, value] of Object.entries(table)) {
      if (norm(key) === cur) return value === true
    }
    const idx = cur.lastIndexOf('/')
    if (idx <= 0) return false
    cur = cur.slice(0, idx)
  }
}

export async function compactionInfo(cwd: string, contextWindow: number, inkstoneCap?: number): Promise<CompactionInfo> {
  const userFile = join(PI_AGENT_DIR, 'settings.json')
  const projFile = join(cwd, '.pi', 'settings.json')
  const trustFile = join(PI_AGENT_DIR, 'trust.json')

  const [userRaw, projRaw, trustRaw] = await Promise.all([
    readJson(userFile),
    readJson(projFile),
    readJson(trustFile)
  ])
  const fromUser = pick((userRaw as { compaction?: unknown })?.compaction, DEFAULTS)

  const projCompaction = (projRaw as { compaction?: unknown } | null)?.compaction
  const hasProjCompaction =
    !!projCompaction && typeof projCompaction === 'object' && Object.keys(projCompaction).length > 0
  const trusted = hasProjCompaction ? projectTrustedFrom(trustRaw, cwd) : false
  const honored = hasProjCompaction && trusted

  const effective = honored ? pick(projCompaction, fromUser) : fromUser

  const win = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.round(contextWindow) : 0
  const native = Math.max(0, win - effective.reserveTokens)
  const capped = inkstoneCap && effective.enabled ? autoCompactAt(inkstoneCap, win) : undefined
  const byInkstone = capped !== undefined && capped < native
  const threshold = byInkstone ? capped : native

  const info: CompactionInfo = {
    enabled: effective.enabled,
    reserveTokens: effective.reserveTokens,
    keepRecentTokens: effective.keepRecentTokens,
    contextWindow: win,
    threshold,
    custom: JSON.stringify(effective) !== JSON.stringify(DEFAULTS),
    scope: honored ? 'project' : 'global',
    ...(byInkstone ? { cappedByInkstone: true } : {})
  }
  if (hasProjCompaction && !trusted) info.projectIgnored = true
  return info
}

export interface CompactionState {
  running: CompactionRun | null
  last: CompactionRun | null
}

export const EMPTY_COMPACTION_STATE: CompactionState = { running: null, last: null }

const REASONS: readonly string[] = ['manual', 'threshold', 'overflow']

function readReason(evt: Record<string, unknown>): {
  reason?: CompactionReason
  reasonRaw?: string
} {
  const raw = typeof evt.reason === 'string' ? evt.reason.trim() : ''
  if (!raw) return {}
  return REASONS.includes(raw)
    ? { reason: raw as CompactionReason }
    : { reasonRaw: raw }
}

function readError(evt: Record<string, unknown>): string | undefined {
  const direct = evt.errorMessage
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const err = evt.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string' && m.trim()) return m.trim()
  }
  return undefined
}

function readTokens(evt: Record<string, unknown>): { beforeTokens?: number; afterTokens?: number } {
  const r = evt.result
  if (!r || typeof r !== 'object') return {}
  const o = r as { tokensBefore?: unknown; estimatedTokensAfter?: unknown }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
  const before = num(o.tokensBefore)
  const after = num(o.estimatedTokensAfter)
  return { ...(before !== undefined ? { beforeTokens: before } : {}), ...(after !== undefined ? { afterTokens: after } : {}) }
}

export function compactionStatusOf(evt: Record<string, unknown>): CompactionStatus {
  const s = typeof evt.status === 'string' ? evt.status : ''
  if (s === 'completed' || s === 'declined' || s === 'failed') return s
  if (evt.aborted === true) return 'cancelled'
  if (evt.result) return 'completed'
  return 'failed'
}

export function reduceCompaction(
  state: CompactionState,
  evt: Record<string, unknown>,
  now: number = Date.now()
): CompactionState | null {
  const type = String(evt.type ?? '')

  if (type === 'compaction_start') {
    const startedAt = evt.startedAt ?? evt.endedAt
    return {
      ...state,
      running: {
        status: 'running',
        ...readReason(evt),
        startedAt: typeof startedAt === 'number' ? startedAt : now
      }
    }
  }

  if (type !== 'compaction_end') return null

  const status = compactionStatusOf(evt)
  const fromEnd = readReason(evt)
  const reason = fromEnd.reason ?? state.running?.reason
  const reasonRaw = fromEnd.reasonRaw ?? (fromEnd.reason ? undefined : state.running?.reasonRaw)
  const endedAt = typeof evt.endedAt === 'number' ? evt.endedAt : now
  const error = readError(evt)

  const run: CompactionRun = {
    status,
    ...(reason ? { reason } : {}),
    ...(reasonRaw ? { reasonRaw } : {}),
    ...(state.running?.startedAt !== undefined ? { startedAt: state.running.startedAt } : {}),
    ...(state.running?.triggeredBy ? { triggeredBy: state.running.triggeredBy } : {}),
    ...(state.running?.policyStage ? { policyStage: state.running.policyStage } : {}),
    endedAt,
    ...(error ? { error } : {}),
    ...(typeof evt.entryId === 'string' && evt.entryId ? { entryId: evt.entryId } : {}),
    ...readTokens(evt)
  }
  return { running: null, last: run }
}

export function clearStaleRunning(
  state: CompactionState,
  isCompacting: boolean
): CompactionState {
  if (isCompacting || state.running === null) return state
  return { ...state, running: null }
}
