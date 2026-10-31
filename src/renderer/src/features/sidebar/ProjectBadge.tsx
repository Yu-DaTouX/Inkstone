import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import { Badge, type BadgeTone } from '../../ui'
import { useProjectIconLook } from '../../patterns/project-icon'

export function ProjectBadge({ label, global, toneKey, projectId }: { label: string; global?: boolean; toneKey?: string; projectId?: string }): JSX.Element {
  const look = useProjectIconLook(projectId ?? toneKey, label)
  const tone: BadgeTone = global ? 'data-8' : (`data-${look.tone}` as BadgeTone)
  return (
    <Badge tone={tone} shape="square" aria-hidden="true">
      {global ? <Globe aria-hidden="true" /> : look.text}
    </Badge>
  )
}
