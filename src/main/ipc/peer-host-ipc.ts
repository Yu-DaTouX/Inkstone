import type { IpcRegistrar } from './registrar'
import { PEER_OPERATIONS } from '../../shared/peer-protocol'
import type { PeerGrantRegistry } from '../peer-grants'

export interface PeerHostIpcDeps {
  grants: PeerGrantRegistry
}

export function registerPeerHostIpc(ipc: IpcRegistrar, deps: PeerHostIpcDeps): void {
  const { handle } = ipc
  const { grants } = deps
  handle('yan:peer-host:pending', () => grants.pendingRequests())
  handle('yan:peer-host:decide', (decision: unknown) => {
    const raw = (decision ?? {}) as { requestId?: unknown; approve?: unknown; projectIds?: unknown; operations?: unknown }
    if (typeof raw.requestId !== 'string') return false
    return grants.decide({
      requestId: raw.requestId,
      approve: raw.approve === true,
      projectIds: Array.isArray(raw.projectIds) ? raw.projectIds.filter((id): id is string => typeof id === 'string') : [],
      operations: Array.isArray(raw.operations) ? PEER_OPERATIONS.filter((op) => (raw.operations as unknown[]).includes(op)) : []
    })
  })
  handle('yan:peer-host:revoke', (connectionId: unknown) => (typeof connectionId === 'string' ? grants.revoke(connectionId) : false))
}
