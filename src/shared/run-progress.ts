import type { TurnTerminalReason } from './ipc'

export type RunPhase =
  | 'preparing'
  | 'requesting'
  | 'thinking'
  | 'tool'
  | 'responding'
  | 'compacting'
  | 'settled'
  | 'failed'
  | 'cancelled'

interface RunProgressInput {
  running: boolean
  streaming: boolean
  compacting?: boolean
  tool: { name: string; startedAt?: number } | null
  thinking: boolean
  requested: boolean
  terminal: TurnTerminalReason | null
  startedAt: number | null
  now: number
  longMs?: number
}

export interface RunProgress {
  phase: RunPhase
  since: number | null
  detail?: string
  long: boolean
  elapsedMs: number
}

export interface RunClock {
  identity: string
  startedAt: number
}

export function resolveRunClock(previous: RunClock | null, input: {
  identity: string; running: boolean; startedAt?: number; now: number
}): RunClock | null {
  if (!input.running) return null
  const reported = input.startedAt
  const startedAt = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? reported
    : previous?.identity === input.identity ? previous.startedAt : input.now
  return { identity: input.identity, startedAt }
}

const DEFAULT_LONG_MS = 30_000

const ACTIVE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'preparing',
  'requesting',
  'thinking',
  'tool',
  'responding',
  'compacting'
])

export function deriveRunProgress(input: RunProgressInput): RunProgress {
  const startedAt = input.startedAt ?? input.now
  const elapsedMs = Math.max(0, input.now - startedAt)
  const long = elapsedMs >= (input.longMs ?? DEFAULT_LONG_MS)

  const phase: RunPhase =
    input.terminal === 'failed'
      ? 'failed'
      : input.terminal === 'stopped' || input.terminal === 'interrupted'
        ? 'cancelled'
        : input.terminal === 'completed'
          ? 'settled'
          : input.compacting
            ? 'compacting'
            : input.tool
              ? 'tool'
              : input.streaming
                ? 'responding'
                : input.thinking
                  ? 'thinking'
                  : input.running && input.requested
                    ? 'requesting'
                    : input.running
                      ? 'preparing'
                      : 'settled'

  return {
    phase,
    since: startedAt,
    ...(phase === 'tool' && input.tool ? { detail: input.tool.name } : {}),
    long: long && phase !== 'compacting' && ACTIVE_PHASES.has(phase),
    elapsedMs
  }
}
