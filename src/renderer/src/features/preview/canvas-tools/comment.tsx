import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject
} from 'react'
import { Check, Crosshair, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import { Button, Checkbox, IconButton, TextArea } from '../../../ui'
import { HTML_PREVIEW_CHANNEL } from '../../../../../shared/html-artifact-preview'
import { stageRect, type CanvasFrameBox, type CanvasView } from '../html-canvas-model'
import { elementVisibleRegion } from '../canvas-region'
import { captureElementRegion, formatElementReference, sendToChat } from '../canvas-share'
import type { CanvasElementInfo, CanvasTool, CanvasToolContext, CanvasToolOverlayProps, CanvasToolPanelProps } from './types'
import {
  COMMENT_IMAGE_LIMIT,
  commentNumber,
  commentTextPreview,
  composeCommentPrompt,
  createCommentStore,
  elementSummary,
  formatCommentTime,
  parseRect,
  plainTextNeedle,
  type CanvasComment,
  type CommentResolution,
  type CommentStore,
  type CommentStoreSnapshot,
  type StorageLike
} from './comment-store'
import { canvasCommentText, type CanvasCommentText } from './comment-text'
import { DockToggle } from './dock'
import { dockPopover } from './dock-model'
import { formatSeconds, formatTimecode } from './timeline-model'
import './comment.css'

const CAPTURE_MARGIN = 6
const PROBE_TIMEOUT_MS = 600
const COMPOSER_WIDTH = 272
const COMPOSER_HEIGHT = 190
const COMPOSER_NARROW_WIDTH = 216
const COMPOSER_NARROW_HEIGHT = 168

type CapturedImage = Awaited<ReturnType<typeof captureElementRegion>>

const clients = new Map<string, CommentStore>()

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function commentStoreFor(abs: string): CommentStore {
  let store = clients.get(abs)
  if (!store) {
    store = createCommentStore({ storage: browserStorage(), abs })
    clients.set(abs, store)
  }
  return store
}

function useCommentStore(abs: string): [CommentStoreSnapshot, CommentStore] {
  const store = commentStoreFor(abs)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return [snapshot, store]
}

function useLayerSize(ref: RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

function locateComment(context: CanvasToolContext, store: CommentStore, comment: CanvasComment): void {
  store.setActive(comment.id)
  if (typeof comment.time === 'number') context.seekComposition(comment.time)
  void context.focusRect(comment.frameId, comment.element.rect, 48)
}

let probeSeq = 0

function probeText(context: CanvasToolContext, frameId: string, needle: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const element = context.frameElement(frameId)
    if (!element || !needle) {
      resolve(null)
      return
    }
    const id = `comment-probe-${Date.now().toString(36)}-${++probeSeq}`
    let done = false
    const finish = (value: boolean | null): void => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== element.contentWindow) return
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object' || data[HTML_PREVIEW_CHANNEL] !== 'probe' || data.id !== id) return
      finish(parseRect(data.rect) ? true : false)
    }
    const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    element.contentWindow?.postMessage({ [HTML_PREVIEW_CHANNEL]: 'probe', id, text: needle, follow: false }, '*')
  })
}

async function resolveFrameComments(
  context: CanvasToolContext,
  frameId: string,
  comments: readonly CanvasComment[]
): Promise<CommentResolution[]> {
  const targets = comments.filter((comment) => comment.frameId === frameId)
  if (!targets.length) return []
  const findings: CommentResolution[] = []
  for (const comment of targets) {
    const needle = plainTextNeedle(comment.element)
    const found = await context.resolveElement(frameId, {
      selector: comment.element.selector,
      path: comment.element.path,
      text: needle || undefined
    })
    if (found.state === 'found') {
      findings.push({ id: comment.id, state: 'valid', rect: found.rect })
      continue
    }
    if (found.state === 'unknown' || !needle) {
      findings.push({ id: comment.id, state: found.state === 'unknown' ? 'unknown' : 'missing' })
      continue
    }
    const seen = await probeText(context, frameId, needle)
    if (seen === null) findings.push({ id: comment.id, state: 'unknown' })
    else findings.push({ id: comment.id, state: seen ? 'valid' : 'missing' })
  }
  return findings
}

