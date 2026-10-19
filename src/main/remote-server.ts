import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import { negotiateCapabilities } from '../shared/capability-negotiation'
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
import type { RemoteHumanApproval } from '../shared/remote-protocol'
import type { RemoteImageInput } from '../shared/remote-protocol'
import type { RemoteDeviceStore } from './remote-devices'
import { PEER_CONNECTION_HEADER, PEER_OPERATIONS, type PeerOperation, type PeerProjectRef } from '../shared/peer-protocol'
import type { PeerGrantRegistry } from './peer-grants'
import type { PeerCollabHost, PeerCollabReply } from './collab/host'

export const REMOTE_API_VERSION = REMOTE_PROTOCOL_VERSION

export type RemoteCommand =
  | { action: 'select'; sessionId: string }
  | { action: 'new' }
  | { action: 'send'; sessionId: string; text: string; images?: RemoteImageInput[] }
  | { action: 'model'; sessionId: string; provider: string; modelId: string }
  | { action: 'thinking'; sessionId: string; level: string }
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
  snapshot(): Promise<unknown>
  history(sessionId: string, limit: number, before?: string): Promise<RemoteOperationResult>
  models?(sessionId: string): Promise<RemoteOperationResult>
  image?(sessionId: string, messageId: string, index: number): Promise<RemoteArtifactFile | RemoteOperationResult>
  command(command: RemoteCommand): Promise<RemoteOperationResult>
  questions?(): Promise<RemotePendingQuestion[]>
  answer?(questionId: string, answer: RemoteAnswer): Promise<RemoteOperationResult>
  humanApproval?(questionId: string, answer: RemoteHumanApproval): Promise<RemoteOperationResult>
  artifact?(sessionId: string, artifactId: string): Promise<RemoteArtifactFile | RemoteOperationResult>
}

export interface PeerHostHandlers {
  projects(): Promise<PeerProjectRef[]>
  sessions(projectIds: string[]): Promise<unknown[]>
  projectOfSession(sessionId: string): Promise<string | null>
  projectOfRun(runId: string): Promise<string | null>
  exportSession(sessionId: string): Promise<RemoteOperationResult>
  startSession(projectId: string, text: string): Promise<RemoteOperationResult>
  collab?: PeerCollabHost
}

export interface RemoteServerOptions {
  host: string
  port: number
  token?: string
  devices?: RemoteDeviceStore
  handlers: RemoteServerHandlers
  peers?: { grants: PeerGrantRegistry; handlers: PeerHostHandlers }
  onLog?: (text: string, level?: 'info' | 'error') => void
  relayToken?: string
}


export interface RemoteServerInfo {
  host: string
  port: number
  token: string | null
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 20_000
const MAX_NAME_CHARS = 200
const SESSION_ID_MAX = 200
const PAIR_RATE_WINDOW_MS = 60_000
const PAIR_RATE_LIMIT = 10
const CORS_HEADERS = {
  'access-control-allow-headers': `authorization, content-type, x-yan-remote-token, ${REMOTE_IDEMPOTENCY_HEADER}`,
  'access-control-allow-methods': 'GET, POST, OPTIONS'
}

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
  'ui-resolved',
  'approval',
  'approval-close'
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

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^r[1-9]\d{0,8}$/.test(value)
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

export function validateRemoteImages(value: unknown): RemoteImageInput[] | null {
  if (!Array.isArray(value) || value.length > 4) return null
  const images: RemoteImageInput[] = []
  for (const item of value) {
    if (!isRecord(item) || !['image/jpeg', 'image/png', 'image/webp'].includes(String(item.mimeType)) || typeof item.data !== 'string') return null
    if (!item.data || item.data.length > 2_796_204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4 !== 0) return null
    const bytes = Buffer.from(item.data, 'base64')
    if (bytes.length > 2 * 1024 * 1024) return null
    const valid = item.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : item.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!valid) return null
    images.push({ mimeType: item.mimeType as RemoteImageInput['mimeType'], data: item.data })
  }
  return images
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

type Caller = { device: RemoteDeviceSummary | null }

export class RemoteServer {
  private server: Server | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private readonly clients = new Set<ServerResponse>()
  private readonly peerClients = new Map<string, ServerResponse>()
  private readonly token: string | null
  private boundPort: number
  private seq = 0
  private readonly buffer: RemoteEventEnvelope[] = []
  private bufferBytes = 0
  private readonly eventFrames = new WeakMap<RemoteEventEnvelope, { text: string; bytes: number }>()
  private readonly idempotency = new Map<string, { at: number; result: Promise<RemoteOperationResult> }>()
  private pairAttempts: number[] = []
  private readonly pairAttemptsBySource = new Map<string, number[]>()

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
      for (const client of [...this.clients, ...this.peerClients.values()]) {
        this.writeSse(client, ': heartbeat\n\n')
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
      }
    }
    this.clients.clear()
    for (const client of this.peerClients.values()) {
      try { client.end() } catch { }
    }
    this.peerClients.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  disconnectConnection(connectionId: string): void {
    const client = this.peerClients.get(connectionId)
    if (!client) return
    this.peerClients.delete(connectionId)
    try { client.end() } catch { }
  }

