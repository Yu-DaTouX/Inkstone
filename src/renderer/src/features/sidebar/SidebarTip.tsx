import type { ComponentProps, ReactElement } from 'react'
import { Focusable } from 'react-aria-components'
import { Tooltip, TooltipTrigger } from '../../ui'

export interface SidebarTipProps {
  label: string
  detail?: string
  placement?: 'right' | 'bottom start'
  isDisabled?: boolean
  children: ComponentProps<typeof Focusable>['children']
}

export function SidebarTip({ label, detail, placement = 'bottom start', isDisabled, children }: SidebarTipProps): ReactElement {
  return (
    <TooltipTrigger delay={500} isDisabled={isDisabled}>
      <Focusable>{children}</Focusable>
      <Tooltip placement={placement} offset={4}>
        <span className="v3-tip-label">{label}</span>
        {detail ? <span className="v3-tip-detail">{detail}</span> : null}
      </Tooltip>
    </TooltipTrigger>
  )
}
