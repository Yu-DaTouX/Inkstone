import { create } from 'zustand'

export const MAX_SPLIT_TILES = 5
export const SPLIT_COLUMN_MIN_WIDTH = 360
export const SPLIT_ROW_DEFAULT = 0.5
export const SPLIT_ROW_MIN = 0.15
export const SPLIT_ROW_MAX = 0.85

export function splitColumnLimit(containerWidth: number): number {
  if (!(containerWidth > 0)) return MAX_SPLIT_TILES
  return Math.max(2, Math.min(MAX_SPLIT_TILES, Math.floor(containerWidth / SPLIT_COLUMN_MIN_WIDTH)))
}

export interface SplitSessionRef {
  sessionId?: string
  path?: string
  uid?: string
  below?: boolean
}

export interface SplitLayout {
  tiles: SplitSessionRef[]
  live: number
}

let nextUid = 0
export const withUid = (ref: SplitSessionRef, uid?: string): SplitSessionRef => ({ ...ref, uid: uid ?? ref.uid ?? `t${++nextUid}` })

const normPath = (p?: string): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

const AUX_TILE = /^(?:subagent|tool):/
const TOOL_TILE = /^tool:/

export const isAuxTile = (ref: SplitSessionRef | null | undefined): boolean => !!ref?.sessionId && AUX_TILE.test(ref.sessionId)

export function sameSplitSession(a: SplitSessionRef | null | undefined, b: SplitSessionRef | null | undefined): boolean {
  if (!a || !b) return false
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId
  return !!a.path && !!b.path && normPath(a.path) === normPath(b.path)
}

export const indexOfSession = (tiles: readonly SplitSessionRef[], target: SplitSessionRef): number => tiles.findIndex((t) => sameSplitSession(t, target))

export function stackedBelow(ref: SplitSessionRef, below: boolean): SplitSessionRef {
  if (!!ref.below === below) return ref
  const { below: _drop, ...rest } = ref
  return below ? { ...rest, below: true } : rest
}

export function normalizeSplitTiles(tiles: readonly SplitSessionRef[]): SplitSessionRef[] {
  let changed = false
  let canStack = false
  const next = tiles.map((tile) => {
    if (tile.below && canStack) {
      canStack = false
      return tile
    }
    canStack = true
    if (!tile.below) return tile
    changed = true
    return stackedBelow(tile, false)
  })
  return changed ? next : (tiles as SplitSessionRef[])
}

export function splitColumns(tiles: readonly SplitSessionRef[]): number[][] {
  const columns: number[][] = []
  tiles.forEach((tile, index) => {
    const last = columns[columns.length - 1]
    if (tile.below && last && last.length === 1) last.push(index)
    else columns.push([index])
  })
  return columns
}

export function splitColumnCount(tiles: readonly SplitSessionRef[]): number {
  return splitColumns(tiles).length
}

export function columnOfTile(tiles: readonly SplitSessionRef[], index: number): number {
  return splitColumns(tiles).findIndex((column) => column.includes(index))
}

function removeTileAt(tiles: SplitSessionRef[], index: number): void {
  const partner = tiles[index + 1]
  if (!tiles[index]?.below && partner?.below) tiles[index + 1] = stackedBelow(partner, false)
  tiles.splice(index, 1)
}

export function displayedSessionOf(view: {
  peekedSessionId: string | null
  peekedPath: string | null
  session: { sessionId?: string; sessionFile?: string } | null
}): SplitSessionRef | null {
  if (view.peekedSessionId || view.peekedPath) return { sessionId: view.peekedSessionId ?? undefined, path: view.peekedPath ?? undefined }
  if (view.session?.sessionId || view.session?.sessionFile) return { sessionId: view.session.sessionId || undefined, path: view.session.sessionFile || undefined }
  return null
}

