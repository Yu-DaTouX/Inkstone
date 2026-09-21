/**
 * 模型出错后的「自动继续」（实施-05 S5c）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 真实用起来最常见的中断不是「任务做完了」，而是**模型侧出错**：上游 5xx、连接被掐、
 * 供应商抽风。pi 自己会就地重试几次（`auto_retry_start/end`），用尽之后就停在那里 ——
 * 用户回来看到一条「模型返回错误」，得自己再敲一句「继续」。
 *
 * 这一层把那句话自动化，但**不是无脑重试**：
 *
 *   · 有些错误重试有意义（网络 / 上游瞬态 / 未知错误）：隔一段时间**再起一轮**；
 *   · 有些错误重试**只会更糟**：额度用尽（429）重试照样 429，还可能把额度耗在空转上；
 *     认证失败（401/403）不换凭证永远不行；上下文超限重试也是徒劳（那条走 S4 的预算门）。
 *     这三类一律**不自动继续**，而是明确说清「这次重试没有意义」。
 *
 * ── 三条纪律 ──
 *   ① **用户优先**：用户一发新消息、或按了停止，未发的自动继续立刻作废，计数归零；
 *   ② **有上限 + 退避**：默认连续 3 次，间隔 3s / 10s / 30s —— 不把额度烧在瞬时的空转上；
 *   ③ **不伪造用户消息**：续行是一条 `custom` 角色消息（与 S3b/S3c 同一条通道），
 *      正文里必须提醒模型「上一轮可能已经产生副作用，先检查再动手」。
 *
 * 纯逻辑全在这里（分类 / 计划 / 正文），宿主与单测共用；落盘在 `main/auto-continue-service.ts`。
 */

/** 连续自动继续的上限（用户发言即归零）。 */
export const AUTO_CONTINUE_LIMIT = 3

/** 每次尝试前的等待（毫秒）。最后一项会被复用（到上限前不会超过 limit 次）。 */
export const AUTO_CONTINUE_DELAYS_MS = [3_000, 10_000, 30_000] as const

export type ModelErrorKind =
  /** 值得再试一次：网络 / 上游瞬态 / 认不出的错误 */
  | 'retryable'
  /** 额度 / 限流：重试只会立刻再失败 */
  | 'quota'
  /** 认证 / 权限：不换凭证永远不行 */
  | 'auth'
  /** 上下文超限：走预算门（S4），不是重试 */
  | 'context'
  /** 用户取消：不重试 */
  | 'aborted'

export interface ModelErrorInfo {
  kind: ModelErrorKind
  /** 归一化后的原始文本（可能为空） */
  text: string
  /** 给界面/日志看的中文短句 */
  label: string
}

/** 关键词表（中英都认；大小写不敏感）。顺序即优先级：越具体的越靠前。 */
const PATTERNS: { kind: ModelErrorKind; label: string; re: RegExp }[] = [
  {
    kind: 'aborted',
    label: '本轮被取消',
    re: /\b(abort(ed)?|cancel(led|ed)?)\b|取消|已中止/i
  },
  {
    kind: 'quota',
    label: '额度或限流',
    /*
     * 为什么还要认 `used all` / `free requests` / `requests for today`：
     * 供应商的原文常常不带 429，而是 “You've used all 100 free requests for today”
     * （实测踩过：只写 429/quota 会让这类错误被当成可重试，白烧 3 次额度）。
     */
    re: /429|rate ?limit|too many requests|quota|insufficient|balance|credit|used all|free requests?|requests for today|额度|配额|余额|限流/i
  },
  {
    kind: 'auth',
    label: '认证或权限',
    re: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication|not logged in|登录|凭证|密钥/i
  },
  {
    kind: 'context',
    label: '上下文超限',
    re: /context (length|window|limit)|too many tokens|maximum context|token limit|prompt is too long|too long|上下文.{0,6}(超|过|长)/i
  }
]

/**
 * 分类一段错误文本。
 *
 * 认不出的一律归 `retryable` —— 这是有意的失败方向：少见错误里「试一次就好了」的比例
 * 远高于「试了就出事」，而且有上限与退避兜着。额度 / 认证 / 上下文三类必须命中关键词才拦。
 */
export function classifyModelError(text: unknown): ModelErrorInfo {
  const raw = typeof text === 'string' ? text.trim() : ''
  for (const item of PATTERNS) {
    if (item.re.test(raw)) return { kind: item.kind, text: raw, label: item.label }
  }
  return { kind: 'retryable', text: raw, label: raw ? '模型侧错误' : '模型侧错误（没有错误文本）' }
}

/** 自动继续的会话级状态。 */
export interface AutoContinueState {
  /** 连续失败次数（用户发言 / 成功一轮 / 用户停止 → 归零）。 */
  attempts: number
  /** 最近一次错误的归一化文本（给界面与排障）。 */
  lastError: string | null
  lastAt: number
}

