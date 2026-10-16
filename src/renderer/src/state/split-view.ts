import { create } from 'zustand'

export const MAX_SPLIT_TILES = 5

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

export function placeInSplit(split: SplitLayout | null, target: SplitSessionRef, current: SplitSessionRef | null, at?: number): SplitLayout | null {
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
  } else if (tiles.length >= MAX_SPLIT_TILES) {
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

export function removeSplitTile(split: SplitLayout, index: number): SplitLayout | null {
  if (index < 0 || index >= split.tiles.length) return split
  const tiles = split.tiles.filter((_, i) => i !== index)
  if (tiles.length < 2) return null
  const live = index < split.live ? split.live - 1 : Math.min(split.live, tiles.length - 1)
  return { tiles, live }
}

export const splitTileKey = (tile: SplitSessionRef): string => tile.uid || tile.sessionId || tile.path || ''

interface SplitViewState {
  split: SplitLayout | null
  weights: Record<string, number>
  setWeights(next: Record<string, number>): void
  open(target: SplitSessionRef, current: SplitSessionRef | null, at?: number): void
  sync(displayed: SplitSessionRef | null): void
  remove(index: number): void
  close(): void
}

function keepWeights(weights: Record<string, number>, split: SplitLayout | null): Record<string, number> {
  const alive = new Set(split?.tiles.map(splitTileKey))
  return Object.fromEntries(Object.entries(weights).filter(([key]) => alive.has(key)))
}

export const useSplitView = create<SplitViewState>((set, get) => ({
  split: null,
  weights: {},
  setWeights: (next) => set({ weights: { ...get().weights, ...next } }),
  open: (target, current, at) => {
    const next = placeInSplit(get().split, target, current, at)
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
  close: () => set({ split: null, weights: {} })
}))
