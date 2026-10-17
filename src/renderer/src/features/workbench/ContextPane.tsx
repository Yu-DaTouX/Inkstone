import { useMemo, type ReactElement } from 'react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type { ContextCategory } from '../../state/context-breakdown'
import {
  compactionGrowthText,
  compactionReclaimText,
  compactionSummary,
  compactionTokensText
} from '../../state/compaction-view'
import { Button } from '../../ui'
import { shortTokens, contextPaneData } from './context-pane-view'
import { contextPaneText } from './context-pane-text'
import type { ContextPaneProps } from './types'
import './workbench.css'

const CATEGORY_LABEL: Record<ContextCategory | 'free', MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools',
  free: 'ctx.cat.free'
}

export function ContextPane(_props: ContextPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => contextPaneText(lang), [lang])

  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)

  const data = useMemo(() => contextPaneData({ session, stats, messages }), [session, stats, messages])
  const { usage, slices, occupancy, compacted } = data

  const share = (n: number): number => (usage.windowSize > 0 ? (n / usage.windowSize) * 100 : 0)
  const rows = usage.known
    ? [
        ...slices.filter((s) => s.tokens > 0),
        { id: 'free' as const, tokens: Math.max(0, usage.windowSize - usage.tokens) }
      ]
    : []

  const last = session?.lastCompaction
  const tokensText = last ? compactionTokensText(last) : null
  const reclaimText = last ? compactionReclaimText(t, last) : null
  const growthText = last
    ? compactionGrowthText(t, last, usage.known ? usage.tokens : undefined)
    : null

  return (
    <section className="wb-ctx" aria-label={text.title} data-testid="v3-wb-context">
      <div className="wb-ctx-block">
        <div className="wb-ctx-head">
          <span className="wb-ctx-subtitle">{text.usage}</span>
          <span
            className={`wb-ctx-total ui-meta-num ${usage.known ? usage.tone : ''}`}
            data-testid="v3-wb-ctx-tokens"
          >
            {usage.known
              ? `${shortTokens(usage.tokens)} / ${usage.windowAssumed ? '~' : ''}${shortTokens(usage.windowSize)} (${Math.round(usage.percent!)}%)`
              : text.unknown}
          </span>
        </div>

        {usage.known ? (
          <>
            <div
              className="wb-ctx-bar"
              role="img"
              aria-label={t('ctx.tip', {
                used: shortTokens(usage.tokens),
                win: shortTokens(usage.windowSize),
                pct: Math.round(usage.percent!)
              })}
            >
              {slices.map((s) =>
                s.tokens > 0 ? (
                  <i key={s.id} className={`wb-ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} />
                ) : null
              )}
            </div>
            <ul className="wb-ctx-legend" data-testid="v3-wb-ctx-breakdown">
              {rows.map((r) => (
                <li key={r.id} className={r.id === 'free' ? 'free' : undefined}>
                  <i className={`wb-ctx-swatch c-${r.id}`} aria-hidden />
                  <span className="wb-ctx-legend-name">{t(r.id === 'system' && compacted ? 'ctx.cat.systemSummary' : CATEGORY_LABEL[r.id])}</span>
                  <span className="wb-ctx-legend-num ui-meta-num">{shortTokens(r.tokens)}</span>
                  <span className="wb-ctx-legend-num ui-meta-num">{`${share(r.tokens).toFixed(1)}%`}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="wb-ctx-note" data-testid="v3-wb-ctx-unknown">
            {text.unknownHint}
          </p>
        )}

        {usage.afterCompactUnknown ? <p className="wb-ctx-note">{text.afterCompact}</p> : null}
        {usage.windowAssumed ? (
          <p className="wb-ctx-note" data-testid="v3-wb-ctx-window-assumed">
            {t('ctx.windowAssumed', { win: shortTokens(usage.windowSize) })}
          </p>
        ) : null}
      </div>

      {usage.known ? (
        <div className="wb-ctx-block">
          <h4 className="wb-ctx-subtitle">{text.occupancy}</h4>
          <ul className="wb-ctx-rows" data-testid="v3-wb-ctx-occupancy">
            {occupancy.map((row) => (
              <li key={row.id} data-testid={`v3-wb-ctx-${row.id}`}>
                <span>{text.occupancyLabels[row.id]}</span>
                <span className="ui-meta-num">
                  {row.count} {text.items} · {shortTokens(row.tokens)}
                </span>
              </li>
            ))}
          </ul>
          <p className="wb-ctx-note">{text.estimateNote}</p>
        </div>
      ) : null}

      <div className="wb-ctx-block">
        <h4 className="wb-ctx-subtitle">{text.compaction}</h4>
        {last ? (
          <p className="wb-ctx-record" data-testid="v3-wb-ctx-compaction">
            {[compactionSummary(t, last), tokensText, reclaimText, growthText].filter(Boolean).join(' · ')}
          </p>
        ) : (
          <p className="wb-ctx-note">{text.compactionNone}</p>
        )}
      </div>

      <div className="wb-ctx-block">
        <Button
          variant="secondary"
          size="sm"
          data-testid="v3-wb-ctx-settings"
          onPress={() => useStore.getState().openSettings('context')}
        >
          {text.openSettings}
        </Button>
      </div>
    </section>
  )
}