  disconnectDevice(deviceId: string): void {
    this.options.peers?.grants.revokeDevice(deviceId)
    for (const client of this.clients) {
      if ((client as ServerResponse & { yanDeviceId?: string }).yanDeviceId === deviceId) {
        try { client.end() } catch { }
        this.clients.delete(client)
      }
    }
  }

  publish(message: MainPush): void {
    if (!REMOTE_CHANNELS.has(message.ch)) return
    const envelope: RemoteEventEnvelope = {
      seq: ++this.seq,
      at: Date.now(),
      channel: message.ch,
      payload: message.payload,
      ...(message.runtime ? { runtime: message.runtime } : {})
    }
    const text = `id: ${envelope.seq}\nevent: ${envelope.channel}\ndata: ${JSON.stringify(envelope)}\n\n`
    const bytes = Buffer.byteLength(text)
    this.eventFrames.set(envelope, { text, bytes })
    this.buffer.push(envelope)
    this.bufferBytes += bytes
    while (this.buffer.length > REMOTE_EVENT_BUFFER || this.bufferBytes > 8 * 1024 * 1024) {
      const removed = this.buffer.shift()!
      this.bufferBytes -= this.eventFrames.get(removed)!.bytes
    }
    if (!this.server) return
    for (const client of this.clients) this.writeEvent(client, envelope)
  }

  private writeSse(client: ServerResponse, text: string): boolean {
    try {
      if (client.destroyed || client.writableEnded || client.writableLength + Buffer.byteLength(text) > 4 * 1024 * 1024) {
        throw new Error('SSE client exceeded queue budget')
      }
      client.write(text)
      return true
    } catch {
      this.clients.delete(client)
      for (const [id, response] of this.peerClients) if (response === client) this.peerClients.delete(id)
      client.destroy()
      return false
    }
  }

  private writeEvent(client: ServerResponse, envelope: RemoteEventEnvelope): boolean {
    return this.writeSse(client, this.eventFrames.get(envelope)?.text ??
      `id: ${envelope.seq}\nevent: ${envelope.channel}\ndata: ${JSON.stringify(envelope)}\n\n`)
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

  private async readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > maxBytes) throw new Error('请求体超过大小限制')
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
    const origin = req.headers.origin
    if (origin) {
      let allowed = false
      try { const incoming = new URL(origin); allowed = ['http:', 'https:'].includes(incoming.protocol) && incoming.host === req.headers.host } catch { }
      if (!allowed) { writeError(res, 403, '网页来源不受允许'); return }
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
    }
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

    if (req.method === 'POST' && url.pathname === '/remote/v1/pair') {
      await this.pair(req, res)
      return
    }

    const caller = await this.authorize(req)
    if (!caller) {
      writeError(res, 401, '需要有效的远程访问令牌', 'unauthorized')
      return
    }

    if (req.method === 'POST' && url.pathname === '/remote/v1/devices/self/revoke') {
      if (!caller.device || (caller.device.kind ?? 'phone') !== 'phone' || !this.options.devices) return writeError(res, 403, '需要配对手机令牌')
      await this.readJson(req)
      const revoked = await this.options.devices.revoke(caller.device.id)
      writeJson(res, revoked ? 200 : 404, revoked ? { ok: true } : { ok: false, error: '设备已撤销' })
      if (revoked) this.disconnectDevice(caller.device.id)
      return
    }

    const isAgent = caller.device?.kind === 'agent'
    if (isAgent && !(req.method === 'GET' && url.pathname === '/remote/v1/info')) {
      return writeError(res, 403, 'Agent Hub 已退役，礁石令牌不能再操作这台电脑', 'agent_scope')
    }

