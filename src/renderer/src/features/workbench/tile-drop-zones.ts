import {
  findStack,
  hasTile,
  insertTile,
  layoutKey,
  moveTile,
  nodeKey,
  parentOfTile,
  type TileDirection,
  type TileLayout,
  type TileNode,
  type TileStack,
  type TileTarget
} from './tile-tree'

export const EDGE_STRIP_PX = 24
export const DEAD_RADIUS_PX = 16

const FAR_PX = 1e4

export interface Box {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

export function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

export interface DropZone {
  kind: 'target' | 'rearrange'
  rect: Box
  target?: TileTarget
  stackId?: string
  direction?: TileDirection
  ownStrip?: boolean
}

export interface DropSnapshot {
  containerRect: Box
  nodeRects: Record<string, Box>
  startPointer: { x: number; y: number } | null
  zones: DropZone[]
}

export interface DropHit {
  liveLayout: TileLayout | null
  pendingLayout: TileLayout | null
  target: TileTarget | null
}

interface Point {
  x: number
  y: number
}

interface TileBox {
  tileId: string
  rect: Box
  parent: TileStack
  index: number
}

interface StackBox {
  stack: TileStack
  rect: Box
  childRects: Box[]
}

interface ZoneInput {
  layout: TileLayout
  gap: number
  sourceTileId: string
  sourceParent: TileStack | null
  nodeRects: Record<string, Box>
  stacks: StackBox[]
  tiles: TileBox[]
  pointer: Point | null
}

type Edge = 'top' | 'bottom' | 'left' | 'right'

const containsPoint = (point: Point, rect: Box): boolean =>
  point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom

const midline = (rect: Box, isRow: boolean): number => (isRow ? rect.left + rect.width / 2 : rect.top + rect.height / 2)

const sliceBox = (rect: Box, isRow: boolean, from: number, to: number): Box =>
  isRow ? box(from, rect.top, to - from, rect.height) : box(rect.left, from, rect.width, to - from)

const pairDepth = (extent: number): number => Math.max(EDGE_STRIP_PX, Math.floor(extent / 3))

function stripPair(rect: Box, direction: TileDirection, startDepth: number, endDepth: number): [Box, Box] {
  const isRow = direction === 'row'
  const extent = isRow ? rect.width : rect.height
  const origin = isRow ? rect.left : rect.top
  return [sliceBox(rect, isRow, origin, origin + startDepth), sliceBox(rect, isRow, origin + extent - endDepth, origin + extent)]
}

const edgeStripPair = (rect: Box, direction: TileDirection): [Box, Box] =>
  stripPair(rect, direction, EDGE_STRIP_PX, EDGE_STRIP_PX)

function pairStripPair(rect: Box, direction: TileDirection): [Box, Box] {
  const isRow = direction === 'row'
  const depth = pairDepth(isRow ? rect.width : rect.height)
  return stripPair(rect, direction, isRow ? depth : EDGE_STRIP_PX, depth)
}

function edgeBand(rootRect: Box, edge: Edge, depth: number): Box {
  switch (edge) {
    case 'top':
      return box(rootRect.left, rootRect.top - FAR_PX, rootRect.width, depth + FAR_PX)
    case 'bottom':
      return box(rootRect.left, rootRect.bottom - depth, rootRect.width, depth + FAR_PX)
    case 'left':
      return box(rootRect.left - FAR_PX, rootRect.top - FAR_PX, depth + FAR_PX, rootRect.height + FAR_PX * 2)
    default:
      return box(rootRect.right - depth, rootRect.top - FAR_PX, depth + FAR_PX, rootRect.height + FAR_PX * 2)
  }
}

function containerEdgeZones(input: ZoneInput, root: TileStack, rootRect: Box): DropZone[] {
  const isRow = root.direction === 'row'
  const edges: Array<{ edge: Edge; direction: TileDirection; index: number }> = [
    { edge: 'top', direction: 'column', index: 0 },
    { edge: 'bottom', direction: 'column', index: isRow ? 1 : root.children.length },
    { edge: 'left', direction: 'row', index: 0 },
    { edge: 'right', direction: 'row', index: isRow ? root.children.length : 1 }
  ]
  return edges.map(({ edge, direction, index }) => {
    const thin = input.pointer !== null && containsPoint(input.pointer, edgeBand(rootRect, edge, Math.max(input.gap, EDGE_STRIP_PX)))
    return {
      kind: 'target',
      rect: edgeBand(rootRect, edge, thin ? 0 : input.gap),
      target: { kind: 'split', stackId: root.id, direction, index }
    }
  })
}

function tileStripZones(input: ZoneInput): DropZone[] {
  const paired = input.sourceParent && input.sourceParent.children.length === 2 ? input.sourceParent : null
  const zones: DropZone[] = []
  for (const tile of input.tiles) {
    if (tile.tileId === input.sourceTileId) continue
    const direction: TileDirection = tile.parent.direction === 'row' ? 'column' : 'row'
    const sharesPair = paired !== null && tile.parent.id === paired.id
    const targetAt = (index: number): TileTarget =>
      sharesPair && paired
        ? { kind: 'split', stackId: paired.id, direction, index }
        : { kind: 'wrap', tileId: tile.tileId, direction, index }
    const strips = sharesPair ? pairStripPair(tile.rect, direction) : edgeStripPair(tile.rect, direction)
    strips.forEach((rect, index) => zones.push({ kind: 'target', rect, target: targetAt(index) }))
  }
  return zones
}

function ownStripZones(input: ZoneInput): DropZone[] {
  const parent = input.sourceParent
  const own = parent ? input.nodeRects[input.sourceTileId] : null
  if (!parent || !own) return []
  const direction: TileDirection = parent.direction === 'row' ? 'column' : 'row'
  const zones: DropZone[] = []
  pairStripPair(own, direction).forEach((rect, index) => {
    if (input.pointer && containsPoint(input.pointer, rect)) return
    zones.push({ kind: 'target', rect, target: { kind: 'split', stackId: parent.id, direction, index }, ownStrip: true })
  })
  return zones
}

function rearrangeZones(input: ZoneInput): DropZone[] {
  const parent = input.sourceParent
  const rect = parent ? input.nodeRects[parent.id] : null
  if (!parent || !rect || parent.children.length < 2) return []
  return [{ kind: 'rearrange', rect, stackId: parent.id, direction: parent.direction }]
}

function foreignInsertZones(input: ZoneInput): DropZone[] {
  const zones: DropZone[] = []
  for (const { stack, rect, childRects } of input.stacks) {
    if (input.sourceParent && stack.id === input.sourceParent.id) continue
    if (childRects.length === 0) continue
    const isRow = stack.direction === 'row'
    const bounds = [isRow ? rect.left : rect.top, ...childRects.map((child) => midline(child, isRow)), isRow ? rect.right : rect.bottom]
    for (let index = 0; index < bounds.length - 1; index += 1) {
      zones.push({
        kind: 'target',
        rect: sliceBox(rect, isRow, bounds[index], bounds[index + 1]),
        target: { kind: 'insert', stackId: stack.id, index }
      })
    }
  }
  return zones
}

function halfTileZones(input: ZoneInput): DropZone[] {
  const zones: DropZone[] = []
  for (const tile of input.tiles) {
    if (tile.tileId === input.sourceTileId) continue
    if (input.sourceParent && tile.parent.id === input.sourceParent.id) continue
    const isRow = tile.parent.direction === 'row'
    const rect = tile.rect
    const middle = midline(rect, isRow)
    const start = isRow ? rect.left : rect.top
    const end = isRow ? rect.right : rect.bottom
    zones.push({
      kind: 'target',
      rect: sliceBox(rect, isRow, start, middle),
      target: { kind: 'insert', stackId: tile.parent.id, index: tile.index }
    })
    zones.push({
      kind: 'target',
      rect: sliceBox(rect, isRow, middle, end),
      target: { kind: 'insert', stackId: tile.parent.id, index: tile.index + 1 }
    })
  }
  return zones
}

const applyTarget = (layout: TileLayout, tileId: string, target: TileTarget): TileLayout =>
  hasTile(layout, tileId) ? moveTile(layout, tileId, target) : insertTile(layout, tileId, target)

function visibleArea(rect: Box, within: Box): number {
  const width = Math.min(rect.right, within.right) - Math.max(rect.left, within.left)
  const height = Math.min(rect.bottom, within.bottom) - Math.max(rect.top, within.top)
  return Math.max(0, width) * Math.max(0, height)
}

function dedupeZones(zones: DropZone[], input: ZoneInput, root: TileStack, rootRect: Box): DropZone[] {
  const { layout, sourceTileId, sourceParent } = input
  const ignored = new Set<string>([layoutKey(layout)])
  if (sourceParent && sourceParent.children.length > 1) {
    sourceParent.children.forEach((_, index) => {
      ignored.add(layoutKey(applyTarget(layout, sourceTileId, { kind: 'insert', stackId: sourceParent.id, index })))
    })
  }
  const exempt = (zone: DropZone): boolean =>
    zone.ownStrip === true || (zone.target !== undefined && zone.target.kind === 'split' && zone.target.stackId === root.id)
  const keyed = zones.map((zone) => ({
    zone,
    key: zone.kind === 'rearrange' || !zone.target ? null : layoutKey(applyTarget(layout, sourceTileId, zone.target))
  }))
  const winners = new Map<string, DropZone>()
  for (const { zone, key } of keyed) {
    if (key === null || ignored.has(key) || exempt(zone)) continue
    const current = winners.get(key)
    if (!current || visibleArea(zone.rect, rootRect) > visibleArea(current.rect, rootRect)) winners.set(key, zone)
  }
  const kept: DropZone[] = []
  for (const { zone, key } of keyed) {
    if (key !== null && ignored.has(key)) continue
    if (key === null || exempt(zone) || winners.get(key) === zone) kept.push(zone)
  }
  return kept
}

function buildZones(input: ZoneInput): DropZone[] {
  const root = input.layout.root
  const rootRect = input.nodeRects[root.id]
  if (!rootRect) return []
  return dedupeZones(
    [
      ...containerEdgeZones(input, root, rootRect),
      ...tileStripZones(input),
      ...ownStripZones(input),
      ...rearrangeZones(input),
      ...foreignInsertZones(input),
      ...halfTileZones(input)
    ],
    input,
    root,
    rootRect
  )
}

export function createDropSnapshot(input: {
  layout: TileLayout
  containerRect: Box
  measure: (key: string) => Box | null
  sourceTileId: string
  startPointer?: { x: number; y: number } | null
  offset?: { x: number; y: number }
  gap: number
}): DropSnapshot | null {
  const { layout, containerRect, measure, sourceTileId, gap } = input
  const offset = input.offset ?? { x: 0, y: 0 }
  const startPointer = input.startPointer ?? null
  const toLocal = (source: Box): Box =>
    box(source.left - containerRect.left, source.top - containerRect.top, source.width, source.height)
  const lifted = (key: string, rect: Box): Box =>
    key === sourceTileId && (offset.x !== 0 || offset.y !== 0)
      ? box(rect.left - offset.x, rect.top - offset.y, rect.width, rect.height)
      : rect
  const nodeRects: Record<string, Box> = {}
  const stacks: StackBox[] = []
  const tiles: TileBox[] = []
  const record = (node: TileNode, parent: TileStack | null, index: number): boolean => {
    const measured = measure(nodeKey(node))
    if (!measured) return false
    const rect = lifted(nodeKey(node), toLocal(measured))
    nodeRects[nodeKey(node)] = rect
    if (node.kind === 'tile') {
      if (parent) tiles.push({ tileId: node.tileId, rect, parent, index })
      return true
    }
    const childRects: Box[] = []
    node.children.forEach((child, childIndex) => {
      if (record(child, node, childIndex)) childRects.push(nodeRects[nodeKey(child)])
    })
    stacks.push({ stack: node, rect, childRects })
    return true
  }
  record(layout.root, null, 0)
  const sourceParent = parentOfTile(layout, sourceTileId)
  if (hasTile(layout, sourceTileId) && (!sourceParent || !nodeRects[sourceTileId])) return null
  const pointer = startPointer
    ? { x: startPointer.x - containerRect.left, y: startPointer.y - containerRect.top }
    : null
  const zones = buildZones({ layout, gap, sourceTileId, sourceParent, nodeRects, stacks, tiles, pointer })
  return { containerRect, nodeRects, startPointer: pointer, zones }
}

function reorderSlot(
  stack: TileStack,
  from: number,
  nodeRects: Record<string, Box>,
  coordinate: number,
  isRow: boolean
): number {
  let to = from
  stack.children.forEach((child, index) => {
    if (index === from) return
    const rect = nodeRects[nodeKey(child)]
    if (!rect) return
    const middle = midline(rect, isRow)
    if (index < from && coordinate < middle) to = Math.min(to, index)
    else if (index > from && coordinate > middle) to = Math.max(to, index)
  })
  return to
}

export function hitTestDrop(
  layout: TileLayout,
  snapshot: DropSnapshot,
  tileId: string,
  pointer: { x: number; y: number }
): DropHit {
  const empty: DropHit = { liveLayout: null, pendingLayout: null, target: null }
  const point = { x: pointer.x - snapshot.containerRect.left, y: pointer.y - snapshot.containerRect.top }
  const origin = snapshot.startPointer
  if (origin && Math.hypot(point.x - origin.x, point.y - origin.y) < DEAD_RADIUS_PX) return empty
  const zone = snapshot.zones.find((candidate) => containsPoint(point, candidate.rect))
  if (!zone) return empty
  if (zone.kind !== 'rearrange') {
    if (!zone.target) return empty
    return { liveLayout: null, pendingLayout: applyTarget(layout, tileId, zone.target), target: zone.target }
  }
  const stack = zone.stackId ? findStack(layout, zone.stackId) : null
  const from = stack ? stack.children.findIndex((child) => child.kind === 'tile' && child.tileId === tileId) : -1
  if (!stack || from < 0) return empty
  const isRow = zone.direction === 'row'
  const to = reorderSlot(stack, from, snapshot.nodeRects, isRow ? point.x : point.y, isRow)
  if (to !== from) {
    return {
      liveLayout: moveTile(layout, tileId, { kind: 'insert', stackId: stack.id, index: to }),
      pendingLayout: null,
      target: null
    }
  }
  const own = snapshot.nodeRects[tileId]
  if (own && containsPoint(point, own)) return empty
  const beneath = snapshot.zones.find(
    (candidate) => candidate.kind !== 'rearrange' && candidate.target !== undefined && containsPoint(point, candidate.rect)
  )
  return beneath && beneath.target
    ? { liveLayout: null, pendingLayout: applyTarget(layout, tileId, beneath.target), target: beneath.target }
    : empty
}
