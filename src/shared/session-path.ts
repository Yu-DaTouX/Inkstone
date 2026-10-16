export function normalizeLayoutPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function samePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return normalizeLayoutPath(a) === normalizeLayoutPath(b)
}
