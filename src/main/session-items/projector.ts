import type { UIMessage, UIToolCall } from '../../shared/ipc'
import {
  PRELUDE_TURN_ID,
  assistantBlockId,
  groupTurns,
  type AssistantTextItem,
  statusItemId,
  toolItemKind,
  toolItemStatus,
  type CompactionItem,
  type ReasoningItem,
  type SessionItem,
  type SessionTurn,
  type ToolItem
} from '../../shared/session-items'
import { normalizeMessage, restoreNestedCalls, type PiContentBlock, type PiMessage } from '../normalize'
import { appendToolCallArgs, endToolExecution, finishToolCallArgs, startToolExecution, streamingToolCall, updateToolExecution, type ToolExecutionEnd, type ToolResultPayload } from './tool-events'

export type LocalizeImage = (mimeType: string, data: string) => string

const PROGRESS_UPDATE_MODEL = /claude-(?:(?:opus|sonnet)-5[-.]5|(?:fable|mythos)-5[-.]1|fable-5(?![-.][0-9]{1,2}(?![0-9])))/i

export function writesProgressUpdates(model: unknown): boolean {
  return typeof model === 'string' && PROGRESS_UPDATE_MODEL.test(model)
}

function promoteProgressUpdate(item: SessionItem | undefined): void {
  if (item?.kind !== 'reasoning' || !item.text.trim()) return
  const promoted = item as SessionItem as AssistantTextItem & Partial<Pick<ReasoningItem, 'live' | 'durationMs'>>
  promoted.kind = 'assistant-text'
  delete promoted.live
  delete promoted.durationMs
}

interface MessageSlot {
  header: UIMessage
  turnId: string
  step: number
  items: SessionItem[]
  toolBlocks?: Map<number, ToolItem>
  progressUpdates?: boolean
}

interface CallEntry {
  msg: UIMessage
  call: UIToolCall
  slot?: MessageSlot
}

export interface LiveToolStart {
  toolCallId: string
  toolName: string
  args?: unknown
  parentToolCallId?: string
}

export interface LiveCompactionEvent {
  type: 'compaction_start' | 'compaction_end'
  reason?: unknown
  aborted?: unknown
  errorMessage?: unknown
  result?: unknown
}

export interface LiveToolStarted {
  call: UIToolCall
  ownerId: string
  created?: UIMessage
}

export interface StreamingContent {
  id: string
  text: string
  thinking: string
  calls: UIToolCall[]
}

type Timeline = { slot: MessageSlot } | { item: CompactionItem }

function assignContent(header: UIMessage, content: Partial<UIMessage>): UIMessage {
  const target = header as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined && !(key in header)) continue
    target[key] = value
  }
  return header
}

function slotContent(slot: MessageSlot): { text?: string; thinking?: string; calls: UIToolCall[]; error?: string } {
  let text: string | undefined
  let thinking: string | undefined
  let error: string | undefined
  const calls: UIToolCall[] = []
  for (const item of slot.items) {
    if (item.kind === 'assistant-text') text = (text ?? '') + item.text
    else if (item.kind === 'reasoning') thinking = (thinking ?? '') + item.text
    else if (item.kind === 'tool') calls.push(item.call)
    else if (item.kind === 'status' && error === undefined) error = item.text
  }
  return { text, thinking, calls, error }
}

export class SessionItemProjector {
  private readonly timeline: Timeline[] = []
  private readonly slots: MessageSlot[] = []
  private readonly callIndex = new Map<string, CallEntry>()
  private turnId = PRELUDE_TURN_ID
  private step = -1
  private seq = 0
  private compactions = 0
  private streaming: MessageSlot | null = null

  constructor(private readonly localizeImage?: LocalizeImage) {}

  appendPersisted(raw: unknown, entryId?: string): void {
    const m = raw as PiMessage
    if (m?.role === 'system') return
    const norm = normalizeMessage(m, this.seq, this.localizeImage, entryId)
    if (!norm) return
    if (m.role === 'assistant') for (const call of norm.toolCalls ?? []) call.cancelled = true
    if (m.role === 'toolResult') {
      const result = norm.toolCalls?.[0]
      const hit = result ? this.callIndex.get(result.id) : undefined
      if (result && hit) {
        hit.call.status = result.status
        hit.call.output = result.output
        hit.call.cancelled = result.cancelled
        hit.call.details = result.details
        if (result.images?.length) hit.call.images = result.images
        this.syncCall(hit.call)
        this.restoreNested(m, hit)
        return
      }
    }
    this.seq += 1
    const slot = this.addSlot(norm, m)
    const first = norm.toolCalls?.[0]
    if (m.role === 'toolResult' && first) this.restoreNested(m, { msg: slot.header, call: first, slot })
  }

