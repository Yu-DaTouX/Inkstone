import type { ApprovalReceipt } from '../../../../shared/approval'
import { mergeApprovalLog } from '../../../../shared/approval-log'
import type { UIMessage } from '../../../../shared/ipc'

const merged = new WeakMap<UIMessage, { entries: readonly ApprovalReceipt[]; message: UIMessage }>()

export function mergeApprovalLogCached(messages: UIMessage[], entries: readonly ApprovalReceipt[]): UIMessage[] {
  if (!entries.length) return messages
  let changed = false
  const out = messages.map((message) => {
    const hit = merged.get(message)
    const next = hit && hit.entries === entries ? hit.message : mergeApprovalLog([message], entries)[0]
    if (!hit || hit.entries !== entries) merged.set(message, { entries, message: next })
    if (next !== message) changed = true
    return next
  })
  return changed ? out : messages
}

export function countUserMessages(messages: readonly UIMessage[]): number {
  let count = 0
  for (const message of messages) if (message.role === 'user' && !message.question) count += 1
  return count
}
