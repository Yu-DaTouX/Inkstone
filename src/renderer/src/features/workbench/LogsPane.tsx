import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Copy, Search } from '../../ui/icons'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PROMPT_SUGGESTION_STATUS_KEY } from '../composer/prompt-suggestion'
import { CONTEXT_USAGE_STATUS_KEY } from '../../state/context-sources'
import { CloseButton, EmptyState, IconButton, InputGroup, InputGroupAddon, InputGroupInput } from '../../ui'
import { workbenchPaneText } from './pane-text'
import type { LogsPaneProps } from './types'
import { logLineTone, type LogTone } from './log-tone'

const TAIL = 200
const USER_SCROLL_MS = 800

interface LogLine {
  seq: number
  text: string
  tone?: LogTone
}

function droppedFromTop(previous: readonly string[], next: readonly string[]): number {
  for (let shift = 0; shift < previous.length; shift++) {
    const rest = previous.length - shift
    if (rest > next.length) continue
    let same = true
    for (let i = 0; i < rest && same; i++) same = previous[shift + i] === next[i]
    if (same) return shift
  }
  return previous.length
}

export function LogsPane(_props: LogsPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = workbenchPaneText(lang)
  const logs = useStore((s) => s.logs)
  const statuses = useStore((s) => s.statuses)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const linesRef = useRef<HTMLDivElement | null>(null)
  const numbering = useRef<{ lines: readonly string[]; base: number }>({ lines: [], base: 0 })
  const stick = useRef(true)
  const lastInput = useRef(-Infinity)

  const statusEntries = Object.entries(statuses).filter(([key]) => key !== PROMPT_SUGGESTION_STATUS_KEY && key !== CONTEXT_USAGE_STATUS_KEY)
  const needle = filter.trim().toLowerCase()
  const numbered = useMemo<LogLine[]>(() => {
    const previous = numbering.current
    const base = previous.base + droppedFromTop(previous.lines, logs)
    numbering.current = { lines: logs, base }
    return logs.map((line, index) => ({ seq: base + index, text: line, tone: logLineTone(line) }))
  }, [logs])
  const visible = useMemo(() => {
    const tail = numbered.slice(-TAIL)
    return needle ? tail.filter((line) => line.text.toLowerCase().includes(needle)) : tail
  }, [numbered, needle])
  const shown = Math.min(logs.length, TAIL)

  useLayoutEffect(() => {
    stick.current = true
  }, [needle])

  const toBottom = useCallback(() => {
    const body = bodyRef.current
    if (!body || !stick.current) return
    body.scrollTop = body.scrollHeight
  }, [])

  useLayoutEffect(toBottom, [visible, toBottom])

  const hasBody = logs.length > 0
  const hasLines = visible.length > 0
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return undefined
    const resized = new ResizeObserver(toBottom)
    resized.observe(body)
    if (linesRef.current) resized.observe(linesRef.current)
    const fonts = document.fonts
    fonts?.addEventListener('loadingdone', toBottom)
    return () => {
      resized.disconnect()
      fonts?.removeEventListener('loadingdone', toBottom)
    }
  }, [hasBody, hasLines, toBottom])

  const onBodyScroll = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    if (performance.now() - lastInput.current > USER_SCROLL_MS) {
      toBottom()
      return
    }
    stick.current = body.scrollHeight - body.scrollTop - body.clientHeight < 8
  }, [toBottom])
  const noteInput = useCallback(() => {
    lastInput.current = performance.now()
  }, [])

  if (logs.length === 0 && statusEntries.length === 0) {
    return (
      <EmptyState className="wb-note-block wb-logs-empty" data-testid="v3-wb-logs-empty" title={t('tile.logsEmpty')} description={t('tile.logsEmptyHint')} />
    )
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(visible.map((line) => line.text).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (cause) {
      useStore.getState().notify('error', cause instanceof Error ? cause.message : text.copyFailed)
    }
  }

  return (
    <div className="wb-logs" data-testid="v3-wb-logs">
      {statusEntries.length > 0 ? (
        <section className="wb-logs-section" aria-label={t('rp.ext')}>
          <h4 className="wb-ctx-subtitle">{t('rp.ext')}</h4>
          <ul className="wb-ctx-rows wb-logs-status" data-testid="v3-wb-logs-status">
            {statusEntries.map(([key, value]) => (
              <li key={key}>
                <span className="wb-logs-status-key">{key}</span>
                <span className="wb-logs-status-value">{value}</span>
              </li>
            ))}
          </ul>
          <p className="wb-ctx-note">{t('rp.extHint')}</p>
        </section>
      ) : null}

      {logs.length > 0 ? (
        <section className="wb-logs-section wb-logs-main" aria-label={t('rp.log')}>
          <div className="wb-logs-bar">
            <h4 className="wb-ctx-subtitle">{t('rp.log')}</h4>
            <span className="wb-logs-count ui-meta-num" data-testid="v3-wb-logs-count">
              {needle ? `${visible.length}/${shown}` : shown}
            </span>
            <InputGroup size="sm" className="wb-logs-filter">
              <InputGroupAddon>
                <Search size={12} aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                value={filter}
                placeholder={text.logFilter}
                aria-label={text.logFilter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && filter) {
                    event.preventDefault()
                    event.stopPropagation()
                    setFilter('')
                  }
                }}
                data-testid="v3-wb-logs-filter"
              />
              {filter ? (
                <InputGroupAddon align="end">
                  <CloseButton size="micro" aria-label={text.clearFilter} onPress={() => setFilter('')} />
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={copied ? text.copied : text.copyLogs}
              tooltip={copied ? text.copied : text.copyLogs}
              onPress={() => void copy()}
              isDisabled={visible.length === 0}
              data-testid="v3-wb-logs-copy"
            >
              <Copy size={14} />
            </IconButton>
          </div>
          <div ref={bodyRef} className="wb-logs-body" role="log" aria-live="off" aria-label={t('rp.log')} tabIndex={0} onScroll={onBodyScroll} onWheel={noteInput} onPointerDown={noteInput} onPointerMove={(event) => { if (event.buttons) noteInput() }} onTouchMove={noteInput} onKeyDown={noteInput} data-testid="v3-wb-logs-body">
            {visible.length > 0 ? (
              <div ref={linesRef} className="wb-logs-lines">
                {visible.map((line) => (
                  <div key={line.seq} className="wb-logs-line" data-tone={line.tone} data-seq={line.seq}>
                    {line.text}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState size="sm" title={text.logNoMatch} data-testid="v3-wb-logs-no-match" />
            )}
          </div>
          <p className="wb-ctx-note">{t('rp.logHint')}</p>
        </section>
      ) : null}
    </div>
  )
}
