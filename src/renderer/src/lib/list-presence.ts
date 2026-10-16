export const LIST_EXIT_MS = 240
export const LIST_STAGGER_MS = 60
export const LIST_MAX_STAGGER = 8

export type ListPhase = 'stable' | 'entering' | 'exiting'

export interface ListPresenceInput<T> {
  id: string
  item: T
}

export interface ListPresenceRow<T> {
  id: string
  item: T
  phase: ListPhase
  stagger: number
  interactive: boolean
}

export interface ListPresenceOptions {
  motion?: boolean
}

export interface ListPresence<T> {
  reconcile(current: readonly ListPresenceInput<T>[], options?: ListPresenceOptions): ListPresenceRow<T>[]
  settle(id: string): boolean
  reset(): void
  exitingIds(): string[]
}

export function listStaggerIndex(order: number): number {
  if (!Number.isFinite(order) || order <= 0) return 0
  return Math.min(Math.floor(order), LIST_MAX_STAGGER - 1)
}

export function createListPresence<T>(): ListPresence<T> {
  let baseline: string[] | null = null
  let items = new Map<string, T>()
  const exiting = new Map<string, { item: T; index: number }>()
  let lastSignature = ''
  let lastRows: ListPresenceRow<T>[] | null = null

  const clearCache = (): void => {
    lastSignature = ''
    lastRows = null
  }

  return {
    reconcile(current, options) {
      const motion = options?.motion !== false
      const signature = `${motion ? 'm' : 'r'}|${current.map((x) => x.id).join('\u0000')}`
      if (lastRows && signature === lastSignature) {
        const byId = new Map(current.map((x) => [x.id, x.item] as const))
        for (const [id, item] of byId) items.set(id, item)
        lastRows = lastRows.map((row) => (byId.has(row.id) ? { ...row, item: byId.get(row.id) as T } : row))
        return lastRows
      }

      const currentIds = current.map((x) => x.id)

      if (baseline === null) {
        baseline = currentIds
        items = new Map(current.map((x) => [x.id, x.item] as const))
        exiting.clear()
        lastRows = current.map(({ id, item }) => ({ id, item, phase: 'stable', stagger: 0, interactive: true }))
        lastSignature = signature
        return lastRows
      }

      const previous = new Set(baseline)
      const currentSet = new Set(currentIds)
      const entering = currentIds.filter((id) => !previous.has(id))
      const removing = baseline.filter((id) => !currentSet.has(id))

      if (!motion) exiting.clear()
      for (const id of removing) {
        if (!motion) continue
        if (exiting.has(id)) continue
        const snapshot = items.get(id)
        if (snapshot === undefined) continue
        exiting.set(id, { item: snapshot, index: baseline.indexOf(id) })
      }
      for (const id of currentIds) exiting.delete(id)

      const enteringOrder = new Map<string, number>()
      entering.forEach((id, i) => enteringOrder.set(id, listStaggerIndex(i)))

      const rows: ListPresenceRow<T>[] = current.map(({ id, item }) => ({
        id,
        item,
        phase: enteringOrder.has(id) ? 'entering' : 'stable',
        stagger: enteringOrder.get(id) ?? 0,
        interactive: true
      }))

      const exitRows = [...exiting.entries()]
        .sort((a, b) => a[1].index - b[1].index)
        .map(([id, snapshot]) => ({ id, item: snapshot.item, phase: 'exiting' as const, stagger: 0, interactive: false }))
      for (const exitRow of exitRows) {
        const at = Math.max(0, Math.min(exiting.get(exitRow.id)?.index ?? rows.length, rows.length))
        rows.splice(at, 0, exitRow)
      }

      baseline = currentIds
      items = new Map(current.map((x) => [x.id, x.item] as const))
      lastRows = rows
      lastSignature = signature
      return rows
    },

    settle(id) {
      const removed = exiting.delete(id)
      if (removed) clearCache()
      return removed
    },

    reset() {
      baseline = null
      items = new Map()
      exiting.clear()
      clearCache()
    },

    exitingIds() {
      return [...exiting.keys()]
    }
  }
}
