/**
 * pi / 宿主事件 → `RunSignal` 映射（v3 WP-10）。
 *
 * 旁路事实输入：这里**只读** pi 事件对象，不修改它、不影响 pi 循环，也不改任何
 * 消息投影。字段名以随包 pi 1.2.0 的实际输出为准（`auto_retry_start` 带
 * `attempt/maxAttempts/delayMs/errorMessage`；`auto_retry_end` 带 `success/finalError`；
 * `agent_settled` 带 `aborted`；`agent_end` 带 `willRetry`）。
 *
 * 为什么单列一层：reducer 只吃有确定语义的信号，pi 换了字段名只需要改这一个文件，
 * 纯函数测试也能逐行覆盖 03 §2.3。
 */
import { classifyModelError, modelErrorNotice, modelErrorText } from '../../shared/model-errors'
import { isWriteTool, writePathOf } from '../snapshots'
import type { RunRequestType, RunSignal } from '../../shared/runs'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 工具行的显示目标：写入类给路径，shell 类给命令首行，其余给查询词或工具名。 */
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

/**
 * 把一条 pi 原始事件映射成 0..n 条信号。
 *
 * 只映射与运行状态有关的事件；消息正文、工具输出细节仍由原有投影处理。
 * `now` 可注入，重试恢复时刻才能在假时钟下断言。
 */
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
      /* 观察到错误但**不**在这里判失败：pi 常随后发 auto_retry_start；终局在 retry-end / agent_settled。 */
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
      /* 被取消不算失败（与 agent.ts 同一口径）。 */
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

/** `queue_update`：有排队项且当前无运行实例时，进入排队。 */
export function signalFromQueueUpdate(evt: Record<string, unknown>): RunSignal | null {
  const steering = Array.isArray(evt.steering) ? evt.steering.length : 0
  const followUp = Array.isArray(evt.followUp) ? evt.followUp.length : 0
  if (steering === 0 && followUp === 0) return null
  return { type: 'queued', reason: 'followup' }
}

const UI_REQUEST_TYPES: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor'])

/** 扩展 UI 请求 → 等你确认。只映射需要应答的对话类。 */
export function runSignalFromUiRequest(req: Record<string, unknown>): RunSignal | null {
  const id = str(req.id)
  const method = str(req.method) ?? ''
  if (!id || !UI_REQUEST_TYPES.has(method)) return null
  const summary = (str(req.title) ?? str(req.message) ?? '等待你的答复').slice(0, 200)
  return { type: 'needs-you', request: { id, type: method as RunRequestType, summary } }
}

/** 宿主危险确认（danger-guard 发起的 `danger.confirm`）→ 等你确认。 */
export function runSignalFromDangerConfirmation(request: { id: string; summary?: string }): RunSignal {
  return { type: 'needs-you', request: { id: request.id, type: 'danger', summary: (request.summary ?? '危险操作确认').slice(0, 200) } }
}

/** 请求得到答复 / 超时自动处理 → 归还运行态。 */
export function runSignalFromUiResolved(id: string): RunSignal {
  return { type: 'request-answered', requestId: id }
}

export function runSignalFromPiExit(code?: number | null, signal?: string | null): RunSignal {
  return { type: 'pi-exit', code: code ?? null, signal: signal ?? null }
}

export function runSignalFromHostStop(by: 'user' | 'host' = 'user'): RunSignal {
  return { type: 'stopped', by }
}
