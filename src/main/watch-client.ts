import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { pick } from '../shared/ui-lang'
import {
  parseWatchInvite,
  watchSessionState,
  WATCH_HISTORY_LIMIT,
  type WatchEventChannel,
  type WatchInvite,
  type WatchJoinResult,
  type WatchPush,
  type WatchSessionState,
  type WatchStatus,
  type WatchView
} from '../shared/session-watch'
import type { UIMessage } from '../shared/ui-message'
import { WatchTunnel, WatchTunnelError } from './watch-tunnel'

const RETRY_MAX_MS = 30_000
const SETTLE_RELOAD_MS = 400
const LIVE_CHANNELS = new Set<WatchEventChannel>(['msg-add', 'msg-update', 'tool'])

interface WatchEntry {
  id: string
  invite: WatchInvite
  title: string
  status: WatchStatus
  error?: string
  state: WatchSessionState | null
  pending: Set<string>
  token: string | null
  tunnel: WatchTunnel | null
  stopStream: (() => void) | null
  lastSeq: number
  retry: number
  retryTimer: ReturnType<typeof setTimeout> | null
  reloadTimer: ReturnType<typeof setTimeout> | null
  sse: string
  closed: boolean
  generation: number
}

class WatchEnded extends Error {}

export interface WatchClientOptions {
  push(update: WatchPush): void
  deviceName?: () => string
  log?: (text: string) => void
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export class WatchClient {
  private readonly watches = new Map<string, WatchEntry>()

  constructor(private readonly opts: WatchClientOptions) {}

  private view(entry: WatchEntry): WatchView {
    return {
      id: entry.id,
      title: entry.title,
      host: entry.invite.host,
      fingerprint: entry.invite.fingerprint,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      pending: entry.pending.size,
      state: entry.state
    }
  }

  private emitView(entry: WatchEntry): void {
    if (this.watches.get(entry.id) !== entry) return
    this.opts.push({ watchId: entry.id, kind: 'view', view: this.view(entry) })
  }

  list(): WatchView[] {
    return [...this.watches.values()].map((entry) => this.view(entry))
  }

  async join(text: string): Promise<WatchJoinResult> {
    const invite = parseWatchInvite(String(text ?? ''))
    if (!invite) return { ok: false, error: pick('\u8fd9\u4e0d\u662f\u6709\u6548\u7684\u65c1\u89c2\u9080\u8bf7\uff0c\u8bf7\u6574\u6bb5\u590d\u5236\u5bf9\u65b9\u53d1\u6765\u7684\u9080\u8bf7', 'This is not a valid watch invite. Copy the whole invite again') }
    const same = [...this.watches.values()].find((entry) => entry.invite.code === invite.code && entry.invite.hostKey === invite.hostKey)
    if (same && same.status !== 'ended' && same.status !== 'failed') return { ok: true, watch: this.view(same) }
    if (same) this.discard(same)
    const entry: WatchEntry = {
      id: `w-${randomUUID()}`,
      invite,
      title: invite.title,
      status: 'connecting',
      state: null,
      pending: new Set(),
      token: null,
      tunnel: null,
      stopStream: null,
      lastSeq: 0,
      retry: 0,
      retryTimer: null,
      reloadTimer: null,
      sse: '',
      closed: false,
      generation: 0
    }
    this.watches.set(entry.id, entry)
    try {
      await this.connect(entry)
      return { ok: true, watch: this.view(entry) }
    } catch (error) {
      this.discard(entry)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async connect(entry: WatchEntry): Promise<void> {
    const generation = ++entry.generation
    entry.stopStream?.()
    entry.stopStream = null
    entry.tunnel?.close()
    entry.sse = ''
    const tunnel = new WatchTunnel({
      url: entry.invite.direct[0],
      hostKey: entry.invite.hostKey,
      deviceName: (this.opts.deviceName ?? hostname)().slice(0, 60),
      pairingCode: entry.invite.code,
      onClose: () => {
        if (entry.generation === generation) this.dropped(entry)
      }
    })
    entry.tunnel = tunnel
    try {
      await tunnel.connect()
    } catch (error) {
      if (error instanceof WatchTunnelError && error.code === 'tunnel-denied') throw new WatchEnded(error.message)
      throw error
    }
    if (!entry.token) {
      const reply = await tunnel.request('POST', '/remote/v1/pair', { body: { code: entry.invite.code, deviceName: (this.opts.deviceName ?? hostname)().slice(0, 60), kind: 'viewer' } })
      const body = parseJson(reply.text)
      if (reply.status !== 200 || typeof body.token !== 'string') throw new WatchEnded(typeof body.error === 'string' ? body.error : pick('\u5bf9\u65b9\u6ca1\u6709\u63a5\u53d7\u8fd9\u6b21\u65c1\u89c2', 'The host did not accept this viewer'))
      entry.token = body.token
    }
    await this.reload(entry, generation)
    await this.openEvents(entry, generation)
    if (entry.generation !== generation) return
    entry.status = 'live'
    entry.error = undefined
    entry.retry = 0
    this.emitView(entry)
  }

  private async reload(entry: WatchEntry, generation = entry.generation): Promise<void> {
    const tunnel = entry.tunnel
    if (!tunnel || !entry.token) return
    const reply = await tunnel.request('GET', `/remote/v1/watch?limit=${WATCH_HISTORY_LIMIT}`, { token: entry.token })
    const body = parseJson(reply.text)
    if (reply.status === 401 || reply.status === 403) throw new WatchEnded(pick('\u5171\u4eab\u5df2\u7ed3\u675f\uff0c\u6216\u4f60\u5df2\u88ab\u79fb\u51fa\u65c1\u89c2', 'Sharing has ended or you were removed'))
    if (reply.status !== 200 || body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : pick('\u8bfb\u4e0d\u5230\u4f1a\u8bdd\u5185\u5bb9', 'Could not read the session'))
    if (entry.generation !== generation) return
    const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {}
    const messages = Array.isArray(data.messages) ? (data.messages as UIMessage[]) : []
    if (typeof data.title === 'string' && data.title.trim()) entry.title = data.title.trim().slice(0, 200)
    if (typeof data.seq === 'number' && Number.isSafeInteger(data.seq)) entry.lastSeq = Math.max(entry.lastSeq, data.seq)
    if (data.state !== undefined) entry.state = watchSessionState(data.state) ?? entry.state
    this.opts.push({ watchId: entry.id, kind: 'reset', view: this.view(entry), messages })
  }

  private async openEvents(entry: WatchEntry, generation: number): Promise<void> {
    const tunnel = entry.tunnel
    if (!tunnel || !entry.token) return
    const opened = await tunnel.openStream(`/remote/v1/watch/events?since=${entry.lastSeq}`, entry.token, {
      chunk: (text) => {
        if (entry.generation === generation) this.feed(entry, text)
      },
      end: () => {
        if (entry.generation === generation) this.dropped(entry)
      }
    })
    if (!opened.ok) {
      if (opened.status === 401 || opened.status === 403) throw new WatchEnded(pick('\u5171\u4eab\u5df2\u7ed3\u675f\uff0c\u6216\u4f60\u5df2\u88ab\u79fb\u51fa\u65c1\u89c2', 'Sharing has ended or you were removed'))
      throw new Error(opened.error || pick('\u6253\u4e0d\u5f00\u4e8b\u4ef6\u6d41', 'Could not open the event stream'))
    }
    if (entry.generation !== generation) {
      opened.stop()
      return
    }
    entry.stopStream = opened.stop
  }

  private feed(entry: WatchEntry, text: string): void {
    entry.sse += text.replace(/\r\n/g, '\n')
    let cut = entry.sse.indexOf('\n\n')
    while (cut >= 0) {
      const block = entry.sse.slice(0, cut)
      entry.sse = entry.sse.slice(cut + 2)
      this.block(entry, block)
      if (this.watches.get(entry.id) !== entry) return
      cut = entry.sse.indexOf('\n\n')
    }
    if (entry.sse.length > 32 * 1024 * 1024) {
      entry.sse = ''
      this.scheduleReload(entry, 0)
    }
  }

  private block(entry: WatchEntry, block: string): void {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (event === 'ready') return
    if (event === 'ended') {
      this.end(entry, pick('\u5bf9\u65b9\u5df2\u505c\u6b62\u5171\u4eab', 'The host stopped sharing'))
      return
    }
    if (event === 'resync') {
      this.scheduleReload(entry, 0)
      return
    }
    if (!data.length) return
    const envelope = parseJson(data.join('\n'))
    if (typeof envelope.seq === 'number') entry.lastSeq = Math.max(entry.lastSeq, envelope.seq)
    this.apply(entry, event as WatchEventChannel, envelope.payload)
  }

  private apply(entry: WatchEntry, channel: WatchEventChannel, payload: unknown): void {
    if (LIVE_CHANNELS.has(channel)) {
      this.opts.push({ watchId: entry.id, kind: 'event', event: { channel, payload } })
      return
    }
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    switch (channel) {
      case 'state':
        entry.state = watchSessionState(payload)
        this.emitView(entry)
        return
      case 'session-title':
        if (typeof record.title === 'string' && record.title.trim()) {
          entry.title = record.title.trim().slice(0, 200)
          this.emitView(entry)
        }
        return
      case 'pending':
        if (typeof record.id === 'string') {
          if (record.open === true) entry.pending.add(record.id)
          else entry.pending.delete(record.id)
          this.emitView(entry)
        }
        return
      case 'turn-settled':
        this.scheduleReload(entry, SETTLE_RELOAD_MS)
        return
      case 'resync':
        this.scheduleReload(entry, 0)
        return
    }
  }

  private scheduleReload(entry: WatchEntry, delay: number): void {
    if (entry.reloadTimer) clearTimeout(entry.reloadTimer)
    entry.reloadTimer = setTimeout(() => {
      entry.reloadTimer = null
      void this.reload(entry).catch((error: unknown) => {
        if (error instanceof WatchEnded) this.end(entry, error.message)
      })
    }, delay)
    entry.reloadTimer.unref?.()
  }

  refresh(id: string): void {
    const entry = this.watches.get(String(id ?? ''))
    if (entry && entry.status === 'live') this.scheduleReload(entry, 0)
  }

  private dropped(entry: WatchEntry): void {
    if (entry.closed || this.watches.get(entry.id) !== entry || entry.status === 'ended') return
    if (entry.retryTimer) return
    entry.generation += 1
    entry.stopStream = null
    entry.status = 'reconnecting'
    this.emitView(entry)
    const delay = Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(entry.retry, 5))
    entry.retry += 1
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null
      if (entry.closed || this.watches.get(entry.id) !== entry) return
      void this.connect(entry).catch((error: unknown) => {
        if (error instanceof WatchEnded) this.end(entry, error.message)
        else {
          entry.error = error instanceof Error ? error.message : String(error)
          this.dropped(entry)
        }
      })
    }, delay)
    entry.retryTimer.unref?.()
  }

