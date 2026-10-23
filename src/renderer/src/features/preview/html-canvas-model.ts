export interface CanvasView {
  x: number
  y: number
  zoom: number
}

export type CanvasDeviceId = 'desktop' | 'laptop' | 'tablet' | 'phone' | 'custom'
export type CanvasCompositionDeviceId = 'composition'
export type CanvasFrameId = CanvasDeviceId | CanvasCompositionDeviceId

export interface CanvasViewport {
  id: CanvasFrameId
  width: number
  height: number
}

export interface CanvasFrameBox {
  viewport: CanvasViewport
  left: number
  top: number
}

export interface CanvasFrameState {
  devices: CanvasDeviceId[]
  customWidth: number
  customHeight: number
}

export const CANVAS_DEVICE_ORDER: readonly CanvasDeviceId[] = ['desktop', 'laptop', 'tablet', 'phone', 'custom']

export const CANVAS_DEVICE_PRESETS: readonly CanvasViewport[] = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'laptop', width: 1280, height: 800 },
  { id: 'tablet', width: 834, height: 1194 },
  { id: 'phone', width: 390, height: 844 }
]

export const CANVAS_CUSTOM_DEVICE = { width: 1024, minWidth: 320, maxWidth: 2560, height: 900, minHeight: 240, maxHeight: 4096 } as const

export const CANVAS_FRAME_STATE_KEY = 'yan.preview.canvasFrames'

export const CANVAS_DEFAULT_FRAME_STATE: CanvasFrameState = { devices: ['desktop', 'phone'], customWidth: CANVAS_CUSTOM_DEVICE.width, customHeight: CANVAS_CUSTOM_DEVICE.height }

export const CANVAS_MIN_ZOOM = 0.1
export const CANVAS_MAX_ZOOM = 2
export const CANVAS_FRAME_GAP = 96
export const CANVAS_HEADER = 40
export const CANVAS_HEAD_CHROME = 32

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom))
}

export function clampCustomWidth(width: number): number {
  if (!Number.isFinite(width)) return CANVAS_CUSTOM_DEVICE.width
  return Math.round(Math.min(CANVAS_CUSTOM_DEVICE.maxWidth, Math.max(CANVAS_CUSTOM_DEVICE.minWidth, width)))
}

export function clampCustomHeight(height: number): number {
  if (!Number.isFinite(height)) return CANVAS_CUSTOM_DEVICE.height
  return Math.round(Math.min(CANVAS_CUSTOM_DEVICE.maxHeight, Math.max(CANVAS_CUSTOM_DEVICE.minHeight, height)))
}

export function viewportFor(id: CanvasDeviceId, customWidth: number, customHeight: number = CANVAS_CUSTOM_DEVICE.height): CanvasViewport {
  if (id === 'custom') return { id, width: clampCustomWidth(customWidth), height: clampCustomHeight(customHeight) }
  const preset = CANVAS_DEVICE_PRESETS.find((candidate) => candidate.id === id) ?? CANVAS_DEVICE_PRESETS[0]
  return { id, width: preset.width, height: preset.height }
}

export const CANVAS_COMPOSITION_DEVICE: CanvasCompositionDeviceId = 'composition'
export const CANVAS_COMPOSITION_MIN = 64
export const CANVAS_COMPOSITION_MAX = 4096

export interface CanvasCompositionSize {
  width: number
  height: number
}

export function compositionSize(composition: CanvasCompositionSize | null | undefined): CanvasCompositionSize | null {
  if (!composition) return null
  const width = composition.width
  const height = composition.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const fit = (value: number): number => Math.round(Math.min(CANVAS_COMPOSITION_MAX, Math.max(CANVAS_COMPOSITION_MIN, value)))
  return { width: fit(width), height: fit(height) }
}

export function compositionViewport(composition: CanvasCompositionSize | null | undefined): CanvasViewport | null {
  const size = compositionSize(composition)
  return size ? { id: CANVAS_COMPOSITION_DEVICE, width: size.width, height: size.height } : null
}

export function visibleViewports(
  state: CanvasFrameState,
  composition: CanvasCompositionSize | null = null
): CanvasViewport[] {
  const viewport = compositionViewport(composition)
  if (viewport) return [viewport]
  const devices = state.devices.length ? state.devices : CANVAS_DEFAULT_FRAME_STATE.devices
  return devices.map((id) => viewportFor(id, state.customWidth, state.customHeight))
}

