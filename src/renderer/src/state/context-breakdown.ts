import type { ContextFrom, SessionState, UIMessage } from '../../../shared/ipc'

export type ContextCategory = 'system' | 'user' | 'assistant' | 'thinking' | 'tools'
export interface ContextSlice { id: ContextCategory; tokens: number }

const IMAGE_TOKENS = 1200
const KEEP_RECENT_TOKENS = 20_000

export function contextFromOf(session: Pick<SessionState, 'contextFrom' | 'lastCompaction'> | null | undefined): ContextFrom | undefined {
  if (session?.contextFrom) return session.contextFrom
  const last = session?.lastCompaction
  if (last?.status !== 'completed') return undefined
  const compactedAt = last.startedAt ?? last.endedAt
  if (!last.firstKeptEntryId && compactedAt === undefined) return undefined
  return { firstKeptEntryId: last.firstKeptEntryId, compactedAt }
}

function cutEstimate(m: UIMessage): number {
  let chars = (m.text?.length ?? 0) + (m.thinking?.length ?? 0) + (m.bash?.command.length ?? 0)
  let images = m.images?.length ?? 0
  for (const call of m.toolCalls ?? []) {
    chars += call.name.length + (call.argsRaw ?? argsText(call.args)).length + (call.output?.length ?? 0)
    images += call.images?.length ?? 0
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS
}

export function inContextMessages(messages: readonly UIMessage[], from: ContextFrom | undefined): readonly UIMessage[] {
  if (!from) return messages
  if (from.firstKeptEntryId) {
    const kept = messages.findIndex((m) => m.entryId === from.firstKeptEntryId)
    if (kept >= 0) return messages.slice(kept)
  }
  const at = from.compactedAt
  if (at === undefined) return messages
  let after = messages.findIndex((m) => (m.timestamp ?? 0) >= at)
  if (after < 0) after = messages.length
  let start = after
  let kept = 0
  for (let i = after - 1; i >= 0; i--) {
    kept += cutEstimate(messages[i])
    start = i
    if (kept >= KEEP_RECENT_TOKENS) break
  }
  return messages.slice(start)
}

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

type MessageSums = Record<Exclude<ContextCategory, 'system'>, number>

const messageSums = new WeakMap<UIMessage, MessageSums>()

function sumsOf(m: UIMessage): MessageSums {
  const hit = messageSums.get(m)
  if (hit) return hit
  const sums: MessageSums = { user: 0, assistant: 0, thinking: 0, tools: 0 }
  if (m.role === 'user' || m.role === 'note') sums.user += estimateTokens(m.text) + (m.images?.length ?? 0) * IMAGE_TOKENS
  else if (m.role === 'bash') sums.tools += estimateTokens(m.bash?.command) + estimateTokens(m.text)
  else {
    sums.assistant += estimateTokens(m.text)
    sums.thinking += estimateTokens(m.thinking)
    for (const call of m.toolCalls ?? []) {
      sums.tools += estimateTokens(call.argsRaw ?? argsText(call.args)) + estimateTokens(call.output) + (call.images?.length ?? 0) * IMAGE_TOKENS
    }
  }
  messageSums.set(m, sums)
  return sums
}

export function contextBreakdown(messages: readonly UIMessage[], total: number): ContextSlice[] {
  const sums: MessageSums = { user: 0, assistant: 0, thinking: 0, tools: 0 }
  for (const m of messages) {
    const own = sumsOf(m)
    sums.user += own.user
    sums.assistant += own.assistant
    sums.thinking += own.thinking
    sums.tools += own.tools
  }
  const counted = sums.user + sums.assistant + sums.thinking + sums.tools
  const scale = counted > total ? total / counted : 1
  const parts = (Object.keys(sums) as Array<keyof typeof sums>).map(id => ({ id, tokens: Math.round(sums[id] * scale) }))
  const system = Math.max(0, total - parts.reduce((n, p) => n + p.tokens, 0))
  return [{ id: 'system', tokens: system }, ...parts]
}
