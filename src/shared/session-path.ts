export function normalizeLayoutPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}
