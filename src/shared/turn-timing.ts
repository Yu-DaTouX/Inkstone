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
