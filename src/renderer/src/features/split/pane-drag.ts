import { splitTileKey, useSplitView, type SplitSessionRef } from '../../state/split-view'
import { trackPointerDrag, type DragStart } from '../sidebar/session-drag'
import { labelGhost, measureDropGeometry, setSplitBadge } from './split-drag'
import {
  applyPaneDrop,
  maxColumnsFor,
  paneDropBadge,
  paneDropTarget,
  paneDropZone,
  samePaneTarget,
  withHiddenTiles,
  type PaneDropTarget
} from './split-drop-model'

export interface PaneDragItem {
  key: string
  label: string
  shown: readonly SplitSessionRef[]
  position: number
}

export function startPaneDrag(event: DragStart, item: PaneDragItem): void {
  trackPointerDrag(event, () => {
    const geometry = measureDropGeometry()
    const split = useSplitView.getState().split
    if (!geometry || !split) return null
    const shown = item.shown
    const from = item.position
    const max = maxColumnsFor(geometry.host.width)
    let target: PaneDropTarget | null = null
    setSplitBadge(paneDropBadge(null, shown, from, geometry, max))
    return {
      source: `pane:${item.key}`,
      ghost: labelGhost(item.label),
      hover: ({ x, y }) => {
        const { host } = geometry
        const inside = x >= host.left && x < host.left + host.width && y >= host.top && y < host.top + host.height
        const zone = inside ? paneDropZone(geometry.columns, geometry.rowSplit, x, y) : null
        const next = zone ? paneDropTarget(shown, from, zone, max) : null
        if (!samePaneTarget(next, target)) {
          target = next
          setSplitBadge(paneDropBadge(next, shown, from, geometry, max))
        }
      },
      drop: () => {
        const view = useSplitView.getState()
        const current = view.split
        if (!target || !current) return
        const fresh = shown.map((tile) => current.tiles.find((item) => splitTileKey(item) === splitTileKey(tile)) ?? tile)
        const moved = applyPaneDrop(fresh, from, target, max)
        if (!moved) return
        const tiles = withHiddenTiles(current.tiles, fresh, moved)
        const liveRef = current.tiles[current.live]
        const live = liveRef ? Math.max(0, tiles.findIndex((tile) => splitTileKey(tile) === splitTileKey(liveRef))) : 0
        view.apply({ tiles, live })
      },
      end: () => setSplitBadge(null)
    }
  })
}
