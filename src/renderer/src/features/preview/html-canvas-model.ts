export interface CanvasView {
  x: number
  y: number
  zoom: number
}

export interface CanvasViewport {
  id: 'desktop' | 'phone'
  width: number
  height: number
}

export interface CanvasFrameBox {
  viewport: CanvasViewport
  left: number
  top: number
}

export const CANVAS_VIEWPORTS: readonly CanvasViewport[] = [
  { id: 'desktop', width: 1280, height: 800 },
  { id: 'phone', width: 390, height: 844 }
]

export const CANVAS_MIN_ZOOM = 0.1
export const CANVAS_MAX_ZOOM = 2
export const CANVAS_FRAME_GAP = 96
export const CANVAS_HEADER = 40

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom))
}

export function layoutFrames(viewports: readonly CanvasViewport[]): { frames: CanvasFrameBox[]; width: number; height: number } {
  const frames: CanvasFrameBox[] = []
  let left = 0
  let height = 0
  for (const viewport of viewports) {
    frames.push({ viewport, left, top: CANVAS_HEADER })
    left += viewport.width + CANVAS_FRAME_GAP
    height = Math.max(height, viewport.height + CANVAS_HEADER)
  }
  return { frames, width: Math.max(0, left - CANVAS_FRAME_GAP), height }
}

export function fitView(stageWidth: number, stageHeight: number, contentWidth: number, contentHeight: number, padding = 48): CanvasView {
  if (stageWidth <= 0 || stageHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) return { x: 0, y: 0, zoom: 1 }
  const zoom = clampZoom(Math.min((stageWidth - padding * 2) / contentWidth, (stageHeight - padding * 2) / contentHeight, 1))
  return {
    zoom,
    x: (stageWidth - contentWidth * zoom) / 2,
    y: (stageHeight - contentHeight * zoom) / 2
  }
}

export function zoomAt(view: CanvasView, nextZoom: number, pointX: number, pointY: number): CanvasView {
  const zoom = clampZoom(nextZoom)
  if (zoom === view.zoom) return view
  const ratio = zoom / view.zoom
  return {
    zoom,
    x: pointX - (pointX - view.x) * ratio,
    y: pointY - (pointY - view.y) * ratio
  }
}

export function panBy(view: CanvasView, dx: number, dy: number): CanvasView {
  return { ...view, x: view.x + dx, y: view.y + dy }
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-200, Math.min(200, deltaY)) * 0.0025)
}

export function zoomStep(zoom: number, direction: 1 | -1): number {
  const steps = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2]
  if (direction > 0) return steps.find((step) => step > zoom + 0.001) ?? CANVAS_MAX_ZOOM
  return [...steps].reverse().find((step) => step < zoom - 0.001) ?? CANVAS_MIN_ZOOM
}
