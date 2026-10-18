export const DECK_WHEEL = {
  threshold: 70,
  lock: 260,
  gap: 140,
  hold: 350,
  touch: 44,
  line: 16
} as const

export const DECK_SLOT_MIN = -2
export const DECK_SLOT_MAX = 4
export const DECK_ROWS_MAX = 3
export const DECK_EDGES_MAX = 2
export const DECK_DOTS_MAX = 12

export type DeckWheelState = { acc: number; lastWheel: number; lockUntil: number }

export function createDeckWheelState(): DeckWheelState {
  return { acc: 0, lastWheel: 0, lockUntil: 0 }
}

export function deckWheelDelta(event: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number): number {
  const dy = event.deltaMode === 1 ? event.deltaY * DECK_WHEEL.line : event.deltaMode === 2 ? event.deltaY * pageHeight : event.deltaY
  if (dy === 0 || Math.abs(dy) < Math.abs(event.deltaX)) return 0
  return dy
}

export function deckCanMove(index: number, count: number, dir: number): boolean {
  return dir < 0 ? index > 0 : index < count - 1
}

export function deckWheelStep(
  state: DeckWheelState,
  dy: number,
  now: number,
  index: number,
  count: number
): { prevent: boolean; target: number | null } {
  if (dy === 0) return { prevent: false, target: null }
  const dir = dy > 0 ? 1 : -1
  if (!deckCanMove(index, count, dir)) {
    state.acc = 0
    if (now < state.lockUntil + DECK_WHEEL.hold) {
      state.lastWheel = now
      return { prevent: true, target: null }
    }
    return { prevent: false, target: null }
  }
  if (now - state.lastWheel > DECK_WHEEL.gap) state.acc = 0
  state.lastWheel = now
  if (now < state.lockUntil) return { prevent: true, target: null }
  if (state.acc && Math.sign(state.acc) !== dir) state.acc = 0
  state.acc += dy
  if (Math.abs(state.acc) < DECK_WHEEL.threshold) return { prevent: true, target: null }
  state.acc = 0
  state.lockUntil = now + DECK_WHEEL.lock
  return { prevent: true, target: index + dir }
}

export function deckKeyTarget(key: string, index: number, count: number): number | null {
  const dir = key === 'ArrowDown' || key === 'PageDown' ? 1 : key === 'ArrowUp' || key === 'PageUp' ? -1 : 0
  if (dir !== 0) return deckCanMove(index, count, dir) ? index + dir : null
  if (key === 'Home') return deckCanMove(index, count, -1) ? 0 : null
  if (key === 'End') return deckCanMove(index, count, 1) ? count - 1 : null
  return null
}

export function deckTouchStep(
  startY: number,
  y: number,
  index: number,
  count: number
): { prevent: boolean; target: number | null; startY: number } {
  const dy = startY - y
  if (dy === 0) return { prevent: false, target: null, startY }
  const dir = dy > 0 ? 1 : -1
  if (!deckCanMove(index, count, dir)) return { prevent: false, target: null, startY }
  if (Math.abs(dy) < DECK_WHEEL.touch) return { prevent: true, target: null, startY }
  return { prevent: true, target: index + dir, startY: y }
}

export function deckSlot(itemIndex: number, current: number): number {
  return itemIndex - current
}

export function deckVisible(slot: number): boolean {
  return slot >= DECK_SLOT_MIN && slot <= DECK_SLOT_MAX
}

export function deckStripDepth(slot: number): number {
  if (slot < 0) return 2
  return Math.min(Math.max(slot, 1), 4)
}
