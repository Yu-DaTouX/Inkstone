import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { MainPush } from '../shared/ipc'

/**
 * Yan 远程管理 API 的版本。
 *
 * 这是“手机管理电脑端客户端”的协议边界，不是 Electron 的 remote
 * debugging 接口。协议只允许显式列出的会话操作和状态订阅。
 */
export const REMOTE_API_VERSION = 1

export type RemoteCommand =
  | { action: 'select'; sessionId: string }
  | { action: 'new' }
  | { action: 'send'; sessionId?: string; text: string }
  | { action: 'abort' }
  | { action: 'rename'; sessionId: string; name: string }

export interface RemoteOperationResult {
  ok: boolean
  status?: number
  data?: unknown
  error?: string
}

export interface RemoteServerHandlers {
  /** 返回不含绝对会话路径、凭证和其它桌面私密字段的快照。 */
  snapshot(): Promise<unknown>
  /** 按稳定 sessionId 读取历史；路径解析留在主进程，不能由网络请求传入。 */
  history(sessionId: string, limit: number): Promise<RemoteOperationResult>
  /** 执行有限的远程会话操作。 */
  command(command: RemoteCommand): Promise<RemoteOperationResult>
}

export interface RemoteServerOptions {
  host: string
  port: number
  /** 未提供时每次启动生成一次性 token；不写入用户数据目录。 */
  token?: string
  handlers: RemoteServerHandlers
  onLog?: (text: string, level?: 'info' | 'error') => void
}

export interface RemoteServerInfo {
  host: string
  port: number
  token: string
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 20_000
const MAX_NAME_CHARS = 200
const SESSION_ID_MAX = 200

/*
 * 不把所有 MainPush 都转发给手机：browser-state、窗口坐标、UI 模态请求
 * 等是桌面专属或可能携带过多内容的事件。完整历史走受控的 history API。
 */
const REMOTE_CHANNELS = new Set([
  'msg-add',
  'msg-update',
  'msg-remove',
  'tool',
  'state',
  'stats',
  'queue',
  'todos',
  'session-title',
  'proc',
  'runners',
  'notify',
  'status'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clampHistoryLimit(value: string | null): number {
  const parsed = Number(value ?? 200)
  if (!Number.isFinite(parsed)) return 200
  return Math.min(500, Math.max(1, Math.floor(parsed)))
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= SESSION_ID_MAX && !/[\r\n]/.test(value)
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-yan-remote-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  })
  res.end(body)
}

function writeError(res: ServerResponse, status: number, error: string): void {
  writeJson(res, status, { ok: false, error })
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim()
  }
  const header = req.headers['x-yan-remote-token']
  return typeof header === 'string' ? header : undefined
}