const merge = (a: SplitSessionRef, b: SplitSessionRef): SplitSessionRef => {
  const merged: SplitSessionRef = { sessionId: b.sessionId ?? a.sessionId, path: b.path ?? a.path, uid: a.uid }
  return a.below ? { ...merged, below: true } : merged
}
const sameFields = (a: SplitSessionRef, b: SplitSessionRef): boolean => (a.sessionId === (b.sessionId ?? a.sessionId)) && (a.path === (b.path ?? a.path))

export function reconcileSplit(split: SplitLayout, displayed: SplitSessionRef | null): SplitLayout {
  if (!displayed || (!displayed.sessionId && !displayed.path)) return split
  const at = indexOfSession(split.tiles, displayed)
  if (at >= 0) {
    if (split.live === at && sameFields(split.tiles[at], displayed)) return split
    const tiles = split.tiles.slice()
    tiles[at] = merge(tiles[at], displayed)
    return { tiles, live: at }
  }
  const tiles = split.tiles.slice()
  const previous = tiles[split.live]
  tiles[split.live] = stackedBelow(withUid(stackedBelow(displayed, false), previous.uid), !!previous.below)
  return { tiles, live: split.live }
}

export function neighborOf(split: SplitLayout, index: number): number {
  return index + 1 < split.tiles.length ? index + 1 : index - 1
}

function columnSafeSlot(tiles: readonly SplitSessionRef[], slot: number): number {
  return slot < tiles.length && tiles[slot]?.below ? slot + 1 : slot
}

export function placeInSplit(split: SplitLayout | null, target: SplitSessionRef, current: SplitSessionRef | null, at?: number, limit: number = MAX_SPLIT_TILES): SplitLayout | null {
  if (!current) return split
  const fresh = stackedBelow(target, false)
  if (!split) {
    if (sameSplitSession(fresh, current)) return null
    return at === 0
      ? { tiles: [withUid(fresh), withUid(stackedBelow(current, false))], live: 1 }
      : { tiles: [withUid(stackedBelow(current, false)), withUid(fresh)], live: 0 }
  }
  const liveRef = split.tiles[split.live]
  const existing = indexOfSession(split.tiles, fresh)
  const tiles = split.tiles.slice()
  let slot = Math.max(0, Math.min(at ?? tiles.length, tiles.length))
  if (existing >= 0) {
    removeTileAt(tiles, existing)
    if (existing < slot) slot -= 1
  } else if (tiles.length >= limit) {
    let drop = -1
    for (let i = 0; i < tiles.length; i++) {
      if (i === split.live) continue
      if (drop < 0 || Math.abs(i + 0.5 - slot) < Math.abs(drop + 0.5 - slot)) drop = i
    }
    if (drop < 0) return split
    removeTileAt(tiles, drop)
    if (drop < slot) slot -= 1
  }
  slot = columnSafeSlot(tiles, Math.max(0, Math.min(slot, tiles.length)))
  tiles.splice(slot, 0, withUid(fresh, existing >= 0 ? split.tiles[existing].uid : undefined))
  const normalized = normalizeSplitTiles(tiles)
  const live = indexOfSession(normalized, liveRef)
  return { tiles: normalized, live: live >= 0 ? live : 0 }
}

export function nearestSessionOf(tiles: readonly SplitSessionRef[], index: number): number {
  for (let step = 1; step < tiles.length; step++) {
    if (index + step < tiles.length && !isAuxTile(tiles[index + step])) return index + step
    if (index - step >= 0 && !isAuxTile(tiles[index - step])) return index - step
  }
  return -1
}

export function removeSplitTile(split: SplitLayout, index: number): SplitLayout | null {
  if (index < 0 || index >= split.tiles.length) return split
  const rest = split.tiles.slice()
  removeTileAt(rest, index)
  const tiles = normalizeSplitTiles(rest)
  if (tiles.length < 2 || tiles.every(isAuxTile)) return null
  if (index !== split.live) return { tiles, live: index < split.live ? split.live - 1 : split.live }
  const next = nearestSessionOf(split.tiles, index)
  return { tiles, live: next > index ? next - 1 : next }
}

