import { isLinkLocalAddress, isMetadataAddress } from '../net/address-policy'
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
  return isLinkLocalAddress(hostname)
}

export function isMetadataHost(hostname: string): boolean {
  return isMetadataAddress(hostname)
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
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false
  if (parsed.username || parsed.password) return true
  const host = parsed.hostname
  if (isLinkLocalHost(host) || isMetadataHost(host) || isPrivateHost(host)) return true
  return resolves(host)
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
  if (isLinkLocalHost(targetHost) || isMetadataHost(targetHost)) return 'block-private'
  if (sameLocalHost(initiatorUrl, targetHost)) return 'allow'
  if (!isPrivateHost(targetHost)) return 'check-dns'
  return requestedByUs && resourceType === 'mainFrame' ? 'allow' : 'block-private'
}
