import { forwardRef, useCallback, type ReactNode } from 'react'
import {
  Button as RACButton,
  composeRenderProps,
  type ButtonProps as RACButtonProps
} from 'react-aria-components'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends RACButtonProps {
  /** `primary` 是墨色主按钮，用于「发送 / 允许」这类唯一主动作。 */
  variant?: ButtonVariant
  size?: ButtonSize
  /** 前置图标（lucide 组件或任意节点）；装饰性，自动 `aria-hidden`。 */
  icon?: ReactNode
  /** 后置图标，例如「打开 ›」。 */
  trailingIcon?: ReactNode
  /** 占满一行。 */
  block?: boolean
  /**
   * 原生 `title` 提示。RAC 的 DOM 过滤会丢掉 `title`，所以这里单独接住，
   * 挂载后写到真实节点上（不改变 RAC 的属性转发规则）。
   */
  title?: string
}

/**
 * 按钮原语。交互状态（`onPress` / `isDisabled` / `isPending` / 键盘焦点）
 * 交给 React Aria Components；外观只在 `ui.css` 的 `@layer primitives` 里。
 *
 * - 默认 `type="button"`：RAC 已处理，表单里不会意外提交。
 * - `isPending` 保留可聚焦、禁用按压，并显示转圈（CSS `[data-pending]`）。
 * - 只做图标时请改用 `IconButton`（强制 `aria-label`）。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, block, title, className, children, ...props },
  ref
) {
  const attachRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: HTMLButtonElement | null }).current = node
      if (node) node.title = title ?? ''
    },
    [ref, title]
  )

  return (
    <RACButton
      {...props}
      ref={attachRef}
      className={composeRenderProps(className, (cn) =>
        cx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', block && 'ui-btn--block', cn)
      )}
    >
      {composeRenderProps(children, (kids) => (
        <>
          {icon != null ? (
            <span className="ui-btn__icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          {kids != null ? <span className="ui-btn__label">{kids}</span> : null}
          {trailingIcon != null ? (
            <span className="ui-btn__icon" aria-hidden="true">
              {trailingIcon}
            </span>
          ) : null}
        </>
      ))}
    </RACButton>
  )
})
