export type SyncResolution = 'local' | 'remote' | 'both'

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
  now(): Promise<SyncNowResult>
  conflicts(): Promise<SyncConflictView[]>
  resolve(id: string, resolution: SyncResolution): Promise<SyncResolveResult>
  exportSession(sessionPath?: string): Promise<SyncExportSessionResult>
  importSession(): Promise<SyncImportSessionResult>
}
