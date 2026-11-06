import type { FoldLayout } from './foldLayout'

export type LayoutMode = 'single' | 'split' | 'book' | 'tabletop' | 'triple'

export interface Frame { x: number; y: number; width: number; height: number }

export interface WindowLayout {
  mode: LayoutMode
  side: number
  gap: number
  aside: number
  top: number
  topGap: number
}

const SPLIT_MIN = 600
const TRIPLE_MIN = 840
const SIDE_RATIO = 0.35
const SIDE_MIN = 240
const SIDE_MAX = 420
const ASIDE = 320
const MAIN_MIN = 400
const HALF_MIN = 280
const HINGE_MIN = 12

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function hinge(start: number, end: number, origin: number, size: number): { at: number; gap: number } | null {
  const pad = Math.max(0, HINGE_MIN - (end - start))
  const at = Math.round(start - origin - pad / 2)
  const gap = Math.round(end - start + pad)
  return at > 0 && at + gap < size ? { at, gap } : null
}

export function computeLayout(frame: Frame, fold: FoldLayout): WindowLayout {
  const base: WindowLayout = { mode: 'single', side: 0, gap: 0, aside: 0, top: 0, topGap: 0 }
  if (frame.width <= 0 || frame.height <= 0) return base
  const vertical = fold.orientation === 'vertical' && fold.left !== undefined && fold.right !== undefined
  const horizontal = fold.orientation === 'horizontal' && fold.top !== undefined && fold.bottom !== undefined

  if (fold.separating && horizontal) {
    const cut = hinge(fold.top!, fold.bottom!, frame.y, frame.height)
    if (cut && cut.at >= 140 && frame.height - cut.at - cut.gap >= 200) return { ...base, mode: 'tabletop', top: cut.at, topGap: cut.gap }
  }

  if (fold.separating && vertical) {
    const cut = hinge(fold.left!, fold.right!, frame.x, frame.width)
    if (cut && cut.at >= HALF_MIN && frame.width - cut.at - cut.gap >= HALF_MIN) return { ...base, mode: 'book', side: cut.at, gap: cut.gap }
  }

  if (frame.width < SPLIT_MIN) return base

  const side = clamp(Math.round(frame.width * SIDE_RATIO), SIDE_MIN, SIDE_MAX)
  if (frame.width >= TRIPLE_MIN && frame.width - side - ASIDE >= MAIN_MIN) return { ...base, mode: 'triple', side, aside: ASIDE }
  return { ...base, mode: 'split', side }
}
