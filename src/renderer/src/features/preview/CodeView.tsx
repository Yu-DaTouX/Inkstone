import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { Check, ChevronDown, ChevronRight, Hash, Plus } from 'lucide-react'
import { VList, type VListHandle } from 'virtua'
import { CloseButton, FindBar, IconButton, InputGroup, InputGroupAddon, InputGroupInput, InputGroupText, TextArea, TextField } from '../../ui'
import { exceedsHighlightLimits, FILE_HIGHLIGHT_LIMITS, highlightLanguage, highlightTree } from '../../lib/code-highlight'
import {
  capCodeText,
  CODE_LINE_LIMIT,
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
  wrapIndentColumns,
  type CodeLine,
  type CodeToken
} from './code-lines'
import {
  createFindSession,
  findMatches,
  findShortcut,
  findStatus,
  findStepKey,
  firstMatchFromLine,
  matchesByLine,
  rememberFindOptions,
  rememberedFindOptions,
  splitLineMatches,
  stepFindIndex,
  type CodeSegment,
  type FindMatch,
  type FindOptions,
  type FindResult,
  type FindSession,
  type MatchRange
} from './code-find'
import { parseLineLocation, goToLineShortcut, validateLineLocation, type LineLocation } from './code-go-to-line'
import { findOptionEntries, isFindOptionKey } from './find-options'
import { commentQuoteLines, commentRange, type LineCommentRange } from './code-line-comment'
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
  find: string
  findPlaceholder: string
  findMatchCase: string
  findWholeWord: string
  findRegexp: string
  findPrev: string
  findNext: string
  findClose: string
  findNoResults: string
  findInvalid: string
  findStatus: string
  goToLine: string
  goToPlaceholder: string
  goToInvalid: string
  goToInvalidRange: string
  goToClose: string
  commentOnLine: string
  commentOnLines: string
  commentPlaceholder: string
  commentSave: string
  commentCancel: string
  tooManyLines: string
}

export interface CodeComment {
  start: number
  end: number
  code: string
  text: string
}

export interface CodeViewProps {
  text: string
  name: string
  settings: FileViewSettings
  firstNumber?: number
  target?: CodeViewTarget | null
  labels: CodeViewText
  onComment?: (comment: CodeComment) => void
}

interface CommentDraft {
  key: string
  start: number
  end: number
  body: string
}

const SPACER = -1
const PLAIN_LANGUAGES = new Set(['plaintext', 'text', 'txt', 'plain', 'log'])
const MAC = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || '')

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

function renderSegment(segment: CodeSegment, key: number, showWhitespace: boolean, active: boolean): ReactNode {
  const node = renderToken({ text: segment.text, classes: segment.classes }, key, showWhitespace)
  if (!segment.match) return <span key={key}>{node}</span>
  return (
    <mark key={key} className="v3-code-find" data-active={active ? '' : undefined}>
      {node}
    </mark>
  )
}

