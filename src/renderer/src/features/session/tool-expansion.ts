export const EXPANSION_LIMIT = 1000

export interface ExpansionStore {
  get(scope: string, id: string): boolean | undefined
  set(scope: string, id: string, open: boolean): void
  forget(scope: string): void
  clear(): void
  size(): number
  version(): number
  subscribe(listener: () => void): () => void
}

const SEP = '\u0000'

export function expansionKey(scope: string, id: string): string {
  return `${scope}${SEP}${id}`
}

export function createExpansionStore(limit = EXPANSION_LIMIT): ExpansionStore {
  const entries = new Map<string, boolean>()
  const listeners = new Set<() => void>()
  let revision = 0
  const emit = (): void => {
    revision += 1
    for (const listener of [...listeners]) listener()
  }
  return {
    get(scope, id) {
      return entries.get(expansionKey(scope, id))
    },
    set(scope, id, open) {
      const key = expansionKey(scope, id)
      if (entries.get(key) === open) {
        entries.delete(key)
        entries.set(key, open)
        return
      }
      entries.delete(key)
      entries.set(key, open)
      while (entries.size > Math.max(1, limit)) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      emit()
    },
    forget(scope) {
      const prefix = `${scope}${SEP}`
      let removed = false
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key)
          removed = true
        }
      }
      if (removed) emit()
    },
    clear() {
      if (!entries.size) return
      entries.clear()
      emit()
    },
    size() {
      return entries.size
    },
    version() {
      return revision
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export const toolExpansion = createExpansionStore()

export function forgetToolExpansion(scope: string): void {
  toolExpansion.forget(scope)
}
