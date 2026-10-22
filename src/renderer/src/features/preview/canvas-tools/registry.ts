import { commentTool } from './comment'
import { drawTool } from './draw'
import { editTool } from './edit'
import { handTool } from './hand'
import { inspectTool } from './inspect'
import { interactTool } from './interact'
import { timelineTool } from './timeline'
import type { CanvasTool, CanvasToolContext, CanvasToolId } from './types'

export const CANVAS_TOOLS: readonly CanvasTool[] = [
  handTool,
  interactTool,
  inspectTool,
  commentTool,
  drawTool,
  editTool,
  timelineTool
]

export const DEFAULT_CANVAS_TOOL: CanvasToolId = 'hand'

export function canvasTool(id: CanvasToolId): CanvasTool {
  return CANVAS_TOOLS.find((tool) => tool.id === id) ?? handTool
}

export function availableCanvasTools(context: CanvasToolContext): CanvasTool[] {
  return CANVAS_TOOLS.filter((tool) => !tool.available || tool.available(context))
}
