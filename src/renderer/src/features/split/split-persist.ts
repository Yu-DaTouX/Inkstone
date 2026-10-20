import {
  MAX_SPLIT_TILES,
  SPLIT_ROW_DEFAULT,
  clampRowSplit,
  isAuxTile,
  normalizeSplitTiles,
  sameSplitSession,
  splitColumns,
  splitTileKey,
  stackedBelow,
  withUid,
  type SplitLayout,
  type SplitSessionRef
} from '../../state/split-view'

export const SPLIT_STORAGE_KEY = 'inkstone.v3.splitLayout'
export const SPLIT_STORAGE_VERSION = 1

export interface SavedSplitTile {
  sessionId?: string
  path?: string
  below?: true
}

export interface SavedSplit {
  version: number
  tiles: SavedSplitTile[]
  live: number
  weights: number[] | null
  rowSplit: number
}

export interface SplitSnapshot {
  split: SplitLayout | null
  weights: Record<string, number>
  rowSplit: number
}

export interface KnownSession {
  id: string
  path: string
  archivedAt?: number
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/.test(value) ? value : undefined

export function serializeSplit(snapshot: SplitSnapshot): SavedSplit | null {
  const split = snapshot.split
  if (!split) return null
  const liveTile = split.tiles[split.live]
  const kept = normalizeSplitTiles(split.tiles.filter((tile) => !isAuxTile(tile) && (tile.sessionId || tile.path)))
  if (kept.length < 2) return null
  const columns = splitColumns(kept)
  const weights = columns.map((column) => snapshot.weights[splitTileKey(kept[column[0]])] ?? 1)
  const live = Math.max(0, kept.findIndex((tile) => tile === liveTile || sameSplitSession(tile, liveTile)))
  return {
    version: SPLIT_STORAGE_VERSION,
    tiles: kept.map((tile) => {
      const saved: SavedSplitTile = {}
      if (tile.sessionId) saved.sessionId = tile.sessionId
      if (tile.path) saved.path = tile.path
      if (tile.below) saved.below = true
      return saved
    }),
    live,
    weights: weights.every((value) => value === 1) ? null : weights,
    rowSplit: clampRowSplit(snapshot.rowSplit)
  }
}

export function restoreSplit(raw: unknown, sessions: readonly KnownSession[]): SplitSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const saved = raw as Partial<SavedSplit>
  if (saved.version !== SPLIT_STORAGE_VERSION || !Array.isArray(saved.tiles)) return null
  const picked: SplitSessionRef[] = []
  let liveRef: SplitSessionRef | null = null
  saved.tiles.slice(0, MAX_SPLIT_TILES).forEach((entry, at) => {
    const value = entry && typeof entry === 'object' ? (entry as SavedSplitTile) : null
    const ref: SplitSessionRef = { sessionId: text(value?.sessionId), path: text(value?.path) }
    if (!ref.sessionId && !ref.path) return
    const known = sessions.find((session) => sameSplitSession({ sessionId: session.id, path: session.path }, ref))
    if (!known || known.archivedAt) return
    if (picked.some((tile) => sameSplitSession(tile, ref))) return
    const tile = stackedBelow(withUid({ sessionId: known.id, path: known.path }), value?.below === true)
    picked.push(tile)
    if (at === saved.live) liveRef = tile
  })
  const tiles = normalizeSplitTiles(picked)
  if (tiles.length < 2) return null
  const live = Math.max(0, liveRef ? tiles.findIndex((tile) => sameSplitSession(tile, liveRef)) : 0)
  const columns = splitColumns(tiles)
  const weights: Record<string, number> = {}
  const savedWeights = Array.isArray(saved.weights) && saved.weights.length === columns.length ? saved.weights : null
  if (savedWeights && savedWeights.every((value) => Number.isFinite(value) && value > 0)) {
    columns.forEach((column, at) => {
      weights[splitTileKey(tiles[column[0]])] = Math.max(0.01, savedWeights[at])
    })
  }
  const rowSplit = typeof saved.rowSplit === 'number' ? clampRowSplit(saved.rowSplit) : SPLIT_ROW_DEFAULT
  return { split: { tiles, live }, weights, rowSplit }
}

export function readSavedSplit(storage: Pick<Storage, 'getItem'> | undefined): unknown {
  try {
    const raw = storage?.getItem(SPLIT_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeSavedSplit(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, saved: SavedSplit | null): void {
  try {
    if (saved) storage?.setItem(SPLIT_STORAGE_KEY, JSON.stringify(saved))
    else storage?.removeItem(SPLIT_STORAGE_KEY)
  } catch {
  }
}