function constantTimeEqual(expected: string, actual: string | undefined): boolean {
  if (!actual) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * 只读/命令 API 的本地 HTTP 服务。
 *
 * 默认由主进程不启动；启动策略在 index.ts 通过 YAN_REMOTE_ENABLE 控制。
 * 这样旧版本用户不会因为升级就突然多出一个网络监听端口。
 */
export class RemoteServer {
  private server: Server | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private readonly clients = new Set<ServerResponse>()
  private readonly token: string
  private boundPort: number

  constructor(private readonly options: RemoteServerOptions) {
    this.token = options.token?.trim() || randomUUID()
    if (this.token.length < 16) throw new Error('YAN_REMOTE_TOKEN 至少需要 16 个字符')
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error(`远程服务端口无效：${options.port}`)
    }
    this.boundPort = options.port
  }

  get info(): RemoteServerInfo {
    return { host: this.options.host, port: this.boundPort, token: this.token }
  }

  async start(): Promise<RemoteServerInfo> {
    if (this.server) return this.info

    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.log(`请求处理失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        if (!res.headersSent) writeError(res, 500, '远程请求处理失败')
        else res.destroy()
      })
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.options.port, this.options.host)
      })
    } catch (error) {
      this.server = null
      throw error
    }

    const address = server.address()
    if (address && typeof address === 'object') this.boundPort = address.port
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(': heartbeat\n\n')
        } catch {
          this.clients.delete(client)
        }
      }
    }, 25_000)
    this.heartbeat.unref()
    this.log(`远程管理服务已启动：${this.options.host}:${this.boundPort}`)
    return this.info
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        /* 客户端已断开 */
      }
    }
    this.clients.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** 将主进程的有限状态事件推给已认证的 Android 客户端。 */
  publish(message: MainPush): void {
    if (!this.server || !REMOTE_CHANNELS.has(message.ch)) return
    const envelope = JSON.stringify({
      at: Date.now(),
      channel: message.ch,
      payload: message.payload,
      ...(message.runtime ? { runtime: message.runtime } : {})
    })
    for (const client of this.clients) {
      try {
        client.write(`event: ${message.ch}\ndata: ${envelope}\n\n`)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  private log(text: string, level: 'info' | 'error' = 'info'): void {
    this.options.onLog?.(text, level)
  }

  private authorized(req: IncomingMessage): boolean {
    return constantTimeEqual(this.token, bearerToken(req))
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体超过 64KB 限制')
      chunks.push(part)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new Error('请求体必须是 JSON 对象')
    return parsed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.options.host}:${this.boundPort}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-yan-remote-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS'
      })
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/health') {
      writeJson(res, 200, { ok: true, apiVersion: REMOTE_API_VERSION })
      return
    }

    if (!this.authorized(req)) {
      writeError(res, 401, '需要有效的远程访问令牌')
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/info') {
      writeJson(res, 200, {
        ok: true,
        apiVersion: REMOTE_API_VERSION,
        transport: ['http', 'sse'],
        tokenRequired: true,
        capabilities: ['status', 'sessions', 'history', 'select', 'new', 'send', 'abort', 'rename']
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/status') {
      writeJson(res, 200, { ok: true, data: await this.options.handlers.snapshot() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/sessions') {
      const snapshot = await this.options.handlers.snapshot()
      const sessions = isRecord(snapshot) && Array.isArray(snapshot.sessions) ? snapshot.sessions : []
      writeJson(res, 200, { ok: true, data: { sessions } })
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/events') {
      await this.openEvents(res)
      return
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'remote' || parts[1] !== 'v1') {
      writeError(res, 404, '远程 API 路径不存在')
      return
    }

    if (req.method === 'GET' && parts.length === 4 && parts[2] === 'sessions') {
      const sessionId = decodeURIComponent(parts[3])
      if (!validSessionId(sessionId)) {
        writeError(res, 400, '会话 id 无效')
        return
      }
      const result = await this.options.handlers.history(sessionId, clampHistoryLimit(url.searchParams.get('limit')))
      this.writeOperation(res, result)
      return
    }

    if (parts[2] === 'sessions' && parts.length === 4 && parts[3] === 'new' && req.method === 'POST') {
      this.writeOperation(res, await this.options.handlers.command({ action: 'new' }))
      return
    }

    if (parts[2] === 'sessions' && parts.length === 5 && req.method === 'POST') {
      const sessionId = decodeURIComponent(parts[3])
      const operation = parts[4]
      if (!validSessionId(sessionId)) {
        writeError(res, 400, '会话 id 无效')
        return
      }
      const body = await this.readJson(req)
      if (operation === 'select') {
        this.writeOperation(res, await this.options.handlers.command({ action: 'select', sessionId }))
        return
      }
      if (operation === 'messages') {
        if (!validText(body.text, MAX_MESSAGE_CHARS)) {
          writeError(res, 400, '消息不能为空且不得超过 20,000 个字符')
          return
        }
        this.writeOperation(res, await this.options.handlers.command({ action: 'send', sessionId, text: body.text }))
        return
      }
      if (operation === 'rename') {
        if (!validText(body.name, MAX_NAME_CHARS)) {
          writeError(res, 400, '名称不能为空且不得超过 200 个字符')
          return
        }
        this.writeOperation(res, await this.options.handlers.command({ action: 'rename', sessionId, name: body.name.trim() }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/remote/v1/runs/abort') {
      this.writeOperation(res, await this.options.handlers.command({ action: 'abort' }))
      return
    }

    writeError(res, 404, '远程 API 路径不存在')
  }

  private writeOperation(res: ServerResponse, result: RemoteOperationResult): void {
    writeJson(res, result.status ?? (result.ok ? 200 : 400), result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error ?? '远程操作失败' })
  }

  private async openEvents(res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no'
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ apiVersion: REMOTE_API_VERSION, at: Date.now() })}\n\n`)
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }
}
