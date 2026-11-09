const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function sanitizeWorkFolderName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const cleaned = [...value]
    .filter((char) => char.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(char))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 64)
  if (!cleaned || /^\.+$/.test(cleaned) || RESERVED_NAMES.test(cleaned)) return ''
  return cleaned
}
