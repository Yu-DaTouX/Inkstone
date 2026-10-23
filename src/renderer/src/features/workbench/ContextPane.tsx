import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useI18n, useT, type Lang, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type { UIMessage } from '../../../../shared/ipc'
import type { ContextCategory } from '../../state/context-breakdown'
import {
  compactionGrowthText,
  compactionReclaimText,
  compactionSummary,
  compactionTokensText
} from '../../state/compaction-view'
import { Button, Notice, Spinner } from '../../ui'
import {
  autoCompactDistance,
  autoCompactLimitOf,
  contextPaneData,
  contextPaneToolCalls,
  shortTokens,
  type ContextToolCall
} from './context-pane-view'
import { compactionReclaim, loadCompactionHistory, type CompactionHistoryItem, type CompactionHistoryLoad } from './context-compactions'
import { contextPaneText, type ContextPaneText } from './context-pane-text'
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

const NO_MESSAGES: UIMessage[] = []
const HISTORY_PREVIEW = 3

function compactionTime(at: number | undefined, lang: Lang): string {
  if (at === undefined) return ''
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(lang, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function historyDetail(item: CompactionHistoryItem, text: ContextPaneText): string {
  const tokens = item.tokensBefore === undefined
    ? null
    : item.tokensAfter === undefined
      ? text.compactionBefore(shortTokens(item.tokensBefore))
      : text.compactionTokens(shortTokens(item.tokensBefore), shortTokens(item.tokensAfter), compactionReclaim(item))
  const summary = item.summaryTokens > 0 ? text.compactionSummary(shortTokens(item.summaryTokens)) : null
  return [tokens, summary].filter(Boolean).join(' · ')
}

function useCompactionHistory(visible: boolean, sessionId: string | null, reloadKey: string): CompactionHistoryLoad | null {
  const [state, setState] = useState<{ key: string; load: CompactionHistoryLoad } | null>(null)
  const generation = useRef(0)
  const key = `${sessionId ?? ''}|${reloadKey}`
  useEffect(() => {
    if (!visible || !sessionId) return undefined
    const run = ++generation.current
    let cancelled = false
    void loadCompactionHistory((request) => window.yan.nativeSession(request), sessionId).then((load) => {
      if (cancelled || run !== generation.current) return
      if (useStore.getState().session?.sessionId !== sessionId) return
      setState({ key, load })
    })
    return () => {
      cancelled = true
    }
  }, [visible, sessionId, key])
  return state && state.key.startsWith(`${sessionId ?? ''}|`) ? state.load : null
}

function ToolCallRows({ rows, text }: { rows: ContextToolCall[]; text: ContextPaneText }): ReactElement {
  const [missed, setMissed] = useState<string | null>(null)
  useEffect(() => {
    if (!missed) return undefined
    const timer = window.setTimeout(() => setMissed(null), 4000)
    return () => window.clearTimeout(timer)
  }, [missed])
  return (
    <>
      <ul className="wb-ctx-tools" data-testid="v3-wb-ctx-top-tools">
        {rows.map((row) => {
          const label = row.target ? `${row.name} · ${row.target}` : row.name
          return (
            <li key={row.id}>
              <Button
                variant="ghost"
                size="sm"
                className="wb-ctx-tool"
                title={label}
                aria-label={`${text.jumpTo(label)} · ${shortTokens(row.tokens)}`}
                data-testid="v3-wb-ctx-tool"
                onPress={() => setMissed(useStore.getState().locateMessage(row.anchorId) ? null : row.id)}
              >
                <span className="wb-ctx-tool-name">{row.name}</span>
                <span className="wb-ctx-tool-target">{row.target}</span>
                <span className="wb-ctx-tool-num ui-meta-num">{`≈${shortTokens(row.tokens)}`}</span>
              </Button>
            </li>
          )
        })}
      </ul>
      {missed ? (
        <Notice tone="info" compact data-testid="v3-wb-ctx-locate-miss">
          {text.locateFailed}
        </Notice>
      ) : null}
    </>
  )
}

export function ContextPane({ visible = true }: ContextPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => contextPaneText(lang), [lang])

  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => (visible ? s.messages : NO_MESSAGES))
  const autoCompactTokens = useStore((s) => s.settings?.autoCompactTokens)
  const autoCompactLimit = autoCompactLimitOf(session, { autoCompactTokens })

  const data = useMemo(
    () => contextPaneData({ session, stats, messages, autoCompactLimit }),
    [session, stats, messages, autoCompactLimit]
  )
  const toolCalls = useMemo(
    () => contextPaneToolCalls({ session, stats, messages, autoCompactLimit }),
    [session, stats, messages, autoCompactLimit]
  )
  const { usage, slices, compacted } = data

  const sessionId = session?.sessionId ?? null
  const last = session?.lastCompaction
  const historyKey = [last?.status ?? '', last?.endedAt ?? last?.startedAt ?? '', last?.entryId ?? '', session?.contextFrom?.firstKeptEntryId ?? ''].join(':')
  const history = useCompactionHistory(visible, sessionId, historyKey)
  const [showAllHistory, setShowAllHistory] = useState(false)

  const [compactRun, setCompactRun] = useState<{ sessionId: string; pending: boolean; error: string } | null>(null)
  const ownRun = compactRun && compactRun.sessionId === sessionId ? compactRun : null
  const running = !!(session?.isStreaming || session?.isAgentRunning)
  const compacting = !!session?.isCompacting || !!ownRun?.pending
  const compactDisabled = !sessionId || running || compacting

  const compactNow = (): void => {
    if (!sessionId || compactDisabled) return
    setCompactRun({ sessionId, pending: true, error: '' })
    void useStore.getState().compact().then(
      (result) => setCompactRun({ sessionId, pending: false, error: result.ok ? '' : result.error || text.compactFailed }),
      (error: unknown) => setCompactRun({ sessionId, pending: false, error: error instanceof Error ? error.message : text.compactFailed })
    )
  }

  const share = (n: number): number => (usage.windowSize > 0 ? (n / usage.windowSize) * 100 : 0)
  const rows = usage.known
    ? [
        ...slices.filter((s) => s.tokens > 0),
        { id: 'free' as const, tokens: Math.max(0, usage.windowSize - usage.tokens) }
      ]
    : []

  const limitNote = usage.cappedByLimit
    ? t('ctx.limitNote', { model: shortTokens(usage.modelWindow), limit: shortTokens(usage.windowSize) })
    : undefined
  const distance = autoCompactDistance(usage, session?.autoCompactionEnabled)
  const lastLine = last
    ? [
        compactionSummary(t, last),
        compactionTokensText(last),
        compactionReclaimText(t, last),
        compactionGrowthText(t, last, usage.known ? usage.tokens : undefined)
      ].filter(Boolean).join(' · ')
    : null
  const historyItems = history?.ok ? history.items : null
  const historyPending = visible && !!sessionId && !history
  const shownHistory = historyItems ? (showAllHistory ? historyItems : historyItems.slice(0, HISTORY_PREVIEW)) : []
  const unsettledLast = last && last.status !== 'completed' ? lastLine : null

  return (
    <section className="wb-ctx" aria-label={text.title} data-testid="v3-wb-context">
      <div className="wb-ctx-block">
        <div className="wb-ctx-head">
          <span className="wb-ctx-subtitle">{text.usage}</span>
          <span
            className={`wb-ctx-total ui-meta-num ${usage.known ? usage.tone : ''}`}
            title={limitNote}
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
        {distance ? (
          <p className="wb-ctx-record" title={limitNote} data-testid="v3-wb-ctx-distance" data-kind={distance.kind}>
            {text.distance(distance.kind, shortTokens(distance.remaining))}
          </p>
        ) : null}
        {usage.windowAssumed ? (
          <p className="wb-ctx-note" data-testid="v3-wb-ctx-window-assumed">
            {t('ctx.windowAssumed', { win: shortTokens(usage.windowSize) })}
          </p>
        ) : null}
        <div className="wb-ctx-actions">
          <Button
            variant="secondary"
            size="sm"
            isDisabled={compactDisabled}
            icon={compacting ? <Spinner size={12} /> : undefined}
            title={running ? text.compactBusy : undefined}
            data-testid="v3-wb-ctx-compact"
            onPress={compactNow}
          >
            {compacting ? text.compacting : text.compactNow}
          </Button>
        </div>
        {ownRun?.error ? (
          <Notice tone="fail" compact title={text.compactFailed} data-testid="v3-wb-ctx-compact-error">
            {ownRun.error === text.compactFailed ? null : ownRun.error}
          </Notice>
        ) : null}
      </div>

      {toolCalls.length ? (
        <div className="wb-ctx-block">
          <h4 className="wb-ctx-subtitle">{text.topTools}</h4>
          <ToolCallRows rows={toolCalls} text={text} />
          <p className="wb-ctx-note">{text.estimateNote}</p>
        </div>
      ) : null}

      <div className="wb-ctx-block">
        <h4 className="wb-ctx-subtitle">{text.compaction}</h4>
        {unsettledLast ? (
          <p className="wb-ctx-record" data-testid="v3-wb-ctx-compaction">
            {unsettledLast}
          </p>
        ) : null}
        {historyItems?.length ? (
          <>
            <ul className="wb-ctx-rows" data-testid="v3-wb-ctx-history">
              {shownHistory.map((item) => (
                <li key={item.id}>
                  <span className="ui-meta-num">{compactionTime(item.at, lang)}</span>
                  <span className="wb-ctx-history-detail ui-meta-num">{historyDetail(item, text)}</span>
                </li>
              ))}
            </ul>
            {historyItems.length > HISTORY_PREVIEW ? (
              <Button
                variant="plain"
                size="sm"
                className="wb-ctx-more"
                aria-expanded={showAllHistory}
                data-testid="v3-wb-ctx-history-more"
                onPress={() => setShowAllHistory((value) => !value)}
              >
                {showAllHistory ? text.less : text.more(historyItems.length - HISTORY_PREVIEW)}
              </Button>
            ) : null}
          </>
        ) : historyItems || unsettledLast || historyPending ? null : lastLine ? (
          <p className="wb-ctx-record" data-testid="v3-wb-ctx-compaction">
            {lastLine}
          </p>
        ) : null}
        {!historyItems?.length && !unsettledLast && !historyPending && (historyItems || !lastLine) ? (
          <p className="wb-ctx-note">{text.compactionNone}</p>
        ) : null}
      </div>

      <div className="wb-ctx-block">
        <Button
          variant="ghost"
          size="sm"
          className="wb-ctx-settings"
          data-testid="v3-wb-ctx-settings"
          onPress={() => useStore.getState().openSettings('context')}
        >
          {text.openSettings}
        </Button>
      </div>
    </section>
  )
}
