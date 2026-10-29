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

export interface QuestionHistoryOption {
  label: string
  description: string
  chosen: boolean
}

export interface QuestionHistoryItem {
  question: string
  header: string
  options: QuestionHistoryOption[]
  answer: string | null
}

export interface QuestionHistoryModel {
  state: QuestionReceiptState
  items: QuestionHistoryItem[]
  pairs: QuestionReceiptPair[]
}

const HISTORY_TOOLS = /^(?:question|askuserquestion|ask_user_question)$/i

export function isHistoryQuestionCall(call: Pick<CallLike, 'name'>): boolean {
  return HISTORY_TOOLS.test(call.name)
}

function optionList(raw: unknown): { label: string; description: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((option) => {
    if (typeof option === 'string') return option.trim() ? [{ label: option.trim(), description: '' }] : []
    const item = record(option)
    const label = text(item?.label)
    return label ? [{ label, description: text(item?.description) }] : []
  })
}

function markChosen(options: readonly { label: string; description: string }[], answer: string | null): { options: QuestionHistoryOption[]; answer: string | null } {
  if (!answer) return { options: options.map((option) => ({ ...option, chosen: false })), answer: null }
  const labels = new Set(options.map((option) => option.label))
  const picked = labels.has(answer) ? [answer] : answer.split(/\s*[,，、]\s*/).filter((part) => labels.has(part))
  const rest = labels.has(answer) ? '' : answer.split(/\s*[,，、]\s*/).filter((part) => part && !labels.has(part)).join(', ')
  return {
    options: options.map((option) => ({ ...option, chosen: picked.includes(option.label) })),
    answer: picked.length ? rest || null : answer
  }
}

function claudeAnswers(output: string): Map<string, string> {
  const answers = new Map<string, string>()
  for (const match of output.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) answers.set(match[1], match[2])
  return answers
}

export function questionHistory(call: CallLike): QuestionHistoryModel {
  const receipt = questionReceipt(call)
  const args = record(call.args)
  if (Array.isArray(args?.questions)) {
    const answers = claudeAnswers(call.output ?? '')
    const items = args.questions.flatMap((raw) => {
      const item = record(raw)
      const question = text(item?.question)
      if (!question) return []
      const marked = markChosen(optionList(item?.options), answers.get(question) ?? null)
      return [{ question, header: text(item?.header), ...marked }]
    })
    const answered = items.some((item) => item.answer || item.options.some((option) => option.chosen))
    const state: QuestionReceiptState = call.status === 'running' || call.status === 'pending' ? 'pending'
      : call.status === 'error' && !call.cancelled ? 'failed'
        : answered ? 'answered' : 'skipped'
    return { state, items, pairs: [] }
  }
  const details = record(call.details)
  const options = optionList(details?.options ?? args?.options)
  const marked = markChosen(options, receipt.answer)
  return {
    state: receipt.state,
    items: [{ question: receipt.question, header: '', options: marked.options, answer: marked.answer }],
    pairs: receipt.pairs
  }
}
