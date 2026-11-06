import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
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
import { Button, ListRow, Notice, Spinner } from '../../ui'
import {
  autoCompactDistance,
  autoCompactLimitOf,
  contextPaneData,
  contextPaneToolCalls,
  shortTokens,
  type ContextToolCall
} from './context-pane-view'
import { CELL_COLUMNS, contextCells, type CellKind } from './context-cells'
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

const HISTORY_RETRY_MS = [300, 800, 2000, 5000]
const historyCache = new Map<string, CompactionHistoryLoad>()

function useCompactionHistory(visible: boolean, sessionId: string | null, reloadKey: string): CompactionHistoryLoad | null {
  const [loaded, setLoaded] = useState<{ sessionId: string; load: CompactionHistoryLoad } | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    if (!visible || !sessionId) return undefined
    const run = ++generation.current
    let timer: number | undefined
    const attempt = (tries: number): void => {
      void loadCompactionHistory((request) => window.yan.nativeSession(request), sessionId).then((load) => {
        if (run !== generation.current) return
        if (useStore.getState().session?.sessionId !== sessionId) return
        if (!load.ok && tries < HISTORY_RETRY_MS.length) {
          timer = window.setTimeout(() => attempt(tries + 1), HISTORY_RETRY_MS[tries])
          return
        }
        if (load.ok) historyCache.set(sessionId, load)
        setLoaded({ sessionId, load })
      })
    }
    attempt(0)
    return () => {
      generation.current += 1
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [visible, sessionId, reloadKey])
  if (!sessionId) return null
  if (loaded?.sessionId === sessionId && (loaded.load.ok || !historyCache.has(sessionId))) return loaded.load
  return historyCache.get(sessionId) ?? null
}

