import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import { projectMonogram, projectTone } from './sidebar-model'

export function ProjectBadge({ label, global }: { label: string; global?: boolean }): JSX.Element {
  if (global) {
    return (
      <span className="v3-pbadge" data-tone="global" aria-hidden>
        <Globe size={10} />
      </span>
    )
  }
  return (
    <span className="v3-pbadge" data-tone={projectTone(label)} aria-hidden>
      {projectMonogram(label)}
    </span>
  )
}
