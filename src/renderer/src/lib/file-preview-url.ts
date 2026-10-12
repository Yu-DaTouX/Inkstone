export function filePreviewUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/')
  const encoded = segments.map((segment, index) => index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment))
  return `file:///${encoded.join('/')}`
}
