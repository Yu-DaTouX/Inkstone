import { pick } from '../../../src/shared/ui-lang'
import { REMOTE_CALL_PREFIX, REMOTE_PROTOCOL_VERSION, REMOTE_VERSION_HEADER, type RemoteAction, type RemoteActionArgs } from '../../../src/shared/remote-protocol'
import type {
  RemoteAnswer,
  RemoteEventEnvelope,
  RemoteInfo,
  RemotePairResponse,
  RemotePendingQuestion,
  RemoteResyncEvent
} from '../../../src/shared/remote-protocol'
import type { RemoteImageInput, RemoteInsight, RemoteModel, RemoteDeviceSummary, RemoteJob, RemoteQueue, RemoteQueueOp, RemoteQuota, RemoteSubagentDiff, RemoteSubagentPatch, RemoteSubagentReview, RemoteUsage, RemoteWorkflow } from '../../../src/shared/remote-protocol'
import { HistoryCache } from '../historyCache'
import { directTunnelUrl, fromB64u, newClientKey, RelayError, RelayTunnel, type RelayConfig, type RelayPairing } from './relay'
import { sha256 } from '@noble/hashes/sha2.js'
import { formatHostFingerprint } from '../../../src/shared/host-identity'

export interface Connection {
  baseUrl: string
  relay: RelayConfig
  token: string
  deviceId: string
  computerName?: string
  deviceName?: string
  clientKey?: string
}

export interface HostIdentity {
  computer: string
  fingerprint: string
}

export function hostFingerprint(hostKey: string): string {
  return formatHostFingerprint(sha256(fromB64u(hostKey)))
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

type Target = { baseUrl: string; relay: RelayConfig }
type ClientRequestInit = { method?: 'GET' | 'POST'; token?: string; body?: unknown; idempotencyKey?: string; timeoutMs?: number; upload?: boolean }

function uploadTimedOut(timeoutMs: number): RemoteHttpError {
  const seconds = Math.round(timeoutMs / 1000)
  return new RemoteHttpError(0, pick(`上传超时：${seconds} 秒内没传完图片或语音，网络可能太慢；可换个网络或少带几张图再试`, `Upload timed out: images or audio did not finish uploading within ${seconds}s. The network may be too slow; try a better connection or fewer images.`))
}

async function request<T>(
  target: string | Target,
  path: string,
  init: ClientRequestInit = {}
): Promise<T> {
  if (typeof target !== 'string') return relayRequest<T>(target.relay, path, init)
  const baseUrl = target
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000)
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: requestHeaders(init),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    })
    const json = await readJson(response)
    if (!response.ok || json.ok === false) {
      throw new RemoteHttpError(response.status, String(json.error ?? pick(`请求失败（${response.status}）`, `Request failed (${response.status})`)), typeof json.code === 'string' ? json.code : undefined)
    }
    return json as T
  } catch (error) {
    if (error instanceof RemoteHttpError) throw error
    if ((error as { name?: string })?.name === 'AbortError' && init.upload && init.timeoutMs) throw uploadTimedOut(init.timeoutMs)
    if ((error as { name?: string })?.name === 'AbortError') throw new RemoteHttpError(0, pick('连接超时：请确认电脑上的砚在运行、手机与电脑在同一个 Tailscale 网络里', 'Timed out. Check that Inkstone is running on the desktop and both devices share a Tailscale network.'))
    throw new RemoteHttpError(0, pick('连不上电脑：请确认地址、端口，以及 Tailscale 已连接', 'Cannot reach the desktop. Check the address, port and Tailscale.'))
  } finally {
    clearTimeout(timer)
  }
}

function requestHeaders(init: { token?: string; body?: unknown; idempotencyKey?: string }): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', [REMOTE_VERSION_HEADER]: String(REMOTE_PROTOCOL_VERSION) }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey
  return headers
}

