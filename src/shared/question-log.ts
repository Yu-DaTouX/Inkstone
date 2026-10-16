import type { QuestionLogEntry, UIMessage } from './ipc'

export function mergeQuestionLog(messages: UIMessage[], entries: QuestionLogEntry[]): UIMessage[] {
  if (!entries.length) return messages
  const out = [...messages]
  const sorted = [...entries].sort((a, b) => a.at - b.at)
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
