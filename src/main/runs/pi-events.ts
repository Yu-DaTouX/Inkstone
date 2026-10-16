import { classifyModelError, modelErrorNotice, modelErrorText } from '../../shared/model-errors'
import { isWriteTool, writePathOf } from '../snapshots'
import type { RunRequestType, RunSignal } from '../../shared/runs'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function toolLabel(name: string, args: unknown): string {
  const path = writePathOf(args)
  if (path) return path
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const box = args as Record<string, unknown>
    const command = box.command ?? box.cmd ?? box.script
    if (typeof command === 'string' && command.trim()) return command.split('\n')[0].slice(0, 160)
    const query = box.query ?? box.pattern ?? box.path
    if (typeof query === 'string' && query.trim()) return query.slice(0, 160)
  }
  return name
}

function retryResumeAt(delayMs: unknown, now: number): number | undefined {
  return typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0 ? now + delayMs : undefined
}

export function signalsFromPiEvent(evt: Record<string, unknown>, now: number = Date.now()): RunSignal[] {
  const type = str(evt.type) ?? ''
  switch (type) {
    case 'agent_start':
      return [{ type: 'agent-start' }]

    case 'turn_start':
      return [{ type: 'activity', activity: 'waiting-model' }]

    case 'message_update': {
      const assistant = evt.assistantMessageEvent as Record<string, unknown> | undefined
      const kind = str(assistant?.type) ?? ''
      if (kind === 'thinking_start' || kind === 'thinking_delta') return [{ type: 'activity', activity: 'thinking' }]
      if (kind === 'text_delta' || kind === 'text_start') return [{ type: 'activity', activity: 'streaming' }]
      if (kind === 'toolcall_start' || kind === 'toolcall_delta') return [{ type: 'activity', activity: 'streaming' }]
      return []
    }

    case 'message_end': {
      const message = evt.message as Record<string, unknown> | undefined
      if (message?.stopReason !== 'error') return []
      const text = modelErrorText(message.errorMessage)
      return [{ type: 'error-observed', message: modelErrorNotice(text), errorKind: classifyModelError(text).kind }]
    }

    case 'tool_execution_start': {
      const name = str(evt.toolName) ?? 'tool'
      const callId = str(evt.toolCallId) ?? ''
      return [{ type: 'tool-start', tool: { name, label: toolLabel(name, evt.args), callId }, isWrite: isWriteTool(name) }]
    }

    case 'tool_execution_update':
      return [{ type: 'tool-update' }]

    case 'tool_execution_end': {
      const cancelled = evt.cancelled === true
      const name = str(evt.toolName) ?? ''
      return [
        {
          type: 'tool-end',
          ...(str(evt.toolCallId) ? { callId: str(evt.toolCallId) } : {}),
          isError: evt.isError === true && !cancelled,
          isWrite: isWriteTool(name)
        }
      ]
    }

    case 'compaction_start':
      return [{ type: 'compaction-start' }]

    case 'compaction_end':
      return [{ type: 'compaction-end' }]

    case 'auto_retry_start': {
      const text = modelErrorText(evt.errorMessage ?? evt.error)
      const info = classifyModelError(text)
      const attempt = Number(evt.attempt ?? 1)
      const max = Number(evt.maxAttempts ?? attempt)
      const resumeAt = retryResumeAt(evt.delayMs, now)
      if (info.kind === 'quota') {
        return [{ type: 'rate-limit', detail: info.label, retry: { attempt, max, ...(resumeAt !== undefined ? { resumeAt } : {}) } }]
      }
      return [
        {
          type: 'retry-start',
          attempt: Number.isFinite(attempt) ? attempt : 1,
          max: Number.isFinite(max) ? max : 1,
          ...(resumeAt !== undefined ? { resumeAt } : {}),
          detail: info.label
        }
      ]
    }

    case 'auto_retry_end': {
      if (evt.success === false) {
        const text = modelErrorText(evt.finalError)
        const info = classifyModelError(text)
        return [{ type: 'retry-end', success: false, errorKind: info.kind, message: modelErrorNotice(text) }]
      }
      return [{ type: 'retry-end', success: true }]
    }

    case 'agent_end':
      return [{ type: 'agent-end', willRetry: evt.willRetry === true }]

    case 'agent_settled':
      return [{ type: 'agent-settled', aborted: evt.aborted === true }]

    default:
      return []
  }
}

export function signalFromQueueUpdate(evt: Record<string, unknown>): RunSignal | null {
  const steering = Array.isArray(evt.steering) ? evt.steering.length : 0
  const followUp = Array.isArray(evt.followUp) ? evt.followUp.length : 0
  if (steering === 0 && followUp === 0) return null
  return { type: 'queued', reason: 'followup' }
}

const UI_REQUEST_TYPES: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor'])

export function runSignalFromUiRequest(req: Record<string, unknown>): RunSignal | null {
  const id = str(req.id)
  const method = str(req.method) ?? ''
  if (!id || !UI_REQUEST_TYPES.has(method)) return null
  const summary = (str(req.title) ?? str(req.message) ?? '等待你的答复').slice(0, 200)
  return { type: 'needs-you', request: { id, type: method as RunRequestType, summary } }
}

export function runSignalFromDangerConfirmation(request: { id: string; summary?: string }): RunSignal {
  return { type: 'needs-you', request: { id: request.id, type: 'danger', summary: (request.summary ?? '危险操作确认').slice(0, 200) } }
}

export function runSignalFromUiResolved(id: string): RunSignal {
  return { type: 'request-answered', requestId: id }
}

export function runSignalFromPiExit(code?: number | null, signal?: string | null): RunSignal {
  return { type: 'pi-exit', code: code ?? null, signal: signal ?? null }
}

export function runSignalFromHostStop(by: 'user' | 'host' = 'user'): RunSignal {
  return { type: 'stopped', by }
}
