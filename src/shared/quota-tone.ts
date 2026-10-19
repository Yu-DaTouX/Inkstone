export type QuotaTone = 'ok' | 'ask' | 'fail'

export const QUOTA_WARN_PCT = 70
export const QUOTA_ERR_PCT = 95

export function quotaTone(usedPct: number, exceeded = false): QuotaTone {
  if (exceeded) return 'fail'
  if (!Number.isFinite(usedPct)) return 'ok'
  if (usedPct >= QUOTA_ERR_PCT) return 'fail'
  return usedPct >= QUOTA_WARN_PCT ? 'ask' : 'ok'
}
