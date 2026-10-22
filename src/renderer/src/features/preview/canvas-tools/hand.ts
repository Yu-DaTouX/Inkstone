import { Hand } from 'lucide-react'
import type { CanvasTool } from './types'

export const handTool: CanvasTool = {
  id: 'hand',
  icon: Hand,
  label: (labels) => labels.canvasToolHand,
  shortcut: 'h',
  frameInput: 'none'
}
