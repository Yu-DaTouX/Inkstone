import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import { Badge } from '../../ui'
import { projectMonogram, projectTone } from './sidebar-model'

export function ProjectBadge({ label, global }: { label: string; global?: boolean }): JSX.Element {
  return (
    <span className="v3-pbadge" data-tone={global ? 'global' : projectTone(label)} aria-hidden="true">
      <Badge className="v3-pbadge-mark">{global ? <Globe size={10} /> : projectMonogram(label)}</Badge>
    </span>
  )
}
