import type { ITerminalOptions } from '@xterm/xterm'

export type TerminalCursorStyle = 'block' | 'bar' | 'underline'

export interface TerminalViewSettings {
  fontSize: number
  lineHeight: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  scrollback: number
}

export const TERMINAL_FONT_SIZES: readonly number[] = [11, 12, 13, 14, 16]
export const TERMINAL_LINE_HEIGHTS: readonly number[] = [1, 1.15, 1.3]
export const TERMINAL_CURSOR_STYLES: readonly TerminalCursorStyle[] = ['block', 'bar', 'underline']
export const TERMINAL_SCROLLBACKS: readonly number[] = [1000, 5000, 10000]
export const TERMINAL_MINIMUM_CONTRAST_RATIO = 3
export const TERMINAL_VIEW_STORAGE_KEY = 'inkstone.terminal.view.v1'

export const DEFAULT_TERMINAL_VIEW: TerminalViewSettings = Object.freeze({
  fontSize: 12,
  lineHeight: 1,
  cursorStyle: 'block' as TerminalCursorStyle,
  cursorBlink: true,
  scrollback: 10000
})

function pickNumber(options: readonly number[], value: unknown, fallback: number): number {
  const match = options.find((option) => option === value)
  return match ?? fallback
}

export function normalizeTerminalView(raw: unknown): TerminalViewSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const cursor = TERMINAL_CURSOR_STYLES.find((style) => style === value.cursorStyle)
  return {
    fontSize: pickNumber(TERMINAL_FONT_SIZES, value.fontSize, DEFAULT_TERMINAL_VIEW.fontSize),
    lineHeight: pickNumber(TERMINAL_LINE_HEIGHTS, value.lineHeight, DEFAULT_TERMINAL_VIEW.lineHeight),
    cursorStyle: cursor ?? DEFAULT_TERMINAL_VIEW.cursorStyle,
    cursorBlink: value.cursorBlink !== false,
    scrollback: pickNumber(TERMINAL_SCROLLBACKS, value.scrollback, DEFAULT_TERMINAL_VIEW.scrollback)
  }
}

export function terminalXtermOptions(view: TerminalViewSettings): ITerminalOptions {
  return {
    fontSize: view.fontSize,
    lineHeight: view.lineHeight,
    cursorStyle: view.cursorStyle,
    cursorBlink: view.cursorBlink,
    scrollback: view.scrollback,
    minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO
  }
}

export interface TerminalViewStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface TerminalViewStore {
  get(): TerminalViewSettings
  subscribe(listener: () => void): () => void
  update(patch: Partial<TerminalViewSettings>): void
  dispose(): void
}

export function createTerminalViewStore(
  storage: TerminalViewStorage | null,
  subscribeStorage: (listener: () => void) => () => void = () => () => {}
): TerminalViewStore {
  const read = (): TerminalViewSettings => {
    try {
      return normalizeTerminalView(JSON.parse(storage?.getItem(TERMINAL_VIEW_STORAGE_KEY) ?? 'null'))
    } catch {
      return { ...DEFAULT_TERMINAL_VIEW }
    }
  }
  let current = read()
  const listeners = new Set<() => void>()
  const publish = (next: TerminalViewSettings): void => {
    if (
      next.fontSize === current.fontSize &&
      next.lineHeight === current.lineHeight &&
      next.cursorStyle === current.cursorStyle &&
      next.cursorBlink === current.cursorBlink &&
      next.scrollback === current.scrollback
    ) {
      return
    }
    current = next
    for (const listener of [...listeners]) listener()
  }
  const off = subscribeStorage(() => publish(read()))
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(patch) {
      const next = normalizeTerminalView({ ...current, ...patch })
      try {
        storage?.setItem(TERMINAL_VIEW_STORAGE_KEY, JSON.stringify(next))
      } catch {
      }
      publish(next)
    },
    dispose() {
      off()
      listeners.clear()
    }
  }
}

let shared: TerminalViewStore | null = null

export function terminalViewStore(): TerminalViewStore {
  if (shared) return shared
  let storage: TerminalViewStorage | null = null
  try {
    storage = window.localStorage
  } catch {
    storage = null
  }
  shared = createTerminalViewStore(storage, (listener) => {
    if (typeof window === 'undefined') return () => {}
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== TERMINAL_VIEW_STORAGE_KEY) return
      listener()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  })
  return shared
}
