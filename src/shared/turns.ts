import type { ImageGenerationProgress, ResponseDetail, TurnTerminalReason, TurnTimingMeta, UIMessage, UIToolCall, Usage } from './ipc'
import { isSubagentNotice } from './subagent-notice'

export interface TurnSegment {
  id: string
  sourceMessageId: string
  runId: string | null
  thinking: string
  thinkingMs?: number
  thinkingLive: boolean
  thinkingParts?: TurnThinking[]
  tools: NonNullable<UIMessage['toolCalls']>
  texts: TurnText[]
  response: TurnText | null
  responseParts?: TurnText[]
  commentary: TurnText[]
}

export interface TurnThinking {
  text: string
  ms?: number
  at: number
}

interface TurnText {
  id: string
  text: string
  sourceCwd?: string
  hasTools: boolean
}

export interface AssistantTurn {
  kind: 'assistant'
  id: string
  thinking: string
  thinkingMs?: number
  thinkingLive: boolean
  commentary: TurnText[]
  segments: TurnSegment[]
  tools: NonNullable<UIMessage['toolCalls']>
  waitSpans?: WaitSpan[]
  waitMs?: number
  artifacts: NonNullable<UIMessage['artifacts']>
  imageProgress: ImageGenerationProgress[]
  response: TurnText | null
  responseParts?: TurnText[]
  streaming: boolean
  usage?: Usage
  usagePartial?: boolean
  speed?: number
  elapsedMs?: number
  timestamp?: number
  terminalReason?: TurnTerminalReason
  timingRecorded?: boolean
  model?: string
  responseDetail?: ResponseDetail
  error?: string
  errorMsgId?: string
  sourceIds: string[]
}

export interface UserTurn {
  kind: 'user'
  id: string
  msg: UIMessage
}

export interface BashTurn {
  kind: 'bash'
  id: string
  msg: UIMessage
}

export interface NoteTurn {
  kind: 'note'
  id: string
  msg: UIMessage
}

export type Turn = AssistantTurn | UserTurn | BashTurn | NoteTurn

function hasText(s: string | undefined): boolean {
  return !!s && s.trim().length > 0
}

function sharedSourceCwd(parts: readonly TurnText[]): string | undefined {
  const sourceCwd = parts[0]?.sourceCwd
  return sourceCwd && parts.every((part) => part.sourceCwd === sourceCwd) ? sourceCwd : undefined
}

function haveSameSourceCwd(parts: readonly TurnText[]): boolean {
  return parts.length < 2 || parts.every((part) => part.sourceCwd === parts[0].sourceCwd)
}

export function splitParagraphs(text: string): string[] {
  const out: string[] = []
  let buf: string[] = []
  let fence: { char: string; length: number } | null = null

  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null
    }

    if (!fence && line.trim() === '') {
      if (buf.length) {
        out.push(buf.join('\n'))
        buf = []
      }
      continue
    }
    buf.push(line)
  }
  if (buf.length) out.push(buf.join('\n'))

  return out.map((s) => s.trim()).filter(Boolean)
}

interface SegmentAccumulator {
  id: string
  sourceMessageId: string
  thinking: string[]
  thinkingMs: number
  thinkingLive: boolean
  thinkingParts: TurnThinking[]
  tools: NonNullable<UIMessage['toolCalls']>
  texts: TurnText[]
  closed: boolean
}

export function createTurnProjector(): typeof groupIntoTurns {
  const cache = new WeakMap<UIMessage, { messages: UIMessage[]; streamingId?: string; turns: Turn[] }>()
  return (messages, streamingId) => {
    const turns: Turn[] = []
    let group: UIMessage[] = []
    const flush = (): void => {
      if (!group.length) return
      const first = group[0]
      const live = group.some(message => message.id === streamingId) ? streamingId : undefined
      const saved = cache.get(first)
      if (saved && saved.streamingId === live && saved.messages.length === group.length &&
        group.every((message, index) => message === saved.messages[index])) {
        turns.push(...saved.turns)
      } else {
        const projected = groupIntoTurns(group, live)
        cache.set(first, { messages: group, streamingId: live, turns: projected })
        turns.push(...projected)
      }
      group = []
    }
    for (const message of messages) {
      if (message.role === 'user' && isSubagentNotice(message.text)) {
        flush()
        continue
      }
      if (message.role === 'user' || message.role === 'bash' || message.role === 'note') {
        flush()
        group = [message]
        flush()
      } else group.push(message)
    }
    flush()
    return turns
  }
}

