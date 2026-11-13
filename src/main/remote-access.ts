import { pick } from '../shared/ui-lang'
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import type { MainPush } from '../shared/ipc'
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  REMOTE_DEFAULT_PORT,
  type RemoteAccessSettings,
  type RemoteAccessStatus
} from '../shared/remote-protocol'
import { RemoteDeviceStore } from './remote-devices'
import { randomBytes } from 'node:crypto'
import { RelayBridge } from './relay-bridge'
import { DirectTunnelEndpoint } from './relay-bridge/direct'
import { REMOTE_TUNNEL_PATH, RemoteServer, type PeerHostHandlers, type RemoteServerHandlers } from './remote-server'
import { RemotePushCoalescer } from './remote-push-coalesce'
import { remotePushPayload } from './remote-host'
import type { PeerGrantRegistry } from './peer-grants'

type AddressKind = RemoteAccessStatus['addresses'][number]['kind']

function isTailscaleIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

function isRadminIPv4(address: string, adapter: string): boolean {
  return /radmin/i.test(adapter) || address.split('.')[0] === '26'
}

const KIND_ORDER: Record<AddressKind, number> = { tailscale: 0, radmin: 1, lan: 2, loopback: 3 }

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function candidateAddresses(): RemoteAccessStatus['addresses'] {
  const found: RemoteAccessStatus['addresses'] = []
  for (const [adapter, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal || item.address.startsWith('169.254.')) continue
      const kind: AddressKind | null = isTailscaleIPv4(item.address)
        ? 'tailscale'
        : isRadminIPv4(item.address, adapter)
          ? 'radmin'
          : isPrivateIPv4(item.address)
            ? 'lan'
            : null
      if (kind && !found.some((entry) => entry.address === item.address)) found.push({ kind, address: item.address })
    }
  }
  found.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind])
  return [...found, { kind: 'loopback', address: '127.0.0.1' }]
}

function tailscaleCliAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null)
      const address = String(stdout).split(/\s+/).find((line) => isTailscaleIPv4(line.trim()))
      resolve(address?.trim() ?? null)
    })
  })
}

async function resolveBindHost(bind: RemoteAccessSettings['bind']): Promise<string | null> {
  if (bind === 'loopback') return '127.0.0.1'
  if (bind === 'tailscale') {
    return candidateAddresses().find((entry) => entry.kind === 'tailscale')?.address ?? (await tailscaleCliAddress())
  }
  if (bind === 'radmin') return candidateAddresses().find((entry) => entry.kind === 'radmin')?.address ?? null
  return bind
}

export class RemoteAccess {
  readonly devices: RemoteDeviceStore
  private server: RemoteServer | null = null
  private settings: RemoteAccessSettings = DEFAULT_REMOTE_ACCESS_SETTINGS
  private lastError: string | null = null
  private applying: Promise<void> = Promise.resolve()
  private stopped = false
  readonly relay: RelayBridge
  private relayServer: RemoteServer | null = null
  private relayToken = ''
  private relayPairing: { kind: 'phone' | 'agent'; link: string; expiresAt: number } | null = null
  private readonly outgoing: RemotePushCoalescer
  private readonly direct: DirectTunnelEndpoint

  constructor(
    dataDir: string,
    private readonly handlers: RemoteServerHandlers,
    private readonly log: (text: string, level?: 'info' | 'error') => void = () => undefined,
    private readonly peers?: { grants: PeerGrantRegistry; handlers: PeerHostHandlers }
  ) {
    this.devices = new RemoteDeviceStore(dataDir)
    this.outgoing = new RemotePushCoalescer((message) => this.deliver(message))
    this.relay = new RelayBridge(dataDir, {
      target: () => (this.relayServer?.running ? { host: '127.0.0.1', port: this.relayServer.info.port, relayToken: this.relayToken } : null),
      startYanPairing: () => this.devices.startPairing(),
      log: this.log
    })
    this.direct = new DirectTunnelEndpoint((pipe) => this.relay.acceptPipe(pipe))
  }

