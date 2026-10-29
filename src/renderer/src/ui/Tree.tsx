import type { ComponentProps, ComponentPropsWithoutRef, ReactNode } from 'react'
import {
  Button as RACButton,
  Tree as RACTree,
  TreeItem as RACTreeItem,
  TreeItemContent as RACTreeItemContent,
  TreeHeader as RACTreeHeader,
  TreeSection as RACTreeSection,
  composeRenderProps,
  type ButtonProps as RACButtonProps,
  type TreeItemContentProps as RACTreeItemContentProps,
  type TreeItemProps as RACTreeItemProps,
  type TreeProps as RACTreeProps
} from 'react-aria-components'
import { ChevronRight } from 'lucide-react'
import { cx } from './cx'
import { CHEVRON_ICON_SIZE } from './sizes'

export type TreeProps<T extends object = object> = RACTreeProps<T>
export type TreeItemProps<T extends object = object> = RACTreeItemProps<T>
export type TreeSectionProps = ComponentProps<typeof RACTreeSection>
export type TreeHeaderProps = ComponentProps<typeof RACTreeHeader>
export type TreeItemContentProps = RACTreeItemContentProps

export { RACTreeItemContent as TreeItemContent }

export function Tree<T extends object = object>({ className, ...props }: TreeProps<T>) {
  return <RACTree {...props} className={composeRenderProps(className, (cn) => cx('ui-tree', cn))} />
}

export function TreeItem<T extends object = object>({ className, ...props }: TreeItemProps<T>) {
  return <RACTreeItem {...props} className={composeRenderProps(className, (cn) => cx('ui-tree__item', cn))} />
}

export function TreeSection({ className, ...props }: TreeSectionProps) {
  return <RACTreeSection {...props} className={cx('ui-tree__section', className)} />
}

export function TreeHeader({ className, ...props }: TreeHeaderProps) {
  return <RACTreeHeader {...props} className={cx('ui-tree__header', className)} />
}

export interface TreeChevronProps extends Omit<RACButtonProps, 'slot'> {
  children?: ReactNode
}

export function TreeChevron({ className, children, ...props }: TreeChevronProps) {
  return (
    <RACButton
      {...props}
      slot="chevron"
      className={composeRenderProps(className, (cn) => cx('ui-tree__chevron', cn))}
    >
      {composeRenderProps(children, (kids) => kids ?? <ChevronRight size={CHEVRON_ICON_SIZE} aria-hidden="true" />)}
    </RACButton>
  )
}

export type TreeItemLabelProps = ComponentPropsWithoutRef<'span'>

export function TreeItemLabel({ className, ...props }: TreeItemLabelProps) {
  return <span {...props} className={cx('ui-tree__label', className)} />
}

export type TreeEmptyStateProps = ComponentPropsWithoutRef<'div'>

export function TreeEmptyState({ className, ...props }: TreeEmptyStateProps) {
  return <div {...props} className={cx('ui-tree__empty', className)} />
}
