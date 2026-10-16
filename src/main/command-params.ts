export function paramString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function paramNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
