import { callHostTool, hostToolsAvailable, toolText } from './host-tool-call.js'
import { reserveInkstoneSections } from './prompt-sections.js'

const WHEN_TO_ASK = 'Ask the user only when a reasonable reading of the request could produce something they did not mean, or when you cannot tell what they want. Check the files, the conversation and the environment first; never ask what you can find out yourself. If the user says to ask more or less, follow that; asking or not never changes approvals or high-risk confirmations.'

export const TOOL_GUIDANCE = `${WHEN_TO_ASK} Ask with the \`question\` tool, one focused question at a time, and wait for the answer.`

export const CLI_GUIDANCE = `${WHEN_TO_ASK} Ask with \`yan question ask\` (at most 3 concrete options), one focused question at a time, and wait for the answer.`

const FIELD_KINDS = ['choice', 'multi', 'text', 'date', 'number', 'range', 'secret']

const SECRET_NOUN = /password|passphrase|passcode|api[ _-]?key|access[ _-]?token|auth(?:entication)?[ _-]?token|secret[ _-]?key|private[ _-]?key|credential|\botp\b|verification code|2fa code|密码|口令|密钥|令牌|验证码|凭据|凭证/i
const SECRET_ASK = /provide|enter|paste|type|share|send|give|what(?:'s| is)|tell me|need|提供|输入|告诉|发给|发我|给我|填写|粘贴|是什么|是多少|需要/i
const MIN_MASKED_CHARS = 4

export function asksForSecret(text) {
  const value = String(text ?? '')
  return SECRET_NOUN.test(value) && SECRET_ASK.test(value)
}

export function protectSecretRequest(params) {
  const source = params ?? {}
  if (Array.isArray(source.fields)) {
    return {
      ...source,
      fields: source.fields.map((field) => (field?.kind === 'text' || field?.kind === undefined) && SECRET_NOUN.test(String(field?.label ?? ''))
        ? { ...field, kind: 'secret', detected: true }
        : field)
    }
  }
  if (source.options?.length || !asksForSecret(source.question)) return source
  const label = String(source.question).trim().split('\n')[0].slice(0, 200)
  return { ...source, fields: [{ name: 'value', label, kind: 'secret', detected: true }] }
}

export function maskSecrets(text, values) {
  let out = String(text)
  for (const value of values) {
    if (value.length < MIN_MASKED_CHARS) continue
    for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) out = out.replaceAll(form, '[REDACTED]')
  }
  return out
}

function secretNotice(names) {
  const list = names.map((name) => `$${name}`).join(', ')
  return `The user provided this privately and you cannot see the value. It is set for your later shell commands as ${list} (PowerShell: ${names.map((name) => `$env:${name}`).join(', ')}) until this session ends. Refer to the variable; do not print it.`
}

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
        description: 'A 1-5 field form instead of options. Use kind secret for passwords, tokens and keys: the user types it privately, you never see the value, and later shell commands get it as $YAN_SECRET_<NAME>.',
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

// 超时说明用户多半不在：按 Claude Code 的做法让模型带着写明的假设继续，而不是停下来白等
const TIMEOUT_TEXT = 'No answer before the question timed out; the user may be away. Proceed with your best judgment from the context so far, state the assumption you made in your final reply, and ask again later only if it still matters. Approvals and high-risk confirmations still apply.'
// 主动关掉或提交空答案说明用户在场但不想答：和 Claude Code 拒答一样停下等用户
const DISMISSED_TEXT = 'The user dismissed the question without answering. Do not guess the answer: stop and wait for the user to tell you how to proceed.'
const EMPTY_TEXT = 'The user closed the question with an empty answer. Do not guess the answer: stop and wait for the user to tell you how to proceed.'

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
  const secretNames = Object.keys(outcome.secrets ?? {})
  if (secretNames.length) lines.push(secretNotice(secretNames))
  return toolText(lines.join('\n'), details)
}

export function createSecretStore(env = process.env) {
  const held = new Map()
  return {
    hold(secrets) {
      for (const [name, value] of Object.entries(secrets ?? {})) {
        if (!/^YAN_SECRET_[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') continue
        held.set(name, value)
        env[name] = value
      }
    },
    clear() {
      for (const name of held.keys()) delete env[name]
      held.clear()
    },
    values: () => [...held.values()]
  }
}

export function createQuestionTool(call = callHostTool, store = createSecretStore()) {
  return {
    ...QUESTION_TOOL,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await call({ command: 'question.ask', params: protectSecretRequest(params), toolCallId, cwd: ctx?.cwd, signal })
      store.hold(outcome.secrets)
      return questionResult(outcome)
    }
  }
}

export function maskToolResult(event, values) {
  if (!values.length || !Array.isArray(event?.content)) return undefined
  let changed = false
  const content = event.content.map((part) => {
    if (part?.type !== 'text' || typeof part.text !== 'string') return part
    const text = maskSecrets(part.text, values)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? { content } : undefined
}

export default function question(pi) {
  const tools = hostToolsAvailable() && typeof pi.registerTool === 'function'
  const store = createSecretStore()
  if (tools) pi.registerTool(createQuestionTool(callHostTool, store))
  pi.on('tool_result', (event) => maskToolResult(event, store.values()))
  pi.on('session_start', (event) => {
    if (event?.reason !== 'reload') store.clear()
  })
  const guidance = tools ? TOOL_GUIDANCE : CLI_GUIDANCE
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      reserveInkstoneSections(sections)
      sections.inkstone_question = guidance
      return
    }
    return { systemPrompt: `${base}\n\n${guidance}` }
  })
}
