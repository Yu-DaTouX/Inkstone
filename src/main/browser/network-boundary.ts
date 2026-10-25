import { isPrivateAddress, resolvesToPrivateAddress } from './network-policy'

export type BoundaryDecision = 'allow' | 'block-private' | 'check-dns'

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    isPrivateAddress(h) ||
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '[::1]' ||
    h.endsWith('.localhost') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
}

export function isLinkLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').split('%', 1)[0]
  if (/^169\.254\./.test(h)) return true
  return /^fe[89ab][0-9a-f]:/.test(h)
}

export async function shouldBlockHiddenPageRequest(
  url: string,
  resolves: (hostname: string) => Promise<boolean> = resolvesToPrivateAddress
): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return true
  const host = parsed.hostname
  if (isLinkLocalHost(host) || isPrivateHost(host)) return true
  return resolves(host)
}

export function isLoopbackOrigin(value: string): boolean {
  try {
    return isPrivateHost(new URL(value).hostname)
  } catch {
    return false
  }
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)
}

export function sameLocalHost(originUrl: string, targetHost: string): boolean {
  let origin: string
  try {
    origin = new URL(originUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  const target = targetHost.toLowerCase()
  if (!isPrivateHost(origin)) return false
  return origin === target || (isLoopbackHost(origin) && isLoopbackHost(target))
}

export function decideRequestBoundary(input: {
  targetHost: string
  initiatorUrl: string
  requestedByUs: boolean
  resourceType?: string
}): BoundaryDecision {
  const { targetHost, initiatorUrl, requestedByUs, resourceType } = input
  if (isLinkLocalHost(targetHost)) return 'block-private'
  if (sameLocalHost(initiatorUrl, targetHost)) return 'allow'
  if (!isPrivateHost(targetHost)) return 'check-dns'
  return requestedByUs && resourceType === 'mainFrame' ? 'allow' : 'block-private'
}