export function emptyAutoContinueState(now = 0): AutoContinueState {
  return { attempts: 0, lastError: null, lastAt: now }
}

export type AutoContinueStopReason = 'limit' | 'not-retryable' | 'user-stopped'

export type AutoContinuePlan =
  | { action: 'retry'; attempt: number; delayMs: number; error: ModelErrorInfo; note: string }
  | { action: 'stop'; reason: AutoContinueStopReason; error: ModelErrorInfo; note: string }

/** 毫秒 →「3 秒 / 10 秒」这种短句（提示用）。 */
function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} 秒`
}

/**
 * 该不该自动继续，以及怎么继续。
 *
 * 判定顺序（先到先拦）：
 *   ① 用户按了停止 → 不继续；
 *   ② 错误本身不值得重试（额度 / 认证 / 上下文 / 取消）→ 不继续，并说明原因；
 *   ③ 连续次数到上限 → 不继续（保留现场，等用户）；
 *   ④ 其余 → 继续，`attempt` 从 1 开始，退避按表取。
 *
 * `state.attempts` 由调用方维护（服务层持久化）；这里只根据它算下一步。
 */
export function planAutoContinue(input: {
  state: AutoContinueState
  error: ModelErrorInfo
  userStopped?: boolean
  limit?: number
  delays?: readonly number[]
}): AutoContinuePlan {
  const limit = Math.max(1, Math.floor(input.limit ?? AUTO_CONTINUE_LIMIT))
  const delays = input.delays && input.delays.length ? input.delays : AUTO_CONTINUE_DELAYS_MS
  const error = input.error

  if (input.userStopped) {
    return { action: 'stop', reason: 'user-stopped', error, note: '你按了停止，不再自动继续。' }
  }
  if (error.kind !== 'retryable') {
    return {
      action: 'stop',
      reason: 'not-retryable',
      error,
      note: `这次错误重试没有意义（${error.label}），已停止自动继续。`
    }
  }
  const attempts = Math.max(0, Math.floor(input.state.attempts ?? 0))
  if (attempts >= limit) {
    return {
      action: 'stop',
      reason: 'limit',
      error,
      note: `连续 ${limit} 次都没成功（${error.label}），已停止自动继续。`
    }
  }
  const attempt = attempts + 1
  const delayMs = delays[Math.min(attempt - 1, delays.length - 1)]
  return {
    action: 'retry',
    attempt,
    delayMs,
    error,
    note: `模型出错（${error.label}），${seconds(delayMs)}后自动继续（第 ${attempt}/${limit} 次）。`
  }
}

/**
 * 自动继续时发给模型的正文（`custom` 角色消息，**不是**用户说的话）。
 *
 * 最后那句是所有重试都必须带的：上一轮可能已经执行了一部分副作用
 * （写文件、跑命令、提交），无脑重放会做出重复动作。
 */
export function retryResumeSummary(input: { error: ModelErrorInfo; attempt: number; limit: number }): string {
  return [
    `上一轮因为模型侧错误中断了（${input.error.label}；这是第 ${input.attempt}/${input.limit} 次自动继续，不是用户说的话）。`,
    '请接着原来的目标继续做：',
    '- **先检查再动手**：上一轮可能已经执行了一部分（文件已改、命令已跑），不要重复执行有副作用的操作；',
    '- 不要重述已经做完的部分，也不要问用户，直接推进下一步；',
    '- 如果确认已经没有可做的事，就用 `yan goal report` 报完成（带证据）或报阻塞。'
  ].join('\n')
}

/** 同一秒内重复到达的错误只算一次（`auto_retry_end` 与 `stopReason` 会同时报同一件事）。 */
export function isDuplicateError(state: AutoContinueState, text: string, now: number, windowMs = 2_000): boolean {
  if (!state.lastAt) return false
  if (now - state.lastAt > windowMs) return false
  return (state.lastError ?? '') === text
}

/**
 * 解析 `YAN_AUTO_CONTINUE` 的覆盖值（测试通道）。
 *
 * 与项目其它测试通道同一个约定：**显式给的覆盖优先**，非法值整项忽略
 * （写坏一个数字不该把上限变成 NaN 或 0）。
 */
export function sanitizeAutoContinueOptions(raw: unknown): { limit?: number; delays?: number[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const item = raw as { limit?: unknown; delays?: unknown }
  const out: { limit?: number; delays?: number[] } = {}
  if (typeof item.limit === 'number' && Number.isFinite(item.limit) && item.limit > 0) {
    out.limit = Math.min(20, Math.floor(item.limit))
  }
  if (Array.isArray(item.delays)) {
    const delays = item.delays
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      .slice(0, 10)
      .map((value) => Math.floor(value))
    if (delays.length) out.delays = delays
  }
  return out
}
