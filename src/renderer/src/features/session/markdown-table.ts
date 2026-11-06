const MIN_UNITS = 5
const MAX_UNITS = 36
const SHIFT_LIMIT = 6

export function textUnits(text: string): number {
  let units = 0
  for (const char of text) units += (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1
  return units
}

export function estimateColumnShares(rows: readonly (readonly string[])[]): number[] {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (!columns) return []
  const units = Array.from({ length: columns }, (_, column) => {
    const widest = rows.reduce((max, row) => Math.max(max, textUnits(row[column] ?? '')), 0)
    return Math.min(MAX_UNITS, Math.max(MIN_UNITS, widest + 2))
  })
  const total = units.reduce((sum, value) => sum + value, 0)
  return units.map((value) => (value / total) * 100)
}

export function sharesShifted(previous: readonly number[] | null, next: readonly number[]): boolean {
  if (!previous || previous.length !== next.length) return true
  return next.some((value, index) => Math.abs(value - previous[index]) >= SHIFT_LIMIT)
}
