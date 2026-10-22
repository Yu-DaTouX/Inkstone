import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { Input, TextField } from '../../../ui'
import {
  DRAW_MIN_SIZE,
  DRAW_STROKE_WIDTH,
  DRAW_TEXT_SIZE,
  distance,
  drawColor,
  rectFromPoints,
  rectIsTiny,
  resolveDrawColors,
  shapeSvg,
  shapesSvg,
  simplifyPoints,
  textLines,
  type DrawPoint,
  type DrawPen,
  type DrawShape
} from './draw-model'
import {
  commitDrawShape,
  drawFrameState,
  drawSnapshot,
  setDrawActive,
  subscribeDraw,
  syncDrawFile
} from './draw-store'
import { drawText } from './draw-text'
import type { CanvasToolOverlayProps } from './types'
import './draw.css'

const EMPTY_SHAPES: readonly DrawShape[] = []

let palette: Record<string, string> | null = null
let paletteTheme = ''

function readCssColor(variable: string): string | null {
  const probe = document.createElement('span')
  probe.style.color = `var(${variable})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const value = window.getComputedStyle(probe).color
  probe.remove()
  return value || null
}

export function drawColors(): Record<string, string> {
  const theme = typeof document === 'undefined' ? '' : document.documentElement.dataset.theme ?? ''
  if (!palette || paletteTheme !== theme) {
    palette = resolveDrawColors(readCssColor)
    paletteTheme = theme
  }
  return palette
}

function shapeFromDrag(pen: DrawPen, from: DrawPoint, to: DrawPoint, points: readonly DrawPoint[], color: string): DrawShape | null {
  if (pen === 'free') return { kind: 'free', points: [...points], color, width: DRAW_STROKE_WIDTH }
  if (pen === 'rect') return { kind: 'rect', rect: rectFromPoints(from, to), color, width: DRAW_STROKE_WIDTH }
  if (pen === 'ellipse') return { kind: 'ellipse', rect: rectFromPoints(from, to), color, width: DRAW_STROKE_WIDTH }
  if (pen === 'arrow') return { kind: 'arrow', from, to, color, width: DRAW_STROKE_WIDTH }
  return null
}

function shapeIsEmpty(shape: DrawShape): boolean {
  if (shape.kind === 'free') return shape.points.length < 1
  if (shape.kind === 'arrow') return distance(shape.from, shape.to) < DRAW_MIN_SIZE
  if (shape.kind === 'rect' || shape.kind === 'ellipse') return rectIsTiny(shape.rect)
  return !textLines(shape.text).length
}

export function DrawOverlay({ frame, view, context }: CanvasToolOverlayProps): ReactElement {
  const state = useSyncExternalStore(subscribeDraw, drawSnapshot)
  const text = drawText(context.labels.lang)
  const colors = drawColors()
  const frameId = frame.viewport.id
  const zoom = view.zoom > 0 ? view.zoom : 1
  const unit = 1 / zoom
  const shapes = state.abs === context.abs ? drawFrameState(context.abs, frameId).shapes : EMPTY_SHAPES
  const [draft, setDraft] = useState<DrawShape | null>(null)
  const [label, setLabel] = useState<{ x: number; y: number; token: number } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  const labelTokenRef = useRef(0)
  const strokeRef = useRef<{ pointerId: number; origin: DrawPoint; points: DrawPoint[]; last: DrawPoint } | null>(null)
  const pen = state.pen
  const color = drawColor(state.color, colors)
  const halo = colors.halo ?? '#FCFCFB'
  const left = view.x + frame.left * zoom
  const top = view.y + frame.top * zoom
  const width = frame.viewport.width * zoom
  const height = frame.viewport.height * zoom

  useEffect(() => {
    syncDrawFile(context.abs)
  }, [context.abs])

  useEffect(() => {
    if (!draft && !label) return undefined
    const cancel = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      strokeRef.current = null
      labelTokenRef.current += 1
      setDraft(null)
      setLabel(null)
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [draft, label])

  const pointOf = (event: { clientX: number; clientY: number }): DrawPoint => {
    const layer = layerRef.current
    if (!layer) return { x: 0, y: 0 }
    const box = layer.getBoundingClientRect()
    if (!(box.width > 0) || !(box.height > 0)) return { x: 0, y: 0 }
    return {
      x: ((event.clientX - box.left) * frame.viewport.width) / box.width,
      y: ((event.clientY - box.top) * frame.viewport.height) / box.height
    }
  }

  const commitLabel = (token: number): void => {
    if (!label || label.token !== token || labelTokenRef.current !== token) return
    const value = labelRef.current?.value ?? ''
    const at = { x: label.x, y: label.y }
    labelTokenRef.current += 1
    setLabel(null)
    if (!textLines(value).length) return
    commitDrawShape(context.abs, frameId, { kind: 'text', at, text: value, color, halo, size: DRAW_TEXT_SIZE * unit })
  }

  const cancelLabel = (): void => {
    labelTokenRef.current += 1
    setLabel(null)
  }

  const openLabel = (point: DrawPoint): void => {
    if (label) commitLabel(label.token)
    labelTokenRef.current += 1
    setLabel({ x: point.x, y: point.y, token: labelTokenRef.current })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target && target.closest('[data-canvas-draw-input]')) return
    if (event.button !== 0) return
    const point = pointOf(event)
    if (state.space) return
    if (pen === 'text') {
      event.preventDefault()
      setDrawActive(context.abs, frameId)
      openLabel(point)
      return
    }
    setDrawActive(context.abs, frameId)
    strokeRef.current = { pointerId: event.pointerId, origin: point, points: [point], last: point }
    setDraft(shapeFromDrag(pen, point, point, [point], color))
    layerRef.current?.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const stroke = strokeRef.current
    if (!stroke || stroke.pointerId !== event.pointerId) return
    const point = pointOf(event)
    if (pen === 'free') {
      if (distance(stroke.last, point) < Math.max(0.4, 2 * unit)) return
      stroke.points.push(point)
      stroke.last = point
      setDraft(shapeFromDrag('free', stroke.origin, point, stroke.points, color))
      return
    }
    stroke.last = point
    setDraft(shapeFromDrag(pen, stroke.origin, point, stroke.points, color))
  }

  const endStroke = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const stroke = strokeRef.current
    if (!stroke || stroke.pointerId !== event.pointerId) return
    strokeRef.current = null
    const point = event.type === 'pointercancel' ? stroke.last : pointOf(event)
    const shape =
      pen === 'free'
        ? shapeFromDrag('free', stroke.origin, point, simplifyPoints(stroke.points, Math.max(0.6, 1.2 * unit)), color)
        : shapeFromDrag(pen, stroke.origin, point, stroke.points, color)
    setDraft(null)
    if (!shape || shapeIsEmpty(shape)) return
    commitDrawShape(context.abs, frameId, shape)
  }

  return (
    <div
      ref={layerRef}
      className="v3-canvas-draw-layer"
      data-testid={`v3-canvas-draw-layer-${frameId}`}
      data-pen={pen}
      data-pan={state.space || undefined}
      data-hidden={state.captureHidden || undefined}
      style={{ left, top, width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    >
      <svg
        className="v3-canvas-draw-svg"
        viewBox={`0 0 ${frame.viewport.width} ${frame.viewport.height}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <g dangerouslySetInnerHTML={{ __html: shapesSvg(shapes, { unit }) }} />
        {draft ? <g dangerouslySetInnerHTML={{ __html: shapeSvg(draft, { unit }) }} /> : null}
      </svg>
      {label ? (
        <div
          className="v3-canvas-draw-label"
          data-canvas-draw-input
          style={{ left: label.x * zoom, top: label.y * zoom }}
        >
          <TextField aria-label={text.labelInput} defaultValue="">
            <Input
              ref={labelRef}
              autoFocus
              className="v3-canvas-draw-input"
              placeholder={text.labelPlaceholder}
              data-testid={`v3-canvas-draw-input-${frameId}`}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  event.nativeEvent.stopImmediatePropagation()
                  cancelLabel()
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitLabel(label.token)
                }
              }}
              onBlur={() => commitLabel(label.token)}
            />
          </TextField>
        </div>
      ) : null}
    </div>
  )
}
