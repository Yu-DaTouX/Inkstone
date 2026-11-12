import { pick } from '../../shared/ui-lang'
import { APPROVAL_DETAIL_MAX, APPROVAL_TARGETS_MAX, type ApprovalDecision, type ApprovalOwner } from '../../shared/approval'
import type { CapabilityCommandResult } from '../capability-server'
import type { DangerConfirmPrompt } from '../agent'

export interface DangerConfirmHost {
  cwd(): string
  permissionMode(): Promise<'danger' | 'all' | undefined>
  confirmDanger(request: DangerConfirmPrompt): Promise<ApprovalDecision | null>
  approvalOwner(): ApprovalOwner
}

export async function runDangerConfirmCommand(host: DangerConfirmHost, params: Record<string, unknown>): Promise<CapabilityCommandResult> {
  if ((await host.permissionMode()) === 'all') return { summary: { kind: 'danger-confirm', allowed: true, decision: 'auto' } }
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
  const answer = await host.confirmDanger({ tool, detail, reasons, cwd: host.cwd(), owner: host.approvalOwner(), ...(toolCallId ? { toolCallId } : {}), ...(kind ? { kind } : {}), ...(outsideDirs.length ? { outsideDirs } : {}), ...(outsideTruncated ? { outsideTruncated } : {}) })
  const decision = answer?.decision ?? 'no-answer'
  return {
    data: { decision },
    summary: { kind: 'danger-confirm', tool, decision, allowed: answer?.decision === 'allow', ...(answer?.feedback ? { feedback: answer.feedback } : {}) }
  }
}
