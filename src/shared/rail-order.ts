export function orderAfterDrag(ids: readonly string[], movedId: string, beforeId: string | null): string[] {
  if (!ids.includes(movedId)) return [...ids]
  if (beforeId === movedId) return [...ids]
  const without = ids.filter((id) => id !== movedId)
  const to = beforeId === null ? without.length : without.indexOf(beforeId)
  if (to < 0) return [...ids]
  const out = [...without]
  out.splice(to, 0, movedId)
  return out
}

export function beforeFromDrop(ids: readonly string[], targetId: string, after: boolean): string | null {
  const i = ids.indexOf(targetId)
  if (i < 0) return null
  if (!after) return targetId
  return ids[i + 1] ?? null
}

export function rankOf(order: readonly string[]): Map<string, number> {
  const rank = new Map<string, number>()
  for (const id of order) if (!rank.has(id)) rank.set(id, rank.size)
  return rank
}
