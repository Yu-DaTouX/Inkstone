import {
  CHAT_TILE_ID,
  chatFlexOf,
  chatOnlyLayout,
  columnLayout,
  hasTile,
  layoutWithChat,
  orderedTileIds,
  panesLayoutOf,
  rememberPaneFlex,
  removeTile,
  sanitizeLayout,
  type TileLayout
} from '../features/workbench/tile-tree'

export const TILE_LAYOUTS_KEY = 'inkstone.v3.tileLayouts'
export const TILE_LAYOUTS_VERSION = 1
export const MAX_LAYOUT_SESSIONS = 100
export const HOME_LAYOUT_KEY = 'home'
export const SESSION_LAYOUT_PREFIX = 's:'

export const LEGACY_PANES_KEY = 'inkstone.v3.workspacePanes'
export const LEGACY_LAYOUT_KEY = 'inkstone.v3.workspaceLayout'
export const LEGACY_FLEX_KEY = 'inkstone.v3.lastPaneFlexByKind'
export const LEGACY_WIDTH_KEY = 'inkstone.v3.workspaceWidth'

export type PaneFlexByKind = Record<string, number>

export interface TileLayoutEntry {
  tileLayout: TileLayout
  baseLayout: TileLayout | null
  expandedTile: string | null
}

export interface TileLayoutsStore {
  version: 1
  lastPaneFlexByKind: PaneFlexByKind
  sessions: Record<string, TileLayoutEntry>
  order: string[]
}

const storage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)

export function sessionLayoutKey(sessionId: string | null | undefined): string {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  return id ? `${SESSION_LAYOUT_PREFIX}${id}` : HOME_LAYOUT_KEY
}

export function emptyTileLayoutEntry(chatFlex = 2): TileLayoutEntry {
  return { tileLayout: chatOnlyLayout(chatFlex), baseLayout: null, expandedTile: null }
}

export function emptyTileLayouts(): TileLayoutsStore {
  return { version: TILE_LAYOUTS_VERSION, lastPaneFlexByKind: {}, sessions: {}, order: [] }
}

export function sanitizePaneFlexByKind(value: unknown): PaneFlexByKind {
  const out: PaneFlexByKind = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    const flex = Number(raw)
    if (!Number.isFinite(flex) || flex <= 0 || flex >= 100) continue
    out[kind] = Math.round(flex * 10000) / 10000
  }
  return out
}

function layoutOf(raw: unknown): TileLayout | null {
  return sanitizeLayout(raw)
}

export function sanitizeTileLayoutEntry(value: unknown): TileLayoutEntry {
  const entry = emptyTileLayoutEntry()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return entry
  const raw = value as { tileLayout?: unknown; baseLayout?: unknown; expandedTile?: unknown }
  const tileLayout = layoutOf(raw.tileLayout)
  const baseLayout = layoutOf(raw.baseLayout)
  const expandedTile = typeof raw.expandedTile === 'string' && raw.expandedTile ? raw.expandedTile : null
  entry.tileLayout = tileLayout ?? baseLayout ?? chatOnlyLayout()
  entry.baseLayout = baseLayout
  entry.expandedTile = expandedTile
  if (entry.expandedTile && (!entry.baseLayout || !orderedTileIds(entry.tileLayout).includes(entry.expandedTile))) {
    entry.expandedTile = null
    entry.tileLayout = entry.baseLayout ?? entry.tileLayout
    entry.baseLayout = null
  }
  if (!entry.expandedTile) {
    entry.baseLayout = null
    if (!hasTile(entry.tileLayout, CHAT_TILE_ID)) {
      entry.tileLayout = layoutWithChat(panesLayoutOf(entry.tileLayout), chatFlexOf(entry.tileLayout))
    }
  }
  return entry
}

function orderedKeys(state: TileLayoutsStore): string[] {
  const known = new Set(state.order)
  return [...state.order, ...Object.keys(state.sessions).filter((key) => !known.has(key))]
}

export function capLayoutSessions(state: TileLayoutsStore, limit = MAX_LAYOUT_SESSIONS): TileLayoutsStore {
  const keys = orderedKeys(state)
  if (keys.length <= limit) return { ...state, order: keys }
  const kept = keys.slice(keys.length - limit)
  const sessions: Record<string, TileLayoutEntry> = {}
  for (const key of kept) sessions[key] = state.sessions[key]
  return { ...state, sessions, order: kept }
}

export function sanitizeTileLayouts(value: unknown): TileLayoutsStore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<TileLayoutsStore>
  if (raw.version !== TILE_LAYOUTS_VERSION) return null
  if (!raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) return null
  const state = emptyTileLayouts()
  state.lastPaneFlexByKind = sanitizePaneFlexByKind(raw.lastPaneFlexByKind)
  const order = Array.isArray(raw.order) ? raw.order.filter((key): key is string => typeof key === 'string' && key.length > 0) : []
  const sessions = raw.sessions as Record<string, unknown>
  for (const key of [...new Set([...order, ...Object.keys(sessions)])]) {
    if (!Object.prototype.hasOwnProperty.call(sessions, key)) continue
    state.sessions[key] = sanitizeTileLayoutEntry(sessions[key])
    state.order.push(key)
  }
  return capLayoutSessions(state)
}

export function panesOfEntry(entry: TileLayoutEntry | null | undefined): string[] {
  if (!entry) return []
  const layout = entry.expandedTile ? entry.baseLayout ?? entry.tileLayout : entry.tileLayout
  return orderedTileIds(layout).filter((id) => id !== CHAT_TILE_ID)
}

