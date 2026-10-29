export type SyncResolution = 'local' | 'remote' | 'both'

export type SyncNoteCode =
  | 'sync.raw'
  | 'folder.missing'
  | 'folder.unwritable'
  | 'folder.uncreatable'
  | 'config.missing'
  | 'mode.unknown'
  | 'resolution.unknown'
  | 'conflict.missing'
  | 'conflict.unreadable'
  | 'conflict.changed'
  | 'conflict.failed'
  | 'record.failed'
  | 'record.forbidden'
  | 'baseline.writeFailed'
  | 'session.missing'
  | 'session.cancelled'
  | 'session.exportFailed'
  | 'session.importFailed'
  | 'unknown'

export interface SyncNote {
  code: SyncNoteCode
  params?: Record<string, string | number>
}

export function syncNote(code: SyncNoteCode, params?: Record<string, string | number>): SyncNote {
  return params ? { code, params } : { code }
}

export function isSyncNote(value: unknown): value is SyncNote {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<SyncNote>
  return typeof raw.code === 'string' && raw.code.length > 0
}

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
  errors: SyncNote[]
}

export interface SyncStatusView {
  configured: boolean
  mode: SyncMode
  autoIntervalMs: number
  syncRoot?: string
  lastSync?: SyncLastSummary
  conflictCount: number
  error?: SyncNote
}

export interface SyncNowResult {
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: SyncNote[]
  at?: number
  error?: SyncNote
}

export interface SyncSetModeResult {
  ok: boolean
  mode?: SyncMode
  error?: SyncNote
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
  error?: SyncNote
}

export interface SyncConfigureResult {
  ok: boolean
  cancelled?: boolean
  syncRoot?: string
  error?: SyncNote
}

export interface SyncExportSessionResult {
  ok: boolean
  path?: string
  bytes?: number
  cancelled?: boolean
  error?: SyncNote
}

export interface SyncImportSessionResult {
  ok: boolean
  path?: string
  sessionId?: string
  cancelled?: boolean
  error?: SyncNote
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
