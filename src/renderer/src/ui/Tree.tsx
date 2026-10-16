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

/**
 * 树原语（WP-05）。层级、展开、选择、禁用、键盘漫游与 `aria-level` 全部交给
 * React Aria Components 的 `Tree` / `TreeItem`，本文件只加类名与行内容的两个小组件；
 * 外观在 `./Tree.css` 的 `@layer primitives` 里。
 *
 * 常用组合（行内容放在 `TreeItemContent` 的渲染函数里，嵌套 `TreeItem` 是它的兄弟节点）：
 *
 * ```tsx
 * <Tree aria-label="文件" selectionMode="single" defaultExpandedKeys={['src']}>
 *   <TreeItem id="src" textValue="src">
 *     <TreeItemContent>
 *       <TreeChevron />
 *       <TreeItemLabel>src</TreeItemLabel>
 *     </TreeItemContent>
 *     <TreeItem id="src/index.ts" textValue="index.ts">
 *       <TreeItemContent>
 *         <TreeChevron />
 *         <TreeItemLabel>index.ts</TreeItemLabel>
 *       </TreeItemContent>
 *     </TreeItem>
 *   </TreeItem>
 * </Tree>
 * ```
 *
 * 叶子行的 `TreeChevron` 会被 CSS 隐藏但仍占位，标签因而天然对齐；也可以按
 * 渲染函数的 `hasChildItems` 决定是否渲染。`textValue` 必需（类型查找与读屏）。
 */

export type TreeProps<T extends object = object> = RACTreeProps<T>
export type TreeItemProps<T extends object = object> = RACTreeItemProps<T>
/* RAC 公开了 `TreeSection` / `TreeHeader` 组件，但未公开它们的 props 类型，故从组件上取。 */
export type TreeSectionProps = ComponentProps<typeof RACTreeSection>
export type TreeHeaderProps = ComponentProps<typeof RACTreeHeader>
export type TreeItemContentProps = RACTreeItemContentProps

/** 行内容渲染函数直通 RAC：`children` 可读 `isExpanded` / `hasChildItems` / `level` / `isSelected` 等。 */
export { RACTreeItemContent as TreeItemContent }

/** 树容器。`selectionMode` / `selectedKeys` / `onSelectionChange` / `expandedKeys` 等与 RAC 一致。 */
export function Tree<T extends object = object>({ className, ...props }: TreeProps<T>) {
  return <RACTree {...props} className={composeRenderProps(className, (cn) => cx('ui-tree', cn))} />
}

/** 树行。`id` / `textValue` / `isDisabled` / `onAction` 与 RAC 一致；嵌套 `TreeItem` 是子节点。 */
export function TreeItem<T extends object = object>({ className, ...props }: TreeItemProps<T>) {
  return <RACTreeItem {...props} className={composeRenderProps(className, (cn) => cx('ui-tree__item', cn))} />
}

/** 分组容器；组标题用 `TreeHeader`。 */
export function TreeSection({ className, ...props }: TreeSectionProps) {
  return <RACTreeSection {...props} className={cx('ui-tree__section', className)} />
}

/** 分组标题。 */
export function TreeHeader({ className, ...props }: TreeHeaderProps) {
  return <RACTreeHeader {...props} className={cx('ui-tree__header', className)} />
}

export interface TreeChevronProps extends Omit<RACButtonProps, 'slot'> {
  /** 自定义图标；缺省为 `ChevronRight`，展开时由 CSS 旋转 90°。 */
  children?: ReactNode
}

/**
 * 展开 / 收起按钮。RAC 通过 `slot="chevron"` 注入本地化的 `aria-label`、`onPress`
 * 并把它排除出 Tab 顺序（左右方向键负责展开收起）；叶子行由 `.ui-tree__item:not([data-has-child-items])`
 * 隐藏但仍占位。
 */
export function TreeChevron({ className, children, ...props }: TreeChevronProps) {
  return (
    <RACButton
      {...props}
      slot="chevron"
      className={composeRenderProps(className, (cn) => cx('ui-tree__chevron', cn))}
    >
      {composeRenderProps(children, (kids) => kids ?? <ChevronRight size={14} aria-hidden="true" />)}
    </RACButton>
  )
}

export type TreeItemLabelProps = ComponentPropsWithoutRef<'span'>

/** 行主文字。超长时单行省略；把完整名称交给 `title` 或外层 Tooltip。 */
export function TreeItemLabel({ className, ...props }: TreeItemLabelProps) {
  return <span {...props} className={cx('ui-tree__label', className)} />
}

export type TreeEmptyStateProps = ComponentPropsWithoutRef<'div'>

/** 空态内容，放进 `Tree` 的 `renderEmptyState`。 */
export function TreeEmptyState({ className, ...props }: TreeEmptyStateProps) {
  return <div {...props} className={cx('ui-tree__empty', className)} />
}
