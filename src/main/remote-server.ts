import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { MainPush } from '../shared/ipc'
import {
  REMOTE_EVENT_BUFFER,
  REMOTE_IDEMPOTENCY_HEADER,
  REMOTE_IDEMPOTENCY_KEY_RE,
  REMOTE_IDEMPOTENCY_TTL_MS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteAnswer,
  type RemoteDeviceSummary,
  type RemoteEventEnvelope,
  type RemotePendingQuestion
} from '../shared/remote-protocol'
import type { RemoteDeviceStore } from './remote-devices'

/**
 * 砚远程管理服务（电脑 ↔ 手机）。协议定义见 `src/shared/remote-protocol.ts`。
 *
 * 这是「手机查看与参与电脑上的任务」的协议边界，不是 Electron 的远程调试接口：
 * 只允许显式列出的会话操作、问题回答与成果读取；任务始终在电脑上执行。
 */
export const REMOTE_API_VERSION = REMOTE_PROTOCOL_VERSION

export type RemoteCommand =
  | { action: 'select'; sessionId: string }
  | { action: 'new' }
  | { action: 'send'; sessionId: string; text: string }
  | { action: 'abort'; runId: string }
  | { action: 'rename'; sessionId: string; name: string }

export interface RemoteOperationResult {
  ok: boolean
  status?: number
  data?: unknown
  error?: string
  code?: string
}

export interface RemoteArtifactFile {
  path: string
  mediaType: string
  bytes: number
  filename: string
}

export interface RemoteServerHandlers {
  /** 返回不含绝对会话路径、凭证和其它桌面私密字段的快照。 */
  snapshot(): Promise<unknown>
  /** 按稳定 sessionId 读取历史；路径解析留在主进程，不能由网络请求传入。 */
  history(sessionId: string, limit: number): Promise<RemoteOperationResult>
  /** 执行有限的远程会话操作。 */
  command(command: RemoteCommand): Promise<RemoteOperationResult>
  /** 当前等待回答的问题（没有实现时远程端看不到问题） */
  questions?(): Promise<RemotePendingQuestion[]>
  /** 回答一个问题；敏感确认由实现方拒绝（需要在电脑上处理） */
  answer?(questionId: string, answer: RemoteAnswer): Promise<RemoteOperationResult>
  /** 按会话 + 成果 id 找到受管文件（实现方负责核对归属，网络请求不能传路径） */
  artifact?(sessionId: string, artifactId: string): Promise<RemoteArtifactFile | RemoteOperationResult>
}

export interface RemoteServerOptions {
  host: string
  port: number
  /**
   * 旧版一次性令牌（YAN_REMOTE_TOKEN）。提供了设备表时可以不给，
   * 此时只接受配对得到的设备令牌。
   */
  token?: string
  /** 手机配对与设备令牌；不提供时退回 v1 的单令牌模式 */
  devices?: RemoteDeviceStore
  handlers: RemoteServerHandlers
  onLog?: (text: string, level?: 'info' | 'error') => void
}

export interface RemoteServerInfo {
  host: string
  port: number
  /** 旧版单令牌；只用设备令牌时为 null */
  token: string | null
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 20_000
const MAX_NAME_CHARS = 200
const SESSION_ID_MAX = 200
const PAIR_RATE_WINDOW_MS = 60_000
const PAIR_RATE_LIMIT = 10
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': `authorization, content-type, x-yan-remote-token, ${REMOTE_IDEMPOTENCY_HEADER}`,
  'access-control-allow-methods': 'GET, POST, OPTIONS'
}

/*
 * 不把所有 MainPush 都转发给手机：browser-state、窗口坐标等是桌面专属或可能携带过多内容的事件。
 * 完整历史走受控的 history API；问题（ui-request / ui-deadline）转发，回答走 answer API。
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
  'status',
  'ui-request',
  'ui-deadline',
  'ui-resolved'
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

/** RunnerRegistry 的公开 runId 形状；中止必须明确指向一个实例。 */
function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^r[1-9]\d{0,8}$/.test(value)
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validQuestionId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(value)
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...CORS_HEADERS
  })
  res.end(body)
}