export function groupIntoTurns(messages: UIMessage[], streamingId?: string): Turn[] {
  const turns: Turn[] = []
  let cur: {
    firstId: string
    sourceIds: string[]
    thinking: string[]
    thinkingMs: number
    thinkingLive: boolean
    texts: TurnText[]
    segments: SegmentAccumulator[]
    tools: NonNullable<UIMessage['toolCalls']>
    artifacts: NonNullable<UIMessage['artifacts']>
    imageProgress: ImageGenerationProgress[]
    responseDetail: ResponseDetail
    usage?: Usage
    usagePartial: boolean
    last: UIMessage | undefined
    error?: string
    errorMsgId?: string
    model?: string
    timestamp?: number
    timing?: TurnTimingMeta
    streaming: boolean
  } | null = null

  const flush = (): void => {
    if (!cur) return

    const texts = cur.texts

    const waitSpans = toolWaitSpans(cur.tools)

    const responseParts: TurnText[] = []
    const commentary: TurnText[] = []
    const afterWork = texts.filter((x) => !x.hasTools)
    const beforeWork = texts.filter((x) => x.hasTools)

    if (!cur.tools.length) {
      responseParts.push(...afterWork, ...beforeWork)
    } else if (afterWork.length) {
      responseParts.push(...afterWork)
      commentary.push(...beforeWork)
    } else {
      responseParts.push(...beforeWork.slice(-1))
      commentary.push(...beforeWork.slice(0, -1))
    }

    const segments: TurnSegment[] = cur.segments
      .filter((raw) => raw.thinking.length || raw.tools.length || raw.texts.length)
      .map((raw) => {
        const afterWork = raw.texts.filter((x) => !x.hasTools)
        const beforeWork = raw.texts.filter((x) => x.hasTools)
        const responseSourceCwd = sharedSourceCwd(afterWork)
        const response: TurnText | null = afterWork.length
          ? {
              id: afterWork[0].id,
              text: afterWork.map((x) => x.text).join('\n\n'),
              hasTools: false,
              ...(responseSourceCwd ? { sourceCwd: responseSourceCwd } : {})
            }
          : null
        return {
          id: raw.id,
          sourceMessageId: raw.sourceMessageId,
          runId: null,
          thinking: raw.thinking.join('\n\n'),
          ...(raw.thinkingMs ? { thinkingMs: raw.thinkingMs } : {}),
          thinkingLive: raw.thinkingLive,
          ...(raw.thinkingParts.length ? { thinkingParts: raw.thinkingParts } : {}),
          tools: raw.tools,
          texts: raw.texts,
          response,
          ...(afterWork.length > 1 && !haveSameSourceCwd(afterWork) ? { responseParts: afterWork } : {}),
          commentary: beforeWork
        }
      })

    const responseSourceCwd = sharedSourceCwd(responseParts)
    turns.push({
      kind: 'assistant',
      id: cur.firstId,
      thinking: cur.thinking.join('\n\n'),
      thinkingMs: cur.thinkingMs || undefined,
      thinkingLive: cur.thinkingLive,
      commentary,
      segments,
      tools: cur.tools,
      ...(waitSpans.length ? { waitSpans, waitMs: waitSpansMs(waitSpans) } : {}),
      artifacts: cur.artifacts,
      imageProgress: cur.imageProgress,
      response: responseParts.length
        ? {
            id: responseParts[0].id,
            text: responseParts.map((x) => x.text).join('\n\n'),
            hasTools: responseParts.some((x) => x.hasTools),
            ...(responseSourceCwd ? { sourceCwd: responseSourceCwd } : {})
          }
        : null,
      ...(responseParts.length > 1 && !haveSameSourceCwd(responseParts) ? { responseParts } : {}),
      streaming: cur.streaming,
      usage: cur.usage,
      ...(cur.usagePartial && cur.usage ? { usagePartial: true } : {}),
      speed: cur.last?.speed,
      elapsedMs: cur.last?.elapsedMs ?? cur.timing?.elapsedMs,
      timestamp: cur.timestamp,
      ...(cur.timing
        ? { terminalReason: cur.timing.terminalReason, timingRecorded: true }
        : {}),
      model: cur.model,
      responseDetail: cur.responseDetail,
      error: cur.error,
      errorMsgId: cur.errorMsgId,
      sourceIds: cur.sourceIds
    })
    cur = null
  }

  for (const m of messages) {
    if (m.role === 'user' && isSubagentNotice(m.text)) {
      flush()
      continue
    }
    if (m.role === 'user') {
      flush()
      turns.push({ kind: 'user', id: m.id, msg: m })
      continue
    }

    if (m.role === 'bash') {
      flush()
      turns.push({ kind: 'bash', id: m.id, msg: m })
      continue
    }

    if (m.role === 'note') {
      flush()
      turns.push({ kind: 'note', id: m.id, msg: m })
      continue
    }

    if (!cur) {
      cur = {
        firstId: m.id,
        sourceIds: [],
        thinking: [],
        thinkingMs: 0,
        thinkingLive: false,
        texts: [],
        segments: [],
        tools: [],
        artifacts: [],
        imageProgress: [],
        responseDetail: m.responseDetail ?? 'unknown',
        streaming: false,
        usage: undefined,
        usagePartial: false,
        last: undefined
      }
    }
    cur.sourceIds.push(m.id)
    if (m.id === streamingId) cur.streaming = true

    const seg = (): SegmentAccumulator => {
      const last = cur!.segments[cur!.segments.length - 1]
      if (last && !last.closed) return last
      const created = {
        id: `${m.id}#seg${cur!.segments.length}`,
        sourceMessageId: m.id,
        thinking: [] as string[],
        thinkingMs: 0,
        thinkingLive: false,
        thinkingParts: [] as TurnThinking[],
        tools: [] as NonNullable<UIMessage['toolCalls']>,
        texts: [] as TurnText[],
        closed: false
      }
      cur!.segments.push(created)
      return created
    }

    if (hasText(m.thinking)) {
      cur.thinking.push(m.thinking!.trim())
      cur.thinkingMs += m.thinkingMs ?? 0
      const target = seg()
      target.thinking.push(m.thinking!.trim())
      target.thinkingMs += m.thinkingMs ?? 0
      target.thinkingParts.push({ text: m.thinking!.trim(), at: target.tools.length, ...(m.thinkingMs ? { ms: m.thinkingMs } : {}) })
    }
    if (m.thinkingLive !== undefined) {
      cur.thinkingLive = m.thinkingLive
      seg().thinkingLive = m.thinkingLive
    }

    if (m.toolCalls?.length) {
      cur.tools.push(...m.toolCalls)
      seg().tools.push(...m.toolCalls)
    }
    if (m.artifacts?.length) cur.artifacts.push(...m.artifacts)
    if (m.imageProgress?.length) {
      for (const progress of m.imageProgress) {
        const index = cur.imageProgress.findIndex((item) => item.id === progress.id)
        if (index < 0) cur.imageProgress.push(progress)
        else cur.imageProgress[index] = progress
      }
    }

    if (m.timestamp !== undefined) cur.timestamp = m.timestamp
    if (m.turnTiming) cur.timing = m.turnTiming

    if (hasText(m.text)) {
      const hasTools = (m.toolCalls?.length ?? 0) > 0
      const target = seg()
      for (const p of splitParagraphs(m.text)) {
        const item = {
          id: `${m.id}#${cur.texts.length}`,
          text: p,
          hasTools,
          ...(m.sourceCwd ? { sourceCwd: m.sourceCwd } : {})
        }
        cur.texts.push(item)
        target.texts.push(item)
      }
      target.closed = true
    }

    if (hasUsageNumbers(m.usage)) cur.usage = addUsage(cur.usage, m.usage)
    else cur.usagePartial = true
    if (m.model) cur.model = m.model
    if (m.error && !cur.errorMsgId) {
      cur.error = m.error
      cur.errorMsgId = m.id
    }
    if (!cur.last) cur.last = m
    if (m.elapsedMs !== undefined || m.speed !== undefined) cur.last = m
  }

  flush()
  return turns
}

