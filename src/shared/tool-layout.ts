export type ToolPlacement = 'docked' | 'floating' | 'library'

export const TILE_DEFAULT_W = 300
export const TILE_MIN_W = 240
export const TILE_MAX_W = 420
export const TILE_HEAD_H = 32

export const NON_FLOATING_TILE_IDS: readonly string[] = []

export function isTileFloatable(id: string): boolean {
  return !NON_FLOATING_TILE_IDS.includes(id)
}

export function defaultFloatRect(floatingCount: number, areaW: number, areaH: number): ToolRect {
  const target = Math.min(TILE_MAX_W, Math.max(TILE_MIN_W, TILE_DEFAULT_W))
  const w = Math.min(0.95, target / Math.max(areaW, target))
  const h = Math.min(0.6, 320 / Math.max(areaH, 320))
  const step = 0.05
  const n = Math.max(0, Math.round(floatingCount))
  return {
    x: Math.min(0.06 + n * step, Math.max(0, 1 - w)),
    y: Math.min(0.1 + n * step, Math.max(0, 1 - h)),
    w,
    h
  }
}

export interface ToolRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ToolTile {
  id: string
  placement: ToolPlacement
  order: number
  rect?: ToolRect
  collapsed?: boolean
}

export interface ToolLayout {
  version: 2
  tiles: ToolTile[]
  revision: number
}

const PLACEMENTS: readonly ToolPlacement[] = ['docked', 'floating', 'library']

function isPlacement(value: unknown): value is ToolPlacement {
  return typeof value === 'string' && (PLACEMENTS as readonly string[]).includes(value)
}

export function defaultToolLayout(ids: readonly string[]): ToolLayout {
  return { version: 2, revision: 0, tiles: ids.map((id, index) => ({ id, placement: 'docked', order: index })) }
}