function commentPinTitle(text: CanvasCommentText, index: number, comment: CanvasComment): string {
  const parts = [`${index}. ${elementSummary(comment.element)}`, commentTextPreview(comment.content)]
  if (typeof comment.time === 'number') parts.push(text.stamp(formatTimecode(comment.time)))
  if (comment.sentAt) parts.push(text.sent)
  if (comment.invalid) parts.push(text.invalidHint)
  return parts.join('\n')
}

function CommentComposer({
  frame,
  view,
  element,
  text,
  layerSize,
  narrow,
  inset,
  onSave,
  onCancel
}: {
  frame: CanvasFrameBox
  view: CanvasView
  element: CanvasElementInfo
  text: CanvasCommentText
  layerSize: { width: number; height: number }
  narrow: boolean
  inset: number
  onSave: (value: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    boxRef.current?.querySelector('textarea')?.focus()
  }, [])
  const box = stageRect(frame, view, element.rect)
  const placement = dockPopover({
    anchor: narrow
      ? { left: box.left, top: box.top, width: 0, height: 0 }
      : { left: box.left, top: box.top, width: box.width, height: box.height },
    size: {
      width: narrow ? COMPOSER_NARROW_WIDTH : COMPOSER_WIDTH,
      height: narrow ? COMPOSER_NARROW_HEIGHT : COMPOSER_HEIGHT
    },
    viewport: layerSize,
    bottomInset: inset
  })
  const style: CSSProperties = { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight }
  const commit = (): void => {
    const content = value.trim()
    if (!content) return
    onSave(content)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      commit()
    }
  }
  return (
    <div
      className="v3-canvas-comment-composer"
      data-canvas-interactive
      data-side={placement.side}
      role="dialog"
      aria-label={text.composerTitle}
      data-testid="v3-canvas-comment-composer"
      ref={boxRef}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className="v3-canvas-comment-composer-head">
        <code className="v3-canvas-comment-meta">
          {element.tag} · {Math.round(element.rect.w)} × {Math.round(element.rect.h)}
        </code>
      </div>
      <TextArea
        aria-label={text.contentLabel}
        placeholder={text.contentPlaceholder}
        value={value}
        onChange={setValue}
        rows={narrow ? 2 : 3}
        textAreaClassName="v3-canvas-comment-input"
      />
      <div className="v3-canvas-comment-composer-foot">
        <span className="v3-canvas-comment-hint">{text.saveHint}</span>
        <Button size="sm" variant="ghost" onPress={onCancel} data-testid="v3-canvas-comment-cancel">
          {text.cancel}
        </Button>
        <Button size="sm" variant="primary" isDisabled={!value.trim()} onPress={commit} data-testid="v3-canvas-comment-save">
          {text.save}
        </Button>
      </div>
    </div>
  )
}

