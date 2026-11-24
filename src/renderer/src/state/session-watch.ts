import { create } from 'zustand'
import type { MainPush, RuntimeEnvelope, UIMessage } from '../../../shared/ipc'
import type { SessionShareView, WatchPush, WatchView } from '../../../shared/session-watch'
import { reduceSessionRuntime, type SessionRuntimeMap } from './session-runtime'

const RUNTIME: RuntimeEnvelope = { sessionId: 'watch', runId: 'watch', generation: 0 }

export interface WatchData {
  view: WatchView
  runtimes: SessionRuntimeMap
  messages: UIMessage[]
  loaded: boolean
}

export type WatchDialog = { kind: 'share'; sessionId: string; title: string } | { kind: 'join' } | null

interface SessionWatchState {
  watches: Record<string, WatchData>
  shares: Record<string, SessionShareView | null>
  dialog: WatchDialog
  openShare(sessionId: string, title: string): void
  openJoin(): void
  closeDialog(): void
  setShare(sessionId: string, share: SessionShareView | null): void
  adopt(view: WatchView): void
}

function seeded(messages: UIMessage[]): SessionRuntimeMap {
  return reduceSessionRuntime({}, RUNTIME, { ch: 'sync', payload: messages, resync: true } as MainPush)
}

function messagesOf(runtimes: SessionRuntimeMap): UIMessage[] {
  return runtimes[RUNTIME.sessionId]?.messages ?? []
}

function targetMissing(messages: UIMessage[], channel: string, payload: unknown): boolean {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const id = channel === 'msg-update' ? record.id : channel === 'tool' ? record.msgId : null
  return typeof id === 'string' && !messages.some((message) => message.id === id)
}

export const useSessionWatch = create<SessionWatchState>((set) => ({
  watches: {},
  shares: {},
  dialog: null,
  openShare: (sessionId, title) => set({ dialog: { kind: 'share', sessionId, title } }),
  openJoin: () => set({ dialog: { kind: 'join' } }),
  closeDialog: () => set({ dialog: null }),
  setShare: (sessionId, share) => set((state) => ({ shares: { ...state.shares, [sessionId]: share } })),
  adopt: (view) =>
    set((state) => ({
      watches: {
        ...state.watches,
        [view.id]: state.watches[view.id] ? { ...state.watches[view.id], view } : { view, runtimes: {}, messages: [], loaded: false }
      }
    }))
}))

function applyWatch(update: WatchPush): void {
  const state = useSessionWatch.getState()
  const current = state.watches[update.watchId]
  if (update.kind === 'removed') {
    if (!current) return
    const watches = { ...state.watches }
    delete watches[update.watchId]
    useSessionWatch.setState({ watches })
    return
  }
  if (update.kind === 'view') {
    useSessionWatch.setState({ watches: { ...state.watches, [update.watchId]: current ? { ...current, view: update.view } : { view: update.view, runtimes: {}, messages: [], loaded: false } } })
    return
  }
  if (update.kind === 'reset') {
    const runtimes = seeded(update.messages)
    useSessionWatch.setState({ watches: { ...state.watches, [update.watchId]: { view: update.view, runtimes, messages: messagesOf(runtimes), loaded: true } } })
    return
  }
  if (!current) return
  const { channel, payload } = update.event
  if (targetMissing(current.messages, channel, payload)) {
    void window.yan.watch.refresh(update.watchId).catch(() => undefined)
    return
  }
  if (channel === 'msg-add') {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id === 'string' && current.messages.some((message) => message.id === id)) return
  }
  const runtimes = reduceSessionRuntime(current.runtimes, RUNTIME, { ch: channel, payload } as MainPush)
  useSessionWatch.setState({ watches: { ...state.watches, [update.watchId]: { ...current, runtimes, messages: messagesOf(runtimes), loaded: true } } })
}

let listening = false

export function listenSessionWatch(): void {
  if (listening) return
  listening = true
  window.yan.onPush((message) => {
    if (message.ch === 'watch') applyWatch(message.payload)
    else if (message.ch === 'session-share') useSessionWatch.getState().setShare(message.payload.sessionId, message.payload.share)
  })
  void window.yan.watch.list().then((views) => {
    for (const view of views) useSessionWatch.getState().adopt(view)
  }, () => undefined)
}
