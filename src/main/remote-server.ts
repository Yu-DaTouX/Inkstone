import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import type { Duplex, Readable } from 'node:stream'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import type { MainPush } from '../shared/ipc'
import { pick } from '../shared/ui-lang'
import {
  REMOTE_EVENT_BUFFER,
  REMOTE_IDEMPOTENCY_HEADER,
  REMOTE_IDEMPOTENCY_KEY_RE,
  REMOTE_IDEMPOTENCY_TTL_MS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_CALL_PREFIX,
  REMOTE_VERSION_HEADER,
  type RemoteAnswer,
  type RemoteDeviceSummary,
  type RemoteEventEnvelope,
  type RemotePendingQuestion,
  type RemoteQueueOp
} from '../shared/remote-protocol'
import type { RemoteHumanApproval } from '../shared/remote-protocol'
import type { RemoteImageInput } from '../shared/remote-protocol'
import type { RemoteDeviceStore } from './remote-devices'
import { isRecord, remoteAction, validSessionId, type ActionContext } from './remote-actions'
import { WATCH_EVENT_BUFFER, WATCH_HISTORY_LIMIT, WATCH_MAX_VIEWERS, watchMessage, watchSessionState, type WatchEventChannel } from '../shared/session-watch'
import type { UIMessage } from '../shared/ui-message'

export const REMOTE_API_VERSION = REMOTE_PROTOCOL_VERSION

export type RemoteCommand =
  | { action: 'select'; sessionId: string }
  | { action: 'new'; projectId?: string; worktree?: boolean }
  | { action: 'send'; sessionId: string; text: string; images?: RemoteImageInput[]; mode?: 'steer' | 'followUp' }
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
  subagents?(sessionId: string): Promise<RemoteOperationResult>
  insight?(sessionId: string): Promise<RemoteOperationResult>
  stopSubagent?(sessionId: string, runId: string): Promise<RemoteOperationResult>
  reviewSubagent?(sessionId: string, runId: string, action: 'merge' | 'discard'): Promise<RemoteOperationResult>
  sendSubagent?(sessionId: string, runId: string, text: string): Promise<RemoteOperationResult>
  queue?(sessionId: string, op: RemoteQueueOp): Promise<RemoteOperationResult>
  jobs?(sessionId: string): Promise<RemoteOperationResult>
  stopJob?(sessionId: string, jobId: string): Promise<RemoteOperationResult>
  subagentPatch?(sessionId: string, runId: string): Promise<RemoteOperationResult>
  workflows?(sessionId: string): Promise<RemoteOperationResult>
  workflowControl?(sessionId: string, workflowId: string, action: 'pause' | 'resume' | 'stop'): Promise<RemoteOperationResult>
  quota?(): Promise<RemoteOperationResult>
  usage?(range: '7d' | '30d' | 'all'): Promise<RemoteOperationResult>
  sessionFlags?(sessionId: string, flags: { pinned?: boolean; archived?: boolean }): Promise<RemoteOperationResult>
  deleteSession?(sessionId: string): Promise<RemoteOperationResult>
  compact?(sessionId: string): Promise<RemoteOperationResult>
  branches?(sessionId: string): Promise<RemoteOperationResult>
  switchBranch?(sessionId: string, branch: string): Promise<RemoteOperationResult>
  search?(query: string, limit: number): Promise<RemoteOperationResult>
  image?(sessionId: string, messageId: string, index: number): Promise<RemoteArtifactFile | RemoteOperationResult>
  command(command: RemoteCommand): Promise<RemoteOperationResult>
  questions?(): Promise<RemotePendingQuestion[]>
  answer?(questionId: string, answer: RemoteAnswer): Promise<RemoteOperationResult>
  humanApproval?(questionId: string, answer: RemoteHumanApproval): Promise<RemoteOperationResult>
  artifact?(sessionId: string, artifactId: string): Promise<RemoteArtifactFile | RemoteOperationResult>
  transcribe?(wav: Uint8Array): Promise<RemoteOperationResult>
}


