import type { GenerationTiming } from './ipc'

export interface TurnUsageLike {
  output?: number
}

export interface TurnTimingInput {
  usage?: TurnUsageLike
  firstTokenAt?: number
  startedAt?: number
  turnStartedAt?: number
  endedAt: number
}

export interface TurnTiming {
  speed?: number
  elapsedMs?: number
}

export function turnTiming(input: TurnTimingInput): TurnTiming {
  const { usage, firstTokenAt, startedAt, turnStartedAt, endedAt } = input
  const output = usage?.output ?? 0
  const speedFrom = firstTokenAt ?? startedAt
  const elapsedFrom = turnStartedAt ?? startedAt
  const result: TurnTiming = {}
  if (output > 0 && speedFrom !== undefined) {
    const ms = Math.max(1, endedAt - speedFrom)
    result.speed = output / (ms / 1000)
  }
  if (elapsedFrom !== undefined) result.elapsedMs = Math.max(1, endedAt - elapsedFrom)
  return result
}

export interface GenerationTimingInput {
  startedMono: number
  endedMono: number
  firstContentMono?: number
  firstOutputMono?: number
  startEvent?: 'turn_start'
}

export function generationTiming(input: GenerationTimingInput): GenerationTiming | undefined {
  const { startedMono, endedMono, firstContentMono, firstOutputMono, startEvent } = input
  if (!Number.isFinite(startedMono) || !Number.isFinite(endedMono)) return undefined
  const result: GenerationTiming = { durationMs: Math.max(1, Math.round(endedMono - startedMono)) }
  if (startEvent === 'turn_start') result.startEvent = 'turn_start'
  if (firstContentMono !== undefined && Number.isFinite(firstContentMono)) {
    result.ttftMs = Math.max(1, Math.round(firstContentMono - startedMono))
    result.decodeMs = Math.max(1, Math.round(endedMono - firstContentMono))
  }
  if (firstOutputMono !== undefined && Number.isFinite(firstOutputMono)) {
    result.outputDecodeMs = Math.max(1, Math.round(endedMono - firstOutputMono))
  }
  return result
}

export function decodeTokensPerSecond(
  outputTokens: number | undefined,
  decodeMs: number | undefined
): number | undefined {
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) return undefined
  if (typeof decodeMs !== 'number' || !Number.isFinite(decodeMs) || decodeMs <= 0) return undefined
  return outputTokens / (decodeMs / 1000)
}
