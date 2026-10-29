import type { SyncNote } from '../../shared/sync'

export type SyncRecordKind = 'settings' | 'prompt' | 'skill' | 'bookmark' | 'schedule'

export interface SyncRecord {
  key: string
  kind: SyncRecordKind
  payload: string
  modifiedAt: number
}

export interface RemoteRecord extends SyncRecord {
  deviceId: string
  deviceName: string
  hash: string
}

export interface BaselineEntry {
  localHash?: string
  remoteHash?: string
  syncedAt: number
}

export interface BaselineFile {
  v: 1
  deviceId: string
  records: Record<string, BaselineEntry>
}

export interface ConflictRecord {
  id: string
  key: string
  kind: SyncRecordKind
  detectedAt: number
  localDeviceId?: string
  localDeviceName?: string
  localModifiedAt?: number
  localHash?: string
  localPayload?: string
  remoteDeviceId: string
  remoteDeviceName: string
  remoteModifiedAt: number
  remoteHash: string
  remotePayload: string
  suffix: string
}

export interface SyncReport {
  ok: boolean
  deviceId: string
  deviceName: string
  pushed: string[]
  pulled: string[]
  conflicts: ConflictRecord[]
  skipped: string[]
  errors: SyncNote[]
  at: number
}

export interface SyncPaths {
  settingsFile: string
  promptsDir: string
  skillsDir: string
  schedulesFile: string
  interactionStateDir: string
}
