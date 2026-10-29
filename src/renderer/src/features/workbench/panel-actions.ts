import { useUiV3 } from '../../state/ui-v3'
import { currentPanelEntry, toolSurface, useRightPanel, type PanelToolKind, type RightPanelSurface } from '../../state/right-panel'
import type { WorkbenchTabId } from './types'

export function openPanelSurface(surface: RightPanelSurface): void {
  useUiV3.getState().navigate({ name: 'chat' })
  useRightPanel.getState().open(surface)
}

export function openPanelTool(kind: WorkbenchTabId | PanelToolKind): void {
  openPanelSurface(toolSurface(kind))
}

export function closePanelTool(kind: WorkbenchTabId | PanelToolKind): void {
  useRightPanel.getState().close(toolSurface(kind).id)
}

export function isPanelSurfaceShown(id: string): boolean {
  const entry = currentPanelEntry()
  return entry.open && entry.surfaces.some((item) => item.id === id)
}

export function setPanelOpen(open: boolean): void {
  useRightPanel.getState().setOpen(open)
}
