import { forwardRef } from 'react'
import {
  Tooltip as RACTooltip,
  TooltipTrigger,
  composeRenderProps,
  type TooltipProps as RACTooltipProps
} from 'react-aria-components'
import { cx } from './cx'

export { TooltipTrigger }
export type { TooltipProps, TooltipTriggerComponentProps } from 'react-aria-components'

/**
 * 提示气泡。放在 `TooltipTrigger` 内使用；不支持也不应支持焦点，
 * 这是纯说明，不是可交互浮层。
 *
 * ```tsx
 * <TooltipTrigger delay={500}>
 *   <IconButton aria-label="收起侧栏">…</IconButton>
 *   <Tooltip>收起侧栏 Ctrl+B</Tooltip>
 * </TooltipTrigger>
 * ```
 *
 * 设计约定：延迟 500ms，悬停与键盘聚焦都会出现。
 */
export const Tooltip = forwardRef<HTMLDivElement, RACTooltipProps>(function Tooltip({ className, ...props }, ref) {
  return (
    <RACTooltip
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-tooltip', cn))}
    />
  )
})
