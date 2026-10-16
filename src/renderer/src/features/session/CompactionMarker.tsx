/**
 * 压缩标记行（WP-21c）。
 *
 * 复用 `state/compaction-view.ts` 的既有投影：进行中的压缩说原因，最近一次
 * 已结束的压缩说「起因 · 结局」，两端 token 都拿到时才写「150k → 32k」。
 * 从磁盘打开的历史会话没有这条记录，此时不写「未发生过」—— 只是不显示。
 */
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
