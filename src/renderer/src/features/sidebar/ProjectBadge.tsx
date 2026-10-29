import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import { Badge, type BadgeTone } from '../../ui'
import { projectMonogram, projectTone } from './sidebar-model'

export function ProjectBadge({ label, global, toneKey }: { label: string; global?: boolean; toneKey?: string }): JSX.Element {
  const tone: BadgeTone = global ? 'data-8' : (`data-${projectTone(toneKey || label)}` as BadgeTone)
  return (
    <Badge tone={tone} shape="square" aria-hidden="true">
      {global ? <Globe aria-hidden="true" /> : projectMonogram(label)}
    </Badge>
  )
}
