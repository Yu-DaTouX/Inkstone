export type TileDirection = 'row' | 'column'

export interface TileLeaf {
  kind: 'tile'
  tileId: string
  flex: number
}

export interface TileStack {
  kind: 'stack'
  id: string
  direction: TileDirection
  flex: number
  children: TileNode[]
}

export type TileNode = TileLeaf | TileStack

export interface TileLayout {
  root: TileStack
}

export type TileTarget =
  | { kind: 'insert'; stackId: string; index: number }
  | { kind: 'split'; stackId: string; direction: TileDirection; index: number }
  | { kind: 'wrap'; tileId: string; direction: TileDirection; index: number }

export const TILE_GAP = 8
export const TILE_MIN_PX = 120

interface Slot {
  stack: TileStack
  index: number
}

interface Found {
  node: TileNode
  trail: Slot[]
}

interface Origin {
  stackId: string
  index: number
}

let stackSerial = 0
const stackSalt = Math.floor(Math.random() * 0x7fffffff).toString(36)

const clampNumber = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const isDirection = (value: unknown): value is TileDirection => value === 'row' || value === 'column'

const isTileNode = (node: TileNode): node is TileLeaf => node.kind === 'tile'

const isStackNode = (node: TileNode): node is TileStack => node.kind === 'stack'

const withFlex = <T extends TileNode>(node: T, flex: number): T => ({ ...node, flex })

const withChildren = (stack: TileStack, children: TileNode[]): TileStack => ({ ...stack, children })

export function nextStackId(): string {
  stackSerial += 1
  return `stack-${stackSalt}-${stackSerial.toString(36)}`
}

export function tileLeaf(tileId: string, flex = 1): TileLeaf {
  return { kind: 'tile', tileId, flex }
}

export function tileStack(direction: TileDirection, children: TileNode[], flex = 1, id = nextStackId()): TileStack {
  return { kind: 'stack', id, direction, flex, children }
}

export function nodeKey(node: TileNode): string {
  return isTileNode(node) ? node.tileId : node.id
}

function locate(node: TileNode, match: (candidate: TileNode) => boolean, trail: Slot[] = []): Found | null {
  if (match(node)) return { node, trail }
  if (isTileNode(node)) return null
  for (let index = 0; index < node.children.length; index += 1) {
    const found = locate(node.children[index], match, [...trail, { stack: node, index }])
    if (found) return found
  }
  return null
}

const locateTile = (root: TileStack, tileId: string): Found | null =>
  locate(root, (node) => isTileNode(node) && node.tileId === tileId)

const locateStack = (root: TileStack, stackId: string): Found | null =>
  locate(root, (node) => isStackNode(node) && node.id === stackId)

function spliceInto(slot: Slot, child: TileNode): TileStack {
  const children = [...slot.stack.children]
  children[slot.index] = child
  return withChildren(slot.stack, children)
}

function dropFrom(slot: Slot): TileStack {
  const children = [...slot.stack.children]
  children.splice(slot.index, 1)
  return withChildren(slot.stack, children)
}

function replaceStackAt(trail: Slot[], stack: TileStack): TileStack {
  let next = stack
  for (let depth = trail.length - 1; depth >= 0; depth -= 1) next = spliceInto(trail[depth], next)
  return next
}

function removeAt(trail: Slot[]): TileStack {
  const last = trail[trail.length - 1]
  let next = dropFrom(last)
  for (let depth = trail.length - 2; depth >= 0; depth -= 1) next = spliceInto(trail[depth], next)
  return next
}

function normalizeNode(node: TileNode): TileNode {
  if (isTileNode(node)) return node
  const children: TileNode[] = []
  for (const child of node.children) {
    const clean = normalizeNode(child)
    if (!isStackNode(clean)) {
      children.push(clean)
      continue
    }
    if (clean.children.length === 0) continue
    if (clean.direction === node.direction) {
      children.push(...clean.children)
      continue
    }
    children.push(clean)
  }
  return children.length === 1 ? withFlex(children[0], node.flex) : withChildren(node, children)
}

