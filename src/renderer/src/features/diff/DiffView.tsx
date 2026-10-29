import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { VList, type VListHandle } from 'virtua'
import { ChevronDown, ChevronUp, Columns2, Plus, Rows3 } from 'lucide-react'
import { Button, IconButton, cx } from '../../ui'
import { alignHunk, type DiffSideRow } from './align'
import { DiffAnnotationEditor, type DiffAnnotate, type DiffAnnotateLabels } from './DiffAnnotation'
import { foldLines } from './fold'
import {
  byteLength,
  DIFF_LIMITS,
  formatBytes
} from './limits'
import { parsePatch } from './parse'
import { hunkSeparators, unifiedLineNumber } from './separators'
import { diffViewText, type DiffViewText } from './text'
import type { DiffFile, DiffLine, DiffViewMode } from './types'
import { wordDiff } from './word-diff'
import './diff-view.css'

export interface DiffViewProps {
  patch: string
  title?: string
  mode?: DiffViewMode
  defaultMode?: DiffViewMode
  onModeChange?: (mode: DiffViewMode) => void
  context?: number
  showFileHeader?: boolean
  embedded?: boolean
  lang?: string
  className?: string
  maxBytes?: number
  lineSlot?: (line: DiffLine, side: 'new' | 'old') => ReactNode
  annotate?: DiffAnnotate
}

type RenderRow =
  | { kind: 'file'; key: string; file: DiffFile }
  | { kind: 'hunk'; key: string; text: string; title: string; separator: 'lines' | 'metadata'; first: boolean; last: boolean }
  | { kind: 'line'; key: string; line: DiffLine }
  | { kind: 'gap'; key: string; gapId: string; count: number; first: boolean; last?: boolean }
  | { kind: 'split'; key: string; row: DiffSideRow }
  | { kind: 'note'; key: string; text: string }

