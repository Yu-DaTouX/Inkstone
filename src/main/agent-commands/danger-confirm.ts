import { pick } from '../../shared/ui-lang'
import { APPROVAL_DETAIL_MAX, APPROVAL_TARGETS_MAX, DANGER_CONFIRM_TIMEOUT_MS, type ApprovalDecision, type ApprovalOwner } from '../../shared/approval'
import type { CapabilityCommandResult } from '../capability-server'
import type { DangerConfirmPrompt } from '../agent'
import type { ModelReviewReceiptInput } from '../approval-log'

export interface DangerConfirmHost {
  cwd(): string
  permissionMode(): Promise<'danger' | 'all' | undefined>
  confirmDanger(request: DangerConfirmPrompt): Promise<ApprovalDecision | null>
  approvalOwner(): ApprovalOwner
  recordDangerReview?(review: ModelReviewReceiptInput): void
}

const REVIEW_REASON_MAX = 500

export function dangerReviewOf(params: Record<string, unknown>): ModelReviewReceiptInput | null {
  const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId.slice(0, 200) : ''
  if (!toolCallId) return null
  const tool = typeof params.tool === 'string' ? params.tool.slice(0, 40) : 'tool'
  const reasons = Array.isArray(params.reasons) ? params.reasons.filter((r): r is string => typeof r === 'string') : []
  const reason = typeof params.reason === 'string' ? params.reason.trim().slice(0, REVIEW_REASON_MAX) : ''
  const askedAt = Number(params.askedAt)
  return {
    toolCallId,
    tool,
    title: (reasons[0] ?? tool).slice(0, 200),
    allowed: params.allowed === true,
    ...(reason ? { reason } : {}),
    ...(Number.isFinite(askedAt) && askedAt > 0 ? { askedAt } : {})
  }
}

export function runDangerReviewCommand(host: Pick<DangerConfirmHost, 'recordDangerReview'>, params: Record<string, unknown>): CapabilityCommandResult {
  const review = dangerReviewOf(params)
  if (review) host.recordDangerReview?.(review)
  return { summary: { kind: 'danger-review', recorded: !!review } }
}

export async function runDangerConfirmCommand(host: DangerConfirmHost, params: Record<string, unknown>): Promise<CapabilityCommandResult> {
  const critical = params.critical === true
  if ((await host.permissionMode()) === 'all' && !critical) return { summary: { kind: 'danger-confirm', allowed: true, decision: 'auto' } }
  const tool = typeof params.tool === 'string' ? params.tool.slice(0, 40) : 'tool'
  const detail = typeof params.detail === 'string' ? params.detail : ''
  if (detail.length > APPROVAL_DETAIL_MAX) return { summary: { kind: 'danger-confirm', allowed: false, decision: 'no-answer', reason: `审批内容有 ${detail.length} 字，超过 ${APPROVAL_DETAIL_MAX} 字，无法完整展示给用户确认。请缩短内容或分步执行` } }
  const allReasons = Array.isArray(params.reasons) ? params.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 200)) : []
  const reasons = allReasons.length > APPROVAL_TARGETS_MAX
    ? [...allReasons.slice(0, APPROVAL_TARGETS_MAX - 1), pick(`另有 ${allReasons.length - APPROVAL_TARGETS_MAX + 1} 项未列出`, `${allReasons.length - APPROVAL_TARGETS_MAX + 1} more not listed`)]
    : allReasons
  const rawOutside = Array.isArray(params.outsideDirs) ? params.outsideDirs.filter((d): d is string => typeof d === 'string') : []
  const outsideDirs = rawOutside.map((d) => d.slice(0, 500)).slice(0, APPROVAL_TARGETS_MAX)
  const outsideTruncated = rawOutside.length > APPROVAL_TARGETS_MAX || rawOutside.some((d) => d.length > 500) || params.outsideTruncated === true
  const kind = params.kind === 'permission' || params.kind === 'delete' ? params.kind : undefined
  const toolCallId = typeof params.toolCallId === 'string' && params.toolCallId ? params.toolCallId.slice(0, 200) : undefined
  const answer = await host.confirmDanger({ tool, detail, reasons, cwd: host.cwd(), owner: host.approvalOwner(), ...(toolCallId ? { toolCallId } : {}), ...(kind ? { kind } : {}), ...(outsideDirs.length ? { outsideDirs } : {}), ...(outsideTruncated ? { outsideTruncated } : {}), timeoutMs: DANGER_CONFIRM_TIMEOUT_MS, onTimeout: critical || tool === 'terminal' ? 'deny' : 'review' })
  const decision = answer?.decision ?? 'no-answer'
  return {
    data: { decision },
    summary: { kind: 'danger-confirm', tool, decision, allowed: answer?.decision === 'allow', ...(answer?.feedback ? { feedback: answer.feedback } : {}) }
  }
}
