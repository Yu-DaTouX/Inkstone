import { useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { CodeViewDiffItem, CodeViewItem, DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import { CodeView, FileDiff, type CodeViewHandle } from '@pierre/diffs/react'
import { ChevronDown, ChevronUp, Columns2, Rows3 } from 'lucide-react'
import { Button, EmptyState, IconButton, Notice, Toggle, ToggleGroup, cx } from '../../ui'
import { DiffAnnotationEditor, type DiffAnnotate } from './DiffAnnotation'
import { DiffWorkerPool } from './DiffWorkerPool'
import { DIFF_THEMES, DIFF_UNSAFE_CSS, useDiffSurfaceMetrics, type DiffSurfaceMetrics } from './diff-theme'
import { byteLength, DIFF_LIMITS, formatBytes, isBinaryPatch } from './limits'
import { annotationRange, fileDiffId, hunkTargets, patchFiles, type AnnotationRange } from './patch-files'
import { diffViewText, type DiffViewText } from './text'
import type { DiffViewMode } from './types'
import './diff-view.css'

export interface DiffViewProps {
  patch: string
  title?: string
  mode?: DiffViewMode
  defaultMode?: DiffViewMode
  onModeChange?: (mode: DiffViewMode) => void
  showFileHeader?: boolean
  embedded?: boolean
  lang?: string
  className?: string
  maxBytes?: number
  annotate?: DiffAnnotate
}

interface DraftMeta {
  kind: 'draft'
}

interface AnnotationDraft {
  fileId: string
  range: AnnotationRange
  body: string
}

export function DiffView({
  patch,
  title,
  mode: modeProp,
  defaultMode = 'unified',
  onModeChange,
  showFileHeader = true,
  embedded = false,
  lang,
  className,
  maxBytes = DIFF_LIMITS.maxBytes,
  annotate
}: DiffViewProps): ReactElement {
  const text = useMemo(() => diffViewText(lang ?? 'zh-CN'), [lang])
  const metrics = useDiffSurfaceMetrics()
  const [internalMode, setInternalMode] = useState<DiffViewMode>(defaultMode)
  const mode = modeProp ?? internalMode
  const [forceLarge, setForceLarge] = useState(false)
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [hunkCursor, setHunkCursor] = useState(-1)
  const [seenPatch, setSeenPatch] = useState(patch)
  if (seenPatch !== patch) {
    setSeenPatch(patch)
    setForceLarge(false)
    setDraft(null)
    setHunkCursor(-1)
  }

  const bytes = useMemo(() => byteLength(patch), [patch])
  const tooLarge = bytes > maxBytes
  const exceedHard = bytes > DIFF_LIMITS.hardMaxBytes
  const parsed = useMemo(
    () => (tooLarge && !forceLarge ? null : patchFiles(patch, title ?? '', embedded ? 'embedded' : 'view')),
    [patch, title, embedded, tooLarge, forceLarge]
  )
  const files = parsed?.kind === 'files' ? parsed.files : []
  const targets = useMemo(() => hunkTargets(files), [files])
  const viewerRef = useRef<CodeViewHandle<DraftMeta, undefined>>(null)

  const setMode = (next: DiffViewMode): void => {
    if (next === mode) return
    if (modeProp === undefined) setInternalMode(next)
    onModeChange?.(next)
    setDraft(null)
  }

  const goHunk = (delta: number): void => {
    if (targets.length === 0) return
    const next =
      hunkCursor < 0 ? (delta > 0 ? 0 : targets.length - 1) : Math.max(0, Math.min(targets.length - 1, hunkCursor + delta))
    setHunkCursor(next)
    const target = targets[next]
    viewerRef.current?.scrollTo({
      type: 'line',
      id: target.id,
      lineNumber: target.lineNumber,
      side: target.side,
      align: 'start',
      behavior: 'instant'
    })
  }

  const beginAnnotation = (fileId: string, file: FileDiffMetadata, range: SelectedLineRange): void => {
    if (!annotate) return
    const resolved = annotationRange(file, range)
    if (!resolved) return
    setDraft({ fileId, range: resolved, body: '' })
  }

  const submitAnnotation = (): void => {
    if (!annotate || !draft) return
    const body = draft.body.trim()
    if (!body) return
    annotate.onSubmit({ start: draft.range.start, end: draft.range.end, code: draft.range.code, text: body })
    setDraft(null)
  }

  const annotationsFor = (fileId: string): DiffLineAnnotation<DraftMeta>[] =>
    draft && draft.fileId === fileId
      ? [{ side: draft.range.side, lineNumber: draft.range.end, metadata: { kind: 'draft' } }]
      : []

  const selectionFor = (fileId: string): SelectedLineRange | null =>
    draft && draft.fileId === fileId
      ? { start: draft.range.start, end: draft.range.end, side: draft.range.side, endSide: draft.range.side }
      : null

  const renderDraft = (): ReactNode =>
    annotate && draft ? (
      <DiffAnnotationEditor
        labels={annotate.labels}
        range={
          draft.range.start === draft.range.end
            ? annotate.labels.line(draft.range.start)
            : annotate.labels.lines(draft.range.start, draft.range.end)
        }
        value={draft.body}
        onChange={(value) => setDraft((prev) => (prev ? { ...prev, body: value } : prev))}
        onSubmit={submitAnnotation}
        onCancel={() => setDraft(null)}
      />
    ) : null

  const shell = (children: ReactNode): ReactElement => (
    <section
      className={cx('diff-view', embedded && 'diff-view--embedded', className)}
      aria-label={title ?? text.fileHeader}
    >
      {children}
    </section>
  )

  if (!patch.trim()) return shell(<EmptyState size="sm" title={text.empty} className="diff-view__empty" />)

  if (tooLarge && (!forceLarge || exceedHard)) {
    return shell(
      <Notice
        tone="ask"
        compact
        className="diff-view__notice"
        action={
          exceedHard ? null : (
            <Button size="xs" onPress={() => setForceLarge(true)}>
              {text.renderAnyway}
            </Button>
          )
        }
      >
        {text.tooLarge(formatBytes(bytes))}
      </Notice>
    )
  }

  if (parsed?.kind === 'raw') {
    return shell(
      <>
        <Notice variant="hint" tone="ask" className="diff-view__notice">
          {text.rawFallback}
        </Notice>
        <pre className="diff-view__raw">{parsed.text}</pre>
      </>
    )
  }

  if (files.length === 0) return shell(<EmptyState size="sm" title={text.empty} className="diff-view__empty" />)

  const binaryOnly = files.every((file) => file.hunks.length === 0) && isBinaryPatch(patch)
  const options = diffOptions(metrics, mode, showFileHeader, Boolean(annotate) && draft === null)

  const body = binaryOnly ? (
    <Notice variant="hint" className="diff-view__notice">
      {text.binaryFile}
    </Notice>
  ) : embedded ? (
    <div className="diff-view__files">
      {files.map((file, index) => {
        const id = fileDiffId(file, index)
        return (
          <FileDiff<DraftMeta>
            key={id}
            className="diff-view__file"
            fileDiff={file}
            options={{
              ...options,
              hunkSeparators: 'metadata',
              onGutterUtilityClick: (range) => beginAnnotation(id, file, range)
            }}
            lineAnnotations={annotationsFor(id)}
            selectedLines={selectionFor(id)}
            renderAnnotation={renderDraft}
          />
        )
      })}
    </div>
  ) : (
    <CodeView<DraftMeta>
      ref={viewerRef}
      className="diff-view__body"
      items={files.map((file, index) => codeViewItem(file, index, annotationsFor(fileDiffId(file, index))))}
      selectedLines={draft ? { id: draft.fileId, range: selectionFor(draft.fileId) as SelectedLineRange } : null}
      options={{
        ...options,
        hunkSeparators: 'metadata',
        stickyHeaders: showFileHeader,
        itemMetrics: {
          lineHeight: metrics.lineHeight,
          diffHeaderHeight: showFileHeader ? metrics.barHeight : 0,
          hunkSeparatorHeight: 24,
          spacing: 0,
          paddingTop: 0,
          paddingBottom: 8
        },
        layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
        onGutterUtilityClick: (range: SelectedLineRange, context: { item: CodeViewItem<DraftMeta> }) => {
          const item = context.item
          if (item.type === 'diff') beginAnnotation(item.id, item.fileDiff, range)
        }
      }}
      renderAnnotation={renderDraft}
    />
  )

  return shell(
    <>
      {embedded ? null : (
        <DiffBar
          text={text}
          mode={mode}
          onMode={setMode}
          hunkCount={targets.length}
          hunkCursor={hunkCursor}
          onHunk={goHunk}
        />
      )}
      <DiffWorkerPool loadingLabel={text.preparing}>{body}</DiffWorkerPool>
    </>
  )
}

function diffOptions(metrics: DiffSurfaceMetrics, mode: DiffViewMode, showFileHeader: boolean, annotatable: boolean) {
  return {
    theme: DIFF_THEMES,
    themeType: metrics.themeType,
    diffStyle: mode,
    diffIndicators: 'bars' as const,
    overflow: 'wrap' as const,
    lineDiffType: 'word-alt' as const,
    tokenizeMaxLineLength: 1_000,
    disableFileHeader: !showFileHeader,
    unsafeCSS: DIFF_UNSAFE_CSS,
    enableGutterUtility: annotatable,
    enableLineSelection: annotatable,
    lineHoverHighlight: annotatable ? ('number' as const) : ('disabled' as const)
  }
}

function codeViewItem(
  file: FileDiffMetadata,
  index: number,
  annotations: DiffLineAnnotation<DraftMeta>[]
): CodeViewDiffItem<DraftMeta> {
  return {
    id: fileDiffId(file, index),
    type: 'diff',
    fileDiff: file,
    annotations,
    version: annotations.length > 0 ? 2 : 1
  }
}

function DiffBar({
  text,
  mode,
  onMode,
  hunkCount,
  hunkCursor,
  onHunk
}: {
  text: DiffViewText
  mode: DiffViewMode
  onMode: (mode: DiffViewMode) => void
  hunkCount: number
  hunkCursor: number
  onHunk: (delta: number) => void
}): ReactElement {
  return (
    <div className="diff-view__bar">
      <ToggleGroup
        variant="segmented"
        size="xs"
        aria-label={text.layout}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[mode]}
        onSelectionChange={(keys) => {
          const next = [...keys][0]
          if (next === 'unified' || next === 'split') onMode(next)
        }}
      >
        <Toggle id="unified">
          <Rows3 size={12} aria-hidden="true" />
          {text.unified}
        </Toggle>
        <Toggle id="split">
          <Columns2 size={12} aria-hidden="true" />
          {text.split}
        </Toggle>
      </ToggleGroup>
      {hunkCount > 0 ? (
        <div className="diff-view__nav">
          <IconButton size="xs" aria-label={text.prevHunk} tooltip={text.prevHunk} isDisabled={hunkCursor <= 0} onPress={() => onHunk(-1)}>
            <ChevronUp size={12} aria-hidden="true" />
          </IconButton>
          <span className="diff-view__nav-label" aria-live="polite">
            {hunkCursor < 0 ? `— / ${hunkCount}` : text.hunkOf(hunkCursor + 1, hunkCount)}
          </span>
          <IconButton
            size="xs"
            aria-label={text.nextHunk}
            tooltip={text.nextHunk}
            isDisabled={hunkCursor >= hunkCount - 1}
            onPress={() => onHunk(1)}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
    </div>
  )
}
