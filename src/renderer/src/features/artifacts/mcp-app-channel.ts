/**
 * MCP App 的渲染端消息桥（A6-frame-ui）。
 *
 * 它只做一件事：把**受控 iframe** 里 App 发来的 JSON-RPC 消息，经身份核对后转给
 * 宿主注入的 `dispatch(instanceId, message)`，再把宿主的结果原样回给 App。
 * 授权、审批与工具执行都在宿主侧，渲染端**不判工具、不山寨协议、不伪造批准**。
 *
 * ── 这里承担的安全边界 ──
 *   · 只收「本组件当前 iframe 的 contentWindow」且 origin 为 opaque（`"null"`）的消息；
 *     其它窗口发来的消息一律丢弃，也不能抢初始化；
 *   · 每次 load/reload 递增实例序号：重置握手、去重集合与限速窗口，旧代次的
 *     迟到应答不再回投；
 *   · 未握手完成前，敏感方法（`tools/call` / `resources/read` /
 *     `ui/resource-teardown`）本地拒绝，不转宿主；
 *   · 单条 ≤ 1 MiB、≤ 50 条/秒；重复 id 只执行一次；`__proto__` 等键在转发前剔除；
 *   · MessagePort 只在**已验证 source + 初始化阶段**被采纳，并绑定到当前代次，
 *     不挂到任何全局；卸载时关闭并移除监听。
 *
 * ⚠️ 离线 PoC：`dispatch` 是否覆盖全部官方方法、真实 App 是否使用 MessagePort，
 * 都待真实 App 验收；这里只保证「不初始化不放行、未知方法交宿主显式 unsupported」。
 */
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

/* ─────────────────────────────────────────────── 注入点（都可假实现） */

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

/** iframe 的 contentWindow 只需能收 postMessage。 */
export interface McpAppFrameWindowLike {
  postMessage(message: unknown, targetOrigin: string): void
}

/** 宿主注入的权威派发口；渲染端只传 instanceId 与 JSON-RPC 消息。 */
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
  /** 宿主返回的结果已回投给 App；可用于界面提示，不改变授权。 */
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
  /** 期望 origin，缺省 opaque `"null"`。测试可注入。 */
  expectedOrigin?: () => string
  /**
   * 受信宿主上下文读取口（主进程按 instance / owner / generation 返回，与
   * `ui/initialize` 同源）。只有它返回对象才会推 `host-context-changed`；渲染端不
   * 自造主题、也不把本地主题当授权身份。缺省（桥未装配）则不推任何主题通知。
   */
  loadHostContext?: () => Promise<unknown>
}

interface PendingRequest {
  readonly generation: number
  readonly method: string
  readonly id: string | number | null
  readonly hasId: boolean
}

