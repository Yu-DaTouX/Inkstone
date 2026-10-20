import {
  MAX_SPLIT_TILES,
  SPLIT_ROW_DEFAULT,
  SPLIT_ROW_MAX,
  SPLIT_ROW_MIN,
  indexOfSession,
  isAuxTile,
  normalizeSplitTiles,
  splitColumns,
  stackedBelow,
  withUid,
  type SplitLayout,
  type SplitSessionRef
} from '../../state/split-view'

export const SPLIT_COLUMN_PX = 360
export const SPLIT_MAX_COLUMNS = 5
export const SPLIT_MIN_PANE_PX = 320
export const SPLIT_CONSTRAINED_QUERY = '(max-width: 700px)'
export const SPLIT_CONSTRAINED_WIDTH = 700
export const DROP_INSET_PX = 8
export const LEFT_EDGE_PX = 16
export const SESSION_DRAG_THRESHOLD = 4

export type SplitDropTarget =
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'below'; col: number }
  | { kind: 'replace'; index: number; col: number; row: 0 | 1 }

export interface DropRect {
  left: number
  top: number
  width: number
  height: number
}

export interface DropGeometry {
  host: DropRect
  columns: readonly DropRect[]
  rowSplit: number
}

export interface DropContext {
  tiles: readonly SplitSessionRef[]
  maxColumns: number
  canGrow: boolean
  canOpenLeft: boolean
}

export type DropBadgeLabel = 'here' | 'split'

export interface DropBadge {
  box: DropRect
  label: DropBadgeLabel
  hint: boolean
}

export function maxColumnsFor(width: number): number {
  const columns = Math.floor((Number.isFinite(width) ? width : 0) / SPLIT_COLUMN_PX)
  return Math.max(1, Math.min(SPLIT_MAX_COLUMNS, columns || 1))
}

export function sameDropTarget(a: SplitDropTarget | null, b: SplitDropTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'below' && b.kind === 'below') return a.col === b.col
  if (a.kind === 'replace' && b.kind === 'replace') return a.index === b.index
  return true
}

const replaceable = (tile: SplitSessionRef | undefined): boolean => !!tile && !isAuxTile(tile) && !!(tile.sessionId || tile.path)

export function dropContextFor(
  split: SplitLayout | null,
  current: SplitSessionRef | null,
  dragged: SplitSessionRef | null,
  hostWidth: number
): DropContext | null {
  const tiles = split ? split.tiles : current ? [current] : []
  if (!tiles.length) return null
  const shown = dragged ? indexOfSession(tiles, dragged) >= 0 : false
  return {
    tiles,
    maxColumns: maxColumnsFor(hostWidth),
    canGrow: tiles.length < MAX_SPLIT_TILES,
    canOpenLeft: !!dragged && !shown
  }
}

export function sessionDropTarget(ctx: DropContext, geometry: DropGeometry, x: number, y: number): SplitDropTarget | null {
  const { host } = geometry
  if (x < host.left || x >= host.left + host.width || y < host.top || y >= host.top + host.height) return null
  const columns = splitColumns(ctx.tiles)
  const rects = geometry.columns.length === columns.length ? geometry.columns : evenColumns(host, columns.length)
  const count = rects.length
  if (!count) return null
  let at = rects.findIndex((rect) => x >= rect.left && x < rect.left + rect.width)
  if (at === -1) at = x < rects[0].left ? 0 : count - 1
  const rect = rects[at]
  if (at === count - 1 && count < ctx.maxColumns && ctx.canGrow && x >= rect.left + rect.width / 2) return { kind: 'right' }
  const row: 0 | 1 = y >= rect.top + rect.height * geometry.rowSplit ? 1 : 0
  if (at !== 0 || row !== 0) {
    const column = columns[at]
    if (row === 1 && column.length === 1) return ctx.canGrow ? { kind: 'below', col: at } : null
    const index = column[row] ?? column[0]
    return replaceable(ctx.tiles[index]) ? { kind: 'replace', index, col: at, row: column.length > 1 ? row : 0 } : null
  }
  const leftZone = x >= rect.left + LEFT_EDGE_PX && x < rect.left + rect.width / 3
  return ctx.canOpenLeft && ctx.canGrow && count < ctx.maxColumns && leftZone ? { kind: 'left' } : null
}

