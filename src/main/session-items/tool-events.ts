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

export function appendToolCallArgs(call: UIToolCall, delta: unknown): void {
  call.argsRaw = (call.argsRaw ?? '') + String(delta ?? '')
  try {
    if (/[}\]]\s*$/.test(call.argsRaw)) call.args = JSON.parse(call.argsRaw)
  } catch {
  }
}

export function finishToolCallArgs(call: UIToolCall, toolCall: PiContentBlock | undefined): void {
  if (!toolCall) return
  if (toolCall.id) call.id = toolCall.id
  if (toolCall.name) call.name = toolCall.name
  if (toolCall.arguments !== undefined) call.args = toolCall.arguments
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