  private envOverride(): { host: string; port: number; token?: string } | null {
    const rawPort = process.env.YAN_REMOTE_PORT?.trim()
    if (process.env.YAN_REMOTE_ENABLE !== '1' && !rawPort) return null
    return {
      host: process.env.YAN_REMOTE_HOST?.trim() || '127.0.0.1',
      port: rawPort ? Number(rawPort) : REMOTE_DEFAULT_PORT,
      token: process.env.YAN_REMOTE_TOKEN
    }
  }

  apply(settings: RemoteAccessSettings | undefined): Promise<void> {
    if (this.stopped) return this.applying
    this.settings = settings ?? DEFAULT_REMOTE_ACCESS_SETTINGS
    this.applying = this.applying.then(() => this.applyNow()).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(`远程服务启动失败：${this.lastError}`, 'error')
    })
    return this.applying
  }

  private async applyNow(): Promise<void> {
    if (this.stopped) return
    const env = this.envOverride()
    const wanted = env ?? (this.settings.enabled ? { host: await resolveBindHost(this.settings.bind), port: this.settings.port } : null)
    if (this.stopped) return
    await this.applyRelay(!!wanted?.host)
    if (this.stopped) return
    if (wanted && !wanted.host) {
      await this.stopServer()
      this.lastError = this.settings.bind === 'radmin'
        ? pick('没有找到 Radmin VPN 地址，请先连接 Radmin VPN', 'Radmin VPN address not found; connect to Radmin VPN first')
        : pick('没有找到 Tailscale 地址，请先登录 Tailscale', 'Tailscale address not found; sign in to Tailscale first')
      return
    }
    const current = this.server?.info
    if (wanted && current && current.host === wanted.host && current.port === wanted.port) return
    await this.stopServer()
    if (this.stopped) return
    this.lastError = null
    if (!wanted?.host) return
    await this.relay.prepare()
    if (this.stopped) return
    const server = new RemoteServer({
      host: wanted.host,
      port: wanted.port,
      token: env?.token,
      devices: this.devices,
      handlers: this.handlers,
      ...(this.peers ? { peers: this.peers } : {}),
      tunnel: {
        upgrade: (req, socket, head) => this.direct.upgrade(req, socket, head),
        invite: () => this.relay.invite(),
        stop: () => this.direct.stop()
      },
      relayClientPaired: (clientId) => this.relay.store.markPaired(clientId).then(() => undefined),
      relayClientRevoked: (clientId) => this.relay.revoke(clientId).then(() => undefined),
      onLog: this.log
    })
    await server.start()
    if (this.stopped) {
      await server.stop().catch(() => undefined)
      return
    }
    this.server = server
    if (env && server.info.token) this.log('旧版单令牌模式已启用')
  }

  private async applyRelay(direct: boolean): Promise<void> {
    const relay = this.settings.relay
    if (direct || (relay?.enabled && relay.url.trim())) {
      if (this.stopped) return
      if (!this.relayServer) {
        this.relayToken = randomBytes(24).toString('base64url')
        const server = new RemoteServer({
          host: '127.0.0.1',
          port: 0,
          devices: this.devices,
          handlers: this.handlers,
          relayToken: this.relayToken,
          ...(this.peers ? { peers: this.peers } : {}),
          relayClientPaired: (clientId) => this.relay.store.markPaired(clientId).then(() => undefined),
          relayClientRevoked: (clientId) => this.relay.revoke(clientId).then(() => undefined),
          onLog: this.log
        })
        await server.start()
        if (this.stopped) {
          await server.stop().catch(() => undefined)
          return
        }
        this.relayServer = server
      }
    } else if (this.relayServer) {
      const server = this.relayServer
      this.relayServer = null
      await server.stop().catch(() => undefined)
    }
    if (this.stopped) return
    await this.relay.apply(relay)
  }

  async relayPair(kind: 'phone' | 'agent'): Promise<void> {
    const info = this.server?.running ? this.server.info : null
    const direct = info && !['127.0.0.1', 'localhost', '::1'].includes(info.host) ? [`ws://${info.host.includes(':') ? `[${info.host}]` : info.host}:${info.port}${REMOTE_TUNNEL_PATH}`] : []
    const { link, expiresAt } = await this.relay.pairLink(kind, direct)
    this.relayPairing = { kind, link, expiresAt }
  }

  cancelRelayPairing(): void {
    this.relayPairing = null
    this.devices.cancelPairing()
  }

  async relayRevoke(id: string): Promise<boolean> {
    return this.relay.revoke(id)
  }

  relayForget(id: string): Promise<boolean> {
    return this.relay.forget(id)
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.peers?.grants.revokeAll()
    if (server) await server.stop().catch(() => undefined)
  }

  disconnectConnection(connectionId: string): void {
    this.server?.disconnectConnection(connectionId)
    this.relayServer?.disconnectConnection(connectionId)
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.applying.catch(() => undefined)
    this.outgoing.dispose()
    this.relay.stop()
    this.direct.dispose()
    const relayServer = this.relayServer
    this.relayServer = null
    await relayServer?.stop().catch(() => undefined)
    return this.stopServer()
  }

  publish(message: MainPush): void {
    if (!this.server && !this.relayServer) return
    const projected = { ...message, payload: remotePushPayload(message.ch, message.payload) } as MainPush
    this.outgoing.push(projected)
  }

  private deliver(message: MainPush): void {
    if (!this.server && !this.relayServer) return
    this.server?.publish(message)
    this.relayServer?.publish(message)
  }

  startPairing(): { code: string; expiresAt: number } {
    return this.devices.startPairing()
  }

  cancelPairing(): void {
    this.devices.cancelPairing()
  }

  async revoke(deviceId: string): Promise<boolean> {
    const tunnelClientId = (await this.devices.list()).find((device) => device.id === deviceId)?.tunnelClientId
    const revoked = await this.devices.revoke(deviceId)
    if (revoked) {
      this.server?.disconnectDevice(deviceId)
      this.relayServer?.disconnectDevice(deviceId)
      if (tunnelClientId) await this.relay.revoke(tunnelClientId)
    }
    return revoked
  }

  async forget(deviceId: string): Promise<boolean> {
    const tunnelClientId = (await this.devices.list()).find((device) => device.id === deviceId)?.tunnelClientId
    const forgotten = await this.devices.forget(deviceId)
    if (forgotten && tunnelClientId) {
      await this.relay.revoke(tunnelClientId)
      await this.relay.forget(tunnelClientId)
    }
    return forgotten
  }

  hostIdentity(): Promise<string> {
    return this.relay.identity()
  }

  async resetIdentity(): Promise<{ revokedDevices: number; hostFingerprint: string }> {
    let revokedDevices = 0
    for (const device of await this.devices.list()) {
      if (device.revokedAt !== null) continue
      if (await this.devices.revoke(device.id)) revokedDevices += 1
    }
    this.peers?.grants.revokeAll()
    this.server?.disconnectAll()
    this.relayServer?.disconnectAll()
    const hostFingerprint = await this.relay.resetIdentity()
    this.log(pick('已更换本机配对身份：主机密钥已更换，旧连接失效，所有设备需要重新配对', 'Host identity replaced: the host key changed, old connections no longer work and every device must pair again'))
    return { revokedDevices, hostFingerprint }
  }

  async status(): Promise<RemoteAccessStatus> {
    const info = this.server?.info
    return {
      enabled: this.settings.enabled || this.envOverride() !== null,
      hostFingerprint: await this.relay.identity().catch(() => ''),
      running: !!this.server?.running,
      host: info?.host ?? '',
      port: info?.port ?? this.settings.port,
      addresses: candidateAddresses(),
      pairing: this.devices.currentPairing(),
      devices: await this.devices.list(),
      grants: this.peers?.grants.list() ?? [],
      error: this.lastError,
      relay: {
        ...(await this.relay.status()),
        pairing: this.relayPairing && this.relayPairing.expiresAt > Date.now() ? this.relayPairing : null
      }
    }
  }
}