export function DiffView({
  patch,
  title,
  mode: modeProp,
  defaultMode = 'unified',
  onModeChange,
  context = DIFF_LIMITS.contextLines,
  showFileHeader = true,
  embedded = false,
  lang,
  className,
  maxBytes = DIFF_LIMITS.maxBytes,
  lineSlot,
  annotate
}: DiffViewProps): ReactElement {
  const text = useMemo(() => diffViewText(lang ?? 'zh-CN'), [lang])
  const [internalMode, setInternalMode] = useState<DiffViewMode>(defaultMode)
  const mode = modeProp ?? internalMode
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [hunkCursor, setHunkCursor] = useState(-1)
  const [forceLarge, setForceLarge] = useState(false)
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [seenPatch, setSeenPatch] = useState(patch)
  if (seenPatch !== patch) {
    setSeenPatch(patch)
    setExpanded(new Set())
    setHunkCursor(-1)
    setForceLarge(false)
    setSelection(null)
    setDraft(null)
  }

  const parsed = useMemo(() => parsePatch(patch), [patch])
  const bytes = useMemo(() => byteLength(patch), [patch])
  const tooLarge = bytes > maxBytes
  const exceedHard = bytes > DIFF_LIMITS.hardMaxBytes

  const rows = useMemo(() => buildRows(parsed.files, mode, expanded, context, showFileHeader, text), [parsed, mode, expanded, context, showFileHeader, text])
  const hunkRows = useMemo(() => {
    const out: number[] = []
    rows.forEach((row, index) => {
      if (row.kind === 'hunk') out.push(index)
    })
    return out
  }, [rows])

  const vlistRef = useRef<VListHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const setMode = (next: DiffViewMode): void => {
    if (modeProp === undefined) setInternalMode(next)
    onModeChange?.(next)
    setSelection(null)
    setDraft(null)
  }
  const expandGap = (gapId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(gapId)
      return next
    })
  }
  const scrollToRow = (index: number): void => {
    if (rows.length >= DIFF_LIMITS.virtualizeAt) vlistRef.current?.scrollToIndex(index, { align: 'start' })
    else bodyRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({ block: 'start' })
  }
  const dragRef = useRef<{ from: number; to: number } | null>(null)
  const stopDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDragRef.current?.(), [])

  const openAnnotation = (from: number, to: number): void => {
    const first = Math.max(0, Math.min(from, to))
    const last = Math.min(rows.length - 1, Math.max(from, to))
    if (!annotationRange(rows, first, last)) return
    setSelection(null)
    setDraft({ at: last, from: first, to: last, body: '' })
  }

  const beginAnnotation = (event: ReactPointerEvent<HTMLButtonElement>, index: number): void => {
    if (!annotate || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stopDragRef.current?.()
    setDraft(null)
    setSelection({ from: index, to: index })
    dragRef.current = { from: index, to: index }
    const move = (moveEvent: PointerEvent): void => {
      const host = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>('[data-row]')
      const value = host ? Number(host.dataset.row) : Number.NaN
      if (!Number.isInteger(value)) return
      const next = { from: index, to: Math.max(0, Math.min(rows.length - 1, value)) }
      dragRef.current = next
      setSelection(next)
    }
    const stop = (): void => {
      stopDragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', abort)
      window.removeEventListener('keydown', escape, true)
    }
    const finish = (): void => {
      const dragged = dragRef.current
      stop()
      dragRef.current = null
      if (dragged) openAnnotation(dragged.from, dragged.to)
      else setSelection(null)
    }
    const abort = (): void => {
      stop()
      dragRef.current = null
      setSelection(null)
    }
    const escape = (press: KeyboardEvent): void => {
      if (press.key !== 'Escape') return
      press.preventDefault()
      abort()
    }
    stopDragRef.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('keydown', escape, true)
  }

  const annotationOf = (index?: number): RowAnnotate | undefined => {
    if (!annotate || index === undefined) return undefined
    return {
      labels: annotate.labels,
      selected:
        selection !== null &&
        index >= Math.min(selection.from, selection.to) &&
        index <= Math.max(selection.from, selection.to),
      start: (event: ReactPointerEvent<HTMLButtonElement>) => beginAnnotation(event, index),
      open: () => openAnnotation(index, index)
    }
  }

  const draftRange = draft ? annotationRange(rows, draft.from, draft.to) : null

  const submitAnnotation = (): void => {
    if (!annotate || !draft || !draftRange) return
    const body = draft.body.trim()
    if (!body) return
    annotate.onSubmit({ start: draftRange.start, end: draftRange.end, code: draftRange.code, text: body })
    setDraft(null)
  }

  const renderAnnotated = (row: RenderRow, index?: number): ReactElement => (
    <Fragment key={row.key}>
      {renderRow(row, text, expandGap, lineSlot, index, annotationOf(index))}
      {annotate && draft && draftRange && draft.at === index ? (
        <DiffAnnotationEditor
          labels={annotate.labels}
          range={
            draftRange.start === draftRange.end
              ? annotate.labels.line(draftRange.start)
              : annotate.labels.lines(draftRange.start, draftRange.end)
          }
          value={draft.body}
          onChange={(value) => setDraft((prev) => (prev ? { ...prev, body: value } : prev))}
          onSubmit={submitAnnotation}
          onCancel={() => setDraft(null)}
        />
      ) : null}
    </Fragment>
  )

  const goHunk = (delta: number): void => {
    if (hunkRows.length === 0) return
    const next = hunkCursor < 0 ? (delta > 0 ? 0 : hunkRows.length - 1) : Math.max(0, Math.min(hunkRows.length - 1, hunkCursor + delta))
    setHunkCursor(next)
    scrollToRow(hunkRows[next])
  }

  const shell = (children: ReactNode): ReactElement => (
    <div className={cx('diff-view', embedded && 'diff-view--embedded', className)}>{children}</div>
  )

  if (!patch.trim()) return shell(<div className="diff-view__empty">{text.empty}</div>)

  if (tooLarge && (!forceLarge || exceedHard)) {
    return shell(
      <div className="diff-view__degrade">
        <p className="diff-view__degrade-text">{text.tooLarge(formatBytes(bytes))}</p>
        {exceedHard ? null : (
          <Button size="sm" onPress={() => setForceLarge(true)}>
            {text.renderAnyway}
          </Button>
        )}
      </div>
    )
  }

  const virtual = !embedded && rows.length >= DIFF_LIMITS.virtualizeAt

  const body =
    rows.length === 0 ? (
      <div className="diff-view__empty">{text.empty}</div>
    ) : virtual ? (
      <VList ref={vlistRef} data={rows} className="diff-view__body" bufferSize={600}>
        {renderAnnotated}
      </VList>
    ) : (
      <div className="diff-view__body" ref={bodyRef}>
        {rows.map((row, index) => renderAnnotated(row, index))}
      </div>
    )

  return (
    <section
      className={cx('diff-view', embedded && 'diff-view--embedded', className)}
      aria-label={title ?? text.fileHeader}
    >
      {embedded ? null : (
        <div className="diff-view__bar">
          <div className="diff-view__modes" role="group">
            <Button
              size="sm"
              variant={mode === 'unified' ? 'primary' : 'secondary'}
              icon={<Rows3 size={14} aria-hidden="true" />}
              onPress={() => setMode('unified')}
            >
              {text.unified}
            </Button>
            <Button
              size="sm"
              variant={mode === 'split' ? 'primary' : 'secondary'}
              icon={<Columns2 size={14} aria-hidden="true" />}
              onPress={() => setMode('split')}
            >
              {text.split}
            </Button>
          </div>
          {hunkRows.length > 0 ? (
            <div className="diff-view__nav">
              <IconButton size="sm" aria-label={text.prevHunk} title={text.prevHunk} isDisabled={hunkCursor <= 0} onPress={() => goHunk(-1)}>
                <ChevronUp size={14} aria-hidden="true" />
              </IconButton>
              <span className="diff-view__nav-label" aria-live="polite">
                {hunkCursor < 0 ? `— / ${hunkRows.length}` : text.hunkOf(hunkCursor + 1, hunkRows.length)}
              </span>
              <IconButton
                size="sm"
                aria-label={text.nextHunk}
                title={text.nextHunk}
                isDisabled={hunkCursor >= hunkRows.length - 1}
                onPress={() => goHunk(1)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </IconButton>
            </div>
          ) : null}
        </div>
      )}
      {body}
    </section>
  )
}

function buildRows(
  files: DiffFile[],
  mode: DiffViewMode,
  expanded: Set<string>,
  keep: number,
  showFileHeader: boolean,
  text: DiffViewText
): RenderRow[] {
  const rows: RenderRow[] = []
  let seq = 0
  const key = (prefix: string): string => `${prefix}${seq++}`

  files.forEach((file, fileIndex) => {
    if (showFileHeader || file.binary) rows.push({ kind: 'file', key: key('f'), file })
    if (file.binary) {
      rows.push({ kind: 'note', key: key('n'), text: text.binaryFile })
      return
    }
    const separators = hunkSeparators(file.hunks, text.unmodified)
    file.hunks.forEach((hunk, hunkIndex) => {
      const separator = separators[hunkIndex]
      if (separator) {
        rows.push({
          kind: 'hunk',
          key: key('h'),
          text: separator.text,
          title: hunk.header,
          separator: separator.kind,
          first: hunkIndex === 0,
          last: hunkIndex === file.hunks.length - 1
        })
      }
      const bodyStart = rows.length
      let buffer: DiffLine[] = []
      const flush = (): void => {
        if (buffer.length === 0) return
        if (mode === 'split') {
          for (const row of alignHunk(buffer)) rows.push({ kind: 'split', key: key('s'), row })
        } else {
          for (const line of buffer) rows.push({ kind: 'line', key: key('l'), line })
        }
        buffer = []
      }
      foldLines(hunk.lines, keep).forEach((folded, foldIndex) => {
        if (folded.kind === 'line') {
          buffer.push(folded.line)
          return
        }
        const gapId = `${fileIndex}:${hunkIndex}:${foldIndex}`
        if (expanded.has(gapId)) {
          buffer.push(...folded.lines)
          return
        }
        flush()
        rows.push({
          kind: 'gap',
          key: key('g'),
          gapId,
          count: folded.count,
          first: rows.length === bodyStart
        })
      })
      flush()
      const tail = rows[rows.length - 1]
      if (tail?.kind === 'gap') tail.last = true
    })
  })
  return rows
}

type LineSlot = (line: DiffLine, side: 'new' | 'old') => ReactNode

interface AnnotationDraft {
  at: number
  from: number
  to: number
  body: string
}

interface RowAnnotate {
  labels: DiffAnnotateLabels
  selected: boolean
  start: (event: ReactPointerEvent<HTMLButtonElement>) => void
  open: () => void
}

interface AnnotationRange {
  start: number
  end: number
  code: string
}

function lineOfRow(row: RenderRow): DiffLine | null {
  if (row.kind === 'line') return row.line
  if (row.kind === 'split') return row.row.right ?? row.row.left
  return null
}

function annotationRange(rows: readonly RenderRow[], from: number, to: number): AnnotationRange | null {
  const first = Math.max(0, Math.min(from, to))
  const last = Math.min(rows.length - 1, Math.max(from, to))
  const texts: string[] = []
  let start: number | null = null
  let end: number | null = null
  for (let index = first; index <= last; index += 1) {
    const row = rows[index]
    const line = row ? lineOfRow(row) : null
    if (!line) continue
    const number = unifiedLineNumber(line)
    if (number === null) continue
    if (start === null) start = number
    end = number
    texts.push(line.text)
  }
  if (start === null || end === null) return null
  return { start, end: Math.max(start, end), code: texts.join('\n') }
}

function annotateButton(annotate: RowAnnotate, number: number | null): ReactElement {
  const label = number === null ? annotate.labels.add : `${annotate.labels.add} ${number}`
  return (
    <button
      type="button"
      className="diff-view__annotate"
      aria-label={label}
      title={label}
      onPointerDown={annotate.start}
      onClick={(event) => {
        if (event.detail === 0) annotate.open()
      }}
    >
      <Plus size={11} aria-hidden="true" />
    </button>
  )
}

function renderRow(
  row: RenderRow,
  text: DiffViewText,
  onExpand: (gapId: string) => void,
  lineSlot?: LineSlot,
  rowIndex?: number,
  annotate?: RowAnnotate
): ReactElement {
  const attrs = rowIndex === undefined ? {} : { 'data-row': rowIndex }
  switch (row.kind) {
    case 'file':
      return (
        <div key={row.key} {...attrs} className="diff-view__file">
          <span className="diff-view__file-path" title={row.file.path}>
            {row.file.path || '—'}
          </span>
          {row.file.binary ? null : (
            <span className="diff-view__file-stat">
              <span className="diff-view__stat-add">+{row.file.additions}</span>
              <span className="diff-view__stat-del">−{row.file.deletions}</span>
            </span>
          )}
        </div>
      )
    case 'hunk':
      return (
        <div
          key={row.key}
          {...attrs}
          className="diff-view__separator"
          data-separator={row.separator}
          data-first={row.first || undefined}
          data-last={row.last || undefined}
          title={row.title}
        >
          <span className="diff-view__separator-text">{row.text}</span>
        </div>
      )
    case 'line':
      return (
        <div
          key={row.key}
          {...attrs}
          className={cx('diff-view__line', `diff-view__line--${row.line.kind}`)}
          data-old-line={row.line.oldLine ?? undefined}
          data-new-line={row.line.newLine ?? undefined}
          data-annotate-selected={annotate?.selected ? '' : undefined}
        >
          <span className="diff-view__num">
            {annotate ? annotateButton(annotate, unifiedLineNumber(row.line)) : null}
            {unifiedLineNumber(row.line) ?? ''}
          </span>
          <span className="diff-view__code">
            <span className="diff-view__sign" aria-hidden="true">
              {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ' '}
            </span>
            {row.line.text === '' ? '\u00a0' : row.line.text}
            {row.line.noNewline ? <span className="diff-view__noeol">{text.noNewline}</span> : null}
          </span>
          {lineSlot ? lineSlot(row.line, row.line.kind === 'del' ? 'old' : 'new') : null}
        </div>
      )
    case 'gap':
      return (
        <div
          key={row.key}
          {...attrs}
          className="diff-view__separator diff-view__separator--expand"
          data-separator="lines"
          data-first={row.first || undefined}
          data-last={row.last || undefined}
        >
          <Button size="sm" variant="ghost" className="diff-view__separator-button" onPress={() => onExpand(row.gapId)}>
            {text.expandLines(row.count)}
          </Button>
        </div>
      )
    case 'split':
      return <SplitRow key={row.key} {...attrs} row={row.row} lineSlot={lineSlot} annotate={annotate} />
    case 'note':
      return (
        <div key={row.key} {...attrs} className="diff-view__note">
          {row.text}
        </div>
      )
  }
}

function SplitRow({
  row,
  lineSlot,
  annotate,
  'data-row': dataRow
}: {
  row: DiffSideRow
  lineSlot?: LineSlot
  annotate?: RowAnnotate
  'data-row'?: number
}): ReactElement {
  const diff = useMemo(
    () => (row.kind === 'replace' && row.left && row.right ? wordDiff(row.left.text, row.right.text) : null),
    [row]
  )
  const cell = (side: 'left' | 'right'): ReactElement => {
    const line = side === 'left' ? row.left : row.right
    if (!line) return <div className="diff-view__cell diff-view__cell--empty" />
    const sideClass = row.kind === 'context' ? 'diff-view__cell--context' : side === 'left' ? 'diff-view__cell--del' : 'diff-view__cell--add'
    const segments = diff ? (side === 'left' ? diff.left : diff.right) : null
    const annotated = annotate && (row.right ? side === 'right' : side === 'left') ? annotate : undefined
    return (
      <div className={cx('diff-view__cell', sideClass)}>
        <span className="diff-view__gutter" data-annotate={annotated ? '' : undefined}>
          {annotated ? annotateButton(annotated, side === 'left' ? line.oldLine : line.newLine) : null}
          {side === 'left' ? line.oldLine ?? '' : line.newLine ?? ''}
        </span>
        <span className="diff-view__text">
          {segments
            ? segments.map((segment, index) =>
                segment.changed ? (
                  <span key={index} className="diff-view__word">
                    {segment.text}
                  </span>
                ) : (
                  <span key={index}>{segment.text}</span>
                )
              )
            : line.text === ''
              ? '\u00a0'
              : line.text}
        </span>
        {lineSlot ? lineSlot(line, side === 'left' ? 'old' : 'new') : null}
      </div>
    )
  }
  return (
    <div className="diff-view__split" data-row={dataRow} data-annotate-selected={annotate?.selected ? '' : undefined}>
      {cell('left')}
      {cell('right')}
    </div>
  )
}
