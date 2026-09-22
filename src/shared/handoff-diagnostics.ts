/**
 * 交接 / 目标续接的**阶段诊断事件**（实施-14 F0）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 用户现场反馈是「两次完整压缩之后交接没有提示、偶尔报错」，但现有链路里
 * 大量分支是**静默 return** 的：
 *
 *   · 资格不够（`below-threshold` / `no-goal` / `not-autonomous` / `busy`）→ 什么都不说；
 *   · 写请求文件失败 → 静默；
 *   · 结果文件的 handoffId / operationId 对不上 → 静默丢掉；
 *   · 提交卡在 `destination-created` / `committed` → 只有一行 console。
 *
 * 只看界面「没反应」是分不清这几种的，而它们的修法完全不同
 * （资格判定 / 文件交换 / 事务提交 / 启动确认）。所以这一层把每个**阶段结论**
 * 变成一条带操作身份（operationId / handoffId / runnerId / 会话键）的事件。
 *
 * ── 两条硬约束（都来自用户与 §8）──
 *   ① **不静默**：每个可能「看着像没发生」的出口都要留一条事件 + 可读原因；
 *   ② **不记录完整提示与凭证**：交接包提示词可能含用户原话与文件内容，
 *      凭证可能出现在错误文本里 —— 所以 detail 里的字符串一律走 `redactDiagnosticText`
 *      （截断 + 已知凭证形状替换），**永不**原样落盘。
 *
 * ── 这一层不做什么 ──
 *   不做判定、不改状态、不重试。它只是「把已经发生的事按阶段记下来」，
 *   供界面、探针和排障读。判定仍在 `handoff.ts` / `handoff-transaction.ts`，
 *   执行仍在 `handoff-runner.ts`。
 */

/**
 * 阶段清单。
 *
 * 与实施-14 §5.2 的建议阶段对齐（待安全边界 → 生成 → 提交 → 启动确认），
 * 另外加 `eligibility`（还没开始就结束的那一类）与 `goal-continue`（目标续接）。
 */
export const HANDOFF_EVENT_STAGES = [
  /** 资格判定：够不够数、有没有在推进的目标、是不是自主档、忙不忙 */
  'eligibility',
  /** 安全边界：目标还在推进 / 后台工作没结束，先等 */
  'safety-boundary',
  /** 生成：写请求文件、等薄层回结果 */
  'generate',
  /** 提交：事务状态机的各阶段 */
  'commit',
  /** 续接：发 resume 与启动确认 */
  'resume',
  /** 目标续接：arm / 取消一条「接着干」 */
  'goal-continue'
] as const

export type HandoffEventStage = (typeof HANDOFF_EVENT_STAGES)[number]

export function isHandoffEventStage(value: unknown): value is HandoffEventStage {
  return typeof value === 'string' && (HANDOFF_EVENT_STAGES as readonly string[]).includes(value)
}

/**
 * 一条阶段事件。
 *
 * 字段全是**标量或短字符串**：这样单测能直接断言、界面能直接渲染，
 * 也不会因为塞了一个大对象就把诊断日志变成第二份会话副本。
 */
export interface HandoffEvent {
  /** 记录时间（毫秒） */
  at: number
  stage: HandoffEventStage
  /** 阶段内的结论短码（`eligibility:rejected`、`commit:failed` 这类可读机器码） */
  outcome: string
  /** 这一次生成 / 提交 / 续接的操作身份（没有就 null） */
  op: string | null
  /** 交接事务身份（贯穿生成 → 提交） */
  handoffId: string | null
  /** 运行实例身份（薄层按它命名快照文件） */
  runnerId: string | null
  /** 用户会话身份（会话文件路径 / 稳定键） */
  sessionKey: string | null
  /** 可读原因（拒绝 / 失败 / 等待时必填） */
  reason: string | null
  /** 附加诊断（已脱敏：长文本截断、凭证替换） */
  detail: Record<string, string | number | boolean | null>
}

/** 内存里保留最近多少条（落盘上限按它的倍数收）。 */
export const HANDOFF_EVENT_LIMIT = 400

/** detail 里单个字符串值最多留多少字（超过截断并标注原长）。 */
export const HANDOFF_DETAIL_MAX_CHARS = 120

/**
 * 已知的凭证形状。
 *
 * 不是为了「识别所有密钥」（做不到），而是挡住最常见的三类：
 * `sk-…` 开头的 API key、`Authorization: Bearer …`、`token=` / `password=` 这类赋值。
 * 宁可多替换几个词，也不能把用户凭证写进排障日志。
 */
const REDACT_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
  /\b(?:api[-_]?key|token|secret|password|authorization)\b\s*[=:]\s*\S+/gi
]

/**
 * 诊断文本的清洗：压缩空白 → 替换凭证形状 → 截断。
 *
 * 返回 `null` 表示「没有可记录的文本」（空串 / 非字符串）——
 * 调用方据此决定要不要带这个字段，而不是写一个空字符串进日志。
 */
export function redactDiagnosticText(value: unknown, max = HANDOFF_DETAIL_MAX_CHARS): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let out = trimmed.replace(/\s+/g, ' ')
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '[redacted]')
  if (out.length <= max) return out
  return `${out.slice(0, max)}…(共${out.length}字)`
}

/**
 * 把一层任意 detail 清洗成「标量字典」。
 *
 * 未知类型一律 `String()` 后再走文本清洗 —— 诊断绝不能因为传了一个
 * 循环引用对象 / 超大数组就把主链路带崩。
 */
export function sanitizeHandoffDetail(raw: unknown, max = HANDOFF_DETAIL_MAX_CHARS): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = redactDiagnosticText(key, 40)
    if (!name) continue
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = Math.round(value * 1000) / 1000
    else if (typeof value === 'boolean') out[name] = value
    else if (value === null || value === undefined) out[name] = null
    else out[name] = redactDiagnosticText(String(value), max)
  }
  return out
}

/** 短 id 的清洗：只留安全字符，太长就截（错误日志里贴全 id 没有意义）。 */
export function sanitizeDiagnosticId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/[^A-Za-z0-9._:/\\-]/g, '_').slice(0, 160)
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' ? redactDiagnosticText(value) : null
}

/** 组装一条规范事件（`at` 缺省由调用方给，这里只做形状清洗）。 */
export function normalizeHandoffEvent(raw: Partial<HandoffEvent> & { at?: number; now?: number }): HandoffEvent {
  const at = Number.isFinite(raw.at) ? Number(raw.at) : Date.now()
  return {
    at,
    stage: isHandoffEventStage(raw.stage) ? raw.stage : 'generate',
    outcome: redactDiagnosticText(raw.outcome, 60) ?? 'unknown',
    op: sanitizeDiagnosticId(raw.op),
    handoffId: sanitizeDiagnosticId(raw.handoffId),
    runnerId: sanitizeDiagnosticId(raw.runnerId),
    sessionKey: sanitizeDiagnosticId(raw.sessionKey),
    reason: scalar(raw.reason),
    detail: sanitizeHandoffDetail(raw.detail)
  }
}

/** 从磁盘 JSONL 读回一条（脏行返回 null，由读取方跳过）。 */
export function sanitizeHandoffEventLine(raw: unknown): HandoffEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  if (!isHandoffEventStage(item.stage)) return null
  const at = Number(item.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return normalizeHandoffEvent({ ...(item as Partial<HandoffEvent>), at })
}

/** 一行摘要（界面 / 探针）。 */
export function handoffEventSummary(event: HandoffEvent): string {
  const parts = [`${event.stage}:${event.outcome}`]
  if (event.reason) parts.push(event.reason)
  return parts.join(' · ')
}