export function defaultDropTarget(ctx: DropContext): SplitDropTarget | null {
  const columns = splitColumns(ctx.tiles)
  if (ctx.canGrow && columns.length < ctx.maxColumns) return { kind: 'right' }
  if (ctx.canGrow) {
    const col = columns.findIndex((column) => column.length === 1)
    if (col >= 0) return { kind: 'below', col }
  }
  for (let col = columns.length - 1; col >= 0; col--) {
    const column = columns[col]
    for (let row = column.length - 1; row >= 0; row--) {
      const index = column[row]
      if (replaceable(ctx.tiles[index])) return { kind: 'replace', index, col, row: column.length > 1 ? (row as 0 | 1) : 0 }
    }
  }
  return null
}

function evenColumns(host: DropRect, count: number): DropRect[] {
  const width = count > 0 ? host.width / count : host.width
  return Array.from({ length: count }, (_, at) => ({ left: host.left + at * width, top: host.top, width, height: host.height }))
}

function inset(box: DropRect): DropRect {
  return {
    left: box.left + DROP_INSET_PX,
    top: box.top + DROP_INSET_PX,
    width: Math.max(0, box.width - 2 * DROP_INSET_PX),
    height: Math.max(0, box.height - 2 * DROP_INSET_PX)
  }
}

export function dropBadgeBox(target: SplitDropTarget, ctx: DropContext, geometry: DropGeometry): DropRect {
  const { host } = geometry
  const columns = splitColumns(ctx.tiles)
  const rects = geometry.columns.length === columns.length ? geometry.columns : evenColumns(host, columns.length)
  if (target.kind === 'right' || target.kind === 'left') {
    const width = host.width / (columns.length + 1)
    const left = target.kind === 'right' ? host.left + host.width - width : host.left
    return inset({ left, top: host.top, width, height: host.height })
  }
  const rect = rects[target.col] ?? host
  const split = rect.top + rect.height * geometry.rowSplit
  if (target.kind === 'below' || (target.kind === 'replace' && target.row === 1)) {
    return inset({ left: rect.left, top: split, width: rect.width, height: rect.top + rect.height - split })
  }
  const stacked = (columns[target.col]?.length ?? 1) > 1
  return inset({ left: rect.left, top: rect.top, width: rect.width, height: stacked ? split - rect.top : rect.height })
}

export function dropBadge(target: SplitDropTarget | null, ctx: DropContext, geometry: DropGeometry): DropBadge | null {
  const shown = target ?? defaultDropTarget(ctx)
  if (!shown) return null
  return {
    box: dropBadgeBox(shown, ctx, geometry),
    label: target !== null && shown.kind === 'replace' ? 'here' : 'split',
    hint: target === null
  }
}

export function applySessionDrop(
  split: SplitLayout | null,
  target: SplitDropTarget,
  ref: SplitSessionRef,
  current: SplitSessionRef | null
): SplitLayout | null {
  const base: SplitLayout | null = split ?? (current ? { tiles: [withUid(stackedBelow(current, false))], live: 0 } : null)
  if (!base) return null
  const shown = indexOfSession(base.tiles, ref)
  if (shown >= 0) return split ? { tiles: base.tiles, live: shown } : null
  const fresh = withUid(stackedBelow({ sessionId: ref.sessionId, path: ref.path }, false))
  const tiles = base.tiles.slice()
  const columns = splitColumns(tiles)
  let placed = -1
  switch (target.kind) {
    case 'left':
      tiles.unshift(fresh)
      placed = 0
      break
    case 'right':
      tiles.push(fresh)
      placed = tiles.length - 1
      break
    case 'below': {
      const column = columns[target.col]
      if (!column || column.length > 1) return split
      placed = column[0] + 1
      tiles.splice(placed, 0, stackedBelow(fresh, true))
      break
    }
    case 'replace': {
      const previous = tiles[target.index]
      if (!replaceable(previous)) return split
      tiles[target.index] = stackedBelow(fresh, !!previous.below)
      placed = target.index
      break
    }
  }
  const normalized = normalizeSplitTiles(tiles)
  if (normalized.length < 2) return split
  return { tiles: normalized, live: placed }
}

export function rowBoundsFor(height: number): { min: number; max: number } {
  if (!(height > 0)) return { min: SPLIT_ROW_MIN, max: SPLIT_ROW_MAX }
  const min = Math.max(SPLIT_ROW_MIN, SPLIT_MIN_PANE_PX / height)
  return min < 0.5 ? { min, max: 1 - min } : { min: 0.5, max: 0.5 }
}

export function rowSplitFor(value: number, height: number): number {
  const { min, max } = rowBoundsFor(height)
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : SPLIT_ROW_DEFAULT))
}
