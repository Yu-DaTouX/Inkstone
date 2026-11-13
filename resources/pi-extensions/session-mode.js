import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GIT_INSPECT_TOOL, WEB_DOCS_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from './readonly-tools.js'
import { isPrimaryRunner } from './ultracode.js'

export const SESSION_MODE_FILE = 'session-modes.json'
export const SESSION_MODE_TYPE = 'yan-session-mode'

export const READ_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls', ...[GIT_INSPECT_TOOL, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_DOCS_TOOL].map((tool) => tool.name)])
const ALLOWED_TOOLS = new Set([...READ_TOOLS, 'todos', 'question', 'codemode'])
const READ_LIST = READ_TOOLS.join(', ')

export const ASK_BLOCK = `Read-only mode (/ask) is on, so the host blocked this tool call and nothing ran. Only read tools run in this mode (${READ_LIST}); edits, shell commands and other tools are blocked. Answer from what you can read and tell the user what you would do; they can switch read-only mode off.`

export const PLAN_BLOCK = `Plan mode (/plan) is on and the user has not approved a plan yet, so the host blocked this tool call and nothing ran. Investigate with read tools (${READ_LIST}), then give the plan and stop; the user approves it with the Approve button, which lifts the block.`

const ASK_ON = `<yan-reminder>
Read-only mode (/ask) is on for this conversation: answer and investigate, but do not change anything. Only read tools run (${READ_LIST}); the host blocks edits, shell commands and every other tool. If the answer calls for a change, describe it and let the user decide; they can switch read-only mode off.
</yan-reminder>`

const PLAN_ON = `<yan-reminder>
Plan mode (/plan) is on: plan first and change nothing yet.
1. Investigate with read tools only (${READ_LIST}); the host blocks edits, shell commands and every other tool until the user approves.
2. Give a numbered, step-by-step plan: what you will change, where, and how you will check it. Record the steps with the todos tool so they show in the user's to-do panel.
3. Then stop and wait for approval. The user approves with the Approve button; if they ask for changes, revise the plan and stop again.
</yan-reminder>`

const PLAN_APPROVED = `<yan-reminder>
The user approved the plan. Plan mode is off and tools are unblocked: carry out the plan step by step and keep the to-do panel up to date. If something forces a different approach, say so before taking it.
</yan-reminder>`

const ASK_OFF = `<yan-reminder>
Read-only mode is off: tools are available again.
</yan-reminder>`

const PLAN_OFF = `<yan-reminder>
Plan mode is off; the user left it without approving the plan. Tools are available again: follow the user's next request.
</yan-reminder>`

export function dataDir(env = process.env) {
  return env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

export function readMode(file, sessionId) {
  if (!sessionId) return 'off'
  try {
    const mode = JSON.parse(readFileSync(file, 'utf8'))?.[sessionId]
    return mode === 'ask' || mode === 'plan' || mode === 'approved' ? mode : 'off'
  } catch {
    return 'off'
  }
}

export function blocksTool(mode, toolName) {
  return (mode === 'ask' || mode === 'plan') && !ALLOWED_TOOLS.has(toolName)
}

export function blockReason(mode) {
  return mode === 'plan' ? PLAN_BLOCK : ASK_BLOCK
}

export function lastAnnouncement(branch) {
  for (let i = (branch?.length ?? 0) - 1; i >= 0; i -= 1) {
    const entry = branch[i]
    if (entry?.type === 'compaction') return 'off'
    if (entry?.type === 'custom_message' && entry.customType === SESSION_MODE_TYPE) {
      const mode = entry.details?.mode
      if (mode === 'ask' || mode === 'plan' || mode === 'approved' || mode === 'off') return mode
    }
  }
  return 'off'
}

export function chooseReminder(mode, last) {
  if (mode === 'ask') return last === 'ask' ? undefined : { mode: 'ask', text: ASK_ON }
  if (mode === 'plan') return last === 'plan' ? undefined : { mode: 'plan', text: PLAN_ON }
  if (mode === 'approved' && last === 'plan') return { mode: 'approved', text: PLAN_APPROVED }
  if (last === 'ask') return { mode: 'off', text: ASK_OFF }
  if (last === 'plan') return { mode: 'off', text: PLAN_OFF }
  return undefined
}

function sessionIdOf(ctx, env) {
  return ctx?.sessionManager?.getSessionId?.() ?? env.YAN_SESSION_ID
}

export default function sessionModeExtension(pi, env = process.env) {
  if (!isPrimaryRunner(env)) return
  const file = join(dataDir(env), SESSION_MODE_FILE)
  pi.on('before_agent_start', (event, ctx) => {
    if (event?.messageType === 'custom') return
    const reminder = chooseReminder(readMode(file, sessionIdOf(ctx, env)), lastAnnouncement(ctx?.sessionManager?.getBranch?.()))
    if (!reminder) return
    return { message: { customType: SESSION_MODE_TYPE, content: reminder.text, display: false, details: { mode: reminder.mode } } }
  })
  pi.on('tool_call', (event, ctx) => {
    const mode = readMode(file, sessionIdOf(ctx, env))
    if (!blocksTool(mode, event?.toolName)) return
    return { block: true, reason: blockReason(mode) }
  })
}
