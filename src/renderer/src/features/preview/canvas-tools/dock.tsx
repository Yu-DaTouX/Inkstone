import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { IconButton } from '../../../ui'
import type { PreviewText } from '../preview-text'
import './dock.css'

export function DockToggle({
  labels,
  expanded,
  onToggle
}: {
  labels: PreviewText
  expanded: boolean
  onToggle: () => void
}): ReactElement {
  const label = expanded ? labels.canvasDockCollapse : labels.canvasDockExpand
  return (
    <IconButton
      size="sm"
      variant="ghost"
      className="v3-canvas-dock-toggle"
      aria-label={label}
      tooltip={label}
      aria-expanded={expanded}
      data-testid="v3-canvas-dock-toggle"
      onPress={onToggle}
    >
      {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
    </IconButton>
  )
}
