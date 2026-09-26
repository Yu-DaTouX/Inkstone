/*
 * 运行进展的阶段投影（实施-21 P1）。
 *
 * 为什么是纯投影而不是给 agent.ts 加状态机：阶段只能由**真实事件**推进 ——
 * 收到可见思考流才算 `thinking`，拿到工具执行才算 `tool`，正文在流才算
 * `responding`。把这些判据写成一个纯函数后，多轮工具循环、取消、失败、
 * 乱序与切会话都能用假时钟逐条断言，不需要真跑模型。
 *
 * 明确不做的事：
 *   · 不用线性百分比冒充完成度（一个回合里工具 → 模型可以往返多次）
 *   · 没有可见 thinking 时不显示「正在推理」
 *   · 不声称已经编辑 / 验证 / 完成，除非对应终态真的到了
 */
import type { TurnTerminalReason } from './ipc'

export type RunPhase =
  | 'preparing'
  | 'requesting'
  | 'thinking'
  | 'tool'
  | 'responding'
  | 'settled'
  | 'failed'
  | 'cancelled'

export interface RunProgressInput {
  /** `agent_start` → 终态之间为 true（覆盖工具执行与中途再思考） */
  running: boolean
  /** 有正文流在输出 */
  streaming: boolean
  /** 正在执行的工具（取最后一个 status==='running' 的 toolCall） */
  tool: { name: string; startedAt?: number } | null
  /** 本回合已经出现可见思考流 */
  thinking: boolean
  /** 本回合已经向模型发出过请求（有助手消息或正在流式） */
  requested: boolean
  /** 回合的终止原因；未结束为 null */
  terminal: TurnTerminalReason | null
  /** 本回合开始的时刻 */
  startedAt: number | null
  now: number
  /** 超过这个时长就只说「仍在运行」（默认 30s） */
  longMs?: number
}

export interface RunProgress {
  phase: RunPhase
  /** 该阶段的起始时刻（用于显示时长）；取不到就是 start */
  since: number | null
  /** 工具名等附注 */
  detail?: string
  /** 是否已经进入长耗时区间 */
  long: boolean
  /** 本回合已耗时（毫秒） */
  elapsedMs: number
}

const DEFAULT_LONG_MS = 30_000

/** 还在推进中的阶段（这些才会被标记成“长耗时”） */
const ACTIVE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'preparing',
  'requesting',
  'thinking',
  'tool',
  'responding'
])

export function deriveRunProgress(input: RunProgressInput): RunProgress {
  const startedAt = input.startedAt ?? input.now
  const elapsedMs = Math.max(0, input.now - startedAt)
  const long = elapsedMs >= (input.longMs ?? DEFAULT_LONG_MS)

  const phase: RunPhase =
    input.terminal === 'failed'
      ? 'failed'
      : input.terminal === 'stopped' || input.terminal === 'interrupted'
        ? 'cancelled'
        : input.terminal === 'completed'
          ? 'settled'
          : input.tool
            ? 'tool'
            : input.streaming
              ? 'responding'
              : input.thinking
                ? 'thinking'
                : input.running && input.requested
                  ? 'requesting'
                  : input.running
                    ? 'preparing'
                    : 'settled'

  return {
    phase,
    since: startedAt,
    ...(phase === 'tool' && input.tool ? { detail: input.tool.name } : {}),
    long: long && ACTIVE_PHASES.has(phase),
    elapsedMs
  }
}

/** 阶段是否可以点击展开明细（只有真的在跑才给展开） */
export function runPhaseIsActive(phase: RunPhase): boolean {
  return ACTIVE_PHASES.has(phase)
}
