/**
 * 手机端的远程客户端：只和配对过的那台电脑说话。
 *
 * 协议定义在桌面仓库的 `src/shared/remote-protocol.ts`（类型导入，打包时被擦除）。
 * 三条纪律：
 *   · 每个请求带设备令牌；401 表示已被撤销，界面应回到配对页。
 *   · 写操作带幂等键：弱网重试时同一个键不会让电脑执行两次。
 *   · 事件流断线后带着最后收到的 seq 重连，服务端补发；收到 resync 时整体刷新。
 */
import type {
  RemoteAnswer,
  RemoteEventEnvelope,
  RemoteInfo,
  RemotePairResponse,
  RemotePendingQuestion,
  RemoteResyncEvent
} from '../../../src/shared/remote-protocol'
import type { RemoteImageInput, RemoteModel, RemoteDeviceSummary } from '../../../src/shared/remote-protocol'
import { HistoryCache } from '../historyCache'
import { bytesToUtf8, newClientKey, RelayError, RelayTunnel, toB64, type RelayConfig, type RelayPairing } from './relay'

export interface Connection {
  /** 例如 http://100.101.102.103:37892；经中继连接时为 relay://<电脑名> */
  baseUrl: string
  /** 经中继连接（不用 Tailscale）：中继地址、电脑主机公钥与本机私钥 */
  relay?: RelayConfig
  token: string
  deviceId: string
  computerName?: string
  deviceName?: string
}

export class RemoteHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'RemoteHttpError'
  }
}

/** 幂等键：RN 没有 crypto.randomUUID，用时间 + 随机数拼一个足够唯一的键 */
export function idempotencyKey(): string {
  const random = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('')
  return `m-${Date.now().toString(36)}-${random}`
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const match = /^(?:(https?):\/\/)?(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(trimmed)
  if (!match) return ''
  const scheme = (match[1] ?? 'http').toLowerCase()
  const port = match[3] ? Number(match[3]) : scheme === 'http' ? 37892 : 443
  if (port < 1 || port > 65535) return ''
  return `${scheme}://${match[2]}:${port}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

type Target = { baseUrl: string; relay?: RelayConfig }

async function request<T>(
  target: string | Target,
  path: string,
  init: { method?: 'GET' | 'POST'; token?: string; body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {}
): Promise<T> {
  const { baseUrl, relay } = typeof target === 'string' ? { baseUrl: target, relay: undefined } : target
  if (relay) return relayRequest<T>(relay, path, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (init.token) headers.authorization = `Bearer ${init.token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    })
    const json = await readJson(response)
    if (!response.ok || json.ok === false) {
      throw new RemoteHttpError(response.status, String(json.error ?? `请求失败（${response.status}）`), typeof json.code === 'string' ? json.code : undefined)
    }
    return json as T
  } catch (error) {
    if (error instanceof RemoteHttpError) throw error
    if ((error as { name?: string })?.name === 'AbortError') throw new RemoteHttpError(0, '连接超时：请确认电脑上的砚在运行、手机与电脑在同一个 Tailscale 网络里')
    throw new RemoteHttpError(0, '连不上电脑：请确认地址、端口，以及 Tailscale 已连接')
  } finally {
    clearTimeout(timer)
  }
}

function requestHeaders(init: { token?: string; body?: unknown; idempotencyKey?: string }): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey
  return headers
}

/** 经中继隧道发请求：语义与直连相同（状态码、错误、401）。 */
async function relayRequest<T>(
  relay: RelayConfig,
  path: string,
  init: { method?: 'GET' | 'POST'; token?: string; body?: unknown; idempotencyKey?: string; timeoutMs?: number }
): Promise<T> {
  try {
    const res = await RelayTunnel.for(relay).request(init.method ?? 'GET', path, {
      headers: requestHeaders(init),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      timeoutMs: init.timeoutMs ?? 20_000
    })
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(bytesToUtf8(res.body)) as Record<string, unknown>
    } catch {
      /* 非 JSON */
    }
    if (res.status < 200 || res.status >= 300 || json.ok === false) {
      throw new RemoteHttpError(res.status, String(json.error ?? `请求失败（${res.status}）`), typeof json.code === 'string' ? json.code : undefined)
    }
    return json as T
  } catch (error) {
    if (error instanceof RemoteHttpError) throw error
    throw new RemoteHttpError(0, error instanceof RelayError ? error.message : '经中继连不上电脑：请确认电脑上的砚在运行并开启了中继接入')
  }
}

