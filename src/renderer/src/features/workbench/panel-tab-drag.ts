import { trackPointerDrag, type DragStart } from '../sidebar/session-drag'
import { labelGhost, setSplitBadge } from '../split/split-drag'
import type { DropBadge, DropRect } from '../split/split-drop-model'
import { useStore } from '../../state/store'
import {
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  currentPanelEntry,
  moveSurfaceToDock,
  moveSurfaceToGroup,
  moveSurfaceToRight,
  panelGroups,
  rightGroupCount,
  splitSurface,
  useRightPanel,
  type PanelEdgeDock,
  type RightPanelEntry
} from '../../state/right-panel'

export type PanelTabDrop =
  | { kind: 'edge'; side: 'left' | 'right' }
  | { kind: 'group'; index: number }
  | { kind: 'split'; index: number }
  | { kind: 'dock'; side: PanelEdgeDock }
  | { kind: 'right' }

export interface PanelTabDragText {
  splitLeft: string
  splitRight: string
  moveHere: string
  toDockLeft: string
  toDockBottom: string
  toRightPanel: string
}

export interface PanelDropLayout {
  columns: readonly DropRect[]
  chat: DropRect | null
  left: DropRect | null
  bottom: DropRect | null
}

const EDGE_SHARE = 0.25
const CHAT_SIDE_SHARE = 0.25
const CHAT_BOTTOM_SHARE = 0.3
const DOCK_PREVIEW_SHARE = 0.5
const INSET_PX = 8
const OVERLAY_TOKEN = 'rp-tab-drag'

export function samePanelTabDrop(a: PanelTabDrop | null, b: PanelTabDrop | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'edge' && b.kind === 'edge') return a.side === b.side
  if (a.kind === 'dock' && b.kind === 'dock') return a.side === b.side
  if ((a.kind === 'group' || a.kind === 'split') && (b.kind === 'group' || b.kind === 'split')) return a.index === b.index
  return true
}

const inside = (rect: DropRect | null, x: number, y: number): boolean =>
  !!rect && x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height

export function panelTabDropZone(
  columns: readonly DropRect[],
  x: number,
  y: number,
  source = -1,
  sourceHead: DropRect | null = null
): PanelTabDrop | null {
  if (!columns.length) return null
  const first = columns[0]
  const last = columns[columns.length - 1]
  if (y < first.top || y >= first.top + first.height) return null
  if (x < first.left) return { kind: 'edge', side: 'left' }
  if (x >= last.left + last.width) return null
  if (sourceHead && inside(sourceHead, x, y)) return null
  const at = columns.findIndex((rect) => x >= rect.left && x < rect.left + rect.width)
  if (at < 0) return null
  const rect = columns[at]
  if (at === 0 && x < rect.left + rect.width * EDGE_SHARE) return { kind: 'edge', side: 'left' }
  if (at === columns.length - 1 && x >= rect.left + rect.width * (1 - EDGE_SHARE)) return { kind: 'edge', side: 'right' }
  if (at === source) return { kind: 'split', index: at }
  return { kind: 'group', index: at }
}

export function panelDropZone(layout: PanelDropLayout, x: number, y: number, source = -1, sourceHead: DropRect | null = null): PanelTabDrop | null {
  if (inside(layout.left, x, y)) return { kind: 'dock', side: 'left' }
  if (inside(layout.bottom, x, y)) return { kind: 'dock', side: 'bottom' }
  const chat = layout.chat
  if (chat && inside(chat, x, y)) {
    if (x < chat.left + chat.width * CHAT_SIDE_SHARE) return { kind: 'dock', side: 'left' }
    if (y >= chat.top + chat.height * (1 - CHAT_BOTTOM_SHARE)) return { kind: 'dock', side: 'bottom' }
    if (x >= chat.left + chat.width * (1 - CHAT_SIDE_SHARE)) return { kind: 'right' }
    return null
  }
  return panelTabDropZone(layout.columns, x, y, source, sourceHead)
}

export function droppedEntry(entry: RightPanelEntry, id: string, drop: PanelTabDrop): RightPanelEntry {
  if (drop.kind === 'dock') return moveSurfaceToDock(entry, id, drop.side)
  if (drop.kind === 'right') return moveSurfaceToRight(entry, id)
  if (drop.kind === 'split') {
    const group = panelGroups(entry)[drop.index]
    return group && group.surfaces.length > 1 && group.surfaces.some((item) => item.id === id) ? splitSurface(entry, id) : entry
  }
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
  const rights = rightGroupCount(groups)
  const at = groups.findIndex((group) => group.surfaces.some((surface) => surface.id === id))
  if (at < 0 || at >= rights) return null
  const width = predictedPanelWidth(frame, rights)
  const shown = groups.slice(0, rights)
  const total = shown.reduce((sum, group) => sum + group.size, 0) || 1
  const before = shown.slice(0, at).reduce((sum, group) => sum + group.size, 0)
  return {
    left: frame.right - width + (width * before) / total + INSET_PX,
    top: frame.top + INSET_PX,
    width: Math.max(0, (width * groups[at].size) / total - 2 * INSET_PX),
    height: Math.max(0, frame.height - 2 * INSET_PX)
  }
}

