import type { JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { compactionRunningText } from '../../state/compaction-view'
import { useRunProgress } from './run-status'

export function LiveRunNotice(): JSX.Element | null {
  const t = useT()
  const progress = useRunProgress()
  const compaction = useStore((s) => s.session?.compaction)
  const compacting = useStore((s) => !!s.session?.isCompacting) || progress?.phase === 'compacting'
  const retry = useStore((s) => s.session?.retry)
  const abortRetry = useStore((s) => s.abortRetry)
  if (!retry && !compacting) return null
  const retryLeft = retry ? Math.ceil(Math.max(0, retry.at + retry.delayMs - Date.now()) / 1000) : 0
  const text = retry
    ? retryLeft > 0
      ? t('chat.retryWaiting', { n: retry.attempt, m: retry.maxAttempts, s: retryLeft })
      : t('chat.retryRunning', { n: retry.attempt, m: retry.maxAttempts })
    : compactionRunningText(t, compaction)
  return (
    <div className="v3-act" data-kind={retry ? 'retry' : 'run'} data-testid="v3-turn-activity">
      <span className="v3-act-text" role="status" aria-live="polite" title={retry?.error}>{text}</span>
      {progress ? <span className="v3-act-time">{formatDuration(progress.elapsedMs)}</span> : null}
      {retry ? (
        <Button size="sm" variant="ghost" onPress={() => void abortRetry()} data-testid="v3-stop-retry">
          {t('chat.stopRetry')}
        </Button>
      ) : null}
    </div>
  )
}

export function PendingRunNotice(): JSX.Element | null {
  const special = useStore((s) => !!s.session?.retry || !!s.session?.isCompacting)
  if (!special) return null
  return (
    <div className="v3-msg assistant" data-testid="v3-pending">
      <LiveRunNotice />
    </div>
  )
}
