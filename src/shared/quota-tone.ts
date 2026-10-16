export type QuotaTone = 'ok' | 'warn' | 'err'

export const QUOTA_WARN_PCT = 70
export const QUOTA_ERR_PCT = 95

export function quotaTone(usedPct: number, exceeded = false): QuotaTone {
  if (exceeded) return 'err'
  if (!Number.isFinite(usedPct)) return 'ok'
  if (usedPct >= QUOTA_ERR_PCT) return 'err'
  return usedPct >= QUOTA_WARN_PCT ? 'warn' : 'ok'
}
