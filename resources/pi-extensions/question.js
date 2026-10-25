import { callHostTool, hostToolsAvailable, toolText } from './host-tool-call.js'

const WHEN_TO_ASK = [
  'Ask when a materially different reading would change the result and you cannot settle it from the files, the conversation or a quick check; do not ask what you can verify yourself. When you ask, stop and wait for the answer instead of guessing it.',
  'Asking never relaxes approvals, permissions or high-risk confirmations; an explicit user instruction to ask (or not to ask) wins without widening the granted scope.'
]

export const TOOL_GUIDANCE = [
  'Interactive questions use the `question` tool. Give at most 3 concrete options (the panel adds a free-text row); one question at a time unless several are truly independent.',
  ...WHEN_TO_ASK
].join('\n')

export const CLI_GUIDANCE = [
  'Interactive questions use `yan question ask`. Give at most 3 concrete options (the panel adds a free-text row); one question at a time unless several are truly independent.',
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
        description: 'A form with 1-5 fields instead of top-level options. choice and multi require field options; range requires min and max.',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique within the form; 1-40 characters after trimming. Start with an ASCII letter; use only ASCII letters, digits, underscores or hyphens.' },
            label: { type: 'string', description: 'Non-empty field label, at most 200 characters after trimming.' },
            kind: { type: 'string', enum: FIELD_KINDS },
            options: { type: 'array', items: { type: 'string' }, description: 'Required for choice (2-3 options) and multi (2-6 options); ignored for other kinds. Each option must be non-empty and at most 80 characters after trimming.' },
            min: { type: 'number', description: 'Required for range, optional for number; ignored for other kinds. Must be finite and less than max when both bounds are provided.' },
            max: { type: 'number', description: 'Required for range, optional for number; ignored for other kinds. Must be finite and greater than min when both bounds are provided.' },
            step: { type: 'number', description: 'Optional finite numeric step for number or range; ignored for other kinds.' },
            optional: { type: 'boolean' }
          },
          required: ['name', 'label', 'kind']
        }
      }
    },
    required: ['question']
  }
}

// 超时说明用户多半不在：按 Claude Code 的做法让模型带着写明的假设继续，而不是停下来白等
const TIMEOUT_TEXT = 'No answer before the question timed out; the user may be away. Proceed with your best judgment from the context so far, state the assumption you made in your final reply, and ask again later only if it still matters. Approvals and high-risk confirmations still apply.'
// 主动关掉说明用户在场但不想答：和 Claude Code 拒答一样停下等用户；提交空答案只如实告知
const DISMISSED_TEXT = 'The user dismissed the question without answering. Do not guess the answer: stop and wait for the user to tell you how to proceed.'
const EMPTY_TEXT = 'The user did not answer the question.'

export function questionResult(outcome) {
  if (!outcome.ok && outcome.code === 'question_timeout') return toolText(TIMEOUT_TEXT, { cancelled: false, timedOut: true, code: outcome.code })
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
  if (details.cancelled) return toolText(DISMISSED_TEXT, details)
  if (details.answer === null) return toolText(EMPTY_TEXT, details)
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
