import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ULTRACODE_TYPE = 'yan-ultracode'
export const ULTRACODE_STATE_FILE = 'ultracode-sessions.json'
export const SPARSE_EVERY = 10
export const ULTRACODE_GATE_TYPE = 'yan-ultracode-gate'
export const GATE_LIMIT = 2

const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch'])
const SUBAGENT_START = /\bsubagent\b["'\s,]+start\b([^;&|\n]*)/g
const CODEMODE_EDIT = /\btools\s*\.\s*(?:edit|write|multi_edit|apply_patch)\s*\(/g
const HELP_FLAG = /(?:^|["'`\s,])(?:-h|--help)(?=$|["'`\s,=\\])/
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g
const SUBAGENT_NOTICE = /^\s*<subagent-notification\b/

const KEYWORD = /^\s*\/ultracode(?=$|\s)/i

const FULL = `<system-reminder>
Ultracode is on for this conversation. This is a standing request: the user wants the most complete and correct result and accepts the extra time and tokens. Token usage is not limited and cost is not a concern: never cut subagents, review rounds or coverage to save tokens. Before the first substantive task, read the "Ultracode" section of the subagent skill; it is the playbook.

For every substantive task:
- Scout the scope yourself first (list the files, the call sites, the diff) so you have a concrete work list, then fan the list out to subagents.
- Go phase by phase: understand → plan → implement → review. Read each phase's results before you decide the next one.
- Start all parallel subagents of a phase in one tool call, each with a narrow brief (goal, deliverables with file:line evidence, sources, boundary, timeoutMinutes). Do not sleep or poll; the host notifies you.
- Review adversarially: reviewers try to refute, a claim that is not clearly confirmed counts as refuted, and different reviewers take different angles. Keep finding and fixing until two rounds in a row turn up nothing new.
- End with a completeness check: dropped requirements, unread sources, unverified claims. If you cap coverage anywhere, say what was left out.
- Size the team to the user's wording: a quick check needs a few subagents, "thorough" or "audit" needs a larger team and several reviewers per claim. Stay within 24 concurrent subagents.

Casual questions and trivial edits: do them yourself. In the report, say which parts were verified and which were not.
</system-reminder>`

const SPARSE = `<system-reminder>
Ultracode is still on: scout, then fan out by phase, review adversarially until two rounds find nothing new, and finish with a completeness check (subagent skill, "Ultracode"). Token usage is not limited; do not trade coverage for cost.
</system-reminder>`

const EXIT = `<system-reminder>
Ultracode is now off. Go back to normal behaviour: do the work yourself and use subagents only when the task or the user calls for them.
</system-reminder>`

const KEYWORD_ONLY = `<system-reminder>
The user asked for Ultracode on this request only (/ultracode). Follow the "Ultracode" section of the subagent skill for this request: scout the scope, fan out by phase to parallel subagents, review adversarially until two rounds find nothing new, and finish with a completeness check. Token usage is not limited and cost is not a concern for this request.
</system-reminder>`

export function dataDir(env = process.env) {
  return env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

export function readEnabled(file, sessionId) {
  if (!sessionId) return false
  try {
    return JSON.parse(readFileSync(file, 'utf8'))?.[sessionId] === true
  } catch {
    return false
  }
}

export function isPrimaryRunner(env = process.env) {
  if (env.YAN_RUNNER_KIND === 'fork') return false
  const runner = env.YAN_RUNNER_ID
  return !runner || runner === 'primary' || runner === env.YAN_SESSION_ID
}

export function hasKeyword(text) {
  return typeof text === 'string' && KEYWORD.test(text)
}

export function lastAnnouncement(branch) {
  let turnsSince = 0
  for (let i = (branch?.length ?? 0) - 1; i >= 0; i -= 1) {
    const entry = branch[i]
    if (entry?.type === 'compaction') return { mode: 'off', turnsSince: 0 }
    if (entry?.type === 'message' && entry.message?.role === 'user') turnsSince += 1
    if (entry?.type === 'custom_message' && entry.customType === ULTRACODE_TYPE) {
      const mode = entry.details?.mode
      if (mode === 'on' || mode === 'sparse' || mode === 'off') return { mode, turnsSince }
    }
  }
  return { mode: 'off', turnsSince: 0 }
}

export function chooseReminder({ enabled, keyword, last }) {
  const active = last.mode === 'on' || last.mode === 'sparse'
  if (enabled && !active) return { mode: 'on', text: FULL }
  if (enabled && last.turnsSince >= SPARSE_EVERY) return { mode: 'sparse', text: SPARSE }
  if (enabled) return undefined
  if (active) return { mode: 'off', text: keyword ? `${EXIT}\n\n${KEYWORD_ONLY}` : EXIT }
  if (keyword) return { mode: 'keyword', text: KEYWORD_ONLY }
  return undefined
}

const GATE = `<system-reminder>
Ultracode check: you changed files in this request but no subagent has reviewed the changes since the last edit. Before you report, start at least one independent read-only reviewer (preferably on a different model) to refute the changes and check for gaps, then act on its findings. If the change is genuinely trivial, say so in one line and finish.
</system-reminder>`

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text ?? '' : '')).join('') : ''
}

function toolCalls(message) {
  return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === 'toolCall') : []
}

export function requestSlice(branch) {
  const entries = branch ?? []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = entries[i]?.type === 'message' ? entries[i].message : undefined
    if (message?.role === 'user' && !SUBAGENT_NOTICE.test(messageText(message))) {
      return { prompt: messageText(message), entries: entries.slice(i + 1) }
    }
  }
  return { prompt: '', entries: [] }
}

