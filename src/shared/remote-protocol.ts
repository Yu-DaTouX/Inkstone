export const REMOTE_PROTOCOL_VERSION = 2
export const REMOTE_DEFAULT_PORT = 37892
export const REMOTE_PAIRING_TTL_MS = 5 * 60_000
export const REMOTE_PAIRING_CODE_RE = /^\d{6}$/
export const REMOTE_EVENT_BUFFER = 1_000
export const REMOTE_IDEMPOTENCY_HEADER = 'idempotency-key'
export const REMOTE_IDEMPOTENCY_TTL_MS = 10 * 60_000
export const REMOTE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
export const REMOTE_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024

export interface RemoteInfo {
  ok: true
  apiVersion: number
  transport: Array<'http' | 'sse'>
  tokenRequired: true
  capabilities: string[]
  capabilityDetails?: import('./agent-service').ServiceCapability[]
  device: RemoteDeviceSummary | null
  computer?: { name: string }
}

export interface RemotePairRequest {
  code: string
  deviceName: string
  kind?: 'phone' | 'peer' | 'agent'
}

export interface RemotePairResponse {
  ok: true
  deviceId: string
  token: string
  apiVersion: number
  computer?: { name: string }
  device?: RemoteDeviceSummary
}

export interface RemoteImageInput {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  data: string
}

export interface RemoteModel {
  id: string
  provider: string
  name: string
  input?: string[]
}

export interface RemoteDeviceSummary {
  id: string
  name: string
  kind?: 'phone' | 'peer' | 'agent'
  createdAt: number
  lastSeenAt: number | null
}

export interface RemoteDeviceRecord extends RemoteDeviceSummary {
  revokedAt: number | null
}

export interface RemoteAccessStatus {
  enabled: boolean
  running: boolean
  host: string
  port: number
  addresses: Array<{ kind: 'tailscale' | 'lan' | 'loopback'; address: string }>
  pairing: { code: string; expiresAt: number } | null
  devices: RemoteDeviceRecord[]
  grants: import('./peer-protocol').PeerGrantView[]
  error: string | null
  relay?: RemoteRelayStatus
}

export interface RemoteRelaySettings {
  enabled: boolean
  url: string
}

export interface RemoteRelayClient {
  id: string
  name: string
  kind: 'phone' | 'agent'
  addedAt: number
  lastSeenAt: number | null
  revokedAt: number | null
  online: boolean
}

export interface RemoteRelayStatus {
  enabled: boolean
  url: string
  connected: boolean
  detail: string | null
  clients: RemoteRelayClient[]
  pairing: { kind: 'phone' | 'agent'; link: string; expiresAt: number } | null
}

export interface RemoteAccessSettings {
  enabled: boolean
  bind: 'tailscale' | 'loopback' | string
  port: number
  relay?: RemoteRelaySettings
}

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  bind: 'tailscale',
  port: REMOTE_DEFAULT_PORT
}

export interface RemoteEventEnvelope {
  seq: number
  at: number
  channel: string
  payload: unknown
  runtime?: unknown
}

export interface RemoteResyncEvent {
  reason: 'buffer_overflow' | 'server_restarted'
  latestSeq: number
}

export interface RemotePendingQuestion {
  id: string
  sessionId: string | null
  runId: string
  method: 'select' | 'input' | 'confirm' | 'editor'
  title: string
  message: string
  options?: string[]
  placeholder?: string
  sensitive: boolean
  approvalDigest?: string
  deadline: number
}

export type RemoteAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }

export interface RemoteHumanApproval {
  sessionId: string | null
  runId: string
  digest: string
  confirmed: boolean
}

export interface RemoteArtifact {
  id: string
  filename: string
  mediaType: string
  kind: 'image' | 'svg' | 'code' | 'document' | 'binary'
  bytes: number
  createdAt: number
  previewable: boolean
  unavailable?: boolean
}

export interface RemoteError {
  ok: false
  error: string
  code?: string
}
