export const LONG_TAIL_CHARS = 4000
export const LONG_TAIL_THROTTLE_MS = 120

export interface TailHold {
  offset: number
  text: string
  at: number
}

export interface TailThrottle {
  text: string
  hold: TailHold
  wait: number
}

export function throttleTail(hold: TailHold | null, block: { offset: number; text: string }, now: number, minMs = LONG_TAIL_THROTTLE_MS, longChars = LONG_TAIL_CHARS): TailThrottle {
  const fresh = (): TailThrottle => ({ text: block.text, hold: { offset: block.offset, text: block.text, at: now }, wait: 0 })
  if (block.text.length <= longChars || !hold || hold.offset !== block.offset) return fresh()
  if (block.text === hold.text) return { text: hold.text, hold, wait: 0 }
  if (!block.text.startsWith(hold.text)) return fresh()
  const elapsed = now - hold.at
  if (elapsed >= minMs) return fresh()
  return { text: hold.text, hold, wait: minMs - elapsed }
}
