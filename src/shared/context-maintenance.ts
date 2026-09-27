import type { ContextBudgetRuntimeSnapshotV1 } from './context-budget-v1'

export type ContextMaintenanceStateV1 =
  | 'requested'
  | 'preparing'
  | 'summarizing'
  | 'validating'
  | 'committed'
  | 'applied'
  | 'needs_action'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export type ContextMaintenanceRequestKindV1 = 'automatic' | 'manual' | 'user_retry' | 'native_compact'

export interface ContextMaintenanceBaseV1 {
  rawWatermark: { entryCount: number; lastEntryId: string | null }
  sourceRevision: string
  policyRevision: string
  capabilityRevision: string
}

export interface ContextMaintenanceOperationV1 {
  version: 1
  revision: string
  identity: {
    sessionId: string
    runnerId: string
    runnerEpoch: string
    operationId: string
  }
  base: ContextMaintenanceBaseV1
  requestKind: ContextMaintenanceRequestKindV1
  reason: string
  protectedRefs: string[]
  candidateRef: string | null
  beforeSnapshot: ContextBudgetRuntimeSnapshotV1 | null
  afterSnapshot: ContextBudgetRuntimeSnapshotV1 | null
  resumeId: string | null
  resumeReceipt: string | null
  projectionReceipt: string | null
  lastSummarizedSourceRevision: string | null
  retryNonce: string | null
  state: ContextMaintenanceStateV1
  failureCode: string | null
  createdAt: number
  updatedAt: number
}

export interface ContextMaintenanceProjectionV1 {
  version: 1
  projectionId: string
  operationId: string
  sessionId: string
  runnerId: string
  runnerEpoch: string
  base: ContextMaintenanceBaseV1
  elidedEntryIds: string[]
  summaryText: string
  summaryHash: string
  sourceRevision: string
  createdAt: number
}

export interface ContextMaintenanceActivePointerV1 {
  version: 1
  sessionId: string
  operationId: string
  projectionId: string
  revision: string
  rawWatermark: { entryCount: number; lastEntryId: string | null }
  committedAt: number
}

export const CONTEXT_MAINTENANCE_STATES_V1: readonly ContextMaintenanceStateV1[] = [
  'requested', 'preparing', 'summarizing', 'validating', 'committed', 'applied',
  'needs_action', 'failed', 'cancelled', 'superseded'
]

const ALLOWED_TRANSITIONS: Readonly<Record<ContextMaintenanceStateV1, readonly ContextMaintenanceStateV1[]>> = {
  requested: ['preparing', 'needs_action', 'cancelled', 'superseded', 'failed'],
  preparing: ['summarizing', 'validating', 'needs_action', 'cancelled', 'superseded', 'failed'],
  summarizing: ['validating', 'needs_action', 'cancelled', 'superseded', 'failed'],
  validating: ['committed', 'needs_action', 'cancelled', 'superseded', 'failed'],
  committed: ['applied', 'needs_action', 'cancelled', 'superseded'],
  applied: ['needs_action', 'cancelled', 'superseded'],
  needs_action: ['preparing', 'cancelled', 'superseded', 'failed'],
  failed: ['preparing', 'cancelled', 'superseded'],
  cancelled: ['superseded'],
  superseded: []
}

export function canTransitionContextMaintenanceV1(
  from: ContextMaintenanceStateV1,
  to: ContextMaintenanceStateV1
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export function isContextMaintenanceOperationV1(value: unknown): value is ContextMaintenanceOperationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const identity = item.identity as Record<string, unknown> | undefined
  const base = item.base as Record<string, unknown> | undefined
  const watermark = base?.rawWatermark as Record<string, unknown> | undefined
  const state = item.state
  return item.version === 1 && typeof item.revision === 'string' && item.revision.length >= 8 &&
    !!identity && typeof identity.sessionId === 'string' && typeof identity.runnerId === 'string' &&
    typeof identity.runnerEpoch === 'string' && typeof identity.operationId === 'string' &&
    !!base && !!watermark && Number.isSafeInteger(watermark.entryCount) && (watermark.entryCount as number) >= 0 &&
    (watermark.lastEntryId === null || typeof watermark.lastEntryId === 'string') &&
    typeof base.sourceRevision === 'string' && typeof base.policyRevision === 'string' &&
    typeof base.capabilityRevision === 'string' &&
    (item.requestKind === 'automatic' || item.requestKind === 'manual' || item.requestKind === 'user_retry' || item.requestKind === 'native_compact') &&
    typeof item.reason === 'string' && item.reason.length <= 2000 &&
    Array.isArray(item.protectedRefs) && item.protectedRefs.length <= 2000 &&
    item.protectedRefs.every((ref) => typeof ref === 'string' && ref.length <= 2048) &&
    (item.candidateRef === null || typeof item.candidateRef === 'string') &&
    (item.beforeSnapshot === null || (typeof item.beforeSnapshot === 'object' && !Array.isArray(item.beforeSnapshot))) &&
    (item.afterSnapshot === null || (typeof item.afterSnapshot === 'object' && !Array.isArray(item.afterSnapshot))) &&
    (item.resumeId === null || (typeof item.resumeId === 'string' && item.resumeId.length <= 200)) &&
    (item.resumeReceipt === null || (typeof item.resumeReceipt === 'string' && item.resumeReceipt.length <= 300)) &&
    (item.projectionReceipt === null || (typeof item.projectionReceipt === 'string' && item.projectionReceipt.length <= 300)) &&
    (item.lastSummarizedSourceRevision === null || typeof item.lastSummarizedSourceRevision === 'string') &&
    (item.retryNonce === null || typeof item.retryNonce === 'string') &&
    CONTEXT_MAINTENANCE_STATES_V1.includes(state as ContextMaintenanceStateV1) &&
    (item.failureCode === null || typeof item.failureCode === 'string') &&
    Number.isSafeInteger(item.createdAt) && Number.isSafeInteger(item.updatedAt)
}
