export interface CheckpointRecord {
  id: string
  sessionKey: string
  at: number
  textHash: string
  preview: string
  kind: 'turn' | 'restore'
}

export interface CheckpointChange {
  path: string
  status: 'M' | 'A' | 'D'
}

export interface CheckpointPreview {
  ok: boolean
  error?: string
  changes: CheckpointChange[]
  total: number
}

export interface CheckpointRestoreResult {
  ok: boolean
  error?: string
  undoId?: string
  restored: number
}

export interface WorkspaceFit {
  files: number
  tooManyFiles: boolean
  oversizedFiles: number
  largest: { path: string; bytes: number } | null
  totalBytes: number
  tooLarge: boolean
  fits: boolean
}

export function textFingerprint(text: string): string {
  let h = 2166136261
  const s = text.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(16)}:${s.length}`
}

export function matchCheckpoint(records: readonly CheckpointRecord[], text: string, timestamp: number | undefined): CheckpointRecord | null {
  const hash = textFingerprint(text)
  let best: CheckpointRecord | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const record of records) {
    if (record.kind !== 'turn' || record.textHash !== hash) continue
    const gap = timestamp ? Math.abs(record.at - timestamp) : 0
    if (timestamp && gap > 10 * 60 * 1000) continue
    if (gap < bestGap) {
      best = record
      bestGap = gap
    }
  }
  return best
}
