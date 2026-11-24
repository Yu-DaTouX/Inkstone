import type { MainPush } from '../shared/ipc'
import { clipOutputDelta, watchMessage, watchMessagePatch, watchSessionState, watchToolCall, type WatchEventChannel } from '../shared/session-watch'

export interface WatchProjection {
  sessionId: string
  channel: WatchEventChannel
  payload: unknown
}

function ownerOf(message: MainPush): string | undefined {
  const fromRuntime = message.runtime?.sessionId
  if (fromRuntime) return fromRuntime
  const payload = message.payload as { sessionId?: unknown } | null | undefined
  return payload && typeof payload === 'object' && typeof payload.sessionId === 'string' ? payload.sessionId : undefined
}

export function watchProjection(message: MainPush, shared: (sessionId: string) => boolean): WatchProjection | null {
  const sessionId = ownerOf(message)
  if (!sessionId || !shared(sessionId)) return null
  const at = (channel: WatchEventChannel, payload: unknown): WatchProjection => ({ sessionId, channel, payload })
  switch (message.ch) {
    case 'msg-add':
      return at('msg-add', watchMessage(message.payload))
    case 'msg-update':
      return at('msg-update', { id: message.payload.id, patch: watchMessagePatch(message.payload.patch as Record<string, unknown>) })
    case 'tool': {
      const delta = clipOutputDelta(message.payload.outputDelta)
      return at('tool', {
        msgId: message.payload.msgId,
        call: watchToolCall(message.payload.call),
        ...(delta !== undefined ? { outputDelta: delta } : {}),
        ...(message.payload.sameArgs ? { sameArgs: true } : {})
      })
    }
    case 'state':
      return at('state', watchSessionState(message.payload))
    case 'turn-settled':
      return at('turn-settled', {})
    case 'session-title':
      return at('session-title', { title: message.payload.title })
    case 'ui-request':
    case 'approval':
      return at('pending', { id: message.payload.id, open: true })
    case 'ui-resolved':
    case 'approval-close':
      return at('pending', { id: message.payload.id, open: false })
    case 'sync':
    case 'sync-delta':
      return at('resync', {})
    default:
      return null
  }
}
