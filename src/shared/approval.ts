export const PERMISSION_MODES = ['danger', 'all'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'danger'

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'all' ? 'all' : 'danger'
}

export function isLegacyPermissionMode(value: unknown): boolean {
  return value !== 'danger' && value !== 'all'
}

export type ApprovalKind = 'permission' | 'delete' | 'danger' | 'outside' | 'consent' | 'move'

export type ApprovalChoice = 'deny' | 'once' | 'remember'

export type ApprovalPhase = 'pending' | 'sending' | 'resolved'

export interface ApprovalOwner {
  instanceId: string
  generation: number
}

export interface ApprovalAnswerIdentity {
  owner?: ApprovalOwner
  revision?: number
}

export interface ApprovalSnapshot {
  revision: number
  items: ApprovalRequest[]
}

export interface ApprovalRequest {
  id: string
  owner?: ApprovalOwner
  revision?: number
  phase?: ApprovalPhase
  sessionId?: string
  runId?: string
  subagentId?: string
  toolCallId?: string
  kind: ApprovalKind
  tool: string
  title: string
  detail: string
  reasons: string[]
  cwd: string
  rememberDirs?: string[]
  canRemember: boolean
  createdAt: number
}

export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === 'deny' || value === 'once' || value === 'remember'
}
