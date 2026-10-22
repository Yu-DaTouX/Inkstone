import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { ExternalLink, Maximize, MousePointer2, Play, Square, ZoomIn, ZoomOut } from 'lucide-react'
import { Badge, Button, IconButton } from '../../ui'
import type { PreviewText } from './preview-text'
import { HtmlPreviewFrame, type PreviewFocus } from './HtmlPreviewFrame'
import type { HtmlPreviewRect } from '../../../../shared/html-artifact-preview'
import {
  CANVAS_VIEWPORTS,
  fitView,
  layoutFrames,
  panBy,
  wheelZoomFactor,
  zoomAt,
  zoomStep,
  type CanvasView,
  type CanvasViewport
} from './html-canvas-model'
import './html-canvas.css'

const HEAD_HEIGHT = 32
const COMPACT_HEAD = 132
const KEY_PAN = 48
const AGENT_GAP = 6
const AGENT_TIP = 24

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
  const stageRef = useRef<HTMLDivElement>(null)
  const layout = useMemo(() => layoutFrames(CANVAS_VIEWPORTS), [])
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 0.25 })
  const [running, setRunning] = useState<CanvasViewport['id'] | null>(null)
  const [dragging, setDragging] = useState(false)
  const touched = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [agentPoint, setAgentPoint] = useState<{ x: number; y: number } | null>(null)
  const first = layout.frames[0]

  useEffect(() => {
    if (!generating) setAgentPoint(null)
  }, [generating])

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

  const fit = useCallback((): void => {
    const stage = stageRef.current
    if (!stage) return
    setView(fitView(stage.clientWidth, stage.clientHeight, layout.width, layout.height))
  }, [layout.width, layout.height])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const observer = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    observer.observe(stage)
    fit()
    return () => observer.disconnect()
  }, [fit])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const onWheel = (event: WheelEvent): void => {
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

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as HTMLElement).closest('[data-canvas-interactive]')) return
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
    else if (key === 'Escape' && running) setRunning(null)
    else if (key.startsWith('Arrow')) {
      touched.current = true
      const dx = key === 'ArrowLeft' ? KEY_PAN : key === 'ArrowRight' ? -KEY_PAN : 0
      const dy = key === 'ArrowUp' ? KEY_PAN : key === 'ArrowDown' ? -KEY_PAN : 0
      setView((current) => panBy(current, dx, dy))
    } else return
    event.preventDefault()
  }

  const viewportName = (id: CanvasViewport['id']): string =>
    id === 'desktop' ? labels.canvasDesktop : labels.canvasPhone
  const percent = `${Math.round(view.zoom * 100)}%`
  const agentLeft = agentPoint ? agentPoint.x : first ? first.left : 0
  const agentTop = agentPoint ? agentPoint.y : first ? first.top + first.viewport.height + AGENT_GAP / view.zoom : 0

  return (
    <div className="v3-canvas" data-testid="v3-html-canvas">
      <div
        ref={stageRef}
        className="v3-canvas-stage"
        data-dragging={dragging || undefined}
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
              data-running={running === frame.viewport.id || undefined}
              data-canvas-interactive={running === frame.viewport.id || undefined}
              data-testid={`v3-canvas-frame-${frame.viewport.id}`}
              style={{ left: frame.left, top: frame.top, width: frame.viewport.width, height: frame.viewport.height }}
              onDoubleClick={() => setRunning(frame.viewport.id)}
            >
              <HtmlPreviewFrame abs={abs} name={`${name} · ${viewportName(frame.viewport.id)}`} cwd={cwd} labels={labels} revision={revision} draft={draft} focus={generating ? focus : null} follow={running !== frame.viewport.id} onFocusRect={frame === first ? onDesktopFocus : undefined} onViewSource={onViewSource} />
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
        {layout.frames.map((frame) => {
          const width = frame.viewport.width * view.zoom
          const isRunning = running === frame.viewport.id
          return (
            <div
              key={frame.viewport.id}
              className="v3-canvas-head"
              data-canvas-interactive
              style={{ left: view.x + frame.left * view.zoom, top: view.y + frame.top * view.zoom - HEAD_HEIGHT, width }}
            >
              <span className="v3-canvas-head-title">
                {width >= COMPACT_HEAD ? `${viewportName(frame.viewport.id)} · ${frame.viewport.width}×${frame.viewport.height}` : viewportName(frame.viewport.id)}
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
            </div>
          )
        })}
      </div>
      <div className="v3-canvas-toolbar" data-canvas-interactive>
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
        <IconButton size="sm" aria-label={labels.canvasOpen} title={labels.canvasOpen} onPress={onOpen}>
          <ExternalLink size={14} />
        </IconButton>
      </div>
    </div>
  )
}
