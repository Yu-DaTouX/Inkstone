export const GOAL_PHASES = ['planning', 'executing', 'verifying', 'completed', 'blocked', 'stopped'] as const

export type GoalPhase = (typeof GOAL_PHASES)[number]

export const READY_CONFIDENCE_THRESHOLD = 0.95

export const FAILURE_BLOCK_THRESHOLD = 2

export const READY_FIELDS = ['goal', 'deliverable', 'scope', 'constraints', 'acceptance'] as const

export type ReadyField = (typeof READY_FIELDS)[number]

export interface ReadyUnderstanding {
  goal: string
  deliverable: string
  scope: string
  constraints: string
  acceptance: string
}

export type ReadyApprovalMode = 'automatic' | 'review'

export interface PendingReadyPlan {
  transitionId: string
  goalId: string
  modeRevision: number
  goalRevision: number
  understanding: ReadyUnderstanding
  createdAt: number
}

export interface GoalStep {
  title: string
  status: 'pending' | 'done' | 'blocked'
  evidence?: string[]
}

export interface GoalBudget {
  tokens?: number
  ms?: number
}

export interface BudgetUsage {
  tokens: number | null
  elapsedMs: number
}

export type BudgetStop =
  | { stopped: false; note?: string }
  | { stopped: true; reason: 'tokens' | 'time'; detail: string }

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

export const GOAL_LINK_KINDS = ['file', 'url', 'artifact'] as const
export type GoalLinkKind = (typeof GOAL_LINK_KINDS)[number]

export const GOAL_LINK_LIMIT = 20
export const GOAL_LINK_TEXT_MAX = 500

export interface GoalLink {
  kind: GoalLinkKind
  target: string
  label?: string
  source?: { sessionId?: string; messageId?: string }
  check?: GoalLinkCheck
  addedAt: number
}

export interface GoalLinkCheck {
  at: number
  ok: boolean
  method: 'exists'
  detail: string
}

export const GOAL_VERIFICATION_STATUSES = ['not_checked', 'passed', 'failed', 'manual_review'] as const
export type GoalVerificationStatus = (typeof GOAL_VERIFICATION_STATUSES)[number]

export interface GoalVerificationCheck {
  target: string
  kind: GoalLinkKind
  ok: boolean
  detail: string
  at: number
}

export interface GoalVerification {
  status: GoalVerificationStatus
  at: number
  checks: GoalVerificationCheck[]
  detail: string
}

export function summarizeVerification(
  checks: GoalVerificationCheck[],
  now = Date.now()
): GoalVerification {
  if (checks.length === 0) {
    return { status: 'not_checked', at: now, checks: [], detail: '目标还没有声明可核验的产物' }
  }
  const remote = checks.filter((c) => c.kind === 'url')
  const local = checks.filter((c) => c.kind !== 'url')
  if (local.length === 0) {
    return {
      status: 'manual_review',
      at: now,
      checks,
      detail: '只声明了链接；宿主不联网核验，需人工确认'
    }
  }
  const missing = local.filter((c) => !c.ok)
  if (missing.length) {
    return {
      status: 'failed',
      at: now,
      checks,
      detail: `${missing.length} 项本地产物不存在（可能已被移动或删除）`
    }
  }
  if (remote.length) {
    return {
      status: 'manual_review',
      at: now,
      checks,
      detail: `本地产物都存在，另有 ${remote.length} 条链接需人工确认`
    }
  }
  return {
    status: 'passed',
    at: now,
    checks,
    detail: `${local.length} 项本地产物都存在（只证明存在，不证明内容正确）`
  }
}

function normalizeVerification(raw: unknown): GoalVerification | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<GoalVerification>
  if (!GOAL_VERIFICATION_STATUSES.includes(item.status as GoalVerificationStatus)) return null
  return {
    status: item.status as GoalVerificationStatus,
    at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
    checks: Array.isArray(item.checks)
      ? item.checks
          .filter((c): c is GoalVerificationCheck => !!c && typeof c === 'object')
          .map((c) => ({
            target: text(c.target),
            kind: GOAL_LINK_KINDS.includes(c.kind as GoalLinkKind) ? (c.kind as GoalLinkKind) : 'file',
            ok: c.ok === true,
            detail: text(c.detail),
            at: typeof c.at === 'number' && Number.isFinite(c.at) ? c.at : 0
          }))
      : [],
    detail: text(item.detail)
  }
}

