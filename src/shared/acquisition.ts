export const ACQUISITION_MAIN_PATH = [
  'discovered',
  'inspected',
  'prepared',
  'acquiring',
  'verifying',
  'activated',
  'resumed'
] as const

export const ACQUISITION_BRANCH_STATES = [
  'needs-auth',
  'needs-authorization',
  'pending-boundary',
  'failed',
  'cancelled'
] as const

export type AcquisitionMainState = (typeof ACQUISITION_MAIN_PATH)[number]
export type AcquisitionState = AcquisitionMainState | (typeof ACQUISITION_BRANCH_STATES)[number]

export const ACQUISITION_TERMINAL_STATES: readonly AcquisitionState[] = [
  'resumed',
  'failed',
  'cancelled',
  'needs-auth',
  'needs-authorization'
]

const MAIN_TRANSITIONS: Record<AcquisitionMainState, readonly AcquisitionState[]> = {
  discovered: ['inspected', 'failed', 'cancelled'],
  inspected: ['prepared', 'failed', 'cancelled'],
  prepared: ['acquiring', 'needs-auth', 'needs-authorization', 'pending-boundary', 'failed', 'cancelled'],
  acquiring: ['verifying', 'failed', 'cancelled'],
  verifying: ['activated', 'prepared', 'pending-boundary', 'failed', 'cancelled'],
  activated: ['resumed', 'failed', 'cancelled'],
  resumed: []
}

const BRANCH_TRANSITIONS: Partial<Record<AcquisitionState, readonly AcquisitionState[]>> = {
  'needs-auth': ['prepared', 'cancelled'],
  'needs-authorization': ['prepared', 'cancelled'],
  'pending-boundary': ['acquiring', 'failed', 'cancelled'],
  failed: ['prepared', 'cancelled'],
  cancelled: []
}

export function isTerminalAcquisitionState(state: AcquisitionState): boolean {
  return ACQUISITION_TERMINAL_STATES.includes(state)
}

export function allowedAcquisitionTransitions(state: AcquisitionState): readonly AcquisitionState[] {
  const main = MAIN_TRANSITIONS[state as AcquisitionMainState]
  if (main) return main
  return BRANCH_TRANSITIONS[state] ?? []
}

export function canTransitionAcquisition(from: AcquisitionState, to: AcquisitionState): boolean {
  return allowedAcquisitionTransitions(from).includes(to)
}

export class AcquisitionTransitionError extends Error {
  constructor(
    readonly from: AcquisitionState,
    readonly to: AcquisitionState
  ) {
    super(`接入事务不能从 ${from} 走到 ${to}`)
    this.name = 'AcquisitionTransitionError'
  }
}

import type { SkillSecurityReview } from './skill-security'

export const MAX_ACQUIRE_ATTEMPTS = 2

export type AcquisitionFailureCode =
  | 'network'
  | 'integrity'
  | 'permission'
  | 'unsupported-runtime'
  | 'verification'
  | 'cancelled'
  | 'unknown'

export type AcquisitionStep = {
  at: string
  from: AcquisitionState
  to: AcquisitionState
  detail?: string
}

export type CapabilityReceipt = {
  operationId: string
  planId: string
  planRevision: number
  candidateId: string
  digest: string
  scope: 'project-managed'
  projectId: string
  installedPaths: string[]
  verification: 'files-present' | 'protocol-reachable' | 'smoke-passed'
  activatedAt: string
  securityReview?: SkillSecurityReview
}

export type PiPackageActivationTarget = {
  runnerId: string
  runnerGeneration: number
  cwd: string
  sessionFile: string
  projectId: string
  goalId: string
  goalRevision: number
  sourceHead: string | null
  continueId: string
  packageName: string
  packageVersion: string
}

export type AcquisitionTransaction = {
  operationId: string
  planId: string
  planRevision: number
  candidateId: string
  digest: string
  projectId: string
  state: AcquisitionState
  attempts: number
  createdAt: string
  updatedAt: string
  stagingDir?: string
  piPackageTarget?: PiPackageActivationTarget
  securityReview?: SkillSecurityReview
  receipt?: CapabilityReceipt
  failure?: { code: AcquisitionFailureCode; detail: string }
  history: AcquisitionStep[]
}

export function newAcquisitionTransaction(input: {
  operationId: string
  planId: string
  planRevision: number
  candidateId: string
  digest: string
  projectId: string
  at: string
}): AcquisitionTransaction {
  return {
    operationId: input.operationId,
    planId: input.planId,
    planRevision: input.planRevision,
    candidateId: input.candidateId,
    digest: input.digest,
    projectId: input.projectId,
    state: 'prepared',
    attempts: 0,
    createdAt: input.at,
    updatedAt: input.at,
    history: []
  }
}

export function advanceAcquisition(
  tx: AcquisitionTransaction,
  to: AcquisitionState,
  patch: {
    at: string
    detail?: string
    stagingDir?: string
    receipt?: CapabilityReceipt
    securityReview?: SkillSecurityReview
    failure?: { code: AcquisitionFailureCode; detail: string }
  } = {
    at: new Date().toISOString()
  }
): AcquisitionTransaction {
  if (!canTransitionAcquisition(tx.state, to)) throw new AcquisitionTransitionError(tx.state, to)
  const from = tx.state
  const next: AcquisitionTransaction = {
    ...tx,
    state: to,
    updatedAt: patch.at,
    history: [...tx.history, { at: patch.at, from, to, ...(patch.detail ? { detail: patch.detail } : {}) }]
  }
  if (patch.stagingDir !== undefined) next.stagingDir = patch.stagingDir
  if (patch.receipt !== undefined) next.receipt = patch.receipt
  if (patch.securityReview !== undefined) next.securityReview = patch.securityReview
  if (patch.failure !== undefined) next.failure = patch.failure
  if (to === 'acquiring' && tx.state === 'prepared') next.attempts = tx.attempts + 1
  return next
}

