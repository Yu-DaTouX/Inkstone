import { useUiV3 } from '../../state/ui-v3'
import { toolSurface, useRightPanel, type PanelToolKind, type RightPanelSurface } from '../../state/right-panel'
import type { WorkbenchTabId } from './types'

export function openPanelSurface(surface: RightPanelSurface): void {
  useUiV3.getState().navigate({ name: 'chat' })
  useRightPanel.getState().open(surface)
}

export function openPanelTool(kind: WorkbenchTabId | PanelToolKind): void {
  openPanelSurface(toolSurface(kind))
}
