/**
 * 回合计时口径（纯函数）。
 *
 * 两个时间回答的是不同问题，**不能互相替代**：
 *
 * - `speed`（token/秒）—— 模型生成快不快。从**首个内容 token 到达**算起，
 *   排队、首包延迟、工具往返都不算进去，否则速率会被工具时间摊薄。
 * - `elapsedMs` —— 这一轮用户等了多久。从 **agent 回合起点**算起，
 *   覆盖模型思考、工具执行、重试等待与自动压缩在内的整轮墙钟时间。
 *
 * 为什么把它从 `main/agent.ts` 抽出来：它是纯算术，而 agent.ts 要跑起来
 * 必须真起 pi。放在共享层才能用单测钉住「工具等待算进整轮、不算进速度」，
 * 不让这条口径在后续改动里被悄悄改回去（turn 页脚与用量条都依赖它）。
 *
 * 边界：
 * - 拿不到 `usage.output` 时**只省略速度**，不拿字符数瞎猜；`elapsedMs` 不依赖
 *   用量，所以 provider 不报 token 时界面仍能显示真实整轮时间。
 * - 时间来源可能是系统时钟，所以差值统一钳到 ≥ 1ms，不产生 0 或负数。
 * - 空回合（既没有回合起点也没有流起点）不产生 `elapsedMs`，由调用方决定不显示。
 */

import type { GenerationTiming } from './ipc'

export interface TurnUsageLike {
  output?: number
}

export interface TurnTimingInput {
  /** 本轮最新用量；缺 `output` 时不给速度 */
  usage?: TurnUsageLike
  /** 首个内容 token 到达的时刻 */
  firstTokenAt?: number
  /** 本条消息流开始的时刻（首包之前） */
  startedAt?: number
  /** agent 回合起点（用户提交被接纳后开始执行） */
  turnStartedAt?: number
  /** 结束时刻 */
  endedAt: number
}

export interface TurnTiming {
  speed?: number
  elapsedMs?: number
}

export function turnTiming(input: TurnTimingInput): TurnTiming {
  const { usage, firstTokenAt, startedAt, turnStartedAt, endedAt } = input
  const output = usage?.output ?? 0
  /* 速度用首 token；拿不到就退回流起点（比退到回合起点更贴近生成过程）。 */
  const speedFrom = firstTokenAt ?? startedAt
  const elapsedFrom = turnStartedAt ?? startedAt
  const result: TurnTiming = {}
  /*
   * 用 `!== undefined` 而不是真假值判断：时间戳 0 是合法值（epoch），
   * 用 falsy 判断会把「起点恰为 0」误判成「没有起点」而静默丢掉用时。
   */
  if (output > 0 && speedFrom !== undefined) {
    const ms = Math.max(1, endedAt - speedFrom)
    result.speed = output / (ms / 1000)
  }
  if (elapsedFrom !== undefined) result.elapsedMs = Math.max(1, endedAt - elapsedFrom)
  return result
}

/**
 * 一次模型请求计时的输入（全部为**单调**时刻，`performance.now()`）。
 *
 * 为什么不在这里读表：主进程在事件到达时记时刻，纯函数只做减法 ——
 * 这样「首包延迟 / 解码时长 / 请求时长」三条口径能被单测钉住，
 * 不会被后来的改动在事件处理里悄悄改掉。
 */
export interface GenerationTimingInput {
  /** 请求起点的单调时刻（原生 turn_start 或流下限） */
  startedMono: number
  /** assistant `message_end` 时刻 */
  endedMono: number
  /** 首个真正内容的时刻；没有就缺省 */
  firstContentMono?: number
  /**
   * 起点语义。`'turn_start'` 表示 `startedMono` 来自 pi 原生 `turn_start`
   * （含请求准备 / 网络等待 / provider 内部重试）；缺省表示起点只是流的下限，
   * caller 不得拿它当完整请求 TTFT 保存。
   */
  startEvent?: 'turn_start'
}

/**
 * 一次模型请求的生成用时。
 *
 * 与 `turnTiming()` 分开的理由：它回答的是「**这次调用**快不快」，不含工具
 * 等待与整轮墙钟；旧口径里的 `speed` 仍然保留（兼容既有回合页脚）。
 *
 * 边界：
 * - 起点 / 终点非有限值（缺字段、NaN、Infinity）时不产出记录，而不是猜；
 * - 没有首个内容时**只给** `durationMs`，`ttftMs` / `decodeMs` 保持缺省；
 * - `startEvent` 只是把 caller 传入的起点语义原样带出，不在函数里猜；
 * - 时间可能被钳到 ≥ 1ms，不产生 0 或负数。
 */
export function generationTiming(input: GenerationTimingInput): GenerationTiming | undefined {
  const { startedMono, endedMono, firstContentMono, startEvent } = input
  if (!Number.isFinite(startedMono) || !Number.isFinite(endedMono)) return undefined
  const result: GenerationTiming = { durationMs: Math.max(1, Math.round(endedMono - startedMono)) }
  /* 起点语义原样带出：只有 caller 明确来自原生 turn_start 时才标记。 */
  if (startEvent === 'turn_start') result.startEvent = 'turn_start'
  if (firstContentMono !== undefined && Number.isFinite(firstContentMono)) {
    result.ttftMs = Math.max(1, Math.round(firstContentMono - startedMono))
    result.decodeMs = Math.max(1, Math.round(endedMono - firstContentMono))
  }
  return result
}

/**
 * 输出速度（token/秒）= 真实 `usage.output` ÷ 解码时长。
 *
 * 没有首 token（没有 `decodeMs`）或没有真实用量输出时返回 `undefined` ——
 * 不拿字符数或整轮墙钟冒充 TPS。会话统计用它统一口径。
 */
export function decodeTokensPerSecond(
  outputTokens: number | undefined,
  decodeMs: number | undefined
): number | undefined {
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) return undefined
  if (typeof decodeMs !== 'number' || !Number.isFinite(decodeMs) || decodeMs <= 0) return undefined
  return outputTokens / (decodeMs / 1000)
}
