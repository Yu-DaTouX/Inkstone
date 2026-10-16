import { BRIDGE_MESSAGE_LIMIT_BYTES, BRIDGE_SIZE_MAX, BRIDGE_SIZE_MIN } from './model'
import { MCP_APP_METHODS } from '../../../../shared/mcp-app-methods'
import { MCP_APP_SANDBOX, parseMcpAppUrl, type McpAppUrl } from '../../../../shared/mcp-app-preview'

export const MCP_APP_FRAME_SANDBOX = MCP_APP_SANDBOX

export const MCP_APP_FRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"

export const MCP_APP_FRAME_REFERRER_POLICY = 'no-referrer' as const

export function isSafeMcpAppSandbox(sandbox: string): boolean {
  return sandbox === MCP_APP_SANDBOX && !sandbox.includes('allow-same-origin')
}

export function isSafeMcpAppAllow(allow: string): boolean {
  return allow === MCP_APP_FRAME_ALLOW
}

export function isMcpAppFrameUrl(src: string): boolean {
  return parseMcpAppUrl(src) !== null
}

export function parseMcpAppFrameUrl(src: string): McpAppUrl | null {
  return parseMcpAppUrl(src)
}

export const MCP_APP_OPAQUE_ORIGIN = 'null'

export function isExpectedMcpAppOrigin(origin: string): boolean {
  return origin === MCP_APP_OPAQUE_ORIGIN
}

export function mcpAppFrameKey(instanceId: string, generation: number): string {
  return `${instanceId}#${generation}`
}

export { MCP_APP_METHODS }

export type McpAppMethodKind =
  | 'initialize'
  | 'initialized'
  | 'size'
  | 'sensitive'
  | 'host'

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

export type McpAppChannelPhase = 'idle' | 'initializing' | 'ready' | 'closed'

export type McpAppPhaseEvent = 'initialize' | 'initialize-ok' | 'close' | 'reset'

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
      return phase === 'initializing' ? 'ready' : phase
  }
}

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

export const MCP_APP_MESSAGE_LIMIT_BYTES = BRIDGE_MESSAGE_LIMIT_BYTES

export type McpAppDecodeError = 'shape' | 'size' | 'method'

export interface McpAppIncomingMessage {
  readonly method: string
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
    return { ok: false, error: 'shape' }
  }

  const rawParams = raw.params
  if (rawParams !== undefined && rawParams !== null && !isPlainObject(rawParams)) return { ok: false, error: 'shape' }
  const params = rawParams === undefined || rawParams === null ? null : (sanitizeMcpAppValue(rawParams) as Record<string, unknown>)

  return { ok: true, message: { method, id, hasId, params } }
}

export function toHostDispatchMessage(message: McpAppIncomingMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { jsonrpc: '2.0', method: message.method }
  if (message.hasId) out.id = message.id
  if (message.params) out.params = message.params
  return out
}

export function mcpAppDedupKey(generation: number, id: string | number): string {
  return `${generation}\u0000${String(id)}`
}

export function clampMcpAppSize(height: unknown): number | null {
  if (typeof height !== 'number' || !Number.isFinite(height)) return null
  return Math.max(BRIDGE_SIZE_MIN, Math.min(BRIDGE_SIZE_MAX, Math.ceil(height)))
}

export type McpAppAuditPhase = 'requested' | 'denied' | 'approved' | 'completed' | 'error'

export type McpAppAuditTone = 'neutral' | 'ask' | 'ok' | 'err'

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
  | { mode: 'invalid'; error: string }

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
