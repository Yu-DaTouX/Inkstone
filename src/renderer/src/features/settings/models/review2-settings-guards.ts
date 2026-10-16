export function peerBrowseBelongsTo(current: { peerId: string } | null, peerId: string): boolean {
  return current?.peerId === peerId
}

export function mergeDiscoveredModels<T extends { id: string }>(
  current: T[], discovered: T[], merge: (latest: T, found: T) => T
): T[] {
  const byId = new Map(discovered.map((entry) => [entry.id, entry]))
  const kept = current.filter((entry) => entry.id.trim()).map((entry) => {
    const found = byId.get(entry.id.trim())
    return found ? merge(entry, found) : entry
  })
  const ids = new Set(kept.map((entry) => entry.id.trim()))
  return [...kept, ...discovered.filter((entry) => !ids.has(entry.id))]
}

export function boundedPending<T extends { data: string }>(queue: T[], next: T, maxItems: number, maxChars: number): T[] | null {
  const candidate = [...queue, next]
  return candidate.length <= maxItems && candidate.reduce((sum, item) => sum + item.data.length, 0) <= maxChars ? candidate : null
}

export function isCurrentGeneration(current: number, response: number): boolean {
  return current === response
}

export function canReplaceDraft<T>(draft: T, previousSaved: T): boolean {
  return JSON.stringify(draft) === JSON.stringify(previousSaved)
}
