import { cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BRIDGE_REVISION, BrowserBridgeServer, type BridgeConnection, type BridgeConnectionInfo } from './bridge-server'
import { installBridgeHost, type BridgeBrowser } from './native-host'
import { UserBrowserError, UserBrowserSession, browserLabel } from './session-host'

export interface UserBrowserStartOptions {
  dataDir: string
  hostSource: string
  extensionSource: string
  execPath: string
  register: boolean
}

export interface UserBrowserStatus {
  running: boolean
  extensionDir: string
  connections: BridgeConnectionInfo[]
}

const BROWSERS = new Set<BridgeBrowser>(['chrome', 'edge', 'firefox'])

async function manifestVersion(dir: string): Promise<string> {
  try {
    return String(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

export class UserBrowserService {
  readonly server = new BrowserBridgeServer()
  private readonly sessions = new Map<string, UserBrowserSession>()
  private running = false
  private extensionTarget = ''

  constructor() {
    this.server.on('connection', (connection) => {
      if (connection.info.revision >= 2 && connection.info.revision < BRIDGE_REVISION) {
        void connection.call('runtime.reload', {}, 5_000).catch(() => undefined)
        return
      }
      this.rebind(connection)
    })
    this.server.on('tabRemoved', (connection, tabId) => {
      for (const session of this.sessions.values()) if (session.info.id === connection.info.id) session.tabRemoved(tabId)
    })
  }

  async start(options: UserBrowserStartOptions): Promise<void> {
    if (this.running) return
    this.extensionTarget = join(options.dataDir, 'browser-cookie-bridge')
    if ((await manifestVersion(options.extensionSource)) !== (await manifestVersion(this.extensionTarget))) {
      await cp(options.extensionSource, this.extensionTarget, { recursive: true, force: true })
    }
    const dir = join(options.dataDir, 'browser-bridge')
    await mkdir(dir, { recursive: true })
    await installBridgeHost({ dir, hostSource: options.hostSource, execPath: options.execPath, register: options.register })
    await this.server.start(dir)
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    this.sessions.clear()
    await this.server.stop()
  }

  status(): UserBrowserStatus {
    return { running: this.running, extensionDir: this.extensionTarget, connections: this.server.connections().map((connection) => connection.info) }
  }

  extensionDir(): string {
    return this.extensionTarget
  }

  private rebind(connection: BridgeConnection): void {
    if (!connection.info.instanceId) return
    for (const session of this.sessions.values()) {
      if (session.connected) continue
      if (
        session.info.browser !== connection.info.browser
        || session.info.extensionId !== connection.info.extensionId
        || !session.info.instanceId
        || session.info.instanceId !== connection.info.instanceId
      ) continue
      session.rebind(connection)
      void session.pruneClosedTabs()
    }
  }

  pick(browser?: string): BridgeConnection {
    const connections = this.server.connections()
    const wanted = browser?.trim().toLowerCase()
    if (wanted && !BROWSERS.has(wanted as BridgeBrowser)) throw new UserBrowserError('invalid_browser', `--browser 只接受 chrome、edge 或 firefox，收到 ${browser}`)
    if (!connections.length) {
      throw new UserBrowserError(
        'user_browser_not_connected',
        `没有连上的用户浏览器。请用户在自己的浏览器里装好「砚 · 浏览器连接」扩展并保持浏览器打开：Chrome / Edge 打开扩展管理页（chrome://extensions 或 edge://extensions），开启开发者模式，「加载已解压的扩展」选 ${this.extensionTarget}；已装过旧版的，在扩展管理页点一次重新加载。Firefox 需要经 Mozilla 签名的扩展包。装好后再 connect-user。`
      )
    }
    const candidates = wanted ? connections.filter((connection) => connection.info.browser === wanted) : connections
    if (!candidates.length) {
      throw new UserBrowserError('user_browser_not_found', `没有连上的 ${wanted}；当前连着：${connections.map((connection) => browserLabel(connection.info)).join('、')}`)
    }
    const kinds = new Set(candidates.map((connection) => connection.info.browser))
    if (kinds.size > 1) {
      throw new UserBrowserError('user_browser_ambiguous', `连着多个浏览器（${candidates.map((connection) => browserLabel(connection.info)).join('、')}），用 --browser chrome|edge|firefox 指定`)
    }
    return candidates.reduce((latest, connection) => (connection.info.connectedAt > latest.info.connectedAt ? connection : latest))
  }

  attach(sessionId: string, connection: BridgeConnection): UserBrowserSession {
    const previous = this.sessions.get(sessionId)
    if (previous && previous.info.id === connection.info.id) return previous
    if (previous) void previous.release()
    const session = new UserBrowserSession(sessionId, connection)
    this.sessions.set(sessionId, session)
    return session
  }

  async detach(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.sessions.delete(sessionId)
    await session.release()
    return true
  }

  hostFor(sessionId: string): UserBrowserSession | undefined {
    return this.sessions.get(sessionId)
  }
}

export const userBrowser = new UserBrowserService()
