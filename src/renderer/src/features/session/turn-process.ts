/**
 * 一轮助手回复的「过程收拢」纯投影（不碰 React / store / DOM）。
 *
 * 规则（见 `docs/DESIGN_SYSTEM.md` §5「过程收拢」）：
 *   · 最后一个带正式回复（`response`）的段是「回复」；它之前的所有解说、工具组、
 *     推理合成一条「过程行」，放在回复之前；
 *   · 回复段自己的解说与工具（同一段里排在回复前的部分）也归入过程；
 *   · 回复之后仍有的段（极少见：正式回复后又出现工具）原样留在 `tail`，不藏进过程行；
 *   · 没有正式回复时（运行中、或只剩工具）全部进过程行，`reply` 为 null。
 */
import type { UIToolCall } from '../../../../shared/ipc'
import type { TurnSegment } from '../../../../shared/turns'
import { toolGroupLabel } from './tool-summary'

export interface TurnProcessSplit {
  /** 过程行里的段（按原顺序；解说与工具保留在各自段内） */
  process: TurnSegment[]
  /** 正式回复段：只带 `response`，解说与工具已移入过程行 */
  reply: TurnSegment | null
  /** 回复之后的段（原样保留，显示在回复之后） */
  tail: TurnSegment[]
}

function hasWork(segment: TurnSegment): boolean {
  return segment.commentary.length > 0 || segment.tools.length > 0
}

export function splitTurnProcess(segments: readonly TurnSegment[]): TurnProcessSplit {
  let at = -1
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].response) {
      at = i
      break
    }
  }
  if (at < 0) {
    return { process: segments.filter(hasWork), reply: null, tail: [] }
  }

  const replySource = segments[at]
  const process = segments.slice(0, at).filter(hasWork)
  if (hasWork(replySource)) {
    process.push({ ...replySource, response: null, responseParts: undefined })
  }
  const reply: TurnSegment = {
    ...replySource,
    thinking: '',
    thinkingMs: undefined,
    thinkingLive: false,
    commentary: [],
    tools: [],
    texts: [],
    responseParts: replySource.responseParts
  }
  return { process, reply, tail: segments.slice(at + 1) }
}

/** 过程行里的全部工具（按原顺序） */
export function processTools(process: readonly TurnSegment[]): UIToolCall[] {
  return process.flatMap((segment) => segment.tools)
}

/** 过程行里的解说文字（按原顺序） */
export function processNotes(process: readonly TurnSegment[]): string[] {
  return process.flatMap((segment) => segment.commentary.map((part) => part.text))
}

/** 失败数（与 ToolSteps 的口径一致：出错且未被取消） */
export function failedCount(tools: readonly Pick<UIToolCall, 'status' | 'cancelled'>[]): number {
  return tools.filter((call) => call.status === 'error' && !call.cancelled).length
}

/** 正在运行的工具（取最后一个，即当前正在做的那一步） */
export function runningTool(tools: readonly UIToolCall[]): UIToolCall | null {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const status = tools[i].status
    if (status === 'running' || status === 'pending') return tools[i]
  }
  return null
}

/** 旁白只取第一行非空文字作单行标签；截断由样式完成 */
export function narrationLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s+)/, '').replace(/[`*_]/g, '')
}

/**
 * 过程行的摘要标签（不含用时）。
 * 有工具：`toolGroupLabel` 的类别汇总 + 失败数；只有旁白：取「过程」字样。
 */
export function processSummaryLabel(tools: readonly UIToolCall[], zh: boolean, fallback: string): string {
  if (!tools.length) return fallback
  const failed = failedCount(tools)
  const failText = failed > 0 ? (zh ? `（${failed} 个失败）` : ` (${failed} failed)`) : ''
  return toolGroupLabel(tools, zh) + failText
}
