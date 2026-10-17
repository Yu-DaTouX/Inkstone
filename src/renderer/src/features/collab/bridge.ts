import type { CollabBridge } from '../../../../shared/collab'
import type { PeerOperation, PeerGrantView, PeerRecordView } from '../../../../shared/peer-protocol'

const COLLAB_METHODS: ReadonlyArray<keyof CollabBridge> = [
  'overview',
  'remoteProject',
  'link',
  'fetch',
  'compare',
  'fileDiff',
  'merge',
  'abortMerge',
  'push',
  'closeRequest',
  'continueFrom'
]

export function collabBridge(): CollabBridge | null {
  const yan = (window as unknown as { yan?: { collab?: CollabBridge } }).yan
  const collab = yan?.collab
  if (!collab) return null
  for (const method of COLLAB_METHODS) {
    if (typeof collab[method] !== 'function') return null
  }
  return collab
}

export type PeerCallResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export interface CollabPeerBridge {
  pair(address: string, code: string): Promise<PeerCallResult<PeerRecordView>>
  remove(peerId: string): Promise<boolean>
  connect(peerId: string, operations: PeerOperation[], note: string): Promise<PeerCallResult<PeerGrantView>>
  disconnect(peerId: string): Promise<void>
}

export function collabPeerBridge(): CollabPeerBridge | null {
  const yan = (window as unknown as { yan?: { peer?: Partial<CollabPeerBridge> } }).yan
  const peer = yan?.peer
  if (
    !peer ||
    typeof peer.pair !== 'function' ||
    typeof peer.remove !== 'function' ||
    typeof peer.connect !== 'function' ||
    typeof peer.disconnect !== 'function'
  ) {
    return null
  }
  return peer as CollabPeerBridge
}

export interface PairLink {
  address: string
  code: string
}

export function parsePairLink(raw: string): PairLink | null {
  const text = raw.trim()
  if (!/^inkstone:\/\/pair\b/i.test(text)) return null
  const query = text.indexOf('?')
  if (query < 0) return null
  const params = new URLSearchParams(text.slice(query + 1))
  const address = (params.get('address') ?? '').trim()
  const code = (params.get('code') ?? '').replace(/\D/g, '').slice(0, 6)
  if (!address && !code) return null
  return { address, code }
}
