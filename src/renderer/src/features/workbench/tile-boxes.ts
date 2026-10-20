import { nodeKey, type TileLayout, type TileNode } from './tile-tree'

export interface TileBox {
  left: number
  top: number
  width: number
  height: number
}

export function layoutBoxes(layout: TileLayout, root: TileBox, gap: number): Record<string, TileBox> {
  const boxes: Record<string, TileBox> = {}
  const place = (node: TileNode, area: TileBox): void => {
    boxes[nodeKey(node)] = area
    if (node.kind === 'tile' || !node.children.length) return
    const row = node.direction === 'row'
    const extent = row ? area.width : area.height
    const usable = Math.max(0, extent - gap * (node.children.length - 1))
    const total = node.children.reduce((sum, child) => sum + (child.flex > 0 ? child.flex : 1), 0) || 1
    let offset = row ? area.left : area.top
    for (const child of node.children) {
      const size = (usable * (child.flex > 0 ? child.flex : 1)) / total
      place(child, row ? { left: offset, top: area.top, width: size, height: area.height } : { left: area.left, top: offset, width: area.width, height: size })
      offset += size + gap
    }
  }
  place(layout.root, root)
  return boxes
}

export function tileLandingBox(layout: TileLayout, tileId: string, root: TileBox, gap: number): TileBox | null {
  return layoutBoxes(layout, root, gap)[tileId] ?? null
}
