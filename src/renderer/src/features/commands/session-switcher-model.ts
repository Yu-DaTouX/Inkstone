import type { SessionSummary } from '../../../../shared/ipc'
import { compareRecency } from '../../state/project-session'

export const SWITCHER_LIMIT = 9

export type SwitcherSession = Pick<SessionSummary, 'id' | 'path' | 'title' | 'cwd' | 'archivedAt' | 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'>

export function switcherSessions<T extends SwitcherSession>(
  sessions: readonly T[],
  currentPath: string | null | undefined,
  limit = SWITCHER_LIMIT
): T[] {
  const live = sessions.filter((session) => !session.archivedAt || !!session.lastOpenedAt || (!!currentPath && session.path === currentPath))
  const current = currentPath ? live.find((session) => session.path === currentPath) : undefined
  const rest = live.filter((session) => session !== current).sort(compareRecency)
  return (current ? [current, ...rest] : rest).slice(0, Math.max(0, limit))
}

export function stepSwitcherIndex(index: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0
  return (index + direction + count) % count
}

export function initialSwitcherIndex(count: number, direction: 1 | -1, hasCurrent: boolean): number {
  if (count <= 0) return 0
  if (!hasCurrent) return direction === 1 ? 0 : count - 1
  return stepSwitcherIndex(0, count, direction)
}

export function heldModifiersReleased(
  keys: readonly string[],
  state: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
): boolean {
  const modifiers = keys.slice(0, -1).map((key) => key.toLowerCase())
  const primary = modifiers.find((key) => key !== 'shift')
  if (!primary) return true
  if (primary === 'alt') return !state.altKey
  return !state.ctrlKey && !state.metaKey
}
