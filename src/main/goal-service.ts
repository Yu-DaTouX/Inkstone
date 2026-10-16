import { parsePersistedDocument } from './persisted-document'
import { mkdir, rename, rm } from 'node:fs/promises'
import { writeFileDurable } from './write-file-durable'
import { readFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  applyGoalReport,
  applyPursuedGoal,
  applyPendingReadyPlan,
  applyReadyApprovalMode,
  applyReadyTransition,
  clearPendingReadyPlan,
  applyRepeatFailure,
  checkGoalBudget,
  sanitizeGoalBudget,
  summarizeVerification,
  AUTONOMOUS_CONTINUE_LIMIT,
  checkGoalReport,
  checkReadySubmission,
  emptyGoal,
  goalContinueSummary,
  isActiveGoalPhase,
  normalizeGoalState,
  readyResumeSummary,
  type BudgetUsage,
  type GoalBudget,
  type GoalLink,
  type GoalLinkCheck,
  type GoalReportInput,
  type GoalState,
  type ReadyApprovalMode,
  type PursuedBrief,
  type ReadySubmission,
  type ReadyTransitionResult,
  type ResumeKind,
  type ResumeRecord
} from '../shared/goal'
import { normalizeSessionFileKey, sanitizeWorkModeKey } from './work-mode-service'
import {
  parseRepeatGuardSnapshot,
  pendingRepeatFailures,
  REPEAT_BLOCK_SIGNATURE,
  REPEAT_GUARD_DIR,
  repeatGuardKey
} from '../shared/repeat-guard'

function readRepeatGuardCounter(root: string, runtimeKey: string): unknown {
  try {
    return JSON.parse(readFileSync(join(root, REPEAT_GUARD_DIR, `${repeatGuardKey(runtimeKey)}.json`), 'utf8'))
  } catch {
    return null
  }
}

export const GOAL_FILE_NAME = 'goals.json'

const MAX_IDEMPOTENCY_RECORDS = 50

const MAX_ENTRIES = 2000

interface IdempotencyRecord {
  at: number
  result: unknown
}

export interface GoalEntry {
  goal: GoalState
  transitions: Record<string, IdempotencyRecord>
  reports: Record<string, IdempotencyRecord>
  resume: ResumeRecord | null
  autoContinues: number
  paused: boolean
  repeatCursor: { goalId: string; blocks: number } | null
  startedAt: number
  updatedAt: number
}

export interface GoalDocument {
  version: 1
  entries: Record<string, GoalEntry>
}

export type ArmContinueReason = 'not_active' | 'limit' | 'paused' | 'pending' | 'budget'

export interface ArmContinueResult {
  armed: boolean
  reason?: ArmContinueReason
  round: number
  detail?: string
}

export interface GoalCommitResult {
  ok: true
  replayed: boolean
  goal: GoalState
  result: ReadyTransitionResult
}

export interface GoalRejectResult {
  ok: false
  code: string
  message: string
  goal: GoalState
}

export function goalDocumentPath(root: string = YAN_DIR): string {
  return join(root, GOAL_FILE_NAME)
}

export const GOAL_RESUME_DIRNAME = 'goal-resume'

export function goalResumeSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  const safe = sanitizeWorkModeKey(runtimeKey)
  if (!safe) throw new Error('无效的运行实例标识')
  return join(root, GOAL_RESUME_DIRNAME, `${safe}.json`)
}

export function goalResumeConsumedPath(runtimeKey: string, root: string = YAN_DIR): string {
  const target = goalResumeSnapshotPath(runtimeKey, root)
  return join(dirname(target), `${basename(target, '.json')}.consumed.json`)
}

const resumeSnapshotTails = new Map<string, Promise<void>>()

function serializeResumeSnapshot<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = resumeSnapshotTails.get(path) ?? Promise.resolve()
  const task = previous.then(work, work)
  const tail = task.then(() => undefined, () => undefined)
  resumeSnapshotTails.set(path, tail)
  return task.finally(() => {
    if (resumeSnapshotTails.get(path) === tail) resumeSnapshotTails.delete(path)
  })
}

async function readResumeSnapshot(path: string): Promise<{ operationId: string | null; summary: string | null }> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { operationId?: unknown; summary?: unknown }
    return {
      operationId: typeof raw.operationId === 'string' ? raw.operationId : null,
      summary: typeof raw.summary === 'string' ? raw.summary : null
    }
  } catch {
    return { operationId: null, summary: null }
  }
}