export function needsReviewGate(branch) {
  const { prompt, entries } = requestSlice(branch)
  let edited = false
  let reviewed = false
  let gates = 0
  for (const entry of entries) {
    if (entry?.type === 'custom_message' && entry.customType === ULTRACODE_GATE_TYPE) gates += 1
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue
    for (const call of toolCalls(entry.message)) {
      if (EDIT_TOOLS.has(call.name)) {
        edited = true
        reviewed = false
        continue
      }
      const editAt = codemodeEditAt(call)
      const startAt = subagentStartAt(call.arguments)
      if (editAt >= 0) {
        edited = true
        reviewed = startAt > editAt
      } else if (startAt >= 0) {
        reviewed = true
      }
    }
  }
  return { prompt, needed: edited && !reviewed && gates < GATE_LIMIT }
}

function codemodeEditAt(call) {
  if (call.name !== 'codemode') return -1
  let at = -1
  for (const match of blankQuoted(String(call.arguments?.code ?? '')).matchAll(CODEMODE_EDIT)) at = match.index
  return at
}

function argumentStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) out.push(value.join(' '))
    else for (const item of value) argumentStrings(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) argumentStrings(item, out)
  }
  return out
}

function blankQuoted(text) {
  return text.replace(QUOTED, (quoted) => ' '.repeat(quoted.length)).replace(/\\\r?\n/g, (joint) => ' '.repeat(joint.length))
}

function commandCandidates(text) {
  const candidates = [{ text, offset: 0 }]
  for (const match of text.matchAll(QUOTED)) candidates.push({ text: match[0].slice(1, -1), offset: match.index + 1 })
  return candidates
}

function subagentStartAt(args) {
  let at = -1
  for (const raw of argumentStrings(args)) {
    for (const { text, offset } of commandCandidates(raw)) {
      for (const match of blankQuoted(text).matchAll(SUBAGENT_START)) {
        const options = match[1].replace(/(?:^|\s)#.*$/, '')
        if (!HELP_FLAG.test(options)) at = Math.max(at, offset + match.index)
      }
    }
  }
  return at
}

export default function ultracodeExtension(pi) {
  if (!isPrimaryRunner()) return
  const file = join(dataDir(), ULTRACODE_STATE_FILE)
  pi.on('before_agent_start', (event, ctx) => {
    if (event?.messageType === 'custom') return
    const sessionId = ctx?.sessionManager?.getSessionId?.()
    const reminder = chooseReminder({
      enabled: readEnabled(file, sessionId),
      keyword: hasKeyword(event?.prompt),
      last: lastAnnouncement(ctx?.sessionManager?.getBranch?.())
    })
    if (!reminder) return
    return { message: { customType: ULTRACODE_TYPE, content: reminder.text, display: false, details: { mode: reminder.mode } } }
  })
  pi.on('agent_before_settle', (event, ctx) => {
    if (event?.outcome && event.outcome !== 'completed') return
    const branch = ctx?.sessionManager?.getBranch?.()
    const gate = needsReviewGate(branch)
    if (!gate.needed) return
    if (!readEnabled(file, ctx?.sessionManager?.getSessionId?.()) && !hasKeyword(gate.prompt)) return
    pi.sendMessage({ customType: ULTRACODE_GATE_TYPE, content: GATE, display: false }, { deliverAs: 'followUp' })
  })
}
