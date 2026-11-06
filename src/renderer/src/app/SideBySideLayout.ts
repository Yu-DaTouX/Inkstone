import { splitColumns, type SplitLayout, type SplitSessionRef } from '../state/split-view'

export function isSessionTile(ref: SplitSessionRef | null | undefined): boolean {
  if (!ref) return false
  return !!(ref.sessionId || ref.path)
}

export function sessionTiles(refs: readonly SplitSessionRef[]): SplitSessionRef[] {
  return refs.filter(isSessionTile)
}

export interface PaneLayout {
  tiles: SplitSessionRef[]
  live: number
}

export function collapsedPanes(split: SplitLayout | null, narrow: boolean, maxColumns = Number.POSITIVE_INFINITY): PaneLayout | null {
  if (!split || split.tiles.length < 2) return null
  if (narrow || maxColumns <= 1) return { tiles: [split.tiles[split.live]], live: 0 }
  const columns = splitColumns(split.tiles)
  if (columns.length <= maxColumns) return { tiles: split.tiles, live: split.live }
  const liveColumn = Math.max(0, columns.findIndex((column) => column.includes(split.live)))
  const start = Math.min(Math.max(0, liveColumn - Math.floor((maxColumns - 1) / 2)), columns.length - maxColumns)
  const kept = columns.slice(start, start + maxColumns).flat()
  return { tiles: kept.map((index) => split.tiles[index]), live: kept.indexOf(split.live) }
}

export function splitColumnsThatFit(width: number, minPaneWidth: number): number {
  return width > 0 ? Math.max(1, Math.floor(width / minPaneWidth)) : Number.POSITIVE_INFINITY
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
