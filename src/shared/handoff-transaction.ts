import type { HandoffPackage } from './handoff'

export type HandoffStage =
  | 'pending'
  | 'snapshot'
  | 'validated'
  | 'destination-created'
  | 'committed'
  | 'resumed'
  | 'failed'

export const HANDOFF_STAGE_ORDER: HandoffStage[] = [
  'pending',
  'snapshot',
  'validated',
  'destination-created',
  'committed',
  'resumed'
]

export type HandoffRecoveryAction = 'none' | 'resend' | 'abandon' | 'complete'

export interface HandoffStep {
  at: number
  from: HandoffStage
  to: HandoffStage
  detail?: string
}

export interface HandoffReceipts {
  sentAt?: number
  persistedAt?: number
  startedAt?: number
}

export interface HandoffTransaction {
  handoffId: string
  sourceSession: string
  destinationSession: string | null
  package: HandoffPackage | null
  resumeId: string
  resumeAttempts: number
  receipts: HandoffReceipts
  stage: HandoffStage
  steps: HandoffStep[]
  error: string | null
  createdAt: number
  updatedAt: number
}

export function handoffStages(): HandoffStage[] {
  return [...HANDOFF_STAGE_ORDER]
}

export function isTerminalStage(stage: HandoffStage): boolean {
  return stage === 'resumed' || stage === 'failed'
}

export function canAdvance(
  tx: HandoffTransaction,
  to: HandoffStage
): { ok: boolean; reason: string } {
  if (!tx || !tx.stage) return { ok: false, reason: 'no-transaction' }
  if (tx.stage === to) return { ok: false, reason: 'already-there' }
  if (isTerminalStage(tx.stage)) return { ok: false, reason: `terminal:${tx.stage}` }
  if (to === 'failed') return { ok: true, reason: 'fail' }
  const from = HANDOFF_STAGE_ORDER.indexOf(tx.stage)
  const next = HANDOFF_STAGE_ORDER.indexOf(to)
  if (next < 0) return { ok: false, reason: 'unknown-stage' }
  if (next !== from + 1) return { ok: false, reason: next < from ? 'backwards' : 'skipped' }
  if (to === 'validated' && !tx.package) return { ok: false, reason: 'no-package' }
  if ((to === 'destination-created' || to === 'committed') && !tx.destinationSession) {
    return { ok: false, reason: 'no-destination' }
  }
  return { ok: true, reason: 'ok' }
}

export function advance(
  tx: HandoffTransaction,
  to: HandoffStage,
  opts: { at?: number; detail?: string } = {}
): { tx: HandoffTransaction; advanced: boolean; reason: string } {
  const verdict = canAdvance(tx, to)
  if (!verdict.ok) return { tx, advanced: false, reason: verdict.reason }
  const at = opts.at ?? Date.now()
  const step: HandoffStep = { at, from: tx.stage, to, ...(opts.detail ? { detail: opts.detail } : {}) }
  return {
    tx: {
      ...tx,
      stage: to,
      steps: [...tx.steps, step].slice(-40),
      updatedAt: at,
      ...(to === 'failed' ? { error: opts.detail ?? tx.error } : {})
    },
    advanced: true,
    reason: verdict.reason
  }
}

export function attachDestination(
  tx: HandoffTransaction,
  destinationSession: string,
  at = Date.now()
): { tx: HandoffTransaction; ok: boolean; reason: string } {
  const dest = typeof destinationSession === 'string' ? destinationSession.trim() : ''
  if (!dest) return { tx, ok: false, reason: 'empty-destination' }
  if (tx.destinationSession && tx.destinationSession !== dest) {
    return { tx, ok: false, reason: 'destination-locked' }
  }
  if (tx.stage === 'committed' || tx.stage === 'resumed') {
    return { tx, ok: false, reason: 'already-committed' }
  }
  if (tx.destinationSession === dest) return { tx, ok: true, reason: 'unchanged' }
  return { tx: { ...tx, destinationSession: dest, updatedAt: at }, ok: true, reason: 'attached' }
}

export function attachPackage(
  tx: HandoffTransaction,
  pkg: HandoffPackage,
  at = Date.now()
): { tx: HandoffTransaction; ok: boolean; reason: string } {
  if (!pkg) return { tx, ok: false, reason: 'no-package' }
  if (tx.package) return { tx, ok: false, reason: 'package-locked' }
  const next = { ...tx, package: pkg, updatedAt: at }
  if (tx.stage === 'snapshot') {
    const moved = advance(next, 'validated', { at, detail: 'package-attached' })
    return { tx: moved.tx, ok: moved.advanced, reason: moved.reason }
  }
  return { tx: next, ok: true, reason: 'attached' }
}

export function createTransaction(input: {
  handoffId: string
  sourceSession: string
  resumeId: string
  at?: number
}): HandoffTransaction {
  const at = input.at ?? Date.now()
  return {
    handoffId: input.handoffId,
    sourceSession: input.sourceSession,
    destinationSession: null,
    package: null,
    resumeId: input.resumeId,
    resumeAttempts: 0,
    receipts: {},
    stage: 'pending',
    steps: [],
    error: null,
    createdAt: at,
    updatedAt: at
  }
}

export function recoveryAction(
  tx: HandoffTransaction,
  evidence: { destinationHasResume: boolean }
): { action: HandoffRecoveryAction; reason: string } {
  if (!tx) return { action: 'none', reason: 'no-transaction' }
  switch (tx.stage) {
    case 'resumed':
      return { action: 'none', reason: 'already-resumed' }
    case 'failed':
      return { action: 'none', reason: 'failed' }
    case 'committed':
      return evidence.destinationHasResume
        ? { action: 'complete', reason: 'evidence-found' }
        : { action: 'resend', reason: 'no-evidence' }
    case 'destination-created':
      return { action: 'abandon', reason: 'not-committed' }
    default:
      return { action: 'abandon', reason: 'nothing-to-recover' }
  }
}

export function recordResumeAttempt(tx: HandoffTransaction, at = Date.now()): HandoffTransaction {
  return {
    ...tx,
    resumeAttempts: Math.max(0, Math.floor(tx.resumeAttempts ?? 0)) + 1,
    receipts: { ...(tx.receipts ?? {}), sentAt: tx.receipts?.sentAt ?? at },
    updatedAt: at
  }
}

export type ReceiptKind = 'sent' | 'persisted' | 'started'

const RECEIPT_FIELD: Record<ReceiptKind, keyof HandoffReceipts> = {
  sent: 'sentAt',
  persisted: 'persistedAt',
  started: 'startedAt'
}

export function recordReceipt(tx: HandoffTransaction, kind: ReceiptKind, at = Date.now()): HandoffTransaction {
  const field = RECEIPT_FIELD[kind]
  const receipts = tx.receipts ?? {}
  if (typeof receipts[field] === 'number') return tx
  return { ...tx, receipts: { ...receipts, [field]: at }, updatedAt: at }
}

export function transactionSummary(tx: HandoffTransaction | null): string {
  if (!tx) return '没有交接事务'
  const dest = tx.destinationSession ? tx.destinationSession.split(/[\\/]/).pop() : '（未建）'
  return `${tx.stage} · 源 ${tx.sourceSession.split(/[\\/]/).pop() ?? '?'} → ${dest}${tx.error ? ` · ${tx.error}` : ''}`
}
