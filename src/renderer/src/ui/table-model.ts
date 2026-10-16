/**
 * Table 原语的纯模型：稳定排序与虚拟窗口边界。
 *
 * 这里只放与 React 无关的计算，方便在没有浏览器的环境里验证边界。
 * 运行时的真实窗口化由 RAC `Virtualizer` / `TableLayout` 承担；本文件里的
 * 窗口函数是同一套窗口契约的纯参考，不复制 RAC 的布局算法。
 */
import type { Key, SortDirection } from 'react-aria-components'

export interface TableSortDescriptor {
  /** 排序列的 key，对应 `Column` 的 `id`。 */
  column: Key
  direction: SortDirection
}

export interface TableWindowInput {
  rowCount: number
  /** 固定行高（px）。 */
  rowHeight: number
  /** 视口高度（px）。 */
  viewportHeight: number
  /** 当前滚动位置（px），默认 0。 */
  scrollTop?: number
  /** 视口上下各多渲染几行，默认 0。 */
  overscan?: number
}

export interface TableWindow {
  /** 窗口首行下标（闭区间）。空表为 0。 */
  startIndex: number
  /** 窗口末行下标（闭区间）。空表为 -1。 */
  endIndex: number
  /** 首行相对内容顶端的偏移（px）。 */
  offsetY: number
  /** 内容总高度（px）。 */
  totalHeight: number
  /** 窗口渲染的行数。 */
  renderedCount: number
}

/**
 * 单元格值的默认比较：空值（`null` / `undefined` / `''`）排在后面；
 * 数字按数值，其余按字符串码位。降序由 `sortRows` 取反，所以空值在降序里排前。
 */
export function compareTableValues(a: unknown, b: unknown): number {
  const aEmpty = a == null || a === ''
  const bEmpty = b == null || b === ''
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const left = String(a)
  const right = String(b)
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * 稳定排序：`compare` 相等时保持原数组顺序。
 *
 * RAC 只维护 `sortDescriptor` 状态，不会替调用方排序数据（`useTableState`
 * 只记录当前排序列），所以调用方用这个纯函数把 `items` 排成受控顺序。
 */
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
    // 同值时用原始下标兜底，保证任何引擎下都稳定。
    return left.index - right.index
  })
  return decorated.map((entry) => entry.row)
}

/**
 * 计算固定行高列表的可见窗口。滚动越界、负滚动、空表都被夹到合法范围；
 * `viewportHeight` 为 0 时仍渲染至少一行（有行可渲染时）。
 */
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
