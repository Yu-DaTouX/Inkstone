import { pick } from '../../shared/ui-lang'
import { hostname } from 'node:os'
import { toB64u, type KeyPair } from './crypto'
import { RelayLink, relayWsBase, type WsCtor } from './link'
import { RelayBridgeStore, roomIdFor, type RelayClient, type RelayClientKind } from './store'
import { TunnelSession, type Pipe, type TunnelTarget } from './tunnel'

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
  private readonly relaySessions = new WeakSet<TunnelSession>()
  private key: KeyPair | null = null

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
      this.detail = pick('中继地址无效：应为 https://… 开头', 'Invalid relay address: it must start with https://')
      return
    }
    const hostKey = await this.store.hostKey()
    const secret = await this.store.secret()
    this.detail = pick('正在连接中继…', 'Connecting to the relay…')
    this.link = new RelayLink({
      url: next.url,
      secret,
      WebSocket: this.opts.WebSocket,
      log: (text) => this.opts.log?.(text),
      onState: (connected, detail) => {
        this.detail = connected ? null : (detail ?? pick('中继连接断开，正在重连', 'Relay connection lost; reconnecting'))
      },
      onPipe: (pipe) => this.open(pipe, hostKey, true)
    })
    this.link.start()
  }

  private open(pipe: Pipe, hostKey: KeyPair, viaRelay: boolean): void {
    const session = new TunnelSession(pipe, {
      hostKey,
      authenticate: (key, name, pair) => this.store.authenticate(key, name, pair),
      target: () => this.opts.target(),
      onOpen: (s) => this.sessions.add(s),
      onClose: (s) => this.sessions.delete(s),
      log: (text) => this.opts.log?.(text)
    })
    if (viaRelay) this.relaySessions.add(session)
  }

  async prepare(): Promise<void> {
    this.key ??= await this.store.hostKey()
  }

  acceptPipe(pipe: Pipe): void {
    if (!this.key) {
      pipe.close(1013, 'not ready')
      return
    }
    this.open(pipe, this.key, false)
  }

  async invite(): Promise<{ hostKey: string; code: string }> {
    const hostKey = await this.store.hostKey()
    return { hostKey: toB64u(hostKey.raw), code: this.store.startPairing('phone').code }
  }

  private stopLink(): void {
    this.link?.stop()
    this.link = null
    for (const s of [...this.sessions]) {
      if (!this.relaySessions.has(s)) continue
      s.close()
      this.sessions.delete(s)
    }
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

  async pairLink(kind: RelayClientKind, direct: string[] = []): Promise<{ link: string; expiresAt: number }> {
    const viaRelay = this.settings.enabled && !!this.settings.url
    if (!viaRelay && !direct.length) throw new Error(pick('先开启设备连接或中继接入', 'Turn on device access or relay access first'))
    const hostKey = await this.store.hostKey()
    const room = viaRelay ? await roomIdFor(await this.store.secret()) : ''
    const relay = this.store.startPairing(kind)
    const yan = this.opts.startYanPairing()
    const payload = {
      v: 1,
      k: 'yan',
      m: kind,
      s: toB64u(hostKey.raw),
      n: hostname().slice(0, 60),
      c: relay.code,
      ...(viaRelay ? { r: `${relayWsBase(this.settings.url)}/v1/join/${room}` } : {}),
      ...(direct.length ? { d: direct } : {}),
      y: yan.code
    }
    return { link: `yan://relay#p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`, expiresAt: Math.min(relay.expiresAt, yan.expiresAt) }
  }

  async revoke(id: string): Promise<boolean> {
    try {
      return await this.store.revoke(id)
    } finally {
      for (const s of this.sessions) if (s.client?.id === id) s.close()
    }
  }

  forget(id: string): Promise<boolean> {
    return this.store.forget(id)
  }
}
