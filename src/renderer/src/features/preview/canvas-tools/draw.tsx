import { PenLine } from 'lucide-react'
import { DrawOverlay } from './draw-overlay'
import { DrawPanel } from './draw-panel'
import { drawText } from './draw-text'
import type { CanvasTool } from './types'

export const drawTool: CanvasTool = {
  id: 'draw',
  icon: PenLine,
  label: (labels) => drawText(labels.lang).title,
  shortcut: 'd',
  frameInput: 'none',
  Overlay: DrawOverlay,
  Panel: DrawPanel
}
