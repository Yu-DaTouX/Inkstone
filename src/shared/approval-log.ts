import type { ApprovalReceipt } from './approval'
import type { UIMessage } from './ipc'

export function approvalReceiptsByCall(entries: readonly ApprovalReceipt[], subagentId?: string): Map<string, ApprovalReceipt> {
  const byCall = new Map<string, ApprovalReceipt>()
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    if (subagentId !== undefined && entry.subagentId !== subagentId) continue
    byCall.set(entry.toolCallId, entry)
  }
  return byCall
}

export function mergeApprovalLog<T extends Pick<UIMessage, 'toolCalls'>>(messages: T[], entries: readonly ApprovalReceipt[], subagentId?: string): T[] {
  if (!entries.length) return messages
  const byCall = approvalReceiptsByCall(entries, subagentId)
  if (!byCall.size) return messages
  let changed = false
  const out = messages.map((message) => {
    const calls = message.toolCalls
    if (!calls?.some((call) => byCall.has(call.id) && call.approval !== byCall.get(call.id))) return message
    changed = true
    return { ...message, toolCalls: calls.map((call) => {
      const approval = byCall.get(call.id)
      return approval && call.approval !== approval ? { ...call, approval } : call
    }) }
  })
  return changed ? out : messages
}