function writeError(res: ServerResponse, status: number, error: string, code?: string): void {
  writeJson(res, status, { ok: false, error, ...(code ? { code } : {}) })
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

/** 解析一次请求的身份：旧版单令牌（device=null）或已配对设备 */
type Caller = { device: RemoteDeviceSummary | null }

/**
 * 只读/命令 API 的 HTTP + SSE 服务。
 *
 * 默认不启动：在设置里开启手机接入（或旧的 YAN_REMOTE_ENABLE 环境变量）后才监听。
 * 这样旧版本用户不会因为升级就突然多出一个网络监听端口。
 */
export class RemoteServer {
  private server: Server | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private readonly clients = new Set<ServerResponse>()
  private readonly token: string | null
  private boundPort: number
  /** 事件缓冲：断线重连时按 seq 补发 */
  private seq = 0
  private readonly buffer: RemoteEventEnvelope[] = []
  /** 幂等键 → 结果（有效期内同一键只执行一次；执行中的请求共享同一个 Promise） */
  private readonly idempotency = new Map<string, { at: number; result: Promise<RemoteOperationResult> }>()
  private pairAttempts: number[] = []

  constructor(private readonly options: RemoteServerOptions) {
    const explicit = options.token?.trim()
    this.token = explicit || (options.devices ? null : randomUUID())
    if (this.token !== null && this.token.length < 16) throw new Error('YAN_REMOTE_TOKEN 至少需要 16 个字符')
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error(`远程服务端口无效：${options.port}`)
    }
    this.boundPort = options.port
  }

  get info(): RemoteServerInfo {
    return { host: this.options.host, port: this.boundPort, token: this.token }
  }

  get running(): boolean {
    return this.server !== null
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
      this.pruneIdempotency()
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

  /** 撤销设备后立即断开它的事件流（其它设备不受影响） */
  disconnectDevice(deviceId: string): void {
    for (const client of this.clients) {
      if ((client as ServerResponse & { yanDeviceId?: string }).yanDeviceId === deviceId) {
        try { client.end() } catch { /* 已断开 */ }
        this.clients.delete(client)
      }
    }
  }

  /** 将主进程的有限状态事件推给已认证的手机客户端，并留在缓冲里供重连补发。 */
  publish(message: MainPush): void {
    if (!REMOTE_CHANNELS.has(message.ch)) return
    const envelope: RemoteEventEnvelope = {
      seq: ++this.seq,
      at: Date.now(),
      channel: message.ch,
      payload: message.payload,
      ...(message.runtime ? { runtime: message.runtime } : {})
    }
    this.buffer.push(envelope)
    if (this.buffer.length > REMOTE_EVENT_BUFFER) this.buffer.splice(0, this.buffer.length - REMOTE_EVENT_BUFFER)
    if (!this.server) return
    for (const client of this.clients) this.writeEvent(client, envelope)
  }

  private writeEvent(client: ServerResponse, envelope: RemoteEventEnvelope): void {
    try {
      client.write(`id: ${envelope.seq}\nevent: ${envelope.channel}\ndata: ${JSON.stringify(envelope)}\n\n`)
    } catch {
      this.clients.delete(client)
    }
  }

  private log(text: string, level: 'info' | 'error' = 'info'): void {
    this.options.onLog?.(text, level)
  }

  private async authorize(req: IncomingMessage): Promise<Caller | null> {
    const presented = bearerToken(req)
    if (this.token !== null && constantTimeEqual(this.token, presented)) return { device: null }
    if (this.options.devices && presented) {
      const device = await this.options.devices.authenticate(presented)
      if (device) return { device }
    }
    return null
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

  private pruneIdempotency(): void {
    const cutoff = Date.now() - REMOTE_IDEMPOTENCY_TTL_MS
    for (const [key, entry] of this.idempotency) if (entry.at < cutoff) this.idempotency.delete(key)
  }

  /**
   * 写操作的幂等执行。
   *
   * 手机在弱网下会重试：同一幂等键（按调用方隔离）在有效期内只执行一次，
   * 重试拿到的是第一次的结果。没带键的旧客户端照常执行（required=true 的新接口必须带）。
   */
  private async idempotent(
    req: IncomingMessage,
    res: ServerResponse,
    caller: Caller,
    required: boolean,
    run: () => Promise<RemoteOperationResult>
  ): Promise<void> {
    const header = req.headers[REMOTE_IDEMPOTENCY_HEADER]
    const key = typeof header === 'string' ? header.trim() : ''
    if (!key) {
      if (required) {
        writeError(res, 400, `这个操作需要 ${REMOTE_IDEMPOTENCY_HEADER} 请求头`, 'idempotency_key_required')
        return
      }
      this.writeOperation(res, await run())
      return
    }
    if (!REMOTE_IDEMPOTENCY_KEY_RE.test(key)) {
      writeError(res, 400, '幂等键格式无效', 'idempotency_key_invalid')
      return
    }
    this.pruneIdempotency()
    const scoped = `${caller.device?.id ?? 'legacy'}:${req.method}:${new URL(req.url ?? '/', 'http://x').pathname}:${key}`
    const existing = this.idempotency.get(scoped)
    if (existing) {
      const result = await existing.result
      this.writeOperation(res, result, true)
      return
    }
    const result = run().catch((error: unknown): RemoteOperationResult => ({
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : '远程操作失败'
    }))
    this.idempotency.set(scoped, { at: Date.now(), result })
    this.writeOperation(res, await result)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.options.host}:${this.boundPort}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/health') {
      writeJson(res, 200, { ok: true, apiVersion: REMOTE_API_VERSION })
      return
    }

    /* 配对：不需要令牌，但需要电脑上当前显示的配对码；按分钟限速 */
    if (req.method === 'POST' && url.pathname === '/remote/v1/pair') {
      await this.pair(req, res)
      return
    }

    const caller = await this.authorize(req)
    if (!caller) {
      writeError(res, 401, '需要有效的远程访问令牌', 'unauthorized')
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/info') {
      writeJson(res, 200, {
        ok: true,
        apiVersion: REMOTE_API_VERSION,
        transport: ['http', 'sse'],
        tokenRequired: true,
        capabilities: [
          'status', 'sessions', 'history', 'select', 'new', 'send', 'abort', 'rename',
          'events-resume', 'idempotency',
          ...(this.options.handlers.questions ? ['questions'] : []),
          ...(this.options.handlers.answer ? ['answer'] : []),
          ...(this.options.handlers.artifact ? ['artifacts'] : [])
        ],
        device: caller.device
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
      await this.openEvents(req, res, caller, url.searchParams.get('since'))
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/questions') {
      const questions = this.options.handlers.questions ? await this.options.handlers.questions() : []
      writeJson(res, 200, { ok: true, data: { questions } })
      return
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'remote' || parts[1] !== 'v1') {
      writeError(res, 404, '远程 API 路径不存在')
      return
    }

    if (req.method === 'POST' && parts.length === 5 && parts[2] === 'questions' && parts[4] === 'answer') {
      await this.answer(req, res, caller, decodeURIComponent(parts[3]))
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

    if (req.method === 'GET' && parts.length === 6 && parts[2] === 'sessions' && parts[4] === 'artifacts') {
      await this.artifact(res, decodeURIComponent(parts[3]), decodeURIComponent(parts[5]))
      return
    }

    if (parts[2] === 'sessions' && parts.length === 4 && parts[3] === 'new' && req.method === 'POST') {
      await this.idempotent(req, res, caller, false, () => this.options.handlers.command({ action: 'new' }))
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
        const text = body.text
        await this.idempotent(req, res, caller, false, () => this.options.handlers.command({ action: 'send', sessionId, text }))
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
      const body = await this.readJson(req)
      if (!validRunId(body.runId)) {
        writeError(res, 400, '中止操作必须提供有效的目标 runId')
        return
      }
      const runId = body.runId
      await this.idempotent(req, res, caller, false, () => this.options.handlers.command({ action: 'abort', runId }))
      return
    }

    writeError(res, 404, '远程 API 路径不存在')
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.options.devices) {
      writeError(res, 404, '这台电脑没有开启手机配对', 'pairing_disabled')
      return
    }
    const now = Date.now()
    this.pairAttempts = this.pairAttempts.filter((at) => now - at < PAIR_RATE_WINDOW_MS)
    if (this.pairAttempts.length >= PAIR_RATE_LIMIT) {
      writeError(res, 429, '配对尝试过于频繁，请稍后再试', 'rate_limited')
      return
    }
    this.pairAttempts.push(now)
    const body = await this.readJson(req)
    const result = await this.options.devices.pair(body.code, body.deviceName)
    if (!result.ok) {
      const message = {
        no_pairing: '电脑上没有正在进行的配对，请先在砚的设置里生成配对码',
        expired: '配对码已过期，请在电脑上重新生成',
        invalid_code: '配对码不正确',
        too_many_attempts: '输错次数过多，这个配对码已作废，请在电脑上重新生成',
        device_limit: '已配对的设备太多，请先在电脑上撤销不用的设备'
      }[result.error]
      writeError(res, result.error === 'device_limit' ? 409 : 403, message, result.error)
      return
    }
    this.log(`新设备已配对：${result.device.name}`)
    writeJson(res, 200, { ok: true, deviceId: result.device.id, token: result.token, apiVersion: REMOTE_API_VERSION })
  }

  private async answer(req: IncomingMessage, res: ServerResponse, caller: Caller, questionId: string): Promise<void> {
    if (!this.options.handlers.answer) {
      writeError(res, 404, '这台电脑不支持远程回答问题')
      return
    }
    if (!validQuestionId(questionId)) {
      writeError(res, 400, '问题 id 无效')
      return
    }
    const body = await this.readJson(req)
    let answer: RemoteAnswer
    if (body.cancelled === true) answer = { cancelled: true }
    else if (typeof body.confirmed === 'boolean') answer = { confirmed: body.confirmed }
    else if (typeof body.value === 'string' && body.value.length <= MAX_MESSAGE_CHARS) answer = { value: body.value }
    else {
      writeError(res, 400, '回答需要 value、confirmed 或 cancelled 之一')
      return
    }
    const handler = this.options.handlers.answer
    await this.idempotent(req, res, caller, true, () => handler(questionId, answer))
  }

  private async artifact(res: ServerResponse, sessionId: string, artifactId: string): Promise<void> {
    if (!this.options.handlers.artifact) {
      writeError(res, 404, '这台电脑不支持远程读取成果')
      return
    }
    if (!validSessionId(sessionId) || !/^[A-Za-z0-9._-]{1,200}$/.test(artifactId)) {
      writeError(res, 400, '成果 id 无效')
      return
    }
    const found = await this.options.handlers.artifact(sessionId, artifactId)
    if ('ok' in found) {
      this.writeOperation(res, found)
      return
    }
    res.writeHead(200, {
      'content-type': found.mediaType || 'application/octet-stream',
      'content-length': found.bytes,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
      'cache-control': 'no-store',
      ...CORS_HEADERS
    })
    const stream = createReadStream(found.path)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  private writeOperation(res: ServerResponse, result: RemoteOperationResult, replayed = false): void {
    writeJson(
      res,
      result.status ?? (result.ok ? 200 : 400),
      result.ok
        ? { ok: true, data: result.data, ...(replayed ? { replayed: true } : {}) }
        : { ok: false, error: result.error ?? '远程操作失败', ...(result.code ? { code: result.code } : {}) }
    )
  }

  private async openEvents(req: IncomingMessage, res: ServerResponse, caller: Caller, sinceRaw: string | null): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no'
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ apiVersion: REMOTE_API_VERSION, at: Date.now(), latestSeq: this.seq })}\n\n`)
    /* 断线补齐：优先用 ?since=，其次 SSE 标准的 Last-Event-ID */
    const lastEventId = req.headers['last-event-id']
    const since = Number(sinceRaw ?? (typeof lastEventId === 'string' ? lastEventId : NaN))
    if (Number.isSafeInteger(since) && since >= 0) {
      const oldest = this.buffer[0]?.seq ?? this.seq + 1
      if (since > this.seq) {
        /* 客户端的序号比服务端还新：服务端重启过，序号已经重新开始 */
        res.write(`event: resync\ndata: ${JSON.stringify({ reason: 'server_restarted', latestSeq: this.seq })}\n\n`)
      } else if (since < oldest - 1) {
        res.write(`event: resync\ndata: ${JSON.stringify({ reason: 'buffer_overflow', latestSeq: this.seq })}\n\n`)
      } else {
        for (const envelope of this.buffer) if (envelope.seq > since) this.writeEvent(res, envelope)
      }
    }
    ;(res as ServerResponse & { yanDeviceId?: string }).yanDeviceId = caller.device?.id
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }
}
