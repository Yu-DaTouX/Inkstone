export const MAX_TERMINAL_TABS = 12

export interface TerminalTabNameInput {
  command?: string
  cwd?: string
  title?: string
}

const TAB_COMMAND_CHARS = 32

export function canAddTerminalTab(count: number): boolean {
  return count < MAX_TERMINAL_TABS
}

function commandName(command: string): string {
  const line = command.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return line.length > TAB_COMMAND_CHARS ? `${line.slice(0, TAB_COMMAND_CHARS - 1)}…` : line
}

function cwdName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? ''
}

export function terminalTabName(input: TerminalTabNameInput): string {
  return commandName(input.command ?? '') || cwdName(input.cwd ?? '') || (input.title ?? '').trim()
}

export function terminalTabNames(inputs: readonly TerminalTabNameInput[], fallback: (n: number) => string, single: string): string[] {
  const names = inputs.map((input, index) => terminalTabName(input) || (inputs.length > 1 ? fallback(index + 1) : single))
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count > 1 ? `${name} ${count}` : name
  })
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
