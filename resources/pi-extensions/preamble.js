/** Identify Inkstone without replacing pi tools, rules or project context.
 * An unknown upstream preamble keeps its text and receives an explicit identity suffix. */
/** pi 内置 preamble（0.87.1 起，逐字取自 bundle 的 buildSystemPromptSections）。 */
export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

/** Inkstone identity; pi remains the execution engine. */
export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), the desktop AI workspace. pi is the underlying execution engine, not the user-facing application. You help users through Inkstone and its available tools, reading files, executing commands, editing code, and writing new files.'

export const PROGRESS_GUIDANCE = 'Before substantive tool work, say in one line what you will check; while working, give a short update when you learn something meaningful or change approach, without narrating each routine call or claiming results you have not observed. If the user requests silence or only a final answer, follow that.'

/*
 * pi 的 <docs> 段（约 370 token）列出全部文档路径与阅读要求，只在用户问 pi 本身时有用。
 * 砚的用户很少问 pi 内部，这里压成一行入口：保留主文档路径，其余目录在它旁边，用到时再读。
 * 认不出段落形状时原样保留。
 */
const DOCS_BLOCK = /<docs>\n([\s\S]*?)\n<\/docs>/

export function compactDocs(body) {
  const main = /Main documentation:\s*(.+)/.exec(body)?.[1]?.trim()
  if (!main) return undefined
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, skills or models): ${main}; docs/ and examples/ sit next to it.`
}

export default function preambleExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const identity = base.includes(YAN_PREAMBLE) ? base : base.includes(NATIVE_PREAMBLE) ? base.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) : `${base}\n\n${YAN_PREAMBLE}`
    const docs = DOCS_BLOCK.exec(identity)
    const short = docs ? compactDocs(docs[1]) : undefined
    const compacted = short ? identity.replace(DOCS_BLOCK, `<docs>\n${short}\n</docs>`) : identity
    /* 同时写具名分区：只转发结构化部分的 provider 用分区重新拼提示，同名分区覆盖 pi 内置的 docs */
    const sections = event?.systemPromptOptions?.sections
    if (short && sections && typeof sections === 'object') sections.docs = short
    const updated = compacted.includes(PROGRESS_GUIDANCE) ? compacted : `${compacted}\n\n${PROGRESS_GUIDANCE}`
    if (updated === base) return
    return { systemPrompt: updated }
  })
}
