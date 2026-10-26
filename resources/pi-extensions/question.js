import { callHostTool, hostToolsAvailable, toolText } from './host-tool-call.js'

const WHEN_TO_ASK = [
  'Ask only when a materially different reading would change the result and you cannot settle it from the files, the conversation or a quick check; do not ask what you can verify yourself. When you ask, wait for the answer instead of guessing it.',
  'Asking never relaxes approvals, permissions or high-risk confirmations; an explicit user instruction to ask (or not to ask) wins without widening the granted scope.'
]

export const TOOL_GUIDANCE = [
  'Interactive questions use the `question` tool: at most 3 concrete options, one question at a time.',
  ...WHEN_TO_ASK
].join('\n')

export const CLI_GUIDANCE = [
  'Interactive questions use `yan question ask`: at most 3 concrete options, one question at a time.',
  ...WHEN_TO_ASK
].join('\n')

const FIELD_KINDS = ['choice', 'multi', 'text', 'date', 'number', 'range']

const QUESTION_TOOL = {
  name: 'question',
  label: 'Question',
  description: 'Ask the user and wait. options: up to 3 choices; fields: a short form (1-5) instead of options; neither: free text.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      fields: {
        type: 'array',
        description: 'A 1-5 field form instead of options.',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique id, at most 40 characters: an ASCII letter, then letters, digits, _ or -.' },
            label: { type: 'string', description: 'At most 200 characters.' },
            kind: { type: 'string', enum: FIELD_KINDS },
            options: { type: 'array', items: { type: 'string' }, description: 'Required for choice (2-3) and multi (2-6); ignored for other kinds. Each at most 80 characters.' },
            min: { type: 'number', description: 'Required for range, optional for number; below max.' },
            max: { type: 'number', description: 'Required for range, optional for number; above min.' },
            step: { type: 'number', description: 'For number or range.' },
            optional: { type: 'boolean' }
          },
          required: ['name', 'label', 'kind']
        }
      }
    },
    required: ['question']
  }
}

export function questionResult(outcome) {
  if (!outcome.ok) {
    return toolText(outcome.cancelled ? 'Question cancelled.' : `Question failed: ${outcome.error}`, { cancelled: outcome.cancelled === true, code: outcome.code }, !outcome.cancelled)
  }
  const data = outcome.data ?? {}
  const details = {
    question: data.question,
    options: data.options ?? [],
    ...(data.fields ? { fields: data.fields, answers: data.answers ?? null } : {}),
    answer: data.answer ?? null,
    cancelled: data.cancelled === true
  }
  if (details.cancelled || details.answer === null) return toolText('No answer (dismissed or timed out). Do not guess it.', details)
  const lines = [`Answer: ${details.answer}`]
  if (details.answers) lines.push(JSON.stringify(details.answers))
  return toolText(lines.join('\n'), details)
}

export function createQuestionTool(call = callHostTool) {
  return {
    ...QUESTION_TOOL,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await call({ command: 'question.ask', params: params ?? {}, toolCallId, cwd: ctx?.cwd, signal })
      return questionResult(outcome)
    }
  }
}

export default function question(pi) {
  const tools = hostToolsAvailable() && typeof pi.registerTool === 'function'
  if (tools) pi.registerTool(createQuestionTool())
  const guidance = tools ? TOOL_GUIDANCE : CLI_GUIDANCE
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_question = guidance
      return
    }
    return { systemPrompt: `${base}\n\n${guidance}` }
  })
}