    const isPeer = caller.device?.kind === 'peer'
    if (url.pathname.startsWith('/remote/v1/peer/')) {
      if (!isPeer || !caller.device) return writeError(res, 403, '只有配对为「另一台砚」的设备可以使用这个接口', 'peer_only')
      await this.handlePeer(req, res, url, caller.device)
      return
    }
    if (isPeer && url.pathname !== '/remote/v1/info') {
      writeError(res, 403, '另一台砚需要先申请本次连接，并只能访问开放的项目', 'peer_scope')
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/info') {
      const configured = [
        'status', 'sessions', 'history', 'select', 'new', 'send', 'abort', 'rename', 'events-resume', 'idempotency',
        ...(this.options.handlers.questions ? ['questions'] : []),
        ...(this.options.handlers.answer ? ['answer'] : []),
        ...(this.options.handlers.humanApproval && caller.device && (caller.device.kind ?? 'phone') === 'phone' ? ['human-approval'] : []),
        ...(this.options.handlers.artifact ? ['artifacts'] : []),
        ...(this.options.devices ? ['device-name', 'device-revoke'] : []),
        ...(this.options.handlers.models ? ['models', 'thinking', 'send-images'] : [])
      ]
      const implemented = [...new Set([...configured, 'questions', 'answer', 'artifacts', 'device-name', 'device-revoke', 'models', 'thinking', 'send-images'])]
      const allowed = isPeer || isAgent ? [] : configured
      const negotiation = negotiateCapabilities(implemented, configured, allowed)
      writeJson(res, 200, {
        ok: true,
        apiVersion: REMOTE_API_VERSION,
        transport: ['http', 'sse'],
        tokenRequired: true,
        ...negotiation,
        device: caller.device,
        computer: { name: hostname() }
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

    if (req.method === 'POST' && url.pathname === '/remote/v1/device') {
      const body = await this.readJson(req)
      if (!caller.device || !this.options.devices) return writeError(res, 403, '需要配对设备令牌')
      if (!validText(body.name, 60)) return writeError(res, 400, '设备名称需要 1–60 个字符')
      const device = await this.options.devices.renameDevice(caller.device.id, body.name)
      writeJson(res, device ? 200 : 404, device ? { ok: true, data: device } : { ok: false, error: '设备已撤销' })
      return
    }

    if (req.method === 'GET' && parts.length === 5 && parts[2] === 'sessions' && parts[4] === 'models') {
      const sessionId = decodeURIComponent(parts[3])
      if (!validSessionId(sessionId)) return writeError(res, 400, '会话 id 无效')
      if (!this.options.handlers.models) return writeError(res, 404, '请更新电脑端')
      this.writeOperation(res, await this.options.handlers.models(sessionId))
      return
    }

    if (req.method === 'GET' && parts.length === 7 && parts[2] === 'sessions' && parts[4] === 'images') {
      const [sessionId, messageId] = [decodeURIComponent(parts[3]), decodeURIComponent(parts[5])]
      const index = Number(parts[6])
      if (!validSessionId(sessionId) || !messageId || messageId.length > 2000 || !Number.isInteger(index) || index < 0 || index > 127) return writeError(res, 400, '图片引用无效')
      if (!this.options.handlers.image) return writeError(res, 404, '请更新电脑端')
      const found = await this.options.handlers.image(sessionId, messageId, index)
      if ('ok' in found) { this.writeOperation(res, found); return }
      res.writeHead(200, { 'content-type': found.mediaType, 'content-length': found.bytes, 'cache-control': 'no-store', ...CORS_HEADERS })
      const stream = createReadStream(found.path)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
      return
    }

    if (req.method === 'POST' && parts.length === 5 && parts[2] === 'questions' && parts[4] === 'answer') {
      await this.answer(req, res, caller, decodeURIComponent(parts[3]))
      return
    }

    if (req.method === 'POST' && parts.length === 5 && parts[2] === 'questions' && parts[4] === 'approval') {
      if (!caller.device || (caller.device.kind ?? 'phone') !== 'phone') return writeError(res, 403, '人工批准需要单独配对的用户客户端', 'paired_user_required')
      const handler = this.options.handlers.humanApproval
      if (!handler) return writeError(res, 404, '电脑端尚不支持人工批准回传')
      const questionId = decodeURIComponent(parts[3])
      const body = await this.readJson(req)
      if (!validQuestionId(questionId) || !(body.sessionId === null || (typeof body.sessionId === 'string' && validSessionId(body.sessionId))) ||
          !(validRunId(body.runId) || (typeof body.runId === 'string' && /^approval:[0-9a-f-]{36}$/.test(body.runId))) ||
          typeof body.confirmed !== 'boolean' || typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest)) return writeError(res, 400, '人工批准必须绑定有效的问题、会话、运行和操作摘要')
      const answer: RemoteHumanApproval = { sessionId: body.sessionId, runId: body.runId, digest: body.digest, confirmed: body.confirmed }
      await this.idempotent(req, res, caller, true, () => handler(questionId, answer))
      return
    }

    if (req.method === 'GET' && parts.length === 4 && parts[2] === 'sessions') {
      const sessionId = decodeURIComponent(parts[3])
      if (!validSessionId(sessionId)) {
        writeError(res, 400, '会话 id 无效')
        return
      }
      const before = url.searchParams.get('before') ?? undefined
      if (before !== undefined && (!before || before.length > 2000 || /[\r\n]/.test(before))) {
        writeError(res, 400, '历史游标无效')
        return
      }
      const result = await this.options.handlers.history(sessionId, clampHistoryLimit(url.searchParams.get('limit')), before)
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
      let body: Record<string, unknown>
      try { body = await this.readJson(req, operation === 'messages' ? 12 * 1024 * 1024 : MAX_BODY_BYTES) }
      catch { writeError(res, 413, '消息超过大小限制或格式无效'); return }
      if (operation === 'select') {
        this.writeOperation(res, await this.options.handlers.command({ action: 'select', sessionId }))
        return
      }
      if (operation === 'messages') {
        let images: RemoteImageInput[] | undefined
        if (body.images !== undefined) {
          images = validateRemoteImages(body.images) ?? undefined
          if (!images) { writeError(res, 400, '最多 4 张图片，每张不超过 2MB，仅支持 JPEG、PNG、WebP'); return }
        }
        if (typeof body.text !== 'string' || body.text.length > MAX_MESSAGE_CHARS || (!body.text.trim() && !images?.length)) {
          writeError(res, 400, '消息不能为空且不得超过 20,000 个字符')
          return
        }
        const text = body.text
        await this.idempotent(req, res, caller, !!images?.length, () => this.options.handlers.command({ action: 'send', sessionId, text, images }))
        return
      }
      if (operation === 'model') {
        if (!this.options.handlers.models) return writeError(res, 404, '请更新电脑端')
        if (!validText(body.provider, 200) || !validText(body.modelId, 300)) return writeError(res, 400, '模型标识无效')
        const { provider, modelId } = body
        await this.idempotent(req, res, caller, true, () => this.options.handlers.command({ action: 'model', sessionId, provider, modelId }))
        return
      }
      if (operation === 'thinking') {
        if (!this.options.handlers.models) return writeError(res, 404, '请更新电脑端')
        if (!validText(body.level, 40)) return writeError(res, 400, '思考档位无效')
        const level = body.level
        await this.idempotent(req, res, caller, false, () => this.options.handlers.command({ action: 'thinking', sessionId, level }))
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

  private async handlePeer(req: IncomingMessage, res: ServerResponse, url: URL, device: RemoteDeviceSummary): Promise<void> {
    const peers = this.options.peers
    if (!peers) return writeError(res, 404, '这台电脑没有开启砚对砚互通', 'peer_disabled')
    const { grants, handlers } = peers
    const parts = url.pathname.split('/').filter(Boolean).slice(3)
    const header = req.headers[PEER_CONNECTION_HEADER]
    const connectionId = typeof header === 'string' ? header.trim() : (url.searchParams.get('connection') ?? undefined)
    const gate = (operation: PeerOperation, projectId?: string) => {
      const result = grants.check(connectionId, device.id, operation, projectId)
      if (!result.ok) writeError(res, result.status, result.error, result.code)
      return result.ok ? result.grant : null
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'connect') {
      const body = await this.readJson(req)
      const operations = Array.isArray(body.operations)
        ? PEER_OPERATIONS.filter((op) => (body.operations as unknown[]).includes(op))
        : []
      if (!operations.length) return writeError(res, 400, `需要至少申请一种操作：${PEER_OPERATIONS.join(' / ')}`)
      const note = typeof body.note === 'string' ? body.note : ''
      const grant = await grants.request(device, operations, note, await handlers.projects())
      if (!grant) return writeError(res, 403, '所有者拒绝了这次连接，或没有及时处理', 'peer_denied')
      this.log(`已批准另一台砚的连接：${device.name}`)
      writeJson(res, 200, { ok: true, data: { grant } })
      return
    }

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'events') {
      if (this.clients.size + this.peerClients.size >= 32) return writeError(res, 429, '事件连接过多，请关闭其他连接后重试')
      const grant = connectionId ? grants.activate(connectionId, device.id) : null
      if (!grant || !connectionId) return writeError(res, 401, '本次连接未获批准、已使用过或已失效，请重新申请', 'peer_connection_required')
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      this.peerClients.set(connectionId, res)
      res.on('close', () => {
        this.peerClients.delete(connectionId)
        grants.revoke(connectionId)
      })
      this.writeSse(res, `event: grant\ndata: ${JSON.stringify(grant)}\n\n`)
      return
    }

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'grant') {
      const grant = grants.list().find((item) => item.connectionId === connectionId && item.deviceId === device.id)
      if (!grant) return writeError(res, 401, '本次连接已失效', 'peer_connection_required')
      writeJson(res, 200, { ok: true, data: { grant } })
      return
    }

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      const grant = gate('read')
      if (!grant) return
      writeJson(res, 200, { ok: true, data: { projects: grant.projects, sessions: await handlers.sessions(grant.projects.map((p) => p.id)) } })
      return
    }

    if (parts[0] === 'sessions' && parts.length >= 2) {
      const sessionId = decodeURIComponent(parts[1])
      if (!validSessionId(sessionId)) return writeError(res, 400, '会话 id 无效')
      const projectId = await handlers.projectOfSession(sessionId)
      if (!projectId) return writeError(res, 404, '找不到这个会话，或它不属于任何开放的项目')

      if (req.method === 'GET' && parts.length === 2) {
        if (!gate('read', projectId)) return
        const before = url.searchParams.get('before') ?? undefined
        if (before !== undefined && (!before || before.length > 2000 || /[\r\n]/.test(before))) return writeError(res, 400, '历史游标无效')
        this.writeOperation(res, await this.options.handlers.history(sessionId, clampHistoryLimit(url.searchParams.get('limit')), before))
        return
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'export') {
        if (!gate('transfer', projectId)) return
        this.writeOperation(res, await handlers.exportSession(sessionId))
        return
      }
      if (req.method === 'GET' && parts.length === 4 && parts[2] === 'artifacts') {
        const viewing = grants.check(connectionId, device.id, 'read', projectId)
        const copying = viewing.ok ? viewing : grants.check(connectionId, device.id, 'transfer', projectId)
        const allowed = copying.ok ? copying : grants.check(connectionId, device.id, 'pull', projectId)
        if (!allowed.ok) return writeError(res, allowed.status, allowed.error, allowed.code)
        await this.artifact(res, sessionId, decodeURIComponent(parts[3]))
        return
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'messages') {
        if (!gate('send', projectId)) return
        let body: Record<string, unknown>
        try {
          body = await this.readJson(req)
        } catch {
          return writeError(res, 413, '消息超过大小限制或格式无效')
        }
        if (!validText(body.text, MAX_MESSAGE_CHARS)) return writeError(res, 400, '消息不能为空且不得超过 20,000 个字符')
        const text = body.text
        await this.idempotent(req, res, { device }, true, () => this.options.handlers.command({ action: 'send', sessionId, text }))
        return
      }
    }

    if (req.method === 'POST' && parts.length === 2 && parts[0] === 'runs' && parts[1] === 'abort') {
      const body = await this.readJson(req)
      if (!validRunId(body.runId)) return writeError(res, 400, '中止操作必须提供有效的目标 runId')
      const runId = body.runId
      const projectId = await handlers.projectOfRun(runId)
      if (!projectId) return writeError(res, 404, '找不到这个运行实例，或它不属于开放的项目')
      if (!gate('send', projectId)) return
      await this.idempotent(req, res, { device }, false, () => this.options.handlers.command({ action: 'abort', runId }))
      return
    }

    if (req.method === 'POST' && parts.length === 3 && parts[0] === 'projects' && parts[2] === 'sessions') {
      const projectId = decodeURIComponent(parts[1])
      if (!gate('send', projectId)) return
      let body: Record<string, unknown>
      try {
        body = await this.readJson(req)
      } catch {
        return writeError(res, 413, '消息超过大小限制或格式无效')
      }
      if (!validText(body.text, MAX_MESSAGE_CHARS)) return writeError(res, 400, '消息不能为空且不得超过 20,000 个字符')
      const text = body.text
      this.log(`另一台砚申请在开放项目里新开任务：${device.name}`)
      await this.idempotent(req, res, { device }, true, () => handlers.startSession(projectId, text))
      return
    }

    if (parts[0] === 'collab' && handlers.collab) {
      const reply = await handlers.collab.handle(req, parts.slice(1), {
        device,
        allow: (operations, projectId) => {
          let denied: RemoteOperationResult | null = null
          for (const operation of operations) {
            const result = grants.check(connectionId, device.id, operation, projectId)
            if (result.ok) return null
            if (!denied || result.code === 'peer_project_denied') denied = { ok: false, status: result.status, error: result.error, code: result.code }
          }
          return denied ?? { ok: false, status: 403, error: '这个操作不在本次连接的授权范围内' }
        }
      })
      if (reply) return this.writeCollab(res, reply)
    }

    writeError(res, 404, '远程 API 路径不存在')
  }

  private writeCollab(res: ServerResponse, reply: PeerCollabReply): void {
    if (reply.kind === 'json') return this.writeOperation(res, reply.result)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': reply.bytes,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(reply.filename)}`,
      'cache-control': 'no-store'
    })
    const stream = createReadStream(reply.path)
    stream.on('error', () => res.destroy())
    res.on('close', () => reply.done())
    stream.pipe(res)
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.options.devices) {
      writeError(res, 404, '这台电脑没有开启手机配对', 'pairing_disabled')
      return
    }
    const now = Date.now()
    this.pairAttempts = this.pairAttempts.filter((at) => now - at < PAIR_RATE_WINDOW_MS)
    const source = req.socket?.remoteAddress ?? 'unknown'
    for (const [key, attempts] of this.pairAttemptsBySource) {
      const recent = attempts.filter((at) => now - at < PAIR_RATE_WINDOW_MS)
      if (recent.length) this.pairAttemptsBySource.set(key, recent)
      else this.pairAttemptsBySource.delete(key)
    }
    const recent = this.pairAttemptsBySource.get(source) ?? []
    if (recent.length >= PAIR_RATE_LIMIT || this.pairAttempts.length >= PAIR_RATE_LIMIT * 10 || (!this.pairAttemptsBySource.has(source) && this.pairAttemptsBySource.size >= 1000)) {
      writeError(res, 429, '配对尝试过于频繁，请稍后再试', 'rate_limited')
      return
    }
    this.pairAttempts.push(now)
    this.pairAttemptsBySource.set(source, [...recent, now])
    const body = await this.readJson(req)
    if (body.kind === 'agent') {
      writeError(res, 403, 'Agent Hub 已退役，不再接受礁石配对', 'agent_retired')
      return
    }
    const result = await this.options.devices.pair(body.code, body.deviceName, body.kind)
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
    writeJson(res, 200, { ok: true, deviceId: result.device.id, token: result.token, apiVersion: REMOTE_API_VERSION, device: result.device, computer: { name: hostname() } })
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
    if (this.clients.size + this.peerClients.size >= 32) return writeError(res, 429, '事件连接过多，请关闭其他连接后重试')
    ;(res as ServerResponse & { yanDeviceId?: string }).yanDeviceId = caller.device?.id
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    if (!this.writeSse(res, `event: ready\ndata: ${JSON.stringify({ apiVersion: REMOTE_API_VERSION, at: Date.now(), latestSeq: this.seq })}\n\n`)) return
    const lastEventId = req.headers['last-event-id']
    const since = Number(sinceRaw ?? (typeof lastEventId === 'string' ? lastEventId : NaN))
    if (Number.isSafeInteger(since) && since >= 0) {
      const oldest = this.buffer[0]?.seq ?? this.seq + 1
      if (since > this.seq) {
        this.writeSse(res, `event: resync\ndata: ${JSON.stringify({ reason: 'server_restarted', latestSeq: this.seq })}\n\n`)
      } else if (since < oldest - 1) {
        this.writeSse(res, `event: resync\ndata: ${JSON.stringify({ reason: 'buffer_overflow', latestSeq: this.seq })}\n\n`)
      } else {
        for (const envelope of this.buffer) if (envelope.seq > since && !this.writeEvent(res, envelope)) break
      }
    }
  }
}
