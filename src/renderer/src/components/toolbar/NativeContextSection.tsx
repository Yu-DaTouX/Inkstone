import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Section } from './ToolSection'
import { Button, MiniMeter, RunDot, Switch } from '../ui'
import type { CompactionInfo } from '../../../../shared/ipc'
import { compactionRunningText, compactionSummary } from '../../state/compaction-view'

/** Display the agent's reported pressure; the UI does not choose a budget or compact automatically. */
export function NativeContextSection() {
  const t = useT()
  const session = useStore(s => s.session)
  const stats = useStore(s => s.stats)
  const compact = useStore(s => s.compact)
  const setAutoCompaction = useStore(s => s.setAutoCompaction)
  const usage = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const matches = !!usage && (!usage.modelKey || usage.modelKey === modelKey)
  const windowSize = session?.model?.contextWindow ?? (matches ? usage?.contextWindow : undefined) ?? 0
  const known = matches && typeof usage?.tokens === 'number' && windowSize > 0
  const tokens = known ? usage.tokens! : 0
  const percent = known ? (tokens / windowSize) * 100 : null
  const tone = percent !== null && percent >= 95 ? 'err' : percent !== null && percent >= 85 ? 'warn' : 'ok'
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const [info, setInfo] = useState<CompactionInfo | null>(null)
  useEffect(() => {
    let current = true
    setInfo(null)
    if (windowSize > 0) void window.yan.compactionInfo(windowSize).then(value => { if (current) setInfo(value) }).catch(() => undefined)
    return () => { current = false }
  }, [windowSize, session?.sessionId, session?.autoCompactionEnabled])
  const number = (n: number) => new Intl.NumberFormat().format(n)
  return (
    <Section titleKey="rp.context" testId="rp-context" defaultOpen compactWhenFloating extra={
      <span className="rp-header-usage">
        {session?.isCompacting ? <><RunDot /><span data-testid="ctx-compacting-reason">{compactionRunningText(t, session.compaction)}</span></> : <>
          <span className="rp-header-values">{known ? `${Math.round(percent!)}%` : t('ctx.usageUnknown')}</span>
          <MiniMeter percent={percent} tone={known ? tone : ''} />
        </>}
      </span>
    }>
      <div className="rp-dim" data-testid="ctx-native-owner">{t('ctx.nativeOwner')}</div>
      <div className="rp-ctx-main" data-testid="ctx-main" data-mode="window">
        <span className={`rp-v big ${known ? tone : ''}`}>{known ? `${Math.round(percent!)}%` : '—'}</span>
        <span className="spacer" />
        <span className="rp-u" data-testid="ctx-tokens">{known ? `${number(tokens)} / ${number(windowSize)}` : '—'}</span>
      </div>
      {matches && usage?.tokens === null ? <div className="rp-dim" data-testid="ctx-unknown">{t('ctx.afterCompact')}</div> : null}
      {info ? <div className="rp-dim" data-testid="ctx-native-threshold">{t('ctx.thresholdTip', { n: number(info.threshold) })}</div> : null}
      {session?.lastCompaction ? <div className="rp-dim" data-testid="ctx-last-compaction">{compactionSummary(t, session.lastCompaction)}</div> : null}
      <div className="rp-kv rp-ctx-actions" data-testid="rp-context-actions">
        <span className="rp-u">{t('ctx.autoCompact')}</span>
        <Switch label={t('ctx.autoCompact')} checked={session?.autoCompactionEnabled === true} disabled={!session?.sessionId || session.autoCompactionEnabled === undefined} testId="rp-auto-compact" onChange={on => void setAutoCompaction(on)} />
        <Button size="sm" icon="compact" data-testid="rp-compact-now" disabled={!session?.sessionId || busy} onClick={() => void compact()}>{t('status.compact')}</Button>
      </div>
    </Section>
  )
}
