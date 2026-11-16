export interface ModelGridGeometry {
  size: number
  gap: number
  cols: number
  rows: number
  height: number
}

const STEPS: readonly (readonly [number, number])[] = [[7, 2], [5, 2], [4, 1], [3, 1]]
export const MODEL_GRID_MAX_HEIGHT = 260
export const MODEL_GRID_FRAME_MS = 100

export function modelGridGeometry(count: number, width: number, maxHeight = MODEL_GRID_MAX_HEIGHT): ModelGridGeometry {
  const usable = Math.max(1, Math.floor(width))
  let picked: ModelGridGeometry | null = null
  for (const [size, gap] of STEPS) {
    const cols = Math.max(1, Math.floor((usable + gap) / (size + gap)))
    const rows = Math.max(1, Math.ceil(Math.max(1, count) / cols))
    picked = { size, gap, cols, rows, height: rows * (size + gap) - gap }
    if (picked.height <= maxHeight) break
  }
  return picked!
}

export function modelGridCellAt(geometry: ModelGridGeometry, x: number, y: number, count: number): number {
  const step = geometry.size + geometry.gap
  if (x < 0 || y < 0) return -1
  const col = Math.floor(x / step)
  const row = Math.floor(y / step)
  if (col >= geometry.cols || x - col * step > geometry.size + 0.5 * geometry.gap) return -1
  if (y - row * step > geometry.size + 0.5 * geometry.gap) return -1
  const index = row * geometry.cols + col
  return index < count ? index : -1
}

export function modelGridBreath(now: number, index: number): number {
  return 0.55 + 0.45 * Math.abs(Math.sin(now / 420 + index * 0.9))
}
