import type { MessagePatch } from '../../../shared/ipc'

export interface PendingMessagePatch {
  id: string
  patch: MessagePatch
}

export function mergeMessagePatch(previous: MessagePatch | undefined, next: MessagePatch): MessagePatch {
  if (!previous) return next
  const { textDelta: previousText, thinkingDelta: previousThinking, ...previousFields } = previous
  const { textDelta: nextText, thinkingDelta: nextThinking, ...nextFields } = next
  const textDelta = (previousText ?? '') + (nextText ?? '')
  const thinkingDelta = (previousThinking ?? '') + (nextThinking ?? '')
  return {
    ...previousFields,
    ...nextFields,
    ...(previousText === undefined && nextText === undefined ? {} : { textDelta }),
    ...(previousThinking === undefined && nextThinking === undefined ? {} : { thinkingDelta })
  }
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
  const animated = typeof requestAnimationFrame === 'function'
  const clear = (): void => {
    if (handle === null) return
    if (animated) cancelAnimationFrame(handle as number)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
    handle = null
  }
  return {
    schedule() {
      if (handle !== null) return
      const run = (): void => {
        handle = null
        drain()
      }
      handle = animated ? requestAnimationFrame(run) : setTimeout(run, 16)
    },
    cancel: clear
  }
}
