/**
 * 目标状态与「计划就绪」转移（实施-05 S3 的契约与纯逻辑）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════
 * 计划档（`clarify`）的目标是：**把目标问清楚，然后自动开工**。
 * 「清楚」不能由模型自己说了算，也不能靠一句「可以开始了吗？」——
 * 所以这里定三件事：
 *
 *   1. **就绪条件**（§4）：`confidence >= 0.95`、五栏（目标 / 交付物 / 范围 /
 *      约束 / 验收）齐全、没有关键未决、没有未回答的必要问题，
 *      并且提交时看到的 `modeRevision` / `goalRevision` **没有过期**。
 *   2. **转移**：`clarifying → 原子提交 mode=standard 且 goal=executing`。
 *      「恰好一次」由 `transitionId` 保证（宿主侧记已提交结果，重放原样返回）。
 *   3. **目标阶段推进**（§5）：`planning → executing → verifying → completed`，
 *      外加 `blocked` / `stopped`。**不能一次 assistant 文本结束就当目标完成**：
 *      报 `completed` 必须带证据，报 `blocked` 必须说清阻塞；
 *      同一失败签名连续两次则**强制** blocked（不许继续假装在推进）。
 *
 * 这里只放**纯函数与类型**（主进程、单测、`yan` CLI 共用）。
 * 落盘与幂等在 `main/goal-service.ts`，通道是 `yan goal ready|report|status`。
 *
 * ⚠️ 模型自评**不是**校验。「模型说 confidence=1」只是它提交的一个字段，
 *    五栏是否真空、revision 是否过期由这里判。
 */

/** 合法阶段。顺序即推进顺序；`blocked` / `stopped` 是终态分支。 */
export const GOAL_PHASES = ['planning', 'executing', 'verifying', 'completed', 'blocked', 'stopped'] as const

export type GoalPhase = (typeof GOAL_PHASES)[number]

/** 就绪门槛（§4 写死 0.95；做成常量是为了单测能引用同一个值）。 */
export const READY_CONFIDENCE_THRESHOLD = 0.95

/** 连续同因失败到这个次数就判 blocked（§5：连续两次 → blocked）。 */
export const FAILURE_BLOCK_THRESHOLD = 2

/** 就绪提交必填的五栏（§4 的「齐全」）。 */
export const READY_FIELDS = ['goal', 'deliverable', 'scope', 'constraints', 'acceptance'] as const

export type ReadyField = (typeof READY_FIELDS)[number]

export interface ReadyUnderstanding {
  goal: string
  deliverable: string
  scope: string
  constraints: string
  acceptance: string
}

export interface GoalStep {
  title: string
  status: 'pending' | 'done' | 'blocked'
  evidence?: string[]
}

/**
 * 目标级预算（实施-15 A-2）：**可选**的上限。
 *
 * 为什么可选、为什么不给默认值：这里的“费用”是 token 数，不同模型单价差几个
 * 数量级；给一个默认上限等于替用户做了一次他没做过的成本承诺。不填就是不管，
 * 填了才停。未知用量就显示未知 —— 不用估算数字冒充硬上限。
 */
export interface GoalBudget {
  /** token 上限（输入 + 输出，口径由 H-6b 的逐消息聚合给）。 */
  tokens?: number
  /** 墙钟上限（毫秒）。 */
  ms?: number
}

/** 到目前为止的用量（装配方给，宿主不自己算使用量）。 */
export interface BudgetUsage {
  /** 已知的累计 token；`null` = 未知（模型没报 usage）。 */
  tokens: number | null
  /** 目标开始到现在的墙钟时间。 */
  elapsedMs: number
}

export type BudgetStop =
  | { stopped: false; note?: string }
  | { stopped: true; reason: 'tokens' | 'time'; detail: string }

/**
 * 预算判定。
 *
 * 两条规则是为「不承诺做不到的事」写的：
 *   · 用量**未知**时不因 tokens 停（无法判断），但在 `note` 里说明——界面能显示“未知”而
 *     不是假装够用；
 *   · **只停“安排新轮”**，不改 phase、不删目标、不把暂停当成失败：耗尽后用户可以
 *     调预算或主动继续（A-2 出口：“硬阈值暂停不删除目标”）。
 */
export function checkGoalBudget(budget: GoalBudget | null | undefined, used: BudgetUsage): BudgetStop {
  if (!budget) return { stopped: false }
  const notes: string[] = []
  if (typeof budget.ms === 'number' && budget.ms > 0 && used.elapsedMs >= budget.ms) {
    return {
      stopped: true,
      reason: 'time',
      detail: `已用 ${Math.round(used.elapsedMs / 1000)}s，达到时间预算 ${Math.round(budget.ms / 1000)}s`
    }
  }
  if (typeof budget.tokens === 'number' && budget.tokens > 0) {
    if (used.tokens === null) {
      notes.push('token 用量未知（模型未报 usage），这一条先不算')
    } else if (used.tokens >= budget.tokens) {
      return {
        stopped: true,
        reason: 'tokens',
        detail: `已用 ${used.tokens} tokens，达到预算 ${budget.tokens}`
      }
    }
  }
  return notes.length ? { stopped: false, note: notes.join('；') } : { stopped: false }
}

