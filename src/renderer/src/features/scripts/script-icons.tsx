import { FlaskConical, Hammer, Play, ScanLine, Server } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ProjectScriptIcon } from '../../../../shared/project-scripts'
import type { MessageKey } from '../../i18n'

export const SCRIPT_ICON_LABEL: Record<ProjectScriptIcon, MessageKey> = {
  play: 'script.icon.play',
  test: 'script.icon.test',
  build: 'script.icon.build',
  lint: 'script.icon.lint',
  server: 'script.icon.server'
}

export function scriptIconGlyph(icon: ProjectScriptIcon | undefined, size = 14): ReactNode {
  switch (icon) {
    case 'test':
      return <FlaskConical size={size} strokeWidth={1.75} />
    case 'build':
      return <Hammer size={size} strokeWidth={1.75} />
    case 'lint':
      return <ScanLine size={size} strokeWidth={1.75} />
    case 'server':
      return <Server size={size} strokeWidth={1.75} />
    default:
      return <Play size={size} strokeWidth={1.75} />
  }
}
