export const FILES_HIDDEN_KEY = 'yan.files.showHidden'

export interface FilesHiddenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface FilesHiddenStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  set(value: boolean): void
}

export function readFilesShowHidden(storage: FilesHiddenStorage | null): boolean {
  if (!storage) return false
  try {
    return storage.getItem(FILES_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeFilesShowHidden(storage: FilesHiddenStorage | null, value: boolean): void {
  if (!storage) return
  try {
    storage.setItem(FILES_HIDDEN_KEY, value ? '1' : '0')
  } catch {}
}

export function createFilesHiddenStore(
  storage: FilesHiddenStorage | null,
  subscribeStorage: (listener: () => void) => () => void = () => () => {}
): FilesHiddenStore {
  let value = readFilesShowHidden(storage)
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const sync = (): void => {
    const next = readFilesShowHidden(storage)
    if (next === value) return
    value = next
    emit()
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      const off = listeners.size === 1 ? subscribeStorage(sync) : () => {}
      return () => {
        listeners.delete(listener)
        off()
      }
    },
    getSnapshot: () => value,
    set: (next) => {
      value = next
      writeFilesShowHidden(storage, next)
      emit()
    }
  }
}

let shared: FilesHiddenStore | null = null

function browserStorage(): FilesHiddenStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function filesHiddenStore(): FilesHiddenStore {
  if (!shared) {
    shared = createFilesHiddenStore(browserStorage(), (listener) => {
      if (typeof window === 'undefined') return () => {}
      window.addEventListener('storage', listener)
      return () => window.removeEventListener('storage', listener)
    })
  }
  return shared
}
