function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  for (const k of ak) {
    if (!(k in bo) || !deepEqual(ao[k], bo[k])) return false
  }
  return true
}

export function reuseIfSame<T>(prev: readonly T[], next: readonly T[]): readonly T[] {
  if (prev === next) return prev
  let allSame = prev.length === next.length
  const merged = next.map((item, i) => {
    if (i < prev.length && deepEqual(prev[i], item)) return prev[i]
    allSame = false
    return item
  })
  return allSame ? prev : merged
}
