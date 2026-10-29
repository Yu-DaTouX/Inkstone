import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteAccessStatus } from '../../../../shared/remote-protocol'

const REMOTE_POLL_MS = 5000

export interface RemoteStatusBridge {
  status(): Promise<RemoteAccessStatus | null>
  pair(): Promise<RemoteAccessStatus | null>
  cancelPairing(): Promise<RemoteAccessStatus | null>
}

export interface PeerHostBridge {
  hostRevoke(connectionId: string): Promise<boolean>
}

export interface RemoteStatusState {
  remote: RemoteStatusBridge | null
  status: RemoteAccessStatus | null
  loaded: boolean
  error: string
  setError(error: string): void
  apply(next: RemoteAccessStatus | null): void
  refresh(): Promise<void>
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function remoteStatusBridge(): RemoteStatusBridge | null {
  const remote = typeof window !== 'undefined' ? (window as unknown as { yan?: { remote?: Partial<RemoteStatusBridge> } }).yan?.remote : undefined
  if (!remote || typeof remote.status !== 'function' || typeof remote.pair !== 'function' || typeof remote.cancelPairing !== 'function') return null
  return remote as RemoteStatusBridge
}

export function peerHostBridge(): PeerHostBridge | null {
  const peer = typeof window !== 'undefined' ? (window as unknown as { yan?: { peer?: Partial<PeerHostBridge> } }).yan?.peer : undefined
  if (!peer || typeof peer.hostRevoke !== 'function') return null
  return peer as PeerHostBridge
}

export function useRemoteStatus(): RemoteStatusState {
  const [remote] = useState(remoteStatusBridge)
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    if (!remote) return
    try {
      const next = await remote.status()
      if (alive.current) setStatus(next)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setLoaded(true)
    }
  }, [remote])

  const apply = useCallback((next: RemoteAccessStatus | null): void => {
    if (alive.current) setStatus(next)
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REMOTE_POLL_MS)
    return () => {
      alive.current = false
      window.clearInterval(id)
    }
  }, [refresh])

  return { remote, status, loaded, error, setError, apply, refresh }
}
