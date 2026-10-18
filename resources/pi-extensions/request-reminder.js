export function appendReminder(payload, text) {
  const messages = payload?.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const last = messages[messages.length - 1]
  if (last?.role === 'user' && Array.isArray(last.content)) {
    return { ...payload, messages: [...messages.slice(0, -1), { ...last, content: [...last.content, { type: 'text', text }] }] }
  }
  if (last?.role === 'user' && typeof last.content === 'string') {
    return { ...payload, messages: [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${text}` }] }
  }
  return { ...payload, messages: [...messages, { role: 'user', content: text }] }
}
