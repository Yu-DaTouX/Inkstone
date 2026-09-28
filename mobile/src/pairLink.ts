import { normalizeBaseUrl } from './api/client'

export interface PairingPrefill {
  address: string
  code: string
}

/** The QR carries only the temporary address and six-digit pairing code, never a device token. */
export function parsePairingLink(url: string): PairingPrefill | null {
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
