import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isHostAutomatedMessage } from './host-message.js'

export const ULTRACODE_TYPE = 'yan-ultracode'
export const ULTRACODE_STATE_FILE = 'ultracode-sessions.json'
export const SPARSE_EVERY = 10
export const ULTRACODE_GATE_TYPE = 'yan-ultracode-gate'
export const GATE_LIMIT = 2

const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch'])
const SUBAGENT_START = /\bsubagent\b["'\s,]+start\b([^;&|\n]*)/g
const WORKFLOW_RUN = /\bworkflow\b["'\s,]+run\b([^;&|\n]*)/g
const CODEMODE_EDIT = /\btools\s*\.\s*(?:edit|write|multi_edit|apply_patch)\s*\(/g
const HELP_FLAG = /(?:^|["'`\s,])(?:-h|--help)(?=$|["'`\s,=\\])/
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g

const KEYWORD = /^\s*\/ultracode(?=$|\s)/i

const FULL = `<yan-reminder>
Ultracode is on for this conversation. This is a standing request: the user wants the most complete and correct result and accepts the extra time and tokens. Token usage is not limited and cost is not a concern: never cut agents, review rounds or coverage to save tokens. Before the first substantive task, read \`workflow.md\` in the subagent skill's directory (next to its SKILL.md); it documents the workflow script API, its limits and the quality patterns.

For every substantive task:
- Scout the scope yourself first (list the files, the call sites, the diff) so the script works from a concrete list.
- Write a workflow script and start it with \`yan workflow run --file <script.js>\`. It runs in the background and the host sends you its final answer; do not sleep or poll. A task can take several workflows in a row (understand, change, verify): read each result before you write the next.
- Build the quality pattern into the script: one agent per item, adversarial reviewers that try to refute each finding (a claim that is not clearly confirmed counts as refuted), search rounds until two in a row find nothing new, several angles compared before committing to a plan, fix and recheck until the checks pass.
- The script does not merge worktree agents: when the run ends, review their patches and merge or discard them.
- End with a completeness check: dropped requirements, unread sources, unverified claims. If you cap coverage anywhere, say what was left out.
- Size the run to the user's wording: a quick check needs a few agents, "thorough" or "audit" needs dozens and several reviewers per claim.

Casual questions and trivial edits: do them yourself, without a workflow. In the report, say which parts were verified and which were not.
</yan-reminder>`

const SPARSE = `<yan-reminder>
Ultracode is still on: scout, then write a workflow script (\`workflow.md\` next to the subagent skill) and run it with \`yan workflow run\`; build adversarial review and two-rounds-with-nothing-new into the script, and finish with a completeness check. Token usage is not limited; do not trade coverage for cost.
</yan-reminder>`

const EXIT = `<yan-reminder>
Ultracode is now off. Go back to normal behaviour: do the work yourself and use subagents or workflows only when the task or the user calls for them.
</yan-reminder>`

const KEYWORD_ONLY = `<yan-reminder>
The user asked for Ultracode on this request only (/ultracode). Write a workflow for this request: read \`workflow.md\` in the subagent skill's directory, scout the scope, write the script with adversarial review built in, and start it with \`yan workflow run --file <script.js>\`; the host sends you the final answer when it ends. Finish with a completeness check. Token usage is not limited and cost is not a concern for this request.
</yan-reminder>`

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

const GATE = `<yan-reminder>
Ultracode check: you changed files in this request but no subagent or workflow has reviewed the changes since the last edit. Before you report, start at least one independent read-only reviewer (a subagent, or a review workflow; preferably on a different model) to refute the changes and check for gaps, then act on its findings. If the change is genuinely trivial, say so in one line and finish.
</yan-reminder>`

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
    if (message?.role === 'user' && !isHostAutomatedMessage(messageText(message))) {
      return { prompt: messageText(message), entries: entries.slice(i + 1) }
    }
  }
  return { prompt: '', entries: [] }
}

export function needsReviewGate(branch, slice = requestSlice(branch)) {
  const { prompt, entries } = slice
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
      const startAt = Math.max(commandAt(call.arguments, SUBAGENT_START), commandAt(call.arguments, WORKFLOW_RUN))
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

function commandAt(args, pattern) {
  let at = -1
  for (const raw of argumentStrings(args)) {
    for (const { text, offset } of commandCandidates(raw)) {
      for (const match of blankQuoted(text).matchAll(pattern)) {
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
    const slice = requestSlice(ctx?.sessionManager?.getBranch?.())
    if (!hasKeyword(slice.prompt) && !readEnabled(file, ctx?.sessionManager?.getSessionId?.())) return
    if (!needsReviewGate(undefined, slice).needed) return
    pi.sendMessage({ customType: ULTRACODE_GATE_TYPE, content: GATE, display: false }, { deliverAs: 'followUp' })
  })
}
