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

// 触发器直接来自 RAC：`MenuTrigger`（含 `trigger="contextMenu"` 右键菜单）
// 与 `SubmenuTrigger`，语义已经完整，这里不重复包装。
export { MenuTrigger, SubmenuTrigger } from 'react-aria-components'
export type { MenuTriggerProps, SubmenuTriggerProps } from 'react-aria-components'

export type MenuProps<T extends object = object> = RACMenuProps<T>

/** 菜单容器。默认放进 `Popover` 里由 `MenuTrigger` 打开。 */
export function Menu<T extends object = object>({ className, ...props }: MenuProps<T>) {
  return <RACMenu {...props} className={composeRenderProps(className, (cn) => cx('ui-menu', cn))} />
}

export type MenuItemProps<T extends object = object> = RACMenuItemProps<T>

/**
 * 菜单项。`onAction` 在选中时触发；`href` 会渲染成链接。
 * 点击后是否关闭由外层 `Menu` 的 `shouldCloseOnSelect` 决定（默认关闭）。
 */
export function MenuItem<T extends object = object>({ className, ...props }: MenuItemProps<T>) {
  return <RACMenuItem {...props} className={composeRenderProps(className, (cn) => cx('ui-menu__item', cn))} />
}

export type MenuSectionProps<T extends object = object> = RACMenuSectionProps<T>

/** 分组；组标题用 RAC 的 `Header`（已从 `ui/index.ts` 转出）。 */
export function MenuSection<T extends object = object>({ className, ...props }: MenuSectionProps<T>) {
  return <RACMenuSection {...props} className={cx('ui-menu__section', className)} />
}
