export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface NativeBounds {
  x: number
  y: number
  width: number
  height: number
}

export const BOUNDS_QUANTUM = 0.5

function quantize(value: number): number {
  return Math.max(0, Math.round(value / BOUNDS_QUANTUM) * BOUNDS_QUANTUM)
}

export function clipToRect(rect: RectLike, clip: RectLike | null): { left: number; top: number; right: number; bottom: number } {
  return {
    left: clip ? Math.max(rect.left, clip.left) : rect.left,
    top: clip ? Math.max(rect.top, clip.top) : rect.top,
    right: clip ? Math.min(rect.right, clip.right) : rect.right,
    bottom: clip ? Math.min(rect.bottom, clip.bottom) : rect.bottom
  }
}

export function nativeBoundsFor(rect: RectLike, clip: RectLike | null = null): NativeBounds {
  const box = clipToRect(rect, clip)
  const width = Math.max(0, box.right - box.left)
  const height = Math.max(0, box.bottom - box.top)
  return {
    x: quantize(box.left),
    y: quantize(box.top),
    width: quantize(width),
    height: quantize(height)
  }
}

export function boundsSignature(bounds: NativeBounds): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
}

export function boundsArea(bounds: NativeBounds): number {
  return bounds.width * bounds.height
}

export interface BoundsBridge {
  setBounds(bounds: NativeBounds): void | Promise<void>
}

export class BrowserBoundsSync {
  private last = ''

  constructor(private readonly bridge: BoundsBridge) {}

  sync(rect: RectLike | null, clip: RectLike | null = null): NativeBounds | null {
    if (!rect) return null
    const bounds = nativeBoundsFor(rect, clip)
    const signature = boundsSignature(bounds)
    if (signature === this.last) return bounds
    this.last = signature
    void this.bridge.setBounds(bounds)
    return bounds
  }

  reset(): void {
    this.last = ''
  }
}
