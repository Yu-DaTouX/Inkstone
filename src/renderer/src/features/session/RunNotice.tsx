import type { JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, ShimmerText, StatusDot, TermSpinner } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { compactionRunningText } from '../../state/compaction-view'
import { useSessionText } from './text'
import { useWorkingLine } from './run-status'
import type { WorkingKind } from './working-line-model'

const ACT_KIND: Record<WorkingKind, string> = {
  stopping: 'stop',
  waiting: 'retry',
  retrying: 'retry',
  compacting: 'run',
  tool: 'run',
  thinking: 'run',
  thought: 'run',
  responding: 'run',
  working: 'run',
  sending: 'run'
}

const SHIMMER: ReadonlySet<WorkingKind> = new Set<WorkingKind>(['compacting', 'tool', 'thinking', 'responding', 'working', 'sending', 'stopping'])

export function LiveRunNotice({ hasProcess = false }: { hasProcess?: boolean }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const line = useWorkingLine()
  const compaction = useStore((s) => s.session?.compaction)
  const abortRetry = useStore((s) => s.abortRetry)
  if (!line) return null
  if (line.kind === 'compacting' && compaction?.status === 'running') return null
  if (line.kind === 'working' && hasProcess) return null
  const text = line.textKey ? tt(line.textKey, line.vars) : compactionRunningText(t, compaction)
  return (
    <div
      className="v3-act"
      data-kind={ACT_KIND[line.kind]}
      data-working={line.kind}
      data-quiet={line.quiet || undefined}
      data-testid="v3-turn-activity"
    >
      {line.kind === 'waiting' ? <StatusDot kind="awaiting" /> : <TermSpinner data-testid="v3-act-spin" />}
      <span className="v3-act-text" role="status" aria-live="polite" title={line.error}>
        <ShimmerText active={!line.quiet && SHIMMER.has(line.kind)}>{text}</ShimmerText>
      </span>
      {line.elapsedMs !== null ? <span className="v3-act-time" data-testid="v3-working-elapsed">{formatDuration(line.elapsedMs)}</span> : null}
      {line.kind === 'retrying' && line.error ? <span className="v3-act-time" data-testid="v3-retry-reason">{line.error}</span> : null}
      {line.kind === 'retrying' ? (
        <Button size="sm" variant="ghost" onPress={() => void abortRetry()} data-testid="v3-stop-retry">
          {t('chat.stopRetry')}
        </Button>
      ) : null}
    </div>
  )
}

export function PendingRunNotice(): JSX.Element | null {
  return (
    <div className="v3-msg assistant" data-testid="v3-pending">
      <LiveRunNotice />
    </div>
  )
}
