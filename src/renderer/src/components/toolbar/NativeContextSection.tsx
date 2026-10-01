import { useMemo } from 'react'
import { useT } from '../../i18n'
import { contextBreakdown, type ContextCategory } from '../../state/context-breakdown'
import { useStore } from '../../state/store'
import { Section } from './ToolSection'
import { Button, MiniMeter, MiniRing, RunDot, Switch } from '../ui'
import { DetailTrigger } from '../shell/DetailPopover'
import { compactionRunningText, compactionSummary } from '../../state/compaction-view'

/** The agent's reported pressure; the UI does not choose a budget or compact automatically. */
function useContextUsage() {
  const session = useStore(s => s.session)
  const stats = useStore(s => s.stats)
  const usage = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const matches = !!usage && (!usage.modelKey || usage.modelKey === modelKey)
  const windowSize = session?.model?.contextWindow ?? (matches ? usage?.contextWindow : undefined) ?? 0
  const known = matches && typeof usage?.tokens === 'number' && windowSize > 0
  const tokens = known ? usage.tokens! : 0
  const percent = known ? (tokens / windowSize) * 100 : null
  const tone: 'ok' | 'warn' | 'err' = percent !== null && percent >= 95 ? 'err' : percent !== null && percent >= 85 ? 'warn' : 'ok'
  return { session, usage, matches, windowSize, known, tokens, percent, tone }
}

const CATEGORY_LABEL: Record<ContextCategory | 'free', string> = {
  system: '系统提示与工具', user: '用户消息', assistant: '回复', thinking: '思考', tools: '工具调用与结果', free: '剩余空间'
}

/** 383.8k / 1M style figures for the window header and legend. */
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Details shared by the inspector section and the composer popover. */
function ContextDetails() {
  const t = useT()
  const compact = useStore(s => s.compact)
  const setAutoCompaction = useStore(s => s.setAutoCompaction)
  const messages = useStore(s => s.messages)
  const { session, usage, matches, windowSize, known, tokens, percent, tone } = useContextUsage()
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const since = session?.lastCompaction?.status === 'completed' ? session.lastCompaction.startedAt : undefined
  const slices = useMemo(() => known ? contextBreakdown(messages, tokens, since) : [], [known, messages, tokens, since])
  const rows = known ? [...slices.filter(s => s.tokens > 0), { id: 'free' as const, tokens: Math.max(0, windowSize - tokens) }] : []
  const share = (n: number) => windowSize > 0 ? n / windowSize * 100 : 0
  return <>
    <div className="ctx-window-head" data-testid="ctx-main" data-mode="window">
      <span className="ui-popover-title">上下文窗口</span>
      <span className={`ctx-window-total ui-meta-num ${known && tone !== 'ok' ? tone : ''}`} data-testid="ctx-tokens">
        {known ? `${shortTokens(tokens)} / ${shortTokens(windowSize)} (${Math.round(percent!)}%)` : '—'}
      </span>
    </div>
    <div className="ui-usage-bar" role="img" aria-label={known ? `已用 ${Math.round(percent!)}%` : '用量未知'}>
      {slices.map(s => s.tokens > 0 ? <i key={s.id} className={`ui-usage-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} /> : null)}
    </div>
    {rows.length ? <ul className="ui-usage-legend" data-testid="ctx-breakdown">
      {rows.map(r => <li key={r.id} className={r.id === 'free' ? 'free' : undefined}>
        <i className={`ui-usage-swatch c-${r.id}`} aria-hidden />
        <span className="ui-usage-name">{CATEGORY_LABEL[r.id]}</span>
        <span className="ui-usage-num ui-meta-num">{shortTokens(r.tokens)}</span>
        <span className="ui-usage-num ui-meta-num">{`${share(r.tokens).toFixed(1)}%`}</span>
      </li>)}
    </ul> : null}
    {rows.length ? <div className="ctx-window-note">分类按当前消息文本估算，总量来自 Agent</div> : null}
    {matches && usage?.tokens === null ? <div className="rp-dim" data-testid="ctx-unknown">{t('ctx.afterCompact')}</div> : null}
    {session?.lastCompaction ? <div className="rp-dim" data-testid="ctx-last-compaction">{compactionSummary(t, session.lastCompaction)}</div> : null}
    <div className="rp-kv rp-ctx-actions" data-testid="rp-context-actions">
      <span className="rp-u">{t('ctx.autoCompact')}</span>
      <Switch label={t('ctx.autoCompact')} checked={session?.autoCompactionEnabled === true} disabled={!session?.sessionId || session.autoCompactionEnabled === undefined} testId="rp-auto-compact" onChange={on => void setAutoCompaction(on)} />
      <Button size="sm" icon="compact" data-testid="rp-compact-now" disabled={!session?.sessionId || busy} onClick={() => void compact()}>{t('status.compact')}</Button>
    </div>
  </>
}

export function NativeContextSection() {
  const t = useT()
  const { session, known, percent, tone } = useContextUsage()
  return (
    <Section titleKey="rp.context" testId="rp-context" defaultOpen compactWhenFloating extra={
      <span className="rp-header-usage">
        {session?.isCompacting ? <><RunDot /><span data-testid="ctx-compacting-reason">{compactionRunningText(t, session.compaction)}</span></> : <>
          <span className="rp-header-values">{known ? `${Math.round(percent!)}%` : t('ctx.usageUnknown')}</span>
          <MiniMeter percent={percent} tone={known ? tone : ''} />
        </>}
      </span>
    }>
      <ContextDetails />
    </Section>
  )
}

/** Composer entry: a ring with the percentage; the details open above it. */
export function ContextRing() {
  const t = useT()
  const { session, known, percent, tone } = useContextUsage()
  if (!session?.sessionId) return null
  const text = known ? `${Math.round(percent!)}%` : '—'
  return (
    <DetailTrigger
      className="ctx-ring btn ghost sm"
      testId="composer-context"
      label={t('rp.context')}
      title={`${t('rp.context')} ${text}`}
      panel={<ContextDetails />}
    >
      {session.isCompacting ? <RunDot /> : <MiniRing percent={percent} tone={known && tone !== 'ok' ? tone : ''} />}
      <span className="ctx-ring-text ui-meta-num">{text}</span>
    </DetailTrigger>
  )
}
