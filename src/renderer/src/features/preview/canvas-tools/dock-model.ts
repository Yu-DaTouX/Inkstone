export const DOCK_GAP = 12
export const DOCK_EDGE = 8
export const DOCK_PANEL_SHARE = 0.5
export const DOCK_POPOVER_GAP = 10
export const DOCK_POPOVER_MIN_HEIGHT = 96

export interface DockMeasure {
  top: number
  height: number
}

export interface DockBox {
  left: number
  top: number
  width: number
  height: number
}

export interface DockPopoverInput {
  anchor: DockBox
  size: { width: number; height: number }
  viewport: { width: number; height: number }
  bottomInset?: number
  margin?: number
  gap?: number
  minHeight?: number
}

export interface DockPopoverPlacement {
  left: number
  top: number
  width: number
  maxHeight: number
  side: 'below' | 'above'
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function dockPanelLimit(stageHeight: number): number {
  if (!Number.isFinite(stageHeight) || stageHeight <= 0) return 0
  return Math.round(stageHeight * DOCK_PANEL_SHARE)
}

export function dockReserveHeight(stageHeight: number, measure: DockMeasure, gap: number = DOCK_GAP): number {
  if (!Number.isFinite(stageHeight) || stageHeight <= 0) return 0
  const height = finite(measure.height, 0)
  if (height <= 0) return 0
  const top = Number.isFinite(measure.top) ? measure.top : stageHeight - height
  const bottom = Math.max(0, stageHeight - top - height)
  const panel = Math.min(height, dockPanelLimit(stageHeight))
  return Math.max(0, Math.round(bottom + panel + Math.max(0, finite(gap, 0))))
}

export function dockBottomInset(stageHeight: number, measure: DockMeasure): number {
  if (!Number.isFinite(stageHeight) || stageHeight <= 0) return 0
  const height = finite(measure.height, 0)
  if (height <= 0) return 0
  const top = Number.isFinite(measure.top) ? measure.top : stageHeight - height
  return Math.max(0, Math.round(stageHeight - top))
}

export function dockPopover(input: DockPopoverInput): DockPopoverPlacement {
  const margin = Math.max(0, finite(input.margin ?? DOCK_EDGE, DOCK_EDGE))
  const gap = Math.max(0, finite(input.gap ?? DOCK_POPOVER_GAP, DOCK_POPOVER_GAP))
  const minHeight = Math.max(0, finite(input.minHeight ?? DOCK_POPOVER_MIN_HEIGHT, DOCK_POPOVER_MIN_HEIGHT))
  const viewportWidth = finite(input.viewport.width, 0)
  const viewportHeight = finite(input.viewport.height, 0)
  const wantedWidth = Math.max(0, finite(input.size.width, 0))
  const wantedHeight = Math.max(0, finite(input.size.height, 0))
  const belowTop = finite(input.anchor.top, 0) + Math.max(0, finite(input.anchor.height, 0)) + gap
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return {
      left: Math.max(margin, Math.round(finite(input.anchor.left, 0))),
      top: Math.round(Math.max(margin, belowTop)),
      width: Math.round(wantedWidth),
      maxHeight: Math.round(wantedHeight),
      side: 'below'
    }
  }
  const width = Math.min(wantedWidth, Math.max(0, viewportWidth - margin * 2))
  const bottomInset = Math.max(0, Math.min(viewportHeight - margin, finite(input.bottomInset ?? 0, 0)))
  const bottomLimit = Math.max(margin, viewportHeight - margin - bottomInset)
  const aboveTop = finite(input.anchor.top, 0) - gap - wantedHeight
  const roomBelow = bottomLimit - belowTop
  const roomAbove = finite(input.anchor.top, 0) - gap - margin
  const fitsBelow = roomBelow >= wantedHeight
  const fitsAbove = roomAbove >= wantedHeight
  const side: 'below' | 'above' = fitsBelow || (!fitsAbove && roomBelow >= roomAbove) ? 'below' : 'above'
  const preferred = side === 'below' ? belowTop : aboveTop
  const top = Math.round(clampValue(preferred, margin, bottomLimit - Math.min(wantedHeight, bottomLimit - margin)))
  const anchorLeft = finite(input.anchor.left, 0) + (finite(input.anchor.width, 0) - width) / 2
  const left = Math.round(clampValue(anchorLeft, margin, viewportWidth - width - margin))
  const room = Math.max(0, bottomLimit - top)
  const maxHeight = Math.round(Math.max(Math.min(wantedHeight, room), Math.min(minHeight, room)))
  return { left, top, width: Math.round(width), maxHeight, side }
}
