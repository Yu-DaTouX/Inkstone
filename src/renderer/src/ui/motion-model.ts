export const CONDENSE_ENTER_SLACK = 32
export const CONDENSE_EXIT_AT = 4
export const ROW_TRAVEL_MAX = 40
export const LIST_CHURN_MAX = 40
export const HOLD_FRAMES = 2

export interface CondenseInput {
  condensed: boolean
  top: number
  foldHeight: number
  compactHeight: number
  enterSlack?: number
  exitAt?: number
}

export interface CondenseStep {
  condensed: boolean
  scrollTo: number | null
}

export function condenseStep({ condensed, top, foldHeight, compactHeight, enterSlack = CONDENSE_ENTER_SLACK, exitAt = CONDENSE_EXIT_AT }: CondenseInput): CondenseStep {
  if (foldHeight <= 0) return { condensed, scrollTo: null }
  if (condensed) return { condensed: !(top < exitAt), scrollTo: null }
  if (top <= foldHeight + enterSlack) return { condensed: false, scrollTo: null }
  return { condensed: true, scrollTo: Math.max(0, top - (foldHeight - compactHeight)) }
}

export function compensatedScrollTop(top: number, anchorBefore: number, anchorAfter: number): number {
  return Math.max(0, top + (anchorAfter - anchorBefore))
}

export function rowTravel(height: number, cap = ROW_TRAVEL_MAX): number {
  return Math.min(Math.max(0, height), cap)
}

export function remainingShare(offset: number, progress: number): number {
  const done = Math.min(1, Math.max(0, progress))
  return offset * (1 - done)
}

export function flipOffset(previousTop: number, remaining: number, nextTop: number): number {
  return previousTop + remaining - nextTop
}

export interface ListMotionGate {
  animate: boolean
  measured: boolean
  reduced: boolean
  held: boolean
  churn: number
  maxChurn?: number
}

export function listMotionAllowed({ animate, measured, reduced, held, churn, maxChurn = LIST_CHURN_MAX }: ListMotionGate): boolean {
  return animate && measured && !reduced && !held && churn <= maxChurn
}

export function listChurn<K>(previous: ReadonlyMap<K, { height: number }>, next: ReadonlyMap<K, { height: number }>): number {
  let churn = 0
  for (const [key, box] of previous) if (!next.has(key) && box.height > 0) churn++
  for (const [key, box] of next) if (!previous.has(key) && box.height > 0) churn++
  return churn
}

export function ridingDelta<K>(order: readonly K[], index: number, moved: ReadonlyMap<K, number>, retained: (key: K) => number | undefined): number | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const key = order[cursor]
    const delta = moved.get(key)
    if (delta !== undefined) return delta
    const kept = retained(key)
    if (kept !== undefined) return kept
  }
  return undefined
}

export type PresenceState = 'open' | 'closing' | 'closed'

export function presenceNext(state: PresenceState, open: boolean, animate: boolean): PresenceState {
  if (open) return 'open'
  if (state === 'closed') return 'closed'
  if (state === 'closing') return animate ? 'closing' : 'closed'
  return animate ? 'closing' : 'closed'
}

export function parseDuration(value: string | null | undefined, fallback = 0): number {
  const text = (value ?? '').trim()
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(text)
  if (!match) return fallback
  const amount = Number(match[1])
  return Math.max(0, match[2] === 's' ? amount * 1000 : amount)
}

export interface HoldClock {
  frame: (callback: () => void) => number
  cancel: (id: number) => void
}

export interface MotionHold {
  hold: () => void
  held: () => boolean
  subscribe: (listener: (held: boolean) => void) => () => void
}

export function createMotionHold(clock: HoldClock, frames = HOLD_FRAMES): MotionHold {
  let pending: number | null = null
  let active = false
  const listeners = new Set<(held: boolean) => void>()
  const emit = (): void => {
    for (const listener of listeners) listener(active)
  }
  const tick = (left: number): void => {
    pending = clock.frame(() => {
      if (left > 1) {
        tick(left - 1)
        return
      }
      pending = null
      active = false
      emit()
    })
  }
  return {
    hold() {
      if (pending !== null) clock.cancel(pending)
      const was = active
      active = true
      tick(Math.max(1, frames))
      if (!was) emit()
    },
    held: () => active,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export interface InkBox {
  left: number
  width: number
}

export function inkGeometry(tab: InkBox, list: InkBox, scrollLeft: number, inset = 0): { x: number; width: number } {
  const width = Math.max(0, tab.width - inset * 2)
  return { x: tab.left - list.left + scrollLeft + inset, width }
}

export function staggerDelay(index: number, step: number, cap = 6): number {
  return Math.min(Math.max(0, index), cap) * step
}
