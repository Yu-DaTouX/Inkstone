type QuestionReceiptState = 'pending' | 'answered' | 'skipped' | 'failed'

interface QuestionReceiptPair {
  label: string
  value: string
}

interface QuestionReceiptModel {
  state: QuestionReceiptState
  question: string
  answer: string | null
  pairs: QuestionReceiptPair[]
}

interface CallLike {
  name: string
  status?: string
  cancelled?: boolean
  args?: unknown
  details?: unknown
  output?: string
}

const QUESTION_TOOLS = new Set(['question'])

export function isQuestionCall(call: Pick<CallLike, 'name'>): boolean {
  return QUESTION_TOOLS.has(call.name)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function fieldPairs(fields: unknown, answers: unknown): QuestionReceiptPair[] {
  const values = record(answers)
  if (!Array.isArray(fields) || !values) return []
  const pairs: QuestionReceiptPair[] = []
  for (const raw of fields) {
    const field = record(raw)
    const name = text(field?.name)
    if (!field || !name || !(name in values)) continue
    const value = values[name]
    const shown = Array.isArray(value) ? value.map(String).join('、') : value === null || value === undefined ? '' : String(value)
    if (!shown) continue
    pairs.push({ label: text(field.label) || name, value: shown })
  }
  return pairs
}

export function questionReceipt(call: CallLike): QuestionReceiptModel {
  const args = record(call.args)
  const details = record(call.details)
  const question = text(details?.question) || text(args?.question)
  const running = call.status === 'running' || call.status === 'pending'
  if (running) return { state: 'pending', question, answer: null, pairs: [] }
  const answer = text(details?.answer) || text(/^Answer:\s*(.+)$/m.exec(call.output ?? '')?.[1]) || null
  const pairs = fieldPairs(details?.fields ?? args?.fields, details?.answers)
  if (call.status === 'error' && !call.cancelled && !details?.cancelled) return { state: 'failed', question, answer: null, pairs: [] }
  if (call.cancelled || details?.cancelled === true || (!answer && !pairs.length)) return { state: 'skipped', question, answer: null, pairs: [] }
  return { state: 'answered', question, answer: pairs.length ? null : answer, pairs }
}
