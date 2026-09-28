/**
 * 手机接入（远程访问）的生命周期：按设置启停远程服务、识别可用地址、配对与撤销设备。
 *
 * 默认关闭，不监听任何端口。开启后默认只绑定 Tailscale 地址（需求稿：外网优先 Tailscale），
 * 找不到 Tailscale 时不自动退到所有网卡 —— 而是报告「没有可用地址」，由用户选择本机或具体 IP。
 * 普通 SSH 隧道可以用「仅本机」绑定再转发端口。
 *
 * 旧的环境变量入口（YAN_REMOTE_ENABLE / YAN_REMOTE_PORT / YAN_REMOTE_TOKEN）仍然可用，
 * 优先于设置，便于已有的测试与脚本。
 */
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
import { RemoteServer, type PeerHostHandlers, type RemoteServerHandlers } from './remote-server'
import type { PeerGrantRegistry } from './peer-grants'

type AddressKind = RemoteAccessStatus['addresses'][number]['kind']

/** Tailscale 使用 100.64.0.0/10（CGNAT 段） */
function isTailscaleIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** 本机可供手机连接的地址（只列 IPv4；Tailscale 优先） */
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

/** 网卡里没找到时再问一次 tailscale CLI（某些 Windows 配置下网卡名不直观） */
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
  /** 串行化启停：连续切换开关时不会同时起两个监听 */
  private applying: Promise<void> = Promise.resolve()

  constructor(
    dataDir: string,
    private readonly handlers: RemoteServerHandlers,
    private readonly log: (text: string, level?: 'info' | 'error') => void = () => undefined,
    /** 砚对砚：本次连接授权与开放数据 */
    private readonly peers?: { grants: PeerGrantRegistry; handlers: PeerHostHandlers }
  ) {
    this.devices = new RemoteDeviceStore(dataDir)
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

  /** 按设置（或环境变量）启动 / 停止 / 重启远程服务 */
  apply(settings: RemoteAccessSettings | undefined): Promise<void> {
    this.settings = settings ?? DEFAULT_REMOTE_ACCESS_SETTINGS
    this.applying = this.applying.then(() => this.applyNow()).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(`远程服务启动失败：${this.lastError}`, 'error')
    })
    return this.applying
  }

  private async applyNow(): Promise<void> {
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
    if (env && server.info.token) this.log(`旧版单令牌模式：token=${server.info.token}`)
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    /* 服务停下，所有本次连接授权一并作废 */
    this.peers?.grants.revokeAll()
    if (server) await server.stop().catch(() => undefined)
  }

  /** 所有者撤销一次砚对砚连接 */
  revokeConnection(connectionId: string): boolean {
    return this.peers?.grants.revoke(connectionId) ?? false
  }

  /** 登记表通知某次连接作废：断开它的事件流 */
  disconnectConnection(connectionId: string): void {
    this.server?.disconnectConnection(connectionId)
  }

  stop(): Promise<void> {
    return this.stopServer()
  }

  publish(message: MainPush): void {
    this.server?.publish(message)
  }

  startPairing(): { code: string; expiresAt: number } {
    return this.devices.startPairing()
  }

  cancelPairing(): void {
    this.devices.cancelPairing()
  }

  async revoke(deviceId: string): Promise<boolean> {
    const revoked = await this.devices.revoke(deviceId)
    if (revoked) this.server?.disconnectDevice(deviceId)
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
      error: this.lastError
    }
  }
}
