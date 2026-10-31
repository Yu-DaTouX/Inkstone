import type { ShortcutId } from '../../app/shortcuts'
import { runSplitCommand, type SplitCommand } from './split-actions'

const SPLIT_SHORTCUTS: Partial<Record<ShortcutId, SplitCommand>> = {
  splitFocusNext: 'focus-next',
  splitFocusPrevious: 'focus-previous',
  splitNewRight: 'new-right',
  splitNewBelow: 'new-below',
  splitClose: 'close',
  splitFocusLeft: 'focus-left',
  splitFocusRight: 'focus-right',
  splitFocusUp: 'focus-up',
  splitFocusDown: 'focus-down'
}

const EDITOR_SURFACES = '.cm-editor, .monaco-editor, .xterm'

export function splitCommandFor(shortcut: ShortcutId): SplitCommand | null {
  return SPLIT_SHORTCUTS[shortcut] ?? null
}

export function runSplitShortcut(shortcut: ShortcutId, target: EventTarget | null): boolean | null {
  const command = splitCommandFor(shortcut)
  if (!command) return null
  if (target instanceof Element && target.closest(EDITOR_SURFACES)) return false
  return runSplitCommand(command)
}