async function relayRequest<T>(
  relay: RelayConfig,
  path: string,
  init: ClientRequestInit
): Promise<T> {
  try {
    const res = await RelayTunnel.for(relay).request(init.method ?? 'GET', path, {
      headers: requestHeaders(init),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      timeoutMs: init.timeoutMs ?? 20_000
    })
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(res.text) as Record<string, unknown>
    } catch {
    }
    if (res.status < 200 || res.status >= 300 || json.ok === false) {
      throw new RemoteHttpError(res.status, String(json.error ?? pick(`请求失败（${res.status}）`, `Request failed (${res.status})`)), typeof json.code === 'string' ? json.code : undefined)
    }
    return json as T
  } catch (error) {
    if (error instanceof RemoteHttpError) throw error
    if (error instanceof RelayError && error.denied) throw new RemoteHttpError(401, error.message, 'relay_denied')
    if (error instanceof RelayError && error.timedOut && init.upload && init.timeoutMs) throw uploadTimedOut(init.timeoutMs)
    throw new RemoteHttpError(0, error instanceof RelayError ? error.message : pick('经中继连不上电脑：请确认电脑上的砚在运行并开启了中继接入', 'Cannot reach the desktop via relay. Check that Inkstone is running with relay enabled.'))
  }
}

export async function pairViaRelay(pairing: RelayPairing, deviceName: string): Promise<Connection> {
  const relay: RelayConfig = { ...(pairing.join ? { join: pairing.join } : {}), ...(pairing.direct?.length ? { direct: pairing.direct } : {}), hostKey: pairing.hostKey, clientKey: newClientKey() }
  const tunnel = RelayTunnel.for(relay, deviceName)
  try {
    await tunnel.connect(pairing.relayCode)
  } catch (error) {
    tunnel.close()
    throw new RemoteHttpError(0, error instanceof RelayError ? error.message : pick('经中继连不上电脑', 'Cannot reach the desktop via relay'))
  }
  const target = { baseUrl: `relay://${pairing.computerName}`, relay }
  try {
    const result = await request<RemotePairResponse>(target, '/remote/v1/pair', { method: 'POST', body: { code: pairing.code, deviceName } })
    return { ...target, token: result.token, deviceId: result.deviceId, computerName: result.computer?.name ?? pairing.computerName, deviceName: result.device?.name ?? deviceName, clientKey: relay.clientKey }
  } catch (error) {
    tunnel.close()
    throw error
  }
}

interface TunnelInvite {
  hostKey: string
  code: string
  path: string
  computer?: { name?: string }
  hostFingerprint?: string
}