  appendPersistedEntry(entry: { id?: unknown; type?: unknown; message?: unknown; tokensBefore?: unknown }, message: unknown): void {
    const entryId = typeof entry.id === 'string' ? entry.id : undefined
    if (message) {
      this.appendPersisted(message, entryId)
      return
    }
    if (entry.type !== 'compaction') return
    const item: CompactionItem = {
      kind: 'compaction',
      id: entryId ? `compaction:${entryId}` : `compaction:${++this.compactions}`,
      turnId: this.turnId,
      messageId: '',
      ...(entryId ? { entryId } : {}),
      status: 'ok',
      ...(typeof entry.tokensBefore === 'number' ? { tokensBefore: entry.tokensBefore } : {})
    }
    this.timeline.push({ item })
  }

  load(messages: readonly UIMessage[]): void {
    const live = this.streaming
    this.reset()
    for (const message of messages) this.addSlot({ ...message })
    this.seq = this.slots.length
    if (!live) return
    this.slots.push(live)
    this.timeline.push({ slot: live })
    for (const item of live.items) if (item.kind === 'tool') this.callIndex.set(item.call.id, { msg: live.header, call: item.call, slot: live })
    if (live.turnId === this.turnId) this.step = Math.max(this.step, live.step)
    this.streaming = live
  }

  reset(): void {
    this.timeline.length = 0
    this.slots.length = 0
    this.callIndex.clear()
    this.turnId = PRELUDE_TURN_ID
    this.step = -1
    this.seq = 0
    this.streaming = null
  }

  discardStreaming(): void {
    const slot = this.streaming
    if (!slot) return
    this.streaming = null
    const at = this.slots.indexOf(slot)
    if (at >= 0) this.slots.splice(at, 1)
    const entry = this.timeline.findIndex((candidate) => 'slot' in candidate && candidate.slot === slot)
    if (entry >= 0) this.timeline.splice(entry, 1)
  }

  appendMessage(message: UIMessage): UIMessage {
    this.seq = this.settledCount() + 1
    return this.compose(this.addSlot({ ...message }))
  }

  previewLive(m: PiMessage): UIMessage | null {
    if (m.role !== 'user' && m.role !== 'custom') return null
    return normalizeMessage(m, this.settledCount(), this.localizeImage)
  }

  commitLive(message: UIMessage, m?: PiMessage): UIMessage {
    this.seq = this.settledCount() + 1
    return this.compose(this.addSlot(message, m))
  }

  liveMessageStart(m: PiMessage, now: number): UIMessage | null {
    if (m.role === 'user' || m.role === 'custom') {
      const norm = this.previewLive(m)
      return norm ? this.commitLive(norm, m) : null
    }
    if (m.role !== 'assistant') return null
    this.discardStreaming()
    const header: UIMessage = { id: `m${this.slots.length}`, role: 'assistant', text: '', timestamp: now }
    this.seq = this.slots.length + 1
    this.streaming = this.addSlot(header)
    if (writesProgressUpdates(m.model)) this.streaming.progressUpdates = true
    return { ...header }
  }

  streamingContent(): StreamingContent | null {
    const slot = this.streaming
    if (!slot) return null
    const content = slotContent(slot)
    return { id: slot.header.id, text: content.text ?? '', thinking: content.thinking ?? '', calls: content.calls }
  }

  call(id: string): UIToolCall | undefined {
    return id ? this.callIndex.get(id)?.call : undefined
  }

  ownerOf(id: string): string | undefined {
    const entry = this.callIndex.get(id)
    return entry ? (entry.slot?.header.id ?? entry.msg.id) : undefined
  }

