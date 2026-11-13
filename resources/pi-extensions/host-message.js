const SUBAGENT_NOTICE = /^\s*<subagent-notification\b/
const CONTINUATION = /^\s*\[(?:循环恢复|模型错误恢复|额度换号) · 自动继续|^\s*\[Auto-continue 1\/1\]/
const QUOTA_RESUME = /^\s*额度已恢复，请从上一轮中断的地方继续完成任务。\s*$/
const HOST_NOTICE = /^\s*\[砚宿主通知：/

export function hostMessageKind(text) {
  const body = typeof text === 'string' ? text : ''
  if (!body) return null
  if (SUBAGENT_NOTICE.test(body)) return 'subagent-notice'
  if (CONTINUATION.test(body)) return 'continuation'
  if (QUOTA_RESUME.test(body)) return 'quota-resume'
  if (HOST_NOTICE.test(body)) return 'host-notice'
  return null
}

export function isHostAutomatedMessage(text) {
  return hostMessageKind(text) !== null
}

export function isHostContinuation(text) {
  const kind = hostMessageKind(text)
  return kind === 'continuation' || kind === 'quota-resume'
}
