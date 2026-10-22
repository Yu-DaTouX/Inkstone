import { DRAW_DEFAULT_COLOR, type DrawPen, type DrawShape } from './draw-model'

export interface DrawFrameState {
  shapes: DrawShape[]
  past: DrawShape[][]
  future: DrawShape[][]
}

export interface DrawState {
  abs: string | null
  frames: Record<string, DrawFrameState>
  active: string | null
  pen: DrawPen
  color: string
  space: boolean
  captureHidden: boolean
  version: number
}

const EMPTY_SHAPES: DrawShape[] = []
const EMPTY_FRAME: DrawFrameState = { shapes: EMPTY_SHAPES, past: [], future: [] }

let state: DrawState = {
  abs: null,
  frames: {},
  active: null,
  pen: 'free',
  color: DRAW_DEFAULT_COLOR,
  space: false,
  captureHidden: false,
  version: 0
}

const listeners = new Set<() => void>()

function publish(next: DrawState): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribeDraw(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function drawSnapshot(): DrawState {
  return state
}

export function drawFrameState(abs: string, frameId: string): DrawFrameState {
  if (state.abs !== abs) return EMPTY_FRAME
  return state.frames[frameId] ?? EMPTY_FRAME
}

export function drawFrameShapes(abs: string, frameId: string): readonly DrawShape[] {
  return drawFrameState(abs, frameId).shapes
}

function setFrame(abs: string, frameId: string, frame: DrawFrameState): void {
  if (state.abs !== abs) return
  publish({
    ...state,
    frames: { ...state.frames, [frameId]: frame },
    active: frameId,
    version: state.version + 1
  })
}

export function syncDrawFile(abs: string): void {
  if (state.abs === abs) return
  publish({
    ...state,
    abs,
    frames: {},
    active: null,
    captureHidden: false,
    version: state.version + 1
  })
}

export function setDrawPen(pen: DrawPen): void {
  if (state.pen === pen) return
  publish({ ...state, pen, version: state.version + 1 })
}

export function setDrawColor(color: string): void {
  if (state.color === color) return
  publish({ ...state, color, version: state.version + 1 })
}

export function setDrawActive(abs: string, frameId: string): void {
  if (state.abs !== abs || state.active === frameId) return
  publish({ ...state, active: frameId, version: state.version + 1 })
}

export function setDrawSpace(space: boolean): void {
  if (state.space === space) return
  publish({ ...state, space, version: state.version + 1 })
}

export function setDrawCaptureHidden(hidden: boolean): void {
  if (state.captureHidden === hidden) return
  publish({ ...state, captureHidden: hidden, version: state.version + 1 })
}

export function commitDrawShape(abs: string, frameId: string, shape: DrawShape): void {
  const frame = drawFrameState(abs, frameId)
  setFrame(abs, frameId, {
    shapes: [...frame.shapes, shape],
    past: [...frame.past, frame.shapes],
    future: []
  })
}

export function undoDraw(abs: string, frameId: string): boolean {
  const frame = drawFrameState(abs, frameId)
  if (!frame.past.length) return false
  const previous = frame.past[frame.past.length - 1]
  setFrame(abs, frameId, {
    shapes: previous,
    past: frame.past.slice(0, -1),
    future: [frame.shapes, ...frame.future]
  })
  return true
}

export function redoDraw(abs: string, frameId: string): boolean {
  const frame = drawFrameState(abs, frameId)
  if (!frame.future.length) return false
  const next = frame.future[0]
  setFrame(abs, frameId, {
    shapes: next,
    past: [...frame.past, frame.shapes],
    future: frame.future.slice(1)
  })
  return true
}

export function clearDrawFrame(abs: string, frameId: string): boolean {
  const frame = drawFrameState(abs, frameId)
  if (!frame.shapes.length) return false
  setFrame(abs, frameId, { shapes: [], past: [...frame.past, frame.shapes], future: [] })
  return true
}

export function drawHistory(abs: string, frameId: string): { undo: number; redo: number } {
  const frame = drawFrameState(abs, frameId)
  return { undo: frame.past.length, redo: frame.future.length }
}
