import {
  CHAT_TILE_ID,
  TILE_GAP,
  TILE_MIN_HEIGHT_PX,
  TILE_MIN_WIDTH_PX,
  nodeKey,
  parentOfTile,
  tileMinPxOf,
  withStackFlexes,
  type TileLayout,
  type TileNode,
  type TileStack
} from './tile-tree'

export const PANE_LANE_INSET_PX = 16

export interface FitOptions {
  gap?: number
  minOf?: (tileId: string, direction: 'row' | 'column') => number
  laneInset?: (node: TileNode) => number
}

interface ResolvedOptions {
  gap: number
  minOf: (tileId: string, direction: 'row' | 'column') => number
  laneInset: (node: TileNode) => number
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

const scaleTo = (values: readonly number[], total: number): number[] => {
  const current = sum(values) || 1
  return values.map((value) => (value / current) * total)
}

const defaultLaneInset = (node: TileNode): number =>
  node.kind === 'tile' && node.tileId === CHAT_TILE_ID ? 0 : PANE_LANE_INSET_PX

const resolveOptions = (options: FitOptions): ResolvedOptions => ({
  gap: options.gap ?? TILE_GAP,
  minOf: options.minOf ?? tileMinPxOf,
  laneInset: options.laneInset ?? defaultLaneInset
})

export function distributeFlex(flexes: readonly number[], mins: readonly number[], total: number): number[] {
  const count = flexes.length
  if (count === 0 || total <= 0) return [...flexes]
  const pinned = new Set<number>()
  let sizes = scaleTo(flexes, total)
  for (;;) {
    const short = sizes.findIndex((size, index) => !pinned.has(index) && size < mins[index] - 0.5)
    if (short === -1) break
    pinned.add(short)
    const reserved = sum([...pinned].map((index) => mins[index]))
    const freeWeight = sum(flexes.filter((_, index) => !pinned.has(index)))
    const budget = total - reserved
    if (freeWeight <= 0 || budget <= 0) {
      sizes = scaleTo(mins, total)
      break
    }
    sizes = flexes.map((flex, index) => (pinned.has(index) ? mins[index] : (flex / freeWeight) * budget))
  }
  return scaleTo(sizes, count)
}

export function splitPixels(weights: readonly number[], usable: number): number[] {
  const total = sum(weights) || 1
  let running = 0
  let previousEdge = 0
  return weights.map((weight) => {
    running += weight
    const edge = Math.round((running / total) * usable)
    const size = edge - previousEdge
    previousEdge = edge
    return size
  })
}

export function minSize(node: TileNode, direction: 'row' | 'column', options: FitOptions = {}): number {
  const { gap, minOf } = resolveOptions(options)
  const base = direction === 'row' ? TILE_MIN_WIDTH_PX : TILE_MIN_HEIGHT_PX
  if (node.kind === 'tile') return direction === 'row' ? minOf(node.tileId, 'row') : TILE_MIN_HEIGHT_PX
  const parts = node.children.map((child) => minSize(child, direction, { gap, minOf }))
  if (node.direction !== direction) return Math.max(base, ...parts)
  return sum(parts) + gap * Math.max(0, node.children.length - 1)
}

function fitStack(stack: TileStack, width: number, root: boolean, options: ResolvedOptions): TileNode {
  const { gap } = options
  const row = stack.direction === 'row'
  if (!row || width <= 0) {
    const children = stack.children.map((child) =>
      child.kind === 'stack' ? fitStack(child, width, false, options) : child
    )
    return children.every((child, index) => child === stack.children[index]) ? stack : { ...stack, children }
  }
  const insets = stack.children.map((child) => (root ? options.laneInset(child) : 0))
  const budget = Math.max(0, width - gap * Math.max(0, stack.children.length - 1) - sum(insets))
  const flexes = stack.children.map((child) => child.flex)
  const pure = scaleTo(flexes, flexes.length)
  const lifted =
    stack.children.length > 1 && budget > 0
      ? distributeFlex(
          flexes,
          stack.children.map((child) => minSize(child, 'row', options)),
          budget
        )
      : pure
  const changed = lifted.some((flex, index) => Math.abs(flex - pure[index]) > 1e-6)
  const weights = changed ? lifted : flexes
  const shares = splitPixels(weights, budget)
  const children = stack.children.map((child, index) => ({ ...child, flex: changed ? lifted[index] : child.flex }))
  const next = children.map((child, index) =>
    child.kind === 'stack' ? fitStack(child, shares[index], false, options) : child
  )
  if (!changed && next.every((child, index) => child === stack.children[index])) return stack
  return { ...stack, children: next }
}

export function fitOpenedLayout(layout: TileLayout, width: number, options: FitOptions = {}): TileLayout {
  if (!(width > 0) || layout.root.direction !== 'row') return layout
  const root = fitStack(layout.root, width, true, resolveOptions(options))
  return root === layout.root ? layout : { root: root as TileStack }
}

export function measureWidths(layout: TileLayout, width: number, options: FitOptions = {}): Map<string, number> {
  const opts = resolveOptions(options)
  const out = new Map<string, number>()
  const walk = (node: TileNode, extent: number, root: boolean): void => {
    if (node.kind !== 'stack') {
      out.set(nodeKey(node), extent)
      return
    }
    const row = node.direction === 'row'
    const insets = node.children.map((child) => (row && root ? opts.laneInset(child) : 0))
    const budget = Math.max(0, extent - (row ? opts.gap * Math.max(0, node.children.length - 1) : 0) - sum(insets))
    const pixels = row ? splitPixels(node.children.map((child) => child.flex), budget) : node.children.map(() => extent)
    out.set(nodeKey(node), extent)
    node.children.forEach((child, index) => {
      if (row) walk(child, pixels[index] + insets[index], false)
      else walk(child, pixels[index], false)
    })
  }
  walk(layout.root, width, true)
  return out
}

export function withChatMinimum(layout: TileLayout, width: number, options: FitOptions = {}): TileLayout {
  const opts = resolveOptions(options)
  const { gap } = opts
  if (!(width > 0)) return layout
  const parent = parentOfTile(layout, CHAT_TILE_ID)
  if (!parent || parent.direction !== 'row' || parent.children.length < 2) return layout
  const chatIndex = parent.children.findIndex((child) => child.kind === 'tile' && child.tileId === CHAT_TILE_ID)
  if (chatIndex < 0) return layout
  const root = parent.id === layout.root.id
  const widths = measureWidths(layout, width, options)
  const chatWidth = widths.get(CHAT_TILE_ID) ?? 0
  const parentWidth = widths.get(parent.id) ?? 0
  const chatMin = opts.minOf(CHAT_TILE_ID, 'row')
  if (!(parentWidth > 0) || chatWidth >= chatMin - 0.5) return layout
  const insets = parent.children.map((child) => (root ? opts.laneInset(child) : 0))
  const budget = Math.max(0, parentWidth - gap * Math.max(0, parent.children.length - 1) - sum(insets))
  const mins = parent.children.map((child, index) => Math.max(0, minSize(child, 'row', opts) - insets[index]))
  mins[chatIndex] = Math.min(mins[chatIndex], budget - (sum(mins) - mins[chatIndex]))
  if (mins[chatIndex] <= chatWidth + 0.5) return layout
  const declared = parent.children.map((child) => child.flex)
  const weights = distributeFlex(declared, mins, budget)
  const scale = sum(declared) / weights.length
  return withStackFlexes(
    layout,
    parent.id,
    weights.map((weight) => weight * scale)
  )
}