/* ─────────────────────────────────────────────── 通道 */

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
  /* 主题跟读：同一代内只认最后一次请求；未就绪时只记「有最新待发」。 */
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

  /** 挂上 window 监听；幂等。iframe 装载前调用一次即可。 */
  attach(): void {
    if (this.closed || this.attached) return
    this.attached = true
    this.listener = (event) => this.handleWindowMessage(event)
    this.window.addEventListener('message', this.listener)
  }

  /**
   * 新的一代：iframe load/reload 时调用。
   * 重置握手与去重，丢弃旧 MessagePort，清空限速窗口；未完成的旧 dispatch
   * 应答因 generation 不符被丢弃。
   */
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

  /** 卸载：移除 window/port 监听、关闭 port、标记关闭；之后的迟到应答不再回投。 */
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

  /** 宿主 → App 的通知（如 tool-result / host-context-changed）；未就绪时不发。 */
  pushHostNotification(method: string, params?: unknown): boolean {
    if (this.closed || this.phase !== 'ready') return false
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.sendToFrame(message)
    return true
  }

  /**
   * 请求刷新宿主上下文：就绪时取受信 `hostContext` 并推
   * `ui/notifications/host-context-changed`；未就绪只记「有最新待发」，握手完成
   * （`ui/initialize` 合法结果）后补发。同一代内只认最后一次请求：旧异步回包在换代 /
   * 关闭 / 被更新请求覆盖时一律丢弃。只读取宿主下发的上下文，不执行工具。
   */
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
    /* 关闭 / 换代 / 已被更新请求覆盖：迟到回包不投递。 */
    if (this.closed || generation !== this.generation) return
    if (requestId !== this.hostContextRequest) return
    if (this.phase !== 'ready') {
      this.hostContextPending = true
      return
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) return
    this.pushHostNotification(MCP_APP_METHODS.hostContextChanged, context)
  }

  /* ── 收 ── */

  private handleWindowMessage(event: McpAppMessageEvent): void {
    if (this.closed) return
    /* opaque origin 不是信任：必须确实是本实例当前的 contentWindow。 */
    if (!isExpectedMcpAppOrigin(event.origin) || event.origin !== this.expectedOrigin()) {
      this.hooks.onRejected?.('origin', null)
      return
    }
    const frame = this.getFrame()
    if (!frame || event.source !== frame) {
      /* opaque origin 不是信任：必须确实是本实例当前的 contentWindow。 */
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
    /* 只在初始化阶段、且来源已验证时采纳一次 MessagePort。 */
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
    /* 端口消息已在采纳时绑定到代次，这里不再重复做 source/origin 判定。 */
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
      /* App 的 initialized 通知**不**能把通道直接点成 ready：只有宿主对
       * `ui/initialize` 返回合法 result 信封才放行。这里只当已就绪后的幂等确认。 */
      return
    }

    /* 除 initialize / initialized / size 外，握手完成前一律本地拒绝。 */
    if (this.phase !== 'ready' && kind !== 'initialize') {
      this.hooks.onRejected?.('not-ready', method)
      if (hasId) this.respondError(id, -32002, 'App 视图尚未完成初始化')
      return
    }

    if (fromPort && !this.port) {
      /* 端口已在本代被丢弃，忽略它的迟到消息。 */
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
    /* 关键：只有 host 能决定结果；渲染端不自行执行任何工具。 */
    this.api.dispatch(this.instanceId, toHostDispatchMessage(message)).then(
      (result) => this.settle(pending, result, undefined),
      (error) => this.settle(pending, undefined, error)
    )
  }

  private settle(pending: PendingRequest, result: unknown, error: unknown): void {
    /* 关闭 / 换代后的迟到应答：丢弃，不回投。 */
    if (this.closed || pending.generation !== this.generation) return
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '宿主处理失败'
      this.hooks.onRejected?.('host-error', pending.method)
      if (pending.hasId) this.respondError(pending.id, -32603, message)
      return
    }

    /* 宿主返回的必须是规范 JSON-RPC 2.0 信封（单层）；裸对象 / 错 id / 畸形一律失败。 */
    const envelope = parseMcpAppHostEnvelope(result, { hasId: pending.hasId, id: pending.id })
    if (!envelope.ok) {
      this.hooks.onRejected?.('invalid-host', pending.method)
      if (pending.hasId) this.respondError(pending.id, -32603, '宿主返回了无法识别的响应')
      return
    }

    /* host error 保留在顶层 error：不回投字节，也**不**因 Promise resolve 就进 ready。 */
    if (envelope.kind === 'error') {
      /* 通知不产生伪响应；请求原样回投 host 信封一次。 */
      if (pending.hasId) this.sendToFrame(result)
      this.hooks.onHostResult?.(pending.method, result)
      return
    }

    /* 合法 result：只有带 id 的 initialize 才放行 ready。 */
    if (pending.method === 'ui/initialize') {
      if (pending.hasId) this.setPhase(nextMcpAppPhase(this.phase, 'initialize-ok'))
      /* 握手前攒下的主题变更：就绪后补取一次宿主上下文并推送。 */
      if (this.phase === 'ready' && this.hostContextPending) {
        this.hostContextPending = false
        this.requestHostContext()
      }
    }
    if (pending.hasId) this.sendToFrame(result)
    this.hooks.onHostResult?.(pending.method, result)
  }

  /* ── 发 ── */

  private respondError(id: string | number | null, code: number, message: string): void {
    this.sendToFrame({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /**
   * 回投给 App。targetOrigin 只能是 `'*'`：App 是 opaque origin，没有可用的具体
   * origin 可指定；安全性由入口的 `event.source === frame.contentWindow` 保证。
   */
  private sendToFrame(message: unknown): void {
    if (this.port) {
      this.port.postMessage(message)
      return
    }
    this.getFrame()?.postMessage(message, '*')
  }

  /* ── MessagePort ── */

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

  /* ── 杂项 ── */

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
