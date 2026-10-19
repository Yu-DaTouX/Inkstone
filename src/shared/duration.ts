export function formatDuration(ms: number, options: { minSeconds?: number } = {}): string {
  const min = Math.max(0, Math.floor(options.minSeconds ?? 0))
  const raw = Number.isFinite(ms) ? ms : 0
  const seconds = Math.max(min, Math.round(raw / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatShortDuration(ms: number): string {
  const raw = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (raw < 999.5) return `${Math.round(raw)}ms`
  return formatDuration(raw)
}
