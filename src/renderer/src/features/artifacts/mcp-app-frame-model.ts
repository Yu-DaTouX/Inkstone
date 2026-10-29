import { BRIDGE_SIZE_MAX, BRIDGE_SIZE_MIN } from './model'
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

export type McpAppChannelPhase = 'idle' | 'initializing' | 'ready' | 'closed'

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