export interface RemoteServerOptions {
  host: string
  port: number
  token?: string
  devices?: RemoteDeviceStore
  handlers: RemoteServerHandlers
  onLog?: (text: string, level?: 'info' | 'error') => void
  relayToken?: string
  tunnel?: RemoteTunnelHooks
  relayClientPaired?: (clientId: string) => void | Promise<void>
  relayClientRevoked?: (clientId: string) => void | Promise<void>
  viewersChanged?: (sessionId: string) => void
}

export interface RemoteTunnelHooks {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  invite(): Promise<{ hostKey: string; code: string; hostFingerprint?: string }>
  inviteActive?(code: string): boolean
  stop?(): void
}

export const REMOTE_TUNNEL_PATH = '/remote/v1/tunnel'


export interface RemoteServerInfo {
  host: string
  port: number
  token: string | null
}

const MAX_BODY_BYTES = 64 * 1024
const IDEMPOTENCY_MAX_ENTRIES = 2000
const DEVICE_STREAM_LIMIT = 4
const VIEWER_STREAM_LIMIT = 2
const WATCH_STREAMS_MAX = 64
const WATCH_BUFFER_BYTES = 8 * 1024 * 1024
const PAIR_RATE_WINDOW_MS = 60_000
const MAX_INVITE_ISSUES = 5
const PAIR_RATE_LIMIT = 10
const INVITE_RATE_LIMIT = 20
const RELAY_HANDOFF_HEADER = 'x-yan-relay-client'
const CORS_HEADERS = {
  'access-control-allow-headers': `authorization, content-type, x-yan-remote-token, ${REMOTE_IDEMPOTENCY_HEADER}`,
  'access-control-allow-methods': 'GET, POST, OPTIONS'
}

const REMOTE_CHANNELS = new Set([
  'msg-add',
  'msg-update',
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
  'approval-close',
  'turn-settled',
  'agent-error',
  'subagent',
  'terminal-jobs',
  'workflow'
])

