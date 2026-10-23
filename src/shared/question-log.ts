import type { QuestionLogEntry, UIMessage } from './ipc'

function questionsAskedByTool(messages: UIMessage[]): Set<string> {
  const asked = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.name !== 'question') continue
      const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : null
      const question = typeof args?.question === 'string' ? args.question.trim() : ''
      if (question) asked.add(question)
    }
  }
  return asked
}

export function mergeQuestionLog(messages: UIMessage[], entries: QuestionLogEntry[]): UIMessage[] {
  if (!entries.length) return messages
  const asked = questionsAskedByTool(messages)
  const pending = asked.size ? entries.filter((entry) => !asked.has(entry.question.trim())) : entries
  if (!pending.length) return messages
  const out = [...messages]
  const sorted = [...pending].sort((a, b) => a.at - b.at)
  let last: UIMessage | null = null
  for (const entry of sorted) {
    const line = entry.answer ? `${entry.question}\n\n${entry.answer}` : entry.question
    let index = out.length
    for (let i = 0; i < out.length; i += 1) {
      const at = out[i].timestamp
      if (typeof at === 'number' && at > entry.at) {
        index = i
        break
      }
    }
    if (last && out[index - 1] === last) {
      last.text = `${last.text}\n\n${line}`
      last.qa?.push({ question: entry.question, answer: entry.answer ?? undefined })
      continue
    }
    const msg: UIMessage = {
      id: `qlog:${entry.id}`,
      role: 'user',
      question: true,
      qa: [{ question: entry.question, answer: entry.answer ?? undefined }],
      text: line,
      timestamp: entry.at
    }
    out.splice(index, 0, msg)
    last = msg
  }
  return out
}