async function readConsumedOperation(path: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { operationId?: unknown }
    return typeof raw.operationId === 'string' ? raw.operationId : null
  } catch {
    return null
  }
}

export async function writeGoalResumeSnapshot(
  runtimeKey: string,
  resume: ResumeRecord | null,
  root: string = YAN_DIR
): Promise<void> {
  const target = goalResumeSnapshotPath(runtimeKey, root)
  return serializeResumeSnapshot(target, async () => {
    await writeGoalResumeSnapshotUnlocked(runtimeKey, resume, target)
  })
}

export async function writeGoalResumeSnapshotIfVacant(
  runtimeKey: string,
  resume: ResumeRecord,
  root: string = YAN_DIR
): Promise<boolean> {
  const target = goalResumeSnapshotPath(runtimeKey, root)
  const consumed = goalResumeConsumedPath(runtimeKey, root)
  return serializeResumeSnapshot(target, async () => {
    const current = await readResumeSnapshot(target)
    if (current.operationId && current.operationId !== resume.operationId) {
      const consumedId = await readConsumedOperation(consumed)
      if (current.operationId !== consumedId) return false
    }
    if (current.operationId === resume.operationId) return true
    await writeGoalResumeSnapshotUnlocked(runtimeKey, resume, target)
    return true
  })
}

export async function clearGoalResumeSnapshotIfOperation(
  runtimeKey: string,
  operationId: string,
  root: string = YAN_DIR
): Promise<boolean> {
  const target = goalResumeSnapshotPath(runtimeKey, root)
  return serializeResumeSnapshot(target, async () => {
    const current = await readResumeSnapshot(target)
    if (current.operationId !== operationId) return false
    await writeGoalResumeSnapshotUnlocked(runtimeKey, null, target)
    return true
  })
}

export async function goalResumeContinuationWasConsumed(
  runtimeKey: string,
  operationId: string,
  root: string = YAN_DIR
): Promise<boolean> {
  return (await readConsumedOperation(goalResumeConsumedPath(runtimeKey, root))) === operationId
}

async function writeGoalResumeSnapshotUnlocked(
  runtimeKey: string,
  resume: ResumeRecord | null,
  target: string
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const record = resume
    ? {
        version: 1,
        runtimeKey,
        operationId: resume.operationId,
        summary: resume.summary,
        kind: resume.kind ?? 'ready',
        at: resume.at
      }
    : { version: 1, runtimeKey, operationId: null, summary: null, kind: null, at: null }
  const temp = `${target}.${process.pid}.tmp`
  await writeFileDurable(temp, JSON.stringify(record))
  try {
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function emptyEntry(): GoalEntry {
  return {
    goal: emptyGoal(),
    transitions: {},
    reports: {},
    resume: null,
    autoContinues: 0,
    paused: false,
    repeatCursor: null,
    startedAt: 0,
    updatedAt: 0
  }
}

function sanitizeRepeatCursor(raw: unknown): { goalId: string; blocks: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as { goalId?: unknown; blocks?: unknown }
  const goalId = typeof item.goalId === 'string' ? item.goalId.trim() : ''
  const blocks = Number(item.blocks)
  if (!goalId || !Number.isFinite(blocks) || blocks < 0) return null
  return { goalId, blocks: Math.floor(blocks) }
}

function sanitizeResume(raw: unknown): ResumeRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<ResumeRecord>
  const operationId = sanitizeWorkModeKey(item.operationId)
  const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
  if (!operationId || !summary) return null
  const kind: ResumeKind =
    item.kind === 'continue'
      ? 'continue'
      : item.kind === 'retry'
        ? 'retry'
        : item.kind === 'handoff'
          ? 'handoff'
          : 'ready'
  return {
    operationId,
    at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
    summary,
    kind
  }
}

function sanitizeIdempotency(raw: unknown): Record<string, IdempotencyRecord> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, IdempotencyRecord> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = sanitizeWorkModeKey(key)
    if (!id) continue
    const item = value as Partial<IdempotencyRecord> | null
    if (!item || typeof item !== 'object') continue
    out[id] = {
      at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
      result: item.result
    }
  }
  return out
}

