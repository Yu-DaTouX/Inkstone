import { clampToArea, type Rect, type Size } from './geometry'

export const PANE_POPOUT_SIZE: Size = { width: 460, height: 620 }
export const PANE_POPOUT_MARGIN = 12
export const PANE_POPOUT_STAGGER = 28

export function computePanePopoutBounds(input: {
  anchor?: Rect
  area: Rect
  size?: Size
  margin?: number
  index?: number
}): Rect {
  const size = input.size ?? PANE_POPOUT_SIZE
  const margin = input.margin ?? PANE_POPOUT_MARGIN
  const anchor = input.anchor
  const area = input.area
  if (!anchor) {
    return clampToArea({ x: area.x + margin, y: area.y + margin, width: size.width, height: size.height }, area)
  }
  const rightX = anchor.x + anchor.width + margin
  const leftX = anchor.x - size.width - margin
  const fitsRight = rightX + size.width <= area.x + area.width
  const x = fitsRight ? rightX : leftX
  const y = anchor.y + (input.index ?? 0) * PANE_POPOUT_STAGGER
  return clampToArea({ x, y, width: size.width, height: size.height }, area)
}
