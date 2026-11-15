const NETWORK_PREFIX = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/
const LOCAL_DRIVE_DEVICE = /^[\\/]{2}[?.][\\/](?=[a-zA-Z]:(?:[\\/]|$))/
const DOT_SEGMENT = /(?:^|[\\/])[. ]*\.[. ]*(?:[\\/]|$)/

function decoded(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function networkLocalPath(value: string): boolean {
  if (LOCAL_DRIVE_DEVICE.test(value)) return DOT_SEGMENT.test(value.replace(LOCAL_DRIVE_DEVICE, ''))
  return NETWORK_PREFIX.test(value)
}

export function isNetworkPath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim()
  const url = /^file:([\s\S]*)$/i.exec(text)
  if (!url) return networkLocalPath(text)
  const rest = decoded(url[1])
  const authority = /^[\\/]{2}([^\\/]*)/.exec(rest)
  if (!authority) return networkLocalPath(rest)
  const host = authority[1]
  if (host && host.toLowerCase() !== 'localhost') return true
  return networkLocalPath(rest.slice(2 + host.length))
}
