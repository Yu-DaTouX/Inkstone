import { findStack, type TileLayout, type TileTarget } from './tile-tree'
import type { Box } from './tile-drop-zones'

export type DropEdge = 'top' | 'bottom' | 'left' | 'right'

export interface TileDropIndicator {
  edge: DropEdge
  left: number
  top: number
  width: number
  height: number
}

export const DROP_BAR_PX = 3

export const DROP_BAR_INSET_PX = 6

const edgeFor = (row: boolean, start: boolean): DropEdge => (row ? (start ? 'left' : 'right') : start ? 'top' : 'bottom')

export interface DropEdgeHit {
  key: string
  edge: DropEdge
}

export function tileDropEdge(layout: TileLayout, target: TileTarget): DropEdgeHit | null {
  if (target.kind === 'wrap') {
    return { key: target.tileId, edge: edgeFor(target.direction === 'row', target.index === 0) }
  }
  const stack = findStack(layout, target.stackId)
  if (!stack) return null
  if (target.kind === 'split' && target.direction !== stack.direction) {
    return { key: stack.id, edge: edgeFor(target.direction === 'row', target.index === 0) }
  }
  if (target.index === 0) return { key: stack.id, edge: edgeFor(stack.direction === 'row', true) }
  if (target.index === stack.children.length) return { key: stack.id, edge: edgeFor(stack.direction === 'row', false) }
  return null
}

export function tileDropIndicator(
  layout: TileLayout,
  target: TileTarget | null,
  nodeRects: Record<string, Box>,
  inset = DROP_BAR_INSET_PX
): TileDropIndicator | null {
  if (!target) return null
  const hit = tileDropEdge(layout, target)
  if (!hit) return null
  const rect = nodeRects[hit.key]
  if (!rect) return null
  const thickness = DROP_BAR_PX
  switch (hit.edge) {
    case 'left':
      return { edge: hit.edge, left: rect.left - inset, top: rect.top, width: thickness, height: rect.height }
    case 'right':
      return { edge: hit.edge, left: rect.right + inset - thickness, top: rect.top, width: thickness, height: rect.height }
    case 'top':
      return { edge: hit.edge, left: rect.left, top: rect.top - inset, width: rect.width, height: thickness }
    default:
      return { edge: hit.edge, left: rect.left, top: rect.bottom + inset - thickness, width: rect.width, height: thickness }
  }
}
