import type { RemoteAccessStatus } from './remote-protocol'

export const PAIR_CODE_LENGTH = 6

export interface PairInvite {
  address: string
  code: string
}

export type PairInviteAddress = { ok: true; address: string; kind: 'tailscale' | 'lan' | 'bound' } | { ok: false; reason: 'stopped' | 'loopback' }

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', ''])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function pairInviteAddress(status: Pick<RemoteAccessStatus, 'running' | 'host' | 'port' | 'addresses'> | null): PairInviteAddress {
  if (!status?.running || !status.port) return { ok: false, reason: 'stopped' }
  const host = status.host.trim()
  if (LOOPBACK_HOSTS.has(host)) return { ok: false, reason: 'loopback' }
  if (!WILDCARD_HOSTS.has(host)) {
    const known = status.addresses.find((entry) => entry.address === host)
    const kind = known?.kind === 'tailscale' || known?.kind === 'lan' ? known.kind : 'bound'
    return { ok: true, address: `http://${host}:${status.port}`, kind }
  }
  const reachable = status.addresses.find((entry) => entry.kind === 'tailscale') ?? status.addresses.find((entry) => entry.kind === 'lan')
  if (!reachable) return { ok: false, reason: 'loopback' }
  return { ok: true, address: `http://${reachable.address}:${status.port}`, kind: reachable.kind === 'tailscale' ? 'tailscale' : 'lan' }
}

export function pairInviteLink(invite: PairInvite): string {
  return `inkstone://pair?address=${encodeURIComponent(invite.address)}&code=${invite.code}`
}

export function normalizePairCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PAIR_CODE_LENGTH)
}

export function validPairAddress(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 300 || /[\u0000-\u001f\u007f\s]/.test(text)) return null
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  return `${url.protocol}//${url.host}`
}

export function parsePairInvite(raw: string): PairInvite | null {
  const text = raw.trim()
  if (!/^inkstone:\/\/pair(?:[/?]|$)/i.test(text)) return null
  const query = text.indexOf('?')
  if (query < 0) return null
  const params = new URLSearchParams(text.slice(query + 1))
  const address = validPairAddress(params.get('address') ?? '')
  const code = normalizePairCode(params.get('code') ?? '')
  if (!address || code.length !== PAIR_CODE_LENGTH) return null
  return { address, code }
}
