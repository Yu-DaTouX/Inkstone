import type { JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { compactionRunningText, compactionSummary, compactionTokensText, compactionTone } from '../../state/compaction-view'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { compactionLineModel } from './turn-lines'

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
      data-tone={compactionTone(model.run)}
      data-running={model.running ? '1' : '0'}
      data-testid="v3-compaction-marker"
    >
      <Icon name="layers" size={13} />
      {model.running ? null : <span className="v3-compaction-title">{tt('compactionTitle')}</span>}
      <span className="v3-compaction-text">{model.running ? compactionRunningText(t, model.run) : compactionSummary(t, model.run)}</span>
      {tokens ? <span className="v3-compaction-tokens">{tokens}</span> : null}
    </div>
  )
}
