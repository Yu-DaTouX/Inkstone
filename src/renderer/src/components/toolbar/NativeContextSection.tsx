import { useEffect, useMemo, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { contextBreakdown, type ContextCategory } from '../../state/context-breakdown'
import { useStore } from '../../state/store'
import { Section } from './ToolSection'
import { Button, MiniMeter, MiniRing, RunDot, Switch } from '../ui'
import { DetailTrigger } from '../shell/DetailPopover'
import type { ContextInspectSnapshot } from '../../../../shared/context-inspect'
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

const CATEGORY_LABEL: Record<ContextCategory | 'free', MessageKey> = {
  system: 'ctx.cat.system', user: 'ctx.cat.user', assistant: 'ctx.cat.assistant', thinking: 'ctx.cat.thinking', tools: 'ctx.cat.tools', free: 'ctx.cat.free'
}

/** 383.8k / 1M style figures for the window header and legend. */
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

const SECTION_LABEL: Record<string, MessageKey> = {
  preamble: 'ctx.sec.preamble', tools: 'ctx.sec.tools', rules: 'ctx.sec.rules', docs: 'ctx.sec.docs', skills: 'ctx.sec.skills',
  'project-context': 'ctx.sec.projectContext', cwd: 'ctx.sec.cwd', appended: 'ctx.sec.appended', additions: 'ctx.sec.additions', between: 'ctx.sec.between'
}

/** Fixed parts pi already assembled: system prompt sections and tool definitions (estimated, read-only). */
function ContextInspect({ tokens }: { tokens: number }) {
  const t = useT()
  const [snap, setSnap] = useState<ContextInspectSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void window.yan.contextInspect().then(s => { if (alive) setSnap(s) }).catch(() => {})
    return () => { alive = false }
  }, [tokens])
  if (!snap || (!snap.sections.length && !snap.tools.length)) return null
  const active = snap.tools.filter(x => x.active).sort((a, b) => b.tokens - a.tokens)
  const shown = active.slice(0, 8)
  return <details className="ctx-inspect" data-testid="ctx-inspect">
    <summary title={t('ctx.fixedHint', { prompt: shortTokens(snap.promptTokens), tools: shortTokens(snap.toolTokens) })}>{t('ctx.fixed')}<span className="ui-meta-num">{shortTokens(snap.promptTokens + snap.toolTokens)}</span></summary>
    <ul className="ctx-inspect-list">
      {snap.sections.map(s => <li key={s.id + s.label}>
        <details>
          <summary><span className="ui-usage-name">{SECTION_LABEL[s.id] ? t(SECTION_LABEL[s.id]) : s.label}</span><span className="ui-meta-num">{shortTokens(s.tokens)}</span></summary>
          <pre className="ctx-inspect-text">{s.text}{s.text.length < s.chars ? '\n…' : ''}</pre>
        </details>
      </li>)}
    </ul>
    {active.length ? <ul className="ctx-inspect-list" data-testid="ctx-inspect-tools">
      {shown.map(x => <li key={x.name} title={x.description}><span className="ui-usage-name">{x.name}</span><span className="ui-meta-num">{shortTokens(x.tokens)}</span></li>)}
      {active.length > shown.length ? <li className="rp-dim">{t('ctx.moreTools', { n: active.length - shown.length })}</li> : null}
    </ul> : null}
  </details>
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
    <div className="ctx-window-head" data-testid="ctx-main" data-mode="window" title={t('ctx.estimateHint')}>
      <span className="ui-popover-title">{t('ctx.window')}</span>
      <span className={`ctx-window-total ui-meta-num ${known && tone !== 'ok' ? tone : ''}`} data-testid="ctx-tokens">
        {known ? `${shortTokens(tokens)} / ${shortTokens(windowSize)} (${Math.round(percent!)}%)` : '—'}
      </span>
    </div>
    <div className="ui-usage-bar" role="img" aria-label={known ? t('quota.usedInline', { pct: Math.round(percent!) }) : t('ctx.usageUnknown')}>
      {slices.map(s => s.tokens > 0 ? <i key={s.id} className={`ui-usage-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} /> : null)}
    </div>
    {rows.length ? <ul className="ui-usage-legend" data-testid="ctx-breakdown">
      {rows.map(r => <li key={r.id} className={r.id === 'free' ? 'free' : undefined}>
        <i className={`ui-usage-swatch c-${r.id}`} aria-hidden />
        <span className="ui-usage-name">{t(CATEGORY_LABEL[r.id])}</span>
        <span className="ui-usage-num ui-meta-num">{shortTokens(r.tokens)}</span>
        <span className="ui-usage-num ui-meta-num">{`${share(r.tokens).toFixed(1)}%`}</span>
      </li>)}
    </ul> : null}
    {known ? <ContextInspect tokens={tokens} /> : null}
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
