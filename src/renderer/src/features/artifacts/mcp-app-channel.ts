import { BridgeRateLimiter } from './model'
import { MCP_APP_METHODS } from '../../../../shared/mcp-app-methods'
import {
  clampMcpAppSize,
  classifyMcpAppMethod,
  decodeMcpAppMessage,
  isExpectedMcpAppOrigin,
  mcpAppDedupKey,
  nextMcpAppPhase,
  parseMcpAppHostEnvelope,
  toHostDispatchMessage,
  type McpAppChannelPhase,
  type McpAppDecodeError
} from './mcp-app-frame-model'

export interface McpAppPortLike {
  postMessage(message: unknown): void
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

export interface McpAppMessageEvent {
  readonly data: unknown
  readonly origin: string
  readonly source: unknown
  readonly ports?: readonly McpAppPortLike[]
}

export interface McpAppWindowLike {
  addEventListener(type: 'message', listener: (event: McpAppMessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: McpAppMessageEvent) => void): void
}

export interface McpAppFrameWindowLike {
  postMessage(message: unknown, targetOrigin: string): void
}

export interface McpAppDispatchApi {
  dispatch(instanceId: string, message: unknown): Promise<unknown>
}

export type McpAppRejectReason =
  | McpAppDecodeError
  | 'origin'
  | 'source'
  | 'limit'
  | 'duplicate'
  | 'not-ready'
  | 'host-error'
  | 'invalid-host'
  | 'closed'

export interface McpAppChannelHooks {
  onPhase?(phase: McpAppChannelPhase): void
  onSizeChanged?(height: number): void
  onRejected?(reason: McpAppRejectReason, method: string | null): void
  onHostResult?(method: string, result: unknown): void
}

export interface McpAppChannelOptions {
  instanceId: string
  api: McpAppDispatchApi
  window: McpAppWindowLike
  getFrame: () => McpAppFrameWindowLike | null
  hooks?: McpAppChannelHooks
  now?: () => number
  limiter?: BridgeRateLimiter
  expectedOrigin?: () => string
  loadHostContext?: () => Promise<unknown>
}

interface PendingRequest {
  readonly generation: number
  readonly method: string
  readonly id: string | number | null
  readonly hasId: boolean
}

export class McpAppChannel {
  private readonly instanceId: string
  private readonly api: McpAppDispatchApi
  private readonly window: McpAppWindowLike
  private readonly getFrame: () => McpAppFrameWindowLike | null
  private readonly hooks: McpAppChannelHooks
  private readonly now: () => number
  private readonly limiter: BridgeRateLimiter
  private readonly expectedOrigin: () => string
  private readonly loadHostContext?: () => Promise<unknown>

  private generation = 0
  private phase: McpAppChannelPhase = 'idle'
  private closed = false
  private attached = false
  private listener: ((event: McpAppMessageEvent) => void) | null = null
  private port: McpAppPortLike | null = null
  private portListener: ((event: { data: unknown }) => void) | null = null
  private hostContextRequest = 0
  private hostContextPending = false
  private readonly seen = new Set<string>()
  private readonly phaseListeners = new Set<(phase: McpAppChannelPhase) => void>()

  constructor(options: McpAppChannelOptions) {
    this.instanceId = options.instanceId
    this.api = options.api
    this.window = options.window
    this.getFrame = options.getFrame
    this.hooks = options.hooks ?? {}
    this.now = options.now ?? (() => Date.now())
    this.limiter = options.limiter ?? new BridgeRateLimiter()
    this.expectedOrigin = options.expectedOrigin ?? (() => 'null')
    this.loadHostContext = options.loadHostContext
  }

  getPhase(): McpAppChannelPhase {
    return this.phase
  }

  getGeneration(): number {
    return this.generation
  }

  subscribe(listener: (phase: McpAppChannelPhase) => void): () => void {
    this.phaseListeners.add(listener)
    return () => {
      this.phaseListeners.delete(listener)
    }
  }

  attach(): void {
    if (this.closed || this.attached) return
    this.attached = true
    this.listener = (event) => this.handleWindowMessage(event)
    this.window.addEventListener('message', this.listener)
  }

  nextGeneration(): number {
    if (this.closed) return this.generation
    this.generation += 1
    this.seen.clear()
    this.limiter.reset()
    this.hostContextPending = false
    this.dropPort()
    this.setPhase(nextMcpAppPhase(this.phase, 'reset'))
    return this.generation
  }

  dispose(): void {
    if (this.closed) return
    if (this.listener) {
      this.window.removeEventListener('message', this.listener)
      this.listener = null
    }
    this.dropPort()
    this.closed = true
    this.hostContextPending = false
    this.setPhase(nextMcpAppPhase(this.phase, 'close'))
  }

  pushHostNotification(method: string, params?: unknown): boolean {
    if (this.closed || this.phase !== 'ready') return false
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.sendToFrame(message)
    return true
  }

  requestHostContext(): void {
    if (this.closed) return
    const load = this.loadHostContext
    if (!load) return
    if (this.phase !== 'ready') {
      this.hostContextPending = true
      return
    }
    const generation = this.generation
    const requestId = (this.hostContextRequest += 1)
    let loaded: Promise<unknown>
    try {
      loaded = Promise.resolve(load())
    } catch {
      return
    }
    void loaded.then(
      (context) => this.settleHostContext(generation, requestId, context),
      () => undefined
    )
  }

