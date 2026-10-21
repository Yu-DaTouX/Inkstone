export function compactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`
  return Math.round(n).toLocaleString()
}

export function shareText(share: number): string {
  return share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%'
}
