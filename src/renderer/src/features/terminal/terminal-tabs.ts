export const MAX_TERMINAL_TABS = 12

export interface TerminalTabLabel {
  kind: 'title' | 'numbered' | 'single'
  text: string
  number: number
}

export function canAddTerminalTab(count: number): boolean {
  return count < MAX_TERMINAL_TABS
}

export function terminalTabLabel(title: string, index: number, count: number): TerminalTabLabel {
  const trimmed = title.trim()
  if (trimmed) return { kind: 'title', text: trimmed, number: index + 1 }
  if (count > 1) return { kind: 'numbered', text: '', number: index + 1 }
  return { kind: 'single', text: '', number: 1 }
}

export function nextTerminalTabIndex(index: number, count: number, key: string): number | null {
  if (count <= 0 || index < 0) return null
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function pickActiveAfterClose(keys: readonly string[], removed: string, active: string | null): string | null {
  if (!keys.includes(removed)) return active
  const rest = keys.filter((key) => key !== removed)
  if (rest.length === 0) return null
  if (active !== removed && active && rest.includes(active)) return active
  const index = keys.indexOf(removed)
  const next = rest[Math.min(index, rest.length - 1)]
  return next ?? null
}

export function othersThan<T extends { key: string }>(tabs: readonly T[], keep: string): T[] {
  return tabs.filter((tab) => tab.key !== keep)
}

export function isTerminalTabCloseKey(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): boolean {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return false
  return !event.ctrlKey && !event.metaKey && !event.altKey
}
