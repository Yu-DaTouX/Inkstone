export type FileTabSize = 2 | 4 | 8

export interface FileViewSettings {
  wordWrap: boolean
  indentGuides: boolean
  showWhitespace: boolean
  scrollPastEnd: boolean
  tabSize: FileTabSize
  previewTabs: boolean
}

export type FileViewSettingKey = keyof FileViewSettings

export const FILE_TAB_SIZES: readonly FileTabSize[] = [2, 4, 8]

export const FILE_VIEW_STORAGE_KEYS: Readonly<Record<FileViewSettingKey, string>> = {
  wordWrap: 'yan.files.wordWrap',
  indentGuides: 'yan.files.indentGuides',
  showWhitespace: 'yan.files.showWhitespace',
  scrollPastEnd: 'yan.files.scrollPastEnd',
  tabSize: 'yan.files.tabSize',
  previewTabs: 'yan.files.previewTabs'
}

export const DEFAULT_FILE_VIEW_SETTINGS: Readonly<FileViewSettings> = {
  wordWrap: true,
  indentGuides: true,
  showWhitespace: false,
  scrollPastEnd: false,
  tabSize: 4,
  previewTabs: true
}

const SETTING_KEYS = Object.keys(FILE_VIEW_STORAGE_KEYS) as FileViewSettingKey[]

export function normalizeFileViewSetting<K extends FileViewSettingKey>(key: K, value: unknown): FileViewSettings[K] {
  if (key === 'tabSize') {
    return (FILE_TAB_SIZES.includes(value as FileTabSize) ? value : DEFAULT_FILE_VIEW_SETTINGS.tabSize) as FileViewSettings[K]
  }
  return (typeof value === 'boolean' ? value : DEFAULT_FILE_VIEW_SETTINGS[key]) as FileViewSettings[K]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface StorageChange {
  key: string | null
  storageArea?: unknown
}

export interface FileViewSettingsStore {
  getSnapshot(): FileViewSettings
  subscribe(listener: () => void): () => void
  set<K extends FileViewSettingKey>(key: K, value: FileViewSettings[K]): void
  dispose(): void
}

function readSetting<K extends FileViewSettingKey>(storage: StorageLike | null, key: K): FileViewSettings[K] {
  try {
    const raw = storage?.getItem(FILE_VIEW_STORAGE_KEYS[key])
    return normalizeFileViewSetting(key, raw == null ? null : JSON.parse(raw))
  } catch {
    return DEFAULT_FILE_VIEW_SETTINGS[key]
  }
}

export function readFileViewSettings(storage: StorageLike | null): FileViewSettings {
  const next = { ...DEFAULT_FILE_VIEW_SETTINGS }
  for (const key of SETTING_KEYS) (next as Record<FileViewSettingKey, unknown>)[key] = readSetting(storage, key)
  return next
}

function sameSettings(a: FileViewSettings, b: FileViewSettings): boolean {
  return SETTING_KEYS.every((key) => a[key] === b[key])
}

export function createFileViewSettings(options: {
  storage: StorageLike | null
  subscribeStorage?: (listener: (change: StorageChange) => void) => () => void
}): FileViewSettingsStore {
  const { storage } = options
  let current = readFileViewSettings(storage)
  const listeners = new Set<() => void>()
  const publish = (next: FileViewSettings): void => {
    if (sameSettings(next, current)) return
    current = next
    for (const listener of [...listeners]) listener()
  }
  const watched = new Set(Object.values(FILE_VIEW_STORAGE_KEYS))
  const off =
    options.subscribeStorage?.((change) => {
      if (change.storageArea && change.storageArea !== storage) return
      if (change.key === null || watched.has(change.key)) publish(readFileViewSettings(storage))
    }) ?? (() => {})
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(key, value) {
      if (!SETTING_KEYS.includes(key)) return
      const normalized = normalizeFileViewSetting(key, value)
      try {
        storage?.setItem(FILE_VIEW_STORAGE_KEYS[key], JSON.stringify(normalized))
      } catch {
      }
      publish({ ...current, [key]: normalized })
    },
    dispose() {
      off()
      listeners.clear()
    }
  }
}
