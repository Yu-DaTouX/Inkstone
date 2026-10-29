import type { ComponentProps, ReactElement } from 'react'
import { Focusable } from 'react-aria-components'
import { Tooltip, TooltipTrigger } from '../../ui'

export interface SidebarTipProps {
  label: string
  detail?: string
  placement?: 'right' | 'bottom start'
  card?: boolean
  isDisabled?: boolean
  children: ComponentProps<typeof Focusable>['children']
}

export function SidebarTip({ label, detail, placement = 'bottom start', card, isDisabled, children }: SidebarTipProps): ReactElement {
  return (
    <TooltipTrigger delay={card ? 150 : 500} {...(card ? { closeDelay: 0 } : {})} isDisabled={isDisabled}>
      <Focusable>{children}</Focusable>
      <Tooltip placement={placement} offset={card ? 8 : 4} variant={card ? 'card' : 'default'} className={card ? 'v3-tip-card' : undefined}>
        <span className="v3-tip-label">{label}</span>
        {detail ? <span className="v3-tip-detail">{detail}</span> : null}
      </Tooltip>
    </TooltipTrigger>
  )
}