export interface WaitSpan {
  id: string
  name: string
  startedAt: number
  endedAt: number
}

export function toolWaitSpans(tools: readonly UIToolCall[]): WaitSpan[] {
  const spans: WaitSpan[] = []
  for (const c of tools) {
    if (c.startedAt === undefined || c.endedAt === undefined) continue
    if (c.endedAt < c.startedAt) continue
    spans.push({ id: c.id, name: c.name, startedAt: c.startedAt, endedAt: c.endedAt })
  }
  return spans
}

export function waitSpansMs(spans: readonly WaitSpan[]): number {
  if (!spans.length) return 0
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  let total = 0
  let start = sorted[0].startedAt
  let end = sorted[0].endedAt
  for (let i = 1; i < sorted.length; i += 1) {
    const s = sorted[i]
    if (s.startedAt > end) {
      total += end - start
      start = s.startedAt
      end = s.endedAt
    } else if (s.endedAt > end) {
      end = s.endedAt
    }
  }
  return Math.max(0, total + (end - start))
}

export function hasUsageNumbers(u?: Usage): boolean {
  return !!u && (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0)
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost
  }
}

export function cacheHitRate(u?: Usage): number | null {
  if (!u) return null
  const promptTotal = u.input + u.cacheRead + u.cacheWrite
  if (promptTotal <= 0) return null
  return (u.cacheRead / promptTotal) * 100
}

export function formatHitRate(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null
  if (pct >= 100) return '100%'
  const truncated = Math.floor(pct * 100) / 100
  return `${truncated.toFixed(2)}%`
}
