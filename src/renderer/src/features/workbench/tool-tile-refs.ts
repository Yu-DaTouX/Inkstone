import type { SplitLayout, SplitSessionRef } from '../../state/split-view'
import type { WorkbenchTabId } from './types'

export const TOOL_TILE_PREFIX = 'tool:'

export const TILE_TOOLS: readonly WorkbenchTabId[] = ['changes', 'terminal', 'files', 'browser', 'preview', 'logs', 'branch', 'device', 'pullRequests']

export const TOOL_TILE_MIN_WIDTH = 280

export function roomForAnotherTile(width: number, columns: number): boolean {
  return width >= (Math.max(1, columns) + 1) * TOOL_TILE_MIN_WIDTH
}

export function tileCapacity(width: number): number {
  return width > 0 ? Math.max(1, Math.floor(width / TOOL_TILE_MIN_WIDTH)) : Number.POSITIVE_INFINITY
}

export function fitToolTiles(tiles: readonly SplitSessionRef[], capacity: number): SplitSessionRef[] {
  const kept = tiles.slice()
  let excess = kept.length - capacity
  for (let i = kept.length - 1; i >= 0 && excess > 0; i--) {
    if (!toolTabOf(kept[i])) continue
    kept.splice(i, 1)
    excess -= 1
  }
  return kept
}

export function fitPaneTiles<T extends { tiles: SplitSessionRef[]; live: number }>(layout: T | null, capacity: number): T | null {
  if (!layout) return null
  const tiles = fitToolTiles(layout.tiles, capacity)
  if (tiles.length === layout.tiles.length) return layout
  return { ...layout, tiles, live: Math.max(0, tiles.indexOf(layout.tiles[layout.live])) }
}

export function canTileTool(tab: string): tab is WorkbenchTabId {
  return (TILE_TOOLS as readonly string[]).includes(tab)
}

export function toolTileRef(tab: WorkbenchTabId): SplitSessionRef {
  return { sessionId: `${TOOL_TILE_PREFIX}${tab}` }
}

export function toolTabOf(ref: SplitSessionRef | null | undefined): WorkbenchTabId | null {
  const id = ref?.sessionId
  if (!id || !id.startsWith(TOOL_TILE_PREFIX)) return null
  const tab = id.slice(TOOL_TILE_PREFIX.length)
  return canTileTool(tab) ? tab : null
}

export function visibleToolTiles(split: SplitLayout | null, narrow: boolean, capacity = Number.POSITIVE_INFINITY): WorkbenchTabId[] {
  if (narrow || !split || split.tiles.length < 2) return []
  return fitToolTiles(split.tiles, capacity).map(toolTabOf).filter((tab): tab is WorkbenchTabId => !!tab)
}

export function toolTileIndex(split: SplitLayout | null, tab: WorkbenchTabId): number {
  return split ? split.tiles.findIndex((ref) => toolTabOf(ref) === tab) : -1
}