/** 经中继配对：先用中继配对码完成加密隧道登记，再在隧道里用 6 位码换设备令牌。 */
export async function pairViaRelay(pairing: RelayPairing, deviceName: string): Promise<Connection> {
  const relay: RelayConfig = { join: pairing.join, hostKey: pairing.hostKey, clientKey: newClientKey() }
  const tunnel = RelayTunnel.for(relay, deviceName)
  try {
    await tunnel.connect(pairing.relayCode)
  } catch (error) {
    tunnel.close()
    throw new RemoteHttpError(0, error instanceof RelayError ? error.message : '经中继连不上电脑')
  }
  const target = { baseUrl: `relay://${pairing.computerName}`, relay }
  const result = await request<RemotePairResponse>(target, '/remote/v1/pair', { method: 'POST', body: { code: pairing.code, deviceName } })
  return { ...target, token: result.token, deviceId: result.deviceId, computerName: result.computer?.name ?? pairing.computerName, deviceName: result.device?.name ?? deviceName }
}

/** 配对：不需要令牌，用电脑上显示的 6 位码换一个设备令牌 */
export async function pair(baseUrl: string, code: string, deviceName: string): Promise<Connection> {
  const result = await request<RemotePairResponse>(baseUrl, '/remote/v1/pair', {
    method: 'POST',
    body: { code, deviceName }
  })
  return { baseUrl, token: result.token, deviceId: result.deviceId, computerName: result.computer?.name, deviceName: result.device?.name ?? deviceName }
}

export interface SessionListItem {
  id: string
  title: string
  cwdName?: string
  projectId?: string
  lastActivityAt?: number
  lastReply?: { id: string; at: number; text: string }
  lastOpenedAt?: number
  updatedAt: number
  messageCount: number
  model?: string
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'bashExecution' | string
  text?: string
  timestamp?: number
  error?: string
  images?: Array<{ mimeType: string }>
  toolCalls?: Array<{ id: string; name: string; status?: string }>
  artifacts?: Array<{ id: string; filename: string; mediaType: string; kind: string; bytes: number; unavailable?: boolean }>
}

export interface HistoryPage {
  messages: HistoryMessage[]
  truncated?: number | boolean
  total?: number
  hasMore?: boolean
  nextBefore?: string
}

export class RemoteClient {
  readonly historyCache = new HistoryCache()
  constructor(readonly connection: Connection) {}
  async hubSnapshot(): Promise<import('../../../src/shared/agent-hub').HubSnapshot> {
    return (await this.get<{ data: import('../../../src/shared/agent-hub').HubSnapshot }>('/remote/v1/hub')).data
  }
  async hubCommand(command: import('../../../src/shared/agent-hub').HubCommand, key = idempotencyKey()): Promise<unknown> {
    return (await this.post<{ data: unknown }>('/remote/v1/hub', command, key)).data
  }

  private get<T>(path: string): Promise<T> {
    return request<T>(this.connection, path, { token: this.connection.token })
  }

  private post<T>(path: string, body: unknown, key: string): Promise<T> {
    return request<T>(this.connection, path, { method: 'POST', token: this.connection.token, body, idempotencyKey: key })
  }

