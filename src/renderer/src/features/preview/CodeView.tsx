import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { VList, type VListHandle } from 'virtua'
import { exceedsHighlightLimits, FILE_HIGHLIGHT_LIMITS, highlightLanguage, highlightTree } from '../../lib/code-highlight'
import {
  foldRegions,
  guideLevels,
  jumpRange,
  lineText,
  numberColumnWidth,
  rowIndexOfLine,
  scrollPastEndPadding,
  splitHighlightedLines,
  unfoldToReveal,
  visibleLineIndexes,
  type CodeLine,
  type CodeToken
} from './code-lines'
import type { FileViewSettings } from './file-view-settings'
import { pickLanguage } from './preview-language'
import '../../patterns/highlighted-code.css'
import './code-view.css'

export interface CodeViewTarget {
  line: number
  lineEnd?: number
  nonce: number
}

export interface CodeViewText {
  label: string
  plainNote: string
  fold: string
  unfold: string
  folded: string
}

export interface CodeViewProps {
  text: string
  name: string
  settings: FileViewSettings
  firstNumber?: number
  target?: CodeViewTarget | null
  labels: CodeViewText
}

const SPACER = -1
const PLAIN_LANGUAGES = new Set(['plaintext', 'text', 'txt', 'plain', 'log'])

function whitespaceParts(value: string): ReactNode {
  const parts = value.split(/([ \t])/)
  return parts.map((part, index) =>
    part === ' ' ? (
      <span key={index} className="v3-code-ws" data-ws="space">
        {part}
      </span>
    ) : part === '\t' ? (
      <span key={index} className="v3-code-ws" data-ws="tab">
        {part}
      </span>
    ) : (
      part
    )
  )
}

function renderToken(token: CodeToken, key: number, showWhitespace: boolean): ReactNode {
  let node: ReactNode = showWhitespace ? whitespaceParts(token.text) : token.text
  for (let depth = token.classes.length - 1; depth >= 0; depth -= 1) {
    node = <span className={token.classes[depth]}>{node}</span>
  }
  return <span key={key}>{node}</span>
}

