import { create } from 'zustand'
import { useStore } from '../../state/store'
import { displayedSessionOf, indexOfSession, useSplitView, type SplitSessionRef } from '../../state/split-view'
import {
  SESSION_DRAG_THRESHOLD,
  SPLIT_CONSTRAINED_WIDTH,
  dropBadge,
  dropContextFor,
  sameDropTarget,
  sessionDropTarget,
  type DropBadge,
  type DropContext,
  type DropGeometry,
  type DropRect,
  type SplitDropTarget
} from './split-drop-model'
import { dropSessionInSplit } from './split-actions'

export interface SessionDragItem {
  id: string
  path: string
  title: string
}

export interface DragGhost {
  label: string
  width: number
  height: number
  dx: number
  dy: number
  clone: HTMLElement | null
}

export interface SplitDragState {
  source: string | null
  ghost: DragGhost | null
  over: boolean
  badge: DropBadge | null
}

export const useSplitDrag = create<SplitDragState>(() => ({ source: null, ghost: null, over: false, badge: null }))

export const dragPointer = { x: -1000, y: -1000 }

export const PANE_GHOST_WIDTH = 240
export const PANE_GHOST_HEIGHT = 32

export interface DragPoint {
  x: number
  y: number
}

export interface DragSession {
  source: string
  ghost: DragGhost
  blocksOverlay?: boolean
  hover(point: DragPoint): { badge: DropBadge | null; over: boolean }
  drop(): void
  cancel?(): void
  end?(): void
}

export interface DragStart {
  button: number
  pointerId: number
  clientX: number
  clientY: number
}

export function labelGhost(label: string): DragGhost {
  return { label, width: PANE_GHOST_WIDTH, height: PANE_GHOST_HEIGHT, dx: PANE_GHOST_WIDTH / 2, dy: PANE_GHOST_HEIGHT / 2, clone: null }
}

const toRect = (rect: DOMRect): DropRect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

function renderedRowSplit(host: HTMLElement): number {
  const value = parseFloat(getComputedStyle(host).getPropertyValue('--split-row'))
  return Number.isFinite(value) ? value : useSplitView.getState().rowSplit
}

export function measureDropGeometry(): DropGeometry | null {
  if (typeof document === 'undefined') return null
  const host = document.querySelector<HTMLElement>('.v3-chat .v3-split') ?? document.querySelector<HTMLElement>('.v3-chat')
  if (!host) return null
  const hostRect = toRect(host.getBoundingClientRect())
  if (hostRect.width <= 0 || hostRect.height <= 0) return null
  const split = host.classList.contains('v3-split')
  const columns = split ? [...host.querySelectorAll<HTMLElement>(':scope > .v3-split-column')].map((el) => toRect(el.getBoundingClientRect())) : [hostRect]
  return { host: hostRect, columns, rowSplit: split ? renderedRowSplit(host) : useSplitView.getState().rowSplit }
}

export function sidebarEdge(): number {
  const side = document.querySelector<HTMLElement>('.v3-side')
  if (!side) return 0
  const rect = side.getBoundingClientRect()
  return rect.width > 0 ? rect.right : 0
}

export function chatRoomy(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > SPLIT_CONSTRAINED_WIDTH
}

function cloneRow(row: HTMLElement): HTMLElement {
  const clone = row.cloneNode(true) as HTMLElement
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('[id], [data-testid]')]) {
    node.removeAttribute('id')
    node.removeAttribute('data-testid')
  }
  clone.removeAttribute('style')
  clone.removeAttribute('data-dragging')
  clone.setAttribute('inert', '')
  clone.setAttribute('aria-hidden', 'true')
  return clone
}

function shownInWindow(ref: SplitSessionRef): boolean {
  const store = useStore.getState()
  const split = useSplitView.getState().split
  if (split) return indexOfSession(split.tiles, ref) >= 0
  const current = displayedSessionOf(store)
  return !!current && indexOfSession([current], ref) >= 0
}

let cancelActive: (() => void) | null = null

export function cancelPointerDrag(): void {
  cancelActive?.()
}

let previewRelease: (() => void) | null = null

export function showDropPreview(badge: DropBadge | null): void {
  if (useSplitDrag.getState().ghost) return
  useSplitDrag.setState({ badge })
  if (badge && !previewRelease) previewRelease = useStore.getState().acquireOverlayBlocker('split-drag')
  if (!badge && previewRelease) {
    previewRelease()
    previewRelease = null
  }
}