  liveAssistantDelta(ev: Record<string, unknown>, now: number): UIToolCall | null {
    const slot = this.streaming
    if (!slot) return null
    const kind = String(ev.type ?? '')
    const blockKind = kind.startsWith('thinking_') ? 'reasoning' : 'assistant-text'
    const index = typeof ev.contentIndex === 'number' ? ev.contentIndex : this.fallbackBlock(slot, blockKind, kind === 'thinking_start')
    if (kind === 'thinking_start' || kind === 'thinking_delta' || kind === 'thinking_end') {
      const item = this.blockItem(slot, 'reasoning', index) as ReasoningItem
      if (kind === 'thinking_start') item.live = true
      if (kind === 'thinking_delta') item.text += String(ev.delta ?? '')
      if (kind === 'thinking_end') item.live = false
      return null
    }
    if (kind === 'text_delta') {
      this.blockItem(slot, 'assistant-text', index).text += String(ev.delta ?? '')
      return null
    }
    if (kind === 'toolcall_start') {
      if (slot.progressUpdates && typeof ev.contentIndex === 'number') {
        const previousId = assistantBlockId(slot.turnId, slot.step, ev.contentIndex - 1)
        promoteProgressUpdate(slot.items.find((item) => item.id === previousId))
      }
      const call = streamingToolCall(ev, slot.items.filter((item) => item.kind === 'tool').length, now)
      const item = this.attachCall(slot, call)
      if (typeof ev.contentIndex === 'number') (slot.toolBlocks ??= new Map()).set(ev.contentIndex, item)
      return call
    }
    const target = (typeof ev.contentIndex === 'number' ? slot.toolBlocks?.get(ev.contentIndex) : undefined)
      ?? [...slot.items].reverse().find((item): item is ToolItem => item.kind === 'tool')
    if (kind === 'toolcall_delta' && target) {
      appendToolCallArgs(target.call, ev.delta)
      return target.call
    }
    if (kind === 'toolcall_end' && target) {
      const previousId = target.call.id
      finishToolCallArgs(target.call, ev.toolCall as PiContentBlock | undefined)
      if (target.call.id !== previousId) this.reindexCall(target, previousId)
      target.tool = toolItemKind(target.call.name)
      return target.call
    }
    return null
  }

  liveMessageEnd(meta: Partial<UIMessage> = {}): UIMessage | null {
    const slot = this.streaming
    if (!slot) return null
    this.streaming = null
    for (const item of slot.items) if (item.kind === 'reasoning') item.live = false
    const { text: _text, thinking: _thinking, toolCalls: _calls, error, ...rest } = meta
    slot.header = { ...slot.header, ...rest }
    if (error) slot.items.push({ kind: 'status', id: statusItemId(slot.turnId, slot.step), turnId: slot.turnId, messageId: slot.header.id, step: slot.step, status: 'error', text: error })
    return this.compose(slot)
  }

  liveToolStart(evt: LiveToolStart, now: number): LiveToolStarted {
    const existing = evt.toolCallId ? this.callIndex.get(evt.toolCallId) : undefined
    if (existing) {
      startToolExecution(existing.call, now)
      this.syncCall(existing.call)
      return { call: existing.call, ownerId: existing.slot?.header.id ?? existing.msg.id }
    }
    const call: UIToolCall = { id: evt.toolCallId, name: evt.toolName, args: evt.args, parentToolCallId: evt.parentToolCallId, status: 'running', startedAt: now }
    const parent = evt.parentToolCallId ? this.callIndex.get(evt.parentToolCallId) : undefined
    const owner = parent?.slot ?? this.streaming
    let created: UIMessage | undefined
    if (owner) {
      this.attachCall(owner, call)
    } else {
      this.seq = this.settledCount() + 1
      created = this.compose(this.addSlot({ id: `t${now.toString(36)}`, role: 'assistant', text: '', toolCalls: [call], timestamp: now }))
    }
    startToolExecution(call, now)
    this.syncCall(call)
    return { call, ownerId: owner?.header.id ?? created!.id, ...(created ? { created } : {}) }
  }

  liveToolUpdate(toolCallId: string, partial: ToolResultPayload | undefined): UIToolCall | null {
    const hit = this.callIndex.get(toolCallId)
    if (!hit) return null
    updateToolExecution(hit.call, partial)
    return hit.call
  }

  liveToolEnd(toolCallId: string, evt: ToolExecutionEnd, now: number): UIToolCall | null {
    const hit = this.callIndex.get(toolCallId)
    if (!hit) return null
    endToolExecution(hit.call, evt, now)
    this.syncCall(hit.call)
    return hit.call
  }

  cancelUnfinishedTools(now: number): UIToolCall[] {
    const cancelled: UIToolCall[] = []
    for (const { call, slot } of this.callIndex.values()) {
      if (slot?.turnId !== this.turnId || slot.header.role !== 'assistant') continue
      if (call.status !== 'running' && call.status !== 'pending') continue
      call.status = 'ok'
      call.cancelled = true
      call.endedAt = now
      this.syncCall(call)
      cancelled.push(call)
    }
    return cancelled
  }