function CommentOverlay({ frame, view, context }: CanvasToolOverlayProps): ReactElement {
  const text = canvasCommentText(context.labels.lang)
  const [snapshot, store] = useCommentStore(context.abs)
  const layerRef = useRef<HTMLDivElement>(null)
  const layerSize = useLayerSize(layerRef)
  const [draft, setDraft] = useState<{ element: CanvasElementInfo } | null>(null)
  const contextRef = useRef(context)
  contextRef.current = context
  const frameId = frame.viewport.id
  const comments = snapshot.comments
  const commentKey = comments
    .filter((comment) => comment.frameId === frameId)
    .map((comment) => comment.id)
    .join('|')
  const selection = context.selection

  useEffect(() => {
    if (!selection) return
    if (selection.frameId !== frameId) {
      setDraft(null)
      return
    }
    setDraft({ element: selection })
  }, [selection, frameId])

  useEffect(() => {
    let live = true
    let running = false
    const refresh = (): void => {
      if (running) return
      running = true
      void resolveFrameComments(contextRef.current, frameId, store.getSnapshot().comments).then(
        (findings) => {
          running = false
          if (!live || !findings.length) return
          store.resolve(findings)
        },
        () => {
          running = false
        }
      )
    }
    refresh()
    window.addEventListener('resize', refresh)
    return () => {
      live = false
      window.removeEventListener('resize', refresh)
    }
  }, [frameId, store, context.refreshTick, commentKey])

  const hover = context.hover && context.hover.frameId === frameId ? context.hover : null
  const hoverBox = hover ? stageRect(frame, view, hover.rect) : null

  useEffect(() => {
    if (!hover) return
    const matches = store
      .getSnapshot()
      .comments.filter((comment) => comment.frameId === frameId && comment.element.selector === hover.selector)
    if (!matches.length) return
    store.resolve(matches.map((comment) => ({ id: comment.id, state: 'valid' as const, rect: hover.rect })))
  }, [hover, frameId, store])

  useEffect(() => {
    if (!context.narrow || context.dockCollapsed || !selection) return
    if (selection.frameId !== frameId) return
    context.toggleDock()
  }, [context.narrow, context.dockCollapsed, selection, frameId])

  return (
    <div className="v3-canvas-comment-layer" ref={layerRef} data-testid={`v3-canvas-comment-layer-${frameId}`}>
      {hoverBox ? (
        <div
          className="v3-canvas-comment-hover"
          aria-hidden
          style={{ left: hoverBox.left, top: hoverBox.top, width: hoverBox.width, height: hoverBox.height }}
        />
      ) : null}
      {comments
        .filter((comment) => comment.frameId === frameId)
        .map((comment) => {
          const index = commentNumber(comments, comment.id)
          const box = stageRect(frame, view, comment.element.rect)
          return (
            <button
              key={comment.id}
              type="button"
              className="v3-canvas-comment-pin"
              data-testid="v3-canvas-comment-pin"
              data-invalid={comment.invalid || undefined}
              data-sent={comment.sentAt ? '1' : undefined}
              data-active={snapshot.activeId === comment.id || undefined}
              style={{ left: box.left, top: box.top }}
              title={commentPinTitle(text, index, comment)}
              aria-label={commentPinTitle(text, index, comment)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => locateComment(context, store, comment)}
            >
              {comment.sentAt ? <Check size={10} aria-hidden /> : index}
            </button>
          )
        })}
      {draft ? (
        <CommentComposer
          frame={frame}
          view={view}
          element={draft.element}
          text={text}
          layerSize={layerSize}
          narrow={context.narrow}
          inset={context.dockInset}
          onSave={(content) => {
            store.add({ frameId: draft.element.frameId, element: draft.element, content, time: context.currentTime })
            setDraft(null)
          }}
          onCancel={() => setDraft(null)}
        />
      ) : null}
    </div>
  )
}

async function captureComment(
  context: CanvasToolContext,
  stage: HTMLElement | null,
  comment: CanvasComment
): Promise<CapturedImage | null> {
  const frame = context.frames.find((item) => item.viewport.id === comment.frameId)
  if (!frame) return null
  await context.focusRect(comment.frameId, comment.element.rect, 48)
  const element = context.frameElement(comment.frameId)
  const stageBox = stage?.getBoundingClientRect()
  if (!element || !stageBox) return null
  const box = element.getBoundingClientRect()
  if (!(box.width > 0) || !(box.height > 0) || !(frame.viewport.width > 0)) return null
  const scale = box.width / frame.viewport.width
  if (!(scale > 0)) return null
  const rect = comment.element.rect
  const region = elementVisibleRegion(
    { width: frame.viewport.width, height: frame.viewport.height },
    { x: box.left, y: box.top, w: box.width, h: box.height },
    { x: stageBox.left, y: stageBox.top, w: stageBox.width, h: stageBox.height },
    { x: rect.x - CAPTURE_MARGIN, y: rect.y - CAPTURE_MARGIN, w: rect.w + CAPTURE_MARGIN * 2, h: rect.h + CAPTURE_MARGIN * 2 }
  )
  if (!region) return null
  const base = context.name.replace(/\.[^.]+$/, '') || 'canvas'
  try {
    return await captureElementRegion(
      element,
      { x: region.x * scale, y: region.y * scale, w: region.w * scale, h: region.h * scale },
      `${base}-comment-${comment.id.slice(-4)}.png`,
      { x: stageBox.left, y: stageBox.top, w: stageBox.width, h: stageBox.height }
    )
  } catch {
    return null
  }
}

