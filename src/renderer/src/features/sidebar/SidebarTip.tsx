import type { ComponentProps, ReactElement } from 'react'
import { Focusable } from 'react-aria-components'
import { Tooltip, TooltipTrigger } from '../../ui'

export interface SidebarTipProps {
  label: string
  detail?: string
  children: ComponentProps<typeof Focusable>['children']
}

export function SidebarTip({ label, detail, children }: SidebarTipProps): ReactElement {
  return (
    <TooltipTrigger delay={500}>
      <Focusable>{children}</Focusable>
      <Tooltip placement="bottom start" offset={4}>
        <span className="v3-tip-label">{label}</span>
        {detail ? <span className="v3-tip-detail">{detail}</span> : null}
      </Tooltip>
    </TooltipTrigger>
  )
}
