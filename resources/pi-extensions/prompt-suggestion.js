import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendInstruction } from './context-compact.js'
import { isHostAutomatedMessage } from './host-message.js'
import { registerProviderRequestStage } from './provider-request.js'

export const SUGGESTION_STATUS_KEY = 'inkstone_prompt_suggestion'
export const SUGGESTION_MARKER = '[Inkstone: predict the user\'s next message]'
const MAX_TOKENS = 1024
const REPLY_MAX_CHARS = 4000
const SUGGESTION_MAX_CHARS = 200
const IGNORED_BEFORE_BACKOFF = 3
const BACKOFF_EVERY = 3
const FAILURE_LIMIT = 3
const FAILURE_RETRY_EVERY = 10
const REASONING_REJECTED = /reasoning|effort|unsupported|not supported|unknown (?:parameter|field)|invalid (?:parameter|value)/i
export const EVIDENCE_HIGH_CHARS = 140_000
export const EVIDENCE_LOW_CHARS = 80_000

const COMPLETIONS_APIS = new Set(['openai-completions'])
const RESPONSES_APIS = new Set(['openai-responses', 'azure-openai-responses', 'openai-codex-responses'])

const PREDICT_RULES = 'Write the single message the user is most likely to send next, in their own voice and language, exactly as they would type it: for example a short go-ahead, a pick among options just offered, or the natural next request. Predict what they would type, not what you think they should do. Do not answer, continue the task or call tools. If the reply asks for something only the user can supply (a fact about them, a file, a name or a date), or nothing is reasonably predictable, output only NONE. Otherwise output only the message, at most 20 words.'

export const SEPARATE_SYSTEM_PROMPT = [
  'You predict the next message a user will type to their AI agent in Inkstone. Each user message below is one past exchange between them, oldest first: what the user wrote and what the agent replied. The last one ends with the agent\'s latest reply.',
  PREDICT_RULES
].join('\n\n')

const SEPARATE_ROUTES = [
  { matches: (model) => model.api === 'anthropic-messages' && /^claude-/.test(model.id), id: 'claude-haiku-5-5' },
  { matches: (model) => /^gpt-/.test(model.id), id: 'gpt-6-luna', reasoning: 'low' }
]

export function suggestionInstruction(reply) {
  const text = reply.length > REPLY_MAX_CHARS ? reply.slice(-REPLY_MAX_CHARS) : reply
  return [
    `${SUGGESTION_MARKER} This request comes from Inkstone, not from the user. The assistant has just finished its turn with this reply:`,
    `<assistant-reply>\n${text}\n</assistant-reply>`,
    PREDICT_RULES
  ].join('\n\n')
}

const CREDENTIAL_LIKE = [
  /(?:验证码|密码|口令|password|passcode|passwd|otp|token|api[ _-]?key|secret)\s*[:：=是为]\s*\S+/i,
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{10,}/,
  /^\d{4,8}$/
]

export function isCredentialLike(text) {
  return CREDENTIAL_LIKE.some((pattern) => pattern.test(text))
}

const normalized = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[。.!！?？~～]+$/, '')

