import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hostToolsAvailable, toolText } from './host-tool-call.js'

export const WRAP_UP_TOOL_NAME = 'wrap_up'

const MAX_ACTIONS = 2

export const WRAP_UP_GUIDANCE = [
  'Only when the next step truly needs the user to decide, call `wrap_up` once, right before your final reply. Otherwise do not call it, and never invent a next step to show a card; completed results go in the final reply only.',
  'If your reply asks the user a question or waits for their go-ahead, put the same question in `ask` with 1-2 `actions` (the first is your recommendation); never leave it only in the reply text.'
].join('\n')

const WRAP_UP_TOOL = {
  name: WRAP_UP_TOOL_NAME,
  label: 'Wrap up',
  description: 'Decision card before the final reply: recap, one question, 1-2 reply buttons. Not for completed results alone. Returns immediately.',
  parameters: {
    type: 'object',
    properties: {
      recap: { type: 'string', description: '2-3 sentences: what is done, and what is not done or not verified.' },
      ask: { type: 'string', description: 'The pending decision. Required whenever the final reply asks the user something or waits for their go-ahead; same question.' },
      actions: {
        type: 'array',
        maxItems: MAX_ACTIONS,
        description: 'Reply buttons for ask; the first is recommended.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short button text.' },
            message: { type: 'string', description: 'The complete reply sent on click, in the user\'s words; no blanks such as ___.' }
          },
          required: ['label', 'message']
        }
      }
    },
    required: ['recap']
  }
}

function settingsFile(env) {
  const dir = env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

export function wrapUpEnabled(env = process.env) {
  try {
    return JSON.parse(readFileSync(settingsFile(env), 'utf8'))?.wrapUpCard !== false
  } catch {
    return true
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function wrapUpDetails(params) {
  const source = params && typeof params === 'object' ? params : {}
  const recap = clean(source.recap)
  const ask = clean(source.ask)
  const actions = ask && Array.isArray(source.actions)
    ? source.actions
      .map((item) => ({ label: clean(item?.label), message: clean(item?.message) }))
      .filter((item) => item.label && item.message)
      .slice(0, MAX_ACTIONS)
    : []
  return { recap, ...(ask ? { ask } : {}), actions }
}

export function createWrapUpTool() {
  return {
    ...WRAP_UP_TOOL,
    async execute(_toolCallId, params) {
      const details = wrapUpDetails(params)
      if (!details.recap) return toolText('wrap_up needs a recap.', details, true)
      if (!details.ask) return toolText('No pending decision; no card shown. Put the result in your final reply.', details)
      return toolText('Shown to the user.', details)
    }
  }
}

function toolNames(list) {
  return (Array.isArray(list) ? list : []).map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter(Boolean)
}

export function syncWrapUpTool(pi, enabled) {
  if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return
  try {
    const active = toolNames(pi.getActiveTools())
    const present = active.includes(WRAP_UP_TOOL_NAME)
    if (enabled && !present && toolNames(pi.getAllTools?.()).includes(WRAP_UP_TOOL_NAME)) pi.setActiveTools([...active, WRAP_UP_TOOL_NAME])
    if (!enabled && present) pi.setActiveTools(active.filter((name) => name !== WRAP_UP_TOOL_NAME))
  } catch {
    return
  }
}

export default function wrapUp(pi) {
  if (!hostToolsAvailable() || typeof pi.registerTool !== 'function') return
  let registered = false
  const register = () => {
    if (registered) return
    pi.registerTool(createWrapUpTool())
    registered = true
  }
  if (wrapUpEnabled()) register()
  pi.on('before_agent_start', (event) => {
    const enabled = wrapUpEnabled()
    if (enabled) register()
    syncWrapUpTool(pi, enabled)
    if (!enabled) return
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_wrap_up = WRAP_UP_GUIDANCE
      return
    }
    const base = String(event?.systemPrompt ?? '')
    return { systemPrompt: base ? `${base}\n\n${WRAP_UP_GUIDANCE}` : WRAP_UP_GUIDANCE }
  })
  pi.on('tool_call', (event) => {
    if (event?.toolName === WRAP_UP_TOOL_NAME && !wrapUpEnabled()) {
      return { block: true, reason: 'wrap_up is turned off in Inkstone settings.' }
    }
  })
}
