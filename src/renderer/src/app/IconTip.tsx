import type { ReactElement } from 'react'
import { Tooltip, TooltipTrigger } from '../ui'

export function IconTip({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <TooltipTrigger delay={500}>
      {children}
      <Tooltip>{label}</Tooltip>
    </TooltipTrigger>
  )
}
