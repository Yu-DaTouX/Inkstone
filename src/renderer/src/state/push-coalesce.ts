import type { MessagePatch } from '../../../shared/ipc'

export interface PendingMessagePatch {
  id: string
  patch: MessagePatch
}

export function mergeMessagePatch(previous: MessagePatch | undefined, next: MessagePatch): MessagePatch {
  if (!previous) return next
  const { textDelta: previousText, thinkingDelta: previousThinking, ...previousFields } = previous
  const { textDelta: nextText, thinkingDelta: nextThinking, ...nextFields } = next
  const merged: MessagePatch = { ...previousFields, ...nextFields }
  const fold = (
    field: 'text' | 'thinking',
    deltaKey: 'textDelta' | 'thinkingDelta',
    previousDelta: string | undefined,
    nextDelta: string | undefined
  ): void => {
    if (nextFields[field] !== undefined) return
    const base = previousFields[field]
    if (base !== undefined) {
      if (nextDelta) merged[field] = base + nextDelta
      return
    }
    if (previousDelta === undefined && nextDelta === undefined) return
    merged[deltaKey] = (previousDelta ?? '') + (nextDelta ?? '')
  }
  fold('text', 'textDelta', previousText, nextText)
  fold('thinking', 'thinkingDelta', previousThinking, nextThinking)
  return merged
}

export class MessagePatchBatch {
  private readonly pending = new Map<string, MessagePatch>()

  add(id: string, patch: MessagePatch): void {
    this.pending.set(id, mergeMessagePatch(this.pending.get(id), patch))
  }

  get size(): number {
    return this.pending.size
  }

  drain(): PendingMessagePatch[] {
    if (this.pending.size === 0) return []
    const out = [...this.pending].map(([id, patch]) => ({ id, patch }))
    this.pending.clear()
    return out
  }
}

export interface FrameFlush {
  schedule(): void
  cancel(): void
}

export function createFrameFlush(drain: () => void): FrameFlush {
  let handle: number | ReturnType<typeof setTimeout> | null = null
  let scheduled = false
  const animated = typeof requestAnimationFrame === 'function'
  const clear = (): void => {
    if (!scheduled) return
    scheduled = false
    if (handle === null) return
    if (animated) cancelAnimationFrame(handle as number)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
    handle = null
  }
  return {
    schedule() {
      if (scheduled) return
      scheduled = true
      const run = (): void => {
        scheduled = false
        handle = null
        drain()
      }
      handle = animated ? requestAnimationFrame(run) : setTimeout(run, 16)
    },
    cancel: clear
  }
}
