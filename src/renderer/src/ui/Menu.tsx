import {
  Menu as RACMenu,
  MenuItem as RACMenuItem,
  MenuSection as RACMenuSection,
  composeRenderProps,
  type MenuItemProps as RACMenuItemProps,
  type MenuProps as RACMenuProps,
  type MenuSectionProps as RACMenuSectionProps
} from 'react-aria-components'
import { cx } from './cx'

export { MenuTrigger, SubmenuTrigger } from 'react-aria-components'
export type { MenuTriggerProps, SubmenuTriggerProps } from 'react-aria-components'

export type MenuProps<T extends object = object> = RACMenuProps<T>

export function Menu<T extends object = object>({ className, ...props }: MenuProps<T>) {
  return <RACMenu {...props} className={composeRenderProps(className, (cn) => cx('ui-menu', cn))} />
}

export type MenuItemProps<T extends object = object> = RACMenuItemProps<T>

export function MenuItem<T extends object = object>({ className, ...props }: MenuItemProps<T>) {
  return <RACMenuItem {...props} className={composeRenderProps(className, (cn) => cx('ui-menu__item', cn))} />
}

export type MenuSectionProps<T extends object = object> = RACMenuSectionProps<T>

export function MenuSection<T extends object = object>({ className, ...props }: MenuSectionProps<T>) {
  return <RACMenuSection {...props} className={cx('ui-menu__section', className)} />
}