function CommentPanel({ context }: CanvasToolPanelProps): ReactElement {
  const text = canvasCommentText(context.labels.lang)
  const [snapshot, store] = useCommentStore(context.abs)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [sending, setSending] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const comments = snapshot.comments
  const selectedIds = snapshot.selected.filter((id) => comments.some((comment) => comment.id === id))
  const allSelected = comments.length > 0 && selectedIds.length === comments.length
  const someSelected = selectedIds.length > 0 && !allSelected
  const sentCount = comments.filter((comment) => comment.sentAt !== null).length

  const send = useCallback(async (): Promise<void> => {
    const chosen = comments.filter((comment) => selectedIds.includes(comment.id))
    if (!chosen.length) {
      store.setStatus({ tone: 'info', text: text.sendEmpty })
      return
    }
    if (sending) return
    setSending(true)
    store.setStatus({ tone: 'info', text: text.sending })
    const images: CapturedImage[] = []
    for (const comment of chosen) {
      if (images.length >= COMMENT_IMAGE_LIMIT) break
      const shot = await captureComment(context, panelRef.current?.parentElement ?? null, comment)
      if (shot) images.push(shot)
    }
    const body = composeCommentPrompt({
      header: text.promptHeader(context.name),
      commentLabel: text.promptComment,
      entries: chosen.map((comment) => ({
        index: commentNumber(comments, comment.id),
        reference: [
          formatElementReference(comment.element),
          typeof comment.time === 'number' ? text.promptTime(formatSeconds(comment.time)) : ''
        ]
          .filter(Boolean)
          .join(' · '),
        content: comment.content
      }))
    })
    const handled = sendToChat({ text: body, images })
    setSending(false)
    if (!handled) {
      store.setStatus({ tone: 'error', text: text.sendFailed })
      return
    }
    store.markSent(chosen.map((comment) => comment.id))
    store.setStatus({
      tone: 'info',
      text: images.length >= chosen.length ? text.sendDone(chosen.length) : text.sendPartial(chosen.length, images.length)
    })
  }, [comments, context, selectedIds, sending, store, text])

  if (context.narrow && context.dockCollapsed) {
    return (
      <aside
        className="v3-canvas-comment-panel v3-canvas-dock-bar"
        data-canvas-interactive
        aria-label={text.panelTitle}
        data-testid="v3-canvas-comment-panel"
        ref={panelRef}
      >
        <div className="v3-canvas-dock-row">
          <span className="v3-canvas-comment-count">{text.countLabel(comments.length, selectedIds.length)}</span>
          {snapshot.status ? (
            <span className="v3-canvas-dock-hint" role="status" data-tone={snapshot.status.tone}>
              {snapshot.status.text}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            isDisabled={!selectedIds.length || sending}
            onPress={() => void send()}
            data-testid="v3-canvas-comment-send"
          >
            {sending ? text.sending : text.send}
          </Button>
        </div>
        <DockToggle labels={context.labels} expanded={false} onToggle={context.toggleDock} />
      </aside>
    )
  }

  return (
    <aside
      className="v3-canvas-comment-panel"
      data-canvas-interactive
      aria-label={text.panelTitle}
      data-testid="v3-canvas-comment-panel"
      ref={panelRef}
    >
      <div className="v3-canvas-comment-panel-head">
        <span className="v3-canvas-comment-panel-title">{text.panelTitle}</span>
        <span className="v3-canvas-comment-count">{text.countLabel(comments.length, selectedIds.length)}</span>
        {context.narrow ? <DockToggle labels={context.labels} expanded onToggle={context.toggleDock} /> : null}
      </div>
      <div className="v3-canvas-comment-actions">
        <Checkbox
          aria-label={text.selectAll}
          isSelected={allSelected}
          isIndeterminate={someSelected}
          isDisabled={!comments.length}
          onChange={(selected) => (selected ? store.selectAll() : store.selectNone())}
          data-testid="v3-canvas-comment-select-all"
        >
          {text.selectAll}
        </Checkbox>
        <Button
          size="sm"
          variant="primary"
          isDisabled={!selectedIds.length || sending}
          onPress={() => void send()}
          data-testid="v3-canvas-comment-send"
        >
          {sending ? text.sending : text.send}
        </Button>
        <Button size="sm" variant="ghost" isDisabled={!sentCount} onPress={() => store.clearSent()} data-testid="v3-canvas-comment-clear-sent">
          {text.clearSent}
        </Button>
      </div>
      {snapshot.status ? (
        <p className="v3-canvas-comment-status" role="status" data-tone={snapshot.status.tone}>
          {snapshot.status.text}
        </p>
      ) : null}
      {comments.length ? (
        <ul className="v3-canvas-comment-list">
          {comments.map((comment) => {
            const index = commentNumber(comments, comment.id)
            const summary = elementSummary(comment.element)
            const active = snapshot.activeId === comment.id
            return (
              <li
                key={comment.id}
                className="v3-canvas-comment-row"
                data-active={active || undefined}
                data-sent={comment.sentAt ? '1' : undefined}
                data-invalid={comment.invalid || undefined}
                data-testid="v3-canvas-comment-row"
              >
                <div className="v3-canvas-comment-row-head">
                  <Checkbox
                    aria-label={text.selectRow(index, summary)}
                    isSelected={selectedIds.includes(comment.id)}
                    onChange={() => store.toggleSelected(comment.id)}
                  />
                  <span className="v3-canvas-comment-num" aria-hidden>
                    {comment.sentAt ? <Check size={10} /> : index}
                  </span>
                  <button
                    type="button"
                    className="v3-canvas-comment-summary"
                    title={`${text.locate}\n${summary}`}
                    onClick={() => locateComment(context, store, comment)}
                  >
                    <code>{summary}</code>
                  </button>
                </div>
                {editing && editing.id === comment.id ? (
                  <div className="v3-canvas-comment-edit">
                    <TextArea
                      aria-label={text.edit}
                      value={editing.value}
                      onChange={(value) => setEditing({ id: comment.id, value })}
                      rows={3}
                      textAreaClassName="v3-canvas-comment-input"
                    />
                    <div className="v3-canvas-comment-edit-actions">
                      <Button size="sm" variant="ghost" onPress={() => setEditing(null)}>
                        {text.editCancel}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={!editing.value.trim()}
                        onPress={() => {
                          store.update(comment.id, editing.value)
                          setEditing(null)
                        }}
                      >
                        {text.editSave}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="v3-canvas-comment-body">{comment.content}</p>
                )}
                <div className="v3-canvas-comment-row-foot">
                  <span className="v3-canvas-comment-time">{formatCommentTime(comment.createdAt, context.labels.lang)}</span>
                  {typeof comment.time === 'number' ? (
                    <span className="v3-canvas-comment-stamp">{text.stamp(formatTimecode(comment.time))}</span>
                  ) : null}
                  {comment.sentAt ? (
                    <span className="v3-canvas-comment-badge" data-tone="sent">
                      {text.sent}
                    </span>
                  ) : null}
                  {comment.invalid ? (
                    <span className="v3-canvas-comment-badge" data-tone="invalid" title={text.invalidHint}>
                      {text.invalid}
                    </span>
                  ) : null}
                  <span className="v3-canvas-comment-row-spacer" />
                  <IconButton
                    size="sm"
                    aria-label={text.locate}
                    title={text.locate}
                    onPress={() => locateComment(context, store, comment)}
                  >
                    <Crosshair size={12} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    aria-label={text.edit}
                    title={text.edit}
                    onPress={() => setEditing({ id: comment.id, value: comment.content })}
                  >
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="danger"
                    aria-label={text.remove}
                    title={text.remove}
                    onPress={() => {
                      if (editing?.id === comment.id) setEditing(null)
                      store.remove(comment.id)
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="v3-canvas-comment-empty">
          <MessageSquarePlus size={16} aria-hidden />
          <p>{text.panelEmpty}</p>
          <p className="v3-canvas-comment-empty-hint">{text.panelHint}</p>
        </div>
      )}
    </aside>
  )
}

export const commentTool: CanvasTool = {
  id: 'comment',
  icon: MessageSquarePlus,
  label: (labels) => canvasCommentText(labels.lang).tool,
  shortcut: 'c',
  frameInput: 'bridge',
  Overlay: CommentOverlay,
  Panel: CommentPanel
}