export function migrateToolLayout(
  order: readonly string[] | undefined,
  hidden: readonly string[] | undefined,
  ids: readonly string[]
): ToolLayout {
  const known = new Set(ids)
  const hiddenSet = new Set((hidden ?? []).filter((id) => known.has(id)))
  const ordered = (order ?? []).filter((id) => known.has(id) && !hiddenSet.has(id))
  const seen = new Set<string>()
  const tiles: ToolTile[] = []
  for (const id of ordered) {
    if (seen.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  for (const id of ids) {
    if (seen.has(id) || hiddenSet.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  for (const id of ids) {
    if (!hiddenSet.has(id) || seen.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  return { version: 2, revision: 0, tiles }
}

function clamp01(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null
}

function sanitizeRect(value: unknown): ToolRect | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Partial<ToolRect>
  const x = clamp01(r.x)
  const y = clamp01(r.y)
  const w = clamp01(r.w)
  const h = clamp01(r.h)
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return undefined
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h }
}

function sanitizeOrder(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback
}

export function normalizeToolLayout(value: unknown, ids: readonly string[]): ToolLayout {
  const known = new Set(ids)
  if (!value || typeof value !== 'object') return defaultToolLayout(ids)
  const input = value as Record<string, unknown>
  const version = typeof input.version === 'number' && Number.isInteger(input.version) ? input.version : 1
  if (version < 1 || version > 2) return defaultToolLayout(ids)
  const rawTiles = Array.isArray(input.tiles) ? input.tiles : []
  const seen = new Set<string>()
  const tiles: ToolTile[] = []
  for (const raw of rawTiles) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<ToolTile>
    if (typeof item.id !== 'string' || !known.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    const rawPlacement: ToolPlacement = isPlacement(item.placement) ? item.placement : 'docked'
    const migrated: ToolPlacement = rawPlacement === 'library' ? 'docked' : rawPlacement
    const placement: ToolPlacement = migrated === 'floating' && !isTileFloatable(item.id) ? 'docked' : migrated
    const rect = placement === 'floating' ? sanitizeRect(item.rect) : undefined
    tiles.push({
      id: item.id,
      placement: rect ? 'floating' : placement === 'floating' ? 'docked' : placement,
      order: sanitizeOrder(item.order, tiles.length),
      ...(rect ? { rect } : {}),
      ...(item.collapsed === true ? { collapsed: true } : {})
    })
  }
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    tiles.push({ id, placement: 'docked', order: tiles.length })
  }
  tiles.sort((a, b) => a.order - b.order)
  tiles.forEach((tile, index) => { tile.order = index })
  const revision = typeof input.revision === 'number' && Number.isFinite(input.revision) ? Math.max(0, Math.round(input.revision)) : 0
  return { version: 2, tiles, revision }
}

export function setTilePlacement(
  layout: ToolLayout,
  id: string,
  placement: ToolPlacement,
  rect?: ToolRect
): ToolLayout {
  const want: ToolPlacement = placement === 'floating' && !isTileFloatable(id) ? 'docked' : placement
  const tiles = layout.tiles.map((tile) => {
    if (tile.id !== id) return tile
    const safe = want === 'floating' ? sanitizeRect(rect) : undefined
    const next: ToolTile = { id, placement: safe ? 'floating' : want === 'floating' ? 'docked' : want, order: tile.order }
    if (safe) next.rect = safe
    if (tile.collapsed) next.collapsed = true
    return next
  })
  return { ...layout, tiles, revision: layout.revision + 1 }
}

export function setTileCollapsed(layout: ToolLayout, id: string, collapsed: boolean): ToolLayout {
  const tiles = layout.tiles.map((tile) => {
    if (tile.id !== id) return tile
    const next: ToolTile = { id: tile.id, placement: tile.placement, order: tile.order }
    if (tile.rect) next.rect = tile.rect
    if (collapsed) next.collapsed = true
    return next
  })
  return { ...layout, tiles, revision: layout.revision + 1 }
}

export function moveTileToIndex(layout: ToolLayout, id: string, index: number): ToolLayout {
  const docked = layout.tiles.filter((tile) => tile.placement === 'docked').sort((a, b) => a.order - b.order)
  const from = docked.findIndex((tile) => tile.id === id)
  if (from < 0) return layout
  const [picked] = docked.splice(from, 1)
  const at = Math.min(Math.max(0, Math.round(index)), docked.length)
  docked.splice(at, 0, picked)
  const rest = layout.tiles.filter((tile) => tile.placement !== 'docked').sort((a, b) => a.order - b.order)
  const tiles = [...docked, ...rest].map((tile, i) => ({ ...tile, order: i }))
  return { ...layout, tiles, revision: layout.revision + 1 }
}

export function dockedTileIds(layout: ToolLayout): string[] {
  return layout.tiles.filter((tile) => tile.placement === 'docked').sort((a, b) => a.order - b.order).map((t) => t.id)
}

export function moveTile(layout: ToolLayout, id: string, targetId: string, after: boolean): ToolLayout {
  if (id === targetId) return layout
  const ordered = layout.tiles.map((tile) => ({ ...tile })).sort((a, b) => a.order - b.order)
  const from = ordered.findIndex((tile) => tile.id === id)
  const to = ordered.findIndex((tile) => tile.id === targetId)
  if (from < 0 || to < 0) return layout
  const [picked] = ordered.splice(from, 1)
  const at = ordered.findIndex((tile) => tile.id === targetId)
  ordered.splice(after ? at + 1 : at, 0, picked)
  ordered.forEach((tile, index) => { tile.order = index })
  return { ...layout, tiles: ordered, revision: layout.revision + 1 }
}

export function clampRectToBounds(rect: ToolRect): ToolRect {
  const w = Math.min(rect.w, 1)
  const h = Math.min(rect.h, 1)
  const x = Math.min(Math.max(0, rect.x), Math.max(0, 1 - w))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, 1 - h))
  return { x, y, w, h }
}

export function isStaleLayoutWrite(incomingRevision: number, currentRevision: number): boolean {
  return incomingRevision < currentRevision
}

export function commitTileLayout(
  current: ToolLayout,
  incoming: ToolLayout
): { layout: ToolLayout; applied: boolean } {
  if (incoming.revision > current.revision) return { layout: incoming, applied: true }
  return { layout: current, applied: false }
}

export interface FloatArea {
  left: number
  top: number
  width: number
  height: number
}

export interface FloatPxRect {
  left: number
  top: number
  width: number
  height: number
}

export function clampFloatPixels(rect: FloatPxRect, area: FloatArea): FloatPxRect {
  const width = Math.min(rect.width, Math.max(0, area.width))
  const height = Math.min(rect.height, Math.max(0, area.height))
  const left = Math.min(Math.max(area.left, rect.left), area.left + Math.max(0, area.width - width))
  const top = Math.min(Math.max(area.top, rect.top), area.top + Math.max(0, area.height - height))
  return { left, top, width, height }
}

function intersects(a: FloatPxRect, b: FloatArea): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top
}