export function sanitizeGoalDocument(raw: unknown): GoalDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, entries: {} }
  const doc = raw as Partial<GoalDocument>
  const entries: Record<string, GoalEntry> = {}
  for (const [key, value] of Object.entries(doc.entries ?? {})) {
    const id = normalizeSessionFileKey(key)
    if (!id) continue
    const item = (value ?? {}) as Partial<GoalEntry>
    entries[id] = {
      goal: normalizeGoalState(item.goal),
      transitions: sanitizeIdempotency(item.transitions),
      reports: sanitizeIdempotency(item.reports),
      resume: sanitizeResume(item.resume),
      autoContinues:
        typeof item.autoContinues === 'number' && Number.isFinite(item.autoContinues) && item.autoContinues > 0
          ? Math.floor(item.autoContinues)
          : 0,
      paused: item.paused === true,
      repeatCursor: sanitizeRepeatCursor(item.repeatCursor),
      startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? item.startedAt : 0,
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
    }
  }
  return { version: 1, entries }
}

function verifyGoalLink(link: GoalLink, now: number): GoalLinkCheck {
  if (link.kind === 'url') {
    return { at: now, ok: true, method: 'exists', detail: 'url 仅做形态校验（宿主不联网）' }
  }
  try {
    const st = statSync(link.target)
    return {
      at: now,
      ok: true,
      method: 'exists',
      detail: `${st.size} 字节 · ${new Date(st.mtimeMs).toISOString()}`
    }
  } catch {
    return { at: now, ok: false, method: 'exists', detail: '文件不存在（可能已被移动或删除）' }
  }
}

export interface GoalStoreOptions {
  root?: string
  now?: () => number
}

export class GoalStore {
  private readonly root: string
  private readonly now: () => number
  private doc: GoalDocument = { version: 1, entries: {} }
  private loadPromise: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: GoalStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  state(sessionKey: string): GoalState {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return emptyGoal(this.now())
    return this.doc.entries[key]?.goal ?? emptyGoal(this.now())
  }

  transitionResult(sessionKey: string, transitionId: string): ReadyTransitionResult | null {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return null
    const record = this.doc.entries[key]?.transitions[sanitizeWorkModeKey(transitionId) ?? '']
    return record ? (record.result as ReadyTransitionResult) : null
  }

  resumeOf(sessionKey: string): ResumeRecord | null {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return null
    return this.doc.entries[key]?.resume ?? null
  }

  autoContinueCount(sessionKey: string): number {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return 0
    return this.doc.entries[key]?.autoContinues ?? 0
  }

  async ensureAutonomousGoal(
    sessionKey: string,
    request: string
  ): Promise<{ created: boolean; goal: GoalState }> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return { created: false, goal: emptyGoal(this.now()) }

      const entry = (this.doc.entries[key] ??= emptyEntry())
      if (entry.goal.goalId && isActiveGoalPhase(entry.goal.phase)) {
        return { created: false, goal: entry.goal }
      }

