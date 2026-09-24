/**
 * 目标（goal）的会话级存储（实施-05 S3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════════════
 * 计划档能不能「自动开工」，取决于一件事：**就绪转移只发生一次**。
 * 所以这一层不是「存个状态」，而是把三条不变式钉在磁盘上：
 *
 *   1. **键 = 会话文件路径**（不是 pi 的 `sessionId`）。
 *      实测过：同一份会话文件切走再切回，pi 会报一个**新的** `sessionId`；
 *      拿它作键会让模式与目标当场丢回初值（05-S2 踩过，同因）。
 *   2. **幂等**：`transitionId` / `reportId` 提交过就记下**结果**；
 *      同一个 id 再来一遍原样返回，不再推进 `revision`。
 *      模型重试、宿主重启、两条腿同时到达，都只能产生一次转移。
 *   3. **先落盘再续行**：`commitReady` 返回时状态已经写进磁盘
 *      （`persist()` 在返回前 await）—— 后面那一步「让模型继续执行」不能抢跑。
 *
 * 并发策略与 `work-mode-service` 一致：进程内一条串行队列，
 * 每次读-改-写都在队列里做，写完原子替换（先写临时文件再 `rename`）。
 */

import { mkdir, rename, writeFile, rm } from 'node:fs/promises'
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

/**
 * 读薄层写的「重复动作被拦下」计数（不存在 / 脏值一律当 0）。
 *
 * 同步读：调用点在回合收尾（轮结束的 state 推送）上，文件很小，
 * 而且这里**不能**因为一个计数文件而把收尾链路变成 async 分支 ——
 * 读不到就当没有（宁可少记一次失败，不拖慢回合）。
 */
function readRepeatGuardCounter(root: string, runtimeKey: string): unknown {
  try {
    return JSON.parse(readFileSync(join(root, REPEAT_GUARD_DIR, `${repeatGuardKey(runtimeKey)}.json`), 'utf8'))
  } catch {
    return null
  }
}

export const GOAL_FILE_NAME = 'goals.json'

/** 单个会话最多保留多少条幂等记录（防无界增长；超了丢最旧的）。 */
const MAX_IDEMPOTENCY_RECORDS = 50

/** 最多记多少个会话（与 work-modes.json 同量级）。 */
const MAX_ENTRIES = 2000

interface IdempotencyRecord {
  at: number
  /** 已提交的结果（就绪转移）或推进后的目标（报告）。 */
  result: unknown
}

export interface GoalEntry {
  goal: GoalState
  /** 已提交的就绪转移（`transitionId` → 结果）。 */
  transitions: Record<string, IdempotencyRecord>
  /** 已提交的目标报告（`reportId` → 结果）。 */
  reports: Record<string, IdempotencyRecord>
  /**
   * 待发续行（实施-05 S3b / S3c）。
   *
   * 宿主写、**薄层扩展读**：续行得用 pi 的 `custom` 消息（角色不是 user），
   * 而那个通道只有扩展 API 有（RPC 没有）。宿主只负责「该不该发」与落盘。
   * 清空时机：用户停止、用户把模式改回非标准档（撤销未发续行）、
   * 目标进入终态（completed / blocked / stopped，S3c）。
   */
  resume: ResumeRecord | null
  /**
   * 自主档「连续」自动续接次数（S3c）。
   *
   * 只在用户没有插话时累加：用户发一句话（`resetAutoContinues`）就归零。
   * 到 `AUTONOMOUS_CONTINUE_LIMIT` 就不再 arm 续行，等用户介入 ——
   * 这是「无人看管时不能无限烧额度」的落点。
   *
   * ⚠️ 它只数**真的安排了**的续接：同一条待发操作被重复 arm 不会把它推高（A6）。
   */
  autoContinues: number
  /**
   * 用户按了停止（实施-14 A2）。
   *
   * 与「放弃目标」（`phase: 'stopped'`）是两件事：停止一个回合只是
   * 「现在别跑了」，目标本身还在推进阶段。分开的理由是**恢复的出口不同** ——
   * 暂停要用户再发一句话 / 明确改档才继续，而放弃是目标级终态。
   * 持久化（不是进程内标志）：重启后也不能把用户刚按下的停止悄悄忘掉。
   */
  paused: boolean
  /**
   * 「重复动作被拦下」计入失败签名的消费游标（实施-14 A4）。
   *
   * 按**目标身份**分立：`goalId` 与当前目标不同就只重建基线、不记账 ——
   * 上一个目标欠下的拦下次数不该由新目标承担。
   * 不用目标自己的 `failure.count` 当账本：它会被「换签名 / 报进展」清掉，
   * 于是同一批旧 blocks 会被再计一遍，把正常推进的目标打成 blocked。
   */
  repeatCursor: { goalId: string; blocks: number } | null
  /**
   * 目标开始的时间（A-2）：首次报告 / 就绪转移时落一次，之后不再改。
   *
   * 为什么要它：预算要用「**这个目标**花了多少」而不是「这个会话花了多少」——
   * 同一个会话可以先做完一个目标再开下一个。
   */
  startedAt: number
  updatedAt: number
}