const CodeLineRow = memo(function CodeLineRow({
  line,
  number,
  index,
  guides,
  guideStep,
  indent,
  foldable,
  folded,
  active,
  showWhitespace,
  labels,
  matches,
  activeMatch,
  commented,
  pendingComment,
  comment,
  commentLabel,
  onToggleFold,
  onPick,
  onCommentStart,
  onCommentOpen,
  onCommentChange,
  onCommentSave,
  onCommentCancel
}: {
  line: CodeLine
  number: number
  index: number
  guides: number
  guideStep: number
  indent: number
  foldable: boolean
  folded: boolean
  active: boolean
  showWhitespace: boolean
  labels: CodeViewText
  matches?: readonly MatchRange[]
  activeMatch?: MatchRange | null
  commented: boolean
  pendingComment: boolean
  comment?: CommentDraft
  commentLabel: string
  onToggleFold: (index: number) => void
  onPick: (index: number) => void
  onCommentStart: (event: ReactPointerEvent<HTMLButtonElement>, number: number) => void
  onCommentOpen: (number: number) => void
  onCommentChange: (key: string, body: string) => void
  onCommentSave: (key: string) => void
  onCommentCancel: (key: string) => void
}) {
  const style = {
    ...(guides > 0 ? { '--code-guides': String(guides), '--code-guide-step': `${guideStep}ch` } : {}),
    ...(indent > 0 ? { '--code-indent-ch': String(indent) } : {})
  } as CSSProperties
  const segments = useMemo(() => (matches && matches.length ? splitLineMatches(line, matches) : null), [line, matches])
  return (
    <div
      className="v3-code-line"
      data-line={number}
      data-active={active ? '' : undefined}
      data-comment={commented ? '' : undefined}
      data-pending-comment={pendingComment ? '' : undefined}
      onMouseDown={() => onPick(index)}
    >
      <span className="v3-code-gutter">
        <button
          type="button"
          tabIndex={active ? 0 : -1}
          className="v3-code-comment"
          aria-label={commentLabel}
          title={commentLabel}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => onCommentStart(event, number)}
          onClick={(event) => {
            if (event.detail === 0) onCommentOpen(number)
          }}
        >
          <Plus size={12} aria-hidden />
        </button>
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
        {segments
          ? segments.map((segment, key) =>
              renderSegment(segment, key, showWhitespace, !!activeMatch && activeMatch.start === segment.start)
            )
          : line.map((token, key) => renderToken(token, key, showWhitespace))}
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
      {comment ? (
        <LineCommentCard
          draft={comment}
          label={commentLabelOf(labels, { start: comment.start, end: comment.end })}
          labels={labels}
          onChange={onCommentChange}
          onSave={onCommentSave}
          onCancel={onCommentCancel}
        />
      ) : null}
    </div>
  )
})

function commentLabelOf(labels: CodeViewText, range: LineCommentRange): string {
  return range.start === range.end
    ? labels.commentOnLine.replace('{line}', String(range.start))
    : labels.commentOnLines.replace('{start}', String(range.start)).replace('{end}', String(range.end))
}

function LineCommentCard({
  draft,
  label,
  labels,
  onChange,
  onSave,
  onCancel
}: {
  draft: CommentDraft
  label: string
  labels: CodeViewText
  onChange: (key: string, body: string) => void
  onSave: (key: string) => void
  onCancel: (key: string) => void
}): ReactNode {
  return (
    <div className="v3-code-comment-card" data-testid="v3-code-comment" onMouseDown={(event) => event.stopPropagation()}>
      <span className="v3-code-comment-label">{label}</span>
      <TextArea
        className="v3-code-comment-field"
        textAreaClassName="v3-code-comment-input"
        size="sm"
        aria-label={label}
        placeholder={labels.commentPlaceholder}
        value={draft.body}
        rows={1}
        autoFocus
        onChange={(value) => onChange(draft.key, value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel(draft.key)
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
            event.preventDefault()
            event.stopPropagation()
            onSave(draft.key)
          }
        }}
      />
      <span className="v3-code-comment-actions">
        <IconButton
          size="sm"
          aria-label={labels.commentSave}
          tooltip={labels.commentSave}
          tooltipShortcut="Enter"
          isDisabled={!draft.body.trim()}
          onPress={() => onSave(draft.key)}
        >
          <Check size={14} />
        </IconButton>
        <CloseButton size="sm" aria-label={labels.commentCancel} tooltip={labels.commentCancel} tooltipShortcut="Esc" onPress={() => onCancel(draft.key)} />
      </span>
    </div>
  )
}

const EMPTY_FIND_RESULT: FindResult = { matches: [], invalid: false, capped: false }

