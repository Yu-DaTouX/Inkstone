export function fileUrl(path: string): string {
  const slashes = path.replace(/\\/g, '/')
  if (slashes.startsWith('//')) {
    const [host, ...parts] = slashes.slice(2).split('/')
    return `file://${host}/${parts.map((segment) => encodeURIComponent(segment)).join('/')}`
  }
  const normalized = slashes.replace(/^\/+/, '')
  const encoded = normalized
    .split('/')
    .map((segment, index) => (index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file:///${encoded}`
}
