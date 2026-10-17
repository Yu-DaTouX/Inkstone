export type SyncResolution = 'local' | 'remote' | 'both'

export type SyncMode = 'manual' | 'auto'

export const AUTO_SYNC_INTERVAL_MS = 60 * 60_000

export function isSyncMode(value: unknown): value is SyncMode {
  return value === 'manual' || value === 'auto'
}

export type SyncRecordKindView = 'settings' | 'prompt' | 'skill' | 'bookmark' | 'schedule'

export interface SyncLastSummary {
  at: number
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: string[]
}

export interface SyncStatusView {
  configured: boolean
  mode: SyncMode
  autoIntervalMs: number
  syncRoot?: string
  lastSync?: SyncLastSummary
  conflictCount: number
  error?: string
}

export interface SyncNowResult {
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: string[]
  at?: number
  error?: string
}

export interface SyncSetModeResult {
  ok: boolean
  mode?: SyncMode
  error?: string
}

export interface SyncConflictView {
  id: string
  key: string
  kind: SyncRecordKindView
  detectedAt: number
  localDeviceName?: string
  remoteDeviceName: string
  localModifiedAt?: number
  remoteModifiedAt: number
  suffix: string
  localPreview?: string
  remotePreview?: string
}

export interface SyncResolveResult {
  ok: boolean
  error?: string
}

export interface SyncConfigureResult {
  ok: boolean
  cancelled?: boolean
  syncRoot?: string
  error?: string
}

export interface SyncExportSessionResult {
  ok: boolean
  path?: string
  bytes?: number
  cancelled?: boolean
  error?: string
}

export interface SyncImportSessionResult {
  ok: boolean
  path?: string
  sessionId?: string
  cancelled?: boolean
  error?: string
}

export interface SyncBridge {
  status(): Promise<SyncStatusView>
  configure(root?: string | null): Promise<SyncConfigureResult>
  setMode(mode: SyncMode): Promise<SyncSetModeResult>
  now(): Promise<SyncNowResult>
  conflicts(): Promise<SyncConflictView[]>
  resolve(id: string, resolution: SyncResolution): Promise<SyncResolveResult>
  exportSession(sessionPath?: string): Promise<SyncExportSessionResult>
  importSession(): Promise<SyncImportSessionResult>
}