export function CodeView({ text, name, settings, firstNumber = 1, target, labels, onComment }: CodeViewProps) {
  const listRef = useRef<VListHandle>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const language = useMemo(() => pickLanguage(name, (value) => highlightLanguage(value) !== null), [name])
  const limited = useMemo(() => capCodeText(text.replace(/\r\n/g, '\n')), [text])
  const source = limited.text
  const tree = useMemo(() => (language ? highlightTree(source, language, FILE_HIGHLIGHT_LIMITS) : null), [source, language])
  const tooSlow = useMemo(
    () => !!language && !PLAIN_LANGUAGES.has(language) && highlightLanguage(language) !== null && !tree && exceedsHighlightLimits(source, FILE_HIGHLIGHT_LIMITS),
    [language, tree, source]
  )
  const lines = useMemo(() => splitHighlightedLines(tree, source), [tree, source])
  const texts = useMemo(() => lines.map(lineText), [lines])
  const guides = useMemo(() => (settings.indentGuides ? guideLevels(texts, settings.tabSize) : null), [texts, settings.indentGuides, settings.tabSize])
  const indents = useMemo(() => (settings.wordWrap ? wrapIndentColumns(texts, settings.tabSize) : null), [texts, settings.wordWrap, settings.tabSize])
  const regions = useMemo(() => foldRegions(texts, settings.tabSize), [texts, settings.tabSize])
  const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set())
  const [current, setCurrent] = useState<number | null>(null)
  const [padding, setPadding] = useState(0)
  const [seenTexts, setSeenTexts] = useState(texts)
  const [bar, setBar] = useState<'find' | 'goto' | null>(null)
  const [findQuery, setFindQuery] = useState('')
  const [findOptions, setFindOptions] = useState<FindOptions>(rememberedFindOptions)
  const [findIndex, setFindIndex] = useState(-1)
  const [gotoQuery, setGotoQuery] = useState('')
  const [goTo, setGoTo] = useState<(LineLocation & { nonce: number }) | null>(null)
  const [drafts, setDrafts] = useState<CommentDraft[]>([])
  const [pendingComment, setPendingComment] = useState<LineCommentRange | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const gotoInputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<LineCommentRange | null>(null)
  const dragStopRef = useRef<(() => void) | null>(null)
  const findSessionRef = useRef<FindSession | null>(null)
  if (!findSessionRef.current) findSessionRef.current = createFindSession()
  if (seenTexts !== texts) {
    setSeenTexts(texts)
    setFolded(new Set())
    setCurrent(null)
    setDrafts([])
    setPendingComment(null)
  }
  const rows = useMemo(() => visibleLineIndexes(lines.length, regions, folded), [lines.length, regions, folded])
  const data = useMemo(() => (settings.scrollPastEnd ? [...rows, SPACER] : rows), [rows, settings.scrollPastEnd])
  const range = target ? jumpRange(target.line, target.lineEnd) : null
  const lastNumber = firstNumber + Math.max(0, lines.length - 1)

  const literalSearch = useMemo(
    () => (findOptions.regexp ? EMPTY_FIND_RESULT : findMatches(texts, bar === 'find' ? findQuery : '', findOptions)),
    [texts, bar, findQuery, findOptions]
  )
  const [regexSearch, setRegexSearch] = useState<FindResult>(EMPTY_FIND_RESULT)
  useEffect(() => {
    if (!findOptions.regexp) return
    const activeQuery = bar === 'find' ? findQuery : ''
    if (!activeQuery) {
      setRegexSearch(EMPTY_FIND_RESULT)
      return
    }
    let live = true
    findSessionRef.current!.find(texts, activeQuery, findOptions).then((result) => {
      if (live) setRegexSearch(result)
    })
    return () => {
      live = false
    }
  }, [texts, bar, findQuery, findOptions])
  useEffect(() => () => findSessionRef.current?.dispose(), [])
  const search = findOptions.regexp ? regexSearch : literalSearch
  const activeIndex = search.matches.length ? Math.min(Math.max(findIndex, 0), search.matches.length - 1) : -1
  const activeMatch: FindMatch | null = activeIndex >= 0 ? search.matches[activeIndex] : null
  const lineMatches = useMemo(() => matchesByLine(search.matches), [search.matches])

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

  const scroller = (): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>('.v3-code-scroller') ?? null
  const focusScroller = (): void => {
    scroller()?.focus({ preventScroll: true })
  }

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

  useLayoutEffect(() => {
    if (bar !== 'find' || !activeMatch) return
    const revealed = unfoldToReveal(regions, folded, activeMatch.line)
    if (revealed.size !== folded.size) {
      setFolded(revealed)
      return
    }
    const rowIndex = rowIndexOfLine(rows, activeMatch.line)
    if (rowIndex >= 0) listRef.current?.scrollToIndex(rowIndex, { align: 'center' })
    setCurrent(activeMatch.line)
  }, [bar, activeMatch, folded, regions, rows])

  useLayoutEffect(() => {
    if (!goTo) return
    const lineIndex = goTo.line - firstNumber
    if (lineIndex < 0 || lineIndex >= lines.length) return
    const revealed = unfoldToReveal(regions, folded, lineIndex)
    if (revealed.size !== folded.size) {
      setFolded(revealed)
      return
    }
    setCurrent(lineIndex)
    const rowIndex = rowIndexOfLine(rows, lineIndex)
    if (rowIndex >= 0) listRef.current?.scrollToIndex(rowIndex, { align: 'center' })
    if (goTo.column && !settings.wordWrap) scrollToColumn(hostRef.current, scroller(), goTo.column)
    setGoTo(null)
  }, [goTo, folded, regions, rows, lines.length, firstNumber, settings.wordWrap])

  const openFind = useCallback((): void => {
    setBar('find')
    setFindIndex(findOptions.regexp ? 0 : firstMatchFromLine(findMatches(texts, findQuery, findOptions).matches, current))
    const input = findInputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [texts, findQuery, findOptions, current])

  const openGoTo = useCallback((): void => {
    setBar('goto')
    setGotoQuery('')
    const input = gotoInputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [])

  const closeBar = useCallback((): void => {
    setBar(null)
    setGotoQuery('')
    requestAnimationFrame(focusScroller)
  }, [])

  const stepFind = (delta: number): void => {
    if (!search.matches.length) return
    const next = stepFindIndex(activeIndex, delta, search.matches.length)
    setFindIndex(next)
    const match = search.matches[next]
    if (match) setCurrent(match.line)
  }

  const toggleFindOption = (key: keyof FindOptions): void => {
    const next = rememberFindOptions({ ...findOptions, [key]: !findOptions[key] })
    setFindOptions(next)
    setFindIndex(next.regexp ? 0 : firstMatchFromLine(findMatches(texts, findQuery, next).matches, current))
  }

  const submitGoTo = (): void => {
    const location = validateLineLocation(parseLineLocation(gotoQuery), lastNumber, firstNumber)
    if (!location) return
    setGoTo({ ...location, nonce: (goTo?.nonce ?? 0) + 1 })
    setBar(null)
    setGotoQuery('')
    requestAnimationFrame(focusScroller)
  }

  const openDraft = (start: number, end: number): void => {
    const next = commentRange(start, end, lastNumber)
    if (next) setDrafts((prev) => [...prev.filter((draft) => !(draft.start === next.start && draft.end === next.end)), { key: `${next.start}:${next.end}`, ...next, body: '' }])
  }

  const startComment = (event: ReactPointerEvent<HTMLButtonElement>, number: number): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setPendingComment({ start: number, end: number })
    dragRef.current = { start: number, end: number }
    const move = (moveEvent: PointerEvent): void => {
      const row = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>('.v3-code-line')
      const value = row ? Number(row.dataset.line) : NaN
      if (!Number.isInteger(value)) return
      const next = commentRange(number, value, lastNumber)
      if (!next) return
      dragRef.current = next
      setPendingComment(next)
    }
    const stop = (): void => {
      dragStopRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', abort)
      window.removeEventListener('keydown', escape, true)
    }
    dragStopRef.current = stop
    const finish = (): void => {
      const dragged = dragRef.current
      stop()
      dragRef.current = null
      setPendingComment(null)
      if (dragged) openDraft(dragged.start, dragged.end)
    }
    const abort = (): void => {
      stop()
      dragRef.current = null
      setPendingComment(null)
    }
    const escape = (press: KeyboardEvent): void => {
      if (press.key !== 'Escape') return
      press.preventDefault()
      abort()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('keydown', escape, true)
  }

  useEffect(() => () => {
    dragRef.current = null
    dragStopRef.current?.()
  }, [])

  const updateDraft = useCallback((key: string, body: string): void => setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, body } : draft))), [])
  const cancelDraft = useCallback((key: string): void => setDrafts((prev) => prev.filter((draft) => draft.key !== key)), [])
  const saveDraft = useCallback(
    (key: string): void => {
      const draft = drafts.find((item) => item.key === key)
      if (!draft) return
      const body = draft.body.trim()
      if (!body || !onComment) return
      const code = commentQuoteLines(texts, firstNumber, draft).join('\n')
      onComment?.({ start: draft.start, end: draft.end, code, text: body })
      setDrafts((prev) => prev.filter((item) => item.key !== key))
    },
    [drafts, texts, firstNumber, onComment]
  )

  const moveCurrent = (delta: number): void => {
    if (!rows.length) return
    const at = current === null ? -1 : rowIndexOfLine(rows, current)
    const nextRow = Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta))
    setCurrent(rows[nextRow])
    listRef.current?.scrollToIndex(nextRow, { align: 'nearest' })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if ((event.target as HTMLElement).closest('input, textarea')) return
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

  const onHostKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    const findAction = findShortcut(
      { key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey },
      MAC
    )
    if (findAction === 'open') {
      event.preventDefault()
      event.stopPropagation()
      openFind()
      return
    }
    if (goToLineShortcut({ key: event.key, code: event.code, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey })) {
      event.preventDefault()
      event.stopPropagation()
      openGoTo()
      return
    }
    if (bar && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeBar()
    }
  }

  const onBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    closeBar()
  }

  const onFindBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.key !== 'F3') {
      onBarKeyDown(event)
      return
    }
    const delta = findStepKey(event.key, event.shiftKey)
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    stepFind(delta)
  }

  const onGotoInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    submitGoTo()
  }

  useEffect(() => {
    if (bar === 'find') {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    } else if (bar === 'goto') {
      gotoInputRef.current?.focus()
      gotoInputRef.current?.select()
    }
  }, [bar])

  const width = numberColumnWidth(lines.length, firstNumber)
  const hostStyle = { '--code-number-width': `${width}ch`, tabSize: settings.tabSize } as CSSProperties
  const inRange = (number: number): boolean => !!range && number >= range.first && number <= range.last
  const pending = pendingComment
  const status = findStatus(activeIndex, search.matches.length, search.capped)
  const statusText = !findQuery
    ? ''
    : search.invalid
      ? labels.findInvalid
      : !search.matches.length
        ? labels.findNoResults
        : labels.findStatus
            .replace('{current}', String(status.current))
            .replace('{total}', `${status.total.toLocaleString()}${status.capped ? '+' : ''}`)
  const gotoLocation = parseLineLocation(gotoQuery)
  const gotoInvalid = gotoQuery.trim().length > 0 && !validateLineLocation(gotoLocation, lastNumber, firstNumber)
  const gotoInvalidText =
    firstNumber > 1
      ? labels.goToInvalidRange.replace('{first}', String(firstNumber)).replace('{last}', String(lastNumber))
      : labels.goToInvalid.replace('{lines}', String(lastNumber))

  return (
    <div
      ref={hostRef}
      className="v3-code-view hljs"
      data-word-wrap={settings.wordWrap ? 'on' : 'off'}
      data-show-whitespace={settings.showWhitespace ? '' : undefined}
      data-testid="v3-code-view"
      style={hostStyle}
      onKeyDown={onHostKeyDown}
    >
      {tooSlow ? (
        <p role="note" className="v3-code-note">
          {labels.plainNote}
        </p>
      ) : null}
      {limited.capped ? (
        <p role="note" className="v3-code-note" data-testid="v3-code-capped">
          {labels.tooManyLines.replace('{n}', String(CODE_LINE_LIMIT))}
        </p>
      ) : null}
      {bar === 'find' ? (
        <div className="v3-code-bar v3-code-bar--find" data-testid="v3-code-findbar" onKeyDown={onFindBarKeyDown}>
          <FindBar
            value={findQuery}
            onChange={(value) => {
              setFindQuery(value)
              setFindIndex(0)
            }}
            onNext={() => stepFind(1)}
            onPrevious={() => stepFind(-1)}
            onClose={closeBar}
            matchIndex={activeIndex}
            matchCount={findQuery ? search.matches.length : null}
            status={statusText || null}
            options={findOptionEntries(labels, findOptions)}
            onOptionChange={(id) => {
              if (isFindOptionKey(id)) toggleFindOption(id)
            }}
            placeholder={labels.findPlaceholder}
            labels={{ input: labels.find, previous: labels.findPrev, next: labels.findNext, close: labels.findClose }}
            inputRef={findInputRef}
            className="v3-code-findbar"
          />
        </div>
      ) : null}
      {bar === 'goto' ? (
        <div className="v3-code-bar" role="search" aria-label={labels.goToLine} data-testid="v3-code-gotobar" onKeyDown={onBarKeyDown}>
          <TextField
            className="v3-code-bar-field"
            aria-label={labels.goToLine}
            value={gotoQuery}
            isInvalid={gotoInvalid}
            onChange={setGotoQuery}
          >
            <InputGroup size="sm">
              <InputGroupAddon align="start">
                <Hash size={14} aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                ref={gotoInputRef}
                placeholder={labels.goToPlaceholder}
                spellCheck={false}
                autoComplete="off"
                data-testid="v3-code-goto-input"
                onKeyDown={onGotoInputKeyDown}
              />
              {gotoInvalid ? (
                <InputGroupAddon align="end">
                  <InputGroupText className="v3-code-bar-status" aria-live="polite">
                    {gotoInvalidText}
                  </InputGroupText>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </TextField>
          <CloseButton size="sm" aria-label={labels.goToClose} tooltip={labels.goToClose} tooltipShortcut="Esc" data-testid="v3-code-goto-close" onPress={closeBar} />
        </div>
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
            (() => {
              const number = lineIndex + firstNumber
              const comment = drafts.find((draft) => draft.end === number)
              return (
                <CodeLineRow
                  key={lineIndex}
                  line={lines[lineIndex]}
                  index={lineIndex}
                  number={number}
                  guides={guides ? guides.levels[lineIndex] : 0}
                  guideStep={guides?.unit ?? settings.tabSize}
                  indent={indents ? indents[lineIndex] : 0}
                  foldable={regions.has(lineIndex)}
                  folded={folded.has(lineIndex)}
                  active={current === lineIndex || inRange(number)}
                  showWhitespace={settings.showWhitespace}
                  labels={labels}
                  matches={lineMatches.get(lineIndex)}
                  activeMatch={activeMatch && activeMatch.line === lineIndex ? activeMatch : null}
                  commented={drafts.some((draft) => number >= draft.start && number <= draft.end)}
                  pendingComment={!!pending && number >= pending.start && number <= pending.end}
                  comment={comment}
                  commentLabel={labels.commentOnLine.replace('{line}', String(number))}
                  onToggleFold={toggleFold}
                  onPick={pick}
                  onCommentStart={startComment}
                  onCommentOpen={(number) => openDraft(number, number)}
                  onCommentChange={updateDraft}
                  onCommentSave={saveDraft}
                  onCommentCancel={cancelDraft}
                />
              )
            })()
          )
        }
      </VList>
    </div>
  )
}

function scrollToColumn(host: HTMLElement | null, viewport: HTMLElement | null, column: number): void {
  if (!host || !viewport) return
  const sample = document.createElement('span')
  sample.textContent = '0000000000'
  sample.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit'
  host.appendChild(sample)
  const width = sample.getBoundingClientRect().width / 10
  sample.remove()
  if (!(width > 0)) return
  viewport.scrollLeft = Math.max(0, (column - 1) * width - viewport.clientWidth / 2)
}
