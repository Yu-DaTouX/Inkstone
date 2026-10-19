const MAX_DEPTH = 8

function equalAt(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (depth >= MAX_DEPTH) return false
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    const left = a as unknown[]
    const right = b as unknown[]
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) if (!equalAt(left[i], right[i], depth + 1)) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = Object.keys(ao)
  if (keys.length !== Object.keys(bo).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key) || !equalAt(ao[key], bo[key], depth + 1)) return false
  }
  return true
}

export function structurallyEqual(a: unknown, b: unknown): boolean {
  return equalAt(a, b, 0)
}

export function keepRef<T>(prev: T, next: T): T {
  return structurallyEqual(prev, next) ? prev : next
}
