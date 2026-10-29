import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import type {
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffContentsLoader,
  FileDiffMetadata,
  SelectedLineRange
} from '@pierre/diffs'
import { DIFFS_TAG_NAME } from '@pierre/diffs'
import { CodeView, FileDiff, type CodeViewHandle } from '@pierre/diffs/react'
import { ChevronDown, ChevronUp, Columns2, Rows3 } from 'lucide-react'
import { Button, EmptyState, IconButton, Notice, Toggle, ToggleGroup, cx } from '../../ui'
import { DiffAnnotationEditor, type DiffAnnotate } from './DiffAnnotation'
import { isComposingKey } from './annotation-keys'
import { enhanceSeparators } from './diff-separators'
import { DiffWorkerPool } from './DiffWorkerPool'
import { DIFF_THEMES, DIFF_UNSAFE_CSS, useDiffSurfaceMetrics, type DiffSurfaceMetrics } from './diff-theme'
import { byteLength, DIFF_LIMITS, formatBytes, isBinaryPatch } from './limits'
import {
  annotationRange,
  canExpandContext,
  contentsMatchPatch,
  fileDiffId,
  hunkTargets,
  keyboardLines,
  keyCursorRange,
  loadedFiles,
  moveKeyCursor,
  patchFiles,
  type AnnotationRange,
  type DiffContents,
  type DiffKeyCursor
} from './patch-files'
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
  loadContents?: () => Promise<DiffContents | null>
}

