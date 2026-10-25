import { isLinkLocalHost, isPrivateHost, sameLocalHost } from './network-boundary'

export type ExternalBoundaryDecision = 'allow' | 'block-private' | 'check-dns'

export function decideExternalRequest(input: {
  url: string
  resourceType: string
  pageUrl: string
  requestedByUs: boolean
}): ExternalBoundaryDecision {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return 'allow'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'allow'
  if (isLinkLocalHost(parsed.hostname)) return 'block-private'
  if (sameLocalHost(input.pageUrl, parsed.hostname)) return 'allow'
  if (!isPrivateHost(parsed.hostname)) return 'check-dns'
  return input.requestedByUs && input.resourceType === 'Document' ? 'allow' : 'block-private'
}
