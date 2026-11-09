import { forwardRef, type HTMLAttributes } from 'react'
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

export interface StaticListBoxProps extends HTMLAttributes<HTMLDivElement> {
  'aria-label': string
}

export const StaticListBox = forwardRef<HTMLDivElement, StaticListBoxProps>(function StaticListBox({ className, ...props }, ref) {
  return <div {...props} ref={ref} role="listbox" className={cx('ui-listbox', 'ui-listbox--static', className)} />
})

export interface StaticListBoxItemProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean
  selected?: boolean
  disabled?: boolean
}

export const StaticListBoxItem = forwardRef<HTMLDivElement, StaticListBoxItemProps>(function StaticListBoxItem(
  { active, selected, disabled, className, ...props },
  ref
) {
  return (
    <div
      {...props}
      ref={ref}
      role="option"
      aria-selected={selected ?? false}
      aria-disabled={disabled || undefined}
      data-focused={active ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cx('ui-listbox__item', className)}
    />
  )
})
