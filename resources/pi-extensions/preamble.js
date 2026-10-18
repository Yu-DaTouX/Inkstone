export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), the desktop AI workspace. pi is the underlying execution engine, not the user-facing application. You help users through Inkstone and its available tools, reading files, executing commands, editing code, and writing new files.'

export const PROGRESS_GUIDANCE = 'Work quietly. Before substantive tool work, say in one short line what you will do. Do not narrate routine steps or announce tool calls, and do not explain Inkstone internals (the yan CLI, skill files, subagent ids, host notifications, artifact commands) unless the user asks. Speak up mid-task only when a step fails, you change approach, you need the user, or a long task reaches a finding the user should see now. Never claim results you have not observed. Finish with the result itself: lead with what was found or changed, without recapping the process. If the user requests silence or only a final answer, follow that.'

const DOCS_BLOCK = /<docs>\n([\s\S]*?)\n<\/docs>/

export function compactDocs(body) {
  const main = /Main documentation:\s*(.+)/.exec(body)?.[1]?.trim()
  if (!main) return undefined
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, skills or models): ${main}; docs/ and examples/ sit next to it.`
}

const PROGRESS_SECTION = 'inkstone_progress'

export function withInkstonePreamble(messages) {
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
