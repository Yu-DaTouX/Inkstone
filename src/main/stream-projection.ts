import type { GenerationTiming, MainPush, ResponseDetail, UIToolCall, Usage } from '../shared/ipc'
import { generationTiming, turnTiming } from '../shared/turn-timing'
import { toUsage, type PiMessage } from './normalize'
import type { SessionItemProjector } from './session-items/projector'
import { streamsHtmlWriteArgs, toolOutputPushMode } from './session-items/tool-events'

export const FLUSH_MS = 16
export const MAX_FLUSH_MS = 120
export const HTML_ARGS_PUSH_MS = 600

export interface StreamingState {
  id: string
  thinkingMs?: number
  thinkingStartedAt?: number
  thinkingLive?: boolean
  responseDetail: ResponseDetail
  startedAt?: number
  firstTokenAt?: number
  generationStartedMono?: number
  requestStartEvent?: 'turn_start'
  firstContentMono?: number
  firstOutputMono?: number
  usage?: Usage
  pushedText: number
  pushedThinking: number
  toolOpen?: boolean
}

export type StreamTimer = unknown

export interface StreamClock {
  now(): number
  mono(): number
  setTimer(run: () => void, ms: number): StreamTimer
  clearTimer(timer: StreamTimer): void
}

export const systemStreamClock: StreamClock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

export type StreamItems = Pick<SessionItemProjector, 'liveAssistantDelta' | 'streamingContent' | 'call' | 'ownerOf'>

export interface StreamProjectionDeps {
  items: StreamItems
  push(message: MainPush): void
  clock?: StreamClock
  modelId(): string | undefined
  turnStartedAt(): number | undefined
  idleBacklog(): number
  checkDelta(kind: 'thinking' | 'text', delta: string): void
}

export function streamSpeed(
  s: { usage?: Usage; firstTokenAt?: number; startedAt?: number },
  endedAt: number,
  turnStartedAt?: number
): { speed?: number; elapsedMs?: number } {
  return turnTiming({
    usage: s.usage,
    firstTokenAt: s.firstTokenAt,
    startedAt: s.startedAt,
    turnStartedAt,
    endedAt
  })
}

export function streamGenerationTiming(
  s: { generationStartedMono?: number; firstContentMono?: number; firstOutputMono?: number; requestStartEvent?: 'turn_start' },
  endedMono: number
): GenerationTiming | undefined {
  if (s.generationStartedMono === undefined) return undefined
  const g = generationTiming({
    startedMono: s.generationStartedMono,
    endedMono,
    firstContentMono: s.firstContentMono,
    firstOutputMono: s.firstOutputMono,
    ...(s.requestStartEvent ? { startEvent: s.requestStartEvent } : {})
  })
  if (!g) return undefined
  if (g.startEvent === 'turn_start') return g
  return {
    durationMs: g.durationMs,
    ...(g.decodeMs !== undefined ? { decodeMs: g.decodeMs } : {}),
    ...(g.outputDecodeMs !== undefined ? { outputDecodeMs: g.outputDecodeMs } : {})
  }
}

export class StreamProjection {
  streaming: StreamingState | null = null
  private dirty = false
  private flushTimer: StreamTimer | null = null
  private readonly dirtyTools = new Set<string>()
  private readonly pushedOut = new Map<string, number>()
  private readonly pushedOutText = new Map<string, string>()
  private readonly pushedArgs = new Map<string, unknown>()
  private readonly htmlArgsPushedAt = new Map<string, number>()
  private readonly items: StreamItems
  private readonly clock: StreamClock

  constructor(private readonly deps: StreamProjectionDeps) {
    this.items = deps.items
    this.clock = deps.clock ?? systemStreamClock
  }

  messageUpdate(evt: Record<string, unknown>): void {
    const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
    if (!ev || !this.streaming) return
    const kind = String(ev.type ?? '')

    const u = toUsage(evt.usage as PiMessage['usage'], this.deps.modelId())
    if (u && (this.streaming.usage?.output !== u.output || this.streaming.usage?.input !== u.input)) this.streaming.usage = u

    if (
      !this.streaming.firstTokenAt &&
      (kind === 'text_delta' || kind === 'thinking_delta' || kind === 'toolcall_start')
    ) {
      this.streaming.firstTokenAt = this.clock.now()
    }
    if (!this.streaming.firstContentMono) {
      const delta = String(ev.delta ?? '')
      const realContent =
        kind === 'toolcall_start' ||
        ((kind === 'text_delta' || kind === 'thinking_delta') && delta.length > 0)
      if (realContent) this.streaming.firstContentMono = this.clock.mono()
    }
    if (this.streaming.firstOutputMono === undefined &&
      (kind === 'toolcall_start' || (kind === 'text_delta' && String(ev.delta ?? '').length > 0))) {
      this.streaming.firstOutputMono = this.clock.mono()
    }

    const call = this.items.liveAssistantDelta(ev, this.clock.now())
    if (kind === 'thinking_start') {
      this.streaming.thinkingStartedAt = this.clock.now()
      this.streaming.thinkingLive = true
    } else if (kind === 'thinking_delta') {
      this.deps.checkDelta('thinking', String(ev.delta ?? ''))
      this.markDirty()
    } else if (kind === 'thinking_end') {
      const started = this.streaming.thinkingStartedAt
      if (started) this.streaming.thinkingMs = this.clock.now() - started
      this.streaming.thinkingLive = false
      this.markDirty()
    } else if (kind === 'text_delta') {
      this.deps.checkDelta('text', String(ev.delta ?? ''))
      this.markDirty()
    } else if (kind === 'toolcall_start') {
      this.streaming.toolOpen = true
      this.dirty = true
      this.flushNow()
      if (call) this.pushTool(call)
    } else if (kind === 'toolcall_delta') {
      if (call && streamsHtmlWriteArgs(call)) {
        const now = this.clock.now()
        if (now - (this.htmlArgsPushedAt.get(call.id) ?? 0) >= HTML_ARGS_PUSH_MS) {
          this.htmlArgsPushedAt.set(call.id, now)
          this.pushTool(call)
        }
      }
    } else if (kind === 'toolcall_end') {
      this.streaming.toolOpen = false
      this.flushNow()
      if (call) {
        this.htmlArgsPushedAt.delete(call.id)
        this.pushTool(call)
      }
    }
  }

