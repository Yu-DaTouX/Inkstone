export type ThinkingDisplay = 'summarized' | 'updates'

const KEY = Symbol.for('yan.thinkingDisplay')

type Holder = { [KEY]?: ThinkingDisplay }

export function setThinkingDisplayMode(value: unknown): void {
  ;(globalThis as Holder)[KEY] = value === 'updates' ? 'updates' : 'summarized'
}

export function thinkingDisplayMode(): ThinkingDisplay {
  return (globalThis as Holder)[KEY] ?? 'summarized'
}
