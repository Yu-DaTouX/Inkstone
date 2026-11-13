import { MousePointerClick } from '../../../ui/icons'
import type { CanvasTool } from './types'

export const interactTool: CanvasTool = {
  id: 'interact',
  icon: MousePointerClick,
  label: (labels) => labels.canvasToolInteract,
  shortcut: 'p',
  frameInput: 'native'
}