const inset = (rect: DropRect): DropRect => ({
  left: rect.left + INSET_PX,
  top: rect.top + INSET_PX,
  width: Math.max(0, rect.width - 2 * INSET_PX),
  height: Math.max(0, rect.height - 2 * INSET_PX)
})

export function predictedDockBox(layout: PanelDropLayout, drop: PanelTabDrop, sizes: { left: number; bottom: number; right: number }): DropRect | null {
  const chat = layout.chat
  if (drop.kind === 'dock' && drop.side === 'left') {
    if (layout.left) return inset(layout.left)
    if (!chat) return null
    return inset({ left: chat.left, top: chat.top, width: Math.min(sizes.left, chat.width * DOCK_PREVIEW_SHARE), height: chat.height })
  }
  if (drop.kind === 'dock' && drop.side === 'bottom') {
    if (layout.bottom) return inset(layout.bottom)
    if (!chat) return null
    const height = Math.min(sizes.bottom, chat.height * DOCK_PREVIEW_SHARE)
    return inset({ left: chat.left, top: chat.top + chat.height - height, width: chat.width, height })
  }
  if (drop.kind === 'right' && layout.columns.length) {
    const first = layout.columns[0]
    const last = layout.columns[layout.columns.length - 1]
    return inset({ left: first.left, top: first.top, width: last.left + last.width - first.left, height: first.height })
  }
  if (drop.kind === 'right' && chat) {
    const width = Math.min(sizes.right, chat.width * DOCK_PREVIEW_SHARE)
    return inset({ left: chat.left + chat.width - width, top: chat.top, width, height: chat.height })
  }
  return null
}

const toRect = (rect: DOMRect): DropRect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
const rectOf = (selector: string): DropRect | null => {
  const el = document.querySelector<HTMLElement>(selector)
  return el ? toRect(el.getBoundingClientRect()) : null
}

export function startPanelTabDrag(start: DragStart, id: string, label: string, room: number, text: PanelTabDragText): void {
  let release: (() => void) | null = null
  trackPointerDrag(start, () => {
    const host = document.querySelector<HTMLElement>('.rp-columns')
    const columnEls = [...document.querySelectorAll<HTMLElement>('.rp-columns > .rp-column')]
    const entry = currentPanelEntry()
    const groups = panelGroups(entry)
    const rights = rightGroupCount(groups)
    const columns = host && columnEls.length === rights ? columnEls.map((el) => toRect(el.getBoundingClientRect())) : []
    const layout: PanelDropLayout = {
      columns,
      chat: rectOf('.v3-body'),
      left: rectOf('[data-testid="rp-dock-left"]'),
      bottom: rectOf('[data-testid="rp-dock-bottom"]')
    }
    if (!layout.columns.length && !layout.chat) return null
    const source = groups.findIndex((group) => group.surfaces.some((surface) => surface.id === id))
    const headEl = source >= 0 && source < columnEls.length ? columnEls[source].querySelector<HTMLElement>('.rp-column-head') : null
    const sourceHead = headEl ? toRect(headEl.getBoundingClientRect()) : null
    const box = host?.getBoundingClientRect()
    const frame: PanelFrame | null = box ? { right: box.right, top: box.top, height: box.height, width: box.width, room } : null
    const panel = useRightPanel.getState()
    const sizes = { left: panel.dockLeft, bottom: panel.dockBottom, right: clampPanelWidth(panel.width, room) }
    release = useStore.getState().acquireOverlayBlocker(OVERLAY_TOKEN)
    let target: PanelTabDrop | null = null
    const badgeFor = (drop: PanelTabDrop): DropBadge | null => {
      const next = droppedEntry(entry, id, drop)
      if (next === entry) return null
      if (drop.kind === 'dock' || drop.kind === 'right') {
        const rect = predictedDockBox(layout, drop, sizes)
        if (!rect) return null
        return { box: rect, label: 'split', hint: false, text: drop.kind === 'right' ? text.toRightPanel : drop.side === 'left' ? text.toDockLeft : text.toDockBottom }
      }
      const rect = frame ? predictedColumnBox(next, id, frame) : null
      if (!rect) return null
      return {
        box: rect,
        label: drop.kind === 'group' ? 'move' : 'split',
        hint: false,
        text: drop.kind === 'group' ? text.moveHere : drop.kind === 'edge' && drop.side === 'left' ? text.splitLeft : text.splitRight
      }
    }
    return {
      source: `rp-tab:${id}`,
      ghost: labelGhost(label),
      hover: ({ x, y }) => {
        const zone = panelDropZone(layout, x, y, source, sourceHead)
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
        if (target.kind === 'dock') panel.moveToDock(id, target.side)
        else if (target.kind === 'right') panel.moveToRight(id)
        else if (target.kind === 'split') panel.split(id)
        else if (target.kind === 'group') panel.moveToGroup(id, target.index)
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
