export type BackupAction = 'create' | 'verify' | 'restore' | 'open-restored'

export interface DamagedSessionRecords {
  path: string
  lines: number[]
  total: number
}

export interface BackupSummary {
  path: string
  createdAt: string
  files: number
  bytes: number
  damagedRecords?: DamagedSessionRecords[]
}
export type BackupResult = { ok: true; summary: BackupSummary } | { ok: false; cancelled?: boolean; error?: string }
