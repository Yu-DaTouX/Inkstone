export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

export function costText(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return ''
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(cost < 10 ? 2 : 1)}`
}

export function contextRatio(context: { percent: number | null; tokens: number | null; window: number } | undefined): number | null {
  if (!context) return null
  if (typeof context.percent === 'number') return Math.min(1, Math.max(0, context.percent / 100))
  if (typeof context.tokens === 'number' && context.window > 0) return Math.min(1, context.tokens / context.window)
  return null
}
