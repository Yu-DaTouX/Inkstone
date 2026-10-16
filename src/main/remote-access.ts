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
import { RemoteServer, type PeerHostHandlers, type RemoteServerHandlers } from './remote-server'
import type { PeerGrantRegistry } from './peer-grants'

type AddressKind = RemoteAccessStatus['addresses'][number]['kind']

function isTailscaleIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function candidateAddresses(): RemoteAccessStatus['addresses'] {
  const found: RemoteAccessStatus['addresses'] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const kind: AddressKind | null = isTailscaleIPv4(item.address) ? 'tailscale' : isPrivateIPv4(item.address) ? 'lan' : null
      if (kind && !found.some((entry) => entry.address === item.address)) found.push({ kind, address: item.address })
    }
  }
  found.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'tailscale' ? -1 : 1))
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
  return bind
}

export class RemoteAccess {
  readonly devices: RemoteDeviceStore
  private server: RemoteServer | null = null
  private settings: RemoteAccessSettings = DEFAULT_REMOTE_ACCESS_SETTINGS
  private lastError: string | null = null
  private applying: Promise<void> = Promise.resolve()
  readonly relay: RelayBridge
  private relayServer: RemoteServer | null = null
  private relayToken = ''
  private relayPairing: { kind: 'phone' | 'agent'; link: string; expiresAt: number } | null = null

  constructor(
    dataDir: string,
    private readonly handlers: RemoteServerHandlers,
    private readonly log: (text: string, level?: 'info' | 'error') => void = () => undefined,
    private readonly peers?: { grants: PeerGrantRegistry; handlers: PeerHostHandlers }
  ) {
    this.devices = new RemoteDeviceStore(dataDir)
    this.relay = new RelayBridge(dataDir, {
      target: () => (this.relayServer?.running ? { host: '127.0.0.1', port: this.relayServer.info.port, relayToken: this.relayToken } : null),
      startYanPairing: () => this.devices.startPairing(),
      log: this.log
    })
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
    this.settings = settings ?? DEFAULT_REMOTE_ACCESS_SETTINGS
    this.applying = this.applying.then(() => this.applyNow()).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(`远程服务启动失败：${this.lastError}`, 'error')
    })
    return this.applying
  }

  private async applyNow(): Promise<void> {
    await this.applyRelay()
    const env = this.envOverride()
    const wanted = env ?? (this.settings.enabled ? { host: await resolveBindHost(this.settings.bind), port: this.settings.port } : null)
    if (wanted && !wanted.host) {
      await this.stopServer()
      this.lastError = '没有找到 Tailscale 地址：请确认 Tailscale 已登录，或改为「仅本机」/ 指定 IP'
      return
    }
    const current = this.server?.info
    if (wanted && current && current.host === wanted.host && current.port === wanted.port) return
    await this.stopServer()
    this.lastError = null
    if (!wanted?.host) return
    const server = new RemoteServer({
      host: wanted.host,
      port: wanted.port,
      token: env?.token,
      devices: this.devices,
      handlers: this.handlers,
      ...(this.peers ? { peers: this.peers } : {}),
      onLog: this.log
    })
    await server.start()
    this.server = server
    if (env && server.info.token) this.log('旧版单令牌模式已启用')
  }

  private async applyRelay(): Promise<void> {
    const relay = this.settings.relay
    if (relay?.enabled && relay.url.trim()) {
      if (!this.relayServer) {
        this.relayToken = randomBytes(24).toString('base64url')
        const server = new RemoteServer({
          host: '127.0.0.1',
          port: 0,
          devices: this.devices,
          handlers: this.handlers,
          relayToken: this.relayToken,
          onLog: this.log
        })
        await server.start()
        this.relayServer = server
      }
    } else if (this.relayServer) {
      const server = this.relayServer
      this.relayServer = null
      await server.stop().catch(() => undefined)
    }
    await this.relay.apply(relay)
  }

  async relayPair(kind: 'phone' | 'agent'): Promise<void> {
    const { link, expiresAt } = await this.relay.pairLink(kind)
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

  revokeConnection(connectionId: string): boolean {
    return this.peers?.grants.revoke(connectionId) ?? false
  }

  disconnectConnection(connectionId: string): void {
    this.server?.disconnectConnection(connectionId)
  }

  async stop(): Promise<void> {
    this.relay.stop()
    const relayServer = this.relayServer
    this.relayServer = null
    await relayServer?.stop().catch(() => undefined)
    return this.stopServer()
  }

  publish(message: MainPush): void {
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
    const revoked = await this.devices.revoke(deviceId)
    if (revoked) {
      this.server?.disconnectDevice(deviceId)
      this.relayServer?.disconnectDevice(deviceId)
    }
    return revoked
  }

  forget(deviceId: string): Promise<boolean> {
    return this.devices.forget(deviceId)
  }

  async status(): Promise<RemoteAccessStatus> {
    const info = this.server?.info
    return {
      enabled: this.settings.enabled || this.envOverride() !== null,
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