export function cleanSuggestion(text, lastUser = '') {
  const line = String(text ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? ''
  const unwrapped = line.replace(/^["'`\u201c\u300c\u300e]+|["'`\u201d\u300d\u300f]+$/g, '').trim()
  if (!unwrapped || /^none\.?$/i.test(unwrapped) || /^[!/]/.test(unwrapped) || unwrapped.length > SUGGESTION_MAX_CHARS) return ''
  if (!/[\p{L}\p{N}]/u.test(unwrapped) || isCredentialLike(unwrapped)) return ''
  if (lastUser && normalized(unwrapped) === normalized(lastUser)) return ''
  return unwrapped
}

export function lowerReasoning(api, payload) {
  if (RESPONSES_APIS.has(api) && payload?.reasoning && typeof payload.reasoning === 'object' && payload.reasoning.effort) {
    return { ...payload, reasoning: { ...payload.reasoning, effort: 'low' } }
  }
  if (COMPLETIONS_APIS.has(api) && typeof payload?.reasoning_effort === 'string') return { ...payload, reasoning_effort: 'low' }
  return payload
}

export function finalReply(messages) {
  if (!Array.isArray(messages)) return ''
  const last = [...messages].reverse().find((message) => message?.role === 'assistant')
  if (!last || last.stopReason !== 'stop') return ''
  const content = Array.isArray(last.content) ? last.content : []
  if (content.some((block) => block?.type === 'toolCall')) return ''
  return content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n').trim()
}

export function predictionRoute(model, registry) {
  const route = SEPARATE_ROUTES.find((item) => item.matches(model))
  if (!route) return null
  let target = model.id === route.id ? model : null
  try {
    target ??= registry?.find?.(model.provider, route.id) ?? null
  } catch {
    target = null
  }
  if (!target || typeof registry?.streamSimple !== 'function') return null
  return { model: target, reasoning: route.reasoning }
}

function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n') : ''
}

export function visibleTurns(entries) {
  const turns = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const message = entry?.type === 'message' ? entry.message : null
    if (!message) continue
    const text = textOf(message.content).trim()
    if (!text) continue
    if (message.role === 'user') {
      if (isHostAutomatedMessage(text)) continue
      turns.push({ user: text, assistant: [] })
    } else if (message.role === 'assistant' && turns.length) turns.at(-1).assistant.push(text)
  }
  return turns.map((turn) => `[user]\n${turn.user}\n\n[assistant]\n${turn.assistant.join('\n\n')}`)
}

export function evidenceStart(turns, start = 0) {
  let from = Math.min(Math.max(0, start), Math.max(0, turns.length - 1))
  const size = (index) => turns.slice(index).reduce((sum, turn) => sum + turn.length, 0)
  if (size(from) <= EVIDENCE_HIGH_CHARS) return from
  while (from < turns.length - 1 && size(from) > EVIDENCE_LOW_CHARS) from += 1
  return from
}

function lastUserText(entries) {
  for (const entry of [...(Array.isArray(entries) ? entries : [])].reverse()) {
    const message = entry?.type === 'message' ? entry.message : null
    if (message?.role !== 'user') continue
    const text = textOf(message.content).trim()
    if (text && !isHostAutomatedMessage(text)) return text
  }
  return ''
}

function branchOf(ctx) {
  try {
    return ctx?.sessionManager?.getBranch?.() ?? []
  } catch {
    return []
  }
}

function suggestionsEnabled() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))?.promptSuggestions !== false
  } catch {
    return true
  }
}

