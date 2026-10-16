import { useEffect, useState, type JSX } from 'react'
import type { RunSnapshot } from '../../../../shared/runs'
import { useI18n } from '../../i18n'
import { Button } from '../../ui'
import { Icon } from './Icon'
import { railText, stallReason } from './rail-text'
import { sameViewPath, type SessionViewIdentity } from './view-state'
import './rail.css'

export function currentStalledRun(
  runs: readonly RunSnapshot[],
  view: SessionViewIdentity,
  viewActive: boolean
): RunSnapshot | null {
  if (!viewActive) return null
  let found: RunSnapshot | null = null
  for (const run of runs) {
    if (run.phase.kind !== 'stalled') continue
    const matched =
      (!!view.sessionId && run.sessionId === view.sessionId) ||
      (!!view.sessionFile && !!run.sessionPath && sameViewPath(run.sessionPath, view.sessionFile))
    if (!matched) continue
    if (!found || run.startedAt > found.startedAt) found = run
  }
  return found
}

export interface StalledCardProps {
  run: RunSnapshot | null
  onStop: () => void
}

export function StalledCard({ run, onStop }: StalledCardProps): JSX.Element | null {
  const { lang } = useI18n()
  const text = railText(lang)
  const [now, setNow] = useState(() => Date.now())
  const stalled = !!run && run.phase.kind === 'stalled'

  useEffect(() => {
    if (!stalled) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [stalled, run?.runId, run?.phase.kind])

  if (!run || run.phase.kind !== 'stalled') return null
  const reason = stallReason(lang, run.phase, now)
  if (!reason) return null

  return (
    <div className="v3-stall" data-testid="v3-stall" role="status" aria-live="polite">
      <div className="v3-stall-head">
        <Icon name="warn" size={16} />
        <span className="v3-stall-title">{text.stalledTitle}</span>
        <span className="v3-stall-word">{reason.word}</span>
        <span className="v3-stall-timing">{reason.timing}</span>
      </div>
      {reason.detail ? <p className="v3-stall-detail">{reason.detail}</p> : null}
      <p className="v3-stall-note">{text.autoNote}</p>
      <div className="v3-stall-foot">
        <Button variant="danger" size="sm" onPress={onStop}>
          {text.stop}
        </Button>
      </div>
    </div>
  )
}
