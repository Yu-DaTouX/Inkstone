/**
 * MCP App 沙箱框与渲染端消息桥的**纯逻辑**（A6-frame-ui）。
 *
 * 只放不碰 React、不碰真实 `window` 的判定：受控地址、静态 sandbox/allow、
 * JSON-RPC 形状与体积、方法分类、握手状态、去重与限速的决策件。
 * `mcp-app-channel.ts` 只负责把这些判定接到一个可注入的 window/frame 上，
 * 因此都能在 Node 里用假 window 直接测（`scripts/test-mcp-app-frame.mjs`）。
 *
 * ── 安全立场 ──
 *   · `src` 只认 `inkstone-app://<hash>/<实例>/index.html`（`parseMcpAppUrl`），
 *     任意 http(s)/file/data/自定义地址一律拒绝；
 *   · sandbox 只有 `allow-scripts`，**永不**加 `allow-same-origin`；iframe 是
 *     opaque origin（`null`），但那**不是信任**——还要比对 `event.source` 与
 *     每代实例序号；
 *   · 渲染端不自造协议：方法名以 `src/main/mcp/app-spec.ts` 为唯一来源，这里
 *     只是离线镜像（渲染端不能 import main）；真正的授权、审批与工具执行一律
 *     由宿主 `dispatch` 处理为权威。
 *
 * ⚠️ 离线 PoC：MCP Apps 规范字段（方法名、`ui/initialize` 形状）尚未联网核对，
 * 只保证与 `app-spec` 镜像一致，不宣称与真实第三方 App 兼容。
 */
import { BRIDGE_MESSAGE_LIMIT_BYTES, BRIDGE_SIZE_MAX, BRIDGE_SIZE_MIN } from './model'
import { MCP_APP_METHODS } from '../../../../shared/mcp-app-methods'
import { MCP_APP_SANDBOX, parseMcpAppUrl, type McpAppUrl } from '../../../../shared/mcp-app-preview'

/* ─────────────────────────────────────────────── 静态属性 */

/** 与 `shared/mcp-app-preview` 同源：只有脚本，无 `allow-same-origin`。 */
export const MCP_APP_FRAME_SANDBOX = MCP_APP_SANDBOX

/**
 * iframe `allow` 属性：显式把宿主能力全关。
 * 与 `MCP_APP_PERMISSIONS_POLICY` 语义一致，只是 `allow` 属性用分号分隔。
 */
export const MCP_APP_FRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"

/** App 页面一律不发 referrer。 */
export const MCP_APP_FRAME_REFERRER_POLICY = 'no-referrer' as const

/** sandbox 只能是这个值；任何含 `allow-same-origin` 的输入都判不安全。 */
export function isSafeMcpAppSandbox(sandbox: string): boolean {
  return sandbox === MCP_APP_SANDBOX && !sandbox.includes('allow-same-origin')
}

/** `allow` 属性里不得出现任何放行的特性（`*` 或缺少 `'none'` 都拒绝）。 */
export function isSafeMcpAppAllow(allow: string): boolean {
  return allow === MCP_APP_FRAME_ALLOW
}

/** 受控地址判定：必须能解析出「固定哈希 host + 随机实例目录 + index.html」。 */
export function isMcpAppFrameUrl(src: string): boolean {
  return parseMcpAppUrl(src) !== null
}

export function parseMcpAppFrameUrl(src: string): McpAppUrl | null {
  return parseMcpAppUrl(src)
}

/**
 * sandboxed iframe 的期望 origin 字面量。
 * `allow-scripts` 无 `allow-same-origin` → opaque origin，序列化成字符串 `"null"`。
 * 这只是**必要条件**：真正的身份仍由 `event.source === frame.contentWindow` 保证。
 */
export const MCP_APP_OPAQUE_ORIGIN = 'null'

export function isExpectedMcpAppOrigin(origin: string): boolean {
  return origin === MCP_APP_OPAQUE_ORIGIN
}

/** 每代（每次 load/reload）唯一的框键；切代即重置握手、去重与限速。 */
export function mcpAppFrameKey(instanceId: string, generation: number): string {
  return `${instanceId}#${generation}`
}