  finishMessage(): StreamingState | null {
    const s = this.streaming
    this.streaming = null
    this.htmlArgsPushedAt.clear()
    return s
  }

  ownerOf(call: UIToolCall): string | undefined {
    return this.items.ownerOf(call.id) ?? this.streaming?.id
  }

  pushTool(call: UIToolCall): void {
    const msgId = this.ownerOf(call)
    if (!msgId) return
    this.pushToolTo(msgId, call)
  }

  pushToolTo(msgId: string, call: UIToolCall): void {
    this.pushedOut.set(call.id, call.output?.length ?? 0)
    this.pushedOutText.set(call.id, call.output ?? '')
    this.dirtyTools.delete(call.id)
    this.deps.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
  }

  settledCalls(calls: readonly UIToolCall[]): void {
    for (const c of calls) {
      this.pushedOut.set(c.id, c.output?.length ?? 0)
      this.pushedOutText.delete(c.id)
      this.pushedArgs.delete(c.id)
      this.dirtyTools.delete(c.id)
    }
  }

  settledOutput(callId: string, length: number): void {
    this.pushedOut.set(callId, length)
    this.dirtyTools.delete(callId)
  }

  forgetPushed(): void {
    this.pushedOut.clear()
    this.pushedOutText.clear()
    this.pushedArgs.clear()
  }

  reset(): void {
    if (this.flushTimer) this.clock.clearTimer(this.flushTimer)
    this.flushTimer = null
    this.streaming = null
    this.dirty = false
    this.dirtyTools.clear()
    this.forgetPushed()
  }

  markToolOutput(callId: string): void {
    if (!callId) return
    this.dirtyTools.add(callId)
    this.scheduleFlush()
  }

  markDirty(): void {
    this.dirty = true
    this.scheduleFlush()
  }

  flushTools(): void {
    if (!this.dirtyTools.size) return
    const ids = [...this.dirtyTools]
    this.dirtyTools.clear()

    for (const id of ids) {
      const call = this.items.call(id)
      if (!call) {
        this.pushedOut.delete(id)
        this.pushedOutText.delete(id)
        this.pushedArgs.delete(id)
        continue
      }
      const pushed = this.pushedOut.get(id) ?? 0
      const out = call.output ?? ''
      const previous = this.pushedOutText.get(id)
      const mode = toolOutputPushMode(previous, pushed, out)
      if (mode === 'skip') continue
      const msgId = this.ownerOf(call)
      if (!msgId) continue
      this.pushedOut.set(id, out.length)
      this.pushedOutText.set(id, out)
      const sameArgs = this.pushedArgs.has(id) && this.pushedArgs.get(id) === call.args
      this.pushedArgs.set(id, call.args)
      if (mode === 'replace') {
        this.deps.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
        continue
      }
      const { args: _args, output: _output, ...rest } = call
      this.deps.push({
        ch: 'tool',
        payload: {
          msgId,
          call: sameArgs ? (rest as UIToolCall) : { ...call, output: undefined },
          outputDelta: out.slice(pushed),
          ...(sameArgs ? { sameArgs: true } : {})
        }
      })
    }
  }

  flushNow(): void {
    if (!this.dirty || !this.streaming) return
    this.dirty = false
    const s = this.streaming
    const content = this.items.streamingContent()
    const text = content?.text ?? ''
    const thinking = content?.thinking ?? ''

    const textDelta = text.length > s.pushedText ? text.slice(s.pushedText) : ''
    const thinkingDelta =
      thinking.length > s.pushedThinking ? thinking.slice(s.pushedThinking) : ''
    const thinkingShrank = thinking.length < s.pushedThinking
    s.pushedText = text.length
    s.pushedThinking = thinking.length

    const sp = streamSpeed(s, this.clock.now(), this.deps.turnStartedAt())
    const genTiming = streamGenerationTiming(s, this.clock.mono())
    this.deps.push({
      ch: 'msg-update',
      payload: {
        id: s.id,
        patch: {
          ...(textDelta ? { textDelta } : null),
          ...(thinkingDelta ? { thinkingDelta } : null),
          ...(thinkingShrank ? { thinking } : null),
          thinkingMs: s.thinkingMs,
          thinkingStartedAt: s.thinkingStartedAt,
          thinkingLive: s.thinkingLive,
          usage: s.usage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs,
          ...(genTiming ? { generationTiming: genTiming } : null)
        }
      }
    })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = this.clock.setTimer(() => {
      this.flushTimer = null
      this.flushNow()
      this.flushTools()
    }, this.flushDelay())
  }

  private flushDelay(): number {
    if (this.streaming) return FLUSH_MS
    const len = this.deps.idleBacklog()
    return Math.min(MAX_FLUSH_MS, Math.max(FLUSH_MS, Math.round(len / 2000)))
  }
}
