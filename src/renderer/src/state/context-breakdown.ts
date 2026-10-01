import type { UIMessage } from '../../../shared/ipc'

/**
 * Splits the agent-reported context total into categories for display.
 *
 * pi reports only the total, so per-category sizes are estimated from the visible message text
 * and the remainder is attributed to the system prompt, tool definitions and compaction summary.
 * The estimates never exceed the reported total.
 */
export type ContextCategory = 'system' | 'user' | 'assistant' | 'thinking' | 'tools'
export interface ContextSlice { id: ContextCategory; tokens: number }

const IMAGE_TOKENS = 1200

/** Rough tokenizer: ASCII runs average ~4 chars per token, other scripts ~1 char per token. */
export function estimateTokens(text: string | undefined): number {
  if (!text) return 0
  let ascii = 0, other = 0
  for (let i = 0; i < text.length; i++) text.charCodeAt(i) < 128 ? ascii++ : other++
  return Math.ceil(ascii / 4 + other)
}

function argsText(args: unknown): string {
  if (typeof args === 'string') return args
  try { return JSON.stringify(args) ?? '' } catch { return '' }
}

/** Messages after `since` (the latest compaction) are counted; earlier ones live in the summary. */
export function contextBreakdown(messages: readonly UIMessage[], total: number, since?: number): ContextSlice[] {
  const sums: Record<Exclude<ContextCategory, 'system'>, number> = { user: 0, assistant: 0, thinking: 0, tools: 0 }
  for (const m of messages) {
    if (since && (m.timestamp ?? 0) < since) continue
    if (m.role === 'user') sums.user += estimateTokens(m.text) + (m.images?.length ?? 0) * IMAGE_TOKENS
    else if (m.role === 'bash') sums.tools += estimateTokens(m.bash?.command) + estimateTokens(m.text)
    else {
      sums.assistant += estimateTokens(m.text)
      sums.thinking += estimateTokens(m.thinking)
      for (const call of m.toolCalls ?? []) {
        sums.tools += estimateTokens(call.argsRaw ?? argsText(call.args)) + estimateTokens(call.output) + (call.images?.length ?? 0) * IMAGE_TOKENS
      }
    }
  }
  const counted = sums.user + sums.assistant + sums.thinking + sums.tools
  /* Estimates above the real total are scaled down; the system share is whatever remains. */
  const scale = counted > total ? total / counted : 1
  const parts = (Object.keys(sums) as Array<keyof typeof sums>).map(id => ({ id, tokens: Math.round(sums[id] * scale) }))
  const system = Math.max(0, total - parts.reduce((n, p) => n + p.tokens, 0))
  return [{ id: 'system', tokens: system }, ...parts]
}
