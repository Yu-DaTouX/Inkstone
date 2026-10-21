import { normalizeBaseUrl } from './api/base-url'
import { parseRelayLink, type RelayPairing } from './api/relay'

export interface PairingPrefill {
  address: string
  code: string
  relay?: RelayPairing
}

export function parsePairingLink(url: string): PairingPrefill | null {
  const relay = parseRelayLink(url)
  if (relay) return { address: `经中继连接 ${relay.computerName}`, code: relay.code, relay }
  const match = /^inkstone:\/\/pair\?([^#]+)$/i.exec(url)
  if (!match) return null
  const query = new Map<string, string>()
  for (const segment of match[1].split('&')) {
    const split = segment.indexOf('=')
    if (split < 0) return null
    try {
      query.set(decodeURIComponent(segment.slice(0, split)), decodeURIComponent(segment.slice(split + 1)))
    } catch {
      return null
    }
  }
  const address = normalizeBaseUrl(query.get('address') ?? '')
  const code = query.get('code') ?? ''
  return address && /^\d{6}$/.test(code) ? { address, code } : null
}
