import { useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { VList, type VListHandle } from 'virtua'
import { ChevronDown, ChevronUp, Columns2, Rows3 } from 'lucide-react'
import { Button, IconButton, cx } from '../../ui'
import { alignHunk, type DiffSideRow } from './align'
import { foldLines } from './fold'
import {
  byteLength,
  DIFF_LIMITS,
  formatBytes,
  patchExceedsHardLimit,
  patchExceedsLimit
} from './limits'
import { parsePatch } from './parse'
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
  lang?: string
  className?: string
  maxBytes?: number
  lineSlot?: (line: DiffLine, side: 'new' | 'old') => ReactNode
}

type RenderRow =
  | { kind: 'file'; key: string; file: DiffFile }
  | { kind: 'hunk'; key: string; header: string; section: string }
  | { kind: 'line'; key: string; line: DiffLine }
  | { kind: 'gap'; key: string; gapId: string; count: number }
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
  lang,
  className,
  maxBytes = DIFF_LIMITS.maxBytes,
  lineSlot
}: DiffViewProps): ReactElement {
  const text = useMemo(() => diffViewText(lang ?? 'zh-CN'), [lang])
  const [internalMode, setInternalMode] = useState<DiffViewMode>(defaultMode)
  const mode = modeProp ?? internalMode
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [hunkCursor, setHunkCursor] = useState(-1)
  const [forceLarge, setForceLarge] = useState(false)
  const [seenPatch, setSeenPatch] = useState(patch)
  if (seenPatch !== patch) {
    setSeenPatch(patch)
    setExpanded(new Set())
    setHunkCursor(-1)
    setForceLarge(false)
  }

  const parsed = useMemo(() => parsePatch(patch), [patch])
  const bytes = useMemo(() => byteLength(patch), [patch])
  const tooLarge = patchExceedsLimit(patch, maxBytes)
  const exceedHard = patchExceedsHardLimit(patch)

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
  const goHunk = (delta: number): void => {
    if (hunkRows.length === 0) return
    const next = hunkCursor < 0 ? (delta > 0 ? 0 : hunkRows.length - 1) : Math.max(0, Math.min(hunkRows.length - 1, hunkCursor + delta))
    setHunkCursor(next)
    scrollToRow(hunkRows[next])
  }

  const shell = (children: ReactNode): ReactElement => <div className={cx('diff-view', className)}>{children}</div>

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

  const virtual = rows.length >= DIFF_LIMITS.virtualizeAt

  return (
    <section className={cx('diff-view', className)} aria-label={title ?? text.fileHeader}>
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
      {rows.length === 0 ? (
        <div className="diff-view__empty">{text.empty}</div>
      ) : virtual ? (
        <VList ref={vlistRef} data={rows} className="diff-view__body" bufferSize={600}>
          {(row: RenderRow) => renderRow(row, text, expandGap, lineSlot)}
        </VList>
      ) : (
        <div className="diff-view__body" ref={bodyRef}>
          {rows.map((row, index) => renderRow(row, text, expandGap, lineSlot, index))}
        </div>
      )}
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
    file.hunks.forEach((hunk, hunkIndex) => {
      if (hunk.header) rows.push({ kind: 'hunk', key: key('h'), header: hunk.header, section: hunk.section })
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
        rows.push({ kind: 'gap', key: key('g'), gapId, count: folded.count })
      })
      flush()
    })
  })
  return rows
}

type LineSlot = (line: DiffLine, side: 'new' | 'old') => ReactNode

function renderRow(
  row: RenderRow,
  text: DiffViewText,
  onExpand: (gapId: string) => void,
  lineSlot?: LineSlot,
  rowIndex?: number
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
        <div key={row.key} {...attrs} className="diff-view__hunk">
          <span className="diff-view__hunk-text">{row.header}</span>
          {row.section ? <span className="diff-view__hunk-section">{row.section}</span> : null}
        </div>
      )
    case 'line':
      return (
        <div key={row.key} {...attrs} className={cx('diff-view__line', `diff-view__line--${row.line.kind}`)}>
          <span className="diff-view__gutter">{row.line.oldLine ?? ''}</span>
          <span className="diff-view__gutter">{row.line.newLine ?? ''}</span>
          <span className="diff-view__sign" aria-hidden="true">
            {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '-' : ' '}
          </span>
          <span className="diff-view__text">{row.line.text === '' ? '\u00a0' : row.line.text}</span>
          {row.line.noNewline ? <span className="diff-view__noeol">\ No newline at end of file</span> : null}
          {lineSlot ? lineSlot(row.line, row.line.kind === 'del' ? 'old' : 'new') : null}
        </div>
      )
    case 'gap':
      return (
        <div key={row.key} {...attrs} className="diff-view__gap-row">
          <Button size="sm" variant="ghost" className="diff-view__gap" onPress={() => onExpand(row.gapId)}>
            {text.expandLines(row.count)}
          </Button>
        </div>
      )
    case 'split':
      return <SplitRow key={row.key} {...attrs} row={row.row} lineSlot={lineSlot} />
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
  'data-row': dataRow
}: {
  row: DiffSideRow
  lineSlot?: LineSlot
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
    return (
      <div className={cx('diff-view__cell', sideClass)}>
        <span className="diff-view__gutter">{side === 'left' ? line.oldLine ?? '' : line.newLine ?? ''}</span>
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
    <div className="diff-view__split" data-row={dataRow}>
      {cell('left')}
      {cell('right')}
    </div>
  )
}