  info(): Promise<RemoteInfo> {
    return this.get<RemoteInfo>('/remote/v1/info')
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.get<{ data: Record<string, unknown> }>('/remote/v1/status')).data
  }

  async sessions(): Promise<SessionListItem[]> {
    const result = await this.get<{ data: { sessions: SessionListItem[] } }>('/remote/v1/sessions')
    return result.data.sessions
  }

  async history(sessionId: string, limit = 60, before?: string): Promise<HistoryPage> {
    const result = await this.get<{ data: HistoryPage }>(
      `/remote/v1/sessions/${encodeURIComponent(sessionId)}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`
    )
    return result.data
  }

  async questions(): Promise<RemotePendingQuestion[]> {
    return (await this.get<{ data: { questions: RemotePendingQuestion[] } }>('/remote/v1/questions')).data.questions
  }

  answer(questionId: string, answer: RemoteAnswer, key = idempotencyKey()): Promise<unknown> {
    return this.post(`/remote/v1/questions/${encodeURIComponent(questionId)}/answer`, answer, key)
  }

  send(sessionId: string, text: string, key = idempotencyKey(), images?: RemoteImageInput[]): Promise<unknown> {
    return this.post(`/remote/v1/sessions/${encodeURIComponent(sessionId)}/messages`, { text, images }, key)
  }

  async renameDevice(name: string): Promise<RemoteDeviceSummary> {
    return (await this.post<{ data: RemoteDeviceSummary }>('/remote/v1/device', { name }, idempotencyKey())).data
  }

  async models(sessionId: string): Promise<{ models: RemoteModel[]; current: RemoteModel | null }> {
    return (await this.get<{ data: { models: RemoteModel[]; current: RemoteModel | null } }>(`/remote/v1/sessions/${encodeURIComponent(sessionId)}/models`)).data
  }

  async setModel(sessionId: string, model: RemoteModel, key = idempotencyKey()): Promise<RemoteModel> {
    return (await this.post<{ data: { current: RemoteModel } }>(`/remote/v1/sessions/${encodeURIComponent(sessionId)}/model`, { provider: model.provider, modelId: model.id }, key)).data.current
  }

  imageSource(sessionId: string, messageId: string, index: number) {
    return { uri: `${this.connection.baseUrl}/remote/v1/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(messageId)}/${index}`, headers: { authorization: `Bearer ${this.connection.token}` } }
  }

  abort(runId: string, key = idempotencyKey()): Promise<unknown> {
    return this.post('/remote/v1/runs/abort', { runId }, key)
  }

  async newSession(key = idempotencyKey()): Promise<{ sessionId?: string }> {
    return (await this.post<{ data: { sessionId?: string } }>('/remote/v1/sessions/new', {}, key)).data
  }

  /** 成果文件的地址与请求头（图片直接交给 <Image source={{ uri, headers }}>） */
  artifactSource(sessionId: string, artifactId: string): { uri: string; headers: Record<string, string> } {
    return {
      uri: `${this.connection.baseUrl}/remote/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
      headers: { authorization: `Bearer ${this.connection.token}` }
    }
  }

  /**
   * 把图片 / 成果地址变成 <Image> 能用的来源：直连原样返回；经中继时先经隧道取字节，转成 data URI。
   */
  async resolveSource(source: { uri: string; headers: Record<string, string> }): Promise<{ uri: string; headers?: Record<string, string> }> {
    const relay = this.connection.relay
    if (!relay) return source
    const path = source.uri.slice(this.connection.baseUrl.length)
    const res = await RelayTunnel.for(relay).request('GET', path, { headers: source.headers, timeoutMs: 60_000 })
    if (res.status !== 200) throw new RemoteHttpError(res.status, '读取图片失败')
    return { uri: `data:${res.headers['content-type'] ?? 'application/octet-stream'};base64,${toB64(res.body)}` }
  }

  async artifactText(sessionId: string, artifactId: string): Promise<string> {
    const source = this.artifactSource(sessionId, artifactId)
    const relay = this.connection.relay
    if (relay) {
      const res = await RelayTunnel.for(relay).request('GET', source.uri.slice(this.connection.baseUrl.length), { headers: source.headers, timeoutMs: 60_000 })
      if (res.status !== 200) throw new RemoteHttpError(res.status, '读取成果失败')
      return bytesToUtf8(res.body)
    }
    const response = await fetch(source.uri, { headers: source.headers })
    if (!response.ok) {
      const json = await readJson(response)
      throw new RemoteHttpError(response.status, String(json.error ?? '读取成果失败'))
    }
    return response.text()
  }
}

/* ---------------------------------------------------------------- 事件流 */

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface EventStreamHandlers {
  onEvent(event: RemoteEventEnvelope): void
  /** 服务端补不齐（重启过或断线太久）：调用方重新拉快照、问题和当前会话历史 */
  onResync(event: RemoteResyncEvent): void
  onState(state: StreamState): void
  /** 401：令牌已被撤销 */
  onUnauthorized(): void
}

/**
 * SSE 客户端（基于 XMLHttpRequest 的增量 responseText）。
 *
 * 断线后指数退避重连（1s → 30s），每次都带 ?since=<最后收到的 seq>。
 * 电脑任务不会因为手机断线而停止；手机回来后补齐这期间的事件即可。
 */
export class RemoteEventStream {
  private xhr: XMLHttpRequest | null = null
  /** 经中继时的事件流取消函数 */
  private cancelRelay: (() => void) | null = null
  private lastSeq = 0
  private offset = 0
  private buffer = ''
  private retryMs = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly connection: Connection, private readonly handlers: EventStreamHandlers) {}

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.xhr?.abort()
    this.xhr = null
    this.cancelRelay?.()
    this.cancelRelay = null
    this.handlers.onState('closed')
  }

  private open(): void {
    this.handlers.onState(this.lastSeq > 0 ? 'reconnecting' : 'connecting')
    if (this.connection.relay) return this.openRelay(this.connection.relay)
    const xhr = new XMLHttpRequest()
    this.xhr = xhr
    this.offset = 0
    this.buffer = ''
    xhr.open('GET', `${this.connection.baseUrl}/remote/v1/events?since=${this.lastSeq}`)
    xhr.setRequestHeader('authorization', `Bearer ${this.connection.token}`)
    xhr.setRequestHeader('accept', 'text/event-stream')
    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
        if (xhr.status === 401) {
          this.stopped = true
          this.handlers.onUnauthorized()
          xhr.abort()
          return
        }
        if (xhr.status === 200) {
          this.retryMs = 1000
          this.handlers.onState('open')
        }
      }
      if (xhr.readyState === XMLHttpRequest.LOADING || xhr.readyState === XMLHttpRequest.DONE) this.consume(xhr.responseText)
      if (xhr.readyState === XMLHttpRequest.DONE) this.scheduleReconnect()
    }
    xhr.onerror = () => this.scheduleReconnect()
    xhr.send()
  }

  /** 经中继的事件流：隧道分块送来 SSE 文本，按同样的格式解析。 */
  private openRelay(relay: RelayConfig): void {
    this.buffer = ''
    let received = 0
    this.cancelRelay = RelayTunnel.for(relay).stream(`/remote/v1/events?since=${this.lastSeq}`, { authorization: `Bearer ${this.connection.token}`, accept: 'text/event-stream' }, {
      onStart: (status) => {
        if (status === 401) {
          this.stopped = true
          this.cancelRelay?.()
          this.handlers.onUnauthorized()
          return
        }
        if (status === 200) {
          this.retryMs = 1000
          this.handlers.onState('open')
        }
      },
      onChunk: (text) => {
        received += text.length
        this.consumeText(text)
        /* 与直连一致：长时间的流定期重连，避免无限累积 */
        if (received >= 1_000_000) {
          this.cancelRelay?.()
          this.cancelRelay = null
          this.scheduleReconnect()
        }
      },
      onEnd: () => {
        this.cancelRelay = null
        this.scheduleReconnect()
      }
    })
  }

  private consume(text: string): void {
    this.consumeText(text.slice(this.offset))
    this.offset = text.length
    /* RN 的 XHR 会保留整条 SSE 响应；定期重连，避免长任务持续占用内存。 */
    if (text.length >= 1_000_000) {
      this.xhr?.abort()
      this.scheduleReconnect()
    }
  }

  private consumeText(chunk: string): void {
    this.buffer += chunk
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      this.dispatch(block)
      boundary = this.buffer.indexOf('\n\n')
    }
  }

  private dispatch(block: string): void {
    let eventName = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    if (eventName === 'ready') return
    if (eventName === 'resync') {
      const resync = parsed as RemoteResyncEvent
      this.lastSeq = resync.latestSeq
      this.handlers.onResync(resync)
      return
    }
    const envelope = parsed as RemoteEventEnvelope
    if (typeof envelope.seq === 'number') {
      if (envelope.seq <= this.lastSeq) return
      this.lastSeq = envelope.seq
    }
    this.handlers.onEvent(envelope)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return
    this.xhr = null
    this.handlers.onState('reconnecting')
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, 30_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }
}
