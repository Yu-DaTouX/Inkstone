export const REPEAT_BLOCK_SIGNATURE = 'repeat-tool-call'

export const REPEAT_GUARD_DIR = 'repeat-guard'

export const REPEAT_WARN_AT = 3
export const REPEAT_BLOCK_AT = 5

const MAX_PENDING_FAILURES = 10

export function repeatGuardKey(sessionKey: unknown): string {
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : ''
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
}

export interface RepeatGuardSnapshot {
  blocks: number
  tool: string | null
  updatedAt: number | null
}

export function parseRepeatGuardSnapshot(raw: unknown): RepeatGuardSnapshot {
  const empty: RepeatGuardSnapshot = { blocks: 0, tool: null, updatedAt: null }
  if (!raw || typeof raw !== 'object') return empty
  const source = raw as Record<string, unknown>
  const blocks = Number(source.blocks)
  return {
    blocks: Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0,
    tool: typeof source.tool === 'string' && source.tool.trim() ? source.tool.trim() : null,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : null
  }
}

export function pendingRepeatFailures(counted: number, blocks: number): number {
  const already = Number.isFinite(counted) && counted > 0 ? Math.floor(counted) : 0
  const wanted = Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0
  return Math.max(0, Math.min(wanted - already, MAX_PENDING_FAILURES))
}