  private settleHostContext(generation: number, requestId: number, context: unknown): void {
    if (this.closed || generation !== this.generation) return
    if (requestId !== this.hostContextRequest) return
    if (this.phase !== 'ready') {
      this.hostContextPending = true
      return
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) return
    this.pushHostNotification(MCP_APP_METHODS.hostContextChanged, context)
  }

  private handleWindowMessage(event: McpAppMessageEvent): void {
    if (this.closed) return
    if (!isExpectedMcpAppOrigin(event.origin) || event.origin !== this.expectedOrigin()) {
      this.hooks.onRejected?.('origin', null)
      return
    }
    const frame = this.getFrame()
    if (!frame || event.source !== frame) {
      this.hooks.onRejected?.('source', null)
      return
    }
    if (!this.allowNow()) {
      this.hooks.onRejected?.('limit', null)
      return
    }
    const decoded = decodeMcpAppMessage(event.data)
    if (!decoded.ok) {
      this.hooks.onRejected?.(decoded.error, null)
      return
    }
    const { method } = decoded.message
    if (method === 'ui/initialize') this.maybeAdoptPort(event)
    this.dispatchMessage(method, decoded.message.id, decoded.message.hasId, decoded.message.params, false)
  }

  private handlePortMessage(event: { data: unknown }): void {
    if (this.closed) return
    if (!this.allowNow()) {
      this.hooks.onRejected?.('limit', null)
      return
    }
    const decoded = decodeMcpAppMessage(event.data)
    if (!decoded.ok) {
      this.hooks.onRejected?.(decoded.error, null)
      return
    }
    this.dispatchMessage(decoded.message.method, decoded.message.id, decoded.message.hasId, decoded.message.params, true)
  }

  private dispatchMessage(
    method: string,
    id: string | number | null,
    hasId: boolean,
    params: Record<string, unknown> | null,
    fromPort: boolean
  ): void {
    const kind = classifyMcpAppMethod(method)

    if (kind === 'size') {
      const raw = params && typeof params.height === 'number' ? params.height : null
      const height = clampMcpAppSize(raw)
      if (height !== null) this.hooks.onSizeChanged?.(height)
      return
    }

    if (kind === 'initialized') {
      return
    }

    if (this.phase !== 'ready' && kind !== 'initialize') {
      this.hooks.onRejected?.('not-ready', method)
      if (hasId) this.respondError(id, -32002, 'App 视图尚未完成初始化')
      return
    }

    if (fromPort && !this.port) {
      return
    }

    const message = { method, id, hasId, params }
    if (hasId) {
      const key = mcpAppDedupKey(this.generation, id as string | number)
      if (this.seen.has(key)) {
        this.hooks.onRejected?.('duplicate', method)
        return
      }
      this.seen.add(key)
    }

    if (kind === 'initialize') this.setPhase(nextMcpAppPhase(this.phase, 'initialize'))

    const pending: PendingRequest = { generation: this.generation, method, id, hasId }
    this.api.dispatch(this.instanceId, toHostDispatchMessage(message)).then(
      (result) => this.settle(pending, result, undefined),
      (error) => this.settle(pending, undefined, error)
    )
  }

  private settle(pending: PendingRequest, result: unknown, error: unknown): void {
    if (this.closed || pending.generation !== this.generation) return
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '宿主处理失败'
      this.hooks.onRejected?.('host-error', pending.method)
      if (pending.hasId) this.respondError(pending.id, -32603, message)
      return
    }

    const envelope = parseMcpAppHostEnvelope(result, { hasId: pending.hasId, id: pending.id })
    if (!envelope.ok) {
      this.hooks.onRejected?.('invalid-host', pending.method)
      if (pending.hasId) this.respondError(pending.id, -32603, '宿主返回了无法识别的响应')
      return
    }

    if (envelope.kind === 'error') {
      if (pending.hasId) this.sendToFrame(result)
      this.hooks.onHostResult?.(pending.method, result)
      return
    }

    if (pending.method === 'ui/initialize') {
      if (pending.hasId) this.setPhase(nextMcpAppPhase(this.phase, 'initialize-ok'))
      if (this.phase === 'ready' && this.hostContextPending) {
        this.hostContextPending = false
        this.requestHostContext()
      }
    }
    if (pending.hasId) this.sendToFrame(result)
    this.hooks.onHostResult?.(pending.method, result)
  }

  private respondError(id: string | number | null, code: number, message: string): void {
    this.sendToFrame({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private sendToFrame(message: unknown): void {
    if (this.port) {
      this.port.postMessage(message)
      return
    }
    this.getFrame()?.postMessage(message, '*')
  }

  private maybeAdoptPort(event: McpAppMessageEvent): void {
    if (this.port || this.phase === 'ready') return
    const port = event.ports?.[0]
    if (!port || typeof port.postMessage !== 'function') return
    this.port = port
    if (port.addEventListener) {
      this.portListener = (messageEvent) => this.handlePortMessage(messageEvent)
      port.addEventListener('message', this.portListener)
    }
    port.start?.()
  }

  private dropPort(): void {
    if (this.port && this.portListener && this.port.removeEventListener) {
      this.port.removeEventListener('message', this.portListener)
    }
    this.portListener = null
    this.port?.close?.()
    this.port = null
  }

  private allowNow(): boolean {
    return this.limiter.allow(this.now())
  }

  private setPhase(phase: McpAppChannelPhase): void {
    if (phase === this.phase) return
    this.phase = phase
    this.hooks.onPhase?.(phase)
    for (const listener of this.phaseListeners) listener(phase)
  }
}