function rootOf(node: TileNode): TileStack {
  return isStackNode(node) ? node : tileStack('column', [node])
}

export function normalizeLayout(layout: TileLayout): TileLayout {
  return { root: rootOf(normalizeNode(layout.root)) }
}

export function columnLayout(tileIds: readonly string[]): TileLayout {
  return normalizeLayout({ root: tileStack('column', tileIds.map((tileId) => tileLeaf(tileId))) })
}

function collectTiles(node: TileNode, into: string[]): string[] {
  if (isTileNode(node)) into.push(node.tileId)
  else for (const child of node.children) collectTiles(child, into)
  return into
}

export function orderedTileIds(layout: TileLayout): string[] {
  return collectTiles(layout.root, [])
}

export function hasTile(layout: TileLayout, tileId: string): boolean {
  return locateTile(layout.root, tileId) !== null
}

export function findStack(layout: TileLayout, stackId: string): TileStack | null {
  const hit = locateStack(layout.root, stackId)
  return hit && isStackNode(hit.node) ? hit.node : null
}

export function parentOfTile(layout: TileLayout, tileId: string): TileStack | null {
  const hit = locateTile(layout.root, tileId)
  if (!hit || hit.trail.length === 0) return null
  return hit.trail[hit.trail.length - 1].stack
}

export function tilePath(layout: TileLayout, tileId: string): number[] | null {
  const hit = locateTile(layout.root, tileId)
  return hit ? hit.trail.map((slot) => slot.index) : null
}

function structureKey(node: TileNode): string {
  if (isTileNode(node)) return `tile#${node.tileId}`
  return `${node.direction}(${node.children.map(structureKey).join('|')})`
}

export function layoutKey(layout: TileLayout): string {
  return structureKey(layout.root)
}

export function layoutsEqual(a: TileLayout, b: TileLayout, compareFlex = true): boolean {
  const same = (left: TileNode, right: TileNode): boolean => {
    if (left.kind !== right.kind) return false
    if (compareFlex && left.flex !== right.flex) return false
    if (left.kind === 'tile') return right.kind === 'tile' && left.tileId === right.tileId
    if (right.kind !== 'stack') return false
    if (left.direction !== right.direction || left.children.length !== right.children.length) return false
    return left.children.every((child, index) => same(child, right.children[index]))
  }
  return same(a.root, b.root)
}

export function appendTile(layout: TileLayout, tileId: string): TileLayout {
  const root = layout.root
  const column = root.direction === 'column' ? root : tileStack('column', [withFlex(root, 1)])
  return normalizeLayout({ root: withChildren(column, [...column.children, tileLeaf(tileId)]) })
}

export function removeTile(layout: TileLayout, tileId: string): TileLayout {
  const hit = locateTile(layout.root, tileId)
  if (!hit || hit.trail.length === 0) return layout
  return normalizeLayout({ root: removeAt(hit.trail) })
}

function placeTile(root: TileStack, tile: TileLeaf, target: TileTarget, origin: Origin | null): TileStack | null {
  if (target.kind === 'wrap') {
    const hit = locateTile(root, target.tileId)
    if (!hit || hit.trail.length === 0 || !isTileNode(hit.node)) return null
    const anchor = hit.node
    const pair = target.index === 0 ? [tile, withFlex(anchor, 1)] : [withFlex(anchor, 1), tile]
    return replaceStackAt(hit.trail, tileStack(target.direction, pair, anchor.flex))
  }
  const hit = locateStack(root, target.stackId)
  if (!hit || !isStackNode(hit.node)) return null
  const stack = hit.node
  if (target.kind === 'split' && target.direction !== stack.direction) {
    const pair = target.index === 0 ? [tile, withFlex(stack, 1)] : [withFlex(stack, 1), tile]
    return replaceStackAt(hit.trail, tileStack(target.direction, pair, stack.flex))
  }
  let index = target.index
  if (origin && origin.stackId === stack.id && index > origin.index) index -= 1
  const children = [...stack.children]
  children.splice(clampNumber(index, 0, children.length), 0, tile)
  return replaceStackAt(hit.trail, withChildren(stack, children))
}

