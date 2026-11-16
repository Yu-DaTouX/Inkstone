export function spreadLabels(positions: readonly number[], gap: number, min: number, max: number): number[] {
  const order = positions.map((value, index) => ({ value: Math.min(max, Math.max(min, value)), index })).sort((a, b) => a.value - b.value || a.index - b.index)
  const placed = order.map((item) => item.value)
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + gap)
  const overflow = placed.length ? placed[placed.length - 1] - max : 0
  if (overflow > 0) {
    placed[placed.length - 1] -= overflow
    for (let i = placed.length - 2; i >= 0; i--) placed[i] = Math.min(placed[i], placed[i + 1] - gap)
  }
  const out = new Array<number>(positions.length)
  order.forEach((item, i) => {
    out[item.index] = placed[i]
  })
  return out
}