export function trackPointerDrag(start: DragStart, begin: (point: DragPoint) => DragSession | null, onStarted?: () => void): void {
  if (start.button !== 0 || cancelActive) return
  const pointerId = start.pointerId
  const startX = start.clientX
  const startY = start.clientY
  let session: DragSession | null = null
  let started = false
  let releaseBlocker: (() => void) | null = null

  const hover = (point: DragPoint): void => {
    if (!session) return
    const next = session.hover(point)
    const state = useSplitDrag.getState()
    if (next.badge !== state.badge || next.over !== state.over) useSplitDrag.setState({ badge: next.badge, over: next.over })
  }

  const move = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    if (ev.buttons === 0) {
      finish(true)
      return
    }
    dragPointer.x = ev.clientX
    dragPointer.y = ev.clientY
    if (!started) {
      if (Math.abs(ev.clientX - startX) < SESSION_DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < SESSION_DRAG_THRESHOLD) return
      started = true
      session = begin({ x: ev.clientX, y: ev.clientY })
      if (!session) {
        finish(false)
        return
      }
      onStarted?.()
      document.getSelection()?.removeAllRanges()
      document.documentElement.dataset.pointerDragging = ''
      showDropPreview(null)
      useSplitDrag.setState({ source: session.source, ghost: session.ghost, over: false, badge: null })
      if (session.blocksOverlay !== false) releaseBlocker = useStore.getState().acquireOverlayBlocker('split-drag')
    }
    hover({ x: ev.clientX, y: ev.clientY })
  }

  const finish = (commit: boolean): void => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('selectstart', noSelect, true)
    cancelActive = null
    if (!started) return
    const swallow = (click: MouseEvent): void => {
      click.preventDefault()
      click.stopPropagation()
    }
    document.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => document.removeEventListener('click', swallow, true), 0)
    useSplitDrag.setState({ source: null, ghost: null, over: false, badge: null })
    delete document.documentElement.dataset.pointerDragging
    releaseBlocker?.()
    releaseBlocker = null
    const active = session
    session = null
    if (!active) return
    if (commit) active.drop()
    else active.cancel?.()
    active.end?.()
  }
  const up = (ev: PointerEvent): void => {
    if (ev.pointerId === pointerId) finish(true)
  }
  const cancel = (): void => finish(false)
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.isComposing) return
    if (started) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
    }
    finish(false)
  }
  const noSelect = (ev: Event): void => {
    if (started) ev.preventDefault()
  }

  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', cancel)
  window.addEventListener('selectstart', noSelect, true)
  cancelActive = () => finish(false)
}

export interface SessionFolderDrop {
  item: SessionDragItem
  projectId: string | null
  cwd: string
  label: string
}

export const SESSION_FOLDER_DROP_EVENT = 'yan-v3-session-folder-drop'

function folderUnder(x: number, y: number, home: HTMLElement | null): HTMLElement | null {
  if (x > sidebarEdge()) return null
  for (const group of document.querySelectorAll<HTMLElement>('.v3-side .v3-group[data-move-cwd]')) {
    if (group === home) continue
    const rect = group.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return group
  }
  return null
}

function sidebarZoneUnder(x: number, y: number, selector: string): HTMLElement | null {
  if (x > sidebarEdge()) return null
  const zone = document.querySelector<HTMLElement>(`.v3-side ${selector}`)
  if (!zone) return null
  const rect = zone.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? zone : null
}

export const SESSION_QUOTE_DROP_EVENT = 'yan-v3-session-quote-drop'