export function moveTile(layout: TileLayout, tileId: string, target: TileTarget): TileLayout {
  const hit = locateTile(layout.root, tileId)
  if (!hit || hit.trail.length === 0 || !isTileNode(hit.node)) return layout
  const moving = hit.node
  const owner = hit.trail[hit.trail.length - 1]
  if (target.kind === 'insert' && target.stackId === owner.stack.id) {
    const siblings = owner.stack.children.filter((_, index) => index !== owner.index)
    siblings.splice(clampNumber(target.index, 0, siblings.length), 0, moving)
    return normalizeLayout({ root: replaceStackAt(hit.trail.slice(0, -1), withChildren(owner.stack, siblings)) })
  }
  const detached = removeAt(hit.trail)
  const carried = tileLeaf(tileId, target.kind === 'insert' ? moving.flex : 1)
  const placed = placeTile(detached, carried, target, { stackId: owner.stack.id, index: owner.index })
  return placed ? normalizeLayout({ root: placed }) : layout
}

export function insertTile(layout: TileLayout, tileId: string, target: TileTarget): TileLayout {
  if (hasTile(layout, tileId)) return layout
  const placed = placeTile(layout.root, tileLeaf(tileId), target, null)
  return placed ? normalizeLayout({ root: placed }) : layout
}

export function withStackFlexes(layout: TileLayout, stackId: string, flexes: number[]): TileLayout {
  const hit = locateStack(layout.root, stackId)
  if (!hit || !isStackNode(hit.node)) return layout
  const stack = hit.node
  const children = stack.children.map((child, index) => {
    const flex = flexes[index]
    return Number.isFinite(flex) && flex > 0 ? withFlex(child, flex) : child
  })
  return normalizeLayout({ root: replaceStackAt(hit.trail, withChildren(stack, children)) })
}

export function adjustFlexes(flexes: number[], index: number, deltaPx: number, pxPerFlex: number, minPx: number): number[] {
  const next = [...flexes]
  if (!(pxPerFlex > 0)) return next
  if (index < 0 || index + 1 >= next.length) return next
  const floor = minPx / pxPerFlex
  const shared = next[index] + next[index + 1]
  if (floor * 2 > shared) return next
  next[index] = clampNumber(next[index] + deltaPx / pxPerFlex, floor, shared - floor)
  next[index + 1] = shared - next[index]
  return next
}

export function sanitizeLayout(value: unknown, allowed?: ReadonlySet<string>): TileLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const seen = new Set<string>()
  const flexOf = (raw: unknown): number => {
    const flex = Number(raw)
    return Number.isFinite(flex) && flex > 0 ? flex : 1
  }
  const walk = (raw: unknown): TileNode | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as { kind?: unknown; tileId?: unknown; direction?: unknown; children?: unknown; id?: unknown; flex?: unknown }
    if (record.kind === 'tile') {
      const tileId = record.tileId
      if (typeof tileId !== 'string' || seen.has(tileId)) return null
      if (allowed && !allowed.has(tileId)) return null
      seen.add(tileId)
      return tileLeaf(tileId, flexOf(record.flex))
    }
    if (record.kind !== 'stack' || !isDirection(record.direction) || !Array.isArray(record.children)) return null
    const id = typeof record.id === 'string' && record.id ? record.id : nextStackId()
    const children = record.children.map(walk).filter((child): child is TileNode => child !== null)
    return tileStack(record.direction, children, flexOf(record.flex), id)
  }
  const root = walk((value as { root?: unknown }).root)
  if (!root) return null
  const layout = normalizeLayout({ root: rootOf(root) })
  return orderedTileIds(layout).length > 0 ? layout : null
}