export interface GoalDocument {
  version: 1
  entries: Record<string, GoalEntry>
}

/** 一次「接着干」的 arm 结果；`reason` 的每一种都有对应的可读出口（实施-14 A6）。 */
export type ArmContinueReason = 'not_active' | 'limit' | 'paused' | 'pending' | 'budget'

export interface ArmContinueResult {
  armed: boolean
  reason?: ArmContinueReason
  /** 已安排的连续续接轮数（`armed:false` 时是当前计数）。 */
  round: number
  /** `reason==='budget'` 时说明是哪条预算用完了。 */
  detail?: string
}

export interface GoalCommitResult {
  ok: true
  /** 这次是**真的推进了**还是命中了幂等记录。 */
  replayed: boolean
  goal: GoalState
  result: ReadyTransitionResult
}

export interface GoalRejectResult {
  ok: false
  code: string
  message: string
  /** 出错的当下状态（模型据此纠正后重试）。 */
  goal: GoalState
}

export function goalDocumentPath(root: string = YAN_DIR): string {
  return join(root, GOAL_FILE_NAME)
}

export const GOAL_RESUME_DIRNAME = 'goal-resume'

export function goalResumeSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  const safe = sanitizeWorkModeKey(runtimeKey) ?? 'session'
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

/**
 * 把「待发续行」写成**给薄层看的每实例快照**（实施-05 S3b）。
 *
 * 为何不直接让扩展读 `goals.json`：那份文档按**会话文件路径**索引，
 * 而扩展只知道自己是个 runner（`YAN_SESSION_ID`）—— 多会话时它分不清哪条是自己的。
 * 快照用 runnerId 命名，与 `work-mode/<runnerId>.json` 同一个约定。
 *
 * 传 `null` 表示**撤销**：写一条空记录而不是删文件 —— 删文件与「从没写过」同形，
 * 而这两种情况在排障时要分开看（前者是用户停止的效果，后者是根本没发起转移）。
 */
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

/** Write a package continuation only when the slot is empty, consumed, or already ours. */
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

/** Clear only the matching one-shot continuation; never erase another feature's pending request. */
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
  await writeFile(temp, JSON.stringify(record), 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, JSON.stringify(record), 'utf8')
    await rm(temp, { force: true }).catch(() => {})
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

/** 脏消费游标一律当「没有」—— 重建基线比错记失败安全。 */
function sanitizeRepeatCursor(raw: unknown): { goalId: string; blocks: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as { goalId?: unknown; blocks?: unknown }
  const goalId = typeof item.goalId === 'string' ? item.goalId.trim() : ''
  const blocks = Number(item.blocks)
  if (!goalId || !Number.isFinite(blocks) || blocks < 0) return null
  return { goalId, blocks: Math.floor(blocks) }
}

/** 脏续行记录一律当「没有」（宁可少发一次，也不能拿半个记录去发消息）。 */
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

/** 脏文档一律降级成「没有这条记录」，不抛。 */
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
      /* 旧记录没有这两个字段：一律当「没暂停、没有游标」，不凭空造状态 */
      paused: item.paused === true,
      repeatCursor: sanitizeRepeatCursor(item.repeatCursor),
      startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? item.startedAt : 0,
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
    }
  }
  return { version: 1, entries }
}

