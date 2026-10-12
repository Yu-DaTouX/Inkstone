export function sparklinePoints(values: number[], width = 96, height = 28): string[] {
  if (!values.length) return []
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1
  return values.map((value, index) => {
    const xRatio = values.length === 1 ? 0.5 : index / (values.length - 1)
    return `${xRatio * (width - 4) + 2},${height - 3 - ((value - lo) / span) * (height - 6)}`
  })
}