const CodeLineRow = memo(function CodeLineRow({
  line,
  number,
  index,
  guides,
  guideStep,
  foldable,
  folded,
  active,
  showWhitespace,
  labels,
  onToggleFold,
  onPick
}: {
  line: CodeLine
  number: number
  index: number
  guides: number
  guideStep: number
  foldable: boolean
  folded: boolean
  active: boolean
  showWhitespace: boolean
  labels: CodeViewText
  onToggleFold: (index: number) => void
  onPick: (index: number) => void
}) {
  const style = guides > 0 ? ({ '--code-guides': String(guides), '--code-guide-step': `${guideStep}ch` } as CSSProperties) : undefined
  return (
    <div className="v3-code-line" data-line={number} data-active={active ? '' : undefined} onMouseDown={() => onPick(index)}>
      <span className="v3-code-gutter">
        <span className="v3-code-number" data-number={number} aria-hidden />
        <span className="v3-code-fold-slot">
          {foldable ? (
            <button
              type="button"
              tabIndex={-1}
              className="v3-code-fold"
              data-folded={folded ? '' : undefined}
              aria-expanded={!folded}
              aria-label={`${folded ? labels.unfold : labels.fold} ${number}`}
              title={folded ? labels.unfold : labels.fold}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => onToggleFold(index)}
            >
              {folded ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            </button>
          ) : null}
        </span>
      </span>
      <code className="v3-code-text" data-guides={guides > 0 ? '' : undefined} style={style}>
        {line.map((token, key) => renderToken(token, key, showWhitespace))}
        {folded ? (
          <button
            type="button"
            tabIndex={-1}
            className="v3-code-folded"
            aria-label={`${labels.unfold} ${number}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onToggleFold(index)}
          >
            {labels.folded}
          </button>
        ) : null}
        {'\n'}
      </code>
    </div>
  )
})

export function CodeView({ text, name, settings, firstNumber = 1, target, labels }: CodeViewProps) {
  const listRef = useRef<VListHandle>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const language = useMemo(() => pickLanguage(name, (value) => highlightLanguage(value) !== null), [name])
  const source = useMemo(() => text.replace(/\r\n/g, '\n'), [text])
  const tree = useMemo(() => (language ? highlightTree(source, language, FILE_HIGHLIGHT_LIMITS) : null), [source, language])
  const tooSlow = useMemo(
    () => !!language && !PLAIN_LANGUAGES.has(language) && highlightLanguage(language) !== null && !tree && exceedsHighlightLimits(source, FILE_HIGHLIGHT_LIMITS),
    [language, tree, source]
  )
  const lines = useMemo(() => splitHighlightedLines(tree, source), [tree, source])
  const texts = useMemo(() => lines.map(lineText), [lines])
  const guides = useMemo(() => (settings.indentGuides ? guideLevels(texts, settings.tabSize) : null), [texts, settings.indentGuides, settings.tabSize])
  const regions = useMemo(() => foldRegions(texts, settings.tabSize), [texts, settings.tabSize])
  const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set())
  const [current, setCurrent] = useState<number | null>(null)
  const [padding, setPadding] = useState(0)
  const [seenTexts, setSeenTexts] = useState(texts)
  if (seenTexts !== texts) {
    setSeenTexts(texts)
    setFolded(new Set())
    setCurrent(null)
  }
  const rows = useMemo(() => visibleLineIndexes(lines.length, regions, folded), [lines.length, regions, folded])
  const data = useMemo(() => (settings.scrollPastEnd ? [...rows, SPACER] : rows), [rows, settings.scrollPastEnd])
  const range = target ? jumpRange(target.line, target.lineEnd) : null

  const toggleFold = useCallback(
    (index: number): void => {
      if (!regions.has(index)) return
      setFolded((prev) => {
        const next = new Set(prev)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
    },
    [regions]
  )
  const pick = useCallback((index: number): void => setCurrent(index), [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || !settings.scrollPastEnd) return undefined
    const measure = (): void => {
      const viewport = host.querySelector<HTMLElement>('.v3-code-scroller')
      if (!viewport) return
      const style = getComputedStyle(viewport)
      const lineHeight = parseFloat(getComputedStyle(host).lineHeight) || 17
      setPadding(scrollPastEndPadding(viewport.clientHeight, lineHeight, parseFloat(style.paddingTop) || 0))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [settings.scrollPastEnd])

  const jumpedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!range || !target) return
    const key = `${target.nonce}:${range.first}:${range.last}:${lines.length}`
    if (jumpedRef.current === key) return
    const lineIndex = range.first - firstNumber
    if (lineIndex < 0 || lineIndex >= lines.length) return
    const revealed = unfoldToReveal(regions, folded, lineIndex)
    if (revealed.size !== folded.size) {
      setFolded(revealed)
      return
    }
    jumpedRef.current = key
    setCurrent(lineIndex)
    const rowIndex = rowIndexOfLine(rows, lineIndex)
    if (rowIndex < 0) return
    const host = hostRef.current
    const viewport = host?.querySelector<HTMLElement>('.v3-code-scroller')
    const row = viewport?.querySelector<HTMLElement>(`[data-line="${range.first}"]`)
    if (viewport && row) {
      const box = viewport.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      if (rect.top >= box.top && rect.bottom <= box.bottom) return
    }
    listRef.current?.scrollToIndex(rowIndex, { align: 'center' })
  })

  const moveCurrent = (delta: number): void => {
    if (!rows.length) return
    const at = current === null ? -1 : rowIndexOfLine(rows, current)
    const nextRow = Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta))
    setCurrent(rows[nextRow])
    listRef.current?.scrollToIndex(nextRow, { align: 'nearest' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveCurrent(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (current === null || !regions.has(current)) return
    if ((event.key === 'ArrowLeft' && !folded.has(current)) || (event.key === 'ArrowRight' && folded.has(current))) {
      event.preventDefault()
      toggleFold(current)
    }
  }

  const width = numberColumnWidth(lines.length, firstNumber)
  const hostStyle = { '--code-number-width': `${width}ch`, tabSize: settings.tabSize } as CSSProperties
  const inRange = (number: number): boolean => !!range && number >= range.first && number <= range.last

  return (
    <div
      ref={hostRef}
      className="v3-code-view hljs"
      data-word-wrap={settings.wordWrap ? 'on' : 'off'}
      data-show-whitespace={settings.showWhitespace ? '' : undefined}
      data-testid="v3-code-view"
      style={hostStyle}
    >
      {tooSlow ? (
        <p role="note" className="v3-code-note">
          {labels.plainNote}
        </p>
      ) : null}
      <VList
        ref={listRef}
        data={data}
        className="v3-code-scroller"
        style={{ overflowX: settings.wordWrap ? 'hidden' : 'auto' }}
        role="region"
        aria-label={labels.label}
        tabIndex={0}
        bufferSize={400}
        onKeyDown={onKeyDown}
      >
        {(lineIndex) =>
          lineIndex === SPACER ? (
            <div key="spacer" className="v3-code-spacer" style={{ height: padding }} aria-hidden />
          ) : (
            <CodeLineRow
              key={lineIndex}
              line={lines[lineIndex]}
              index={lineIndex}
              number={lineIndex + firstNumber}
              guides={guides ? guides.levels[lineIndex] : 0}
              guideStep={guides?.unit ?? settings.tabSize}
              foldable={regions.has(lineIndex)}
              folded={folded.has(lineIndex)}
              active={current === lineIndex || inRange(lineIndex + firstNumber)}
              showWhitespace={settings.showWhitespace}
              labels={labels}
              onToggleFold={toggleFold}
              onPick={pick}
            />
          )
        }
      </VList>
    </div>
  )
}
