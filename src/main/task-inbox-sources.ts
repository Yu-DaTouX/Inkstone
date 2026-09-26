/**
 * 收件箱的真实事实源组装（实施-28 T1 契约 → T2 界面之间的那一层）。
 *
 * ── 为什么单独一个文件 ──
 *   `task-inbox-service.ts` 是**纯投影**：喂它什么源就投影什么，不认识 sessions /
 *   runners / task-plans 这些宿主概念（那样它才能被单测直接驱动）。
 *   这里负责把宿主的三样东西接进去：
 *     · 会话目录（`listSessions`，433MB 的那一份，最贵）
 *     · 运行实例注册表（`RunnerRegistry.statuses()`，同步快照）
 *     · 宿主任务日志（`currentTaskPlan`，按会话读）
 *
 * ── 没接进来的源，以及为什么 ──
 *   `readGoal` / `readQuestion` / `readStudy` / `readSubagents` / `readAwaitingReview`
 *   都是**可选**的（契约允许缺）。缺了就不会出现对应状态，而不是编一个：
 *     · goal：目标文档是「本机唯一一个活跃目标」，不按会话切分，投影到卡片上
 *       会把同一个目标挂到每一张卡上；
 *     · question：挂起提问是能力服务的运行期状态，重启后不可考；
 *     · study：只有进了学习会话才有，且它自己就有独立界面；
 *     · subagents：子代理事实在 pi 侧，需要另开一条读取链。
 *   `needs_review` 同理：没有精确事实源，宁缺勿编（T1 已把这一点写在契约注释里）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { listSessions } from './sessions'
import { currentTaskPlan } from './task-plan-store'
import type { RunnerRegistry } from './runners'
import type { InboxSession, RunnerFacts, TaskInboxSources } from './task-inbox-service'

/** 收件箱自己的可见性文件（不是会话事实，是「我看过了」） */
const INBOX_STATE_FILE = 'task-inbox.json'
/** 忽略名单上限：这只是本地可见性开关，写爆了没有意义 */
const DISMISS_MAX = 500

export interface InboxState {
  /** 用户主动从收件箱移除的会话 */
  dismissed: string[]
  /**
   * 「我上次真的看过这个会话」的时间（毫秒，按会话 id）。
   *
   * 为什么需要它：`needs_review`（跑完了但没被确认）唯一的判据就是
   * 「最后活动时间 > 我上次看它的时间」。宿主没有别的事实能回答这个问题 ——
   * 所以这个状态会一直标着 `approximate`。
   */
  readUntil: Record<string, number>
}

const EMPTY_STATE: InboxState = { dismissed: [], readUntil: {} }