export interface PursuedBrief {
  goal: string
  outcome: string
  deliverable?: string
  scope?: string
  constraints?: string
}

export interface FailureTrack {
  signature: string
  count: number
}

export interface GoalState {
  goalId: string
  phase: GoalPhase
  revision: number
  steps: GoalStep[]
  evidence: string[]
  links: GoalLink[]
  verification: GoalVerification | null
  budget: GoalBudget | null
  budgetStop: { at: number; reason: 'tokens' | 'time'; detail: string } | null
  budgetUsage?: { tokens: number | null; at: number } | null
  blocker: string | null
  pursue: boolean
  brief: PursuedBrief | null
  readyApproval: ReadyApprovalMode
  pendingReady: PendingReadyPlan | null
  failure: FailureTrack | null
  updatedAt: number
}

export function emptyGoal(now = 0): GoalState {
  return {
    goalId: '',
    phase: 'planning',
    revision: 0,
    steps: [],
    evidence: [],
    links: [],
    verification: null,
    budget: null,
    budgetStop: null,
    budgetUsage: null,
    blocker: null,
    pursue: false,
    brief: null,
    readyApproval: 'automatic',
    pendingReady: null,
    failure: null,
    updatedAt: now
  }
}

export function isGoalPhase(value: unknown): value is GoalPhase {
  return typeof value === 'string' && (GOAL_PHASES as readonly string[]).includes(value)
}

export interface ReadySubmission {
  transitionId: string
  confidence: number
  understanding: Partial<ReadyUnderstanding>
  openQuestions: string[]
  modeRevision: number
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

export function checkReadySubmission(
  input: Partial<ReadySubmission>,
  current: { modeRevision: number; goalRevision: number }
): ReadyCheck {
  const transitionId = text(input.transitionId)
  if (!transitionId) {
    return { ok: false, code: 'missing_transition_id', message: '就绪提交必须带 transitionId（幂等键）' }
  }
  const confidence = typeof input.confidence === 'number' ? input.confidence : Number.NaN
  if (!Number.isFinite(confidence) || confidence < READY_CONFIDENCE_THRESHOLD || confidence > 1) {
    return {
      ok: false,
      code: 'confidence_too_low',
      message: `confidence 必须是 ${READY_CONFIDENCE_THRESHOLD} 到 1 之间的数字（收到 ${JSON.stringify(input.confidence)}）`
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

export interface ReadyTransitionResult {
  transitionId: string
  goalId: string
  goalRevision: number
  mode: 'standard'
  phase: 'executing'
  understanding: ReadyUnderstanding
}

export interface GoalReportInput {
  reportId: string
  phase: GoalPhase
  goalRevision: number
  steps?: GoalStep[]
  evidence?: string[]
  links?: GoalLink[]
  blocker?: string
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
      links: GoalLink[]
      discardedLinks: number
      blocker: string | null
      failureSignature: string | null
    }
  | { ok: false; code: ReportRejectCode; message: string }

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

export function sanitizeGoalBudget(value: unknown): GoalBudget | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<GoalBudget>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
  const tokens = num(raw.tokens)
  const ms = num(raw.ms)
  if (tokens === undefined && ms === undefined) return null
  return { ...(tokens !== undefined ? { tokens } : {}), ...(ms !== undefined ? { ms } : {}) }
}

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
    verification: phase === 'completed' ? null : current.verification,
    blocker: phase === 'blocked' ? (blocker ?? current.blocker) : null,
    failure,
    updatedAt: now
  }
}

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

export function applyReadyTransition(current: GoalState, result: ReadyTransitionResult, now = Date.now()): GoalState {
  return {
    goalId: result.goalId || current.goalId,
    phase: 'executing',
    revision: current.revision + 1,
    steps: current.steps,
    evidence: current.evidence,
    links: current.links ?? [],
    verification: current.verification ?? null,
    budget: current.budget ?? null,
    budgetStop: current.budgetStop ?? null,
    budgetUsage: current.budgetUsage ?? null,
    blocker: null,
    pursue: current.pursue,
    brief: current.brief,
    readyApproval: current.readyApproval ?? 'automatic',
    pendingReady: null,
    failure: null,
    updatedAt: now
  }
}

export function applyPendingReadyPlan(
  current: GoalState,
  input: Omit<PendingReadyPlan, 'goalRevision'>,
  now = Date.now()
): GoalState {
  const revision = current.revision + 1
  return {
    ...current,
    goalId: input.goalId,
    phase: 'planning',
    revision,
    pendingReady: { ...input, goalRevision: revision },
    updatedAt: now
  }
}

export function clearPendingReadyPlan(current: GoalState, now = Date.now()): GoalState {
  if (!current.pendingReady) return current
  return {
    ...current,
    phase: 'planning',
    pendingReady: null,
    revision: current.revision + 1,
    updatedAt: now
  }
}

export function applyReadyApprovalMode(
  current: GoalState,
  mode: ReadyApprovalMode,
  now = Date.now()
): GoalState {
  if (current.pendingReady || current.readyApproval === mode) return current
  return { ...current, readyApproval: mode, revision: current.revision + 1, updatedAt: now }
}

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
    brief,
    readyApproval: current.readyApproval ?? 'automatic'
  }
}

