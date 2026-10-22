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
  baseUrl: string
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

export function idempotencyKey(): string {
  const random = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('')
  return `m-${Date.now().toString(36)}-${random}`
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
  try {
    const result = await request<RemotePairResponse>(target, '/remote/v1/pair', { method: 'POST', body: { code: pairing.code, deviceName } })
    return { ...target, token: result.token, deviceId: result.deviceId, computerName: result.computer?.name ?? pairing.computerName, deviceName: result.device?.name ?? deviceName }
  } catch (error) {
    tunnel.close()
    throw error
  }
}

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
  toolCalls?: Array<{ id: string; name: string; status?: string; denied?: boolean }>
  artifacts?: Array<{ id: string; filename: string; mediaType: string; kind: string; bytes: number; version?: number; unavailable?: boolean }>
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

  async revokeSelf(): Promise<void> {
    await this.post('/remote/v1/devices/self/revoke', {}, idempotencyKey())
  }

  async renameDevice(name: string): Promise<RemoteDeviceSummary> {
    return (await this.post<{ data: RemoteDeviceSummary }>('/remote/v1/device', { name }, idempotencyKey())).data
  }

  async models(sessionId: string): Promise<{ models: RemoteModel[]; current: RemoteModel | null; thinking?: { level: string; levels: string[] } | null }> {
    return (await this.get<{ data: { models: RemoteModel[]; current: RemoteModel | null; thinking?: { level: string; levels: string[] } | null } }>(`/remote/v1/sessions/${encodeURIComponent(sessionId)}/models`)).data
  }

  async setModel(sessionId: string, model: RemoteModel, key = idempotencyKey()): Promise<RemoteModel> {
    return (await this.post<{ data: { current: RemoteModel } }>(`/remote/v1/sessions/${encodeURIComponent(sessionId)}/model`, { provider: model.provider, modelId: model.id }, key)).data.current
  }

  async setThinking(sessionId: string, level: string, key = idempotencyKey()): Promise<string> {
    return (await this.post<{ data: { level: string } }>(`/remote/v1/sessions/${encodeURIComponent(sessionId)}/thinking`, { level }, key)).data.level
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

  artifactSource(sessionId: string, artifactId: string): { uri: string; headers: Record<string, string> } {
    return {
      uri: `${this.connection.baseUrl}/remote/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
      headers: { authorization: `Bearer ${this.connection.token}` }
    }
  }

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
    const maxBytes = 2 * 1024 * 1024
    if (relay) {
      const res = await RelayTunnel.for(relay).request('GET', source.uri.slice(this.connection.baseUrl.length), { headers: source.headers, timeoutMs: 60_000 })
      if (res.status !== 200) throw new RemoteHttpError(res.status, '读取成果失败')
      if (res.body.byteLength > maxBytes) throw new RemoteHttpError(res.status, '成果文本超过 2 MiB，无法在手机端预览')
      return bytesToUtf8(res.body)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    let response: Response
    try { response = await fetch(source.uri, { headers: source.headers, signal: controller.signal }) }
    catch (error) {
      clearTimeout(timer)
      if ((error as { name?: string })?.name === 'AbortError') throw new RemoteHttpError(0, '读取成果超时')
      throw error
    }
    try {
    if (!response.ok) {
      const json = await readJson(response)
      throw new RemoteHttpError(response.status, String(json.error ?? '读取成果失败'))
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new RemoteHttpError(response.status, '成果文本超过 2 MiB，无法在手机端预览')
    const body = (response as Response & { body?: { getReader(): {
      read(): Promise<{ done: boolean; value: Uint8Array }>
      cancel(): Promise<void>
      releaseLock(): void
    } } }).body
    if (!body) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxBytes) throw new RemoteHttpError(response.status, '成果文本超过 2 MiB，无法在手机端预览')
      return bytesToUtf8(bytes)
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) { await reader.cancel(); throw new RemoteHttpError(response.status, '成果文本超过 2 MiB，无法在手机端预览') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytesToUtf8(bytes)
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw new RemoteHttpError(0, '读取成果超时')
      throw error
    } finally { clearTimeout(timer) }
  }
}

export type StreamState = 'connecting' | 'open' | 'reconnecting'

export interface EventStreamHandlers {
  onEvent(event: RemoteEventEnvelope): void
  onResync(event: RemoteResyncEvent): void
  onState(state: StreamState): void
  onUnauthorized(): void
}

export class RemoteEventStream {
  private xhr: XMLHttpRequest | null = null
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
  }

  private rotating = false

  private open(): void {
    if (this.stopped) return
    if (this.rotating) this.rotating = false
    else this.handlers.onState(this.lastSeq > 0 ? 'reconnecting' : 'connecting')
    if (this.connection.relay) return this.openRelay(this.connection.relay)
    const xhr = new XMLHttpRequest()
    this.xhr = xhr
    this.offset = 0
    this.buffer = ''
    xhr.open('GET', `${this.connection.baseUrl}/remote/v1/events?since=${this.lastSeq}`)
    xhr.setRequestHeader('authorization', `Bearer ${this.connection.token}`)
    xhr.setRequestHeader('accept', 'text/event-stream')
    xhr.onreadystatechange = () => {
      if (this.stopped) return
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
    xhr.onerror = () => { if (!this.stopped) this.scheduleReconnect() }
    xhr.send()
  }

  private openRelay(relay: RelayConfig): void {
    this.buffer = ''
    let received = 0
    this.cancelRelay = RelayTunnel.for(relay).stream(`/remote/v1/events?since=${this.lastSeq}`, { authorization: `Bearer ${this.connection.token}`, accept: 'text/event-stream' }, {
      onStart: (status) => {
        if (this.stopped) return
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
        if (this.stopped) return
        received += text.length
        this.consumeText(text)
        if (!this.stopped && received >= 1_000_000) {
          this.rotating = true
          this.cancelRelay?.()
          this.cancelRelay = null
          this.rotate()
        }
      },
      onEnd: () => {
        this.cancelRelay = null
        if (this.stopped || this.rotating) return
        this.scheduleReconnect()
      }
    })
  }

  private consume(text: string): void {
    if (this.stopped) return
    this.consumeText(text.slice(this.offset))
    this.offset = text.length
    if (text.length >= 1_000_000) {
      const xhr = this.xhr
      this.rotate()
      xhr?.abort()
    }
  }

  private rotate(): void {
    if (this.stopped || this.retryTimer) return
    this.xhr = null
    this.rotating = true
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.open()
    }, 0)
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
    if (this.stopped) return
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
