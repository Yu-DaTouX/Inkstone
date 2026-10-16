import type { Key, SortDirection } from 'react-aria-components'

export interface TableSortDescriptor {
  column: Key
  direction: SortDirection
}

export interface TableWindowInput {
  rowCount: number
  rowHeight: number
  viewportHeight: number
  scrollTop?: number
  overscan?: number
}

export interface TableWindow {
  startIndex: number
  endIndex: number
  offsetY: number
  totalHeight: number
  renderedCount: number
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

export function computeTableWindow(input: TableWindowInput): TableWindow {
  const rowCount = Math.max(0, Math.floor(input.rowCount))
  const rowHeight = Math.max(1, input.rowHeight)
  const overscan = Math.max(0, Math.floor(input.overscan ?? 0))
  if (rowCount === 0) {
    return { startIndex: 0, endIndex: -1, offsetY: 0, totalHeight: 0, renderedCount: 0 }
  }
  const viewportHeight = Math.max(0, input.viewportHeight)
  const scrollTop = Math.max(0, input.scrollTop ?? 0)
  const firstVisible = Math.min(rowCount - 1, Math.floor(scrollTop / rowHeight))
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  const startIndex = Math.max(0, firstVisible - overscan)
  const endIndex = Math.min(rowCount - 1, firstVisible + visibleCount - 1 + overscan)
  return {
    startIndex,
    endIndex,
    offsetY: startIndex * rowHeight,
    totalHeight: rowCount * rowHeight,
    renderedCount: endIndex - startIndex + 1
  }
}
