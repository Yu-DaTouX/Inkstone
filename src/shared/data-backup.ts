export type BackupAction = 'create' | 'verify' | 'restore' | 'open-restored'

export interface BackupSummary {
  path: string
  createdAt: string
  files: number
  bytes: number
}
export type BackupResult = { ok: true; summary: BackupSummary } | { ok: false; cancelled?: boolean; error?: string }
