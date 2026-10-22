export interface CanvasRegionRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasRegionSize {
  width: number
  height: number
}

export function rectNormalize(rect: CanvasRegionRect): CanvasRegionRect {
  return {
    x: rect.w < 0 ? rect.x + rect.w : rect.x,
    y: rect.h < 0 ? rect.y + rect.h : rect.y,
    w: Math.abs(rect.w),
    h: Math.abs(rect.h)
  }
}

export function rectExpand(rect: CanvasRegionRect, by: number): CanvasRegionRect {
  const margin = Number.isFinite(by) ? Math.max(0, by) : 0
  return { x: rect.x - margin, y: rect.y - margin, w: rect.w + margin * 2, h: rect.h + margin * 2 }
}

export function rectClamp(rect: CanvasRegionRect, bounds: CanvasRegionRect): CanvasRegionRect {
  const normal = rectNormalize(rect)
  const left = Math.max(bounds.x, Math.min(normal.x, bounds.x + bounds.w))
  const top = Math.max(bounds.y, Math.min(normal.y, bounds.y + bounds.h))
  const right = Math.max(left, Math.min(normal.x + normal.w, bounds.x + bounds.w))
  const bottom = Math.max(top, Math.min(normal.y + normal.h, bounds.y + bounds.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export function rectIntersect(a: CanvasRegionRect, b: CanvasRegionRect): CanvasRegionRect | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (!(right > left) || !(bottom > top)) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export function visibleBoxRegion(frame: CanvasRegionSize, box: CanvasRegionRect, stage: CanvasRegionRect): CanvasRegionRect {
  const scale = box.w > 0 && frame.width > 0 ? frame.width / box.w : 1
  const left = Math.max(box.x, stage.x)
  const top = Math.max(box.y, stage.y)
  const right = Math.min(box.x + box.w, stage.x + stage.w)
  const bottom = Math.min(box.y + box.h, stage.y + stage.h)
  if (!(right > left) || !(bottom > top)) {
    return { x: 0, y: 0, w: Math.min(120, frame.width), h: Math.min(120, frame.height) }
  }
  return rectClamp(
    {
      x: (left - box.x) * scale,
      y: (top - box.y) * scale,
      w: (right - left) * scale,
      h: (bottom - top) * scale
    },
    { x: 0, y: 0, w: frame.width, h: frame.height }
  )
}

export function elementVisibleRegion(
  frame: CanvasRegionSize,
  box: CanvasRegionRect,
  stage: CanvasRegionRect,
  region: CanvasRegionRect
): CanvasRegionRect | null {
  if (!(box.w > 0) || !(box.h > 0) || !(frame.width > 0) || !(frame.height > 0)) return null
  const visible = rectIntersect(box, stage)
  if (!visible) return null
  const scaleX = frame.width / box.w
  const scaleY = frame.height / box.h
  const inside = {
    x: (visible.x - box.x) * scaleX,
    y: (visible.y - box.y) * scaleY,
    w: visible.w * scaleX,
    h: visible.h * scaleY
  }
  const clipped = rectIntersect(rectClamp(region, { x: 0, y: 0, w: frame.width, h: frame.height }), inside)
  if (!clipped || !(clipped.w >= 1) || !(clipped.h >= 1)) return null
  return clipped
}
