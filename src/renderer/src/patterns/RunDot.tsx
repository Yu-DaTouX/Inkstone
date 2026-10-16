import type { ReactElement } from 'react'
import type { RunPhase } from '../../../shared/runs'
import { useI18n } from '../i18n'
import { phaseWord, runTone } from '../state/runs-v3'
import './run-status.css'

export interface RunDotProps {
  phase: RunPhase | null
  unread?: boolean
  code?: string
}

export function RunDot({ phase, unread = false, code }: RunDotProps): ReactElement {
  const { lang } = useI18n()
  if (!phase) {
    return <span className="run-dot" data-kind="none" aria-hidden="true" />
  }
  const tone = runTone(phase)
  const word = phaseWord(lang, phase)
  const label = code ? `${code} · ${word}` : word
  const showUnread = unread && (phase.kind === 'done' || phase.kind === 'failed')
  return (
    <span
      className="run-dot"
      data-kind={phase.kind}
      data-tone={tone}
      data-unread={showUnread ? '1' : '0'}
      role="img"
      aria-label={label}
      title={label}
    />
  )
}
