import {
  MAX_SPLIT_TILES,
  SPLIT_ROW_DEFAULT,
  SPLIT_ROW_MAX,
  SPLIT_ROW_MIN,
  indexOfSession,
  normalizeSplitTiles,
  splitTileKey,
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

export type DropBadgeLabel = 'here' | 'split' | 'swap' | 'move'

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

const replaceable = (tile: SplitSessionRef | undefined): boolean => !!tile && !!(tile.sessionId || tile.path)

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

type CellPart = 'full' | 'top' | 'bottom'

function cellBox(rect: DropRect, part: CellPart, rowSplit: number): DropRect {
  if (part === 'full') return inset(rect)
  const split = rect.top + rect.height * rowSplit
  return part === 'top'
    ? inset({ left: rect.left, top: rect.top, width: rect.width, height: split - rect.top })
    : inset({ left: rect.left, top: split, width: rect.width, height: rect.top + rect.height - split })
}

function newColumnBox(host: DropRect, count: number, side: 'left' | 'right'): DropRect {
  const width = host.width / (count + 1)
  return inset({ left: side === 'right' ? host.left + host.width - width : host.left, top: host.top, width, height: host.height })
}

function columnRects(geometry: DropGeometry, count: number): readonly DropRect[] {
  return geometry.columns.length === count ? geometry.columns : evenColumns(geometry.host, count)
}

export function dropBadgeBox(target: SplitDropTarget, ctx: DropContext, geometry: DropGeometry): DropRect {
  const { host } = geometry
  const columns = splitColumns(ctx.tiles)
  if (target.kind === 'right' || target.kind === 'left') return newColumnBox(host, columns.length, target.kind)
  const rect = columnRects(geometry, columns.length)[target.col] ?? host
  if (target.kind === 'below' || (target.kind === 'replace' && target.row === 1)) return cellBox(rect, 'bottom', geometry.rowSplit)
  const stacked = (columns[target.col]?.length ?? 1) > 1
  return cellBox(rect, stacked ? 'top' : 'full', geometry.rowSplit)
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

export type PaneDropTarget =
  | { kind: 'swap'; index: number }
  | { kind: 'column'; at: number }
  | { kind: 'stack'; col: number; row: 0 | 1 }

export interface PaneDropZone {
  col: number
  row: 0 | 1
  zone: 'above' | 'below' | 'swap'
  band: 'left' | 'right' | null
  edge: boolean
  sideFirst: boolean
}

export const PANE_DROP_EDGE = 1 / 4
export const PANE_DROP_BAND = 1 / 3

export function samePaneTarget(a: PaneDropTarget | null, b: PaneDropTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'swap' && b.kind === 'swap') return a.index === b.index
  if (a.kind === 'column' && b.kind === 'column') return a.at === b.at
  if (a.kind === 'stack' && b.kind === 'stack') return a.col === b.col && a.row === b.row
  return false
}

export function paneDropZone(columns: readonly DropRect[], rowSplit: number, x: number, y: number): PaneDropZone | null {
  if (!columns.length) return null
  let at = columns.findIndex((rect) => x >= rect.left && x < rect.left + rect.width)
  if (at === -1) at = x < columns[0].left ? 0 : columns.length - 1
  const rect = columns[at]
  const rightHalf = x >= rect.left + rect.width / 2
  let band: PaneDropZone['band'] = null
  let reach = 0
  if (rightHalf && at === columns.length - 1) {
    band = 'right'
    reach = rect.left + rect.width - x
  } else if (!rightHalf && at === 0 && x >= rect.left) {
    band = 'left'
    reach = x - rect.left
  }
  const edgeWidth = rect.width * PANE_DROP_EDGE
  const edge = band === 'right' ? reach <= edgeWidth : band === 'left' && reach < edgeWidth
  const bandHeight = rect.height * PANE_DROP_BAND
  const zone: PaneDropZone['zone'] = y < rect.top + bandHeight ? 'above' : y >= rect.top + rect.height - bandHeight ? 'below' : 'swap'
  const depth = zone === 'above' ? y - rect.top : rect.top + rect.height - y
  return {
    col: at,
    row: y < rect.top + rect.height * rowSplit ? 0 : 1,
    zone,
    band,
    edge,
    sideFirst: zone === 'swap' || reach * bandHeight <= depth * edgeWidth
  }
}

const gridOf = (tiles: readonly SplitSessionRef[]): SplitSessionRef[][] => splitColumns(tiles).map((column) => column.map((index) => tiles[index]))

const flatten = (grid: readonly SplitSessionRef[][]): SplitSessionRef[] =>
  grid.flatMap((column) => column.map((tile, row) => stackedBelow(tile, row === 1)))

const layoutSignature = (tiles: readonly SplitSessionRef[]): string =>
  tiles.map((tile) => `${tile.uid ?? tile.sessionId ?? tile.path ?? ''}${tile.below ? '_' : '|'}`).join('')

function locate(grid: readonly SplitSessionRef[][], tile: SplitSessionRef): [number, number] {
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col].indexOf(tile)
    if (row >= 0) return [col, row]
  }
  return [-1, -1]
}

