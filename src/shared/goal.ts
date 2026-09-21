/**
 * 目标状态与「澄清就绪」转移（实施-05 S3 的契约与纯逻辑）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════
 * 澄清档（`clarify`）的目标是：**把目标问清楚，然后自动开工**。
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
  /** `blocked` 时必填。 */
  blocker: string | null
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
    blocker: null,
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
      blocker: string | null
      failureSignature: string | null
    }
  | { ok: false; code: ReportRejectCode; message: string }

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
  return {
    ok: true,
    phase: input.phase,
    steps: sanitizeSteps(input.steps),
    evidence,
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
    blocker: phase === 'blocked' ? (blocker ?? current.blocker) : null,
    failure,
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
    blocker: null,
    failure: null,
    updatedAt: now
  }
}

/* ------------------------------------------------- 续行（S3b / S3c） */

/**
 * 续行的来源：
 *   · `ready`    —— 澄清档就绪转移之后的「开始执行」（S3b）；
 *   · `continue` —— 自主档目标还在推进时的「接着干」（S3c）；
 *   · `retry`    —— 模型侧出错之后的「自动继续」（S5c）。
 * 三者共用一个落盘通道与同一个薄层消费器，区别只在正文与消息标签。
 */
export type ResumeKind = 'ready' | 'continue' | 'retry'

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
  return kind === 'continue' || kind === 'retry' ? kind : 'ready'
}

/** 目标是不是「还在推进」的阶段：只有这些阶段才值得自动续接。 */
export function isActiveGoalPhase(phase: GoalPhase): boolean {
  return phase === 'planning' || phase === 'executing' || phase === 'verifying'
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
    '工作模式已切到标准档（澄清阶段结束）。请开始执行这个已经确认过的目标：',
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
 * 为什么必须有内联形态：澄清档**不能写文件**（那正是这个档位存在的意义），
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
  return {
    goalId: typeof item.goalId === 'string' ? item.goalId : '',
    phase,
    revision,
    steps: sanitizeSteps(item.steps),
    evidence: Array.isArray(item.evidence) ? item.evidence.map((e) => text(e)).filter(Boolean) : [],
    blocker: typeof item.blocker === 'string' && item.blocker.trim() ? item.blocker.trim() : null,
    failure,
    updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
  }
}
