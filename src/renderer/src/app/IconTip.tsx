import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipHint, TooltipTrigger } from '../ui'

export function IconTip({
  label,
  shortcut,
  detail,
  children
}: {
  label: ReactNode
  shortcut?: ReactNode
  detail?: ReactNode
  children: ReactElement
}): ReactElement {
  return (
    <TooltipTrigger>
      {children}
      <Tooltip>
        {shortcut == null && detail == null ? label : <TooltipHint label={label} shortcut={shortcut} detail={detail} />}
      </Tooltip>
    </TooltipTrigger>
  )
}