  liveCompaction(evt: LiveCompactionEvent): CompactionItem | null {
    if (evt.type === 'compaction_start') {
      const item: CompactionItem = {
        kind: 'compaction',
        id: `compaction:${++this.compactions}`,
        turnId: this.turnId,
        messageId: '',
        status: 'running',
        ...(typeof evt.reason === 'string' ? { reason: evt.reason } : {})
      }
      this.timeline.push({ item })
      return item
    }
    const running = [...this.timeline].reverse().find((entry): entry is { item: CompactionItem } => 'item' in entry && entry.item.status === 'running')?.item
    if (!running) return null
    const error = typeof evt.errorMessage === 'string' && evt.errorMessage ? evt.errorMessage : undefined
    running.status = evt.aborted === true ? 'cancelled' : error ? 'error' : 'ok'
    if (error) running.error = error
    const tokensBefore = (evt.result as { tokensBefore?: unknown } | undefined)?.tokensBefore
    if (typeof tokensBefore === 'number') running.tokensBefore = tokensBefore
    return running
  }

  items(): SessionItem[] {
    return this.timeline.flatMap((entry) => ('slot' in entry ? entry.slot.items : [entry.item]))
  }

  turns(): SessionTurn[] {
    return groupTurns(this.items())
  }

  uiMessages(): UIMessage[] {
    const out: UIMessage[] = []
    for (const slot of this.slots) if (slot !== this.streaming) out.push(this.compose(slot))
    return out
  }

  streamingMessage(): UIMessage | null {
    return this.streaming ? this.compose(this.streaming) : null
  }

  private settledCount(): number {
    return this.slots.length - (this.streaming ? 1 : 0)
  }

  private fallbackBlock(slot: MessageSlot, kind: 'reasoning' | 'assistant-text', opening: boolean): number {
    const last = slot.items.at(-1)
    if (!opening && last && last.kind === kind) return last.block
    return slot.items.length
  }

  private addSlot(header: UIMessage, raw?: PiMessage): MessageSlot {
    if (header.role === 'user') {
      this.turnId = header.id
      this.step = -1
    }
    if (header.role === 'assistant') this.step += 1
    const slot: MessageSlot = { header, turnId: this.turnId, step: Math.max(this.step, 0), items: [] }
    this.decompose(slot, raw)
    for (const call of header.toolCalls ?? []) this.callIndex.set(call.id, { msg: header, call, slot })
    this.slots.push(slot)
    this.timeline.push({ slot })
    return slot
  }

  private decompose(slot: MessageSlot, raw?: PiMessage): void {
    const h = slot.header
    const base = { turnId: slot.turnId, messageId: h.id, ...(h.entryId ? { entryId: h.entryId } : {}), ...(h.timestamp !== undefined ? { timestamp: h.timestamp } : {}) }
    if (h.role === 'user') {
      slot.items.push({ kind: 'user', id: h.id, ...base, text: h.text, ...(h.images ? { images: h.images } : {}) })
      return
    }
    if (h.role === 'note' && h.note) {
      slot.items.push({ kind: 'note', id: h.id, ...base, note: h.note, text: h.text, ...(h.images ? { images: h.images } : {}) })
      return
    }
    if (h.role === 'bash') {
      slot.items.push({
        kind: 'shell', id: h.id, ...base,
        command: h.bash?.command ?? h.text, exitCode: h.bash?.exitCode ?? null, cancelled: h.bash?.cancelled === true,
        ...(h.toolCalls?.[0] ? { call: h.toolCalls[0] } : {})
      })
      return
    }
    if (h.role !== 'assistant') return
    const calls = new Map((h.toolCalls ?? []).map((call) => [call.id, call]))
    const used = new Set<string>()
    const blocks = raw?.role === 'assistant' && Array.isArray(raw.content) ? raw.content : null
    if (blocks) {
      const progressUpdates = writesProgressUpdates(raw?.model)
      blocks.forEach((block, index) => {
        if (block.type === 'thinking' && progressUpdates && blocks[index + 1]?.type === 'toolCall' && block.thinking?.trim()) slot.items.push({ kind: 'assistant-text', id: assistantBlockId(slot.turnId, slot.step, index), ...base, step: slot.step, block: index, text: block.thinking })
        else if (block.type === 'thinking') slot.items.push({ kind: 'reasoning', id: assistantBlockId(slot.turnId, slot.step, index), ...base, step: slot.step, block: index, text: block.thinking ?? '' })
        else if (block.type === 'text') slot.items.push({ kind: 'assistant-text', id: assistantBlockId(slot.turnId, slot.step, index), ...base, step: slot.step, block: index, text: block.text ?? '' })
        else if (block.type === 'toolCall' && block.id && calls.has(block.id) && !used.has(block.id)) {
          used.add(block.id)
          slot.items.push(this.toolItem(slot, calls.get(block.id)!))
        }
      })
    } else {
      if (h.thinking) slot.items.push({ kind: 'reasoning', id: assistantBlockId(slot.turnId, slot.step, 0), ...base, step: slot.step, block: 0, text: h.thinking })
      if (h.text) slot.items.push({ kind: 'assistant-text', id: assistantBlockId(slot.turnId, slot.step, 1), ...base, step: slot.step, block: 1, text: h.text })
    }
    for (const call of h.toolCalls ?? []) if (!used.has(call.id) && !slot.items.some((item) => item.kind === 'tool' && item.call === call)) slot.items.push(this.toolItem(slot, call))
    if (h.error) slot.items.push({ kind: 'status', id: statusItemId(slot.turnId, slot.step), ...base, step: slot.step, status: 'error', text: h.error })
  }

