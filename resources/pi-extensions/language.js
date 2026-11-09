export const LANGUAGE_RULE = "Write the short progress lines between tool calls and the final reply in the language of the user's latest message, even when tool output or this prompt is in another language; code, commands, paths and identifiers stay as they are. Exception: when the project instructions in the working directory (such as AGENTS.md or CLAUDE.md) set a language for talking with the user, follow the project instructions instead."

export default function languageExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_language = LANGUAGE_RULE
      return
    }
    return { systemPrompt: base ? `${base}\n\n${LANGUAGE_RULE}` : LANGUAGE_RULE }
  })
}
