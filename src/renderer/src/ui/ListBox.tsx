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

export function ListBox<T extends object = object>({ className, ...props }: ListBoxProps<T>) {
  return <RACListBox {...props} className={composeRenderProps(className, (cn) => cx('ui-listbox', cn))} />
}

export function ListBoxItem<T extends object = object>({ className, ...props }: ListBoxItemProps<T>) {
  return <RACListBoxItem {...props} className={composeRenderProps(className, (cn) => cx('ui-listbox__item', cn))} />
}

export function ListBoxSection<T extends object = object>({ className, ...props }: ListBoxSectionProps<T>) {
  return <RACListBoxSection {...props} className={cx('ui-listbox__section', className)} />
}