export function toggleCanvasDevice(state: CanvasFrameState, id: CanvasDeviceId): CanvasFrameState {
  if (state.devices.includes(id)) {
    return state.devices.length <= 1 ? state : setCanvasDevices(state, state.devices.filter((device) => device !== id))
  }
  return setCanvasDevices(state, [...state.devices, id])
}

export function setCanvasDevices(state: CanvasFrameState, devices: readonly CanvasDeviceId[]): CanvasFrameState {
  const next = CANVAS_DEVICE_ORDER.filter((id) => devices.includes(id))
  return next.length ? { ...state, devices: next } : state
}

export function setCanvasCustomWidth(state: CanvasFrameState, width: number): CanvasFrameState {
  return { ...state, customWidth: clampCustomWidth(width) }
}

export function setCanvasCustomHeight(state: CanvasFrameState, height: number): CanvasFrameState {
  return { ...state, customHeight: clampCustomHeight(height) }
}

export function parseCanvasFrameState(raw: string | null): CanvasFrameState {
  if (!raw) return { ...CANVAS_DEFAULT_FRAME_STATE, devices: [...CANVAS_DEFAULT_FRAME_STATE.devices] }
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') throw new Error('not an object')
    const record = value as Record<string, unknown>
    const chosen = Array.isArray(record.devices)
      ? record.devices.filter((id): id is CanvasDeviceId => typeof id === 'string' && CANVAS_DEVICE_ORDER.includes(id as CanvasDeviceId))
      : []
    const devices = CANVAS_DEVICE_ORDER.filter((id) => chosen.includes(id))
    const customWidth = typeof record.customWidth === 'number' ? clampCustomWidth(record.customWidth) : CANVAS_DEFAULT_FRAME_STATE.customWidth
    const customHeight = typeof record.customHeight === 'number' ? clampCustomHeight(record.customHeight) : CANVAS_DEFAULT_FRAME_STATE.customHeight
    return { devices: devices.length ? devices : [...CANVAS_DEFAULT_FRAME_STATE.devices], customWidth, customHeight }
  } catch {
    return { ...CANVAS_DEFAULT_FRAME_STATE, devices: [...CANVAS_DEFAULT_FRAME_STATE.devices] }
  }
}

export function serializeCanvasFrameState(state: CanvasFrameState): string {
  return JSON.stringify({
    devices: CANVAS_DEVICE_ORDER.filter((id) => state.devices.includes(id)),
    customWidth: clampCustomWidth(state.customWidth),
    customHeight: clampCustomHeight(state.customHeight)
  })
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

export function frameFocusView(frame: CanvasFrameBox, stageWidth: number, stageHeight: number, padding = 32, headHeight = CANVAS_HEAD_CHROME): CanvasView {
  const { width, height } = frame.viewport
  if (stageWidth <= 0 || stageHeight <= 0 || width <= 0 || height <= 0) return { x: 0, y: 0, zoom: 1 }
  const zoom = clampZoom(Math.min((stageWidth - padding * 2) / width, (stageHeight - padding * 2 - headHeight) / height, 1))
  const boxHeight = height * zoom + headHeight
  return {
    zoom,
    x: (stageWidth - width * zoom) / 2 - frame.left * zoom,
    y: (stageHeight - boxHeight) / 2 + headHeight - frame.top * zoom
  }
}

export function rectFocusView(
  frame: CanvasFrameBox,
  rect: { x: number; y: number; w: number; h: number },
  stageWidth: number,
  stageHeight: number,
  padding = 48,
  maxZoom = 1
): CanvasView {
  const w = Math.max(1, rect.w)
  const h = Math.max(1, rect.h)
  if (stageWidth <= 0 || stageHeight <= 0) return { x: 0, y: 0, zoom: 1 }
  const zoom = clampZoom(Math.min((stageWidth - padding * 2) / w, (stageHeight - padding * 2) / h, maxZoom))
  const centerX = frame.left + rect.x + w / 2
  const centerY = frame.top + rect.y + h / 2
  return { zoom, x: stageWidth / 2 - centerX * zoom, y: stageHeight / 2 - centerY * zoom }
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

export function stageRect(
  frame: CanvasFrameBox,
  view: CanvasView,
  rect: { x: number; y: number; w: number; h: number }
): { left: number; top: number; width: number; height: number } {
  return {
    left: view.x + (frame.left + rect.x) * view.zoom,
    top: view.y + (frame.top + rect.y) * view.zoom,
    width: rect.w * view.zoom,
    height: rect.h * view.zoom
  }
}
