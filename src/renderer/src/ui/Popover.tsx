import { forwardRef } from 'react'
import { Popover as RACPopover, composeRenderProps, type PopoverProps as RACPopoverProps } from 'react-aria-components'
import { cx } from './cx'

export type PopoverProps = RACPopoverProps

/**
 * 浮层容器（无样式外壳，样式来自 `ui.css` 的 `.ui-popover`）。
 *
 * 直接 re-export 并统一类名，使用方式与 RAC 一致：放进 `MenuTrigger` /
 * `DialogTrigger` / `Select` / `ComboBox` 内，或配合 `triggerRef` 单独使用。
 * 焦点圈定、Esc 关闭、关闭后焦点归还由包裹它的触发器负责。
 */
export const Popover = forwardRef<HTMLElement, PopoverProps>(function Popover({ className, ...props }, ref) {
  return (
    <RACPopover
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-popover', cn))}
    />
  )
})
