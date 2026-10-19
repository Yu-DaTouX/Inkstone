import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from 'react-aria-components'
import { Button, Popover } from '../ui'
import { useT, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
import type { ContextCategory } from '../state/context-breakdown'
import type { UIMessage } from '../../../shared/ipc'
import { autoCompactLimitOf, contextPaneData, contextUsageSummary } from '../features/workbench/context-pane-view'
import { ContextRingGlyph } from './ContextGauge'
import './context-ring.css'

function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

const NO_MESSAGES: readonly UIMessage[] = []

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
  const autoCompactTokens = useStore((s) => s.settings?.autoCompactTokens)
  const autoCompactLimit = autoCompactLimitOf(session, { autoCompactTokens })
  const summary = contextUsageSummary(session, stats, autoCompactLimit)
  return {
    autoCompactLimit,
    summary,
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
  const { session, usage, matches, windowSize, known, tokens, percent, tone, windowAssumed, summary, autoCompactLimit } =
    useContextUsage()
  const lastShown = useRef<{ sessionId: string; percent: number; tone: typeof tone } | null>(null)
  const sessionId = session?.sessionId ?? ''
  if (known && percent !== null) lastShown.current = { sessionId, percent, tone }
  const held = !known && !!usage && !matches && lastShown.current?.sessionId === sessionId ? lastShown.current : null
  const ringPercent = held ? held.percent : percent
  const ringTone = held ? held.tone : tone
  const stats = useStore((s) => s.stats)
  const compact = useStore((s) => s.compact)
  const [open, setOpen] = useState(false)
  const messages = useStore((s) => (open ? s.messages : NO_MESSAGES))
  const triggerRef = useRef<HTMLButtonElement>(null)

  const boundKey = `${session?.sessionId ?? ''}|${session?.model?.provider ?? ''}/${session?.model?.id ?? ''}`
  useEffect(() => {
    setOpen(false)
  }, [boundKey])

  const { slices, compacted } = useMemo(
    () => (open ? contextPaneData({ session, stats, messages, autoCompactLimit }) : { slices: [], compacted: false }),
    [open, session, stats, messages, autoCompactLimit]
  )
  const share = (n: number): number => (windowSize > 0 ? (n / windowSize) * 100 : 0)
  const rows = known
    ? [...slices.filter((s) => s.tokens > 0), { id: 'free' as const, tokens: Math.max(0, windowSize - tokens) }]
    : []
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const text = ringPercent !== null ? `${Math.round(ringPercent)}%` : '—'
  const limitNote = summary.cappedByLimit
    ? t('ctx.limitNote', { model: shortTokens(summary.modelWindow), limit: shortTokens(windowSize) })
    : ''
  const tip = known
    ? t('ctx.tip', { used: shortTokens(tokens), win: shortTokens(windowSize), pct: Math.round(percent!) })
    : t('ctx.usageUnknown')
  const title = known && limitNote ? `${tip}
${limitNote}` : tip

  return (
    <div className={`ctx-ring-wrap ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="ctx-ring"
        data-tone={ringPercent !== null ? ringTone : ''}
        aria-label={t('rp.context')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <ContextRingGlyph percent={ringPercent} tone={ringTone} />
        <span className="ctx-ring-text ui-meta-num" data-testid="ctx-ring-text">
          {text}
        </span>
      </button>
      <Popover
        variant="panel"
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
          {known && limitNote ? (
            <div className="ctx-note" data-testid="ctx-limit-note">
              {limitNote}
            </div>
          ) : null}
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
