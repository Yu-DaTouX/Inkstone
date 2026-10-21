export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export const QUICK_ASK_SIZE: Size = { width: 560, height: 160 }
export const AUX_MARGIN = 12

export function clampToArea(bounds: Rect, area: Rect): Rect {
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), maxY)),
    width: Math.round(width),
    height: Math.round(height)
  }
}

export function computeQuickAskBounds(input: {
  anchor?: Rect
  area: Rect
  size?: Size
  verticalRatio?: number
}): Rect {
  const size = input.size ?? QUICK_ASK_SIZE
  const anchor = input.anchor
  const ratio = input.verticalRatio ?? 0.25
  const centerX = anchor ? anchor.x + (anchor.width - size.width) / 2 : input.area.x + (input.area.width - size.width) / 2
  const topY = anchor ? anchor.y + (anchor.height - size.height) * ratio : input.area.y + (input.area.height - size.height) * ratio
  return clampToArea({ x: centerX, y: topY, width: size.width, height: size.height }, input.area)
}