/**
 * 交付证据里的**结构化链接**（实施-12 U-3b）。
 *
 * 为什么不能只有字符串：`evidence: string[]` 里写什么都算数 —— 模型报一句
 * 「已生成 build/out.exe」就算证据。这里把「产物 / 参考」拆成可校验的形状：
 * kind 白名单、url 只收 http/https、单目标和单条都有长度上限，
 * **归属由宿主覆盖**（不信调用方自报的 sessionId）。
 */
export const GOAL_LINK_KINDS = ['file', 'url', 'artifact'] as const
export type GoalLinkKind = (typeof GOAL_LINK_KINDS)[number]

/** 单目标最多登记多少条（防止把状态文件当垃圾桶）。 */
export const GOAL_LINK_LIMIT = 20
/** 单条 target / label 的长度上限。 */
export const GOAL_LINK_TEXT_MAX = 500

export interface GoalLink {
  kind: GoalLinkKind
  /** `file`/`artifact` 是路径（相对项目根或绝对），`url` 是 http/https 地址。 */
  target: string
  label?: string
  /** 谁登记的。宿主会用当前会话覆盖 sessionId。 */
  source?: { sessionId?: string; messageId?: string }
  /** 宿主上一次的**只读**核验结果（实施-15 A-1）。 */
  check?: GoalLinkCheck
  addedAt: number
}

/**
 * 宿主对一条链接的只读核验（实施-15 A-1）。
 *
 * 边界写在这里，避免以后被当成安全扫描：
 *   · **只读**：只看存在性与大小/修改时间，**不执行**任何命令、不解析内容；
 *   · **不联网**：`url` 只做 scheme 形态校验（在 `sanitizeGoalLinks` 里）；
 *   · 「存在」**不等于**「内容正确」—— 判据仍由用户自己规定的验收检查决定。
 */
export interface GoalLinkCheck {
  /** 核验时间（每次目标报告都会重新核验，所以能看出「过期」）。 */
  at: number
  ok: boolean
  /** 核验方式（目前只有存在性这一种，不冒充内容校验）。 */
  method: 'exists'
  /** 结果说明：文件大小与修改时间，或缺失原因。 */
  detail: string
}

/**
 * 用户**显式设定**的持续目标（`+` 菜单 → 目标）。
 *
 * `outcome` 就是界面那句「定义可衡量的成果」：达成判据必须能被检查，
 * 而不是「我觉得做完了」。
 */
export interface PursuedBrief {
  goal: string
  outcome: string
}

export interface FailureTrack {
  /** 失败签名：模型给的稳定文本（同一签名视为「同一无变化失败」）。 */
  signature: string
  count: number
}

export interface GoalState {
  /** 会话内一个目标。没有目标时 `phase='planning'`、`revision=0`。 */
  goalId: string
  phase: GoalPhase
  /** 每次目标状态提交 +1（乐观版本，与模式的 `revision` 同构）。 */
  revision: number
  steps: GoalStep[]
  /** 完成证据（§5：任务清单勾选不算证据）。 */
  evidence: string[]
  /** 结构化产物 / 参考（U-3b）；旧文档没有这一项，读到就是空数组。 */
  links: GoalLink[]
  /** 用户设的目标级预算（A-2）；没设就是 null（不代替用户做成本承诺）。 */
  budget: GoalBudget | null
  /**
   * 最近一次「因预算停止安排新轮」的原因（A-2）。
   *
   * 放在目标状态里（而不是存储条目的旁路字段）的理由：它是用户该看到的**事实**
   * ——「为什么没继续」；同时它**不是失败**（phase 不动、不删目标）。
   */
  budgetStop: { at: number; reason: 'tokens' | 'time'; detail: string } | null
  /**
   * 宿主最近一次算出的用量快照（A-2）。
   *
   * 为什么由**宿主**写进目标状态：用量是事实（来自 H-6b 的回合记录），
   * 不是模型报告的内容；`tokens: null` = 拿不到（界面显示“未知”而非 0）。
   * 可选：旧文档没有它。
   */
  budgetUsage?: { tokens: number | null; at: number } | null
  /** `blocked` 时必填。 */
  blocker: string | null
  /**
   * 用户**显式设定**的持续目标（`+` 菜单 → 目标）。
   *
   * 为何要单独一位：自主档的「接着干」是**档位**行为，而「我就是要你把
   * 这件事做成」是**目标**行为 —— 两者正交（2026-09-22 用户口径）。
   * 置位后，非自主档也会在回合收尾时继续被叫醒，直到 `completed` / `blocked`。
   */
  pursue: boolean
  /** 用户的原话（目标 + 可衡量成果）：续行时复述，避免模型自己把目标做小。 */
  brief: PursuedBrief | null
  /** 同一失败签名的连续次数。 */
  failure: FailureTrack | null
  updatedAt: number
}