function ContextCells({ cells, focus, compacting }: { cells: CellKind[]; focus: CellKind | null; compacting: boolean }): ReactElement {
  return (
    <div
      className="wb-ctxw-field"
      aria-hidden
      data-compacting={compacting ? '1' : undefined}
      data-focus={focus ? '1' : undefined}
      style={{ '--ctx-columns': CELL_COLUMNS } as CSSProperties}
      data-testid="v3-wb-ctx-cells"
    >
      {cells.map((kind, index) => (
        <i
          key={index}
          className={`wb-ctxw-cell c-${kind}`}
          data-lit={focus === kind ? '1' : undefined}
          style={{ '--cell-step': (index % CELL_COLUMNS) + Math.floor(index / CELL_COLUMNS) * 2 } as CSSProperties}
        />
      ))}
    </div>
  )
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
          const target = row.target || (row.scriptLines ? text.scriptLines(row.scriptLines) : '')
          const label = target ? `${row.name} · ${target}` : row.name
          return (
            <li key={row.id}>
              <ListRow
                className="wb-ctx-tool"
                title={row.detail ? `${label}\n${row.detail}` : label}
                aria-label={`${text.jumpTo(label)} · ${shortTokens(row.tokens)}`}
                data-testid="v3-wb-ctx-tool"
                trailing={`≈${shortTokens(row.tokens)}`}
                onClick={() => void useStore.getState().locateMessage(row.anchorId).then((found) => setMissed(found ? null : row.id))}
              >
                {row.name}
                {target ? <span className="wb-ctx-tool-target">{` ${target}`}</span> : null}
              </ListRow>
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

  const sessionId = session?.sessionId ?? null
  const last = session?.lastCompaction
  const historyKey = [last?.status ?? '', last?.endedAt ?? last?.startedAt ?? '', last?.entryId ?? '', session?.contextFrom?.firstKeptEntryId ?? ''].join(':')
  const history = useCompactionHistory(visible, sessionId, historyKey)
  const summaryTokens = history?.ok ? history.items[0]?.summaryTokens ?? 0 : 0

  const data = useMemo(
    () => contextPaneData({ session, stats, messages, autoCompactLimit, summaryTokens }),
    [session, stats, messages, autoCompactLimit, summaryTokens]
  )
  const toolCalls = useMemo(
    () => contextPaneToolCalls({ session, stats, messages, autoCompactLimit }),
    [session, stats, messages, autoCompactLimit]
  )
  const { usage, slices, compacted } = data

  const [showAllHistory, setShowAllHistory] = useState(false)
  const [focusKind, setFocusKind] = useState<CellKind | null>(null)

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
  const rows = usage.known ? slices.filter((s) => s.tokens > 0) : []
  const focusRow = rows.find((row) => row.id === focusKind) ?? null
  const rowLabel = (id: ContextCategory): string => t(id === 'system' && compacted ? 'ctx.cat.systemSummary' : CATEGORY_LABEL[id])
  const modelName = session?.model?.name || session?.model?.id || ''

  const cells = useMemo(() => (usage.known ? contextCells(slices, usage.windowSize) : []), [usage.known, slices, usage.windowSize])
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
      <div className="wb-ctxw" role="group" aria-label={text.windowTitle} data-tone={usage.known ? usage.tone : undefined}>
        <div className="wb-ctxw-head">
          <span className="wb-ctxw-title">{text.windowTitle}</span>
          {modelName ? <span className="wb-ctxw-model" title={modelName}>{modelName}</span> : null}
        </div>
        <div className="wb-ctxw-figure" title={limitNote}>
          <span className="wb-ctxw-number" aria-hidden>{usage.known ? shortTokens(focusRow ? focusRow.tokens : usage.tokens) : text.unknown}</span>
          <span className="wb-ctxw-figure-label" aria-hidden>{focusRow ? rowLabel(focusRow.id) : text.used}</span>
          <span className="v3-visually-hidden" data-testid="v3-wb-ctx-tokens">
            {usage.known
              ? `${shortTokens(usage.tokens)} / ${usage.windowAssumed ? '~' : ''}${shortTokens(usage.windowSize)} (${Math.round(usage.percent!)}%)`
              : text.unknown}
          </span>
          {usage.known ? (
            <span className="wb-ctxw-pct ui-num" data-tone={usage.tone} aria-hidden>
              {`${Math.round(focusRow ? share(focusRow.tokens) : usage.percent!)}%`}
            </span>
          ) : null}
        </div>

        {usage.known ? (
          <>
            <ContextCells cells={cells} focus={focusKind} compacting={compacting} />
            <ul className="wb-ctxw-parts" data-testid="v3-wb-ctx-breakdown">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="wb-ctxw-part"
                  aria-label={`${rowLabel(r.id)} ${shortTokens(r.tokens)} (${Math.round(share(r.tokens))}%)`}
                  data-active={focusKind === r.id ? '1' : undefined}
                  tabIndex={0}
                  onMouseEnter={() => setFocusKind(r.id)}
                  onMouseLeave={() => setFocusKind(null)}
                  onFocus={() => setFocusKind(r.id)}
                  onBlur={() => setFocusKind(null)}
                >
                  <i className={`wb-ctxw-swatch c-${r.id}`} aria-hidden />
                  <span className="wb-ctxw-part-name">{rowLabel(r.id)}</span>
                  <span className="wb-ctxw-part-num ui-num">{shortTokens(r.tokens)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="wb-ctx-note" data-testid="v3-wb-ctx-unknown">
            {text.unknownHint}
          </p>
        )}

        <div className="wb-ctxw-tray">
          <span className="wb-ctxw-tray-text" role="status" aria-live="polite" title={limitNote || text.distanceHint} data-testid="v3-wb-ctx-distance" data-kind={distance?.kind}>
            {compacting
              ? text.compacting
              : usage.afterCompactUnknown
                ? text.afterCompact
                : distance
                  ? text.distance(distance.kind, shortTokens(distance.remaining))
                  : usage.known
                    ? text.left(shortTokens(Math.max(0, usage.windowSize - usage.tokens)))
                    : ''}
          </span>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={compactDisabled}
            icon={compacting ? <Spinner size="xs" /> : undefined}
            title={running ? text.compactBusy : undefined}
            data-testid="v3-wb-ctx-compact"
            onPress={compactNow}
          >
            {text.compactNow}
          </Button>
        </div>
        {usage.windowAssumed ? (
          <p className="wb-ctx-note" data-testid="v3-wb-ctx-window-assumed">
            {t('ctx.windowAssumed', { win: shortTokens(usage.windowSize) })}
          </p>
        ) : null}
        {ownRun?.error ? (
          <Notice tone="fail" compact title={text.compactFailed} data-testid="v3-wb-ctx-compact-error">
            {ownRun.error === text.compactFailed ? null : ownRun.error}
          </Notice>
        ) : null}
      </div>

      {toolCalls.length ? (
        <div className="wb-ctx-block">
          <h4 className="wb-ctx-subtitle" title={text.estimateNote}>{text.topTools}</h4>
          <ToolCallRows rows={toolCalls} text={text} />
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
        {!historyItems?.length && !unsettledLast && !historyPending && history?.ok !== false && (historyItems || !lastLine) ? (
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