const PATH_LEAK_RE = /(?:(?<![A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|(?<![\w.:/-])\/(?:home|Users|root|tmp|var|etc|opt|mnt|usr|private|Volumes|srv)\/)[^\r\n"'<>|*?，。；！？]*/g

export function scrubRemoteError(text: string): string {
  return text.replace(PATH_LEAK_RE, '…')
}

export class RemoteRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function requestErrorStatus(error: unknown): number | null {
  return error instanceof RemoteRequestError ? error.status : null
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

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function fromLoopback(req: IncomingMessage): boolean {
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? '')
}

function relayHeaderSource(req: IncomingMessage): string | null {
  const client = req.headers[RELAY_HANDOFF_HEADER]
  return typeof client === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(client) ? `relay:${client}` : null
}

export class RemoteServer {
  private server: Server | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private readonly clients = new Set<ServerResponse>()
  private readonly openStreams = new Set<Readable>()
  private readonly token: string | null
  private boundPort: number
  private seq = 0
  private readonly buffer: RemoteEventEnvelope[] = []
  private bufferBytes = 0
  private readonly eventFrames = new WeakMap<RemoteEventEnvelope, { text: string; bytes: number }>()
  private readonly idempotency = new Map<string, { at: number; result: Promise<RemoteOperationResult>; fingerprint?: string }>()
  private pairAttempts: number[] = []
  private readonly pairAttemptsBySource = new Map<string, number[]>()
  private readonly inviteAttempts = new Map<string, number[]>()
  private readonly watchers = new Map<ServerResponse, { sessionId: string; deviceId: string }>()
  private watchSeq = 0
  private readonly watchBuffer: Array<{ seq: number; sessionId: string; text: string; bytes: number }> = []
  private watchBufferBytes = 0
  private inviteCache: { key: string; issued: number; value: { hostKey: string; code: string; hostFingerprint?: string } } | null = null

  constructor(private readonly options: RemoteServerOptions) {
    const explicit = options.token?.trim()
    this.token = explicit || (options.devices ? null : randomUUID())
    if (this.token !== null && this.token.length < 16) throw new Error(pick('YAN_REMOTE_TOKEN 至少需要 16 个字符', 'YAN_REMOTE_TOKEN must be at least 16 characters'))
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error(pick(`远程服务端口无效：${options.port}`, `Invalid remote service port: ${options.port}`))
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
        const status = requestErrorStatus(error)
        if (status !== null && error instanceof Error) {
          if (!res.headersSent) writeError(res, status, error.message)
          else res.destroy()
          return
        }
        this.log(`请求处理失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        if (!res.headersSent) writeError(res, 500, pick('远程请求处理失败', 'Remote request failed'))
        else res.destroy()
      })
    })
    this.server = server
    const tunnel = this.options.tunnel
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://tunnel.local').pathname
      const origin = req.headers.origin
      let sameOrigin = !origin
      try { if (origin) sameOrigin = new URL(origin).host === req.headers.host } catch { }
      if (tunnel && path === REMOTE_TUNNEL_PATH && sameOrigin) tunnel.upgrade(req, socket, head)
      else socket.destroy()
    })

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
        this.writeSse(client, ': heartbeat\n\n')
      }
      for (const client of [...this.watchers.keys()]) this.writeSse(client, ': heartbeat\n\n')
      this.pruneIdempotency()
    }, 25_000)
    this.heartbeat.unref()
    this.log(`远程管理服务已启动：${this.options.host}:${this.boundPort}`)
    return this.info
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.inviteCache = null
    this.inviteAttempts.clear()
    for (const stream of this.openStreams) stream.destroy()
    this.openStreams.clear()
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
      }
    }
    this.clients.clear()
    for (const client of this.watchers.keys()) {
      try {
        client.end()
      } catch {
      }
    }
    this.watchers.clear()
    this.options.tunnel?.stop?.()
    const server = this.server
    this.server = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      timer.unref?.()
    })
    await Promise.race([closed, deadline])
  }

  private pipeStream(stream: Readable, res: ServerResponse): void {
    this.openStreams.add(stream)
    const forget = (): void => {
      this.openStreams.delete(stream)
    }
    stream.on('error', () => {
      forget()
      res.destroy()
    })
    stream.on('close', forget)
    res.on('close', () => {
      forget()
      stream.destroy()
    })
    stream.pipe(res)
  }

  private allowInvite(source: string): boolean {
    const now = Date.now()
    for (const [key, attempts] of this.inviteAttempts) {
      const recent = attempts.filter((at) => now - at < PAIR_RATE_WINDOW_MS)
      if (recent.length) this.inviteAttempts.set(key, recent)
      else this.inviteAttempts.delete(key)
    }
    const recent = this.inviteAttempts.get(source) ?? []
    if (recent.length >= INVITE_RATE_LIMIT) return false
    this.inviteAttempts.set(source, [...recent, now])
    return true
  }

  disconnectAll(): void {
    for (const client of this.clients) {
      try { client.end() } catch { }
    }
    this.clients.clear()
    for (const client of this.watchers.keys()) {
      try { client.end() } catch { }
    }
    this.watchers.clear()
  }

  disconnectDevice(deviceId: string): void {
    for (const client of this.clients) {
      if ((client as ServerResponse & { yanDeviceId?: string }).yanDeviceId === deviceId) {
        try { client.end() } catch { }
        this.clients.delete(client)
      }
    }
    for (const [client, meta] of [...this.watchers]) {
      if (meta.deviceId !== deviceId) continue
      this.watchers.delete(client)
      try { client.end() } catch { }
    }
  }

  endWatch(sessionId: string): void {
    for (const [client, meta] of [...this.watchers]) {
      if (meta.sessionId !== sessionId) continue
      this.watchers.delete(client)
      try {
        client.write(`event: ended\ndata: {}\n\n`)
        client.end()
      } catch { }
    }
    for (let index = this.watchBuffer.length - 1; index >= 0; index -= 1) {
      if (this.watchBuffer[index].sessionId !== sessionId) continue
      this.watchBufferBytes -= this.watchBuffer[index].bytes
      this.watchBuffer.splice(index, 1)
    }
  }

  publishWatch(sessionId: string, channel: WatchEventChannel, payload: unknown): void {
    const seq = ++this.watchSeq
    const text = `id: ${seq}\nevent: ${channel}\ndata: ${JSON.stringify({ seq, at: Date.now(), channel, payload })}\n\n`
    const bytes = Buffer.byteLength(text)
    this.watchBuffer.push({ seq, sessionId, text, bytes })
    this.watchBufferBytes += bytes
    while (this.watchBuffer.length > WATCH_EVENT_BUFFER || this.watchBufferBytes > WATCH_BUFFER_BYTES) {
      this.watchBufferBytes -= this.watchBuffer.shift()!.bytes
    }
    if (!this.server) return
    for (const [client, meta] of [...this.watchers]) if (meta.sessionId === sessionId) this.writeSse(client, text)
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
      this.watchers.delete(client)
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
    const tooLarge = (): RemoteRequestError => new RemoteRequestError(413, pick('请求体超过大小限制', 'Request body is too large'))
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > maxBytes) throw tooLarge()
      chunks.push(part)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new RemoteRequestError(400, pick('请求体不是有效的 JSON', 'Request body is not valid JSON'))
    }
    if (!isRecord(parsed)) throw new RemoteRequestError(400, pick('请求体必须是 JSON 对象', 'Request body must be a JSON object'))
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
    run: () => Promise<RemoteOperationResult>,
    fingerprint?: string
  ): Promise<void> {
    const header = req.headers[REMOTE_IDEMPOTENCY_HEADER]
    const key = typeof header === 'string' ? header.trim() : ''
    if (!key) {
      if (required) {
        writeError(res, 400, pick(`这个操作需要 ${REMOTE_IDEMPOTENCY_HEADER} 请求头`, `This operation requires the ${REMOTE_IDEMPOTENCY_HEADER} header`), 'idempotency_key_required')
        return
      }
      this.writeOperation(res, await run())
      return
    }
    if (!REMOTE_IDEMPOTENCY_KEY_RE.test(key)) {
      writeError(res, 400, pick('幂等键格式无效', 'Invalid idempotency key'), 'idempotency_key_invalid')
      return
    }
    this.pruneIdempotency()
    const scoped = `${caller.device?.id ?? 'legacy'}:${req.method}:${new URL(req.url ?? '/', 'http://x').pathname}:${key}`
    const existing = this.idempotency.get(scoped)
    if (existing && existing.fingerprint !== fingerprint) {
      writeError(res, 409, pick('这个幂等键已用于另一个请求，请重新发起', 'This idempotency key was already used for another request. Start again'), 'idempotency_key_reused')
      return
    }
    if (existing) {
      const result = await existing.result
      this.writeOperation(res, result, true)
      return
    }
    const result = run().catch((error: unknown): RemoteOperationResult => {
      const status = requestErrorStatus(error)
      if (status !== null && error instanceof Error) return { ok: false, status, error: error.message }
      this.log(`远程操作失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return { ok: false, status: 500, error: pick('远程操作失败', 'Remote operation failed') }
    })
    while (this.idempotency.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.idempotency.keys().next().value
      if (oldest === undefined) break
      this.idempotency.delete(oldest)
    }
    this.idempotency.set(scoped, { at: Date.now(), result, ...(fingerprint !== undefined ? { fingerprint } : {}) })
    this.writeOperation(res, await result)
  }

  private relayHeaderTrusted(req: IncomingMessage): boolean {
    const expected = this.options.relayToken
    if (!expected) return true
    const presented = req.headers['x-yan-relay']
    return typeof presented === 'string' && constantTimeEqual(expected, presented)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin) {
      writeError(res, 403, pick('网页来源不受允许', 'Web origin not allowed'))
      return
    }
    const url = new URL(req.url ?? '/', `http://${this.options.host}:${this.boundPort}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (!this.relayHeaderTrusted(req)) {
      writeError(res, 403, pick('请求没有经过可信任的中继通道', 'Request did not come through a trusted relay'), 'relay_token_required')
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/health') {
      writeJson(res, 200, { ok: true, apiVersion: REMOTE_API_VERSION, ...(this.options.tunnel ? { tunnel: REMOTE_TUNNEL_PATH } : {}) })
      return
    }

    const clientVersion = Number(req.headers[REMOTE_VERSION_HEADER] ?? 0)
    if (clientVersion !== REMOTE_API_VERSION) {
      writeJson(res, 426, {
        ok: false,
        code: 'version_mismatch',
        apiVersion: REMOTE_API_VERSION,
        error: clientVersion > REMOTE_API_VERSION
          ? pick('电脑上的砚版本较旧，请先在电脑上更新砚', 'Inkstone on the computer is out of date. Update it on the computer first')
          : pick('这台设备上的砚版本较旧，请更新到最新版再连接', 'Inkstone on this device is out of date. Update it and connect again')
      })
      return
    }

    const plaintext = !!this.options.tunnel && !this.options.relayToken && !fromLoopback(req)

    if (req.method === 'POST' && url.pathname === '/remote/v1/pair') {
      await this.pair(req, res, plaintext)
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/tunnel/invite' && this.options.tunnel) {
      const pairing = this.options.devices?.currentPairing()
      if (!pairing) return writeError(res, 403, pick('电脑上没有正在进行的配对，请先在电脑上生成配对码', 'No pairing in progress on the computer. Generate a pairing code first'), 'no_pairing')
      const source = (this.options.relayToken ? relayHeaderSource(req) : null) ?? req.socket?.remoteAddress ?? 'unknown'
      if (!this.allowInvite(source)) return writeError(res, 429, pick('配对通道请求过于频繁，请稍后再试', 'Too many pairing channel requests. Try again later'), 'rate_limited')
      const key = `${pairing.code}:${pairing.expiresAt}`
      if (!this.inviteCache || this.inviteCache.key !== key) {
        this.inviteCache = { key, issued: 1, value: await this.options.tunnel.invite() }
      } else if (this.options.tunnel.inviteActive?.(this.inviteCache.value.code) === false) {
        if (this.inviteCache.issued >= MAX_INVITE_ISSUES) return writeError(res, 429, pick('这次配对的通道已重开多次，请在电脑上重新生成配对码', 'This pairing has reopened its channel too many times. Generate a new pairing code on the computer'), 'rate_limited')
        this.inviteCache = { key, issued: this.inviteCache.issued + 1, value: await this.options.tunnel.invite() }
      }
      writeJson(res, 200, { ok: true, ...this.inviteCache.value, path: REMOTE_TUNNEL_PATH, computer: { name: hostname() } })
      return
    }

    const caller = await this.authorize(req)
    if (!caller) {
      writeError(res, 401, pick('需要有效的远程访问令牌', 'A valid remote access token is required'), 'unauthorized')
      return
    }

    if (plaintext) return writeError(res, 403, pick('只能经加密通道连接，请在手机上重新配对', 'Only encrypted tunnel connections are accepted. Pair this phone again'), 'tunnel_required')

    if (caller.device?.kind === 'viewer') {
      await this.viewerRoute(req, res, url, caller.device)
      return
    }

    if (req.method === 'GET' && url.pathname === '/remote/v1/events') {
      await this.openEvents(req, res, caller, url.searchParams.get('since'))
      return
    }

    if (req.method === 'POST' && url.pathname.startsWith(REMOTE_CALL_PREFIX)) {
      await this.call(req, res, caller, url.pathname.slice(REMOTE_CALL_PREFIX.length))
      return
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (req.method === 'GET' && parts.length === 7 && parts[2] === 'sessions' && parts[4] === 'images') {
      const [sessionId, messageId] = [decodeURIComponent(parts[3]), decodeURIComponent(parts[5])]
      const index = Number(parts[6])
      if (!validSessionId(sessionId) || !messageId || messageId.length > 2000 || !Number.isInteger(index) || index < 0 || index > 127) return writeError(res, 400, pick('图片引用无效', 'Invalid image reference'))
      if (!this.options.handlers.image) return writeError(res, 404, pick('请更新电脑端', 'Update the desktop app'))
      const found = await this.options.handlers.image(sessionId, messageId, index)
      if ('ok' in found) { this.writeOperation(res, found); return }
      res.writeHead(200, { 'content-type': found.mediaType, 'content-length': found.bytes, 'cache-control': 'no-store', ...CORS_HEADERS })
      this.pipeStream(createReadStream(found.path), res)
      return
    }

    if (req.method === 'GET' && parts.length === 6 && parts[2] === 'sessions' && parts[4] === 'artifacts') {
      await this.artifact(res, decodeURIComponent(parts[3]), decodeURIComponent(parts[5]))
      return
    }

    writeError(res, 404, pick('远程 API 路径不存在', 'Remote API path not found'))
  }

  private async pair(req: IncomingMessage, res: ServerResponse, plaintext = false): Promise<void> {
    if (!this.options.devices) {
      writeError(res, 404, pick('这台电脑没有开启手机配对', 'Phone pairing is not enabled on this computer'), 'pairing_disabled')
      return
    }
    const now = Date.now()
    this.pairAttempts = this.pairAttempts.filter((at) => now - at < PAIR_RATE_WINDOW_MS)
    const relayClient = this.options.relayToken ? req.headers[RELAY_HANDOFF_HEADER] : undefined
    const source = typeof relayClient === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(relayClient)
      ? `relay:${relayClient}`
      : req.socket?.remoteAddress ?? 'unknown'
    for (const [key, attempts] of this.pairAttemptsBySource) {
      const recent = attempts.filter((at) => now - at < PAIR_RATE_WINDOW_MS)
      if (recent.length) this.pairAttemptsBySource.set(key, recent)
      else this.pairAttemptsBySource.delete(key)
    }
    const recent = this.pairAttemptsBySource.get(source) ?? []
    if (recent.length >= PAIR_RATE_LIMIT || this.pairAttempts.length >= PAIR_RATE_LIMIT * 10 || (!this.pairAttemptsBySource.has(source) && this.pairAttemptsBySource.size >= 1000)) {
      writeError(res, 429, pick('配对尝试过于频繁，请稍后再试', 'Too many pairing attempts. Try again later'), 'rate_limited')
      return
    }
    this.pairAttempts.push(now)
    this.pairAttemptsBySource.set(source, [...recent, now])
    const body = await this.readJson(req)
    if (body.kind === 'viewer') {
      if (!this.options.relayToken) return writeError(res, 426, pick('旁观只能经加密通道连接', 'Viewers can only connect through the encrypted tunnel'), 'tunnel_required')
      const viewer = this.options.devices.pairViewer(body.code, body.deviceName, WATCH_MAX_VIEWERS)
      if (!viewer.ok) {
        return viewer.error === 'device_limit'
          ? writeError(res, 409, pick('旁观的人太多了，请让对方先移除不用的', 'Too many viewers. Ask the host to remove some first'), 'device_limit')
          : writeError(res, 403, pick('共享已结束或邀请无效', 'Sharing has ended or the invite is invalid'), 'invalid_code')
      }
      this.log(pick(`旁观者已加入：${viewer.device.name}`, `Viewer joined: ${viewer.device.name}`))
      if (viewer.device.watchSessionId) this.options.viewersChanged?.(viewer.device.watchSessionId)
      writeJson(res, 200, { ok: true, deviceId: viewer.device.id, token: viewer.token, apiVersion: REMOTE_API_VERSION, device: viewer.device, computer: { name: hostname() } })
      return
    }
    if (plaintext) {
      writeError(res, 426, pick('请把手机上的砚更新到最新版再配对：新版经加密通道连接电脑', 'Update Inkstone on your phone and pair again: the new version connects through an encrypted tunnel'), 'tunnel_required')
      return
    }
    const tunnelClientId = source.startsWith('relay:') ? source.slice(6) : undefined
    const result = await this.options.devices.pair(body.code, body.deviceName, tunnelClientId)
    if (!result.ok) {
      const message = {
        no_pairing: pick('电脑上没有正在进行的配对，请先在砚的设置里生成配对码', 'No pairing in progress on the computer. Generate a pairing code in Inkstone settings first'),
        expired: pick('配对码已过期，请在电脑上重新生成', 'Pairing code expired. Generate a new one on the computer'),
        invalid_code: pick('配对码不正确', 'Incorrect pairing code'),
        too_many_attempts: pick('输错次数过多，这个配对码已作废，请在电脑上重新生成', 'Too many wrong attempts. This code is void. Generate a new one on the computer'),
        device_limit: pick('已配对的设备太多，请先在电脑上撤销不用的设备', 'Too many paired devices. Revoke unused ones on the computer first')
      }[result.error]
      writeError(res, result.error === 'device_limit' ? 409 : 403, message, result.error)
      return
    }
    this.log(`新设备已配对：${result.device.name}`)
    if (tunnelClientId && result.device.tunnelClientId === tunnelClientId) await this.options.relayClientPaired?.(tunnelClientId)
    writeJson(res, 200, { ok: true, deviceId: result.device.id, token: result.token, apiVersion: REMOTE_API_VERSION, device: result.device, computer: { name: hostname() } })
  }

  private async call(req: IncomingMessage, res: ServerResponse, caller: Caller, name: string): Promise<void> {
    const spec = remoteAction(name)
    if (!spec) return writeError(res, 404, pick('远程操作不存在', 'Unknown remote action'), 'unknown_action')
    if (spec.paired && (!caller.device || !this.options.devices)) return writeError(res, 403, pick('这个操作需要配对的手机', 'This action requires a paired phone'), 'paired_user_required')
    const args = spec.parse(await this.readJson(req, spec.maxBytes ?? MAX_BODY_BYTES))
    if (typeof args === 'string') return writeError(res, 400, args)
    const ctx: ActionContext = {
      handlers: this.options.handlers,
      device: caller.device,
      info: () => ({ ok: true, data: { apiVersion: REMOTE_API_VERSION, device: caller.device, computer: { name: hostname() } } }),
      renameDevice: async (deviceName) => {
        const device = caller.device && await this.options.devices?.renameDevice(caller.device.id, deviceName)
        return device ? { ok: true, data: device } : { ok: false, status: 404, error: pick('设备已撤销', 'Device revoked') }
      },
      revokeSelf: async () => {
        const device = caller.device
        if (!device || !this.options.devices || !(await this.options.devices.revoke(device.id))) return { ok: false, status: 404, error: pick('设备已撤销', 'Device revoked') }
        setImmediate(() => {
          this.disconnectDevice(device.id)
          if (device.tunnelClientId) void Promise.resolve(this.options.relayClientRevoked?.(device.tunnelClientId)).catch(() => undefined)
        })
        return { ok: true, data: {} }
      }
    }
    const run = async () => spec.run(ctx, args)
    if (!spec.idempotency) return this.writeOperation(res, await run())
    const required = typeof spec.idempotency.required === 'function' ? spec.idempotency.required(args) : spec.idempotency.required
    await this.idempotent(req, res, caller, required, run, spec.idempotency.fingerprint?.(args))
  }

  private async artifact(res: ServerResponse, sessionId: string, artifactId: string): Promise<void> {
    if (!this.options.handlers.artifact) {
      writeError(res, 404, pick('这台电脑不支持远程读取成果', 'This computer does not support reading artifacts remotely'))
      return
    }
    if (!validSessionId(sessionId) || !/^[A-Za-z0-9._-]{1,200}$/.test(artifactId)) {
      writeError(res, 400, pick('成果 id 无效', 'Invalid artifact id'))
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
    this.pipeStream(createReadStream(found.path), res)
  }

  private writeOperation(res: ServerResponse, result: RemoteOperationResult, replayed = false): void {
    writeJson(
      res,
      result.status ?? (result.ok ? 200 : 400),
      result.ok
        ? { ok: true, data: result.data, ...(replayed ? { replayed: true } : {}) }
        : { ok: false, error: scrubRemoteError(result.error ?? pick('远程操作失败', 'Remote operation failed')), ...(result.code ? { code: result.code } : {}) }
    )
  }

  private async viewerRoute(req: IncomingMessage, res: ServerResponse, url: URL, device: RemoteDeviceSummary): Promise<void> {
    const sessionId = device.watchSessionId
    if (!sessionId || !this.options.relayToken) return writeError(res, 403, pick('旁观只能读取被共享的会话', 'A viewer can only read the shared session'), 'viewer_scope')
    if (req.method === 'GET' && url.pathname === '/remote/v1/info') {
      writeJson(res, 200, { ok: true, apiVersion: REMOTE_API_VERSION, device, computer: { name: hostname() } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/remote/v1/watch') {
      const before = url.searchParams.get('before') ?? undefined
      if (before !== undefined && (!before || before.length > 2000 || /[\r\n]/.test(before))) return writeError(res, 400, pick('历史游标无效', 'Invalid history cursor'))
      const requested = Number(url.searchParams.get('limit') ?? WATCH_HISTORY_LIMIT)
      const limit = Number.isFinite(requested) ? Math.min(WATCH_HISTORY_LIMIT, Math.max(1, Math.floor(requested))) : WATCH_HISTORY_LIMIT
      const result = await this.options.handlers.history(sessionId, limit, before)
      const seq = this.watchSeq
      if (!result.ok) return this.writeOperation(res, result)
      const data = isRecord(result.data) ? result.data : {}
      const session = isRecord(data.session) ? data.session : {}
      const messages = Array.isArray(data.messages) ? (data.messages as UIMessage[]).map(watchMessage) : []
      writeJson(res, 200, {
        ok: true,
        data: {
          seq,
          title: typeof session.title === 'string' ? session.title : '',
          messages,
          state: watchSessionState(data.state),
          hasMore: data.hasMore === true,
          ...(typeof data.nextBefore === 'string' ? { nextBefore: data.nextBefore } : {})
        }
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/remote/v1/watch/events') {
      this.openWatch(req, res, device.id, sessionId, url.searchParams.get('since'))
      return
    }
    if (req.method === 'POST' && url.pathname === '/remote/v1/devices/self/revoke') {
      await this.readJson(req)
      this.options.devices?.removeViewer(device.id)
      writeJson(res, 200, { ok: true })
      this.disconnectDevice(device.id)
      this.options.viewersChanged?.(sessionId)
      return
    }
    writeError(res, 403, pick('旁观只能读取被共享的会话', 'A viewer can only read the shared session'), 'viewer_scope')
  }

  private openWatch(req: IncomingMessage, res: ServerResponse, deviceId: string, sessionId: string, sinceRaw: string | null): void {
    const mine = [...this.watchers].filter(([, meta]) => meta.deviceId === deviceId).map(([client]) => client)
    for (const stale of mine.slice(0, Math.max(0, mine.length - (VIEWER_STREAM_LIMIT - 1)))) {
      this.watchers.delete(stale)
      try { stale.end() } catch { }
    }
    if (this.watchers.size >= WATCH_STREAMS_MAX) return writeError(res, 429, pick('旁观连接过多，请稍后重试', 'Too many viewer connections. Try again later'))
    this.watchers.set(res, { sessionId, deviceId })
    res.on('close', () => this.watchers.delete(res))
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    if (!this.writeSse(res, `event: ready\ndata: ${JSON.stringify({ apiVersion: REMOTE_API_VERSION, at: Date.now(), latestSeq: this.watchSeq })}\n\n`)) return
    const lastEventId = req.headers['last-event-id']
    const since = Number(sinceRaw ?? (typeof lastEventId === 'string' ? lastEventId : NaN))
    if (!Number.isSafeInteger(since) || since < 0) return
    const oldest = this.watchBuffer[0]?.seq ?? this.watchSeq + 1
    if (since > this.watchSeq || since < oldest - 1) {
      this.writeSse(res, `event: resync\ndata: ${JSON.stringify({ latestSeq: this.watchSeq })}\n\n`)
      return
    }
    for (const entry of this.watchBuffer) {
      if (entry.seq > since && entry.sessionId === sessionId && !this.writeSse(res, entry.text)) break
    }
  }

  private async openEvents(req: IncomingMessage, res: ServerResponse, caller: Caller, sinceRaw: string | null): Promise<void> {
    ;(res as ServerResponse & { yanDeviceId?: string }).yanDeviceId = caller.device?.id
    if (caller.device) {
      const mine = [...this.clients].filter((client) => (client as ServerResponse & { yanDeviceId?: string }).yanDeviceId === caller.device!.id)
      for (const stale of mine.slice(0, Math.max(0, mine.length - (DEVICE_STREAM_LIMIT - 1)))) {
        this.clients.delete(stale)
        try { stale.end() } catch { }
      }
    }

    if (this.clients.size >= 32) return writeError(res, 429, pick('事件连接过多，请关闭其他连接后重试', 'Too many event connections. Close others and retry'))
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
