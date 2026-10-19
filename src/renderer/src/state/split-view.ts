import { create } from 'zustand'

export const MAX_SPLIT_TILES = 5
export const SPLIT_COLUMN_MIN_WIDTH = 360

export function splitColumnLimit(containerWidth: number): number {
  if (!(containerWidth > 0)) return MAX_SPLIT_TILES
  return Math.max(2, Math.min(MAX_SPLIT_TILES, Math.floor(containerWidth / SPLIT_COLUMN_MIN_WIDTH)))
}

export interface SplitSessionRef {
  sessionId?: string
  path?: string
  uid?: string
}

export interface SplitLayout {
  tiles: SplitSessionRef[]
  live: number
}

let nextUid = 0
const withUid = (ref: SplitSessionRef, uid?: string): SplitSessionRef => ({ ...ref, uid: uid ?? ref.uid ?? `t${++nextUid}` })

const normPath = (p?: string): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

const AUX_TILE = /^(?:subagent|tool):/
const TOOL_TILE = /^tool:/

export const isAuxTile = (ref: SplitSessionRef | null | undefined): boolean => !!ref?.sessionId && AUX_TILE.test(ref.sessionId)

export function sameSplitSession(a: SplitSessionRef | null | undefined, b: SplitSessionRef | null | undefined): boolean {
  if (!a || !b) return false
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId
  return !!a.path && !!b.path && normPath(a.path) === normPath(b.path)
}

const indexOfSession = (tiles: SplitSessionRef[], target: SplitSessionRef): number => tiles.findIndex((t) => sameSplitSession(t, target))

export function displayedSessionOf(view: {
  peekedSessionId: string | null
  peekedPath: string | null
  session: { sessionId?: string; sessionFile?: string } | null
}): SplitSessionRef | null {
  if (view.peekedSessionId || view.peekedPath) return { sessionId: view.peekedSessionId ?? undefined, path: view.peekedPath ?? undefined }
  if (view.session?.sessionId || view.session?.sessionFile) return { sessionId: view.session.sessionId || undefined, path: view.session.sessionFile || undefined }
  return null
}

const merge = (a: SplitSessionRef, b: SplitSessionRef): SplitSessionRef => ({ sessionId: b.sessionId ?? a.sessionId, path: b.path ?? a.path, uid: a.uid })
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
  tiles[split.live] = withUid(displayed, tiles[split.live].uid)
  return { tiles, live: split.live }
}

export function neighborOf(split: SplitLayout, index: number): number {
  return index + 1 < split.tiles.length ? index + 1 : index - 1
}

export function placeInSplit(split: SplitLayout | null, target: SplitSessionRef, current: SplitSessionRef | null, at?: number, limit: number = MAX_SPLIT_TILES): SplitLayout | null {
  if (!current) return split
  if (!split) {
    if (sameSplitSession(target, current)) return null
    return at === 0
      ? { tiles: [withUid(target), withUid(current)], live: 1 }
      : { tiles: [withUid(current), withUid(target)], live: 0 }
  }
  const liveRef = split.tiles[split.live]
  const existing = indexOfSession(split.tiles, target)
  let tiles = split.tiles.slice()
  let slot = Math.max(0, Math.min(at ?? tiles.length, tiles.length))
  if (existing >= 0) {
    tiles.splice(existing, 1)
    if (existing < slot) slot -= 1
  } else if (tiles.length >= limit) {
    let drop = -1
    for (let i = 0; i < tiles.length; i++) {
      if (i === split.live) continue
      if (drop < 0 || Math.abs(i + 0.5 - slot) < Math.abs(drop + 0.5 - slot)) drop = i
    }
    if (drop < 0) return split
    tiles.splice(drop, 1)
    if (drop < slot) slot -= 1
  }
  tiles.splice(slot, 0, withUid(target, existing >= 0 ? split.tiles[existing].uid : undefined))
  const live = indexOfSession(tiles, liveRef)
  return { tiles, live: live >= 0 ? live : 0 }
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
  const tiles = split.tiles.filter((_, i) => i !== index)
  if (tiles.length < 2 || tiles.every(isAuxTile)) return null
  if (index !== split.live) return { tiles, live: index < split.live ? split.live - 1 : split.live }
  const next = nearestSessionOf(split.tiles, index)
  return { tiles, live: next > index ? next - 1 : next }
}

export function moveSplitTile(split: SplitLayout, from: number, to: number): SplitLayout {
  if (from < 0 || from >= split.tiles.length) return split
  let slot = Math.max(0, Math.min(to, split.tiles.length))
  if (slot === from || slot === from + 1) return split
  const tiles = split.tiles.slice()
  const [tile] = tiles.splice(from, 1)
  if (from < slot) slot -= 1
  tiles.splice(slot, 0, tile)
  return { tiles, live: tiles.indexOf(split.tiles[split.live]) }
}

export const splitTileKey = (tile: SplitSessionRef): string => tile.uid || tile.sessionId || tile.path || ''

interface SplitViewState {
  split: SplitLayout | null
  weights: Record<string, number>
  containerWidth: number
  setContainerWidth(width: number): void
  setWeights(next: Record<string, number>): void
  open(target: SplitSessionRef, current: SplitSessionRef | null, at?: number): void
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
  containerWidth: 0,
  setContainerWidth: (width) => {
    if (width !== get().containerWidth) set({ containerWidth: width })
  },
  setWeights: (next) => set({ weights: { ...get().weights, ...next } }),
  open: (target, current, at) => {
    const limit = target.sessionId && TOOL_TILE.test(target.sessionId) ? MAX_SPLIT_TILES : splitColumnLimit(get().containerWidth)
    const next = placeInSplit(get().split, target, current, at, limit)
    if (next !== get().split) set({ split: next, weights: keepWeights(get().weights, next) })
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
