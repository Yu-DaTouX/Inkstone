import type { UIToolCall } from '../../../../shared/ipc'
import type { TurnSegment } from '../../../../shared/turns'
import { countedWorkCalls, toolCategory } from './tool-run-model'
import { isHistoryQuestionCall } from './question-receipt'

export type StripKind = 'think' | 'tool' | 'sub' | 'wait' | 'fail'

export interface StripPart {
  kind: StripKind
  ms: number
}

export const STRIP_MAX_PARTS = 48

const FLOOR_MS = 1000
const RANK: Record<StripKind, number> = { think: 0, tool: 1, sub: 2, wait: 3, fail: 4 }

function span(start: number | undefined, end: number | undefined): number {
  return start && end && end > start ? end - start : 0
}

function callKind(call: UIToolCall): StripKind {
  if (call.status === 'error' && !call.denied && !call.cancelled) return 'fail'
  if (isHistoryQuestionCall(call)) return 'wait'
  return toolCategory(call) === 'agent' ? 'sub' : 'tool'
}

function thinkingSpans(segment: TurnSegment): number[] {
  if (segment.thinkingParts?.length) return segment.thinkingParts.filter((part) => part.text.trim()).map((part) => part.ms ?? 0)
  return segment.thinking.trim() ? [segment.thinkingMs ?? 0] : []
}

export function processStripParts(process: readonly TurnSegment[], max = STRIP_MAX_PARTS): StripPart[] {
  const parts: StripPart[] = []
  for (const segment of process) {
    for (const ms of thinkingSpans(segment)) parts.push({ kind: 'think', ms: Math.max(FLOOR_MS, ms) })
    for (const call of countedWorkCalls(segment.tools)) {
      const ran = span(call.startedAt, call.endedAt)
      const waited = call.approval ? Math.min(span(call.approval.askedAt, call.approval.at), ran || Infinity) : 0
      if (waited >= FLOOR_MS) parts.push({ kind: 'wait', ms: waited })
      parts.push({ kind: callKind(call), ms: Math.max(FLOOR_MS, ran - (waited >= FLOOR_MS ? waited : 0)) })
    }
  }
  return compactStrip(parts, max)
}

function joinSame(parts: readonly StripPart[]): StripPart[] {
  const joined: StripPart[] = []
  for (const part of parts) {
    const last = joined[joined.length - 1]
    if (last && last.kind === part.kind) last.ms += part.ms
    else joined.push({ ...part })
  }
  return joined
}

export function compactStrip(parts: readonly StripPart[], max = STRIP_MAX_PARTS): StripPart[] {
  const joined = joinSame(parts)
  if (joined.length <= max) return joined
  const total = joined.reduce((sum, part) => sum + part.ms, 0)
  const binMs = total / max
  const bins: StripPart[] = []
  let cursor = 0
  for (const part of joined) {
    const first = Math.min(max - 1, Math.floor(cursor / binMs))
    cursor += part.ms
    const last = Math.min(max - 1, Math.max(first, Math.ceil(cursor / binMs) - 1))
    for (let index = first; index <= last; index += 1) {
      const bin = bins[index]
      if (!bin) bins[index] = { kind: part.kind, ms: binMs }
      else if (RANK[part.kind] > RANK[bin.kind]) bin.kind = part.kind
    }
  }
  return joinSame(bins.filter(Boolean))
}
