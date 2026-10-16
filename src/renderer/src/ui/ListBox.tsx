import {
  ListBox as RACListBox,
  ListBoxItem as RACListBoxItem,
  ListBoxSection as RACListBoxSection,
  composeRenderProps,
  type ListBoxItemProps as RACListBoxItemProps,
  type ListBoxProps as RACListBoxProps,
  type ListBoxSectionProps as RACListBoxSectionProps
} from 'react-aria-components'
import { cx } from './cx'

export type ListBoxProps<T extends object = object> = RACListBoxProps<T>
export type ListBoxItemProps<T extends object = object> = RACListBoxItemProps<T>
export type ListBoxSectionProps<T extends object = object> = RACListBoxSectionProps<T>

/**
 * 列表选择框。`selectionMode` / `selectedKeys` / `onSelectionChange` 与 RAC 一致；
 * 放进 `Select`、`ComboBox` 或 `Popover` 使用。键盘漫游焦点由 RAC 提供。
 */
export function ListBox<T extends object = object>({ className, ...props }: ListBoxProps<T>) {
  return <RACListBox {...props} className={composeRenderProps(className, (cn) => cx('ui-listbox', cn))} />
}

/** 列表项。`textValue` 提供给类型查找与读屏；动态集合时由 `items` 自动带上。 */
export function ListBoxItem<T extends object = object>({ className, ...props }: ListBoxItemProps<T>) {
  return <RACListBoxItem {...props} className={composeRenderProps(className, (cn) => cx('ui-listbox__item', cn))} />
}

/** 分组；组标题用 RAC 的 `Header`（已从 `ui/index.ts` 转出）。 */
export function ListBoxSection<T extends object = object>({ className, ...props }: ListBoxSectionProps<T>) {
  return <RACListBoxSection {...props} className={cx('ui-listbox__section', className)} />
}
