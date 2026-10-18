import type { BotMood } from '../../patterns/model-bot/draw'
import type { RunPhase } from '../../../../shared/runs'

export function sessionBotMood(phase: RunPhase | null): BotMood | null {
  if (!phase) return null
  if (phase.kind === 'running') return 'work'
  if (phase.kind === 'needs-you' || phase.kind === 'stalled') return 'ask'
  return null
}
