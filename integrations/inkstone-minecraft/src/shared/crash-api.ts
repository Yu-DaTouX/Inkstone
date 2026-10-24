import type { LoaderKind } from './api.ts'

export type CrashConfidence = 'high' | 'medium'
export type CrashEvidenceSource = 'process' | 'latest.log' | 'crash-report' | 'hs_err'
export type CrashActionKind = 'install-deps' | 'disable-mod' | 'java' | 'memory' | 'mods' | 'repair' | 'export'

export interface CrashEvidence {
  source: CrashEvidenceSource
  text: string
}

export interface CrashSuspect {
  modId: string
  name: string
  fileName: string
  hits: number
  reasons: string[]
}

export interface CrashRuleMatch {
  id: string
  title: string
  explanation: string
  confidence: CrashConfidence
  evidence: CrashEvidence[]
}

export interface CrashAction {
  kind: CrashActionKind
  label: string
  hint: string | null
  value: string | null
}

export interface CrashDiagnosis {
  id: string
  at: number
  folder: string
  versionId: string
  loader: LoaderKind
  exitCode: number | null
  windowShown: boolean
  rule: CrashRuleMatch | null
  keywords: string[]
  suspects: CrashSuspect[]
  missing: string[]
  evidence: CrashEvidence[]
  actions: CrashAction[]
  recordDir: string | null
  note: string | null
}

export interface CrashRecordSummary {
  id: string
  at: number
  versionId: string
  ruleId: string | null
  title: string
  exitCode: number | null
}

export interface CrashActionRequest {
  folder: string
  versionId: string
  diagnosisId: string
  kind: CrashActionKind
  value: string | null
}

export interface CrashActionResult {
  ok: boolean
  message: string
}

export interface CrashExportResult {
  path: string
  bytes: number
}
