import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { useSplitView, type SplitSessionRef } from '../../state/split-view'
import { useUiV3 } from '../../state/ui-v3'
import {
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  closePreviewTabsToRight,
  keepAllPreviewTabs,
  keepPreviewTab,
  openPreviewTab,
  previewPathFor,
  previewTabsFor,
  readPreviewBindings,
  selectPreviewTab,
  writePreviewBindings,
  type PreviewBindings,
  type PreviewBindingsStorage,
  type PreviewOpenOptions,
  type PreviewTabs
} from './preview-state'
import { fileViewSettingsStore } from '../preview/use-file-view-settings'
import { canTileTool, roomForAnotherTile, tileCapacity, toolTileIndex, toolTileRef, visibleToolTiles } from './tool-tile-refs'
import type { WorkbenchTabId } from './types'

export { canTileTool, fitPaneTiles, toolTabOf } from './tool-tile-refs'

const NARROW_QUERY = '(max-width: 700px)'

function subscribeNarrow(notify: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

function narrowNow(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(NARROW_QUERY).matches
}

export function useNarrowLayout(): boolean {
  return useSyncExternalStore(subscribeNarrow, narrowNow, () => false)
}

export const useChatWidth = create<{ width: number }>(() => ({ width: 0 }))

export function watchChatWidth(host: HTMLElement | null): (() => void) | undefined {
  const chat = host?.closest<HTMLElement>('.v3-chat') ?? host
  if (!chat) return undefined
  const update = (): void => {
    const width = chat.getBoundingClientRect().width
    useChatWidth.setState({ width })
    useSplitView.getState().setContainerWidth(width)
  }
  update()
  if (typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(update)
  observer.observe(chat)
  return () => observer.disconnect()
}

export function useTileCapacity(): number {
  return useChatWidth((s) => tileCapacity(s.width))
}

export function useTiledTools(): ReadonlySet<WorkbenchTabId> {
  const narrow = useNarrowLayout()
  const capacity = useTileCapacity()
  const key = useSplitView((s) => visibleToolTiles(s.split, narrow, capacity).join(','))
  return useMemo(() => new Set(key ? (key.split(',') as WorkbenchTabId[]) : []), [key])
}

export function isToolTiled(tab: WorkbenchTabId): boolean {
  return visibleToolTiles(useSplitView.getState().split, narrowNow(), tileCapacity(useChatWidth.getState().width)).includes(tab)
}

export function hasTileRoom(freesToolbar: boolean): boolean {
  if (typeof document === 'undefined') return true
  const chat = document.querySelector<HTMLElement>('.v3-chat')
  if (!chat) return true
  const toolbar = freesToolbar ? document.querySelector<HTMLElement>('.wb-panel[data-open="1"][data-mode="docked"]') : null
  const width = chat.getBoundingClientRect().width + (toolbar?.getBoundingClientRect().width ?? 0)
  return roomForAnotherTile(width, useSplitView.getState().split?.tiles.length ?? 1)
}

export function useTileRoom(active: boolean, tab: WorkbenchTabId, freesToolbar: boolean): boolean {
  const columns = useSplitView((s) => s.split?.tiles.length ?? 1)
  const placed = useSplitView((s) => toolTileIndex(s.split, tab) >= 0)
  const [room, setRoom] = useState(true)
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined
    const measure = (): void => setRoom(hasTileRoom(freesToolbar))
    measure()
    const chat = document.querySelector('.v3-chat')
    if (!chat || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(chat)
    return () => observer.disconnect()
  }, [active, freesToolbar, columns])
  return placed || room
}

export function openToolTile(tab: WorkbenchTabId, current: SplitSessionRef | null, at?: number, freesToolbar = false): boolean {
  if (!canTileTool(tab) || narrowNow() || !current) return false
  if (toolTileIndex(useSplitView.getState().split, tab) < 0 && !hasTileRoom(freesToolbar)) return false
  const view = useSplitView.getState()
  view.open(toolTileRef(tab), current, at ?? (view.split ? view.split.live + 1 : undefined))
  return toolTileIndex(useSplitView.getState().split, tab) >= 0
}

export function closeToolTile(tab: WorkbenchTabId): void {
  const index = toolTileIndex(useSplitView.getState().split, tab)
  if (index >= 0) useSplitView.getState().remove(index)
}

export function dockToolTile(tab: WorkbenchTabId): void {
  closeToolTile(tab)
  const ui = useUiV3.getState()
  ui.setWorkspaceTab(tab)
  ui.setWorkspaceOpen(true)
}

export function revealToolTile(tab: WorkbenchTabId): boolean {
  if (!isToolTiled(tab)) return false
  requestAnimationFrame(() => {
    const tile = document.querySelector<HTMLElement>(`[data-tool-tile="${tab}"]`)
    if (!tile) return
    tile.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    tile.focus({ preventScroll: true })
    tile.dataset.flash = '1'
    setTimeout(() => {
      delete tile.dataset.flash
    }, 900)
  })
  return true
}

interface PreviewBindingsState {
  bindings: PreviewBindings
  bind(ownerKey: string | null, path: string, options?: PreviewOpenOptions): void
  select(ownerKey: string | null, path: string): void
  keep(ownerKey: string | null, path: string): void
  keepAll(): void
  close(ownerKey: string | null, path: string): void
  closeOthers(ownerKey: string | null, keep: string): void
  closeRight(ownerKey: string | null, path: string): void
  closeAll(ownerKey: string | null): void
}

function previewStorage(): PreviewBindingsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const previewStorageRef = previewStorage()

export const usePreviewBindings = create<PreviewBindingsState>((set, get) => ({
  bindings: readPreviewBindings(previewStorageRef),
  bind: (ownerKey, path, options) => set({ bindings: openPreviewTab(get().bindings, ownerKey, path, options) }),
  select: (ownerKey, path) => set({ bindings: selectPreviewTab(get().bindings, ownerKey, path) }),
  keep: (ownerKey, path) => set({ bindings: keepPreviewTab(get().bindings, ownerKey, path) }),
  keepAll: () => set({ bindings: keepAllPreviewTabs(get().bindings) }),
  close: (ownerKey, path) => set({ bindings: closePreviewTab(get().bindings, ownerKey, path) }),
  closeOthers: (ownerKey, keep) => set({ bindings: closeOtherPreviewTabs(get().bindings, ownerKey, keep) }),
  closeRight: (ownerKey, path) => set({ bindings: closePreviewTabsToRight(get().bindings, ownerKey, path) }),
  closeAll: (ownerKey) => set({ bindings: closeAllPreviewTabs(get().bindings, ownerKey) })
}))

let previewSaveTimer = 0
usePreviewBindings.subscribe((state) => {
  if (typeof window === 'undefined') return
  window.clearTimeout(previewSaveTimer)
  const bindings: PreviewBindings = state.bindings
  previewSaveTimer = window.setTimeout(() => writePreviewBindings(previewStorageRef, bindings), 150)
})

export function usePreviewTabs(ownerKey: string | null): PreviewTabs | undefined {
  return usePreviewBindings((s) => previewTabsFor(s.bindings, ownerKey))
}

export function usePreviewPath(ownerKey: string | null): string | undefined {
  return usePreviewBindings((s) => previewPathFor(s.bindings, ownerKey))
}

export function showPreview(ownerKey: string | null, path: string, options?: PreviewOpenOptions): void {
  const preview = options?.preview === true && fileViewSettingsStore().getSnapshot().previewTabs
  usePreviewBindings.getState().bind(ownerKey, path, { ...options, preview })
  if (revealToolTile('files')) return
  const ui = useUiV3.getState()
  ui.setWorkspaceTab('files')
  ui.setWorkspaceOpen(true)
}
