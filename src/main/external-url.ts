const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function openableExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 8192) return null
  try {
    const url = new URL(value)
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

export function openableAuthUrl(raw: unknown): string | null {
  const url = openableExternalUrl(raw)
  return url && url.startsWith('https:') ? url : null
}