/* ─────────────────────────────────────────────── 方法镜像 */

/**
 * `ui/*` 与 App 域方法名。
 *
 * 唯一来源是 `src/shared/mcp-app-methods.ts`（主进程 `app-spec.ts` 同源 re-export），
 * 渲染端不再自己镜像一份；此处再 export，保持既有引用点不变。
 */
export { MCP_APP_METHODS }

export type McpAppMethodKind =
  /** 握手请求；结果由宿主下发 `hostContext`。 */
  | 'initialize'
  /** 握手完成通知；只改本地状态，不转宿主。 */
  | 'initialized'
  /** 尺寸通知；只在本帧 clamp，不转宿主、不动系统窗口。 */
  | 'size'
  /** 需要宿主授权/执行的敏感方法：握手完成前一律本地拒绝。 */
  | 'sensitive'
  /** 其余（含未知）方法：交宿主显式处理（未知由宿主报 unsupported）。 */
  | 'host'

/** 握手完成前必须拒绝的方法；绝不本地「放行」。 */
export const MCP_APP_SENSITIVE_METHODS: readonly string[] = [
  MCP_APP_METHODS.toolsCall,
  MCP_APP_METHODS.resourcesRead,
  MCP_APP_METHODS.resourceTeardown
]

export function isMcpAppSensitiveMethod(method: string): boolean {
  return MCP_APP_SENSITIVE_METHODS.includes(method)
}

export function classifyMcpAppMethod(method: string): McpAppMethodKind {
  switch (method) {
    case MCP_APP_METHODS.initialize:
      return 'initialize'
    case MCP_APP_METHODS.initialized:
      return 'initialized'
    case MCP_APP_METHODS.sizeChanged:
      return 'size'
    case MCP_APP_METHODS.toolsCall:
    case MCP_APP_METHODS.resourcesRead:
    case MCP_APP_METHODS.resourceTeardown:
      return 'sensitive'
    default:
      return 'host'
  }
}

/* ─────────────────────────────────────────────── 握手状态 */

export type McpAppChannelPhase = 'idle' | 'initializing' | 'ready' | 'closed'

/**
 * 握手状态机事件。
 *
 * `initialized`（App 的 `ui/notifications/initialized`）**不再是**一个能进
 * `ready` 的事件：只有宿主对 `ui/initialize` 返回了**合法 result 信封**之后
 * （`initialize-ok`）才放行。这样 host 拒绝 / 缺 id / 畸形应答都不会误进 ready。
 */
export type McpAppPhaseEvent = 'initialize' | 'initialize-ok' | 'close' | 'reset'

/** 禁止由 `idle`/`initializing` 直接跳到 `ready` 之外的非法迁移。 */
export function nextMcpAppPhase(phase: McpAppChannelPhase, event: McpAppPhaseEvent): McpAppChannelPhase {
  if (phase === 'closed') return 'closed'
  switch (event) {
    case 'reset':
      return 'idle'
    case 'close':
      return 'closed'
    case 'initialize':
      return phase === 'ready' ? 'ready' : 'initializing'
    case 'initialize-ok':
      /* 只有等待宿主 initialize 应答时才能转 ready；idle 不会被通知直接点亮。 */
      return phase === 'initializing' ? 'ready' : phase
  }
}

/* ─────────────────────────────────────────────── 宿主应答信封 */

/**
 * 宿主 `dispatch` 返回的**规范 JSON-RPC 2.0 信封**校验结果。
 *
 * 宿主已经返回完整 `{jsonrpc:'2.0',id,result|error}`；渲染端**原样回投一次**，
 * 绝不再套一层 `{result:{...}}`。裸对象、缺版本、result/error 同时或都缺、
 * 请求 id 不匹配都判失败（不放行、不进 ready）。
 */
export type McpAppHostEnvelope =
  | { ok: true; kind: 'result'; id: unknown; result: unknown }
  | { ok: true; kind: 'error'; id: unknown; error: unknown }
  | { ok: false; error: 'malformed' | 'id' }

