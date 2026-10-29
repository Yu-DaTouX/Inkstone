import { createContext, forwardRef, useContext, type ReactNode } from 'react'
import {
  ToggleButton as RACToggleButton,
  ToggleButtonGroup as RACToggleButtonGroup,
  composeRenderProps,
  type ToggleButtonGroupProps as RACToggleButtonGroupProps,
  type ToggleButtonProps as RACToggleButtonProps,
  type TooltipProps as RACTooltipProps
} from 'react-aria-components'
import { cx } from './cx'
import { Tooltip, TooltipHint, TooltipTrigger } from './Tooltip'

export type ToggleSize = 'micro' | 'xs' | 'sm' | 'md'
export type ToggleVariant = 'ghost' | 'outline'

const ToggleGroupStyle = createContext<{ size?: ToggleSize; variant?: ToggleVariant }>({})

export interface ToggleProps extends RACToggleButtonProps {
  size?: ToggleSize
  variant?: ToggleVariant
  icon?: boolean
  tooltip?: ReactNode
  tooltipShortcut?: ReactNode
  tooltipPlacement?: RACTooltipProps['placement']
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { size: sizeProp, variant: variantProp, icon, tooltip, tooltipShortcut, tooltipPlacement, className, ...props },
  ref
) {
  const group = useContext(ToggleGroupStyle)
  const size = sizeProp ?? group.size ?? 'sm'
  const variant = variantProp ?? group.variant ?? 'ghost'
  const button = (
    <RACToggleButton
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) =>
        cx('ui-toggle', `ui-toggle--${size}`, `ui-toggle--${variant}`, icon && 'ui-toggle--icon', cn)
      )}
    />
  )
  if (tooltip == null || tooltip === false) return button
  return (
    <TooltipTrigger>
      {button}
      <Tooltip placement={tooltipPlacement}>
        <TooltipHint label={tooltip} shortcut={tooltipShortcut} />
      </Tooltip>
    </TooltipTrigger>
  )
})

export interface ToggleGroupProps extends RACToggleButtonGroupProps {
  size?: ToggleSize
  variant?: ToggleVariant | 'segmented'
}

export const ToggleGroup = forwardRef<HTMLDivElement, ToggleGroupProps>(function ToggleGroup(
  { size, variant = 'ghost', className, children, ...props },
  ref
) {
  const itemVariant: ToggleVariant = variant === 'outline' ? 'outline' : 'ghost'
  return (
    <RACToggleButtonGroup
      {...props}
      ref={ref}
      data-variant={variant}
      className={composeRenderProps(className, (cn) => cx('ui-toggle-group', `ui-toggle-group--${variant}`, cn))}
    >
      {composeRenderProps(children, (kids) => (
        <ToggleGroupStyle.Provider value={{ size, variant: itemVariant }}>{kids}</ToggleGroupStyle.Provider>
      ))}
    </RACToggleButtonGroup>
  )
})
