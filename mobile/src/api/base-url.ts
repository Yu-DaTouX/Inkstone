export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const match = /^(?:(https?):\/\/)?(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(trimmed)
  if (!match) return ''
  const scheme = (match[1] ?? 'http').toLowerCase()
  const port = match[3] ? Number(match[3]) : scheme === 'http' ? 37892 : 443
  if (port < 1 || port > 65535) return ''
  return `${scheme}://${match[2]}:${port}`
}
