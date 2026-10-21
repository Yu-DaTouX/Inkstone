import type { Key, SortDirection } from 'react-aria-components'

export interface TableSortDescriptor {
  column: Key
  direction: SortDirection
}

export function compareTableValues(a: unknown, b: unknown): number {
  const aEmpty = a == null || a === ''
  const bEmpty = b == null || b === ''
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const left = String(a)
  const right = String(b)
  return left === right ? 0 : left < right ? -1 : 1
}

export function sortRows<T>(
  rows: readonly T[],
  descriptor: TableSortDescriptor,
  getSortValue?: (row: T, column: Key) => unknown
): T[] {
  const getValue = getSortValue ?? ((row: T, column: Key) => (row as Record<Key, unknown>)[column])
  const decorated = rows.map((row, index) => ({ row, index }))
  decorated.sort((left, right) => {
    const compared = compareTableValues(getValue(left.row, descriptor.column), getValue(right.row, descriptor.column))
    if (compared !== 0) return descriptor.direction === 'descending' ? -compared : compared
    return left.index - right.index
  })
  return decorated.map((entry) => entry.row)
}
