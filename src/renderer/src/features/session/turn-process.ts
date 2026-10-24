import type { UIToolCall } from '../../../../shared/ipc'
import type { TurnSegment, TurnThinking } from '../../../../shared/turns'
import { isWebTool } from './tool-run-model'

const LIVE_SEGMENTS = 3

interface TurnProcessSplit {
  process: TurnSegment[]
  reply: TurnSegment | null
  earlierReplies: TurnSegment[]
  tail: TurnSegment[]
}

function hasWork(segment: TurnSegment): boolean {
  return segment.commentary.length > 0 || segment.tools.length > 0
}

function hasThinking(segment: TurnSegment): boolean {
  return segment.thinking.trim().length > 0
}

function inProcess(segment: TurnSegment): boolean {
  return hasWork(segment) || hasThinking(segment)
}

function withWork(process: TurnSegment[]): TurnSegment[] {
  return process.some(hasWork) ? process : []
}

export function splitTurnProcess(segments: readonly TurnSegment[]): TurnProcessSplit {
  let at = -1
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].response) {
      at = i
      break
    }
  }
  if (at < 0) {
    return { process: withWork(segments.filter(inProcess)), reply: null, earlierReplies: [], tail: [] }
  }

  const replySource = segments[at]
  const earlierReplies = segments.slice(0, at).filter((segment) => !!segment.response)
  const candidates = segments.slice(0, at).filter(inProcess)
  if (inProcess(replySource)) {
    candidates.push({ ...replySource, response: null, responseParts: undefined })
  }
  const process = withWork(candidates)
  const reply: TurnSegment = {
    ...replySource,
    thinking: '',
    thinkingMs: undefined,
    thinkingLive: false,
    commentary: [],
    tools: [],
    texts: [],
    responseParts: replySource.responseParts
  }
  return { process, reply, earlierReplies, tail: segments.slice(at + 1) }
}

function rawThinkingParts(segment: TurnSegment): TurnThinking[] {
  if (segment.thinkingParts) return segment.thinkingParts
  if (!hasThinking(segment)) return []
  return [{ text: segment.thinking, at: 0, ...(segment.thinkingMs ? { ms: segment.thinkingMs } : {}) }]
}

interface ProcessThinking extends TurnThinking {
  live: boolean
}

type ProcessStep =
  | { kind: 'thinking'; key: string; thinking: ProcessThinking }
  | { kind: 'tools'; key: string; tools: UIToolCall[] }

function segmentThinking(segment: TurnSegment): ProcessThinking[] {
  const joined: TurnThinking[] = []
  for (const part of rawThinkingParts(segment)) {
    if (!part.text.trim()) continue
    const at = Math.max(0, Math.min(part.at, segment.tools.length))
    const last = joined[joined.length - 1]
    if (last && last.at === at) {
      const ms = (last.ms ?? 0) + (part.ms ?? 0)
      joined[joined.length - 1] = { text: `${last.text}\n\n${part.text}`, at, ...(ms ? { ms } : {}) }
    } else {
      joined.push({ ...part, at })
    }
  }
  return joined.map((part, index) => ({ ...part, live: segment.thinkingLive && index === joined.length - 1 }))
}

export function segmentSteps(segment: TurnSegment): { lead: ProcessThinking[]; steps: ProcessStep[] } {
  const thinking = segmentThinking(segment)
  const lead = thinking.filter((part) => part.at === 0)
  const steps: ProcessStep[] = []
  let from = 0
  for (const part of thinking) {
    if (part.at === 0) continue
    if (part.at > from) {
      steps.push({ kind: 'tools', key: `tools:${from}`, tools: segment.tools.slice(from, part.at) })
      from = part.at
    }
    steps.push({ kind: 'thinking', key: `thinking:${part.at}`, thinking: part })
  }
  if (from < segment.tools.length) steps.push({ kind: 'tools', key: `tools:${from}`, tools: segment.tools.slice(from) })
  return { lead, steps }
}

export function conciseSegment(segment: TurnSegment): TurnSegment {
  if (!segment.thinking && !segment.thinkingParts?.length) return segment
  const live = segment.thinkingLive ? rawThinkingParts(segment).filter((part) => part.text.trim()).at(-1) : undefined
  const kept = live ? { ...live, at: segment.tools.length } : null
  return {
    ...segment,
    thinking: kept ? kept.text : '',
    thinkingMs: kept?.ms,
    thinkingLive: !!kept,
    thinkingParts: kept ? [kept] : []
  }
}

export function withoutThinking(segment: TurnSegment): TurnSegment {
  if (!segment.thinking && !segment.thinkingParts?.length && !segment.thinkingLive) return segment
  return { ...segment, thinking: '', thinkingMs: undefined, thinkingLive: false, thinkingParts: [] }
}

export function mergeQuietSegments(process: readonly TurnSegment[]): TurnSegment[] {
  const merged: TurnSegment[] = []
  for (const segment of process) {
    const previous = merged[merged.length - 1]
    if (previous && !segment.commentary.length && previous.tools.length && segment.tools.length) {
      const thinkingMs = (previous.thinkingMs ?? 0) + (segment.thinkingMs ?? 0)
      const offset = previous.tools.length
      merged[merged.length - 1] = {
        ...previous,
        thinking: [previous.thinking, segment.thinking].filter((part) => part.trim()).join('\n\n'),
        thinkingMs: thinkingMs || undefined,
        thinkingLive: previous.thinkingLive || segment.thinkingLive,
        thinkingParts: [...rawThinkingParts(previous), ...rawThinkingParts(segment).map((part) => ({ ...part, at: part.at + offset }))],
        tools: [...previous.tools, ...segment.tools]
      }
    } else {
      merged.push(segment)
    }
  }
  return merged
}

export function pickLiveSegments(segments: readonly TurnSegment[], limit = LIVE_SEGMENTS): { shown: TurnSegment[]; hidden: number } {
  const recentFrom = segments.length - limit
  const shown: TurnSegment[] = []
  const dropped: TurnSegment[] = []
  segments.forEach((segment, index) => {
    const pinned = segment.tools.some((call) => isWebTool(call) || call.status === 'running' || call.status === 'pending' || (call.status === 'error' && !call.cancelled))
    if (index >= recentFrom || pinned) shown.push(segment)
    else dropped.push(segment)
  })
  const tools = dropped.reduce((sum, segment) => sum + segment.tools.length, 0)
  return { shown, hidden: tools || dropped.length }
}
