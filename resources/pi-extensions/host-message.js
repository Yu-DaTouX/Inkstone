const SUBAGENT_NOTICE = /^\s*<subagent-notification\b/
const CONTINUATION = /^\s*\[(?:循环恢复|模型错误恢复|额度换号) · 自动继续|^\s*\[Auto-continue 1\/1\]/
const QUOTA_RESUME = /^\s*额度已恢复，请从上一轮中断的地方继续完成任务。\s*$/
const HOST_NOTICE = /^\s*\[砚宿主通知：/
const WRAP_UP = /^\s*【宿主提示】[\s\S]*不要再调用任何工具，立刻用已有的资料交出结论/
const PARENT_FOLLOWUP = /^\s*【主会话追加】/
const FORK_DIRECTIVE = /^\s*<fork-directive>\r?\n[\s\S]*\r?\n<\/fork-directive>\s*$/
const SIDE_QUESTION = /^\s*<side-question>\r?\n[\s\S]*\r?\n<\/side-question>\s*$/

export function hostMessageKind(text) {
  const body = typeof text === 'string' ? text : ''
  if (!body) return null
  if (SUBAGENT_NOTICE.test(body)) return 'subagent-notice'
  if (CONTINUATION.test(body)) return 'continuation'
  if (QUOTA_RESUME.test(body)) return 'quota-resume'
  if (HOST_NOTICE.test(body) || WRAP_UP.test(body)) return 'host-notice'
  if (PARENT_FOLLOWUP.test(body)) return 'parent-followup'
  if (FORK_DIRECTIVE.test(body)) return 'fork-directive'
  if (SIDE_QUESTION.test(body)) return 'side-question'
  return null
}

export function isHostAutomatedMessage(text) {
  return hostMessageKind(text) !== null
}

export function isHostContinuation(text) {
  const kind = hostMessageKind(text)
  return kind === 'continuation' || kind === 'quota-resume'
}
