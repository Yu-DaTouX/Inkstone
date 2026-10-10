/** Identify Inkstone without replacing pi tools, rules or project context.
 * An unknown upstream preamble keeps its text and receives an explicit identity suffix. */
/** pi 内置 preamble（0.87.1 起，逐字取自 bundle 的 buildSystemPromptSections）。 */
export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

/** Inkstone identity; pi remains the execution engine. */
export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), the desktop AI workspace. pi is the underlying execution engine, not the user-facing application. You help users through Inkstone and its available tools, reading files, executing commands, editing code, and writing new files.'

export const PROGRESS_GUIDANCE = 'For tasks requiring substantive tool work, briefly tell the user what you are about to check before the first tool call, in the language of the conversation. While working, share concise progress when you learn something meaningful or change approach; do not silently chain a long series of tools until the final answer. Keep these updates short and factual, without narrating each routine call or claiming results before observing them. If the user explicitly requests silence or only a final answer, follow that preference.'

export default function preambleExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    const identity = base.includes(YAN_PREAMBLE) ? base : base.includes(NATIVE_PREAMBLE) ? base.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) : `${base}\n\n${YAN_PREAMBLE}`
    const updated = identity.includes(PROGRESS_GUIDANCE) ? identity : `${identity}\n\n${PROGRESS_GUIDANCE}`
    if (updated === base) return
    return { systemPrompt: updated }
  })
}
