/**
 * 目标（goal）的会话级存储（实施-05 S3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════════════
 * 澄清档能不能「自动开工」，取决于一件事：**就绪转移只发生一次**。
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
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  applyGoalReport,
  applyReadyTransition,
  AUTONOMOUS_CONTINUE_LIMIT,
  checkGoalReport,
  checkReadySubmission,
  emptyGoal,
  goalContinueSummary,
  isActiveGoalPhase,
  normalizeGoalState,
  readyResumeSummary,
  type GoalReportInput,
  type GoalState,
  type ReadySubmission,
  type ReadyTransitionResult,
  type ResumeKind,
  type ResumeRecord
} from '../shared/goal'
import { normalizeSessionFileKey, sanitizeWorkModeKey } from './work-mode-service'

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
   */
  autoContinues: number
  updatedAt: number
}

export interface GoalDocument {
  version: 1
  entries: Record<string, GoalEntry>
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
  return { goal: emptyGoal(), transitions: {}, reports: {}, resume: null, autoContinues: 0, updatedAt: 0 }
}

/** 脏续行记录一律当「没有」（宁可少发一次，也不能拿半个记录去发消息）。 */
function sanitizeResume(raw: unknown): ResumeRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<ResumeRecord>
  const operationId = sanitizeWorkModeKey(item.operationId)
  const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
  if (!operationId || !summary) return null
  const kind: ResumeKind = item.kind === 'continue' ? 'continue' : item.kind === 'retry' ? 'retry' : 'ready'
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
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
    }
  }
  return { version: 1, entries }
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
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { created: true, goal: entry.goal }
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
      /* 先落盘再返回：调用方拿到 ok 时，续行的前提已经成立。 */
      entry.updatedAt = at
      this.trim(entry)
      await this.persist()
      return { ok: true as const, replayed: false, goal: entry.goal, result }
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

      const check = checkGoalReport(input, entry.goal)
      if (!check.ok) {
        return { ok: false as const, code: check.code, message: check.message, goal: entry.goal }
      }

      const at = this.now()
      entry.goal = applyGoalReport(entry.goal, check, at)
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
   * 安排一次「自主档接着干」的续接（S3c）。
   *
   * 只负责**判断与落盘**，「模式是不是自主档」由调用方（宿主）判 ——
   * 这一层不该知道工作模式（那是另一份文档的另一份状态）。
   *
   * 三个条件同时成立才 arm：
   *   ① 目标还在推进阶段（终态不 arm）；
   *   ② 目标已经开始推进（`revision > 0`）—— 目标可以由宿主在自主档收到
   *      用户请求时登记，也可以由模型的第一份 report 建立；
   *   ③ 连续续接次数还没到上限。
   *
   * 返回值要能让调用方区分「没到可续接的状态」与「到上限了」：
   * 后者要告诉模型停下来向用户交代，不能默默不续。
   */
  async armContinue(
    sessionKey: string
  ): Promise<{ armed: boolean; reason?: 'not_active' | 'limit'; round: number }> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return { armed: false, reason: 'not_active' as const, round: 0 }
      const entry = this.doc.entries[key]
      if (!entry) return { armed: false, reason: 'not_active' as const, round: 0 }
      const round = entry.autoContinues
      if (!isActiveGoalPhase(entry.goal.phase) || entry.goal.revision <= 0) {
        return { armed: false, reason: 'not_active' as const, round }
      }
      if (round >= AUTONOMOUS_CONTINUE_LIMIT) return { armed: false, reason: 'limit' as const, round }

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

  /** 用户停止：撤销未消费的转移资格（§4「用户停止则废弃未消费的转移」）。 */
  async stop(sessionKey: string, goal: GoalState): Promise<GoalState | null> {
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
        failure: null,
        blocker: null,
        updatedAt: at
      }
      /* 用户停止优先：未发出的续行一并作废（§5）；连续续接计数也归零（S3c） */
      entry.resume = null
      entry.autoContinues = 0
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
