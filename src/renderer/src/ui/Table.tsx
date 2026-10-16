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
  isVirtualized?: boolean
  layout?: VirtualizerProps<TableLayoutProps>['layout']
  layoutOptions?: TableLayoutProps
}

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

export function TableHeader<T>({ className, ...props }: RACTableHeaderProps<T>) {
  return <RACTableHeader {...props} className={composeRenderProps(className, (cn) => cx('ui-table__header', cn))} />
}

export type ColumnProps = RACColumnProps

export function Column({ className, ...props }: RACColumnProps) {
  return <RACColumn {...props} className={composeRenderProps(className, (cn) => cx('ui-table__column', cn))} />
}

export interface TableBodyProps<T> extends RACTableBodyProps<T> {
  isLoading?: boolean
  loadingState?: ReactNode
}

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

export function Row<T>({ className, ...props }: RACRowProps<T>) {
  return <RACRow {...props} className={composeRenderProps(className, (cn) => cx('ui-table__row', cn))} />
}

export type CellProps = RACCellProps

export function Cell({ className, ...props }: RACCellProps) {
  return <RACCell {...props} className={composeRenderProps(className, (cn) => cx('ui-table__cell', cn))} />
}

export type TableFooterProps<T> = RACTableFooterProps<T>

export function TableFooter<T>({ className, ...props }: RACTableFooterProps<T>) {
  return <RACTableFooter {...props} className={cx('ui-table__footer', className)} />
}

export interface TableEmptyStateProps {
  children?: ReactNode
  className?: string
}

export function TableEmptyState({ children, className }: TableEmptyStateProps) {
  return <div className={cx('ui-table__empty', className)}>{children ?? '暂无数据'}</div>
}

export interface TableLoadingStateProps {
  children?: ReactNode
  className?: string
}

export function TableLoadingState({ children, className }: TableLoadingStateProps) {
  return (
    <div className={cx('ui-table__loading', className)} role="status" aria-live="polite" aria-busy="true">
      <Spinner size={16} />
      <span>{children ?? '正在加载…'}</span>
    </div>
  )
}
