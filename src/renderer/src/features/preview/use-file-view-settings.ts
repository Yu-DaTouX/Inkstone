import { useSyncExternalStore } from 'react'
import { createFileViewSettings, type FileViewSettings, type FileViewSettingsStore, type StorageLike } from './file-view-settings'

let shared: FileViewSettingsStore | null = null

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function fileViewSettingsStore(): FileViewSettingsStore {
  if (!shared) {
    shared = createFileViewSettings({
      storage: browserStorage(),
      subscribeStorage: (listener) => {
        if (typeof window === 'undefined') return () => {}
        window.addEventListener('storage', listener)
        return () => window.removeEventListener('storage', listener)
      }
    })
  }
  return shared
}

export function useFileViewSettings(): [FileViewSettings, FileViewSettingsStore['set']] {
  const store = fileViewSettingsStore()
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return [settings, store.set]
}
