function appendChatReminder(payload, messages, text) {
  const last = messages[messages.length - 1]
  if (last?.role === 'user' && Array.isArray(last.content)) {
    return { ...payload, messages: [...messages.slice(0, -1), { ...last, content: [...last.content, { type: 'text', text }] }] }
  }
  if (last?.role === 'user' && typeof last.content === 'string') {
    return { ...payload, messages: [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${text}` }] }
  }
  return { ...payload, messages: [...messages, { role: 'user', content: text }] }
}

function appendResponsesReminder(payload, input, text) {
  const last = input[input.length - 1]
  const userMessage = last?.role === 'user' && (last.type === undefined || last.type === 'message')
  if (userMessage && Array.isArray(last.content)) {
    return { ...payload, input: [...input.slice(0, -1), { ...last, content: [...last.content, { type: 'input_text', text }] }] }
  }
  if (userMessage && typeof last.content === 'string') {
    return { ...payload, input: [...input.slice(0, -1), { ...last, content: [{ type: 'input_text', text: last.content }, { type: 'input_text', text }] }] }
  }
  return { ...payload, input: [...input, { role: 'user', content: [{ type: 'input_text', text }] }] }
}

export function appendReminder(payload, text) {
  const messages = payload?.messages
  if (Array.isArray(messages) && messages.length > 0) return appendChatReminder(payload, messages, text)
  const input = payload?.input
  if (Array.isArray(input) && input.length > 0) return appendResponsesReminder(payload, input, text)
  return undefined
}