export type ResumeKind = 'ready' | 'continue' | 'retry' | 'handoff'

export const AUTONOMOUS_CONTINUE_LIMIT = 8

export interface ResumeRecord {
  operationId: string
  at: number
  summary: string
  kind?: ResumeKind
}

export function resumeKindOf(resume: ResumeRecord | null | undefined): ResumeKind {
  const kind = resume?.kind
  return kind === 'continue' || kind === 'retry' || kind === 'handoff' ? kind : 'ready'
}

export function isActiveGoalPhase(phase: GoalPhase): boolean {
  return phase === 'planning' || phase === 'executing' || phase === 'verifying'
}

export function keepsGoalResumeOnModeChange(mode: string, pursue: boolean): boolean {
  return mode === 'autonomous' || pursue === true
}

export function goalContinueSummary(goal: GoalState, round: number): string {
  const pending = goal.steps.filter((step) => step.status !== 'done')
  const lines = [
    `自主档继续推进（第 ${round} 次自动续接；这条不是用户说的话，是宿主的控制消息）。`,
    '目标还没完成：不要问我、不要等我确认，接着干。',
    `- 当前阶段：${goal.phase}`
  ]
  if (goal.brief) {
    lines.push(`- 用户原话：${goal.brief.goal}`)
    lines.push(`- 达成判据（必须自己验证，不能自己说了算）：${goal.brief.outcome}`)
    if (goal.brief.deliverable) lines.push(`- 交付物：${goal.brief.deliverable}`)
    if (goal.brief.scope) lines.push(`- 范围：${goal.brief.scope}`)
    if (goal.brief.constraints) lines.push(`- 约束：${goal.brief.constraints}`)
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

export function shouldResume(
  resume: ResumeRecord | null | undefined,
  consumedOperationId: string | null | undefined
): boolean {
  if (!resume || !resume.operationId) return false
  if (!String(resume.summary ?? '').trim()) return false
  return resume.operationId !== (consumedOperationId ?? null)
}

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

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asText(item).trim()).filter(Boolean)
  const text = asText(value).trim()
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

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

export function normalizeReportParams(raw: Record<string, unknown>): Partial<GoalReportInput> {
  const phase = asText(pick(raw, 'phase')).trim()
  const failure = asText(pick(raw, 'failureSignature', 'failure-signature')).trim()
  const blocker = asText(pick(raw, 'blocker')).trim()
  const steps = pick(raw, 'steps')
  const links = pick(raw, 'links')
  return {
    reportId: asText(pick(raw, 'reportId', 'report-id')).trim(),
    phase: phase as GoalPhase,
    goalRevision: asNumber(pick(raw, 'goalRevision', 'goal-revision')) ?? Number.NaN,
    ...(Array.isArray(steps) ? { steps: steps as GoalStep[] } : {}),
    evidence: asList(pick(raw, 'evidence')),
    ...(Array.isArray(links) ? { links: links as GoalLink[] } : {}),
    ...(blocker ? { blocker } : {}),
    ...(failure ? { failureSignature: failure } : {})
  }
}

export function goalSummary(state: GoalState): string {
  const parts = [`${state.phase}(rev${state.revision})`]
  if (state.steps.length) {
    parts.push(`${state.steps.filter((s) => s.status === 'done').length}/${state.steps.length} 步已完成`)
  }
  if (state.blocker) parts.push(`阻塞：${state.blocker}`)
  if (state.pendingReady) {
    parts.push(`计划等待用户审阅（transitionId=${state.pendingReady.transitionId}）；批准前保持只读`)
  } else if (state.readyApproval === 'review') {
    parts.push('计划就绪后需用户审阅，再开始执行')
  }
  if (state.verification) parts.push(`核验：${state.verification.status}`)
  return parts.join(' · ')
}

export function normalizePursuedBrief(raw: unknown): PursuedBrief | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<PursuedBrief>
  const goal = text(item.goal)
  const outcome = text(item.outcome)
  if (!goal || !outcome) return null
  const brief: PursuedBrief = { goal, outcome }
  const deliverable = text(item.deliverable)
  if (deliverable) brief.deliverable = deliverable
  const scope = text(item.scope)
  if (scope) brief.scope = scope
  const constraints = text(item.constraints)
  if (constraints) brief.constraints = constraints
  return brief
}

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
  const brief = normalizePursuedBrief(item.brief)
  const pendingRaw = item.pendingReady as Partial<PendingReadyPlan> | null | undefined
  const pendingUnderstanding = pendingRaw?.understanding
  const pendingReady =
    pendingRaw &&
    typeof pendingRaw.transitionId === 'string' && pendingRaw.transitionId.trim() &&
    typeof pendingRaw.goalId === 'string' && pendingRaw.goalId.trim() &&
    typeof pendingRaw.modeRevision === 'number' && Number.isFinite(pendingRaw.modeRevision) &&
    typeof pendingRaw.goalRevision === 'number' && Number.isFinite(pendingRaw.goalRevision) &&
    typeof pendingRaw.createdAt === 'number' && Number.isFinite(pendingRaw.createdAt) &&
    pendingUnderstanding && READY_FIELDS.every((field) => text(pendingUnderstanding[field]))
      ? {
          transitionId: pendingRaw.transitionId.trim(),
          goalId: pendingRaw.goalId.trim(),
          modeRevision: Math.max(0, Math.floor(pendingRaw.modeRevision)),
          goalRevision: Math.max(0, Math.floor(pendingRaw.goalRevision)),
          understanding: {
            goal: text(pendingUnderstanding.goal),
            deliverable: text(pendingUnderstanding.deliverable),
            scope: text(pendingUnderstanding.scope),
            constraints: text(pendingUnderstanding.constraints),
            acceptance: text(pendingUnderstanding.acceptance)
          },
          createdAt: pendingRaw.createdAt
        }
      : null
  return {
    goalId: typeof item.goalId === 'string' ? item.goalId : '',
    phase,
    revision,
    steps: sanitizeSteps(item.steps),
    evidence: Array.isArray(item.evidence) ? item.evidence.map((e) => text(e)).filter(Boolean) : [],
    links: sanitizeGoalLinks(item.links),
    verification: normalizeVerification(item.verification),
    budget: sanitizeGoalBudget(item.budget),
    budgetStop: sanitizeBudgetStop(item.budgetStop),
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
    pursue: item.pursue === true,
    brief,
    readyApproval: item.readyApproval === 'review' ? 'review' : 'automatic',
    pendingReady,
    failure,
    updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
  }
}
