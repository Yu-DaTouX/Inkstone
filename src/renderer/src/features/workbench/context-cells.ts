import type { ContextSlice } from '../../state/context-breakdown'

export const CELL_COLUMNS = 36
export const CELL_ROWS = 6
export const CELL_COUNT = CELL_COLUMNS * CELL_ROWS

export type CellKind = ContextSlice['id'] | 'free'

export function contextCells(slices: readonly Pick<ContextSlice, 'id' | 'tokens'>[], windowSize: number, count = CELL_COUNT): CellKind[] {
  if (windowSize <= 0 || count <= 0) return []
  const used = slices.filter((slice) => slice.tokens > 0)
  const exact = used.map((slice) => (slice.tokens / windowSize) * count)
  const counts = exact.map((value) => Math.max(1, Math.floor(value)))
  const usedTotal = Math.min(count, Math.max(used.length, Math.round(exact.reduce((sum, value) => sum + value, 0))))
  let assigned = counts.reduce((sum, value) => sum + value, 0)
  const byRemainder = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
  for (let i = 0; assigned < usedTotal && byRemainder.length; i = (i + 1) % byRemainder.length) {
    counts[byRemainder[i].index] += 1
    assigned += 1
  }
  const byLargest = counts.map((value, index) => ({ index, value })).sort((a, b) => b.value - a.value)
  for (let i = 0; assigned > usedTotal && byLargest.length; i = (i + 1) % byLargest.length) {
    const target = byLargest[i]
    if (counts[target.index] > 1) {
      counts[target.index] -= 1
      assigned -= 1
    } else if (byLargest.every((item) => counts[item.index] <= 1)) break
  }
  const cells: CellKind[] = []
  used.forEach((slice, index) => {
    for (let n = 0; n < counts[index] && cells.length < count; n += 1) cells.push(slice.id)
  })
  while (cells.length < count) cells.push('free')
  return cells
}