function quoteTargetUnder(x: number, y: number): HTMLElement | null {
  if (x <= sidebarEdge()) return null
  for (const target of document.querySelectorAll<HTMLElement>('[data-session-quote-drop]')) {
    const rect = target.getBoundingClientRect()
    if (rect.width && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return target
  }
  return null
}

type SidebarZone = { kind: 'archive' | 'restore' | 'pin' | 'unpin'; el: HTMLElement }

function sidebarZoneFor(x: number, y: number, row: HTMLElement): SidebarZone | null {
  const archived = !!row.closest('[data-archive-shelf]')
  if (archived) {
    const el = sidebarZoneUnder(x, y, '[data-archive-restore]')
    return el ? { kind: 'restore', el } : null
  }
  const shelf = sidebarZoneUnder(x, y, '[data-archive-shelf]')
  if (shelf) return { kind: 'archive', el: shelf }
  const pinned = !!row.closest('[data-pin-zone]')
  const pin = pinned ? null : sidebarZoneUnder(x, y, '[data-pin-zone]')
  if (pin) return { kind: 'pin', el: pin }
  const unpin = pinned ? sidebarZoneUnder(x, y, '[data-unpin-zone]') : null
  return unpin ? { kind: 'unpin', el: unpin } : null
}

export function startSessionRowDrag(event: DragStart & { currentTarget: HTMLElement }, item: SessionDragItem, onDragged: () => void): void {
  const row = event.currentTarget.closest<HTMLElement>('.v3-srow') ?? event.currentTarget
  const home = row.closest<HTMLElement>('.v3-group')
  const archived = !!row.closest('[data-archive-shelf]')
  let folder: HTMLElement | null = null
  let shelf: HTMLElement | null = null
  let zone: SidebarZone | null = null
  let quote: HTMLElement | null = null
  const markQuote = (next: HTMLElement | null): void => {
    if (next === quote) return
    quote?.removeAttribute('data-quote-over')
    next?.setAttribute('data-quote-over', '1')
    quote = next
  }
  const markFolder = (next: HTMLElement | null): void => {
    if (next === folder) return
    folder?.removeAttribute('data-drop-over')
    next?.setAttribute('data-drop-over', '1')
    folder = next
  }
  const markShelf = (next: HTMLElement | null): void => {
    if (next === shelf) return
    shelf?.removeAttribute('data-drop-over')
    next?.setAttribute('data-drop-over', '1')
    shelf = next
  }
  const ref: SplitSessionRef = { sessionId: item.id, path: item.path }
  trackPointerDrag(
    event,
    (point) => {
      const box = row.getBoundingClientRect()
      const ghost: DragGhost = {
        label: '',
        width: box.width,
        height: box.height,
        dx: Math.min(Math.max(point.x - box.left, 4), Math.max(4, box.width - 4)),
        dy: Math.min(Math.max(point.y - box.top, 2), Math.max(2, box.height - 2)),
        clone: cloneRow(row)
      }
      const geometry = measureDropGeometry()
      const edge = sidebarEdge()
      const ctx: DropContext | null =
        chatRoomy() && geometry && !shownInWindow(ref)
          ? dropContextFor(useSplitView.getState().split, displayedSessionOf(useStore.getState()), ref, geometry.host.width)
          : null
      let target: SplitDropTarget | null = null
      let badge: DropBadge | null = ctx && geometry ? dropBadge(null, ctx, geometry) : null
      return {
        source: `session:${item.path}`,
        ghost,
        blocksOverlay: !!ctx,
        hover: ({ x, y }) => {
          zone = sidebarZoneFor(x, y, row)
          markShelf(zone?.el ?? null)
          markFolder(shelf || archived ? null : folderUnder(x, y, home))
          markQuote(shelf || folder ? null : quoteTargetUnder(x, y))
          if (folder || shelf || quote) return { badge: null, over: false }
          if (!ctx || !geometry) return { badge: null, over: false }
          const next = x > edge ? sessionDropTarget(ctx, geometry, x, y) : null
          if (!sameDropTarget(next, target)) {
            target = next
            badge = dropBadge(next, ctx, geometry)
          }
          return { badge, over: target !== null }
        },
        drop: () => {
          if (shelf && zone) {
            const store = useStore.getState()
            if (zone.kind === 'archive' || zone.kind === 'restore') void store.setSessionArchived(item.id, zone.kind === 'archive')
            else void store.setSessionPinned(item.id, zone.kind === 'pin')
            return
          }
          if (quote) {
            quote.dispatchEvent(new CustomEvent(SESSION_QUOTE_DROP_EVENT, { detail: item }))
            return
          }
          if (folder) {
            const detail: SessionFolderDrop = {
              item,
              projectId: folder.dataset.moveProject || null,
              cwd: folder.dataset.moveCwd ?? '',
              label: folder.dataset.moveLabel ?? ''
            }
            window.dispatchEvent(new CustomEvent(SESSION_FOLDER_DROP_EVENT, { detail }))
            return
          }
          if (target) dropSessionInSplit(item, target)
        },
        end: () => {
          markFolder(null)
          markShelf(null)
          markQuote(null)
        }
      }
    },
    onDragged
  )
}