export function createPromptSuggestion({ enabled = suggestionsEnabled } = {}) {
  let lastRequest = null
  let controller = null
  let shown = null
  let ignored = 0
  let backoff = 0
  let failures = 0
  let failureSkips = 0
  let lowerReasoningWorks = true
  let evidenceFrom = { sessionId: null, start: 0 }

  const setStatus = (ui, text) => {
    try {
      ui?.setStatus?.(SUGGESTION_STATUS_KEY, text)
    } catch {
    }
  }

  const cancel = (ui) => {
    controller?.abort()
    controller = null
    if (shown !== null) setStatus(ui, undefined)
  }

  const onRequest = (event, ctx) => {
    const payload = event?.payload
    const model = ctx?.model
    lastRequest = payload && typeof payload === 'object' && model ? { payload, provider: model.provider, id: model.id } : null
  }

  const onAgentStart = (event, ctx) => {
    const prompt = String(event?.prompt ?? '').trim()
    if (shown !== null && prompt && !prompt.startsWith('<subagent-notification')) {
      if (prompt === shown || prompt.startsWith(shown)) {
        ignored = 0
        backoff = 0
      } else ignored += 1
    }
    cancel(ctx?.ui)
    shown = null
  }

  const separateRequest = (route, branch, sessionId) => {
    const turns = visibleTurns(branch)
    if (!turns.length) return null
    const start = evidenceStart(turns, evidenceFrom.sessionId === sessionId ? evidenceFrom.start : 0)
    evidenceFrom = { sessionId, start }
    const messages = turns.slice(start).map((text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }))
    return { model: route.model, context: { systemPrompt: SEPARATE_SYSTEM_PROMPT, messages }, reasoning: route.reasoning }
  }

  const request = async ({ registry, model, plan, sessionId, signal }) => {
    if (plan.separate) {
      return registry.streamSimple(plan.separate.model, plan.separate.context, {
        maxTokens: MAX_TOKENS,
        signal,
        ...(sessionId ? { sessionId: `${sessionId}:prompt-suggestion` } : {}),
        ...(plan.separate.reasoning ? { reasoning: plan.separate.reasoning } : {})
      }).result()
    }
    return registry.complete(model, {
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: '.' }], timestamp: Date.now() }]
    }, { maxTokens: MAX_TOKENS, signal, ...(sessionId ? { sessionId } : {}), onPayload: () => plan.payload })
  }

  const suggest = async ({ registry, model, ui, sessionOf, sessionId, plan, lastUser, signal }) => {
    let response
    try {
      response = await request({ registry, model, plan, sessionId, signal })
    } catch {
      response = { stopReason: signal.aborted ? 'aborted' : 'error' }
    }
    if (signal.aborted || response?.stopReason === 'aborted') return
    if (response?.stopReason === 'error') {
      if (plan.lowered && REASONING_REJECTED.test(String(response?.errorMessage ?? ''))) lowerReasoningWorks = false
      else failures += 1
      return
    }
    failures = 0
    failureSkips = 0
    const text = cleanSuggestion(textOf(response?.content), lastUser)
    if (!text || signal.aborted || sessionOf() !== sessionId) return
    shown = text
    setStatus(ui, text)
  }

  const samePlan = (model, request, reply) => {
    if (!request || request.provider !== model.provider || request.id !== model.id) return null
    const base = appendInstruction(model.api, request.payload, suggestionInstruction(reply), MAX_TOKENS)
    if (!base) return null
    const payload = lowerReasoningWorks ? lowerReasoning(model.api, base) : base
    return { payload, lowered: payload !== base }
  }

  const onAgentEnd = (event, ctx) => {
    if (!enabled()) return
    if (failures >= FAILURE_LIMIT && (failureSkips++ % FAILURE_RETRY_EVERY) !== 0) return
    const model = ctx?.model
    const captured = lastRequest
    lastRequest = null
    const registry = ctx?.modelRegistry
    if (!model || !registry) return
    const reply = finalReply(event?.messages)
    if (!reply) return
    if (ignored >= IGNORED_BEFORE_BACKOFF && (backoff++ % BACKOFF_EVERY) !== 0) return
    const sessionOf = () => {
      try {
        return ctx.sessionManager?.getSessionId?.()
      } catch {
        return undefined
      }
    }
    const sessionId = sessionOf()
    const branch = branchOf(ctx)
    const route = predictionRoute(model, registry)
    const separate = route ? separateRequest(route, branch, sessionId) : null
    const plan = separate ? { separate } : samePlan(model, captured, reply)
    if (!plan) return
    controller?.abort()
    controller = new AbortController()
    void suggest({ registry, model, ui: ctx.ui, sessionOf, sessionId, plan, lastUser: lastUserText(branch), signal: controller.signal })
  }

  const reset = (ui) => {
    cancel(ui)
    lastRequest = null
    shown = null
    evidenceFrom = { sessionId: null, start: 0 }
  }

  return { onRequest, onAgentStart, onAgentEnd, cancel, reset, state: () => ({ shown, ignored, failures, lowerReasoningWorks, evidenceFrom }) }
}

export default function promptSuggestionExtension(pi) {
  const suggestion = createPromptSuggestion()
  registerProviderRequestStage(pi, 'prompt-suggestion', (payload, ctx) => suggestion.onRequest({ payload }, ctx))
  pi.on('before_agent_start', suggestion.onAgentStart)
  pi.on('agent_end', suggestion.onAgentEnd)
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_shutdown']) {
    pi.on(event, (_event, ctx) => suggestion.reset(ctx?.ui))
  }
}