export function canRetryAcquisition(tx: AcquisitionTransaction): boolean {
  return tx.state === 'failed' && tx.attempts < MAX_ACQUIRE_ATTEMPTS
}

export function retryAcquisition(tx: AcquisitionTransaction, at: string): AcquisitionTransaction {
  if (!canRetryAcquisition(tx)) {
    throw new Error(`这个事务不能重试（state=${tx.state}, attempts=${tx.attempts}/${MAX_ACQUIRE_ATTEMPTS}）`)
  }
  const next = advanceAcquisition(tx, 'prepared', { at, detail: `第 ${tx.attempts + 1} 次尝试` })
  delete next.stagingDir
  delete next.receipt
  delete next.failure
  delete next.piPackageTarget
  return next
}

export function receiptMatches(
  receipt: CapabilityReceipt,
  expected: { planId: string; digest: string; planRevision?: number }
): boolean {
  if (receipt.planId !== expected.planId) return false
  if (receipt.digest !== expected.digest) return false
  if (expected.planRevision !== undefined && receipt.planRevision !== expected.planRevision) return false
  return true
}

export const ARTIFACT_LIMITS = {
  maxFiles: 2000,
  maxBytes: 32 * 1024 * 1024,
  maxPathLength: 200
} as const

export type ArtifactLimits = {
  maxFiles: number
  maxBytes: number
  maxPathLength: number
}

export type ArtifactEntry = {
  path: string
  bytes: number
  symlink?: boolean
  kind?: 'file' | 'dir'
}

export type ArtifactRejection = {
  code:
    | 'empty'
    | 'path-traversal'
    | 'absolute-path'
    | 'path-too-long'
    | 'duplicate-path'
    | 'symlink-not-allowed'
    | 'too-many-files'
    | 'too-large'
    | 'negative-size'
  detail: string
  path?: string
}

export function normalizeArtifactPath(raw: string): string | null {
  const text = String(raw ?? '')
  if (text.trim().length === 0) return null
  if (text.includes('\u0000')) return null
  const unified = text.replace(/\\/g, '/')
  if (unified.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(unified)) return null
  const parts: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' || /[. ]$/.test(segment) || /[<>:"|?*\u0000-\u001f]/.test(segment)) return null
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) return null
    parts.push(segment)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

export function validateArtifactEntries(
  entries: readonly ArtifactEntry[],
  limits: ArtifactLimits = ARTIFACT_LIMITS
): ArtifactRejection | null {
  if (entries.length === 0) {
    return { code: 'empty', detail: '归档里一个文件都没有（拒绝空接入）' }
  }
  if (entries.length > limits.maxFiles) {
    return {
      code: 'too-many-files',
      detail: `文件数 ${entries.length} 超过上限 ${limits.maxFiles}（可能是解压膨胀）`
    }
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const entry of entries) {
    const normalized = normalizeArtifactPath(entry.path)
    if (normalized === null) {
      const looksAbsolute = /^([A-Za-z]:|[\\/])/.test(String(entry.path ?? '').trim())
      return {
        code: looksAbsolute ? 'absolute-path' : 'path-traversal',
        detail: `不接受的归档路径：${JSON.stringify(entry.path)}`,
        path: String(entry.path ?? '')
      }
    }
    if (normalized.length > limits.maxPathLength) {
      return {
        code: 'path-too-long',
        detail: `路径过长（${normalized.length} > ${limits.maxPathLength}）：${normalized}`,
        path: normalized
      }
    }
    if (seen.has(normalized)) {
      return { code: 'duplicate-path', detail: `同一个路径出现两次：${normalized}`, path: normalized }
    }
    seen.add(normalized)
    if (entry.symlink) {
      return {
        code: 'symlink-not-allowed',
        detail: `不接受符号链接（可能指向受管目录之外）：${normalized}`,
        path: normalized
      }
    }
    if (typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes) || entry.bytes < 0) {
      return { code: 'negative-size', detail: `文件大小不合法：${normalized} = ${String(entry.bytes)}`, path: normalized }
    }
    totalBytes += entry.bytes
    if (totalBytes > limits.maxBytes) {
      return {
        code: 'too-large',
        detail: `累计 ${totalBytes} 字节超过上限 ${limits.maxBytes}（可能是解压膨胀）`,
        path: normalized
      }
    }
  }
  return null
}

export function classifyAcquisitionFailure(error: unknown): AcquisitionFailureCode {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  const code = (error as { code?: unknown } | null)?.code
  const codeText = typeof code === 'string' ? code : ''
  const both = `${codeText} ${message}`.toLowerCase()
  if (/cancell?ed|aborted|abort/.test(both)) return 'cancelled'
  if (/eacces|eperm|permission|denied|blocked/.test(both)) return 'permission'
  if (/enotfound|econnrefused|econnreset|etimedout|socket|network|fetch failed|dns|tls/.test(both)) return 'network'
  if (/integrity|hash|checksum|sha\d*|digest|mismatch/.test(both)) return 'integrity'
  if (/enoent|unsupported|not supported|no such runtime|python|uv\b|docker/.test(both)) return 'unsupported-runtime'
  if (/verif|smoke|handshake|not reachable|协议|验证|握手|不可达/.test(both)) return 'verification'
  return 'unknown'
}
