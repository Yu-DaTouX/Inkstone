/** Identify Inkstone without replacing pi tools, rules or project context.
 * An unknown upstream preamble keeps its text and receives an explicit identity suffix. */
/** pi 内置 preamble（0.87.1 起，逐字取自 bundle 的 buildSystemPromptSections）。 */
export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

/** Inkstone identity; pi remains the execution engine. */
export const YAN_PREAMBLE =
  'You are an assistant operating inside Inkstone (砚), the desktop AI workspace. pi is the underlying execution engine, not the user-facing application. You help users through Inkstone and its available tools, reading files, executing commands, editing code, and writing new files.'

export default function preambleExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    if (base.includes(YAN_PREAMBLE)) return
    const updated = base.includes(NATIVE_PREAMBLE) ? base.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) : `${base}\n\n${YAN_PREAMBLE}`
    return { systemPrompt: updated }
  })
}