  private end(entry: WatchEntry, reason: string): void {
    if (entry.status === 'ended') return
    entry.generation += 1
    entry.status = 'ended'
    entry.error = reason
    entry.pending.clear()
    entry.state = entry.state ? { ...entry.state, isStreaming: false, isAgentRunning: false } : null
    this.cleanup(entry)
    this.emitView(entry)
  }

  private cleanup(entry: WatchEntry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    if (entry.reloadTimer) clearTimeout(entry.reloadTimer)
    entry.retryTimer = null
    entry.reloadTimer = null
    entry.stopStream?.()
    entry.stopStream = null
    entry.tunnel?.close()
    entry.tunnel = null
  }

  private discard(entry: WatchEntry): void {
    entry.closed = true
    entry.generation += 1
    this.cleanup(entry)
    this.watches.delete(entry.id)
  }

  async leave(id: string): Promise<void> {
    const entry = this.watches.get(String(id ?? ''))
    if (!entry) return
    const tunnel = entry.tunnel
    const token = entry.token
    entry.closed = true
    entry.generation += 1
    if (tunnel?.connected && token && entry.status !== 'ended') {
      await tunnel.request('POST', '/remote/v1/devices/self/revoke', { token, body: {}, timeoutMs: 3000 }).catch(() => undefined)
    }
    this.discard(entry)
    this.opts.push({ watchId: entry.id, kind: 'removed' })
  }

  stopAll(): void {
    for (const entry of [...this.watches.values()]) this.discard(entry)
  }
}