  private toolItem(slot: MessageSlot, call: UIToolCall): ToolItem {
    return {
      kind: 'tool', id: call.id, turnId: slot.turnId, messageId: slot.header.id,
      ...(slot.header.entryId ? { entryId: slot.header.entryId } : {}),
      ...(slot.header.timestamp !== undefined ? { timestamp: slot.header.timestamp } : {}),
      tool: toolItemKind(call.name), step: slot.step, status: toolItemStatus(call), call
    }
  }

  private attachCall(slot: MessageSlot, call: UIToolCall): ToolItem {
    const item = this.toolItem(slot, call)
    slot.items.push(item)
    this.callIndex.set(call.id, { msg: slot.header, call, slot })
    return item
  }

  private reindexCall(item: ToolItem, previousId: string): void {
    const id = item.call.id
    if (this.callIndex.get(previousId)?.call === item.call) this.callIndex.delete(previousId)
    item.id = id
    const slot = this.slots.find((candidate) => candidate.items.includes(item))
    this.callIndex.set(id, { msg: slot?.header ?? ({} as UIMessage), call: item.call, ...(slot ? { slot } : {}) })
  }

  private blockItem(slot: MessageSlot, kind: 'reasoning' | 'assistant-text', block: number) {
    const id = assistantBlockId(slot.turnId, slot.step, block)
    const found = slot.items.find((item) => item.id === id)
    if (found && (found.kind === 'reasoning' || found.kind === 'assistant-text')) return found
    const item = { kind, id, turnId: slot.turnId, messageId: slot.header.id, step: slot.step, block, text: '' } as Extract<SessionItem, { kind: typeof kind }>
    slot.items.push(item)
    return item
  }

  private syncCall(call: UIToolCall): void {
    const slot = this.callIndex.get(call.id)?.slot
    const item = slot?.items.find((candidate): candidate is ToolItem => candidate.kind === 'tool' && candidate.call === call)
    if (item) item.status = toolItemStatus(call)
  }

  private restoreNested(m: PiMessage, owner: CallEntry): void {
    const holder: UIMessage = { id: owner.msg.id, role: 'assistant', text: '', toolCalls: [] }
    restoreNestedCalls(m, holder, owner.call, this.callIndex)
    for (const call of holder.toolCalls ?? []) {
      if (owner.slot) this.attachCall(owner.slot, call)
      else this.callIndex.set(call.id, { msg: owner.msg, call })
    }
  }

  private compose(slot: MessageSlot): UIMessage {
    const h = slot.header
    if (h.role === 'user') {
      const item = slot.items.find((candidate) => candidate.kind === 'user')
      return item?.kind === 'user' ? assignContent(h, { text: item.text, images: item.images }) : h
    }
    if (h.role === 'note') {
      const item = slot.items.find((candidate) => candidate.kind === 'note')
      return item?.kind === 'note' ? assignContent(h, { text: item.text, images: item.images }) : h
    }
    if (h.role === 'bash') {
      const item = slot.items.find((candidate) => candidate.kind === 'shell')
      return item?.kind === 'shell' && item.call ? assignContent(h, { toolCalls: [item.call] }) : h
    }
    const content = slotContent(slot)
    return assignContent(h, {
      text: content.text ?? h.text,
      thinking: content.thinking === undefined ? h.thinking : content.thinking || undefined,
      toolCalls: content.calls.length ? content.calls : h.toolCalls,
      error: content.error ?? h.error
    })
  }
}

export function projectHistory(raw: unknown[], localizeImage?: LocalizeImage, entryIds?: (string | undefined)[]): UIMessage[] {
  const projector = new SessionItemProjector(localizeImage)
  for (let i = 0; i < raw.length; i++) projector.appendPersisted(raw[i], entryIds?.[i])
  return projector.uiMessages()
}
