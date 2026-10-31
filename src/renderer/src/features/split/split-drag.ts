import { create } from 'zustand'
import { useStore } from '../../state/store'
import { displayedSessionOf, indexOfSession, useSplitView, type SplitSessionRef } from '../../state/split-view'
import type { DragGhost } from '../sidebar/session-drag'
import {
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

export const PANE_GHOST_WIDTH = 240
export const PANE_GHOST_HEIGHT = 32

interface SplitDropState {
  badge: DropBadge | null
}

export const useSplitDrop = create<SplitDropState>(() => ({ badge: null }))

let previewRelease: (() => void) | null = null

const sameBadge = (a: DropBadge | null, b: DropBadge | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.label === b.label &&
    a.hint === b.hint &&
    a.box.left === b.box.left &&
    a.box.top === b.box.top &&
    a.box.width === b.box.width &&
    a.box.height === b.box.height)

export function setSplitBadge(badge: DropBadge | null): void {
  if (!sameBadge(useSplitDrop.getState().badge, badge)) useSplitDrop.setState({ badge })
  if (badge && !previewRelease) previewRelease = useStore.getState().acquireOverlayBlocker('split-drag')
  if (!badge && previewRelease) {
    previewRelease()
    previewRelease = null
  }
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

export function chatRoomy(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > SPLIT_CONSTRAINED_WIDTH
}

function shownInWindow(ref: SplitSessionRef): boolean {
  const split = useSplitView.getState().split
  if (split) return indexOfSession(split.tiles, ref) >= 0
  const current = displayedSessionOf(useStore.getState())
  return !!current && indexOfSession([current], ref) >= 0
}

export interface SplitDropItem {
  id: string
  path: string
}

export interface SessionSplitDrag {
  move(x: number, y: number, edge: number): boolean
  drop(x: number, y: number, edge: number): boolean
  clear(): void
  end(): void
}

export function createSessionSplitDrag(item: SplitDropItem): SessionSplitDrag {
  const ref: SplitSessionRef = { sessionId: item.id, path: item.path }
  let prepared = false
  let geometry: DropGeometry | null = null
  let ctx: DropContext | null = null
  let target: SplitDropTarget | null = null

  const prepare = (): void => {
    if (prepared) return
    prepared = true
    if (!chatRoomy() || shownInWindow(ref)) return
    geometry = measureDropGeometry()
    ctx = geometry ? dropContextFor(useSplitView.getState().split, displayedSessionOf(useStore.getState()), ref, geometry.host.width) : null
  }

  const resolve = (x: number, y: number, edge: number): SplitDropTarget | null => {
    prepare()
    if (!ctx || !geometry || x <= edge) return null
    return sessionDropTarget(ctx, geometry, x, y)
  }

  return {
    move: (x, y, edge) => {
      prepare()
      if (!ctx || !geometry || x <= edge) {
        target = null
        setSplitBadge(null)
        return false
      }
      const next = resolve(x, y, edge)
      if (!sameDropTarget(next, target)) target = next
      setSplitBadge(dropBadge(target, ctx, geometry))
      return target !== null
    },
    drop: (x, y, edge) => {
      const next = resolve(x, y, edge)
      setSplitBadge(null)
      target = null
      return next ? dropSessionInSplit(item, next) : false
    },
    clear: () => {
      target = null
      setSplitBadge(null)
    },
    end: () => {
      target = null
      setSplitBadge(null)
    }
  }
}