export function parseMcpAppHostEnvelope(
  raw: unknown,
  expected: { hasId: boolean; id: string | number | null }
): McpAppHostEnvelope {
  if (!isPlainObject(raw)) return { ok: false, error: 'malformed' }
  if (raw.jsonrpc !== '2.0') return { ok: false, error: 'malformed' }
  const hasResult = Object.prototype.hasOwnProperty.call(raw, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(raw, 'error')
  if (hasResult === hasError) return { ok: false, error: 'malformed' }
  if (expected.hasId && raw.id !== expected.id) return { ok: false, error: 'id' }
  return hasResult
    ? { ok: true, kind: 'result', id: raw.id, result: raw.result }
    : { ok: true, kind: 'error', id: raw.id, error: raw.error }
}

/* ─────────────────────────────────────────────── 消息解码 */

/** 单条消息体积上限，与成果桥一致（1 MiB）。 */
export const MCP_APP_MESSAGE_LIMIT_BYTES = BRIDGE_MESSAGE_LIMIT_BYTES

export type McpAppDecodeError = 'shape' | 'size' | 'method'

export interface McpAppIncomingMessage {
  readonly method: string
  /** 请求 id；通知为 `null`。 */
  readonly id: string | number | null
  readonly hasId: boolean
  readonly params: Record<string, unknown> | null
}

export type McpAppMessageDecode = { ok: true; message: McpAppIncomingMessage } | { ok: false; error: McpAppDecodeError }

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_SANITIZE_DEPTH = 16
const APP_JSONRPC_ID = /^[\w.:-]{1,128}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 深拷贝并剔除 `__proto__` / `constructor` / `prototype`。
 * JSON.parse 出来的 `__proto__` 是自有属性，不会直接污染原型；但一旦有人浅拷贝
 * 或 `Object.assign`，就会变成原型污染。转发给宿主的消息只保留安全副本。
 */
export function sanitizeMcpAppValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return null
  if (Array.isArray(value)) return value.map((item) => sanitizeMcpAppValue(item, depth + 1))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue
      out[key] = sanitizeMcpAppValue(value[key], depth + 1)
    }
    return out
  }
  return value
}

/** 消息体的 UTF-8 字节数（与主进程 `Buffer.byteLength(...,'utf8')` 近似）。 */
export function mcpAppMessageBytes(raw: unknown): number {
  if (typeof raw === 'string') return utf8Bytes(raw)
  try {
    return utf8Bytes(JSON.stringify(raw) ?? '')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}

/**
 * 解码一条来自 App 的消息。
 *
 * 只接受 JSON-RPC 2.0 请求/通知形状：`jsonrpc` 省略或 `'2.0'`，`method` 是非空字符串，
 * `params` 是对象/缺省，`id` 是字符串/数字/缺省。**不在这里判方法白名单**——
 * 未知方法照样交给宿主（宿主显式 unsupported），渲染端不自造语义。
 */
export function decodeMcpAppMessage(raw: unknown, options: { maxBytes?: number } = {}): McpAppMessageDecode {
  if (!isPlainObject(raw)) return { ok: false, error: 'shape' }
  const maxBytes = options.maxBytes ?? MCP_APP_MESSAGE_LIMIT_BYTES
  if (mcpAppMessageBytes(raw) > maxBytes) return { ok: false, error: 'size' }

  const jsonrpc = raw.jsonrpc
  if (jsonrpc !== undefined && jsonrpc !== '2.0') return { ok: false, error: 'shape' }
  const method = raw.method
  if (typeof method !== 'string' || method.length === 0 || method.length > 128) return { ok: false, error: 'method' }

  const rawId = raw.id
  let id: string | number | null = null
  let hasId = false
  if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    id = rawId
    hasId = true
  } else if (typeof rawId === 'string' && APP_JSONRPC_ID.test(rawId)) {
    id = rawId
    hasId = true
  } else if (rawId !== null && rawId !== undefined) {
    /* 结构不对的 id 不静默当通知：拒绝，避免「同一请求」因 id 被丢弃而重复执行。 */
    return { ok: false, error: 'shape' }
  }

  const rawParams = raw.params
  if (rawParams !== undefined && rawParams !== null && !isPlainObject(rawParams)) return { ok: false, error: 'shape' }
  const params = rawParams === undefined || rawParams === null ? null : (sanitizeMcpAppValue(rawParams) as Record<string, unknown>)

  return { ok: true, message: { method, id, hasId, params } }
}

