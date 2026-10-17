import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, Popover } from 'react-aria-components'
import { Button } from '../ui'
import { useT, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
import type { ContextCategory } from '../state/context-breakdown'
import { contextPaneData, contextUsageSummary } from '../features/workbench/context-pane-view'
import { ContextRingGlyph } from './ContextGauge'
import './context-ring.css'

function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

const CATEGORY_LABEL: Record<ContextCategory | 'free', MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools',
  free: 'ctx.cat.free'
}

export function useContextUsage() {
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const usage = stats?.contextUsage
  const summary = contextUsageSummary(session, stats)
  return {
    session,
    usage,
    matches: summary.matchesModel,
    windowSize: summary.windowSize,
    known: summary.known,
    tokens: summary.tokens,
    percent: summary.percent,
    tone: summary.tone,
    windowAssumed: summary.windowAssumed
  }
}

export function ContextRing({ className }: { className?: string } = {}) {
  const t = useT()
  const { session, usage, matches, windowSize, known, tokens, percent, tone, windowAssumed } = useContextUsage()
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)
  const compact = useStore((s) => s.compact)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const boundKey = `${session?.sessionId ?? ''}|${session?.model?.provider ?? ''}/${session?.model?.id ?? ''}`
  useEffect(() => {
    setOpen(false)
  }, [boundKey])

  const { slices, compacted } = useMemo(() => contextPaneData({ session, stats, messages }), [session, stats, messages])
  const share = (n: number): number => (windowSize > 0 ? (n / windowSize) * 100 : 0)
  const rows = known
    ? [...slices.filter((s) => s.tokens > 0), { id: 'free' as const, tokens: Math.max(0, windowSize - tokens) }]
    : []
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const text = known ? `${Math.round(percent!)}%` : '—'
  const title = known
    ? t('ctx.tip', { used: shortTokens(tokens), win: shortTokens(windowSize), pct: Math.round(percent!) })
    : t('ctx.usageUnknown')

  return (
    <div className={`ctx-ring-wrap ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="ctx-ring"
        data-tone={known ? tone : ''}
        aria-label={t('rp.context')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <ContextRingGlyph percent={percent} tone={tone} />
        <span className="ctx-ring-text ui-meta-num" data-testid="ctx-ring-text">
          {text}
        </span>
      </button>
      <Popover
        className="ctx-pop"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="top start"
        offset={8}
      >
        <Dialog className="ctx-dialog" aria-label={t('rp.context')}>
          <div className="ctx-window-head" data-testid="ctx-main">
            <span className="ctx-pop-title">{t('ctx.window')}</span>
            <span className={`ctx-window-total ui-meta-num ${known && tone !== 'ok' ? tone : ''}`} data-testid="ctx-tokens">
              {known ? `${shortTokens(tokens)} / ${windowAssumed ? '~' : ''}${shortTokens(windowSize)} (${Math.round(percent!)}%)` : '—'}
            </span>
          </div>
          {windowAssumed ? (
            <div className="ctx-note" data-testid="ctx-window-assumed">
              {t('ctx.windowAssumed', { win: shortTokens(windowSize) })}
            </div>
          ) : null}
          <div
            className="ctx-usage-bar"
            role="img"
            aria-label={known ? t('quota.usedInline', { pct: Math.round(percent!) }) : t('ctx.usageUnknown')}
          >
            {slices.map((s) =>
              s.tokens > 0 ? (
                <i key={s.id} className={`ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} />
              ) : null
            )}
          </div>
          {rows.length ? (
            <ul className="ctx-legend" data-testid="ctx-breakdown">
              {rows.map((r) => (
                <li key={r.id} className={r.id === 'free' ? 'free' : undefined}>
                  <i className={`ctx-swatch c-${r.id}`} aria-hidden />
                  <span className="ctx-legend-name">{t(r.id === 'system' && compacted ? 'ctx.cat.systemSummary' : CATEGORY_LABEL[r.id])}</span>
                  <span className="ctx-legend-num ui-meta-num">{shortTokens(r.tokens)}</span>
                  <span className="ctx-legend-num ui-meta-num">{`${share(r.tokens).toFixed(1)}%`}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {matches && usage?.tokens === null ? (
            <div className="ctx-note" data-testid="ctx-unknown">
              {t('ctx.afterCompact')}
            </div>
          ) : null}
          <p className="ctx-note ctx-estimate-note">{t('ctx.estimateHint')}</p>
          <div className="ctx-actions">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!session?.sessionId || busy}
              data-testid="ctx-compact-now"
              onPress={() => void compact()}
            >
              {t('status.compact')}
            </Button>
          </div>
        </Dialog>
      </Popover>
    </div>
  )
}
