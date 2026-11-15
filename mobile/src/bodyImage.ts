export type BodyImagePlan =
  | { kind: 'inline'; uri: string }
  | { kind: 'host'; uri: string }
  | { kind: 'remote'; uri: string; host: string }
  | { kind: 'local'; name: string }

const SEGMENT = String.raw`(?!(?:\.|%2e){1,2}(?:/|$))[^/?#\\]+`
const HOST_IMAGE_PATH = new RegExp(`^/remote/v1/sessions/${SEGMENT}/(?:images/${SEGMENT}/\\d+|artifacts/${SEGMENT})$`, 'i')

function squeeze(url: string): string {
  return url.replace(/[\u0000-\u0020\u007f]+/g, '').replace(/\\/g, '/')
}

function hostName(rest: string): string {
  const authority = rest.replace(/^\/+/, '').split(/[/?#]/)[0] ?? ''
  const server = authority.slice(authority.lastIndexOf('@') + 1)
  const name = server.startsWith('[') ? server.slice(0, server.indexOf(']') + 1) : server.split(':')[0]
  return name.toLowerCase()
}

function hostImage(trimmed: string, hostBaseUrl: string | undefined): boolean {
  const base = hostBaseUrl?.trim().replace(/\/+$/, '')
  if (!base || trimmed.length <= base.length) return false
  if (trimmed.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return false
  return HOST_IMAGE_PATH.test(trimmed.slice(base.length))
}

export function planBodyImage(url: string, hostBaseUrl?: string): BodyImagePlan {
  const trimmed = url.trim()
  const flat = squeeze(url)
  if (/^data:image\//i.test(flat)) return { kind: 'inline', uri: trimmed }
  if (trimmed === squeeze(trimmed) && hostImage(trimmed, hostBaseUrl)) return { kind: 'host', uri: trimmed }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(flat)?.[1]?.toLowerCase()
  if (scheme === 'http' || scheme === 'https') return { kind: 'remote', uri: flat, host: hostName(flat.slice(scheme.length + 1)) }
  if (!scheme && flat.startsWith('//')) return { kind: 'remote', uri: `https:${flat}`, host: hostName(flat) }
  return { kind: 'local', name: trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed }
}

export function needsTapToLoad(url: string, hostBaseUrl?: string): boolean {
  return planBodyImage(url, hostBaseUrl).kind === 'remote'
}
