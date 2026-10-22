import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { CanvasComposition, CanvasElementInfoPayload, CanvasElementRect, CanvasResolveTarget } from '../../../../../shared/html-canvas-bridge'
import type { CanvasFrameBox, CanvasView } from '../html-canvas-model'
import type { PreviewText } from '../preview-text'

export type CanvasToolId = 'hand' | 'interact' | 'inspect' | 'comment' | 'draw' | 'edit' | 'timeline'

export type CanvasFrameInput = 'bridge' | 'native' | 'none'

export interface CanvasElementInfo extends CanvasElementInfoPayload {
  frameId: string
}

export type CanvasFrameMessage = Record<string, unknown>

export type CanvasResolveOutcome =
  | { state: 'found'; rect: CanvasElementRect }
  | { state: 'missing' }
  | { state: 'unknown' }

export interface CanvasToolContext {
  abs: string
  cwd: string
  name: string
  labels: PreviewText
  generating: boolean
  frames: readonly CanvasFrameBox[]
  view: CanvasView
  hover: CanvasElementInfo | null
  selection: CanvasElementInfo | null
  refreshTick: number
  composition: CanvasComposition | null
  currentTime: number | null
  playing: boolean
  narrow: boolean
  dockCollapsed: boolean
  dockInset: number
  toggleDock: () => void
  select: (info: CanvasElementInfo | null) => void
  postToFrame: (frameId: string, message: CanvasFrameMessage) => void
  reloadFrames: () => void
  frameElement: (frameId: string) => HTMLIFrameElement | null
  frameHash: (frameId: string) => string
  resolveElement: (frameId: string, target: CanvasResolveTarget, timeoutMs?: number) => Promise<CanvasResolveOutcome>
  seekComposition: (t: number) => void
  playComposition: () => void
  pauseComposition: () => void
  focusRect: (frameId: string, rect: { x: number; y: number; w: number; h: number }, padding?: number) => Promise<void>
}

export interface CanvasToolOverlayProps {
  frame: CanvasFrameBox
  view: CanvasView
  context: CanvasToolContext
}

export interface CanvasToolPanelProps {
  context: CanvasToolContext
}

export interface CanvasTool {
  id: CanvasToolId
  icon: LucideIcon
  label: (labels: PreviewText) => string
  shortcut: string
  frameInput: CanvasFrameInput
  available?: (context: CanvasToolContext) => boolean
  Overlay?: ComponentType<CanvasToolOverlayProps>
  Panel?: ComponentType<CanvasToolPanelProps>
}