export function applyPaneDrop(
  tiles: readonly SplitSessionRef[],
  from: number,
  target: PaneDropTarget,
  maxColumns: number = SPLIT_MAX_COLUMNS
): SplitSessionRef[] | null {
  const moving = tiles[from]
  if (!moving) return null
  const grid = gridOf(tiles)
  const [fromCol, fromRow] = locate(grid, moving)
  if (target.kind === 'swap') {
    const other = tiles[target.index]
    if (!other || other === moving) return null
    const [col, row] = locate(grid, other)
    grid[fromCol][fromRow] = other
    grid[col][row] = moving
  } else {
    if (target.kind === 'stack' && target.col === fromCol) return null
    grid[fromCol].splice(fromRow, 1)
    const emptied = grid[fromCol].length === 0
    if (emptied) grid.splice(fromCol, 1)
    const shift = (col: number): number => (emptied && fromCol < col ? col - 1 : col)
    if (target.kind === 'column') {
      grid.splice(Math.max(0, Math.min(shift(target.at), grid.length)), 0, [moving])
    } else {
      const column = grid[shift(target.col)]
      if (!column || column.length !== 1) return null
      if (target.row === 0) column.unshift(moving)
      else column.push(moving)
    }
  }
  if (grid.length > splitColumns(tiles).length && grid.length > maxColumns) return null
  const next = flatten(grid)
  return layoutSignature(next) === layoutSignature(tiles) ? null : next
}

export function paneDropTarget(
  tiles: readonly SplitSessionRef[],
  from: number,
  zone: PaneDropZone,
  maxColumns: number = SPLIT_MAX_COLUMNS
): PaneDropTarget | null {
  const columns = splitColumns(tiles)
  const column = columns[zone.col]
  if (!column) return null
  const fromCol = columns.findIndex((item) => item.includes(from))
  const outcome = (target: PaneDropTarget | null): string | null => {
    const next = target ? applyPaneDrop(tiles, from, target, maxColumns) : null
    return next ? layoutSignature(next) : null
  }
  const stackTarget: PaneDropTarget | null = (() => {
    if (fromCol === zone.col) return null
    if (zone.zone === 'swap') return column.length === 1 ? { kind: 'swap', index: column[0] } : null
    const row = zone.zone === 'above' ? 0 : 1
    if (column.length === 1) return { kind: 'stack', col: zone.col, row }
    const occupied = column[row]
    return occupied !== undefined ? { kind: 'swap', index: occupied } : null
  })()
  const cellIndex = column[zone.row]
  const cellTarget: PaneDropTarget | null =
    cellIndex !== undefined ? { kind: 'swap', index: cellIndex } : { kind: 'stack', col: zone.col, row: 1 }
  const bandTarget: PaneDropTarget | null =
    fromCol === zone.col
      ? null
      : zone.band === 'left'
        ? { kind: 'column', at: 0 }
        : zone.band === 'right'
          ? { kind: 'column', at: columns.length }
          : null
  const stack = outcome(stackTarget) ? stackTarget : null
  const cell = outcome(cellTarget) ? cellTarget : null
  const band = outcome(bandTarget) ? bandTarget : null
  const chosen = stack ?? cell
  if (!band || !chosen) return chosen ?? band
  if (!zone.edge || (chosen === stack && !zone.sideFirst) || outcome(band) === outcome(chosen)) return chosen
  return band
}

export function paneDropHint(tiles: readonly SplitSessionRef[], from: number, maxColumns: number = SPLIT_MAX_COLUMNS): PaneDropTarget | null {
  const columns = splitColumns(tiles)
  const candidates: PaneDropTarget[] = [
    { kind: 'swap', index: columns[0]?.[0] ?? 0 },
    { kind: 'column', at: columns.length },
    { kind: 'column', at: 0 }
  ]
  return candidates.find((target) => applyPaneDrop(tiles, from, target, maxColumns) !== null) ?? null
}

export function paneDropBox(target: PaneDropTarget, tiles: readonly SplitSessionRef[], geometry: DropGeometry): DropRect {
  const columns = splitColumns(tiles)
  const rects = columnRects(geometry, columns.length)
  if (target.kind === 'column') return newColumnBox(geometry.host, columns.length, target.at === 0 ? 'left' : 'right')
  if (target.kind === 'stack') return cellBox(rects[target.col] ?? geometry.host, target.row === 0 ? 'top' : 'bottom', geometry.rowSplit)
  const col = columns.findIndex((column) => column.includes(target.index))
  const column = columns[col] ?? []
  const part: CellPart = column.length > 1 ? (column[0] === target.index ? 'top' : 'bottom') : 'full'
  return cellBox(rects[col] ?? geometry.host, part, geometry.rowSplit)
}

export function paneDropBadge(
  target: PaneDropTarget | null,
  tiles: readonly SplitSessionRef[],
  from: number,
  geometry: DropGeometry,
  maxColumns: number = SPLIT_MAX_COLUMNS
): DropBadge | null {
  const shown = target ?? paneDropHint(tiles, from, maxColumns)
  if (!shown) return null
  return { box: paneDropBox(shown, tiles, geometry), label: shown.kind === 'swap' ? 'swap' : 'move', hint: target === null }
}

export function withHiddenTiles(all: readonly SplitSessionRef[], shown: readonly SplitSessionRef[], next: readonly SplitSessionRef[]): SplitSessionRef[] {
  const keys = new Set(shown.map(splitTileKey))
  const hidden = all.filter((tile) => !keys.has(splitTileKey(tile))).map((tile) => stackedBelow(tile, false))
  return normalizeSplitTiles([...next, ...hidden])
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
