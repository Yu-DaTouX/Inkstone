export type BackupAction = 'create' | 'verify' | 'restore' | 'open-restored'

export type BackupPartId = 'sessions' | 'attachments' | 'artifacts' | 'session-quotes'

export const BACKUP_PART_LABELS: Record<BackupPartId, { zh: string; en: string }> = {
  sessions: { zh: '会话记录', en: 'Session records' },
  attachments: { zh: '附件', en: 'Attachments' },
  artifacts: { zh: '成果文件', en: 'Artifacts' },
  'session-quotes': { zh: '引用片段', en: 'Quoted snippets' }
}

export interface BackupPartUsage {
  part: BackupPartId
  files: number
  bytes: number
}

export interface BackupChange {
  path: string
  kind: 'modified' | 'removed' | 'added'
}

export interface BackupTooLarge {
  parts: BackupPartUsage[]
  suggested: BackupPartId[]
  maxFiles: number
  maxBytes: number
}

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
  skipped?: BackupPartUsage[]
  changed?: BackupChange[]
  changedTotal?: number
}
export type BackupResult = { ok: true; summary: BackupSummary } | { ok: false; cancelled?: boolean; error?: string }