const PAGE_LINES = 10

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
  annotate,
  loadContents
}: DiffViewProps): ReactElement {
  const text = useMemo(() => diffViewText(lang ?? 'zh-CN'), [lang])
  const metrics = useDiffSurfaceMetrics()
  const [internalMode, setInternalMode] = useState<DiffViewMode>(defaultMode)
  const mode = modeProp ?? internalMode
  const [forceLarge, setForceLarge] = useState(false)
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [hunkCursor, setHunkCursor] = useState(-1)
  const [keyCursor, setKeyCursor] = useState<DiffKeyCursor | null>(null)
  const [contentsFailed, setContentsFailed] = useState(false)
  const [seenPatch, setSeenPatch] = useState(patch)
  if (seenPatch !== patch) {
    setSeenPatch(patch)
    setForceLarge(false)
    setDraft(null)
    setHunkCursor(-1)
    setKeyCursor(null)
    setContentsFailed(false)
  }
  const keysHelpId = useId()
  const keysHostRef = useRef<HTMLDivElement | null>(null)
  const codeContainerRef = useRef<HTMLDivElement | null>(null)
  const draftFromKeys = useRef(false)
  const loadContentsRef = useRef(loadContents)
  loadContentsRef.current = loadContents

  const bytes = useMemo(() => byteLength(patch), [patch])
  const tooLarge = bytes > maxBytes
  const exceedHard = bytes > DIFF_LIMITS.hardMaxBytes
  const parsed = useMemo(
    () => (tooLarge && !forceLarge ? null : patchFiles(patch, title ?? '', embedded ? 'embedded' : 'view')),
    [patch, title, embedded, tooLarge, forceLarge]
  )
  const files = parsed?.kind === 'files' ? parsed.files : []
  const targets = useMemo(() => hunkTargets(files), [files])
  const keyLines = useMemo(() => (annotate ? keyboardLines(files) : []), [annotate, files])
  const keyRange = keyCursorRange(keyLines, keyCursor)
  const viewerRef = useRef<CodeViewHandle<DraftMeta, undefined>>(null)
  const expandable =
    Boolean(loadContents) &&
    !contentsFailed &&
    files.length === 1 &&
    (canExpandContext(files[0]) || !files[0].isPartial)

  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const load = loadContentsRef.current
    const contents = load ? await load().catch(() => null) : null
    if (!contents || !contentsMatchPatch(fileDiff, contents)) {
      setContentsFailed(true)
      throw new Error('diff contents unavailable')
    }
    return loadedFiles(fileDiff, contents)
  }, [])

  const utilityLabel = annotate?.labels.add
  const onPostRender = useCallback(
    (node: HTMLElement) => enhanceSeparators(node, text, utilityLabel),
    [text, utilityLabel]
  )

  const keysTarget = (): HTMLElement | null => (embedded ? keysHostRef.current : codeContainerRef.current)

  useLayoutEffect(() => {
    if (embedded || !annotate) return
    const container = keysTarget()
    if (!container) return
    container.setAttribute('tabindex', '0')
    container.setAttribute('role', 'application')
    container.setAttribute('aria-label', text.keysLabel(title ?? ''))
    container.setAttribute('aria-describedby', keysHelpId)
    container.setAttribute('data-diff-keys', '')
  })

  const cursorFocus = keyCursor?.focus ?? -1
  const cursorBackward = keyCursor ? keyCursor.focus < keyCursor.anchor : false
  const drafting = draft !== null
  useEffect(() => {
    if (drafting) return
    const line = keyLines[cursorFocus]
    if (!line) return
    if (!embedded) {
      viewerRef.current?.scrollTo({
        type: 'line',
        id: line.fileId,
        lineNumber: line.lineNumber,
        side: line.side,
        align: 'nearest',
        behavior: 'instant'
      })
      return
    }
    const frame = requestAnimationFrame(() => {
      const hosts = keysHostRef.current?.querySelectorAll<HTMLElement>(DIFFS_TAG_NAME)
      const root = hosts?.[line.fileIndex]?.shadowRoot
      const selected = root?.querySelectorAll<HTMLElement>('[data-selected-line]')
      const target = selected && selected.length > 0 ? (cursorBackward ? selected[0] : selected[selected.length - 1]) : null
      target?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [cursorFocus, cursorBackward, drafting, keyLines, embedded])

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

  const beginAnnotation = (fileId: string, file: FileDiffMetadata, range: SelectedLineRange, fromKeys = false): void => {
    if (!annotate) return
    const resolved = annotationRange(file, range)
    if (!resolved) return
    draftFromKeys.current = fromKeys
    if (!fromKeys) setKeyCursor(null)
    setDraft({ fileId, range: resolved, body: '' })
  }

  const closeDraft = (): void => {
    setDraft(null)
    if (!draftFromKeys.current) return
    draftFromKeys.current = false
    requestAnimationFrame(() => keysTarget()?.focus({ preventScroll: true }))
  }

  const submitAnnotation = (): void => {
    if (!annotate || !draft) return
    const body = draft.body.trim()
    if (!body) return
    annotate.onSubmit({ start: draft.range.start, end: draft.range.end, code: draft.range.code, text: body })
    closeDraft()
  }

  const onKeysDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!annotate || draft) return
    const host = keysTarget()
    const origin = event.nativeEvent.composedPath()[0]
    const fromUtility = origin instanceof Element && origin.closest('[data-utility-button]') !== null
    if (!host || (event.target !== host && !fromUtility)) return
    if (isComposingKey(event.nativeEvent) || event.altKey || event.ctrlKey || event.metaKey) return
    const move = (delta: number): void => {
      event.preventDefault()
      if (fromUtility) host.focus({ preventScroll: true })
      setKeyCursor((prev) => moveKeyCursor(keyLines, prev, prev ? delta : 0, event.shiftKey))
    }
    switch (event.key) {
      case 'ArrowDown':
        return move(1)
      case 'ArrowUp':
        return move(-1)
      case 'PageDown':
        return move(PAGE_LINES)
      case 'PageUp':
        return move(-PAGE_LINES)
      case 'Home':
        return move(-keyLines.length)
      case 'End':
        return move(keyLines.length)
      case 'Enter':
      case ' ': {
        if (!keyRange && fromUtility) return
        event.preventDefault()
        if (!keyRange) {
          setKeyCursor(moveKeyCursor(keyLines, null, 0, false))
          return
        }
        const file = files[keyRange.fileIndex]
        if (!file) return
        beginAnnotation(
          keyRange.fileId,
          file,
          { start: keyRange.start, end: keyRange.end, side: keyRange.side, endSide: keyRange.side },
          true
        )
        return
      }
      case 'Escape':
        if (!keyCursor) return
        event.preventDefault()
        event.stopPropagation()
        setKeyCursor(null)
        return
    }
  }

  const announcement = (): string => {
    if (!keyRange || !keyCursor) return ''
    if (keyRange.count > 1) return text.keyRange(keyRange.start, keyRange.end, keyRange.count)
    const line = keyLines[keyCursor.focus]
    return line ? text.keyLine(line.kind, line.lineNumber, line.text) : ''
  }

  const annotationsFor = (fileId: string): DiffLineAnnotation<DraftMeta>[] =>
    draft && draft.fileId === fileId
      ? [{ side: draft.range.side, lineNumber: draft.range.end, metadata: { kind: 'draft' } }]
      : []

  const selectionFor = (fileId: string): SelectedLineRange | null => {
    if (draft) {
      return draft.fileId === fileId
        ? { start: draft.range.start, end: draft.range.end, side: draft.range.side, endSide: draft.range.side }
        : null
    }
    return keyRange && keyRange.fileId === fileId
      ? { start: keyRange.start, end: keyRange.end, side: keyRange.side, endSide: keyRange.side }
      : null
  }
  const activeSelectionId = draft?.fileId ?? keyRange?.fileId ?? null

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
        onCancel={closeDraft}
        hint={text.annotateKeys}
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
  const options = {
    ...diffOptions(metrics, mode, showFileHeader, Boolean(annotate) && draft === null),
    hunkSeparators: expandable ? ('line-info' as const) : ('metadata' as const),
    onPostRender,
    ...(expandable ? { loadDiffFiles } : {})
  }
  const keysHelp = annotate ? (
    <>
      <span id={keysHelpId} className="sr-only">
        {text.keysHelp}
      </span>
      <span className="sr-only" aria-live="polite">
        {announcement()}
      </span>
    </>
  ) : null

  const body = binaryOnly ? (
    <Notice variant="hint" className="diff-view__notice">
      {text.binaryFile}
    </Notice>
  ) : embedded ? (
    <div
      ref={keysHostRef}
      className="diff-view__files"
      {...(annotate
        ? {
            tabIndex: 0,
            role: 'application',
            'aria-label': text.keysLabel(title ?? ''),
            'aria-describedby': keysHelpId,
            'data-diff-keys': '',
            onKeyDown: onKeysDown
          }
        : {})}
    >
      {keysHelp}
      {files.map((file, index) => {
        const id = fileDiffId(file, index)
        return (
          <FileDiff<DraftMeta>
            key={id}
            className="diff-view__file"
            fileDiff={file}
            options={{
              ...options,
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
    <div className="diff-view__keys" onKeyDown={onKeysDown}>
    {keysHelp}
    <CodeView<DraftMeta>
      ref={viewerRef}
      containerRef={codeContainerRef}
      className="diff-view__body"
      items={files.map((file, index) => codeViewItem(file, index, annotationsFor(fileDiffId(file, index))))}
      selectedLines={
        activeSelectionId ? { id: activeSelectionId, range: selectionFor(activeSelectionId) as SelectedLineRange } : null
      }
      options={{
        ...options,
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
    </div>
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
