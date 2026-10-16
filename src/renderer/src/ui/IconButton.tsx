import { forwardRef, type ReactNode } from 'react'
import { composeRenderProps } from 'react-aria-components'
import { cx } from './cx'
import { Button, type ButtonProps, type ButtonSize } from './Button'

export interface IconButtonProps
  extends Omit<ButtonProps, 'variant' | 'children' | 'icon' | 'trailingIcon' | 'block' | 'size'> {
  /** 必填：图标按钮没有可读文字，读屏靠这个名称。 */
  'aria-label': string
  variant?: 'ghost' | 'secondary' | 'danger'
  size?: ButtonSize
  children: ReactNode
}

/**
 * 纯图标按钮。`aria-label` 在类型层面必填，避免出现读屏无法识别的按钮。
 *
 * 实现复用 `Button`，因此 `title` / `isPending` / `isDisabled` 的行为一致；
 * 宽度与内边距由 `.ui-icon-btn` 覆盖。
 *
 * 需要「悬停出现」的工具条按钮时，仍要保证键盘聚焦时同样出现
 * （用 `data-focus-visible` 或 `:focus-within` 触发，不要只靠 `:hover`）。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className, children, ...props },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant={variant}
      size={size}
      className={composeRenderProps(className, (cn) => cx('ui-icon-btn', cn))}
    >
      {children}
    </Button>
  )
})
