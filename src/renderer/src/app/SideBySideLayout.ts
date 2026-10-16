import type { SplitLayout, SplitSessionRef } from '../state/split-view'

export const SUBAGENT_TILE_PREFIX = 'subagent:'

export function subagentTileRef(runId: string): SplitSessionRef {
  return { sessionId: `${SUBAGENT_TILE_PREFIX}${runId}` }
}

export function subagentRunIdOf(ref: SplitSessionRef | null | undefined): string | null {
  const id = ref?.sessionId
  return id && id.startsWith(SUBAGENT_TILE_PREFIX) ? id.slice(SUBAGENT_TILE_PREFIX.length) : null
}

export function isSessionTile(ref: SplitSessionRef | null | undefined): boolean {
  if (!ref || subagentRunIdOf(ref)) return false
  return !!(ref.sessionId || ref.path)
}

export function sessionTiles(refs: readonly SplitSessionRef[]): SplitSessionRef[] {
  return refs.filter(isSessionTile)
}

export interface PaneLayout {
  tiles: SplitSessionRef[]
  live: number
}

export function collapsedPanes(split: SplitLayout | null, narrow: boolean): PaneLayout | null {
  if (!split || split.tiles.length < 2) return null
  if (narrow) return { tiles: [split.tiles[split.live]], live: 0 }
  return { tiles: split.tiles, live: split.live }
}

export interface SideBySideSession {
  id: string
  path: string
  archivedAt?: number
  lastActivityAt?: number
  updatedAt?: number
}

const normalizePath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b)

const sameRefAsSession = (ref: SplitSessionRef, session: SideBySideSession): boolean =>
  (!!ref.sessionId && ref.sessionId === session.id) || (!!ref.path && samePath(ref.path, session.path))

export function sideBySideCandidate(
  sessions: readonly SideBySideSession[],
  current: SplitSessionRef | null,
  taken: readonly SplitSessionRef[] = []
): SideBySideSession | null {
  const candidates = sessions.filter((session) => {
    if (session.archivedAt) return false
    if (current && sameRefAsSession(current, session)) return false
    return !taken.some((ref) => sameRefAsSession(ref, session))
  })
  candidates.sort(
    (a, b) => (b.lastActivityAt ?? b.updatedAt ?? 0) - (a.lastActivityAt ?? a.updatedAt ?? 0)
  )
  return candidates[0] ?? null
}