/** 读可见性文件；文件不在 / 坏了都当作「什么都没忽略」（不阻断收件箱） */
export async function readInboxState(root: string = YAN_DIR): Promise<InboxState> {
  try {
    const raw = await readFile(join(root, INBOX_STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_STATE, dismissed: [], readUntil: {} }
    const list = (parsed as { dismissed?: unknown }).dismissed
    const rawRead = (parsed as { readUntil?: unknown }).readUntil
    const readUntil: Record<string, number> = {}
    if (rawRead && typeof rawRead === 'object') {
      for (const [k, v] of Object.entries(rawRead as Record<string, unknown>)) {
        const n = Number(v)
        if (Number.isFinite(n) && n > 0) readUntil[k] = Math.floor(n)
      }
    }
    return {
      dismissed: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [],
      readUntil
    }
  } catch {
    return { dismissed: [], readUntil: {} }
  }
}

export async function writeInboxState(state: InboxState, root: string = YAN_DIR): Promise<void> {
  const path = join(root, INBOX_STATE_FILE)
  await mkdir(dirname(path), { recursive: true })
  /* 已读时间只保留最近 200 条：它是“顺手记一笔”的可见性，不是要留档的数据 */
  const recent = Object.entries(state.readUntil ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
  await writeFile(
    path,
    JSON.stringify(
      { dismissed: (state.dismissed ?? []).slice(0, DISMISS_MAX), readUntil: Object.fromEntries(recent) },
      null,
      2
    ),
    'utf8'
  )
}

/**
 * 把多个运行实例折叠成「每个会话一条」。
 *
 * 同一会话可能有多个 runner（分叉、重启后的旧实例、隔离工作树），
 * 收件箱只关心这个会话**现在要不要我看**，所以要挑最需要关注的那一条：
 * 失败 > 等用户 > 在跑。挑错会把「已经挂了」显示成「正在跑」。
 */
export function foldRunners(statuses: RunnerFacts[]): RunnerFacts[] {
  const score = (r: RunnerFacts) => (r.failed ? 4 : 0) + (r.waiting ? 2 : 0) + (r.running ? 1 : 0)
  const bySession = new Map<string, RunnerFacts>()
  for (const s of statuses) {
    const prev = bySession.get(s.sessionId)
    if (!prev) {
      bySession.set(s.sessionId, s)
      continue
    }
    const winner = score(s) > score(prev) ? s : prev
    bySession.set(s.sessionId, {
      sessionId: s.sessionId,
      /* 三个布尔取「或」：任一实例在跑就是会话在跑，任一实例挂了就要标出来 */
      ...(s.running || prev.running ? { running: true } : {}),
      ...(s.waiting || prev.waiting ? { waiting: true } : {}),
      ...(s.failed || prev.failed ? { failed: true } : {}),
      ...(winner.reason ? { reason: winner.reason } : {})
    })
  }
  return [...bySession.values()]
}

/** RunnerStatus → RunnerFacts（少一个字段也不编：只映射真的有的） */
export function toRunnerFacts(s: {
  sessionId?: string
  running?: boolean
  waiting?: boolean
  failed?: boolean
  conn?: string
}): RunnerFacts[] {
  if (!s.sessionId) return []
  return [
    {
      sessionId: s.sessionId,
      ...(s.running ? { running: true } : {}),
      ...(s.waiting ? { waiting: true } : {}),
      ...(s.failed ? { failed: true } : {}),
      ...(s.failed ? { reason: s.conn === 'exited' ? '进程已退出' : '连接失败' } : {})
    }
  ]
}

export interface TaskInboxSourceOptions {
  registry: Pick<RunnerRegistry, 'statuses'>
  /** 会话列表（默认走真实会话目录；单测可换） */
  list?: () => Promise<InboxSession[]>
  /**
   * 可见性（同步）。由调用方持有那份缓存：契约里 `dismissed()` 不是 Promise，
   * 而文件是异步读的 —— 把可变状态放进这个模块会让两个实例互相踩。
   */
  dismissed?: () => string[]
  /** 任务计划（默认走宿主任务日志） */
  readPlan?: TaskInboxSources['readPlan']
  /**
   * 问答记录（`yan question ask` 落盘的那份）。
   * 取**最后一条**，且只有「没作答也没取消」才算在等 —— 作答过就不该再提醒。
   */
  questionLog?: { list(sessionId: string): { question: string; answer: string | null; cancelled?: boolean }[] }
  /** 学习等待（`LearningService.waitingGate`）：只有真在等学习者才回非空 */
  waitingGate?: (runtimeKey: string) => Promise<{ waiting: boolean; where?: string } | null>
  /**
   * 「跑完了但没被确认」的近似源（T4）。
   *
   * 判据：本地已读过这个会话之后它又有了新活动，且计划里没有未完成的步骤。
   * 返回 `since`（最后活动时间），卡片会被标上 `approximate`。
   */
  awaitingReview?: (
    sessionId: string,
    session: InboxSession
  ) => Promise<{ since: number; reason?: string } | undefined>
}

export function createTaskInboxSources(opts: TaskInboxSourceOptions): TaskInboxSources {
  /*
   * 会话投影的最近一份快照。
   *
   * 为什么需要：`readAwaitingReview(sessionId)` 只能拿到 id，而「最后活动时间」
   * 在会话投影里。再扫一遗会话目录（478ms）只为拿一个时间戳不值得。
   */
  let sessionSnapshot = new Map<string, InboxSession>()

  const rawList =
    opts.list ??
    (async () => {
      const list = await listSessions(200)
      return list.map((s) => ({
        id: s.id,
        title: s.title || s.path,
        ...(s.projectId ? { spaceId: s.projectId } : {}),
        /* 没有消息时间就退到创建时间：宁可排得靠下，也不排到未来 */
        updatedAt: s.lastActivityAt ?? s.createdAt ?? 0
      }))
    })

  const listFn = async (): Promise<InboxSession[]> => {
    const list = await rawList()
    sessionSnapshot = new Map(list.map((s) => [s.id, s]))
    return list
  }

  const planFn =
    opts.readPlan ??
    (async (sessionId: string) => {
      const { state } = await currentTaskPlan(sessionId)
      if (!state.todos.length) return undefined
      const done = state.todos.filter((t) => t.done || t.status === 'done').length
      const blocked = state.todos.filter((t) => t.status === 'blocked').length
      const current = state.todos.find((t) => t.status === 'running') ?? state.todos.find((t) => !t.done)
      return {
        total: state.todos.length,
        done,
        ...(blocked ? { blocked } : {}),
        ...(current ? { current: current.text } : {})
      }
    })

  /*
   * 挂起提问（T3）：读问答记录的最后一条。
   *
   * 「最后一条没作答也没取消」才是真在等 —— 只看有没有 question 字段会把
   * 已经答过、已经取消的历史全报成待处理。
   */
  const questionFn = opts.questionLog
    ? async (sessionId: string) => {
        const entries = opts.questionLog!.list(sessionId)
        const last = entries[entries.length - 1]
        if (!last || last.cancelled || last.answer !== null) return undefined
        return { pending: true, text: last.question }
      }
    : undefined

  /*
   * 等学习者（T3）：runtimeKey 就是会话 id（宿主 `studyKey()` 缺省取当前会话），
   * 所以这里按 sessionId 直查。
   */
  const studyFn = opts.waitingGate
    ? async (sessionId: string) => {
        const gate = await opts.waitingGate!(sessionId)
        if (!gate?.waiting) return undefined
        return { waiting: true, ...(gate.where ? { reason: gate.where } : {}) }
      }
    : undefined

  /* 「跑完了但没被确认」（T4）。会话快照里没有它就不报（不编）。 */
  const reviewFn = opts.awaitingReview
    ? async (sessionId: string) => {
        const session = sessionSnapshot.get(sessionId)
        if (!session) return undefined
        return await opts.awaitingReview!(sessionId, session)
      }
    : undefined

  return {
    listSessions: listFn,
    runners: () => foldRunners(opts.registry.statuses().flatMap(toRunnerFacts)),
    dismissed: opts.dismissed ?? (() => []),
    readPlan: planFn,
    ...(questionFn ? { readQuestion: questionFn } : {}),
    ...(studyFn ? { readStudy: studyFn } : {}),
    ...(reviewFn ? { readAwaitingReview: reviewFn } : {})
  }
}