/** 还没有目标时的初值。 */
export function emptyGoal(now = 0): GoalState {
  return {
    goalId: '',
    phase: 'planning',
    revision: 0,
    steps: [],
    evidence: [],
    links: [],
    budget: null,
    budgetStop: null,
    budgetUsage: null,
    blocker: null,
    pursue: false,
    brief: null,
    failure: null,
    updatedAt: now
  }
}

export function isGoalPhase(value: unknown): value is GoalPhase {
  return typeof value === 'string' && (GOAL_PHASES as readonly string[]).includes(value)
}

/* ------------------------------------------------------- 就绪提交与校验 */

export interface ReadySubmission {
  /** 幂等键：同一个 id 重放返回**已提交结果**，不产生第二次转移。 */
  transitionId: string
  confidence: number
  understanding: Partial<ReadyUnderstanding>
  /** 未回答的必要问题：非空即未就绪。 */
  openQuestions: string[]
  /** 提交时看到的**模式** revision（模式切过就过期）。 */
  modeRevision: number
  /** 提交时看到的**目标** revision。 */
  goalRevision: number
}

export type ReadyRejectCode =
  | 'missing_transition_id'
  | 'confidence_too_low'
  | 'incomplete_understanding'
  | 'open_questions'
  | 'stale_mode'
  | 'stale_goal'

export type ReadyCheck =
  | { ok: true; understanding: ReadyUnderstanding }
  | { ok: false; code: ReadyRejectCode; message: string; missing?: ReadyField[] }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 就绪校验。
 *
 * `current` 由宿主给出（它才是真源）：模式 revision 与目标 revision 都要**相等**，
 * 不是「大于等于」—— 中间被别的提交推进过，就说明模型拿的是旧认识。
 */
export function checkReadySubmission(
  input: Partial<ReadySubmission>,
  current: { modeRevision: number; goalRevision: number }
): ReadyCheck {
  const transitionId = text(input.transitionId)
  if (!transitionId) {
    return { ok: false, code: 'missing_transition_id', message: '就绪提交必须带 transitionId（幂等键）' }
  }
  const confidence = typeof input.confidence === 'number' ? input.confidence : Number.NaN
  if (!Number.isFinite(confidence) || confidence < READY_CONFIDENCE_THRESHOLD) {
    return {
      ok: false,
      code: 'confidence_too_low',
      message: `confidence 必须是 >= ${READY_CONFIDENCE_THRESHOLD} 的数字（收到 ${JSON.stringify(input.confidence)}）`
    }
  }
  const raw = (input.understanding ?? {}) as Partial<ReadyUnderstanding>
  const understanding = {
    goal: text(raw.goal),
    deliverable: text(raw.deliverable),
    scope: text(raw.scope),
    constraints: text(raw.constraints),
    acceptance: text(raw.acceptance)
  }
  const missing = READY_FIELDS.filter((field) => !understanding[field])
  if (missing.length) {
    return {
      ok: false,
      code: 'incomplete_understanding',
      message: `理解还不齐：缺 ${missing.join(' / ')}`,
      missing
    }
  }
  const open = Array.isArray(input.openQuestions)
    ? input.openQuestions.map((item) => text(item)).filter(Boolean)
    : []
  if (open.length) {
    return {
      ok: false,
      code: 'open_questions',
      message: `还有未回答的必要问题（${open.length} 个）：${open.slice(0, 3).join('；')}`
    }
  }
  if (input.modeRevision !== current.modeRevision) {
    return {
      ok: false,
      code: 'stale_mode',
      message: `模式已经变过（提交 ${JSON.stringify(input.modeRevision)} ≠ 当前 ${current.modeRevision}）：按当前模式重新确认`
    }
  }
  if (input.goalRevision !== current.goalRevision) {
    return {
      ok: false,
      code: 'stale_goal',
      message: `目标状态已经变过（提交 ${JSON.stringify(input.goalRevision)} ≠ 当前 ${current.goalRevision}）`
    }
  }
  return { ok: true, understanding }
}

/** 就绪转移的结果：模式切标准 + 目标进入执行。 */
export interface ReadyTransitionResult {
  transitionId: string
  goalId: string
  goalRevision: number
  mode: 'standard'
  phase: 'executing'
  understanding: ReadyUnderstanding
}

/* ------------------------------------------------------- 目标报告与推进 */

export interface GoalReportInput {
  /** 幂等键。 */
  reportId: string
  phase: GoalPhase
  /** 提交时看到的目标 revision。 */
  goalRevision: number
  steps?: GoalStep[]
  evidence?: string[]
  /** 结构化产物 / 参考（U-3b，可选）。 */
  links?: GoalLink[]
  blocker?: string
  /** 本次失败的稳定签名（同一签名连续两次 → 强制 blocked）。 */
  failureSignature?: string
}

export type ReportRejectCode =
  | 'missing_report_id'
  | 'bad_phase'
  | 'stale_goal'
  | 'completed_needs_evidence'
  | 'blocked_needs_reason'
  | 'stopped_is_user_action'
  | 'already_completed'

