import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { Check, ExternalLink, Maximize, Monitor, MousePointer2, Play, RotateCw, Square, ZoomIn, ZoomOut } from 'lucide-react'
import { Badge, Button, IconButton, Input, Menu, MenuItem, MenuTrigger, Popover, TextField } from '../../ui'
import type { PreviewText } from './preview-text'
import { HtmlPreviewFrame, type PreviewFocus } from './HtmlPreviewFrame'
import type { HtmlPreviewRect } from '../../../../shared/html-artifact-preview'
import { CANVAS_RESOLVE_TIMEOUT_MS, canvasResolveMessage, canvasTimelineMessage, readCanvasBridgeEvent, type CanvasComposition, type CanvasElementRect, type CanvasResolveTarget } from '../../../../shared/html-canvas-bridge'
import {
  CANVAS_COMPOSITION_DEVICE,
  CANVAS_DEVICE_ORDER,
  CANVAS_FRAME_STATE_KEY,
  CANVAS_HEAD_CHROME,
  clampCustomWidth,
  fitView,
  frameFocusView,
  rectFocusView,
  layoutFrames,
  panBy,
  parseCanvasFrameState,
  serializeCanvasFrameState,
  setCanvasCustomWidth,
  setCanvasDevices,
  viewportFor,
  visibleViewports,
  wheelZoomFactor,
  zoomAt,
  zoomStep,
  type CanvasDeviceId,
  type CanvasFrameId,
  type CanvasFrameState,
  type CanvasView,
  type CanvasViewport
} from './html-canvas-model'
import { CANVAS_TOOLS, DEFAULT_CANVAS_TOOL, availableCanvasTools, canvasTool } from './canvas-tools/registry'
import { dockBottomInset, dockReserveHeight } from './canvas-tools/dock-model'
import { clampTimelineTime, sameComposition } from './canvas-tools/timeline-model'
import { timelineText } from './canvas-tools/timeline-text'
import type { CanvasElementInfo, CanvasFrameInput, CanvasResolveOutcome, CanvasTool, CanvasToolContext, CanvasToolId } from './canvas-tools/types'
import './html-canvas.css'

const HEAD_HEIGHT = CANVAS_HEAD_CHROME
const COMPACT_HEAD = 132
const KEY_PAN = 48
const AGENT_GAP = 6
const AGENT_TIP = 24
const CANVAS_CHROME_SELECTOR = '.v3-canvas-panel, .v3-canvas-comment-panel, .v3-canvas-comment-composer, .v3-canvas-edit-panel, .v3-canvas-timeline, .v3-canvas-toolbar, .v3-canvas-agent'
const OVERLAY_TARGET = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
const NARROW_CANVAS = 520
const DOCK_TOOLS: readonly CanvasToolId[] = ['inspect', 'comment', 'draw', 'edit']
const EDITABLE_TARGET = 'input, textarea, select, [role="textbox"], [contenteditable="true"]'
let resolveSeq = 0

function readFrameState(): CanvasFrameState {
  try {
    return parseCanvasFrameState(window.localStorage.getItem(CANVAS_FRAME_STATE_KEY))
  } catch {
    return parseCanvasFrameState(null)
  }
}

