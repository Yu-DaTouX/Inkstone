export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), the desktop AI workspace. pi is the underlying execution engine, not the user-facing application. You help users through Inkstone and its available tools, reading files, executing commands, editing code, and writing new files.'

export const PROGRESS_GUIDANCE = 'Work quietly. Before substantive tool work, state your plan once per request in one short line. Do not narrate routine steps or announce tool calls, and do not explain Inkstone internals (yan CLI, skill files, subagent ids, host notifications) unless asked or the task is about them. Mid-task, speak only when a step fails, you change approach, you need the user, a finding would change what the user decides, or a long run with no to-dos enters a new phase. Write status lines in your reply language. Once the requested change is made and the relevant tests or checks pass, stop and report; do not re-read, refactor or re-verify unchanged code. Put the complete answer after your last tool call, never only in text between tool calls. Finish with the result, not a recap: what was found or changed, claiming only what you observed, then briefly anything unverified or unfinished. If the user requests silence or only a final answer, comply.'

const DOCS_BLOCK = /<docs>\n([\s\S]*?)\n<\/docs>/

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
      return
    }
    const identity = base.includes(YAN_PREAMBLE) ? base : base.includes(NATIVE_PREAMBLE) ? base.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) : `${base}\n\n${YAN_PREAMBLE}`
    const docs = DOCS_BLOCK.exec(identity)
    const short = docs ? compactDocs(docs[1]) : undefined
    const compacted = short ? identity.replace(DOCS_BLOCK, `<docs>\n${short}\n</docs>`) : identity
    const updated = compacted.includes(PROGRESS_GUIDANCE) ? compacted : `${compacted}\n\n${PROGRESS_GUIDANCE}`
    if (updated === base) return
    return { systemPrompt: updated }
  })
}
