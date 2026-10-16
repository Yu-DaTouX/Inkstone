import { hostname } from 'node:os'
import { toB64u } from './crypto'
import { RelayLink, relayWsBase, type WsCtor } from './link'
import { RelayBridgeStore, roomIdFor, type RelayClient, type RelayClientKind } from './store'
import { TunnelSession, type TunnelTarget } from './tunnel'

export interface RelayBridgeSettings {
  enabled: boolean
  url: string
}

export type RelayClientView = Omit<RelayClient, 'key'> & { online: boolean }

export interface RelayBridgeStatus {
  enabled: boolean
  url: string
  connected: boolean
  detail: string | null
  clients: RelayClientView[]
}

export interface RelayBridgeOptions {
  target(): TunnelTarget | null
  startYanPairing(): { code: string; expiresAt: number }
  log?(text: string, level?: 'info' | 'error'): void
  WebSocket?: WsCtor
}

export class RelayBridge {
  readonly store: RelayBridgeStore
  private link: RelayLink | null = null
  private settings: RelayBridgeSettings = { enabled: false, url: '' }
  private detail: string | null = null
  private readonly sessions = new Set<TunnelSession>()

  constructor(dataDir: string, private readonly opts: RelayBridgeOptions) {
    this.store = new RelayBridgeStore(dataDir)
  }

  async apply(settings: RelayBridgeSettings | undefined): Promise<void> {
    const next = { enabled: !!settings?.enabled, url: (settings?.url ?? '').trim() }
    const same = this.link && next.enabled && next.url === this.settings.url
    this.settings = next
    if (same) return
    this.stopLink()
    if (!next.enabled) return
    if (!/^(https?|wss?):\/\/[^\s/]+/.test(next.url)) {
      this.detail = '中继地址无效：应为 https://… 开头'
      return
    }
    const hostKey = await this.store.hostKey()
    const secret = await this.store.secret()
    this.detail = '正在连接中继…'
    this.link = new RelayLink({
      url: next.url,
      secret,
      WebSocket: this.opts.WebSocket,
      log: (text) => this.opts.log?.(text),
      onState: (connected, detail) => {
        this.detail = connected ? null : (detail ?? '中继连接断开，正在重连')
      },
      onPipe: (pipe) => {
        const session = new TunnelSession(pipe, {
          hostKey,
          authenticate: (key, name, pair) => this.store.authenticate(key, name, pair),
          target: () => this.opts.target(),
          onOpen: (s) => this.sessions.add(s),
          onClose: (s) => this.sessions.delete(s),
          log: (text) => this.opts.log?.(text)
        })
        void session
      }
    })
    this.link.start()
  }

  private stopLink(): void {
    this.link?.stop()
    this.link = null
    for (const s of this.sessions) s.close()
    this.sessions.clear()
    this.detail = null
  }

  stop(): void {
    this.stopLink()
  }

  async status(): Promise<RelayBridgeStatus> {
    const online = new Set([...this.sessions].filter((s) => s.isOpen).map((s) => s.client?.id))
    return {
      enabled: this.settings.enabled,
      url: this.settings.url,
      connected: !!this.link?.connected,
      detail: this.detail,
      clients: (await this.store.list()).map(({ key: _key, ...c }) => ({ ...c, online: online.has(c.id) }))
    }
  }

  async pairLink(kind: RelayClientKind): Promise<{ link: string; expiresAt: number }> {
    if (!this.settings.enabled || !this.settings.url) throw new Error('先开启中继接入并填写中继地址')
    const hostKey = await this.store.hostKey()
    const room = await roomIdFor(await this.store.secret())
    const relay = this.store.startPairing(kind)
    const yan = this.opts.startYanPairing()
    const payload = {
      v: 1,
      k: 'yan',
      m: kind,
      s: toB64u(hostKey.raw),
      n: hostname().slice(0, 60),
      c: relay.code,
      r: `${relayWsBase(this.settings.url)}/v1/join/${room}`,
      y: yan.code
    }
    return { link: `yan://relay#p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`, expiresAt: Math.min(relay.expiresAt, yan.expiresAt) }
  }

  async revoke(id: string): Promise<boolean> {
    const ok = await this.store.revoke(id)
    for (const s of this.sessions) if (s.client?.id === id) s.close()
    return ok
  }

  forget(id: string): Promise<boolean> {
    return this.store.forget(id)
  }
}
