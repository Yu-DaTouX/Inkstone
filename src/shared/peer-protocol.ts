export type PeerOperation = 'read' | 'transfer' | 'send' | 'pull' | 'push'
export const PEER_OPERATIONS: PeerOperation[] = ['read', 'transfer', 'send', 'pull', 'push']

export const PEER_APPROVAL_TIMEOUT_MS = 2 * 60_000
export const PEER_ACTIVATION_TIMEOUT_MS = 30_000
export const PEER_CONNECTION_HEADER = 'x-yan-connection'
export const PEER_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024

export interface PeerConnectRequest {
  operations: PeerOperation[]
  note?: string
}

export interface PeerProjectRef {
  id: string
  name: string
}

export interface PeerGrantView {
  connectionId: string
  deviceId: string
  deviceName: string
  projects: PeerProjectRef[]
  operations: PeerOperation[]
  grantedAt: number
  activatedAt: number | null
}

export interface PeerApprovalRequest {
  requestId: string
  deviceId: string
  deviceName: string
  operations: PeerOperation[]
  note: string
  projects: PeerProjectRef[]
  expiresAt: number
}

export interface PeerApprovalDecision {
  requestId: string
  approve: boolean
  projectIds: string[]
  operations: PeerOperation[]
}

export interface PeerExportedArtifact {
  id: string
  filename: string
  mediaType: string
  bytes: number
  available: boolean
}

export interface PeerSessionExport {
  version: 1
  source: {
    computer: string
    sessionId: string
    projectId: string
    projectName: string
    title: string
    exportedAt: number
    updatedAt: number
    messageCount: number
    prRefs?: import('./collab-github').PrRef[]
  }
  messages: unknown[]
  artifacts: PeerExportedArtifact[]
  truncated: boolean
}

export interface PeerRecordView {
  id: string
  computer: string
  address: string
  pairedAt: number
}

export type PeerConnectionState =
  | { state: 'idle' }
  | { state: 'waiting'; since: number }
  | { state: 'connected'; grant: PeerGrantView }
  | { state: 'ended' }
  | { state: 'failed'; error: string }

export interface PeerStatusView {
  peers: Array<PeerRecordView & { connection: PeerConnectionState }>
  imports: PeerImportView[]
}

export interface PeerImportView {
  id: string
  kind: 'session'
  title: string
  computer: string
  projectName: string
  sourceSessionId: string
  importedAt: number
  exportedAt: number
  messageCount: number
  prRefs?: import('./collab-github').PrRef[]
  artifacts: Array<{ id: string; filename: string; status: 'copied' | 'missing' | 'too_large' }>
}
