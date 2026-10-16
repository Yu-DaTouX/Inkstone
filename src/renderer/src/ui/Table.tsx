/**
 * Table 原语：在 RAC `Table` 之上只做外观封装，并把可选的真实窗口化接上
 * RAC `Virtualizer` + `TableLayout`。
 *
 * 控件层不接管业务数据：排序描述符、受控选中与行禁用都直接透传 RAC；
 * `sortRows`（见 `./table-model`）只提供调用方需要的数据排序纯函数，
 * 不在这里保存第二套表格状态。
 */
import {
  Cell as RACCell,
  Column as RACColumn,
  Row as RACRow,
  Table as RACTable,
  TableBody as RACTableBody,
  TableFooter as RACTableFooter,
  TableHeader as RACTableHeader,
  TableLayout,
  Virtualizer,
  composeRenderProps,
  type CellProps as RACCellProps,
  type ColumnProps as RACColumnProps,
  type RowProps as RACRowProps,
  type TableBodyProps as RACTableBodyProps,
  type TableFooterProps as RACTableFooterProps,
  type TableHeaderProps as RACTableHeaderProps,
  type TableLayoutProps,
  type TableProps as RACTableProps,
  type VirtualizerProps
} from 'react-aria-components'
import type { ReactNode } from 'react'
import { Spinner } from './Progress'
import { cx } from './cx'
import './Table.css'

export interface TableProps extends RACTableProps {
  /**
   * 开启真实窗口化：只把可见行放进 DOM，并由 RAC 输出 `aria-rowcount` /
   * `aria-rowindex`。需要给表格（或其容器）一个受控高度才能滚动。
   */
  isVirtualized?: boolean
  /** 虚拟化布局实现；默认 RAC `TableLayout`。自定义实现主要用于确定性测试。 */
  layout?: VirtualizerProps<TableLayoutProps>['layout']
  /** 虚拟化布局参数：行高、列宽、padding 等。 */
  layoutOptions?: TableLayoutProps
}

/**
 * 表格。排序用受控的 `sortDescriptor` + `onSortChange`（配合 `Column` 的
 * `allowsSorting`），选中用 `selectionMode` / `selectedKeys` /
 * `onSelectionChange`，行禁用用 `disabledKeys` 或 `Row` 的 `isDisabled`。
 */
export function Table({ isVirtualized, layout, layoutOptions, className, children, ...props }: TableProps) {
  const table = (
    <RACTable {...props} className={composeRenderProps(className, (cn) => cx('ui-table', cn))}>
      {children}
    </RACTable>
  )
  if (!isVirtualized) return table
  const resolvedLayout = layout ?? (TableLayout as unknown as VirtualizerProps<TableLayoutProps>['layout'])
  return (
    <Virtualizer layout={resolvedLayout} layoutOptions={layoutOptions}>
      {table}
    </Virtualizer>
  )
}

export type TableHeaderProps<T> = RACTableHeaderProps<T>

/** 表头分组。列由 `Column` 组成。 */
export function TableHeader<T>({ className, ...props }: RACTableHeaderProps<T>) {
  return <RACTableHeader {...props} className={composeRenderProps(className, (cn) => cx('ui-table__header', cn))} />
}

export type ColumnProps = RACColumnProps

/** 列头。`allowsSorting` 打开排序；`isRowHeader` 标出读屏用于指示当前行的主列。 */
export function Column({ className, ...props }: RACColumnProps) {
  return <RACColumn {...props} className={composeRenderProps(className, (cn) => cx('ui-table__column', cn))} />
}

export interface TableBodyProps<T> extends RACTableBodyProps<T> {
  /** 加载中：没有行时显示加载态；配合 `loadingState` 覆盖默认内容。 */
  isLoading?: boolean
  loadingState?: ReactNode
}

/** 表体。`renderEmptyState` 自定义空态；`isLoading` 时用加载态占位。 */
export function TableBody<T>({
  className,
  isLoading,
  loadingState,
  renderEmptyState,
  ...props
}: TableBodyProps<T>) {
  const empty =
    renderEmptyState ?? (isLoading ? () => (loadingState ?? <TableLoadingState />) : undefined)
  return (
    <RACTableBody
      {...props}
      renderEmptyState={empty}
      className={composeRenderProps(className, (cn) => cx('ui-table__body', cn))}
    />
  )
}

export type RowProps<T> = RACRowProps<T>

/** 数据行。`id` 是稳定行 key；`isDisabled` 禁用整行。 */
export function Row<T>({ className, ...props }: RACRowProps<T>) {
  return <RACRow {...props} className={composeRenderProps(className, (cn) => cx('ui-table__row', cn))} />
}

export type CellProps = RACCellProps

/** 单元格。 */
export function Cell({ className, ...props }: RACCellProps) {
  return <RACCell {...props} className={composeRenderProps(className, (cn) => cx('ui-table__cell', cn))} />
}

export type TableFooterProps<T> = RACTableFooterProps<T>

/** 表尾分组。 */
export function TableFooter<T>({ className, ...props }: RACTableFooterProps<T>) {
  return <RACTableFooter {...props} className={cx('ui-table__footer', className)} />
}

export interface TableEmptyStateProps {
  children?: ReactNode
  className?: string
}

/** 空态内容，放进 `TableBody` 的 `renderEmptyState`。 */
export function TableEmptyState({ children, className }: TableEmptyStateProps) {
  return <div className={cx('ui-table__empty', className)}>{children ?? '暂无数据'}</div>
}

export interface TableLoadingStateProps {
  children?: ReactNode
  className?: string
}

/** 加载态内容；`role="status"` 让读屏播报，`aria-busy` 标出正在加载。 */
export function TableLoadingState({ children, className }: TableLoadingStateProps) {
  return (
    <div className={cx('ui-table__loading', className)} role="status" aria-live="polite" aria-busy="true">
      <Spinner size={16} />
      <span>{children ?? '正在加载…'}</span>
    </div>
  )
}