export async function manualPairInvite(baseUrl: string): Promise<{ invite: TunnelInvite; identity: HostIdentity; code: string } | { error: RemoteHttpError }> {
  try {
    const invite = await request<TunnelInvite>(baseUrl, '/remote/v1/tunnel/invite')
    if (typeof invite.hostKey !== 'string' || typeof invite.code !== 'string') {
      return { error: new RemoteHttpError(0, pick('电脑返回的加密通道信息不对', 'Invalid encrypted channel details from the desktop'), 'tunnel_invalid') }
    }
    const fingerprint = hostFingerprint(invite.hostKey)
    if (typeof invite.hostFingerprint === 'string' && invite.hostFingerprint && invite.hostFingerprint !== fingerprint) {
      return { error: new RemoteHttpError(0, pick('电脑报出的身份指纹和它给出的公钥不一致，可能有人在中间冒充这台电脑；已停止配对。', 'The identity the desktop reported does not match the key it sent. Someone may be impersonating it; pairing stopped.'), 'host_identity_mismatch') }
    }
    const identity = { computer: invite.computer?.name?.slice(0, 60) || baseUrl.replace(/^https?:\/\//, ''), fingerprint }
    return { invite, identity, code: invite.code }
  } catch (error) {
    if (error instanceof RemoteHttpError) return { error }
    throw error
  }
}

function tunnelPairing(baseUrl: string, invite: TunnelInvite, code: string): RelayPairing {
  const direct = directTunnelUrl(baseUrl, invite.path)
  if (!direct || typeof invite.hostKey !== 'string' || typeof invite.code !== 'string') throw new RemoteHttpError(0, pick('电脑返回的加密通道信息不对', 'Invalid encrypted tunnel details from the desktop'))
  return { direct: [direct], hostKey: invite.hostKey, relayCode: invite.code, code, computerName: invite.computer?.name?.slice(0, 60) || baseUrl.replace(/^https?:\/\//, '') }
}

export async function pair(baseUrl: string, code: string, deviceName: string, confirm: (identity: HostIdentity) => Promise<boolean>): Promise<Connection> {
  if (typeof confirm !== 'function') {
    throw new RemoteHttpError(0, pick('手动输入地址配对前必须核对电脑上显示的身份指纹。', 'Pairing by address requires confirming the identity fingerprint shown on the desktop.'), 'identity_confirm_required')
  }
  const preflight = await manualPairInvite(baseUrl)
  if ('error' in preflight) {
    const error = preflight.error
    if (error.status === 404) throw new RemoteHttpError(404, pick('这台电脑的砚版本太旧，还没有加密配对通道；请先在电脑上更新砚。', 'That desktop runs an older Inkstone without the encrypted pairing channel. Update Inkstone on it first.'), 'tunnel_required')
    if (error.status === 401 || error.status === 403) throw new RemoteHttpError(error.status, pick('电脑上没有正在进行的配对，请先在电脑「设置 → 设备连接」生成配对码。', 'No pairing is in progress on the desktop. Generate a code in Settings → Device connection first.'), 'no_pairing')
    throw error
  }
  if (!(await confirm(preflight.identity))) throw new RemoteHttpError(0, pick('已取消：没有确认电脑身份', 'Cancelled: the desktop identity was not confirmed'), 'identity_not_confirmed')
  return pairViaRelay(tunnelPairing(baseUrl, preflight.invite, code), deviceName)
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
  pinned?: boolean
  archivedAt?: number
}

export interface HistoryToolCall {
  id: string
  name: string
  status?: string
  denied?: boolean
  cancelled?: boolean
  args?: unknown
  output?: string
  parentToolCallId?: string
  imageIndexes?: number[]
  startedAt?: number
  endedAt?: number
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant' | 'bash' | 'note' | string
  text?: string
  timestamp?: number
  error?: string
  thinking?: string
  thinkingMs?: number
  bash?: { command: string; exitCode: number | null; cancelled: boolean }
  images?: Array<{ mimeType: string }>
  toolCalls?: HistoryToolCall[]
  artifacts?: Array<{ id: string; filename: string; mediaType: string; kind: string; bytes: number; version?: number; unavailable?: boolean }>
  note?: { kind: 'custom' | 'branchSummary' | string; customType?: string }
  question?: boolean
  qa?: Array<{ question: string; answer?: string }>
}

export interface SubagentInfo {
  id: string
  title: string
  task: string
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
  isolation?: string
  startedAt: number
  endedAt?: number
  endReason?: string
  resumable?: boolean
  model?: string
  thinkingLevel?: string
  toolCalls?: number
  latestActivity?: string
  error?: string
  summary?: string
  tokens?: number
  cost?: number
  review?: RemoteSubagentReview
  diff?: RemoteSubagentDiff
  canMerge?: boolean
  canDiscard?: boolean
}

export interface RemoteProject {
  id: string
  name: string
  cwd: string
}

export interface PlanTodo {
  text: string
  done: boolean
  status?: 'pending' | 'running' | 'done' | 'blocked'
}

export interface HistoryPage {
  messages: HistoryMessage[]
  plan?: { todos: PlanTodo[]; stale: boolean }
  queue?: RemoteQueue
  truncated?: number | boolean
  total?: number
  hasMore?: boolean
  nextBefore?: string
}

const SLOW_REQUEST_MS = 60_000
const COMPACT_REQUEST_MS = 180_000
const UPLOAD_FREE_BYTES = 64 * 1024
const UPLOAD_BYTES_PER_SECOND = 32 * 1024
const UPLOAD_MAX_MS = 180_000

function uploadTimeoutMs(bytes: number): number {
  return Math.min(UPLOAD_MAX_MS, Math.max(SLOW_REQUEST_MS, 30_000 + Math.ceil(bytes / UPLOAD_BYTES_PER_SECOND) * 1000))
}

export class RemoteClient {
  readonly historyCache = new HistoryCache()
  constructor(readonly connection: Connection) {}

  private call<T, A extends RemoteAction = RemoteAction>(action: A, args: RemoteActionArgs[A], options: { key?: string; timeoutMs?: number; bytes?: number } = {}): Promise<T> {
    const upload = options.bytes !== undefined && options.bytes > UPLOAD_FREE_BYTES
    return request<{ data: T }>(this.connection, `${REMOTE_CALL_PREFIX}${action}`, {
      method: 'POST',
      token: this.connection.token,
      body: args,
      idempotencyKey: options.key,
      timeoutMs: upload ? uploadTimeoutMs(options.bytes!) : options.timeoutMs,
      upload
    }).then((result) => result.data)
  }

  private get source(): Record<string, string> {
    return { authorization: `Bearer ${this.connection.token}`, [REMOTE_VERSION_HEADER]: String(REMOTE_PROTOCOL_VERSION) }
  }

  info(): Promise<RemoteInfo> {
    return this.call('info', {})
  }

  status(): Promise<Record<string, unknown>> {
    return this.call('status', {})
  }

  async sessions(): Promise<SessionListItem[]> {
    return (await this.call<{ sessions: SessionListItem[] }>('sessions', {})).sessions
  }

  history(sessionId: string, limit = 60, before?: string): Promise<HistoryPage> {
    return this.call('session.history', { sessionId, limit, ...(before ? { before } : {}) })
  }

  async subagents(sessionId: string): Promise<SubagentInfo[]> {
    return (await this.call<{ runs: SubagentInfo[] }>('session.subagents', { sessionId })).runs
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.call('session.rename', { sessionId, name })
  }

  async stopSubagent(sessionId: string, runId: string): Promise<void> {
    await this.call('subagent.stop', { sessionId, runId }, { key: idempotencyKey() })
  }

  reviewSubagent(sessionId: string, runId: string, action: 'merge' | 'discard', key = idempotencyKey()): Promise<{ id: string; review: string; warning?: string }> {
    return this.call('subagent.review', { sessionId, runId, action, confirm: true }, { key, timeoutMs: SLOW_REQUEST_MS })
  }

  async sendSubagent(sessionId: string, runId: string, text: string, key = idempotencyKey()): Promise<void> {
    await this.call('subagent.send', { sessionId, runId, text }, { key })
  }

  async jobs(sessionId: string): Promise<RemoteJob[]> {
    return (await this.call<{ jobs: RemoteJob[] }>('session.jobs', { sessionId })).jobs
  }

  async stopJob(sessionId: string, jobId: string, key = idempotencyKey()): Promise<void> {
    await this.call('job.stop', { sessionId, jobId }, { key })
  }

  subagentPatch(sessionId: string, runId: string): Promise<RemoteSubagentPatch> {
    return this.call('subagent.patch', { sessionId, runId }, { timeoutMs: SLOW_REQUEST_MS })
  }

  async workflows(sessionId: string): Promise<RemoteWorkflow[]> {
    return (await this.call<{ runs: RemoteWorkflow[] }>('session.workflows', { sessionId })).runs
  }

  async workflowControl(sessionId: string, workflowId: string, action: 'pause' | 'resume' | 'stop', key = idempotencyKey()): Promise<void> {
    await this.call('workflow.control', { sessionId, workflowId, action }, { key })
  }

  quota(): Promise<RemoteQuota> {
    return this.call('quota', {}, { timeoutMs: SLOW_REQUEST_MS })
  }

  usage(range: '7d' | '30d' | 'all' = '7d'): Promise<RemoteUsage> {
    return this.call('usage', { range }, { timeoutMs: SLOW_REQUEST_MS })
  }

  async editQueue(sessionId: string, op: RemoteQueueOp, key = idempotencyKey()): Promise<void> {
    await this.call('session.queue', { sessionId, op }, { key })
  }

  async setSessionFlags(sessionId: string, flags: { pinned?: boolean; archived?: boolean }): Promise<void> {
    await this.call('session.flags', { sessionId, ...flags }, { key: idempotencyKey() })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call('session.delete', { sessionId, confirm: true }, { key: idempotencyKey(), timeoutMs: SLOW_REQUEST_MS })
  }

  async compact(sessionId: string): Promise<void> {
    await this.call('session.compact', { sessionId }, { key: idempotencyKey(), timeoutMs: COMPACT_REQUEST_MS })
  }

  branches(sessionId: string): Promise<{ repo: boolean; branches: Array<{ name: string; current: boolean; busy?: boolean }>; current: string | null }> {
    return this.call('session.branches', { sessionId })
  }

  async switchBranch(sessionId: string, branch: string): Promise<void> {
    await this.call('session.branch', { sessionId, branch }, { key: idempotencyKey(), timeoutMs: SLOW_REQUEST_MS })
  }

  async search(query: string): Promise<Array<{ sessionId: string; snippet: string; matches: number }>> {
    return (await this.call<{ hits: Array<{ sessionId: string; snippet: string; matches: number }> }>('search', { q: query })).hits
  }

  insight(sessionId: string): Promise<RemoteInsight> {
    return this.call('session.insight', { sessionId })
  }

  async questions(): Promise<RemotePendingQuestion[]> {
    return (await this.call<{ questions: RemotePendingQuestion[] }>('questions', {})).questions
  }

  answer(questionId: string, answer: RemoteAnswer, key = idempotencyKey()): Promise<unknown> {
    return this.call('question.answer', { questionId, answer }, { key })
  }

  approve(question: RemotePendingQuestion, confirmed: boolean, key = idempotencyKey(), scope?: 'session'): Promise<unknown> {
    return this.call('question.approval', { questionId: question.id, sessionId: question.sessionId ?? null, runId: question.runId ?? '', digest: question.approvalDigest ?? '', confirmed, ...(scope ? { scope } : {}) }, { key })
  }

  send(sessionId: string, text: string, key = idempotencyKey(), images?: RemoteImageInput[], mode?: 'steer' | 'followUp'): Promise<unknown> {
    const bytes = text.length + (images ?? []).reduce((sum, image) => sum + image.data.length, 0)
    return this.call('session.send', { sessionId, text, ...(images ? { images } : {}), ...(mode ? { mode } : {}) }, { key, bytes })
  }

  async revokeSelf(): Promise<void> {
    await this.call('device.revoke', {})
  }

  renameDevice(name: string): Promise<RemoteDeviceSummary> {
    return this.call('device.rename', { name })
  }

  models(sessionId: string): Promise<{ models: RemoteModel[]; current: RemoteModel | null; thinking?: { level: string; levels: string[] } | null; pending?: boolean }> {
    return this.call('session.models', { sessionId })
  }

  async setModel(sessionId: string, model: RemoteModel, key = idempotencyKey()): Promise<RemoteModel> {
    return (await this.call<{ current: RemoteModel }>('session.model', { sessionId, provider: model.provider, modelId: model.id }, { key })).current
  }

  async setThinking(sessionId: string, level: string, key = idempotencyKey()): Promise<string> {
    return (await this.call<{ level: string }>('session.thinking', { sessionId, level }, { key })).level
  }

  imageSource(sessionId: string, messageId: string, index: number) {
    return { uri: `${this.connection.baseUrl}/remote/v1/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(messageId)}/${index}`, headers: this.source }
  }

  abort(runId: string, key = idempotencyKey()): Promise<unknown> {
    return this.call('run.abort', { runId }, { key })
  }

  async transcribe(wav: string): Promise<string> {
    return (await this.call<{ text: string }>('voice.transcribe', { wav }, { key: idempotencyKey(), bytes: Math.max(wav.length, UPLOAD_FREE_BYTES + 1) })).text
  }

  newSession(projectId?: string, key = idempotencyKey(), worktree = false): Promise<{ sessionId?: string }> {
    return this.call('session.new', { ...(projectId ? { projectId } : {}), ...(worktree ? { worktree: true } : {}) }, { key, timeoutMs: worktree ? SLOW_REQUEST_MS : undefined })
  }

  artifactSource(sessionId: string, artifactId: string): { uri: string; headers: Record<string, string> } {
    return {
      uri: `${this.connection.baseUrl}/remote/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
      headers: this.source
    }
  }

  async resolveSource(source: { uri: string; headers: Record<string, string> }): Promise<{ uri: string; headers?: Record<string, string> }> {
    const path = source.uri.slice(this.connection.baseUrl.length)
    const res = await RelayTunnel.for(this.connection.relay).request('GET', path, { headers: source.headers, timeoutMs: 60_000 })
    if (res.status !== 200) throw new RemoteHttpError(res.status, pick('读取图片失败', 'Failed to load image'))
    return { uri: `data:${res.headers['content-type'] ?? 'application/octet-stream'};base64,${res.base64}` }
  }

  async artifactText(sessionId: string, artifactId: string): Promise<string> {
    const source = this.artifactSource(sessionId, artifactId)
    const maxBytes = 2 * 1024 * 1024
    const res = await RelayTunnel.for(this.connection.relay).request('GET', source.uri.slice(this.connection.baseUrl.length), { headers: source.headers, timeoutMs: 60_000 })
    if (res.status !== 200) throw new RemoteHttpError(res.status, pick('读取成果失败', 'Failed to load artifact'))
    if (res.byteLength > maxBytes) throw new RemoteHttpError(res.status, pick('成果文本超过 2 MiB，无法在手机端预览', 'Text over 2 MiB cannot be previewed on mobile'))
    return res.text
  }
}

export type StreamState = 'connecting' | 'open' | 'reconnecting'

export interface EventStreamHandlers {
  onEvent(event: RemoteEventEnvelope): void
  onResync(event: RemoteResyncEvent): void
  onState(state: StreamState): void
  onUnauthorized(): void
}

export const EVENT_IDLE_MS = 65_000
export const EVENT_WATCH_MS = 10_000
export const EVENT_WAKE_STALE_MS = 20_000

export class RemoteEventStream {
  private cancelRelay: (() => void) | null = null
  private lastSeq = 0
  private buffer = ''
  private retryMs = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private epoch = 0
  private lastActivity = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly connection: Connection,
    private readonly handlers: EventStreamHandlers,
    private readonly clock: { now(): number } = Date
  ) {}

  start(): void {
    this.stopped = false
    this.lastActivity = this.clock.now()
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkIdle(), EVENT_WATCH_MS)
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.epoch++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.cancelRelay?.()
    this.cancelRelay = null
  }

  wake(): void {
    if (this.stopped) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.retryMs = 1000
      this.open()
      return
    }
    if (this.clock.now() - this.lastActivity > EVENT_WAKE_STALE_MS) this.reconnectNow()
  }

  private checkIdle(): void {
    if (this.stopped || this.retryTimer) return
    if (this.clock.now() - this.lastActivity > EVENT_IDLE_MS) this.reconnectNow()
  }

  private reconnectNow(): void {
    if (this.stopped) return
    this.epoch++
    const cancel = this.cancelRelay
    this.cancelRelay = null
    cancel?.()
    RelayTunnel.for(this.connection.relay).reset()
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.retryMs = 1000
    this.open()
  }

  private rotating = false

  private open(): void {
    if (this.stopped) return
    if (this.rotating) this.rotating = false
    else this.handlers.onState(this.lastSeq > 0 ? 'reconnecting' : 'connecting')
    this.lastActivity = this.clock.now()
    const epoch = this.epoch
    this.openRelay(this.connection.relay, epoch)
  }

  private openRelay(relay: RelayConfig, epoch: number): void {
    this.buffer = ''
    let received = 0
    this.cancelRelay = RelayTunnel.for(relay).stream(`/remote/v1/events?since=${this.lastSeq}`, { authorization: `Bearer ${this.connection.token}`, accept: 'text/event-stream', [REMOTE_VERSION_HEADER]: String(REMOTE_PROTOCOL_VERSION) }, {
      onStart: (status) => {
        if (this.stopped || this.epoch !== epoch) return
        this.lastActivity = this.clock.now()
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
        if (this.stopped || this.epoch !== epoch) return
        this.lastActivity = this.clock.now()
        received += text.length
        this.consumeText(text)
        if (!this.stopped && received >= 1_000_000) {
          this.rotating = true
          this.cancelRelay?.()
          this.cancelRelay = null
          this.rotate()
        }
      },
      onEnd: (error) => {
        if (this.epoch !== epoch) return
        this.cancelRelay = null
        if (error instanceof RelayError && error.denied && !this.stopped) {
          this.stopped = true
          this.handlers.onUnauthorized()
          return
        }
        if (this.stopped || this.rotating) return
        this.scheduleReconnect()
      }
    })
  }

  private rotate(): void {
    if (this.stopped || this.retryTimer) return
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
    this.handlers.onState('reconnecting')
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, 30_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }
}
