export const JUMP_THRESHOLD_PX = 200
const BOTTOM_EPSILON_PX = 40
export const USER_SCROLL_INTENT_MS = 1000

export interface ScrollMetrics {
  offset: number
  size: number
  viewport: number
}

export interface FollowDecision {
  stick: boolean
  showJump: boolean
  repin: boolean
}

export interface ReadingAnchor {
  turnId: string
  offset: number
}

interface AnchorRow {
  id: string
  top: number
  bottom: number
}

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.size - metrics.offset - metrics.viewport)
}

export function userScrollActive(intentAt: number | null, now: number): boolean {
  return intentAt !== null && now - intentAt >= 0 && now - intentAt <= USER_SCROLL_INTENT_MS
}

export function isLayoutShift(previous: ScrollMetrics | null | undefined, metrics: ScrollMetrics): boolean {
  if (!previous) return true
  if (Math.abs(previous.size - metrics.size) > 1 || Math.abs(previous.viewport - metrics.viewport) > 1) return true
  return metrics.offset >= previous.offset
}

export function decideFollow(wasStuck: boolean, metrics: ScrollMetrics, intentAt: number | null, now: number, previous?: ScrollMetrics | null): FollowDecision {
  const distance = distanceFromBottom(metrics)
  if (distance < BOTTOM_EPSILON_PX) return { stick: true, showJump: false, repin: false }
  if (wasStuck && !userScrollActive(intentAt, now) && isLayoutShift(previous, metrics)) return { stick: true, showJump: false, repin: true }
  return { stick: false, showJump: distance > JUMP_THRESHOLD_PX, repin: false }
}

export function isScrollIntentKey(key: string): boolean {
  return NAVIGATION_KEYS.has(key)
}

export function pickReadingAnchor(rows: ReadonlyArray<AnchorRow>, viewTop: number): ReadingAnchor | null {
  for (const row of rows) {
    if (row.bottom > viewTop) return { turnId: row.id, offset: Math.max(0, viewTop - row.top) }
  }
  return null
}
