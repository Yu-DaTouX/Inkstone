import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebSocket, WebSocketServer } from 'ws'
import type { BridgeBrowser } from './native-host'

export const BRIDGE_PATH = '/browser-bridge'
export const DEFAULT_CALL_TIMEOUT_MS = 45_000
const HELLO_TIMEOUT_MS = 10_000
export const BRIDGE_REVISION = 4

export interface BridgeConnectionInfo {
  id: string
  browser: BridgeBrowser
  browserVersion: string
  extensionVersion: string
  extensionId: string
  instanceId: string
  debugger: boolean
  revision: number
  connectedAt: number
}

export class BridgeCallError extends Error {
  constructor(readonly code: string, message: string, readonly extra?: unknown) {
    super(message)
    this.name = 'BridgeCallError'
  }
}

export interface BridgeConnection {
  readonly info: BridgeConnectionInfo
  readonly open: boolean
  call<T = unknown>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  close(): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function browserOf(value: unknown): BridgeBrowser {
  return value === 'firefox' || value === 'edge' ? value : 'chrome'
}

class SocketConnection implements BridgeConnection {
  info: BridgeConnectionInfo
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(private readonly socket: WebSocket, hello: Record<string, unknown>) {
    this.info = {
      id: randomUUID(),
      browser: browserOf(hello.browser),
      browserVersion: String(hello.browserVersion ?? ''),
      extensionVersion: String(hello.version ?? ''),
      extensionId: String(hello.extensionId ?? ''),
      instanceId: typeof hello.instanceId === 'string' ? hello.instanceId.trim() : '',
      debugger: hello.debugger === true,
      revision: Number(hello.revision) || 0,
      connectedAt: Date.now()
    }
  }

  get open(): boolean {
    return !this.closed
  }

  call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new BridgeCallError('user_browser_disconnected', '用户浏览器已断开'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeCallError('user_browser_timeout', `用户浏览器 ${Math.round(timeoutMs / 1000)} 秒没有回应（${cmd}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, cmd, args }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BridgeCallError('user_browser_disconnected', error instanceof Error ? error.message : String(error)))
      }
    })
  }

  receive(message: Record<string, unknown>): void {
    const id = Number(message.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new BridgeCallError(String(message.code ?? 'EXTENSION_ERROR'), String(message.error ?? '扩展执行失败'), message.extra))
  }

  update(hello: Record<string, unknown>): void {
    this.info = { ...this.info, debugger: hello.debugger === true }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new BridgeCallError('user_browser_disconnected', '用户浏览器已断开'))
    }
    this.pending.clear()
  }

  close(): void {
    try { this.socket.close() } catch {}
    this.dispose()
  }
}

export interface BrowserBridgeEvents {
  connection: [BridgeConnection]
  disconnect: [BridgeConnection]
  tabRemoved: [BridgeConnection, number]
}

export class BrowserBridgeServer extends EventEmitter<BrowserBridgeEvents> {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private token = ''
  private readonly live = new Set<SocketConnection>()
  private discoveryPath = ''
  port = 0

  async start(dir: string): Promise<{ port: number }> {
    if (this.server) return { port: this.port }
    this.token = randomBytes(32).toString('hex')
    const { WebSocketServer: Server } = await import('ws')
    const wss = new Server({ noServer: true, maxPayload: 64 * 1024 * 1024 })
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const given = Buffer.from(url.searchParams.get('token') ?? '')
      const expected = Buffer.from(this.token)
      if (url.pathname !== BRIDGE_PATH || request.headers.origin || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
    this.wss = wss
    this.discoveryPath = join(dir, 'discovery.json')
    await writeFile(this.discoveryPath, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), { encoding: 'utf8', mode: 0o600 })
    return { port: this.port }
  }

  private accept(ws: WebSocket): void {
    let connection: SocketConnection | null = null
    const helloTimer = setTimeout(() => { if (!connection) ws.terminate() }, HELLO_TIMEOUT_MS)
    ws.on('message', (data) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>
      } catch {
        return
      }
      if (message.event === 'hello') {
        if (connection) {
          connection.update(message)
          return
        }
        clearTimeout(helloTimer)
        connection = new SocketConnection(ws, message)
        this.live.add(connection)
        this.emit('connection', connection)
        return
      }
      if (!connection) return
      if (message.event === 'tabRemoved') {
        const tabId = Number(message.tabId)
        if (Number.isInteger(tabId)) this.emit('tabRemoved', connection, tabId)
        return
      }
      connection.receive(message)
    })
    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (!connection) return
      const closing = connection
      connection = null
      closing.dispose()
      this.live.delete(closing)
      this.emit('disconnect', closing)
    })
    ws.on('error', () => undefined)
  }

  connections(): BridgeConnection[] {
    return [...this.live].filter((connection) => connection.open)
  }

  async stop(): Promise<void> {
    for (const connection of this.live) connection.close()
    this.live.clear()
    this.wss?.close()
    this.wss = null
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.discoveryPath) {
      const current = await readFile(this.discoveryPath, 'utf8').catch(() => '')
      if (current.includes(`"pid":${process.pid}`)) await rm(this.discoveryPath, { force: true })
    }
  }
}
