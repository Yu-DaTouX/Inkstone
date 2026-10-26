import type { RetryRun, UIMessage } from '../../../../shared/ipc'
import type { SessionTextKey } from './text'

const THOUGHT_HOLD_MS = 2000
const WORKING_SECONDS_FROM_MS = 2000

export type WorkingKind =
  | 'stopping'
  | 'waiting'
  | 'retrying'
  | 'compacting'
  | 'tool'
  | 'thinking'
  | 'thought'
  | 'responding'
  | 'working'
  | 'sending'

export interface ThinkingClock {
  identity: string
  live: boolean
  startedAt: number | null
  endedAt: number | null
  ms: number | null
}

interface WorkingLineInput {
  running: boolean
  stopping?: boolean
  waiting?: boolean
  retry?: Pick<RetryRun, 'attempt' | 'maxAttempts' | 'at' | 'delayMs' | 'error'> | null
  compacting?: boolean
  toolRunning?: boolean
  streaming?: boolean
  requested?: boolean
  thinking?: ThinkingClock | null
  elapsedMs: number | null
  now: number
  tokens?: number | null
  quiet?: boolean
}

export interface WorkingLine {
  kind: WorkingKind
  textKey: SessionTextKey | null
  vars?: Record<string, string | number>
  elapsedMs: number | null
  tokens: number | null
  quiet: boolean
  error?: string
}

const TOKEN_KINDS: ReadonlySet<WorkingKind> = new Set<WorkingKind>(['tool', 'thinking', 'thought', 'responding', 'working'])
const TIMED_KINDS: ReadonlySet<WorkingKind> = new Set<WorkingKind>(['tool', 'thinking', 'thought', 'responding', 'working', 'sending', 'retrying', 'compacting'])
const QUIET_KINDS: ReadonlySet<WorkingKind> = new Set<WorkingKind>(['tool', 'thinking', 'responding', 'working'])

export function trackThinking(
  previous: ThinkingClock | null,
  input: { identity: string; live: boolean; ms?: number; now: number }
): ThinkingClock {
  const same = previous?.identity === input.identity ? previous : null
  if (input.live) {
    if (same?.live) return same
    return { identity: input.identity, live: true, startedAt: input.now, endedAt: null, ms: null }
  }
  if (same?.live) {
    const measured = same.startedAt !== null ? input.now - same.startedAt : null
    const ms = typeof input.ms === 'number' && input.ms > 0 ? input.ms : measured
    return { identity: input.identity, live: false, startedAt: same.startedAt, endedAt: input.now, ms }
  }
  return same ?? { identity: input.identity, live: false, startedAt: null, endedAt: null, ms: null }
}

function wholeSecondsMs(elapsedMs: number | null): number | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < WORKING_SECONDS_FROM_MS) return null
  return Math.floor(elapsedMs / 1000) * 1000
}

function pickKind(input: WorkingLineInput): WorkingKind | null {
  if (input.stopping && input.running) return 'stopping'
  if (input.waiting) return 'waiting'
  if (input.retry) return 'retrying'
  if (input.compacting) return 'compacting'
  if (!input.running) return null
  if (input.toolRunning) return 'tool'
  const thinking = input.thinking
  if (thinking?.live) return 'thinking'
  if (thinking && thinking.endedAt !== null && input.now - thinking.endedAt < THOUGHT_HOLD_MS) return 'thought'
  if (input.streaming) return 'responding'
  return input.requested ? 'working' : 'sending'
}

export function workingLine(input: WorkingLineInput): WorkingLine | null {
  const kind = pickKind(input)
  if (!kind) return null
  const elapsedMs = TIMED_KINDS.has(kind) ? wholeSecondsMs(input.elapsedMs) : null
  const tokens = TOKEN_KINDS.has(kind) && typeof input.tokens === 'number' && input.tokens > 0 ? input.tokens : null
  const quiet = QUIET_KINDS.has(kind) && !!input.quiet
  const base = { kind, elapsedMs, tokens, quiet }
  if (quiet) return { ...base, textKey: 'workActive' }
  switch (kind) {
    case 'stopping':
      return { ...base, textKey: 'workStopping' }
    case 'waiting':
      return { ...base, textKey: 'workWaiting' }
    case 'retrying': {
      const retry = input.retry!
      const left = Math.ceil(Math.max(0, retry.at + retry.delayMs - input.now) / 1000)
      const vars = { n: retry.attempt, m: retry.maxAttempts }
      return {
        ...base,
        textKey: left > 0 ? 'workRetryWait' : 'workRetry',
        vars: left > 0 ? { ...vars, s: left } : vars,
        ...(retry.error ? { error: retry.error } : null)
      }
    }
    case 'compacting':
      return { ...base, textKey: null }
    case 'tool':
      return { ...base, textKey: 'workTool' }
    case 'thinking':
      return { ...base, textKey: 'workThinking' }
    case 'thought': {
      const ms = input.thinking?.ms ?? 0
      return { ...base, textKey: 'workThought', vars: { n: Math.max(1, Math.round(ms / 1000)) } }
    }
    case 'responding':
      return { ...base, textKey: 'workResponding' }
    case 'working':
      return { ...base, textKey: 'workWorking' }
    case 'sending':
      return { ...base, textKey: 'workSending' }
  }
}

export function turnOutputTokens(
  messages: readonly Pick<UIMessage, 'id' | 'role' | 'usage'>[],
  turnUserId: string | null | undefined
): number | null {
  if (!turnUserId) return null
  let at = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && messages[i].id === turnUserId) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const seen = new Set<string>()
  let total = 0
  let counted = false
  for (let i = at + 1; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role === 'user') break
    if (message.role !== 'assistant' || seen.has(message.id)) continue
    seen.add(message.id)
    const output = message.usage?.output
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
      total += output
      counted = true
    }
  }
  return counted ? total : null
}

const TOKEN_UNITS = ['', 'k', 'M', 'B'] as const

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(Number.isFinite(n) ? n : 0)))
  let unit = 0
  let value = n
  while (value >= 1000 && unit < TOKEN_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  let rounded = Math.round(value * 10) / 10
  if (rounded >= 1000 && unit < TOKEN_UNITS.length - 1) {
    rounded = Math.round(rounded / 100) / 10
    unit += 1
  }
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text}${TOKEN_UNITS[unit]}`
}
