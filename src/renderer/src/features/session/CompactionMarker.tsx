import type { JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { compactionRunningText, compactionSummary, compactionTokensText, compactionTone } from '../../state/compaction-view'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { compactionLineModel } from './turn-lines'

const TONE = { ok: 'ok', warn: 'ask', err: 'fail' } as const

export function CompactionMarker(): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const running = useStore((s) => s.session?.compaction)
  const last = useStore((s) => s.session?.lastCompaction)
  const model = compactionLineModel(running, last)
  if (!model) return null
  const tokens = compactionTokensText(model.run)
  return (
    <div
      className="v3-compaction"
      data-tone={TONE[compactionTone(model.run)]}
      data-running={model.running ? '1' : '0'}
      data-testid="v3-compaction-marker"
    >
      <Icon name="layers" size={13} />
      {model.running ? null : <span className="v3-compaction-title">{tt('compactionTitle')}</span>}
      <span className="v3-compaction-text">{model.running ? compactionRunningText(t, model.run) : compactionSummary(t, model.run)}</span>
      {tokens ? <span className="v3-compaction-tokens">{tokens}</span> : null}
      {!model.running && model.run.status === 'failed' && model.run.error ? (
        <span className="v3-compaction-error" title={model.run.error} data-testid="v3-compaction-error" role="alert">{model.run.error}</span>
      ) : null}
    </div>
  )
}

export function CompactCommandEcho(): JSX.Element | null {
  const running = useStore((s) => s.session?.compaction)
  const last = useStore((s) => s.session?.lastCompaction)
  const command = useStore((s) => s.compactCommand?.sessionId === s.session?.sessionId ? s.compactCommand?.text : undefined)
  const model = compactionLineModel(running, last)
  if (model?.run.reason !== 'manual') return null
  return (
    <div className="v3-msg user" data-testid="v3-compact-command">
      <div className="v3-user-body">
        <div className="v3-bubble">{command ?? '/compact'}</div>
      </div>
    </div>
  )
}