export function moveSplitTile(split: SplitLayout, from: number, to: number): SplitLayout {
  if (from < 0 || from >= split.tiles.length) return split
  let slot = Math.max(0, Math.min(to, split.tiles.length))
  const moving = split.tiles[from]
  if (!moving.below && (slot === from || slot === from + 1)) return split
  const tiles = split.tiles.slice()
  removeTileAt(tiles, from)
  if (from < slot) slot -= 1
  slot = columnSafeSlot(tiles, Math.max(0, Math.min(slot, tiles.length)))
  tiles.splice(slot, 0, stackedBelow(moving, false))
  const normalized = normalizeSplitTiles(tiles)
  return { tiles: normalized, live: liveIndexAfter(normalized, split.tiles[split.live]) }
}

function liveIndexAfter(tiles: readonly SplitSessionRef[], live: SplitSessionRef | undefined): number {
  if (!live) return 0
  const same = tiles.indexOf(live)
  if (same >= 0) return same
  const key = splitTileKey(live)
  return Math.max(0, tiles.findIndex((tile) => splitTileKey(tile) === key))
}

export const splitTileKey = (tile: SplitSessionRef): string => tile.uid || tile.sessionId || tile.path || ''

export function clampRowSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_ROW_DEFAULT
  return Math.min(SPLIT_ROW_MAX, Math.max(SPLIT_ROW_MIN, value))
}

interface SplitViewState {
  split: SplitLayout | null
  weights: Record<string, number>
  rowSplit: number
  containerWidth: number
  setContainerWidth(width: number): void
  setWeights(next: Record<string, number>): void
  setRowSplit(value: number): void
  open(target: SplitSessionRef, current: SplitSessionRef | null, at?: number): void
  apply(next: SplitLayout | null): void
  sync(displayed: SplitSessionRef | null): void
  remove(index: number): void
  move(from: number, to: number): void
  close(): void
}

function keepWeights(weights: Record<string, number>, split: SplitLayout | null): Record<string, number> {
  const alive = new Set(split?.tiles.map(splitTileKey))
  return Object.fromEntries(Object.entries(weights).filter(([key]) => alive.has(key)))
}

export const useSplitView = create<SplitViewState>((set, get) => ({
  split: null,
  weights: {},
  rowSplit: SPLIT_ROW_DEFAULT,
  containerWidth: 0,
  setContainerWidth: (width) => {
    if (width !== get().containerWidth) set({ containerWidth: width })
  },
  setWeights: (next) => set({ weights: { ...get().weights, ...next } }),
  setRowSplit: (value) => {
    const next = clampRowSplit(value)
    if (next !== get().rowSplit) set({ rowSplit: next })
  },
  open: (target, current, at) => {
    const limit = target.sessionId && TOOL_TILE.test(target.sessionId) ? MAX_SPLIT_TILES : splitColumnLimit(get().containerWidth)
    const next = placeInSplit(get().split, target, current, at, limit)
    if (next !== get().split) set({ split: next, weights: keepWeights(get().weights, next) })
  },
  apply: (next) => {
    const normalized = next && next.tiles.length >= 2 ? { tiles: normalizeSplitTiles(next.tiles), live: next.live } : null
    if (normalized !== get().split) set({ split: normalized, weights: keepWeights(get().weights, normalized) })
  },
  sync: (displayed) => {
    const split = get().split
    if (!split) return
    const next = reconcileSplit(split, displayed)
    if (next !== split) set({ split: next, weights: keepWeights(get().weights, next) })
  },
  remove: (index) => {
    const split = get().split
    if (!split) return
    const next = removeSplitTile(split, index)
    set({ split: next, weights: keepWeights(get().weights, next) })
  },
  move: (from, to) => {
    const split = get().split
    if (!split) return
    const next = moveSplitTile(split, from, to)
    if (next !== split) set({ split: next })
  },
  close: () => set({ split: null, weights: {} })
}))