/**
 * 只读核验一条链接（实施-15 A-1）。
 *
 * 边界（与 `GoalLinkCheck` 的注释一致，代码也是这么做的）：
 *   · 看存在性与大小 / 修改时间，**不执行**任何命令、不解析内容；
 *   · `url` 不联网，只当“形态合法”处理（scheme 已在 sanitizeGoalLinks 限定过）。
 * 所以它只能回答「还在不在」，回答不了「内容对不对」—— 那是用户验收的事。
 */
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
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: GoalStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  /** 读当前状态（不落盘）。未知会话返回空目标。 */
  state(sessionKey: string): GoalState {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return emptyGoal(this.now())
    return this.doc.entries[key]?.goal ?? emptyGoal(this.now())
  }

  /** 已提交过的就绪转移结果（`yan goal status` 与幂等回放都用它）。 */
  transitionResult(sessionKey: string, transitionId: string): ReadyTransitionResult | null {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return null
    const record = this.doc.entries[key]?.transitions[sanitizeWorkModeKey(transitionId) ?? '']
    return record ? (record.result as ReadyTransitionResult) : null
  }

  /** 待发续行（没读过盘也先看内存 —— 调用点都在同一进程）。 */
  resumeOf(sessionKey: string): ResumeRecord | null {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return null
    return this.doc.entries[key]?.resume ?? null
  }

  /** 当前会话已经连续自动续接了几轮（用于回执与排障，不改状态）。 */
  autoContinueCount(sessionKey: string): number {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return 0
    return this.doc.entries[key]?.autoContinues ?? 0
  }

  /**
   * 自主档收到用户请求时先登记一个目标。
   *
   * 旧链路要求模型先调用 `yan goal report` 才有目标，因此模型一次没有
   * 上报就会停在普通回答；自主档的职责是把这件事交给宿主先做。这里把
   * 用户请求压成一个可读步骤并立即落盘，后续仍由模型用 report 推进阶段、
   * 补证据或说明阻塞。已有活动目标视为用户对同一任务的补充，不另起一条。
   */
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
        /* 自主档先给模型一个不打断用户的计划阶段，再由它推进执行。 */
        phase: 'planning',
        /* 这是宿主登记目标的版本；模型第一次 report 从 rev1 开始。 */
        revision: 1,
        steps: [{ title, status: 'pending' }]
      }
      entry.transitions = {}
      entry.reports = {}
      entry.resume = null
      entry.autoContinues = 0
      /* 新目标：用户没暂停过它，重复拦下的消费游标也从零（A4） */
      entry.paused = false
      entry.repeatCursor = null
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { created: true, goal: entry.goal }
    })
  }

  /**
   * 用户显式设定持续目标（`+` 菜单 → 目标）。
   *
   * 与 `ensureAutonomousGoal` 的区别：那个是**档位**行为（自主档先替模型登记），
   * 这个是人**明确要求做成的事**，所以：
   *   · 重开一个目标（旧步骤清掉）—— 用户重新写了一遍目标，就是换了一件事；
   *   · 置 `pursue`，于是非自主档也会在回合收尾后继续被叫醒（与档位正交）。
   */
  async startPursued(sessionKey: string, brief: PursuedBrief): Promise<GoalState> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return emptyGoal(this.now())
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const at = this.now()
      entry.goal = applyPursuedGoal(entry.goal, brief, `goal-${randomUUID()}`, at)
      /* 换了目标：旧的幂等记录与未发续行全部作废，续接计数从零开始 */
      entry.transitions = {}
      entry.reports = {}
      entry.resume = null
      entry.autoContinues = 0
      /* 换目标就是用户明确重新开工：暂停意图与新目标的拦下游标都重置（A2 / A4） */
      entry.paused = false
      entry.repeatCursor = null
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return entry.goal
    })
  }

  /**
   * 撤销未发续行（用户停止 / 用户把模式改回非标准档）。
   *
   * 与 `stop()` 分开：停止当前回合不该把目标标成 `stopped`，
   * 但**必须**抦销还没发出去的续行 —— 否则用户按了停止，下一轮又自己跑起来。
   */
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

  /**
   * 提交一次就绪转移。
   *
   * 幂等先于校验：同一个 `transitionId` 再来时，即使此刻 `modeRevision` 已经变过
   * （正是这次转移造成的），也必须原样返回**已提交结果** —— 否则模型重试会收到
   * 「模式已过期」，看起来像失败，然后它可能换个 id 再提交一次。
   */
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
      /*
       * 续行记录与转移**同一次落盘**：§4 的「先持久化再启动」——
       * 扩展拿到 `ok` 之后随时可能读到它并开始执行，不能晚一步。
       */
      entry.resume = {
        operationId: result.transitionId,
        at,
        kind: 'ready',
        summary: readyResumeSummary(check.understanding)
      }
      /* 新目标开工：连续续接计数从零开始（S3c 与就绪转移共用这一份账） */
      entry.autoContinues = 0
      /* 明确开工 = 不再暂停（A2）；重复拦下的游标属于同一目标，保留 */
      entry.paused = false
      /* 先落盘再返回：调用方拿到 ok 时，续行的前提已经成立。 */
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { ok: true as const, replayed: false, goal: entry.goal, result }
    })
  }

  /** 用户按会话选择是否需要审阅计划；待审期间不允许切换这个选项。 */
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

  /** 澄清档启用审阅时，只落盘待审计划，不切模式或安排执行。 */
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
      /* 待审期间不能留下一条旧目标的自动续行。 */
      entry.resume = null
      entry.autoContinues = 0
      entry.updatedAt = at
      await this.persist()
      return { ok: true as const, pending: true as const, replayed: false, goal: entry.goal }
    })
  }

  /** 批准计划时二次比对目标 / 模式 revision；transitionId 也作为单次幂等键。 */
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
      /* 审批按钮本身安排下一轮；避免再写一条 goal-resume 造成重复开工。 */
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

  /** 用户选择修改计划时撤销待审快照；相同 transitionId 不会再批准旧内容。 */
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

  /** 工作模式离开澄清档或用户放弃目标时，撤销待审计划。 */
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

  /** 提交一次目标报告。幂等与就绪转移同一套。 */
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
      /*
       * 归属由**宿主**覆盖：链接里的 sessionId 一律改成这条会话。
       * 不信调用方自报 —— 否则 A 目标的报告可以把链接挂到 B 目标上。
       */
      for (const link of check.links) {
        link.source = { ...(link.source ?? {}), sessionId: key }
      }
      entry.goal = applyGoalReport(entry.goal, check, at)
      /* 首次推进目标时记开始时间（预算的参照起点） */
      if (!entry.startedAt) entry.startedAt = at
      /*
       * 每次报告都把**全部**链接重新只读核验一遍（含先前登记的）——
       * 这样「文件后来被删/被换」在下一次报告里就变成 ok:false，
       * 而不是永远停在当初那一次的结果上。
       */
      entry.goal.links = entry.goal.links.map((link) => ({ ...link, check: verifyGoalLink(link, at) }))
      /*
       * 目标级核验（实施-16 G-2）：把刚刚算出的逐条只读结果汇总成四种状态之一。
       * 与 links 的 check 用同一批事实，不再算第二遍（否则两处会不一致）；
       * 它是宿主写的事实，模型报告不能直接提交结论，也不单独推 revision。
       */
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
      /*
       * 目标进终态（completed / blocked）时，**同一次落盘里**把还没发出的续行清掉：
       * 否则「停在 executing 时 arm 的那条继续消息」会在目标已经完成之后才发出去，
       * 把模型重新叫起来干一件已经交付完的事（S3c 踩得起的坑，这里堵死）。
       */
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

  /**
   * 把薄层「重复动作被拦下」的累计计数计入目标失败签名（2026-09-22）。
   *
   * 为什么不放在 `report` 里：这两条链路完全不相干 —— 重复拦下可能发生在
   * 一个还没报过目标的会话里（那时目标不存在，也就不该凭空建一个）。
   * 所以这里**只改已经存在且还在推进的目标**，其余一律不碰。
   *
   * 「已经记过几次」用**独立持久化的消费游标**（`entry.repeatCursor`），
   * 不用目标自己的 `failure.count`（实施-14 A4）：后者会被「换签名 / 报进展」清掉，
   * 于是同一批旧 blocks 会被再计一遍，把正常推进的目标一瞬间打成 blocked。
   * 游标按 `goalId` 分立 —— 换了目标只重建基线，不把上一个目标欠下的痕迹算过来。
   *
   * 返回是否真的落盘（调用方只用于日志）。
   */
  async consumeRepeatBlocks(runtimeKey: string, sessionKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return false
      const entry = this.doc.entries[key]
      if (!entry) return false
      if (!isActiveGoalPhase(entry.goal.phase) || !entry.goal.goalId) return false

      /* 计数文件按**运行实例 id** 命名（薄层用的是 `YAN_SESSION_ID`，与续行快照同一个约定） */
      const snapshot = parseRepeatGuardSnapshot(readRepeatGuardCounter(this.root, runtimeKey))
      const goalId = entry.goal.goalId
      const cursor = entry.repeatCursor?.goalId === goalId ? entry.repeatCursor.blocks : null
      const at = this.now()

      /*
       * 首次见到这个目标（或换了目标）：**只建立基线**，不记账。
       * 这是 A4 现场的那一步 —— 旧 blocks 属于上一个目标 / 上一段历史，
       * 新目标不该因为“上一次被拦过两次”就直接 blocked。
       */
      if (cursor === null) {
        entry.repeatCursor = { goalId, blocks: snapshot.blocks }
        entry.updatedAt = at
        await this.persist()
        return false
      }

      const pending = pendingRepeatFailures(cursor, snapshot.blocks)
      if (pending <= 0) {
        /* 薄层把计数清零（用户发言 / 目标报进展）→ 游标跟着回落，否则永远数不动 */
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
      /* 消费到新的水位（不是“加上 pending”——脏文件下两者不等，会再次重复计） */
      entry.repeatCursor = { goalId, blocks: snapshot.blocks }
      entry.updatedAt = at
      /*
       * 进了终态（`blocked`）就把没发出的续行清掉 —— 与 `report` 同一条规则：
       * 不然「停在 executing 时 arm 的那条继续」会在目标已经被拦停之后才发出去，
       * 把模型重新叫起来干那件刚被拦下的事。
       */
      if (!isActiveGoalPhase(entry.goal.phase)) {
        entry.resume = null
        entry.autoContinues = 0
      }
      await this.persist()
      return true
    })
  }

  /**
   * 安排一次「自主档接着干」的续接（S3c）。
   *
   * 只负责**判断与落盘**，「模式是不是自主档」由调用方（宿主）判 ——
   * 这一层不该知道工作模式（那是另一份文档的另一份状态）。
   *
   * 五个条件同时成立才 arm：
   *   ① 目标还在推进阶段（终态不 arm）；
   *   ② 目标已经开始推进（`revision > 0`）—— 目标可以由宿主在自主档收到
   *      用户请求时登记，也可以由模型的第一份 report 建立；
   *   ③ 用户没有按停止（`paused`，实施-14 A2）；
   *   ④ 连续续接次数还没到上限；
   *   ⑤ 没有**还没被消费的**「接着干」（实施-14 A6）—— 同一条待发操作必须幂等，
   *      否则模型的每一份进展报告都会覆盖上一条未发出的指令，而轮数已经空转到上限。
   *
   * `options.consumed` 是「这条续行薄层发出去没有」的查询（按 runner 的消费文件）；
   * 不传就视为**没消费**（宁可少 arm 一次，也不能重复执行）。
   *
   * 返回值要能让调用方区分「没到可续接的状态」与「到上限 / 被暂停 / 已有待发」：
   * 每一种都要有可读出口，不能默默不续。
   */
  /** 目标开始时间（A-2 预算用）；没开始过就是 0。 */
  startOf(sessionKey: string): number {
    const key = normalizeSessionFileKey(sessionKey)
    return key ? (this.doc.entries[key]?.startedAt ?? 0) : 0
  }

  /**
   * 用户设 / 清目标级预算（A-2）。
   *
   * 只改预算与停止记录：**不删目标、不改 phase**。收紧到当前已超的额度不会
   * 当场把目标打成失败；下一次收尾评估时才会停止安排新轮（并记下原因）。
   * 放宽（或置 null）时清掉旧的停止记录，下次就能继续。
   */
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
      /** 目标到目前为止的用量（装配方给，宿主不自算）。不传 = 无法判定预算。 */
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
      /*
       * 目标级预算（A-2）：耗尽时**只停“安排新轮”**——
       * 不动 phase、不删目标、不当作失败。用户调了预算或主动发消息就恢复。
       * 用量未知时不判（无法算），界面显示未知即可。
       */
      if (options.usage) {
        /* 先把用量快照写下去：即使没超预算，用户也该在界面上看到“已用多少” */
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
      if (existing?.kind === 'continue') {
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

  /**
   * 用户按了停止 / 明确改档：登记或解除暂停意图（实施-14 A2）。
   *
   * 只改 `paused`，**不动** `resume`：撤销待发续行由 `clearResume` /
   * 快照清理负责。分开的理由是它们不总是同时发生 —— 例如目标级
   * `stopped` 会清续行，而“暂停”只是让下一次 arm 不被安排。
   *
   * 返回「是否真的改过」（调用方用于日志，不用于判定成功）。
   */
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

  /**
   * 把源片段的**宿主级目标事实**迁到目的片段（实施-14 F3 / §5.1）。
   *
   * 交接换的是物理片段，用户看到的是同一条会话 —— 所以「用户要什么」
   * （目标 / 验收标准 / pursue / 暂停）不该丢；而「这一段执行到哪」的幂等记录
   * 与待发续行属于源片段的执行租约，**不能**带过去：
   *
   *   · 继承：`goal`（同一 `goalId` / `revision` / 阶段 / 步骤 / 证据）、
   *     `pursue` 与 `brief`（在 goal 里）、`paused`；
   *   · 不继承：`transitions` / `reports`（幂等记录按会话键）、`resume`
   *     （目的段的续行由交接 resume 驱动）、`autoContinues`（新片段重新给满额度）、
   *     `repeatCursor`（拦下计数属于源片段）。
   *
   * `goalId` 保持不变是**有意**的：它表达「还是同一件事」，也是 A4 里
   * 「新目标不承担历史拦下」的判据 —— 换片段不该被当成换目标。
   *
   * 幂等：目的段已经有自己的记录且目标不同时，不覆盖（避免重放把真实进展抹掉）。
   * 返回是否真的写了盘。
   */
  async inheritTo(sourceKey: string, destKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const from = normalizeSessionFileKey(sourceKey)
      const to = normalizeSessionFileKey(destKey)
      if (!from || !to || from === to) return false
      const source = this.doc.entries[from]
      if (!source) return false
      const existing = this.doc.entries[to]
      if (existing && existing.goal.goalId && existing.goal.goalId !== source.goal.goalId) {
        /* 目的段已经有另一个目标：不把它抹掉（宁可少继承，也不能丢进展） */
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

  /** 读暂停意图（不落盘；没读过盘也先看内存）。 */
  isPaused(sessionKey: string): boolean {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return false
    return this.doc.entries[key]?.paused === true
  }

  /**
   * 用户说话了：连续续接计数归零（S3c）。
   *
   * 上限只约束「没人看管时的连续自动轮」，有人参与就该重新给满额度。
   * 只在真的变过时落盘 —— 每次发言都写一次文件没有意义。
   */
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

  /** 用户放弃目标：撤销未消费的转移资格并进入终态（§4「用户停止则废弃未消费的转移」）。
   *
   * `goal` 传 null 表示用当前存储里的目标（不再叠加一份副本）。 */
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
      /* 用户停止优先：未发出的续行一并作废（§5）；连续续接计数也归零（S3c） */
      entry.resume = null
      entry.autoContinues = 0
      /* 目标已放弃：暂停标志没有意义了（A2） */
      entry.paused = false
      entry.updatedAt = at
      await this.persist()
      return entry.goal
    })
  }

  /** 保证文档已从磁盘读过（幂等）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(goalDocumentPath(this.root), 'utf8')
      this.doc = sanitizeGoalDocument(JSON.parse(text))
    } catch {
      /* 文件不存在 / 读不了 / 坏 JSON：都当成「还没有任何目标」，不把界面弄挂 */
      this.doc = { version: 1, entries: {} }
    }
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

  /** 串行队列：所有读-改-写都在这里排队，避免两个提交互相覆盖。 */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = goalDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      /* 落盘失败不报成功：把内存态退回磁盘上的样子，让下一次提交重新走一遍。 */
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeGoalDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, entries: {} }
      }
      throw new Error('目标状态落盘失败')
    }
  }
}
