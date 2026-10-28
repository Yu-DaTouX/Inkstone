import type { UIToolCall } from '../../shared/ipc'
import { isDangerDenial } from '../../shared/danger-block'
import { imagesOf, type PiContentBlock } from '../normalize'

export interface ToolResultPayload {
  content?: PiContentBlock[]
  details?: unknown
}

export interface ToolExecutionEnd {
  result?: ToolResultPayload
  isError?: unknown
  cancelled?: unknown
}

export function toolResultText(content: PiContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

export function streamingToolCall(ev: Record<string, unknown>, ordinal: number, now: number): UIToolCall {
  return {
    id: String(ev.id ?? `call-${ordinal}`),
    name: String(ev.toolName ?? 'tool'),
    args: undefined,
    argsRaw: '',
    status: 'running',
    startedAt: now
  }
}

const HTML_WRITE_PATH = /"(?:path|file_path)"\s*:\s*"[^"]*\.html?"/i

export function streamsHtmlWriteArgs(call: UIToolCall): boolean {
  return call.name.toLowerCase() === 'write' && HTML_WRITE_PATH.test(call.argsRaw?.slice(0, 600) ?? '')
}

export const LIVE_ARGS_PARSE_LIMIT = 16_384

function lastNonSpace(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') return ch
  }
  return ''
}

function parseArgsRaw(call: UIToolCall): void {
  const end = lastNonSpace(call.argsRaw ?? '')
  if (end !== '}' && end !== ']') return
  try {
    call.args = JSON.parse(call.argsRaw ?? '')
  } catch {
  }
}

export function appendToolCallArgs(call: UIToolCall, delta: unknown): void {
  call.argsRaw = (call.argsRaw ?? '') + String(delta ?? '')
  if (call.argsRaw.length <= LIVE_ARGS_PARSE_LIMIT) parseArgsRaw(call)
}

export function finishToolCallArgs(call: UIToolCall, toolCall: PiContentBlock | undefined): void {
  if (toolCall?.id) call.id = toolCall.id
  if (toolCall?.name) call.name = toolCall.name
  if (toolCall?.arguments !== undefined) call.args = toolCall.arguments
  else if (call.args === undefined) parseArgsRaw(call)
}

export function startToolExecution(call: UIToolCall, now: number): void {
  call.status = 'running'
  call.startedAt = now
}

export function updateToolExecution(call: UIToolCall, partial: ToolResultPayload | undefined): void {
  call.output = toolResultText(partial?.content)
  call.details = partial?.details
}

export function endToolExecution(call: UIToolCall, evt: ToolExecutionEnd, now: number): void {
  const result = evt.result
  const cancelled = evt.cancelled === true
  call.cancelled = cancelled || undefined
  call.status = evt.isError && !cancelled ? 'error' : 'ok'
  call.output = toolResultText(result?.content)
  if (call.status === 'error' && isDangerDenial(call.output)) call.denied = true
  call.images = imagesOf(result?.content)
  call.details = result?.details
  call.endedAt = now
}

export function mergeToolDetails(call: UIToolCall, patch: Record<string, unknown>): void {
  const base =
    call.details && typeof call.details === 'object' && !Array.isArray(call.details)
      ? (call.details as Record<string, unknown>)
      : {}
  call.details = { ...base, ...patch }
}