export function HtmlCanvas({
  abs,
  name,
  cwd,
  labels,
  revision,
  generating,
  draft = null,
  focus = null,
  onOpen,
  onViewSource
}: {
  abs: string
  name: string
  cwd: string
  labels: PreviewText
  revision: number
  generating: boolean
  draft?: string | null
  focus?: PreviewFocus | null
  onOpen: () => void
  onViewSource: () => void
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameElements = useRef(new Map<string, HTMLIFrameElement>())
  const frameMeta = useRef(new Map<string, { hash: string; nonce: string }>())
  const resolvePending = useRef(new Map<string, { settle: (outcome: CanvasResolveOutcome) => void; timer: number }>())
  const touched = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [frameState, setFrameState] = useState<CanvasFrameState>(readFrameState)
  const [composition, setComposition] = useState<CanvasComposition | null>(null)
  const [webFrames, setWebFrames] = useState(false)
  const [playback, setPlayback] = useState<{ t: number; paused: boolean }>({ t: 0, paused: true })
  const activeComposition = composition && !webFrames ? composition : null
  const viewports = useMemo(() => visibleViewports(frameState, activeComposition), [frameState, activeComposition])
  const layout = useMemo(() => layoutFrames(viewports), [viewports])
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 0.25 })
  const [running, setRunning] = useState<CanvasFrameId | null>(null)
  const [tool, setTool] = useState<CanvasToolId>(DEFAULT_CANVAS_TOOL)
  const [hover, setHover] = useState<CanvasElementInfo | null>(null)
  const [selection, setSelection] = useState<CanvasElementInfo | null>(null)
  const [reloads, setReloads] = useState(0)
  const [bridgeTick, setBridgeTick] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [dockCollapsed, setDockCollapsed] = useState(true)
  const [dockReserve, setDockReserve] = useState(0)
  const [dockInset, setDockInset] = useState(0)
  const [agentPoint, setAgentPoint] = useState<{ x: number; y: number } | null>(null)
  const [widthDraft, setWidthDraft] = useState(String(frameState.customWidth))
  const activeTool = canvasTool(tool)
  const bridgeTool = activeTool.frameInput === 'bridge' ? activeTool.id : null
  const bridgeRef = useRef<string | null>(bridgeTool)
  bridgeRef.current = bridgeTool
  const compositionRef = useRef<CanvasComposition | null>(null)
  const playbackRef = useRef<{ t: number; paused: boolean }>({ t: 0, paused: true })
  playbackRef.current = playback
  const autoTimeline = useRef(false)
  const toolsRef = useRef<readonly CanvasTool[]>(CANVAS_TOOLS)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const timelineReady = activeComposition !== null
  const first = layout.frames[0]

  useEffect(() => {
    try {
      window.localStorage.setItem(CANVAS_FRAME_STATE_KEY, serializeCanvasFrameState(frameState))
    } catch {
      return
    }
  }, [frameState])

  useEffect(() => {
    if (!generating) setAgentPoint(null)
  }, [generating])

  useEffect(() => {
    setHover(null)
    if (tool !== 'inspect') setSelection(null)
    setDockCollapsed(true)
  }, [tool])

  useEffect(() => {
    autoTimeline.current = false
    compositionRef.current = null
    setComposition(null)
    setWebFrames(false)
    setPlayback({ t: 0, paused: true })
  }, [abs, revision])

  useEffect(() => {
    if (!timelineReady && tool === 'timeline') setTool(DEFAULT_CANVAS_TOOL)
  }, [timelineReady, tool])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setNarrow(entry.contentRect.width < NARROW_CANVAS)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const toolbar = root?.querySelector<HTMLElement>('.v3-canvas-toolbar')
    if (!root || !toolbar) return undefined
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--canvas-toolbar-h', `${toolbar.offsetHeight}px`)
    })
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [])

  const dockTool = narrow && DOCK_TOOLS.includes(tool)

  useEffect(() => {
    const stage = stageRef.current
    const panel = stage && dockTool ? stage.querySelector<HTMLElement>(':scope > aside') : null
    if (!stage || !panel) {
      setDockReserve(0)
      setDockInset(0)
      return undefined
    }
    const measure = (): void => {
      const box = { top: panel.offsetTop, height: panel.offsetHeight }
      setDockReserve(dockReserveHeight(stage.clientHeight, box))
      setDockInset(dockBottomInset(stage.clientHeight, box))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [dockTool, tool, dockCollapsed])

  const fit = useCallback((): void => {
    const stage = stageRef.current
    if (!stage) return
    const panel = stage.parentElement?.querySelector<HTMLElement>('.v3-canvas-timeline')
    const reserved = (panel ? panel.offsetHeight + 12 : 0) + (dockTool ? dockReserve : 0)
    setView(fitView(stage.clientWidth, Math.max(120, stage.clientHeight - reserved), layout.width, layout.height, 56))
  }, [layout.width, layout.height, dockTool, dockReserve])

  useEffect(() => {
    touched.current = false
    const frame = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(frame)
  }, [layout.width, layout.height])

  useEffect(() => {
    if (touched.current) return undefined
    const frame = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(frame)
  }, [tool, fit])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const observer = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    observer.observe(stage)
    if (!touched.current) fit()
    return () => observer.disconnect()
  }, [fit])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (event.target instanceof Element && event.target.closest(CANVAS_CHROME_SELECTOR)) {
        if (event.ctrlKey || event.metaKey) event.preventDefault()
        return
      }
      event.preventDefault()
      touched.current = true
      const rect = stage.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        const factor = wheelZoomFactor(event.deltaY)
        setView((current) => zoomAt(current, current.zoom * factor, event.clientX - rect.left, event.clientY - rect.top))
        return
      }
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY
      setView((current) => panBy(current, -dx, -dy))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || target.closest(EDITABLE_TARGET))) return
      if (target?.closest(OVERLAY_TARGET)) return
      if (event.key === 'Escape') {
        if (selectionRef.current) {
          setSelection(null)
          return
        }
        setRunning(null)
        setTool(DEFAULT_CANVAS_TOOL)
        return
      }
      const pressed = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      const next = pressed ? toolsRef.current.find((candidate) => candidate.shortcut === pressed) : undefined
      if (!next) return
      event.preventDefault()
      setTool(next.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const postToFrame = useCallback((frameId: string, message: Record<string, unknown>): void => {
    frameElements.current.get(frameId)?.contentWindow?.postMessage(message, '*')
  }, [])

  const reloadFrames = useCallback((): void => {
    setReloads((value) => value + 1)
  }, [])

  const select = useCallback((info: CanvasElementInfo | null): void => {
    setSelection(info)
    if (info) setHover(info)
  }, [])

  const settleResolve = useCallback((frameId: string, id: string, rect: CanvasElementRect | null): void => {
    const key = `${frameId}|${id}`
    const pending = resolvePending.current.get(key)
    if (!pending) return
    resolvePending.current.delete(key)
    window.clearTimeout(pending.timer)
    pending.settle(rect ? { state: 'found', rect } : { state: 'missing' })
  }, [])

  const resolveElement = useCallback(
    (frameId: string, target: CanvasResolveTarget, timeoutMs = CANVAS_RESOLVE_TIMEOUT_MS): Promise<CanvasResolveOutcome> => {
      if (!frameElements.current.get(frameId)) return Promise.resolve({ state: 'unknown' })
      const id = `r${(++resolveSeq).toString(36)}`
      const key = `${frameId}|${id}`
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          resolvePending.current.delete(key)
          resolve({ state: 'unknown' })
        }, timeoutMs)
        resolvePending.current.set(key, { settle: resolve, timer })
        postToFrame(frameId, canvasResolveMessage(id, target))
      })
    },
    [postToFrame]
  )

  const onBridgeMessage = useCallback(
    (frameId: string, data: unknown, nonce: string): void => {
      const event = readCanvasBridgeEvent(data, nonce)
      if (!event) return
      if (event.kind === 'ready' || event.kind === 'scroll') {
        setBridgeTick((value) => value + 1)
        return
      }
      if (event.kind === 'resolve') {
        settleResolve(frameId, event.id, event.rect)
        return
      }
      if (event.kind === 'composition') {
      const next = event.composition
      const previous = compositionRef.current
      if (sameComposition(previous, next)) {
        const current = playbackRef.current
        if (current.t > 0 && current.paused) {
          postToFrame(CANVAS_COMPOSITION_DEVICE, canvasTimelineMessage('seek', current.t))
        }
        return
      }
      compositionRef.current = next
      setComposition(next)
      setWebFrames(false)
      if (!previous || previous.id !== next.id || previous.duration !== next.duration || previous.width !== next.width || previous.height !== next.height) {
        setPlayback({ t: 0, paused: true })
      }
      if (!autoTimeline.current) {
        autoTimeline.current = true
        setTool('timeline')
      }
      return
    }
    if (event.kind === 'time') {
      setPlayback({ t: clampTimelineTime(event.time.t, compositionRef.current?.duration ?? 0), paused: event.time.paused })
      return
    }
    if (!bridgeRef.current) return
    if (event.kind === 'hover') {
      setHover(event.info ? { ...event.info, frameId } : null)
      return
    }
    if (event.kind !== 'select') return
    setSelection({ ...event.info, frameId })
    setHover({ ...event.info, frameId })
  }, [postToFrame, settleResolve])

  const bindFrame = useCallback((frameId: string, element: HTMLIFrameElement | null): void => {
    if (element) {
      if (frameElements.current.get(frameId) === element) return
      frameElements.current.set(frameId, element)
      setBridgeTick((value) => value + 1)
    } else frameElements.current.delete(frameId)
  }, [])

  const bindFrameMeta = useCallback((frameId: string, meta: { hash: string; nonce: string } | null): void => {
    if (meta) frameMeta.current.set(frameId, meta)
    else frameMeta.current.delete(frameId)
  }, [])

  const onDesktopFocus = useCallback(
    (rect: HtmlPreviewRect | null): void => {
      if (!rect || !first) return
      const { width, height } = first.viewport
      const x = Math.min(width - AGENT_TIP, Math.max(0, rect.x + Math.min(rect.w, AGENT_TIP)))
      const y = Math.min(height - AGENT_TIP, Math.max(0, rect.y + rect.h))
      setAgentPoint({ x: first.left + x, y: first.top + y })
    },
    [first]
  )

  const zoomCenter = (next: number): void => {
    const stage = stageRef.current
    if (!stage) return
    touched.current = true
    setView((current) => zoomAt(current, next, stage.clientWidth / 2, stage.clientHeight / 2))
  }

  const refit = (): void => {
    touched.current = false
    fit()
  }

  const focusFrame = (frame: (typeof layout.frames)[number]): void => {
    const stage = stageRef.current
    if (!stage) return
    touched.current = true
    setView(frameFocusView(frame, stage.clientWidth, stage.clientHeight, 56, HEAD_HEIGHT))
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as HTMLElement).closest('[data-canvas-interactive]')) return
    if (event.button === 0 && tool !== DEFAULT_CANVAS_TOOL) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!dx && !dy) return
    touched.current = true
    drag.current = { ...current, x: event.clientX, y: event.clientY }
    setView((value) => panBy(value, dx, dy))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    const key = event.key
    if (key === '+' || key === '=') zoomCenter(zoomStep(view.zoom, 1))
    else if (key === '-' || key === '_') zoomCenter(zoomStep(view.zoom, -1))
    else if (key === '0') refit()
    else if (key === '1') zoomCenter(1)
    else if (key.startsWith('Arrow')) {
      if (tool === 'timeline' && (key === 'ArrowLeft' || key === 'ArrowRight')) return
      touched.current = true
      const dx = key === 'ArrowLeft' ? KEY_PAN : key === 'ArrowRight' ? -KEY_PAN : 0
      const dy = key === 'ArrowUp' ? KEY_PAN : key === 'ArrowDown' ? -KEY_PAN : 0
      setView((current) => panBy(current, dx, dy))
    } else return
    event.preventDefault()
  }

  const inputFor = (id: CanvasFrameId): CanvasFrameInput => {
    if (activeTool.frameInput === 'native') return 'native'
    if (activeTool.frameInput === 'bridge') return 'bridge'
    return running === id ? 'native' : 'none'
  }

  const deviceName = (id: CanvasDeviceId): string => {
    if (id === 'desktop') return labels.canvasDeviceDesktop
    if (id === 'laptop') return labels.canvasDeviceLaptop
    if (id === 'tablet') return labels.canvasDeviceTablet
    if (id === 'phone') return labels.canvasDevicePhone
    return labels.canvasDeviceCustom
  }

  const frameName = (viewport: CanvasViewport): string =>
    viewport.id === CANVAS_COMPOSITION_DEVICE
      ? timelineText(labels.lang).frameName(viewport.width, viewport.height)
      : deviceName(viewport.id)

  const frameTitle = (viewport: CanvasViewport): string =>
    viewport.id === CANVAS_COMPOSITION_DEVICE
      ? frameName(viewport)
      : `${frameName(viewport)} · ${viewport.width}×${viewport.height}`

  const deviceSize = (id: CanvasDeviceId): string => {
    const viewport = viewportFor(id, frameState.customWidth)
    return `${viewport.width}×${viewport.height}`
  }

  const chooseDevices = (keys: Set<string>): void => {
    if (composition) setWebFrames(true)
    setFrameState((state) => setCanvasDevices(state, CANVAS_DEVICE_ORDER.filter((id) => keys.has(id))))
  }

  const commitWidth = (): void => {
    const next = clampCustomWidth(Number(widthDraft.replace(/[^0-9.]/g, '')))
    setWidthDraft(String(next))
    setFrameState((state) => setCanvasCustomWidth(state, next))
  }

  const totalDuration = activeComposition ? activeComposition.duration : 0

  const seekComposition = useCallback(
    (value: number): void => {
      const next = clampTimelineTime(value, totalDuration)
      setPlayback((current) => ({ ...current, t: next }))
      postToFrame(CANVAS_COMPOSITION_DEVICE, canvasTimelineMessage('seek', next))
    },
    [postToFrame, totalDuration]
  )

  const playComposition = useCallback((): void => {
    setPlayback((current) => ({ ...current, paused: false }))
    postToFrame(CANVAS_COMPOSITION_DEVICE, canvasTimelineMessage('play'))
  }, [postToFrame])

  const pauseComposition = useCallback((): void => {
    setPlayback((current) => ({ ...current, paused: true }))
    postToFrame(CANVAS_COMPOSITION_DEVICE, canvasTimelineMessage('pause'))
  }, [postToFrame])

  const context: CanvasToolContext = {
    abs,
    cwd,
    name,
    labels,
    generating,
    frames: layout.frames,
    view,
    hover,
    selection,
    refreshTick: bridgeTick,
    composition: activeComposition,
    currentTime: activeComposition ? playback.t : null,
    playing: activeComposition ? !playback.paused : false,
    narrow,
    dockCollapsed: dockTool ? dockCollapsed : false,
    dockInset: dockTool ? dockInset : 0,
    toggleDock: () => setDockCollapsed((value) => !value),
    select,
    postToFrame,
    reloadFrames,
    frameElement: (frameId) => frameElements.current.get(frameId) ?? null,
    frameHash: (frameId) => frameMeta.current.get(frameId)?.hash ?? '',
    resolveElement,
    seekComposition,
    playComposition,
    pauseComposition,
    focusRect: (frameId, rect, padding) => {
      const stage = stageRef.current
      const frame = layout.frames.find((item) => item.viewport.id === frameId)
      if (!stage || !frame) return Promise.resolve()
      touched.current = true
      setView(rectFocusView(frame, rect, stage.clientWidth, stage.clientHeight, padding))
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))
    }
  }
  const tools = availableCanvasTools(context)
  toolsRef.current = tools
  const Overlay = activeTool.Overlay
  const Panel = activeTool.Panel
  const percent = `${Math.round(view.zoom * 100)}%`
  const agentLeft = agentPoint ? agentPoint.x : first ? first.left : 0
  const agentTop = agentPoint ? agentPoint.y : first ? first.top + first.viewport.height + AGENT_GAP / view.zoom : 0

  return (
    <div className="v3-canvas" data-testid="v3-html-canvas" data-narrow={narrow || undefined} ref={rootRef}>
      <div
        ref={stageRef}
        className="v3-canvas-stage"
        data-dragging={dragging || undefined}
        data-tool={tool}
        tabIndex={0}
        role="group"
        aria-label={labels.canvasHint}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div
          className="v3-canvas-board"
          style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, ['--canvas-zoom' as string]: view.zoom }}
        >
          {layout.frames.map((frame) => (
            <div
              key={frame.viewport.id}
              className="v3-canvas-frame"
              data-input={inputFor(frame.viewport.id)}
              data-running={running === frame.viewport.id || undefined}
              data-canvas-interactive={inputFor(frame.viewport.id) !== 'none' || undefined}
              data-testid={`v3-canvas-frame-${frame.viewport.id}`}
              style={{ left: frame.left, top: frame.top, width: frame.viewport.width, height: frame.viewport.height }}
            >
              <HtmlPreviewFrame
                abs={abs}
                name={`${name} · ${frameName(frame.viewport)}`}
                cwd={cwd}
                labels={labels}
                revision={revision + reloads}
                draft={draft}
                focus={generating ? focus : null}
                follow={frame.viewport.id !== running}
                frameId={frame.viewport.id}
                bridgeTool={bridgeTool}
                onBridgeMessage={onBridgeMessage}
                onFrameElement={(element) => bindFrame(frame.viewport.id, element)}
                onFrameMeta={(meta) => bindFrameMeta(frame.viewport.id, meta)}
                onFocusRect={frame === first ? onDesktopFocus : undefined}
                onViewSource={onViewSource}
              />
            </div>
          ))}
          {generating && first ? (
            <div
              className="v3-canvas-agent"
              role="status"
              data-testid="v3-canvas-agent"
              data-placed={agentPoint ? '1' : undefined}
              style={{ left: agentLeft, top: agentTop }}
            >
              <MousePointer2 size={16} aria-hidden />
              <Badge tone="accent">{labels.canvasAgentEditing}</Badge>
            </div>
          ) : null}
        </div>
        {Overlay
          ? layout.frames.map((frame) => <Overlay key={frame.viewport.id} frame={frame} view={view} context={context} />)
          : null}
        {layout.frames.map((frame) => {
          const width = frame.viewport.width * view.zoom
          const isRunning = running === frame.viewport.id
          return (
            <div
              key={frame.viewport.id}
              className="v3-canvas-head"
              data-canvas-interactive
              style={{ left: view.x + frame.left * view.zoom, top: view.y + frame.top * view.zoom - HEAD_HEIGHT, width }}
              onDoubleClick={() => focusFrame(frame)}
              title={labels.canvasFocusFrame}
            >
              <span className="v3-canvas-head-title">
                {width >= COMPACT_HEAD ? frameTitle(frame.viewport) : frameName(frame.viewport)}
              </span>
              <IconButton
                size="sm"
                variant={isRunning ? 'secondary' : 'ghost'}
                aria-label={isRunning ? labels.canvasStop : labels.canvasRun}
                title={isRunning ? labels.canvasStop : labels.canvasRun}
                aria-pressed={isRunning}
                data-testid={`v3-canvas-run-${frame.viewport.id}`}
                onPress={() => setRunning(isRunning ? null : frame.viewport.id)}
              >
                {isRunning ? <Square size={12} /> : <Play size={12} />}
              </IconButton>
              <IconButton
                size="sm"
                aria-label={labels.canvasReload}
                title={labels.canvasReload}
                data-testid={`v3-canvas-reload-${frame.viewport.id}`}
                onPress={reloadFrames}
              >
                <RotateCw size={12} />
              </IconButton>
            </div>
          )
        })}
        {Panel ? <Panel context={context} /> : null}
      </div>
      <div className="v3-canvas-toolbar" data-canvas-interactive>
        <div className="v3-canvas-tools" role="group" aria-label={labels.canvasTools}>
          {tools.map((candidate) => {
            const Icon = candidate.icon
            const active = candidate.id === tool
            return (
              <IconButton
                key={candidate.id}
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                aria-label={candidate.label(labels)}
                title={`${candidate.label(labels)} (${candidate.shortcut.toUpperCase()})`}
                aria-pressed={active}
                data-testid={`v3-canvas-tool-${candidate.id}`}
                onPress={() => setTool(candidate.id)}
              >
                <Icon size={14} />
              </IconButton>
            )
          })}
        </div>
        <span className="v3-canvas-toolbar-sep" aria-hidden />
        <IconButton size="sm" aria-label={labels.canvasZoomOut} title={labels.canvasZoomOut} onPress={() => zoomCenter(zoomStep(view.zoom, -1))}>
          <ZoomOut size={14} />
        </IconButton>
        <Button size="sm" variant="ghost" aria-label={labels.canvasZoomReset} data-testid="v3-canvas-zoom" onPress={() => zoomCenter(1)}>
          {percent}
        </Button>
        <IconButton size="sm" aria-label={labels.canvasZoomIn} title={labels.canvasZoomIn} onPress={() => zoomCenter(zoomStep(view.zoom, 1))}>
          <ZoomIn size={14} />
        </IconButton>
        <IconButton size="sm" aria-label={labels.canvasFit} title={labels.canvasFit} data-testid="v3-canvas-fit" onPress={refit}>
          <Maximize size={14} />
        </IconButton>
        <span className="v3-canvas-toolbar-sep" aria-hidden />
        <MenuTrigger>
          <IconButton size="sm" aria-label={labels.canvasDevices} title={labels.canvasDevices} data-testid="v3-canvas-devices">
            <Monitor size={14} />
          </IconButton>
          <Popover placement="bottom end" offset={6}>
            <div className="v3-canvas-devices" data-testid="v3-canvas-device-menu">
              {composition ? (
                <Button
                  size="sm"
                  variant={webFrames ? 'ghost' : 'secondary'}
                  aria-pressed={!webFrames}
                  data-testid="v3-canvas-device-composition"
                  onPress={() => setWebFrames(false)}
                >
                  {frameTitle({
                    id: CANVAS_COMPOSITION_DEVICE,
                    width: composition.width,
                    height: composition.height
                  })}
                </Button>
              ) : null}
              <Menu
                aria-label={labels.canvasDevices}
                selectionMode="multiple"
                selectedKeys={frameState.devices}
                onSelectionChange={(keys) => chooseDevices(new Set([...keys].map(String)))}
              >
                {CANVAS_DEVICE_ORDER.map((id) => (
                  <MenuItem key={id} id={id} textValue={deviceName(id)} aria-checked={frameState.devices.includes(id)} data-testid={`v3-canvas-device-${id}`}>
                    <span className="v3-canvas-check" aria-hidden>
                      {frameState.devices.includes(id) ? <Check size={14} /> : null}
                    </span>
                    <span className="v3-canvas-device-name">{deviceName(id)}</span>
                    <span className="v3-canvas-device-size">{deviceSize(id)}</span>
                  </MenuItem>
                ))}
              </Menu>
              <div className="v3-canvas-device-width">
                <TextField label={labels.canvasCustomWidth} value={widthDraft} onChange={setWidthDraft} isDisabled={!frameState.devices.includes('custom')}>
                  <Input
                    inputMode="numeric"
                    data-testid="v3-canvas-custom-width"
                    onBlur={commitWidth}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      commitWidth()
                    }}
                  />
                </TextField>
              </div>
            </div>
          </Popover>
        </MenuTrigger>
        <IconButton size="sm" aria-label={labels.canvasOpen} title={labels.canvasOpen} onPress={onOpen}>
          <ExternalLink size={14} />
        </IconButton>
      </div>
    </div>
  )
}
