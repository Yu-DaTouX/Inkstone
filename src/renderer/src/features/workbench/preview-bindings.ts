import { create } from 'zustand'
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
import { openPanelTool } from './panel-actions'

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
  openPanelTool('files')
}