/** 转发给宿主的规范化 JSON-RPC：只保留 method/id/params，丢弃夹带字段。 */
export function toHostDispatchMessage(message: McpAppIncomingMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { jsonrpc: '2.0', method: message.method }
  if (message.hasId) out.id = message.id
  if (message.params) out.params = message.params
  return out
}

/** 跨代去重键：不同实例/代次里相同 id 不算重复。 */
export function mcpAppDedupKey(generation: number, id: string | number): string {
  return `${generation}\u0000${String(id)}`
}

/* ─────────────────────────────────────────────── 尺寸与审计展示 */

/** size 通知只 clamp 到安全范围；不改变系统窗口，也不改其它框架。 */
export function clampMcpAppSize(height: unknown): number | null {
  if (typeof height !== 'number' || !Number.isFinite(height)) return null
  return Math.max(BRIDGE_SIZE_MIN, Math.min(BRIDGE_SIZE_MAX, Math.ceil(height)))
}

export type McpAppAuditPhase = 'requested' | 'denied' | 'approved' | 'completed' | 'error'

export type McpAppAuditTone = 'neutral' | 'ask' | 'ok' | 'err'

/** 审计阶段 → 列表色调；只用于展示，不参与授权。 */
export function auditPhaseTone(phase: McpAppAuditPhase): McpAppAuditTone {
  switch (phase) {
    case 'requested':
      return 'neutral'
    case 'approved':
      return 'ask'
    case 'completed':
      return 'ok'
    case 'denied':
    case 'error':
      return 'err'
  }
}

/* ─────────────────────────────────────────────── 视图回退分类 */

/** 宿主 `prepare` 返回描述符的最小结构；字段形状与 `McpAppViewDescriptor` 对齐。 */
export interface McpAppDescriptorLike {
  readonly kind: 'ready' | 'text' | 'error'
  readonly instanceId?: string
  readonly url?: string
  readonly title?: string
  readonly callId?: string
  readonly text?: string
  readonly reason?: string
  readonly error?: string
}

export type McpAppViewRender =
  | { mode: 'frame'; instanceId: string; url: string; title: string; callId: string }
  | { mode: 'text'; text: string; reason: string }
  | { mode: 'error'; error: string }
  /** `kind:'ready'` 但 URL 不是受控来源：安全拒绝，不退化成可点击的链接。 */
  | { mode: 'invalid'; error: string }

/**
 * 把宿主描述符翻译成「渲染框 / 文本回退 / 错误 / 安全拒绝」。
 * 只有受控 `inkstone-app:` 地址才会进入框；其余一律回退，绝不接受任意 `src`。
 */
export function describeMcpAppView(descriptor: McpAppDescriptorLike): McpAppViewRender {
  if (descriptor.kind === 'ready') {
    const url = typeof descriptor.url === 'string' ? descriptor.url : ''
    if (!isMcpAppFrameUrl(url)) return { mode: 'invalid', error: 'url' }
    return {
      mode: 'frame',
      instanceId: typeof descriptor.instanceId === 'string' ? descriptor.instanceId : '',
      url,
      title: typeof descriptor.title === 'string' ? descriptor.title : '',
      callId: typeof descriptor.callId === 'string' ? descriptor.callId : ''
    }
  }
  if (descriptor.kind === 'text') {
    return {
      mode: 'text',
      text: typeof descriptor.text === 'string' ? descriptor.text : '',
      reason: typeof descriptor.reason === 'string' ? descriptor.reason : ''
    }
  }
  return { mode: 'error', error: typeof descriptor.error === 'string' ? descriptor.error : '' }
}
