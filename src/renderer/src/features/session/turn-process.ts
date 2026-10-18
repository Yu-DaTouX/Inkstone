import type { UIToolCall } from '../../../../shared/ipc'
import type { TurnSegment } from '../../../../shared/turns'
import { LIVE_SEGMENTS } from './tool-groups'
import { toolGroupLabel } from './tool-summary'

export interface TurnProcessSplit {
  process: TurnSegment[]
  reply: TurnSegment | null
  tail: TurnSegment[]
}

function hasWork(segment: TurnSegment): boolean {
  return segment.commentary.length > 0 || segment.tools.length > 0
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
    return { process: segments.filter(hasWork), reply: null, tail: [] }
  }

  const replySource = segments[at]
  const process = segments.slice(0, at).filter(hasWork)
  if (hasWork(replySource)) {
    process.push({ ...replySource, response: null, responseParts: undefined })
  }
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
  return { process, reply, tail: segments.slice(at + 1) }
}

export function processTools(process: readonly TurnSegment[]): UIToolCall[] {
  return process.flatMap((segment) => segment.tools)
}

export function processNotes(process: readonly TurnSegment[]): string[] {
  return process.flatMap((segment) => segment.commentary.map((part) => part.text))
}

export function failedCount(tools: readonly Pick<UIToolCall, 'status' | 'cancelled'>[]): number {
  return tools.filter((call) => call.status === 'error' && !call.cancelled).length
}

export function runningTool(tools: readonly UIToolCall[]): UIToolCall | null {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const status = tools[i].status
    if (status === 'running' || status === 'pending') return tools[i]
  }
  return null
}

export function narrationLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s+)/, '').replace(/[`*_]/g, '')
}

export function processSummaryLabel(tools: readonly UIToolCall[], zh: boolean, fallback: string): string {
  if (!tools.length) return fallback
  const failed = failedCount(tools)
  const failText = failed > 0 ? (zh ? `（${failed} 个失败）` : ` (${failed} failed)`) : ''
  return toolGroupLabel(tools, zh) + failText
}

export function pickLiveSegments(segments: readonly TurnSegment[], limit = LIVE_SEGMENTS): { shown: TurnSegment[]; hidden: number } {
  const recentFrom = segments.length - limit
  const shown: TurnSegment[] = []
  const dropped: TurnSegment[] = []
  segments.forEach((segment, index) => {
    const pinned = segment.tools.some((call) => call.status === 'running' || call.status === 'pending' || (call.status === 'error' && !call.cancelled))
    if (index >= recentFrom || pinned) shown.push(segment)
    else dropped.push(segment)
  })
  const tools = dropped.reduce((sum, segment) => sum + segment.tools.length, 0)
  return { shown, hidden: tools || dropped.length }
}
