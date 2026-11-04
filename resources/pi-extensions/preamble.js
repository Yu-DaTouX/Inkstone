export const NATIVE_PREAMBLE =
  'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.'

export const NATIVE_PREAMBLES = [
  NATIVE_PREAMBLE,
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
]

const nativePreambleIn = (text) => NATIVE_PREAMBLES.find((native) => text.includes(native))

export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), a desktop AI workspace; pi is the underlying execution engine, not the user-facing application. You help users by reading files, executing commands, editing code, and writing new files.'

export const PROGRESS_GUIDANCE = 'Before substantive tool work, say in one short line what you are about to do. While working, after each meaningful step (a finding, a finished change, a failed check, a change of approach), give a one-sentence progress note in plain language; skip notes for routine reads and searches, and do not announce each tool call or explain Inkstone internals (yan CLI, skill files, subagent ids, host notifications) unless asked or the task is about them. Put the complete answer after your last tool call: what was found or changed, claiming only what you observed, then briefly anything unverified or unfinished. If the user requests silence or only a final answer, comply.'

export const WORK_RULES = [
  'When exploring code, read whole files or large ranges, and issue independent reads in parallel in the same turn.'
]

const FALLBACK_GUIDANCE = [PROGRESS_GUIDANCE, ...WORK_RULES.map((rule) => `- ${rule}`)].join('\n')

function addWorkRules(guidelines) {
  if (!Array.isArray(guidelines)) return
  for (const rule of WORK_RULES) if (!guidelines.includes(rule)) guidelines.push(rule)
}

const DOCS_BLOCK = /<docs>\n([\s\S]*?)\n<\/docs>/
const NATIVE_DOCS_MARKER = 'Main documentation:'

function stripNativeDocsBlock(text) {
  const match = DOCS_BLOCK.exec(text)
  if (!match || !match[1].includes(NATIVE_DOCS_MARKER)) return text
  return text.replace(DOCS_BLOCK, '').replace(/\n{3,}/g, '\n\n')
}

const PROGRESS_SECTION = 'inkstone_progress'

function withInkstonePreamble(messages) {
  if (!Array.isArray(messages)) return undefined
  let changed = false
  const next = messages.map((message) => {
    if (message?.role !== 'system') return message
    const sections = message.sections
    const preamble = sections?.preamble
    const native = typeof preamble === 'string' ? nativePreambleIn(preamble) : undefined
    const docs = sections?.docs
    const hasNativeDocs = typeof docs === 'string' && docs.includes(NATIVE_DOCS_MARKER)
    if (!native && !hasNativeDocs) return message
    changed = true
    const nextSections = { ...sections }
    if (native) nextSections.preamble = preamble.replace(native, YAN_PREAMBLE)
    if (hasNativeDocs) nextSections.docs = null
    return { ...message, sections: nextSections }
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
      sections[PROGRESS_SECTION] = PROGRESS_GUIDANCE
      addWorkRules(event.systemPromptOptions.promptGuidelines)
      return
    }
    const native = nativePreambleIn(base)
    const identity = base.includes(YAN_PREAMBLE) ? base : native ? base.replace(native, YAN_PREAMBLE) : `${base}\n\n${YAN_PREAMBLE}`
    const stripped = stripNativeDocsBlock(identity)
    const updated = stripped.includes(FALLBACK_GUIDANCE) ? stripped : `${stripped}\n\n${FALLBACK_GUIDANCE}`
    if (updated === base) return
    return { systemPrompt: updated }
  })
}
