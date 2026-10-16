export function nativeActiveBranch(entries: Record<string, unknown>[], leafId: string | null): Record<string, unknown>[] {
  if (leafId === null) return []
  const byId = new Map(entries.filter(e => typeof e.id === 'string').map(e => [e.id as string, e]))
  if (!byId.has(leafId)) throw new Error('原生会话叶子不在持久条目中')
  const seen = new Set<string>()
  const path: Record<string, unknown>[] = []
  let id: string | null = leafId
  while (id) {
    if (seen.has(id)) throw new Error('会话条目父链存在循环')
    seen.add(id)
    const entry = byId.get(id)
    if (!entry) break
    path.push(entry)
    id = typeof entry.parentId === 'string' ? entry.parentId : null
  }
  return path.reverse()
}