export function avoidFloatObstacle(
  rect: FloatPxRect,
  area: FloatArea,
  obstacle: FloatArea | null
): FloatPxRect | null {
  if (!obstacle) return clampFloatPixels(rect, area)
  const base = clampFloatPixels(rect, area)
  if (!intersects(base, obstacle)) return base
  const leftSide: FloatPxRect = { ...base, left: obstacle.left - base.width }
  const leftFit = clampFloatPixels(leftSide, area)
  if (!intersects(leftFit, obstacle) && leftFit.left + leftFit.width <= obstacle.left) return leftFit
  const rightSide: FloatPxRect = { ...base, left: obstacle.left + obstacle.width }
  const rightFit = clampFloatPixels(rightSide, area)
  if (!intersects(rightFit, obstacle) && rightFit.left >= obstacle.left + obstacle.width) return rightFit
  const upSide: FloatPxRect = { ...base, top: obstacle.top - base.height }
  const upFit = clampFloatPixels(upSide, area)
  if (!intersects(upFit, obstacle) && upFit.top + upFit.height <= obstacle.top) return upFit
  const downSide: FloatPxRect = { ...base, top: obstacle.top + obstacle.height }
  const downFit = clampFloatPixels(downSide, area)
  if (!intersects(downFit, obstacle) && downFit.top >= obstacle.top + obstacle.height) return downFit
  return null
}

export function pxRectToNormalized(rect: FloatPxRect, area: FloatArea): ToolRect {
  const aw = Math.max(1, area.width)
  const ah = Math.max(1, area.height)
  const w = clamp01(rect.width / aw) ?? 0.3
  const h = clamp01(rect.height / ah) ?? 0.4
  const x = clamp01((rect.left - area.left) / aw) ?? 0
  const y = clamp01((rect.top - area.top) / ah) ?? 0
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h }
}

export const SNAP_THRESHOLD = 4

export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
  kind: 'area' | 'center' | 'tile'
}

export interface SnapResult {
  rect: FloatPxRect
  guides: SnapGuide[]
}

interface SnapCandidate {
  at: number
  offset: number
  kind: SnapGuide['kind']
}

function nearestCandidate(
  candidates: readonly SnapCandidate[],
  pos: number,
  threshold: number
): { want: number; at: number; kind: SnapGuide['kind'] } | null {
  let best: { want: number; at: number; kind: SnapGuide['kind']; d: number } | null = null
  for (const c of candidates) {
    const want = c.at - c.offset
    const d = Math.abs(want - pos)
    if (d > threshold) continue
    if (!best || d < best.d) best = { want, at: c.at, kind: c.kind, d }
  }
  return best ? { want: best.want, at: best.at, kind: best.kind } : null
}

export function snapFloatRect(
  rect: FloatPxRect,
  area: FloatArea,
  others: readonly FloatPxRect[] = [],
  threshold = SNAP_THRESHOLD
): SnapResult {
  const areaRight = area.left + area.width
  const areaBottom = area.top + area.height
  const xs: SnapCandidate[] = [
    { at: area.left, offset: 0, kind: 'area' },
    { at: areaRight, offset: rect.width, kind: 'area' },
    { at: area.left + area.width / 2, offset: rect.width / 2, kind: 'center' }
  ]
  const ys: SnapCandidate[] = [
    { at: area.top, offset: 0, kind: 'area' },
    { at: areaBottom, offset: rect.height, kind: 'area' },
    { at: area.top + area.height / 2, offset: rect.height / 2, kind: 'center' }
  ]
  for (const o of others) {
    xs.push({ at: o.left, offset: 0, kind: 'tile' })
    xs.push({ at: o.left + o.width, offset: 0, kind: 'tile' })
    xs.push({ at: o.left, offset: rect.width, kind: 'tile' })
    xs.push({ at: o.left + o.width, offset: rect.width, kind: 'tile' })
    ys.push({ at: o.top, offset: 0, kind: 'tile' })
    ys.push({ at: o.top + o.height, offset: 0, kind: 'tile' })
    ys.push({ at: o.top, offset: rect.height, kind: 'tile' })
    ys.push({ at: o.top + o.height, offset: rect.height, kind: 'tile' })
  }

  const bx = nearestCandidate(xs, rect.left, threshold)
  const by = nearestCandidate(ys, rect.top, threshold)
  const guides: SnapGuide[] = []
  if (bx) guides.push({ axis: 'x', at: bx.at, kind: bx.kind })
  if (by) guides.push({ axis: 'y', at: by.at, kind: by.kind })
  return {
    rect: { ...rect, left: bx ? bx.want : rect.left, top: by ? by.want : rect.top },
    guides
  }
}