export function expandLayoutEntry(entry: TileLayoutEntry, tileId: string): TileLayoutEntry {
  const base = entry.expandedTile ? entry.baseLayout ?? entry.tileLayout : entry.tileLayout
  if (!hasTile(base, tileId)) return entry
  if (entry.expandedTile === tileId) return entry
  return { tileLayout: columnLayout([tileId]), baseLayout: base, expandedTile: tileId }
}

export function collapseLayoutEntry(entry: TileLayoutEntry): TileLayoutEntry {
  if (!entry.expandedTile) return entry
  return { tileLayout: entry.baseLayout ?? entry.tileLayout, baseLayout: null, expandedTile: null }
}

export function toggleExpandedEntry(entry: TileLayoutEntry, tileId: string): TileLayoutEntry {
  return entry.expandedTile === tileId ? collapseLayoutEntry(entry) : expandLayoutEntry(entry, tileId)
}

export function withLayoutEntry(entry: TileLayoutEntry, layout: TileLayout): TileLayoutEntry {
  return { ...entry, tileLayout: layout, baseLayout: entry.expandedTile ? entry.baseLayout : null }
}

export function withoutLayoutTiles(entry: TileLayoutEntry, gone: ReadonlySet<string>): TileLayoutEntry {
  let base = entry.expandedTile ? entry.baseLayout ?? entry.tileLayout : entry.tileLayout
  for (const tileId of gone) base = removeTile(base, tileId)
  const keepsExpanded = entry.expandedTile !== null && !gone.has(entry.expandedTile) && hasTile(base, entry.expandedTile)
  if (!keepsExpanded) return { tileLayout: base, baseLayout: null, expandedTile: null }
  return { tileLayout: columnLayout([entry.expandedTile as string]), baseLayout: base, expandedTile: entry.expandedTile }
}

function parse(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readRaw(): TileLayoutsStore | null {
  const store = storage()
  if (!store) return null
  try {
    return sanitizeTileLayouts(parse(store.getItem(TILE_LAYOUTS_KEY)))
  } catch {
    return null
  }
}

function writeRaw(state: TileLayoutsStore): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(TILE_LAYOUTS_KEY, JSON.stringify(capLayoutSessions(state)))
  } catch {
  }
}

function paneList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    const item = raw === 'preview' ? 'files' : raw
    if (typeof item !== 'string' || !item || item === 'overview' || out.includes(item)) continue
    out.push(item)
  }
  return out
}

function legacyEntry(): { entry: TileLayoutEntry; flex: PaneFlexByKind } | null {
  const store = storage()
  if (!store) return null
  try {
    const panes = paneList(parse(store.getItem(LEGACY_PANES_KEY)))
    const flex = sanitizePaneFlexByKind(parse(store.getItem(LEGACY_FLEX_KEY)))
    const rawLayout = sanitizeLayout(parse(store.getItem(LEGACY_LAYOUT_KEY)), new Set<string>([...panes, CHAT_TILE_ID]))
    if (!rawLayout && panes.length === 0) return null
    const tree = rawLayout ?? columnLayout(panes)
    const layout = hasTile(tree, CHAT_TILE_ID) ? tree : layoutWithChat(panesLayoutOf(tree), chatFlexOf(tree))
    return { entry: { tileLayout: layout, baseLayout: null, expandedTile: null }, flex }
  } catch {
    return null
  }
}

function dropLegacyKeys(): void {
  const store = storage()
  if (!store) return
  for (const key of [LEGACY_PANES_KEY, LEGACY_LAYOUT_KEY, LEGACY_FLEX_KEY, LEGACY_WIDTH_KEY]) {
    try {
      store.removeItem(key)
    } catch {
    }
  }
}

export function migrateLegacyTileLayouts(): boolean {
  if (readRaw()) return false
  const legacy = legacyEntry()
  if (!legacy) {
    dropLegacyKeys()
    return false
  }
  const state = emptyTileLayouts()
  state.lastPaneFlexByKind = legacy.flex
  state.sessions[HOME_LAYOUT_KEY] = legacy.entry
  state.order = [HOME_LAYOUT_KEY]
  writeRaw(state)
  dropLegacyKeys()
  return true
}

export function readTileLayouts(): TileLayoutsStore {
  const stored = readRaw()
  if (stored) return stored
  const legacy = legacyEntry()
  if (!legacy) return emptyTileLayouts()
  const state = emptyTileLayouts()
  state.lastPaneFlexByKind = legacy.flex
  state.sessions[HOME_LAYOUT_KEY] = legacy.entry
  state.order = [HOME_LAYOUT_KEY]
  return state
}

export function writeTileLayouts(state: TileLayoutsStore): void {
  writeRaw({ ...state, version: TILE_LAYOUTS_VERSION })
}

function touchOrder(state: TileLayoutsStore, key: string): string[] {
  return [...state.order.filter((item) => item !== key), key]
}

export function readTileLayoutEntry(key: string): TileLayoutEntry | null {
  const state = readTileLayouts()
  return state.sessions[key] ?? null
}

export function writeTileLayoutEntry(key: string, entry: TileLayoutEntry): TileLayoutEntry {
  const state = readTileLayouts()
  const next = capLayoutSessions({
    ...state,
    sessions: { ...state.sessions, [key]: entry },
    order: touchOrder(state, key)
  })
  writeTileLayouts(next)
  return entry
}

export function readPaneFlexByKind(): PaneFlexByKind {
  return readTileLayouts().lastPaneFlexByKind
}

export function rememberPaneFlexByKind(layout: TileLayout, changedKeys: readonly string[]): PaneFlexByKind {
  const state = readTileLayouts()
  const next = rememberPaneFlex(layout, changedKeys, state.lastPaneFlexByKind)
  if (next !== state.lastPaneFlexByKind) writeTileLayouts({ ...state, lastPaneFlexByKind: next })
  return next
}
