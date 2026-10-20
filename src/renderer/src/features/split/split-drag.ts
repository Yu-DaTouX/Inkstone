import { create } from 'zustand'
import type { PointerEvent as ReactPointerEvent } from 'react'
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

export interface SessionDragGhost {
  width: number
  height: number
  dx: number
  dy: number
  clone: HTMLElement | null
}

export interface SplitDragState {
  item: SessionDragItem | null
  ghost: SessionDragGhost | null
  canSplit: boolean
  target: SplitDropTarget | null
  badge: DropBadge | null
}

export const useSplitDrag = create<SplitDragState>(() => ({ item: null, ghost: null, canSplit: false, target: null, badge: null }))

export const dragPointer = { x: -1000, y: -1000 }

const toRect = (rect: DOMRect): DropRect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

export function measureDropGeometry(): DropGeometry | null {
  if (typeof document === 'undefined') return null
  const host = document.querySelector<HTMLElement>('.v3-chat .v3-split') ?? document.querySelector<HTMLElement>('.v3-chat')
  if (!host) return null
  const hostRect = toRect(host.getBoundingClientRect())
  if (hostRect.width <= 0 || hostRect.height <= 0) return null
  const columns = host.classList.contains('v3-split')
    ? [...host.querySelectorAll<HTMLElement>(':scope > .v3-split-column')].map((el) => toRect(el.getBoundingClientRect()))
    : [hostRect]
  return { host: hostRect, columns, rowSplit: useSplitView.getState().rowSplit }
}

function sidebarEdge(): number {
  const side = document.querySelector<HTMLElement>('.v3-side')
  if (!side) return 0
  const rect = side.getBoundingClientRect()
  return rect.width > 0 ? rect.right : 0
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

export function cancelSessionDrag(): void {
  cancelActive?.()
}

export function startSessionRowDrag(event: ReactPointerEvent<HTMLElement>, item: SessionDragItem, onDragged: () => void): void {
  if (event.button !== 0 || cancelActive) return
  const pointerId = event.pointerId
  const startX = event.clientX
  const startY = event.clientY
  const row = event.currentTarget.closest<HTMLElement>('.v3-srow') ?? event.currentTarget
  const ref: SplitSessionRef = { sessionId: item.id, path: item.path }
  let started = false
  let ctx: DropContext | null = null
  let geometry: DropGeometry | null = null
  let edge = 0
  let releaseBlocker: (() => void) | null = null

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
      onDragged()
      document.getSelection()?.removeAllRanges()
      document.documentElement.dataset.sessionDragging = ''
      const box = row.getBoundingClientRect()
      const height = box.height
      const ghost: SessionDragGhost = {
        width: box.width,
        height,
        dx: Math.min(Math.max(ev.clientX - box.left, 4), Math.max(4, box.width - 4)),
        dy: Math.min(Math.max(ev.clientY - box.top, 2), Math.max(2, height - 2)),
        clone: cloneRow(row)
      }
      geometry = measureDropGeometry()
      edge = sidebarEdge()
      const roomy = window.innerWidth > SPLIT_CONSTRAINED_WIDTH
      const store = useStore.getState()
      ctx = roomy && geometry && !shownInWindow(ref)
        ? dropContextFor(useSplitView.getState().split, displayedSessionOf(store), ref, geometry.host.width)
        : null
      const canSplit = !!ctx && !!geometry
      useSplitDrag.setState({
        item,
        ghost,
        canSplit,
        target: null,
        badge: canSplit && ctx && geometry ? dropBadge(null, ctx, geometry) : null
      })
      if (canSplit) releaseBlocker = store.acquireOverlayBlocker('split-drag')
      return
    }
    if (!ctx || !geometry) return
    const target = ev.clientX > edge ? sessionDropTarget(ctx, geometry, ev.clientX, ev.clientY) : null
    const state = useSplitDrag.getState()
    if (!sameDropTarget(target, state.target)) useSplitDrag.setState({ target, badge: dropBadge(target, ctx, geometry) })
  }

  const finish = (commit: boolean): void => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', cancel)
    cancelActive = null
    if (!started) return
    const swallow = (click: MouseEvent): void => {
      click.preventDefault()
      click.stopPropagation()
    }
    document.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => document.removeEventListener('click', swallow, true), 0)
    const target = useSplitDrag.getState().target
    useSplitDrag.setState({ item: null, ghost: null, canSplit: false, target: null, badge: null })
    delete document.documentElement.dataset.sessionDragging
    releaseBlocker?.()
    releaseBlocker = null
    if (commit && target) dropSessionInSplit(item, target)
  }
  const up = (ev: PointerEvent): void => {
    if (ev.pointerId === pointerId) finish(true)
  }
  const cancel = (): void => finish(false)
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    if (started) {
      ev.preventDefault()
      ev.stopPropagation()
    }
    finish(false)
  }

  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', cancel)
  cancelActive = () => finish(false)
}