export type ReportCheck =
  | {
      ok: true
      phase: GoalPhase
      steps: GoalStep[]
      evidence: string[]
      /** 校验通过的结构化链接（非法项已被丢弃，数量见 discardedLinks）。 */
      links: GoalLink[]
      /** 因 kind / scheme / 长度 / 重复被丢掉的数量（0 表示全部通过）。 */
      discardedLinks: number
      blocker: string | null
      failureSignature: string | null
    }
  | { ok: false; code: ReportRejectCode; message: string }

/**
 * 清洗结构化链接。
 *
 * 这里**不抛错**：一条坏链接不该让整份报告作废（目标还得推进）。
 * 丢掉多少条会通过 `checkGoalReport` 的 `discardedLinks` 告诉调用方，
 * 所以“被丢掉的不会计入产物/参考”是可核对的。
 */
export function sanitizeGoalLinks(value: unknown, now = Date.now()): GoalLink[] {
  if (!Array.isArray(value)) return []
  const out: GoalLink[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (out.length >= GOAL_LINK_LIMIT) break
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<GoalLink>
    const kind = GOAL_LINK_KINDS.includes(item.kind as GoalLinkKind) ? (item.kind as GoalLinkKind) : null
    if (!kind) continue
    const target = text(item.target).slice(0, GOAL_LINK_TEXT_MAX)
    if (!target) continue
    /* 不支持的 scheme 一律不登记：宿主不执行、也不计入产物 */
    if (kind === 'url') {
      if (!/^https?:\/\//i.test(target)) continue
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
      continue
    }
    const key = `${kind}:${target.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = text(item.label).slice(0, GOAL_LINK_TEXT_MAX)
    const srcRaw = (item.source ?? {}) as { sessionId?: unknown; messageId?: unknown }
    const sessionId = text(srcRaw.sessionId)
    const messageId = text(srcRaw.messageId)
    const checkRaw = item.check as Partial<GoalLinkCheck> | undefined
    const check =
      checkRaw && typeof checkRaw.ok === 'boolean' && typeof checkRaw.detail === 'string'
        ? {
            at: typeof checkRaw.at === 'number' && Number.isFinite(checkRaw.at) ? checkRaw.at : 0,
            ok: checkRaw.ok,
            method: 'exists' as const,
            detail: checkRaw.detail.slice(0, GOAL_LINK_TEXT_MAX)
          }
        : undefined
    out.push({
      kind,
      target,
      ...(label ? { label } : {}),
      ...(sessionId || messageId ? { source: { ...(sessionId ? { sessionId } : {}), ...(messageId ? { messageId } : {}) } } : {}),
      ...(check ? { check } : {}),
      addedAt: typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) ? item.addedAt : now
    })
  }
  return out
}

/** 清洗用户设的预算：只收正数，脏值一律当「没设」。 */
export function sanitizeGoalBudget(value: unknown): GoalBudget | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<GoalBudget>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
  const tokens = num(raw.tokens)
  const ms = num(raw.ms)
  if (tokens === undefined && ms === undefined) return null
  return { ...(tokens !== undefined ? { tokens } : {}), ...(ms !== undefined ? { ms } : {}) }
}

/** 清洗预算停止记录：脏值一律当「没有」。 */
export function sanitizeBudgetStop(
  value: unknown
): { at: number; reason: 'tokens' | 'time'; detail: string } | null {
  if (!value || typeof value !== 'object') return null
  const item = value as { at?: unknown; reason?: unknown; detail?: unknown }
  const reason = item.reason === 'tokens' || item.reason === 'time' ? item.reason : null
  if (!reason || typeof item.detail !== 'string' || !item.detail.trim()) return null
  return {
    at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
    reason,
    detail: item.detail.trim().slice(0, GOAL_LINK_TEXT_MAX)
  }
}

/** 把新登记的链接并进目标：先登记的留着，同 kind+target 只算一次，总数封顶。 */
export function mergeGoalLinks(current: GoalLink[], incoming: GoalLink[]): GoalLink[] {
  const out = [...current]
  const seen = new Set(out.map((l) => `${l.kind}:${l.target.toLowerCase()}`))
  for (const link of incoming) {
    if (out.length >= GOAL_LINK_LIMIT) break
    const key = `${link.kind}:${link.target.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(link)
  }
  return out
}

function sanitizeSteps(value: unknown): GoalStep[] {
  if (!Array.isArray(value)) return []
  const out: GoalStep[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<GoalStep>
    const title = text(item.title)
    if (!title) continue
    const status: GoalStep['status'] =
      item.status === 'done' || item.status === 'blocked' ? item.status : 'pending'
    const evidence = Array.isArray(item.evidence) ? item.evidence.map((e) => text(e)).filter(Boolean) : undefined
    out.push({ title, status, ...(evidence && evidence.length ? { evidence } : {}) })
  }
  return out
}

/**
 * 报告校验。
 *
 * 这里只管**形状与语义**（能不能这么说），能不能生效还要看 revision。
 * 三条硬否定：
 *   · `completed` 必须带证据 —— 「模型说完成」不是证据；
 *   · `blocked` 必须说清阻塞；
 *   · `stopped` 是**用户动作**，模型不能自报（否则它会用「我停了」掩盖失败）。
 */
export function checkGoalReport(input: Partial<GoalReportInput>, current: GoalState): ReportCheck {
  const reportId = text(input.reportId)
  if (!reportId) return { ok: false, code: 'missing_report_id', message: '报告必须带 reportId（幂等键）' }
  if (!isGoalPhase(input.phase)) {
    return { ok: false, code: 'bad_phase', message: `phase 必须是 ${GOAL_PHASES.join(' / ')} 之一` }
  }
  if (input.goalRevision !== current.revision) {
    return {
      ok: false,
      code: 'stale_goal',
      message: `目标已经变过（提交 ${JSON.stringify(input.goalRevision)} ≠ 当前 ${current.revision}）`
    }
  }
  if (current.phase === 'completed' && input.phase !== 'completed') {
    return { ok: false, code: 'already_completed', message: '目标已完成，不能再回退到进行中（要新目标请开新一轮）' }
  }
  if (input.phase === 'stopped') {
    return { ok: false, code: 'stopped_is_user_action', message: 'stopped 只能由用户停止产生，不能自己声明' }
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence.map((e) => text(e)).filter(Boolean) : []
  const blocker = text(input.blocker)
  if (input.phase === 'completed' && evidence.length === 0) {
    return {
      ok: false,
      code: 'completed_needs_evidence',
      message: '报完成必须带证据（命令输出 / 文件路径 / 测试结果），任务清单勾选不算'
    }
  }
  if (input.phase === 'blocked' && !blocker) {
    return { ok: false, code: 'blocked_needs_reason', message: '报 blocked 必须写清阻塞原因' }
  }
  const signature = text(input.failureSignature) || null
  /* 链接只做清洗：一条坏链接不该让整份报告作废，丢掉多少由 discardedLinks 交代 */
  const links = sanitizeGoalLinks(input.links)
  const discardedLinks = Array.isArray(input.links) ? Math.max(0, input.links.length - links.length) : 0
  return {
    ok: true,
    phase: input.phase,
    steps: sanitizeSteps(input.steps),
    evidence,
    links,
    discardedLinks,
    blocker: blocker || null,
    failureSignature: input.phase === 'blocked' ? null : signature
  }
}

/**
 * 推进目标状态。
 *
 * 关键规则（§5）：**同一失败签名连续两次 → 强制 blocked**，
 * 不管模型这次报的是 `executing` 还是 `verifying`。这是「blocked 不假装完成」的实现点：
 * 没有新证据 / 新路径就不许一直重试同一件事。
 */
export function applyGoalReport(
  current: GoalState,
  report: Extract<ReportCheck, { ok: true }>,
  now = Date.now()
): GoalState {
  let failure: FailureTrack | null = current.failure
  let phase = report.phase
  let blocker = report.blocker

  if (report.failureSignature) {
    const same = current.failure && current.failure.signature === report.failureSignature
    const count = same ? current.failure!.count + 1 : 1
    failure = { signature: report.failureSignature, count }
    if (count >= FAILURE_BLOCK_THRESHOLD && phase !== 'completed') {
      phase = 'blocked'
      blocker = blocker ?? `同一失败连续 ${count} 次（${report.failureSignature}）`
    }
  } else if (phase === 'executing' || phase === 'verifying' || phase === 'planning') {
    /* 报了进展却没有新失败签名：说明换路径了，计数归零。 */
    failure = null
  }
  if (phase === 'completed' || phase === 'blocked') failure = null

  return {
    ...current,
    phase,
    revision: current.revision + 1,
    steps: report.steps.length ? report.steps : current.steps,
    evidence: report.evidence.length ? report.evidence : current.evidence,
    links: mergeGoalLinks(current.links ?? [], report.links),
    blocker: phase === 'blocked' ? (blocker ?? current.blocker) : null,
    failure,
    updatedAt: now
  }
}

/**
 * 记一次「薄层拦下的重复动作」为失败签名（2026-09-22 的单轮兜底）。
 *
 * 与 `applyGoalReport` 里的那条失败累计**共用同一个阈値与形状**
 * （`FAILURE_BLOCK_THRESHOLD` / `FailureTrack`），差别只有两点：
 *   · 它不接 `report`：拦下只说明「又被拦了一次」，不代表目标阶段变了，
 *     所以没到阈値时**不动 `phase`**（否则一次重复就能把 executing 改写掉）；
 *   · 到了阈値一律 `blocked` —— 与 §5 的「同一失败连续两次 → blocked」对齐，
 *     且 `blocked` 不假装完成（这就是兜底想要的结局：停住等人看）。
 *
 * 签名由调用方传入（约定为 `REPEAT_BLOCK_SIGNATURE`，见 `shared/repeat-guard.ts`）。
 */
export function applyRepeatFailure(current: GoalState, signature: string, now = Date.now()): GoalState {
  const same = !!current.failure && current.failure.signature === signature
  const count = same ? current.failure!.count + 1 : 1
  const blocked =
    count >= FAILURE_BLOCK_THRESHOLD && current.phase !== 'completed' && current.phase !== 'blocked'
  return {
    ...current,
    phase: blocked ? 'blocked' : current.phase,
    blocker: blocked ? (current.blocker ?? `同一失败连续 ${count} 次（${signature}）`) : current.blocker,
    failure: blocked ? null : { signature, count },
    revision: current.revision + 1,
    updatedAt: now
  }
}

/** 就绪转移后的目标状态（原子提交的另一半：模式切标准由调用方一起做）。 */
export function applyReadyTransition(current: GoalState, result: ReadyTransitionResult, now = Date.now()): GoalState {
  return {
    goalId: result.goalId || current.goalId,
    phase: 'executing',
    revision: current.revision + 1,
    steps: current.steps,
    evidence: current.evidence,
    links: current.links ?? [],
    budget: current.budget ?? null,
    budgetStop: current.budgetStop ?? null,
    budgetUsage: current.budgetUsage ?? null,
    blocker: null,
    /* 就绪转移不改「持续目标」身份：那是用户在 `+` 菜单里单独设的 */
    pursue: current.pursue,
    brief: current.brief,
    failure: null,
    updatedAt: now
  }
}

/* ------------------------------------------------- 续行（S3b / S3c） */

/**
 * 用户设定了持续目标（`+` 菜单 → 目标）：重开一个计划，并把「不达成不结束」标记上。
 *
 * 为何要清空 steps / evidence：旧目标的步骤对新目标毫无意义，留着只会让
 * 续行正文给模型列一堆无关步骤 —— 那比空更坏（它会接着做上一件事）。
 */
export function applyPursuedGoal(
  current: GoalState,
  brief: PursuedBrief,
  goalId: string,
  now = Date.now()
): GoalState {
  return {
    ...emptyGoal(now),
    goalId,
    phase: 'planning',
    revision: current.revision + 1,
    pursue: true,
    brief
  }
}

/**
 * 续行的来源：
 *   · `ready`    —— 计划档就绪转移之后的「开始执行」（S3b）；
 *   · `continue` —— 自主档目标还在推进时的「接着干」（S3c）；
 *   · `retry`    —— 模型侧出错之后的「自动继续」（S5c）。
 * 三者共用一个落盘通道与同一个薄层消费器，区别只在正文与消息标签。
 */
/**
 * 续行种类。
 *
 * `handoff` 是实施-14 F4 加的：**交接**的 resume 也走这条自定义消息通道，
 * 不再用 `agent.send`（那是真用户消息，会冒充用户、也会被当成新的逻辑回合）。
 */
export type ResumeKind = 'ready' | 'continue' | 'retry' | 'handoff'

/**
 * 自主档**连续**自动续接的上限（S3c）。
 *
 * 为什么必须有：自主档下「目标未完成就再叫一轮」没有自然终点 ——
 * 模型判断失误时能无限烧额度。到这里就停下等人（§7 同一口径：
 * 到上限保留任务并说清需介入的原因，**不是**标完成）。
 * 用户说一句话就重新计数：有人在看着的时候不必限轮。
 */
export const AUTONOMOUS_CONTINUE_LIMIT = 8

/**
 * 待发续行记录（宿主写，薄层扩展读）。
 *
 * 为何要落盘：§4 的第三条防护 ——「**先持久化再启动**」：readiness 记录
 * 必须先落盘（并校验 revision）再启动标准轮；用户停止则废弃未消费的转移。
 */
export interface ResumeRecord {
  /** 幂等键：就绪转移用它的 `transitionId`；自主续接每次新生成一个。 */
  operationId: string
  at: number
  /** 给模型看的控制消息正文（**不是**用户说的话）。 */
  summary: string
  /** 缺省 `ready`：S3c 之前的记录没有这个字段（旧文件必须继续能读）。 */
  kind?: ResumeKind
}

/** 记录（或脏值）实际代表的续行种类 —— 旧记录一律当就绪续行。 */
export function resumeKindOf(resume: ResumeRecord | null | undefined): ResumeKind {
  const kind = resume?.kind
  return kind === 'continue' || kind === 'retry' || kind === 'handoff' ? kind : 'ready'
}

/** 目标是不是「还在推进」的阶段：只有这些阶段才值得自动续接。 */
export function isActiveGoalPhase(phase: GoalPhase): boolean {
  return phase === 'planning' || phase === 'executing' || phase === 'verifying'
}

/**
 * 用户改档之后，未消费的续行还该不该留着（实施-14 A3）。
 *
 * 两种会「接着干」的情形：
 *   · 新档是**自主档** —— 档位本身就意味着让它自己跑；
 *   · 目标带 `pursue` —— 用户在 `+` 菜单里明确要求的持续目标，与档位正交，
 *     标准档下同样要推进。
 *
 * 其余（切到标准 / 计划且只是档位驱动）都要作废：旧实现用 `mode !== 'standard'` 判，
 * 于是**从自主切回标准档**时，上一条「接着干」仍留在快照里，下一轮又自己跑起来。
 */
export function keepsGoalResumeOnModeChange(mode: string, pursue: boolean): boolean {
  return mode === 'autonomous' || pursue === true
}

/**
 * 自主档续接的正文（S3c）。
 *
 * 与就绪续行不同：这里没有「刚刚确认的理解」可复述，任务已经跑起来了，
 * 要的是**接着干**。所以正文只给三样：当前阶段、未完成步骤、续接口径。
 * `round` 是这次续接的序号（1-based）—— 模型据此知道自己在自动链路里，
 * 排障时也能把「第几次叫醒」与日志对上。
 */
export function goalContinueSummary(goal: GoalState, round: number): string {
  const pending = goal.steps.filter((step) => step.status !== 'done')
  const lines = [
    `自主档继续推进（第 ${round} 次自动续接；这条不是用户说的话，是宿主的控制消息）。`,
    '目标还没完成：不要问我、不要等我确认，接着干。',
    `- 当前阶段：${goal.phase}`
  ]
  /*
   * 用户设定的持续目标要把**原话与达成判据**复述一遍：模型自己总结的目标
   * 容易越做越小（“先搭个架子就行”），而判据是用户写的，不许由模型改写。
   */
  if (goal.brief) {
    lines.push(`- 用户原话：${goal.brief.goal}`)
    lines.push(`- 达成判据（必须自己验证，不能自己说了算）：${goal.brief.outcome}`)
  }
  if (pending.length) {
    lines.push('- 未完成步骤：')
    for (const step of pending.slice(0, 12)) {
      lines.push(`  ${step.status === 'blocked' ? '[受阻] ' : ''}${step.title}`)
    }
  } else {
    lines.push('- 还没有登记步骤：先把步骤想清楚，再动手')
  }
  if (goal.evidence.length) lines.push(`- 已有证据：${goal.evidence.slice(-3).join('；')}`)
  lines.push('每推进一步就用 `yan goal report` 更新状态；完成要带证据，真做不到就说清阻塞并报 `blocked`。')
  return lines.join('\n')
}

/** 就绪摘要的正文：既进会话（留痕），也进控制消息（模型看到的就是它）。 */
export function readyResumeSummary(understanding: ReadyUnderstanding): string {
  return [
    '工作模式已切到标准档（计划阶段结束）。请开始执行这个已经确认过的目标：',
    `- 目标：${understanding.goal}`,
    `- 交付物：${understanding.deliverable}`,
    `- 范围：${understanding.scope}`,
    `- 约束：${understanding.constraints}`,
    `- 验收：${understanding.acceptance}`,
    '按你自己定的步骤直接开工，不要再回头确认已确认过的内容。'
  ].join('\n')
}

/**
 * 该不该发这次续行？
 *
 * 三个条件缺一不可（§4 的「消费幂等」与「不盲发两次」）：
 *   ① 宿主留有未消费的 resume；
 *   ② 它的 `operationId` 与已消费的不是同一个；
 *   ③ 正文不为空（空的话发出去毫无意义）。
 */
export function shouldResume(
  resume: ResumeRecord | null | undefined,
  consumedOperationId: string | null | undefined
): boolean {
  if (!resume || !resume.operationId) return false
  if (!String(resume.summary ?? '').trim()) return false
  return resume.operationId !== (consumedOperationId ?? null)
}

/* --------------------------------------------------- CLI 参数归一 */

/**
 * 参数取值：`--request-file` 的 camelCase 与 CLI 的 `--kebab-case` 都认。
 * 两种写法都是用户会打的（CLI 里已有一句同样的约定）。
 */
function pick(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = raw[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = asText(value).trim()
  if (!text) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 列表：数组、逗号分隔或换行分隔的字符串都接受（CLI 的 flag 只能是字符串）。 */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asText(item).trim()).filter(Boolean)
  const text = asText(value).trim()
  if (!text) return []
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 把 `yan goal ready` 的参数归一到就绪提交。
 *
 * 为什么必须有内联形态：计划档**不能写文件**（那正是这个档位存在的意义），
 * 所以提交不能只支持 `--request-file`：
 *
 *   yan goal ready --transition-id tr-1 --confidence 0.97 \
 *     --goal "…" --deliverable "…" --scope "…" \
 *     --constraints "…" --acceptance "…" \
 *     --mode-revision 3 --goal-revision 0
 *
 * 五栏既可以从 `understanding` 对象取（请求文件形态），也可以从扁平字段取；
 * 两边都给时**扁平字段优先**（那是模型当场手写的那个）。
 */
export function normalizeReadyParams(raw: Record<string, unknown>): Partial<ReadySubmission> {
  const nested = (pick(raw, 'understanding') ?? {}) as Partial<ReadyUnderstanding>
  const field = (name: ReadyField): string => {
    const flat = pick(raw, name, name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
    return asText(flat ?? nested[name]).trim()
  }
  return {
    transitionId: asText(pick(raw, 'transitionId', 'transition-id')).trim(),
    confidence: asNumber(pick(raw, 'confidence')) ?? Number.NaN,
    understanding: {
      goal: field('goal'),
      deliverable: field('deliverable'),
      scope: field('scope'),
      constraints: field('constraints'),
      acceptance: field('acceptance')
    },
    openQuestions: asList(pick(raw, 'openQuestions', 'open-questions')),
    modeRevision: asNumber(pick(raw, 'modeRevision', 'mode-revision')) ?? Number.NaN,
    goalRevision: asNumber(pick(raw, 'goalRevision', 'goal-revision')) ?? Number.NaN
  }
}

/** `yan goal report` 的参数归一（与就绪提交同一套约定）。 */
export function normalizeReportParams(raw: Record<string, unknown>): Partial<GoalReportInput> {
  const phase = asText(pick(raw, 'phase')).trim()
  const failure = asText(pick(raw, 'failureSignature', 'failure-signature')).trim()
  const blocker = asText(pick(raw, 'blocker')).trim()
  const steps = pick(raw, 'steps')
  return {
    reportId: asText(pick(raw, 'reportId', 'report-id')).trim(),
    phase: phase as GoalPhase,
    goalRevision: asNumber(pick(raw, 'goalRevision', 'goal-revision')) ?? Number.NaN,
    ...(Array.isArray(steps) ? { steps: steps as GoalStep[] } : {}),
    evidence: asList(pick(raw, 'evidence')),
    ...(blocker ? { blocker } : {}),
    ...(failure ? { failureSignature: failure } : {})
  }
}

/** 一行摘要（摘要文本会进 CLI stdout / 界面，保持短）。 */
export function goalSummary(state: GoalState): string {
  const parts = [`${state.phase}(rev${state.revision})`]
  if (state.steps.length) {
    parts.push(`${state.steps.filter((s) => s.status === 'done').length}/${state.steps.length} 步已完成`)
  }
  if (state.blocker) parts.push(`阻塞：${state.blocker}`)
  return parts.join(' · ')
}

/** 脏文档一律回落到空目标（不能因为磁盘上一条坏记录把会话弄坏）。 */
export function normalizeGoalState(raw: unknown): GoalState {
  if (!raw || typeof raw !== 'object') return emptyGoal()
  const item = raw as Partial<GoalState>
  const phase = isGoalPhase(item.phase) ? item.phase : 'planning'
  const revision = typeof item.revision === 'number' && Number.isFinite(item.revision) && item.revision >= 0
    ? Math.floor(item.revision)
    : 0
  const failureRaw = item.failure as Partial<FailureTrack> | undefined
  const failure =
    failureRaw && typeof failureRaw.signature === 'string' && typeof failureRaw.count === 'number'
      ? { signature: failureRaw.signature, count: Math.max(1, Math.floor(failureRaw.count)) }
      : null
  const briefRaw = item.brief as Partial<PursuedBrief> | undefined
  const brief =
    briefRaw && typeof briefRaw.goal === 'string' && typeof briefRaw.outcome === 'string'
      ? { goal: briefRaw.goal.trim(), outcome: briefRaw.outcome.trim() }
      : null
  return {
    goalId: typeof item.goalId === 'string' ? item.goalId : '',
    phase,
    revision,
    steps: sanitizeSteps(item.steps),
    evidence: Array.isArray(item.evidence) ? item.evidence.map((e) => text(e)).filter(Boolean) : [],
    /* 旧文档没有 links（U-3b 之前写的）：读到就是空数组，不报错、不造数据 */
    links: sanitizeGoalLinks(item.links),
    /* 预算是用户设的：脏值一律当「没设」，不凭空造上限 */
    budget: sanitizeGoalBudget(item.budget),
    /* 脏的停止原因一律当「没有」：显示一个不存在的停止原因比不显示更糟 */
    budgetStop: sanitizeBudgetStop(item.budgetStop),
    /* 用量快照：tokens 可以是 null（未知），但必须是显式给的 */
    budgetUsage:
      item.budgetUsage && typeof item.budgetUsage === 'object'
        ? {
            tokens:
              typeof (item.budgetUsage as { tokens?: unknown }).tokens === 'number'
                ? Math.max(0, Math.round((item.budgetUsage as { tokens: number }).tokens))
                : null,
            at:
              typeof (item.budgetUsage as { at?: unknown }).at === 'number'
                ? ((item.budgetUsage as { at: number }).at as number)
                : 0
          }
        : null,
    blocker: typeof item.blocker === 'string' && item.blocker.trim() ? item.blocker.trim() : null,
    /* 只有真的办了设定才置位 —— 脏值不能凭空造一个「持续目标」。 */
    pursue: item.pursue === true,
    brief,
    failure,
    updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
  }
}
