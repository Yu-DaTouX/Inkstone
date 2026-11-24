import type { UIMessage, UIToolCall } from './ui-message'
import { remoteToolCall, REMOTE_TOOL_OUTPUT_CHARS } from './remote-history-page'

export const WATCH_INVITE_PREFIX = 'inkstone-watch:'
export const WATCH_CODE_RE = /^[A-Za-z0-9_-]{16,128}$/
export const WATCH_EVENT_BUFFER = 2_000
export const WATCH_HISTORY_LIMIT = 300
export const WATCH_MAX_VIEWERS = 16

export interface WatchInvite {
  hostKey: string
  host: string
  direct: string[]
  code: string
  fingerprint: string
  title: string
  sessionId: string
}

export interface SessionShareViewer {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
}

export interface SessionShareView {
  sessionId: string
  title: string
  invite: string
  startedAt: number
  viewers: SessionShareViewer[]
}

export type SessionShareStartResult =
  | { ok: true; share: SessionShareView }
  | { ok: false; reason: 'remote-off' | 'failed'; error: string }

export type WatchStatus = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'failed'

export interface WatchSessionState {
  isStreaming: boolean
  isAgentRunning: boolean
  isCompacting: boolean
  model?: string
}

export interface WatchView {
  id: string
  title: string
  host: string
  fingerprint: string
  status: WatchStatus
  error?: string
  pending: number
  state: WatchSessionState | null
}

export interface WatchSnapshot {
  view: WatchView
  messages: UIMessage[]
}

export type WatchJoinResult = { ok: true; watch: WatchView } | { ok: false; error: string }

export type WatchEventChannel = 'msg-add' | 'msg-update' | 'tool' | 'state' | 'turn-settled' | 'session-title' | 'pending' | 'resync'

export interface WatchEvent {
  channel: WatchEventChannel
  payload: unknown
}

export type WatchPush =
  | { watchId: string; kind: 'view'; view: WatchView }
  | { watchId: string; kind: 'reset'; view: WatchView; messages: UIMessage[] }
  | { watchId: string; kind: 'event'; event: WatchEvent }
  | { watchId: string; kind: 'removed' }

function b64uEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(text: string): string {
  const normal = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normal + '='.repeat((4 - (normal.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

function clean(text: unknown, max: number): string {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
}

export function encodeWatchInvite(invite: WatchInvite): string {
  return `${WATCH_INVITE_PREFIX}${b64uEncode(JSON.stringify({
    v: 1,
    s: invite.hostKey,
    n: invite.host,
    d: invite.direct,
    c: invite.code,
    f: invite.fingerprint,
    t: invite.title,
    i: invite.sessionId
  }))}`
}

export function parseWatchInvite(text: string): WatchInvite | null {
  const raw = text.trim().replace(/\s+/g, '')
  if (!raw.startsWith(WATCH_INVITE_PREFIX)) return null
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(b64uDecode(raw.slice(WATCH_INVITE_PREFIX.length)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed.v !== 1) return null
  const hostKey = typeof parsed.s === 'string' && /^[A-Za-z0-9_-]{40,200}$/.test(parsed.s) ? parsed.s : ''
  const code = typeof parsed.c === 'string' && WATCH_CODE_RE.test(parsed.c) ? parsed.c : ''
  const direct = Array.isArray(parsed.d)
    ? parsed.d.filter((url): url is string => typeof url === 'string' && /^wss?:\/\/[^\s/]+\/remote\/v1\/tunnel$/.test(url)).slice(0, 4)
    : []
  const sessionId = clean(parsed.i, 200)
  if (!hostKey || !code || !direct.length || !sessionId) return null
  return {
    hostKey,
    host: clean(parsed.n, 60) || '?',
    direct,
    code,
    fingerprint: clean(parsed.f, 120),
    title: clean(parsed.t, 200),
    sessionId
  }
}

export function watchToolCall(call: UIToolCall): UIToolCall {
  const { approval: _approval, ...rest } = remoteToolCall(call)
  return rest
}

export function watchMessage(message: UIMessage): UIMessage {
  const { images: _images, artifacts: _artifacts, sourceCwd: _cwd, imageProgress: _progress, ...rest } = message
  return rest.toolCalls ? { ...rest, toolCalls: rest.toolCalls.map(watchToolCall) } : rest
}

export function watchMessagePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const { images: _images, artifacts: _artifacts, sourceCwd: _cwd, imageProgress: _progress, ...rest } = patch
  if (Array.isArray(rest.toolCalls)) rest.toolCalls = (rest.toolCalls as UIToolCall[]).map(watchToolCall)
  return rest
}

export function clipOutputDelta(delta: string | undefined): string | undefined {
  if (delta === undefined) return undefined
  return delta.length > REMOTE_TOOL_OUTPUT_CHARS ? `…${delta.slice(-REMOTE_TOOL_OUTPUT_CHARS)}` : delta
}

export function watchSessionState(payload: unknown): WatchSessionState | null {
  if (!payload || typeof payload !== 'object') return null
  const state = payload as Record<string, unknown>
  const model = state.model && typeof state.model === 'object' ? (state.model as Record<string, unknown>) : null
  const modelName = model ? clean(model.name ?? model.id, 120) : clean(state.model, 120)
  return {
    isStreaming: state.isStreaming === true,
    isAgentRunning: state.isAgentRunning === true,
    isCompacting: state.isCompacting === true,
    ...(modelName ? { model: modelName } : {})
  }
}
