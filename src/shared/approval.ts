export const PERMISSION_MODES = ['danger', 'all'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'danger'
export const APPROVAL_DETAIL_MAX = 20000

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'all' ? 'all' : 'danger'
}

export function isLegacyPermissionMode(value: unknown): boolean {
  return value !== 'danger' && value !== 'all'
}

export type ApprovalKind = 'permission' | 'delete' | 'danger' | 'outside' | 'consent' | 'move'

export type ApprovalChoice = 'deny' | 'once' | 'session' | 'remember'

export const APPROVAL_FEEDBACK_MAX = 500

export function normalizeApprovalFeedback(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, APPROVAL_FEEDBACK_MAX)
  return text || undefined
}

export function denyFeedbackNote(feedback: unknown): string {
  const reason = normalizeApprovalFeedback(feedback)
  return reason ? `用户拒绝了这次操作，并给出理由：${reason}。请按这个理由调整做法后再试` : ''
}

export function withDenyFeedback(text: string, feedback: unknown): string {
  const note = denyFeedbackNote(feedback)
  return note ? `${text} ${note}` : text
}

export interface ApprovalAnswer {
  choice: ApprovalChoice
  feedback?: string
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  feedback?: string
}

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
  danger?: string
  cwd: string
  rememberDirs?: string[]
  canRemember: boolean
  createdAt: number
}

export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === 'deny' || value === 'once' || value === 'session' || value === 'remember'
}
