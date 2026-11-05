import { trackPointerDrag, type DragStart } from '../sidebar/session-drag'
import { labelGhost, setSplitBadge } from '../split/split-drag'
import type { DropBadge, DropRect } from '../split/split-drop-model'
import { useStore } from '../../state/store'
import { PANEL_WIDTH_MIN, currentPanelEntry, moveSurfaceToGroup, panelGroups, useRightPanel, type RightPanelEntry } from '../../state/right-panel'

export type PanelTabDrop = { kind: 'edge'; side: 'left' | 'right' } | { kind: 'group'; index: number }

export interface PanelTabDragText {
  splitLeft: string
  splitRight: string
  moveHere: string
}

const EDGE_SHARE = 0.25
const INSET_PX = 8
const OVERLAY_TOKEN = 'rp-tab-drag'

export function samePanelTabDrop(a: PanelTabDrop | null, b: PanelTabDrop | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'edge' && b.kind === 'edge') return a.side === b.side
  if (a.kind === 'group' && b.kind === 'group') return a.index === b.index
  return false
}

export function panelTabDropZone(columns: readonly DropRect[], x: number, y: number): PanelTabDrop | null {
  if (!columns.length) return null
  const first = columns[0]
  const last = columns[columns.length - 1]
  if (x < first.left || x >= last.left + last.width || y < first.top || y >= first.top + first.height) return null
  const at = columns.findIndex((rect) => x >= rect.left && x < rect.left + rect.width)
  if (at < 0) return null
  const rect = columns[at]
  if (at === 0 && x < rect.left + rect.width * EDGE_SHARE) return { kind: 'edge', side: 'left' }
  if (at === columns.length - 1 && x >= rect.left + rect.width * (1 - EDGE_SHARE)) return { kind: 'edge', side: 'right' }
  return { kind: 'group', index: at }
}

export function droppedEntry(entry: RightPanelEntry, id: string, drop: PanelTabDrop): RightPanelEntry {
  const target = drop.kind === 'group' ? drop.index : drop.side === 'left' ? -1 : panelGroups(entry).length
  return moveSurfaceToGroup(entry, id, target)
}

export interface PanelFrame {
  right: number
  top: number
  height: number
  width: number
  room: number
}

export function predictedPanelWidth(frame: PanelFrame, columns: number): number {
  const minimum = columns > 1 ? Math.min(frame.room, PANEL_WIDTH_MIN * columns) : 0
  return Math.max(frame.width, minimum)
}

export function predictedColumnBox(next: RightPanelEntry, id: string, frame: PanelFrame): DropRect | null {
  const groups = panelGroups(next)
  const at = groups.findIndex((group) => group.surfaces.some((surface) => surface.id === id))
  if (at < 0) return null
  const width = predictedPanelWidth(frame, groups.length)
  const total = groups.reduce((sum, group) => sum + group.size, 0) || 1
  const before = groups.slice(0, at).reduce((sum, group) => sum + group.size, 0)
  return {
    left: frame.right - width + (width * before) / total + INSET_PX,
    top: frame.top + INSET_PX,
    width: Math.max(0, (width * groups[at].size) / total - 2 * INSET_PX),
    height: Math.max(0, frame.height - 2 * INSET_PX)
  }
}

const toRect = (rect: DOMRect): DropRect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

export function startPanelTabDrag(start: DragStart, id: string, label: string, room: number, text: PanelTabDragText): void {
  let release: (() => void) | null = null
  trackPointerDrag(start, () => {
    const host = document.querySelector<HTMLElement>('.rp-columns')
    const columns = [...document.querySelectorAll<HTMLElement>('.rp-columns > .rp-column')].map((el) => toRect(el.getBoundingClientRect()))
    const entry = currentPanelEntry()
    if (!host || !columns.length || columns.length !== panelGroups(entry).length) return null
    const box = host.getBoundingClientRect()
    const frame: PanelFrame = { right: box.right, top: box.top, height: box.height, width: box.width, room }
    release = useStore.getState().acquireOverlayBlocker(OVERLAY_TOKEN)
    let target: PanelTabDrop | null = null
    const badgeFor = (drop: PanelTabDrop): DropBadge | null => {
      const next = droppedEntry(entry, id, drop)
      if (next === entry) return null
      const rect = predictedColumnBox(next, id, frame)
      if (!rect) return null
      return {
        box: rect,
        label: drop.kind === 'group' ? 'move' : 'split',
        hint: false,
        text: drop.kind === 'group' ? text.moveHere : drop.side === 'left' ? text.splitLeft : text.splitRight
      }
    }
    return {
      source: `rp-tab:${id}`,
      ghost: labelGhost(label),
      hover: ({ x, y }) => {
        const zone = panelTabDropZone(columns, x, y)
        const badge = zone ? badgeFor(zone) : null
        const next = badge ? zone : null
        if (samePanelTabDrop(next, target)) return
        target = next
        setSplitBadge(badge)
      },
      drop: () => {
        if (!target) return
        const next = droppedEntry(currentPanelEntry(), id, target)
        if (next === currentPanelEntry()) return
        const panel = useRightPanel.getState()
        if (target.kind === 'group') panel.moveToGroup(id, target.index)
        else panel.moveToGroup(id, target.side === 'left' ? -1 : panelGroups(currentPanelEntry()).length)
      },
      end: () => {
        setSplitBadge(null)
        release?.()
        release = null
      }
    }
  })
}
