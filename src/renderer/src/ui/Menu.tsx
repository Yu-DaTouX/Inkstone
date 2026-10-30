import type { ReactNode } from 'react'
import {
  Keyboard,
  Menu as RACMenu,
  MenuItem as RACMenuItem,
  MenuSection as RACMenuSection,
  Separator as RACSeparator,
  Text,
  composeRenderProps,
  type MenuItemProps as RACMenuItemProps,
  type MenuProps as RACMenuProps,
  type MenuSectionProps as RACMenuSectionProps,
  type SeparatorProps as RACSeparatorProps
} from 'react-aria-components'
import { Check } from 'lucide-react'
import { cx } from './cx'
import { CONTROL_ICON_SIZE } from './sizes'

export { MenuTrigger, SubmenuTrigger } from 'react-aria-components'
export type { MenuTriggerProps, SubmenuTriggerProps } from 'react-aria-components'

export type MenuProps<T extends object = object> = RACMenuProps<T>

export function Menu<T extends object = object>({ className, ...props }: MenuProps<T>) {
  return <RACMenu {...props} className={composeRenderProps(className, (cn) => cx('ui-menu', cn))} />
}

export interface MenuItemProps<T extends object = object> extends RACMenuItemProps<T> {
  icon?: ReactNode
  description?: ReactNode
  shortcut?: ReactNode
  trailingValue?: ReactNode
  checked?: boolean | 'selection'
  tone?: 'default' | 'danger'
  disabledReason?: ReactNode
}

export function MenuItem<T extends object = object>({
  icon,
  description,
  shortcut,
  trailingValue,
  checked,
  tone = 'default',
  disabledReason,
  className,
  children,
  textValue,
  ...props
}: MenuItemProps<T>) {
  const slotted = icon != null || description != null || disabledReason != null || shortcut != null || trailingValue != null || checked !== undefined
  const resolvedTextValue = textValue ?? (typeof children === 'string' ? children : undefined)
  return (
    <RACMenuItem
      {...props}
      textValue={resolvedTextValue}
      data-tone={tone === 'danger' ? 'danger' : undefined}
      className={composeRenderProps(className, (cn) =>
        cx(
          'ui-menu__item',
          slotted && 'ui-menu__item--slotted',
          checked !== undefined && 'ui-menu__item--checkable',
          description != null && 'ui-menu__item--described',
          disabledReason != null && 'ui-menu__item--explained',
          cn
        )
      )}
    >
      {(renderProps) => {
        const kids = typeof children === 'function' ? children(renderProps) : children
        if (!slotted) return kids
        const showCheck = checked !== undefined
        const isChecked = checked === 'selection' ? renderProps.isSelected : checked === true
        const shownDescription = renderProps.isDisabled && disabledReason != null ? disabledReason : description
        return (
          <>
            {showCheck ? (
              <span className="ui-menu__check" aria-hidden="true">
                {isChecked ? <Check size={CONTROL_ICON_SIZE.sm} /> : null}
              </span>
            ) : null}
            {icon != null ? (
              <span className="ui-menu__icon" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <span className="ui-menu__text">
              <Text slot="label" className="ui-menu__label">
                {kids}
              </Text>
              {shownDescription != null ? (
                <Text slot="description" className="ui-menu__desc">
                  {shownDescription}
                </Text>
              ) : null}
            </span>
            {trailingValue != null ? <span className="ui-menu__value">{trailingValue}</span> : null}
            {shortcut != null ? <Keyboard className="ui-menu__shortcut">{shortcut}</Keyboard> : null}
          </>
        )
      }}
    </RACMenuItem>
  )
}

export type MenuSectionProps<T extends object = object> = RACMenuSectionProps<T>

export function MenuSection<T extends object = object>({ className, ...props }: MenuSectionProps<T>) {
  return <RACMenuSection {...props} className={cx('ui-menu__section', className)} />
}

export type MenuSeparatorProps = RACSeparatorProps

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return <RACSeparator {...props} className={cx('ui-menu__separator', className)} />
}
