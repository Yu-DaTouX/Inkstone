import { createHash, timingSafeEqual } from 'node:crypto'
import type { RemoteHumanApproval, RemotePendingQuestion } from '../shared/remote-protocol'
import type { RemoteOperationResult } from './remote-server'
import type { ApprovalRequest } from '../shared/approval'
import { APPROVAL_TIMEOUT_MS } from './approval-broker'

/** The same permission card shown on desktop, including full command and reasons. */
export function remoteApprovalQuestion(request: ApprovalRequest): RemotePendingQuestion {
  const question: RemotePendingQuestion = {
    id: `approval:${request.id}`, sessionId: request.sessionId ?? null,
    runId: request.runId ?? `approval:${request.id}`, method: 'confirm', sensitive: true,
    title: request.title, message: JSON.stringify({ kind: request.kind, tool: request.tool, detail: request.detail,
      reasons: request.reasons, cwd: request.cwd, subagentId: request.subagentId,
      rememberDirs: request.rememberDirs, canRemember: request.canRemember }),
    deadline: request.createdAt + APPROVAL_TIMEOUT_MS
  }
  return { ...question, approvalDigest: approvalDigest(question) }
}

/** Bind a human's preview to this exact pending operation, not merely a reusable UI ID. */
export function approvalDigest(question: RemotePendingQuestion): string {
  return createHash('sha256').update(JSON.stringify([
    question.id, question.sessionId, question.runId, question.method,
    question.sensitive, question.title, question.message, question.options ?? []
  ])).digest('hex')
}

export function applyHumanApproval(
  question: RemotePendingQuestion | undefined,
  answer: RemoteHumanApproval,
  resolve: (confirmed: boolean) => void | boolean,
  now = Date.now()
): RemoteOperationResult {
  if (!question) return { ok: false, status: 404, code: 'question_not_pending', error: '该审批已处理或已过期' }
  if (question.method !== 'confirm' || !question.sensitive) return { ok: false, status: 409, code: 'not_sensitive_confirmation', error: '这不是敏感确认，请使用普通回答接口' }
  if (question.deadline > 0 && now >= question.deadline) return { ok: false, status: 409, code: 'approval_expired', error: '审批已过期，请重新查看待审批操作' }
  const expected = approvalDigest(question)
  if (question.sessionId !== answer.sessionId || question.runId !== answer.runId ||
      !/^[0-9a-f]{64}$/.test(answer.digest) || !timingSafeEqual(Buffer.from(expected), Buffer.from(answer.digest))) {
    return { ok: false, status: 409, code: 'approval_changed', error: '审批目标或内容已变化，请重新查看后决定' }
  }
  if (resolve(answer.confirmed) === false) return { ok: false, status: 409, code: 'question_not_pending', error: '该审批已处理或已过期' }
  return { ok: true, data: { questionId: question.id, sessionId: question.sessionId, runId: question.runId, confirmed: answer.confirmed } }
}