      const at = this.now()
      const text = request.trim().replace(/\s+/g, ' ')
      const preview = Array.from(text).slice(0, 180).join('')
      const title = preview ? `完成用户请求：${preview}${text.length > 180 ? '…' : ''}` : '完成用户请求'
      entry.goal = {
        ...emptyGoal(at),
        goalId: `goal-${randomUUID()}`,
        phase: 'planning',
        revision: 1,
        steps: [{ title, status: 'pending' }]
      }
      entry.transitions = {}
      entry.reports = {}
      entry.resume = null
      entry.autoContinues = 0
      entry.startedAt = at
      entry.paused = false
      entry.repeatCursor = null
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { created: true, goal: entry.goal }
    })
  }

  async startPursued(sessionKey: string, brief: PursuedBrief): Promise<GoalState> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return emptyGoal(this.now())
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const at = this.now()
      entry.goal = applyPursuedGoal(entry.goal, brief, `goal-${randomUUID()}`, at)
      entry.transitions = {}
      entry.reports = {}
      entry.resume = null
      entry.autoContinues = 0
      entry.startedAt = at
      entry.paused = false
      entry.repeatCursor = null
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return entry.goal
    })
  }

  async clearResume(sessionKey: string): Promise<void> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return
      const entry = this.doc.entries[key]
      if (!entry?.resume) return
      entry.resume = null
      entry.updatedAt = this.now()
      await this.persist()
    })
  }

  snapshot(): GoalDocument {
    return { ...this.doc, entries: { ...this.doc.entries } }
  }

  async commitReady(
    sessionKey: string,
    submission: Partial<ReadySubmission>,
    current: { modeRevision: number; goalRevision: number },
    goalId: string
  ): Promise<GoalCommitResult | GoalRejectResult> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) {
        return { ok: false as const, code: 'bad_session', message: '会话身份不可用', goal: emptyGoal(this.now()) }
      }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const replayId = sanitizeWorkModeKey(submission.transitionId)
      if (replayId && entry.transitions[replayId]) {
        return {
          ok: true as const,
          replayed: true,
          goal: entry.goal,
          result: entry.transitions[replayId].result as ReadyTransitionResult
        }
      }

      const check = checkReadySubmission(submission, current)
      if (!check.ok) {
        return { ok: false as const, code: check.code, message: check.message, goal: entry.goal }
      }

      const at = this.now()
      const result: ReadyTransitionResult = {
        transitionId: replayId ?? randomUUID(),
        goalId: goalId || entry.goal.goalId || randomUUID(),
        goalRevision: entry.goal.revision + 1,
        mode: 'standard',
        phase: 'executing',
        understanding: check.understanding
      }
      entry.goal = applyReadyTransition(entry.goal, result, at)
      entry.transitions[result.transitionId] = { at, result }
      entry.resume = {
        operationId: result.transitionId,
        at,
        kind: 'ready',
        summary: readyResumeSummary(check.understanding)
      }
      entry.autoContinues = 0
      entry.paused = false
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { ok: true as const, replayed: false, goal: entry.goal, result }
    })
  }

  async setReadyApprovalMode(
    sessionKey: string,
    mode: ReadyApprovalMode,
    expectedGoalRevision: number
  ): Promise<{ ok: true; goal: GoalState } | GoalRejectResult> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) {
        return { ok: false as const, code: 'bad_session', message: '会话身份不可用', goal: emptyGoal(this.now()) }
      }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      if (entry.goal.pendingReady) {
        return { ok: false as const, code: 'review_pending', message: '请先批准或修改待审计划', goal: entry.goal }
      }
      if (entry.goal.revision !== expectedGoalRevision) {
        return { ok: false as const, code: 'stale_goal', message: '目标状态已变化，请刷新后重试', goal: entry.goal }
      }
      const next = applyReadyApprovalMode(entry.goal, mode, this.now())
      if (next !== entry.goal) {
        entry.goal = next
        entry.updatedAt = next.updatedAt
        await this.persist()
      }
      return { ok: true as const, goal: entry.goal }
    })
  }

  async prepareReadyReview(
    sessionKey: string,
    submission: Partial<ReadySubmission>,
    current: { modeRevision: number; goalRevision: number },
    goalId: string
  ): Promise<
    | { ok: true; pending: true; replayed: boolean; goal: GoalState }
    | GoalCommitResult
    | GoalRejectResult
  > {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) {
        return { ok: false as const, code: 'bad_session', message: '会话身份不可用', goal: emptyGoal(this.now()) }
      }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const replayId = sanitizeWorkModeKey(submission.transitionId)
      const pending = entry.goal.pendingReady
      if (pending && replayId === pending.transitionId) {
        return { ok: true as const, pending: true as const, replayed: true, goal: entry.goal }
      }
      if (replayId && entry.transitions[replayId]) {
        return {
          ok: true as const,
          replayed: true,
          goal: entry.goal,
          result: entry.transitions[replayId].result as ReadyTransitionResult
        }
      }
      if (pending) {
        return {
          ok: false as const,
          code: 'review_pending',
          message: '已有计划等待用户审阅；请先批准或选择修改计划',
          goal: entry.goal
        }
      }
      if (entry.goal.readyApproval !== 'review') {
        return {
          ok: false as const,
          code: 'approval_mode_changed',
          message: '计划审阅方式已变化，请按当前设置重新提交',
          goal: entry.goal
        }
      }
      const check = checkReadySubmission(submission, current)
      if (!check.ok) {
        return { ok: false as const, code: check.code, message: check.message, goal: entry.goal }
      }
      const at = this.now()
      const stableGoalId = goalId || entry.goal.goalId || randomUUID()
      entry.goal = applyPendingReadyPlan(
        entry.goal,
        {
          transitionId: replayId ?? randomUUID(),
          goalId: stableGoalId,
          modeRevision: current.modeRevision,
          understanding: check.understanding,
          createdAt: at
        },
        at
      )
      entry.resume = null
      entry.autoContinues = 0
      entry.updatedAt = at
      await this.persist()
      return { ok: true as const, pending: true as const, replayed: false, goal: entry.goal }
    })
  }

  async approveReadyReview(
    sessionKey: string,
    input: { transitionId: string; goalRevision: number; modeRevision: number }
  ): Promise<GoalCommitResult | GoalRejectResult> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) {
        return { ok: false as const, code: 'bad_session', message: '会话身份不可用', goal: emptyGoal(this.now()) }
      }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const transitionId = sanitizeWorkModeKey(input.transitionId)
      if (!transitionId) {
        return { ok: false as const, code: 'missing_transition_id', message: '批准必须带计划 transitionId', goal: entry.goal }
      }
      const committed = entry.transitions[transitionId]
      if (committed) {
        return {
          ok: true as const,
          replayed: true,
          goal: entry.goal,
          result: committed.result as ReadyTransitionResult
        }
      }
      const pending = entry.goal.pendingReady
      if (!pending || pending.transitionId !== transitionId) {
        return { ok: false as const, code: 'stale_goal', message: '待审计划已变化或已被取消', goal: entry.goal }
      }
      if (entry.goal.revision !== input.goalRevision || pending.goalRevision !== input.goalRevision) {
        return { ok: false as const, code: 'stale_goal', message: '目标状态已变化，请重新审阅当前计划', goal: entry.goal }
      }
      if (pending.modeRevision !== input.modeRevision || entry.goal.readyApproval !== 'review') {
        return { ok: false as const, code: 'stale_mode', message: '计划审阅方式已变化，请重新确认', goal: entry.goal }
      }
      const at = this.now()
      const result: ReadyTransitionResult = {
        transitionId,
        goalId: pending.goalId,
        goalRevision: entry.goal.revision + 1,
        mode: 'standard',
        phase: 'executing',
        understanding: pending.understanding
      }
      entry.goal = applyReadyTransition(entry.goal, result, at)
      entry.transitions[transitionId] = { at, result }
      entry.resume = null
      entry.autoContinues = 0
      entry.paused = false
      if (!entry.startedAt) entry.startedAt = at
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { ok: true as const, replayed: false, goal: entry.goal, result }
    })
  }

  async modifyReadyReview(
    sessionKey: string,
    input: { transitionId: string; goalRevision: number }
  ): Promise<{ ok: true; goal: GoalState } | GoalRejectResult> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) {
        return { ok: false as const, code: 'bad_session', message: '会话身份不可用', goal: emptyGoal(this.now()) }
      }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      if (
        !entry.goal.pendingReady ||
        entry.goal.pendingReady.transitionId !== sanitizeWorkModeKey(input.transitionId) ||
        entry.goal.revision !== input.goalRevision
      ) {
        return { ok: false as const, code: 'stale_goal', message: '待审计划已变化，请刷新后重试', goal: entry.goal }
      }
      const at = this.now()
      entry.goal = clearPendingReadyPlan(entry.goal, at)
      entry.resume = null
      entry.updatedAt = at
      await this.persist()
      return { ok: true as const, goal: entry.goal }
    })
  }

  async cancelReadyReview(sessionKey: string): Promise<GoalState | null> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return null
      const entry = this.doc.entries[key]
      if (!entry?.goal.pendingReady) return entry?.goal ?? null
      const at = this.now()
      entry.goal = clearPendingReadyPlan(entry.goal, at)
      entry.resume = null
      entry.updatedAt = at
      await this.persist()
      return entry.goal
    })
  }

  async report(
    sessionKey: string,
    input: Partial<GoalReportInput>
  ): Promise<{ ok: true; replayed: boolean; goal: GoalState } | GoalRejectResult> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) {
        return { ok: false as const, code: 'bad_session', message: '会话身份不可用', goal: emptyGoal(this.now()) }
      }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const replayId = sanitizeWorkModeKey(input.reportId)
      if (replayId && entry.reports[replayId]) {
        return { ok: true as const, replayed: true, goal: entry.goal }
      }
      if (entry.goal.pendingReady) {
        return {
          ok: false as const,
          code: 'review_pending',
          message: '计划等待用户审阅期间不能提交目标进度；请等待批准或修改计划',
          goal: entry.goal
        }
      }

      const check = checkGoalReport(input, entry.goal)
      if (!check.ok) {
        return { ok: false as const, code: check.code, message: check.message, goal: entry.goal }
      }

      const at = this.now()
      for (const link of check.links) {
        link.source = { ...(link.source ?? {}), sessionId: key }
      }
      entry.goal = applyGoalReport(entry.goal, check, at)
      if (!entry.startedAt) entry.startedAt = at
      entry.goal.links = entry.goal.links.map((link) => ({ ...link, check: verifyGoalLink(link, at) }))
      entry.goal.verification = summarizeVerification(
        entry.goal.links.map((link) => ({
          target: link.target,
          kind: link.kind,
          ok: link.check?.ok === true,
          detail: link.check?.detail ?? '未核验',
          at
        })),
        at
      )
      entry.reports[replayId ?? randomUUID()] = { at, result: entry.goal }
      if (!isActiveGoalPhase(entry.goal.phase)) {
        entry.resume = null
        entry.autoContinues = 0
      }
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { ok: true as const, replayed: false, goal: entry.goal }
    })
  }

  async consumeRepeatBlocks(runtimeKey: string, sessionKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return false
      const entry = this.doc.entries[key]
      if (!entry) return false
      if (!isActiveGoalPhase(entry.goal.phase) || !entry.goal.goalId) return false

      const snapshot = parseRepeatGuardSnapshot(readRepeatGuardCounter(this.root, runtimeKey))
      const goalId = entry.goal.goalId
      const cursor = entry.repeatCursor?.goalId === goalId ? entry.repeatCursor.blocks : null
      const at = this.now()

      if (cursor === null) {
        entry.repeatCursor = { goalId, blocks: snapshot.blocks }
        entry.updatedAt = at
        await this.persist()
        return false
      }

      const pending = pendingRepeatFailures(cursor, snapshot.blocks)
      if (pending <= 0) {
        if (snapshot.blocks < cursor) {
          entry.repeatCursor = { goalId, blocks: snapshot.blocks }
          entry.updatedAt = at
          await this.persist()
        }
        return false
      }

      for (let i = 0; i < pending; i++) {
        entry.goal = applyRepeatFailure(entry.goal, REPEAT_BLOCK_SIGNATURE, at)
      }
      entry.repeatCursor = { goalId, blocks: snapshot.blocks }
      entry.updatedAt = at
      if (!isActiveGoalPhase(entry.goal.phase)) {
        entry.resume = null
        entry.autoContinues = 0
      }
      await this.persist()
      return true
    })
  }

  startOf(sessionKey: string): number {
    const key = normalizeSessionFileKey(sessionKey)
    return key ? (this.doc.entries[key]?.startedAt ?? 0) : 0
  }

  async setBudget(sessionKey: string, budget: GoalBudget | null): Promise<GoalState> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return emptyGoal(this.now())
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const at = this.now()
      entry.goal = { ...entry.goal, budget: sanitizeGoalBudget(budget), budgetStop: null, updatedAt: at }
      entry.updatedAt = at
      await this.persist()
      return entry.goal
    })
  }

  async armContinue(
    sessionKey: string,
    options: {
      consumed?: (operationId: string) => Promise<boolean>
      usage?: BudgetUsage
    } = {}
  ): Promise<ArmContinueResult> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return { armed: false, reason: 'not_active' as const, round: 0 }
      const entry = this.doc.entries[key]
      if (!entry) return { armed: false, reason: 'not_active' as const, round: 0 }
      const round = entry.autoContinues
      if (!isActiveGoalPhase(entry.goal.phase) || entry.goal.revision <= 0) {
        return { armed: false, reason: 'not_active' as const, round }
      }
      if (entry.paused) return { armed: false, reason: 'paused' as const, round }
      if (round >= AUTONOMOUS_CONTINUE_LIMIT) return { armed: false, reason: 'limit' as const, round }
      if (options.usage) {
        entry.goal = {
          ...entry.goal,
          budgetUsage: { tokens: options.usage.tokens, at: this.now() }
        }
        const verdict = checkGoalBudget(entry.goal.budget, options.usage)
        if (verdict.stopped) {
          entry.goal = {
            ...entry.goal,
            budgetStop: { at: this.now(), reason: verdict.reason, detail: verdict.detail }
          }
          entry.updatedAt = this.now()
          await this.persist()
          return { armed: false, reason: 'budget' as const, round, detail: verdict.detail }
        }
      }

      const existing = entry.resume
      if (existing) {
        if (existing.kind !== 'continue') return { armed: false, reason: 'pending' as const, round }
        const consumed = options.consumed ? await options.consumed(existing.operationId) : false
        if (!consumed) return { armed: false, reason: 'pending' as const, round }
      }

      const at = this.now()
      entry.autoContinues = round + 1
      entry.resume = {
        operationId: randomUUID(),
        at,
        kind: 'continue',
        summary: goalContinueSummary(entry.goal, round + 1)
      }
      entry.updatedAt = at
      await this.persist()
      return { armed: true, round: round + 1 }
    })
  }

  async setPaused(sessionKey: string, paused: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return false
      const entry = this.doc.entries[key]
      if (!entry || entry.paused === paused) return false
      entry.paused = paused
      entry.updatedAt = this.now()
      await this.persist()
      return true
    })
  }

  async inheritTo(sourceKey: string, destKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const from = normalizeSessionFileKey(sourceKey)
      const to = normalizeSessionFileKey(destKey)
      if (!from || !to || from === to) return false
      const source = this.doc.entries[from]
      if (!source) return false
      const existing = this.doc.entries[to]
      if (existing && existing.goal.goalId && existing.goal.goalId !== source.goal.goalId) {
        return false
      }
      const at = this.now()
      this.doc.entries[to] = {
        goal: source.goal,
        transitions: {},
        reports: {},
        resume: null,
        autoContinues: 0,
        paused: source.paused,
        repeatCursor: null,
        startedAt: source.startedAt,
        updatedAt: at
      }
      await this.persist()
      return true
    })
  }

  isPaused(sessionKey: string): boolean {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return false
    return this.doc.entries[key]?.paused === true
  }

  async resetAutoContinues(sessionKey: string): Promise<void> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return
      const entry = this.doc.entries[key]
      if (!entry || entry.autoContinues === 0) return
      entry.autoContinues = 0
      entry.updatedAt = this.now()
      await this.persist()
    })
  }

  async stop(sessionKey: string, goal: GoalState | null): Promise<GoalState | null> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return null
      const entry = (this.doc.entries[key] ??= emptyEntry())
      if (entry.goal.phase === 'completed' || entry.goal.phase === 'stopped') return entry.goal
      const at = this.now()
      entry.goal = {
        ...(goal ?? entry.goal),
        phase: 'stopped',
        revision: entry.goal.revision + 1,
        pendingReady: null,
        failure: null,
        blocker: null,
        updatedAt: at
      }
      entry.resume = null
      entry.autoContinues = 0
      entry.paused = false
      entry.updatedAt = at
      await this.persist()
      return entry.goal
    })
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          this.doc = sanitizeGoalDocument(parsePersistedDocument(await readFile(goalDocumentPath(this.root), 'utf8'), { entries: 'object' }))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.doc = { version: 1, entries: {} }
            return
          }
          throw new Error('目标文件读取或解析失败，已拒绝覆盖', { cause: error })
        }
      })()
    }
    return this.loadPromise
  }

  private trim(entry: GoalEntry): void {
    for (const bag of [entry.transitions, entry.reports]) {
      const keys = Object.keys(bag)
      if (keys.length <= MAX_IDEMPOTENCY_RECORDS) continue
      keys
        .sort((a, b) => bag[a].at - bag[b].at)
        .slice(0, keys.length - MAX_IDEMPOTENCY_RECORDS)
        .forEach((key) => delete bag[key])
    }
    const ids = Object.keys(this.doc.entries)
    if (ids.length > MAX_ENTRIES) {
      ids
        .sort((a, b) => this.doc.entries[a].updatedAt - this.doc.entries[b].updatedAt)
        .slice(0, ids.length - MAX_ENTRIES)
        .forEach((key) => delete this.doc.entries[key])
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.load()
      const previous = structuredClone(this.doc)
      try { return await job() } catch (error) { this.doc = previous; throw error }
    }
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = goalDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFileDurable(temp, JSON.stringify(this.doc))
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new Error('目标状态落盘失败', { cause: error })
    }
  }
}
