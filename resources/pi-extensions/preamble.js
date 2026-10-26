export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), a desktop AI workspace; pi is the underlying execution engine, not the user-facing application. You help users by reading files, executing commands, editing code, and writing new files.'

export const PROGRESS_GUIDANCE = 'Work quietly. Before substantive tool work, state your plan once in one short line. Do not narrate routine steps, announce tool calls or explain Inkstone internals (yan CLI, skill files, subagent ids, host notifications) unless asked or the task is about them. Speak mid-task only when a step fails, you change approach, you need the user, or a finding would change what the user decides. Put the complete answer after your last tool call: what was found or changed, claiming only what you observed, then briefly anything unverified or unfinished. If the user requests silence or only a final answer, comply.'

export const WORK_RULES = [
  'When exploring code, read whole files or large ranges, and issue independent reads in parallel in the same turn.'
]

const FALLBACK_GUIDANCE = [PROGRESS_GUIDANCE, ...WORK_RULES.map((rule) => `- ${rule}`)].join('\n')

function addWorkRules(guidelines) {
  if (!Array.isArray(guidelines)) return
  for (const rule of WORK_RULES) if (!guidelines.includes(rule)) guidelines.push(rule)
}

const DOCS_BLOCK =/<docs>\n([\s\S]*?)\n<\/docs>/

function compactDocs(body) {
  const main = /Main documentation:\s*(.+)/.exec(body)?.[1]?.trim()
  if (!main) return undefined
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, skills or models): ${main}; docs/ and examples/ sit next to it.`
}

const PROGRESS_SECTION = 'inkstone_progress'

function withInkstonePreamble(messages) {
  if (!Array.isArray(messages)) return undefined
  let changed = false
  const next = messages.map((message) => {
    const preamble = message?.role === 'system' ? message.sections?.preamble : undefined
    if (typeof preamble !== 'string' || !preamble.includes(NATIVE_PREAMBLE)) return message
    changed = true
    return { ...message, sections: { ...message.sections, preamble: preamble.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) } }
  })
  return changed ? next : undefined
}

export default function preambleExtension(pi) {
  pi.on('context_with_system', (event) => {
    const messages = withInkstonePreamble(event?.messages)
    return messages ? { messages } : undefined
  })
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      const docs = DOCS_BLOCK.exec(base)
      const short = docs ? compactDocs(docs[1]) : undefined
      if (short) sections.docs = short
      sections[PROGRESS_SECTION] = PROGRESS_GUIDANCE
      addWorkRules(event.systemPromptOptions.promptGuidelines)
      return
    }
    const identity = base.includes(YAN_PREAMBLE) ? base : base.includes(NATIVE_PREAMBLE) ? base.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) : `${base}\n\n${YAN_PREAMBLE}`
    const docs = DOCS_BLOCK.exec(identity)
    const short = docs ? compactDocs(docs[1]) : undefined
    const compacted = short ? identity.replace(DOCS_BLOCK, `<docs>\n${short}\n</docs>`) : identity
    const updated = compacted.includes(FALLBACK_GUIDANCE) ? compacted : `${compacted}\n\n${FALLBACK_GUIDANCE}`
    if (updated === base) return
    return { systemPrompt: updated }
  })
}
