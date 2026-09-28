/**
 * 任务收件箱的只读聚合服务（实施-28 T1）。
 *
 * 三条硬边界：
 *   ① **不落第二事实源**：这里不写任何文件；每张卡的字段都由注入的读取函数
 *      从既有事实源现取（运行实例 / 任务计划 / 目标 / 提问 / 学习 / 子代理）；
 *   ② **缺源要降级，不要报错**：某个来源读不到（文件在读、格式变了、权限不够）
 *      只让那一项为空，其余照常 —— 收件箱不该因为一个来源坏了就整个不可用；
 *   ③ **懒加载 + 分页**：真实数据 433 MB / 133 文件，一次 `listSessions()` 约 0.5s
 *      （T0 实测），所以结果带 TTL 缓存，并把分页放在这里（界面不用自己切）。
 */
import type { TaskCard, TaskFacts, InboxFilter, TaskInboxPage } from '../shared/task-inbox'

/* `TaskInboxPage` 的真源在 shared（要跨进程传），这里只是给调用方转出去 */
export type { TaskInboxPage }
import { filterTaskCards, inboxCounts, compareTaskCards, projectTaskCard } from '../shared/task-inbox'

/** 一条会话的摘要（只取聚合需要的字段，避免依赖 SessionSummary 的全部形状） */
export interface InboxSession {
  id: string
  title: string
  spaceId?: string
  updatedAt: number
}

/** 一个运行实例的事实（runners 注册表的投影） */
export interface RunnerFacts {
  sessionId: string
  running?: boolean
  waiting?: boolean
  failed?: boolean
  reason?: string
}

/**
 * 事实源的读取口。**全部是函数**，这样：
 *   · main 侧可以把真实 store 接进来；
 *   · 单测可以直接喂假数据（不需要 Electron、不需要真实会话目录）。
 */
export interface TaskInboxSources {
  listSessions(): Promise<InboxSession[]>
  /** 运行实例注册表（同步快照足够） */
  runners(): RunnerFacts[]
  /** 收件箱里被用户忽略 / 已处理的会话 id（本地可见性） */
  dismissed?(): string[]
  readPlan?(sessionId: string): Promise<NonNullable<TaskFacts['plan']> | undefined>
  readGoal?(sessionId: string): Promise<NonNullable<TaskFacts['goal']> | undefined>
  readQuestion?(sessionId: string): Promise<NonNullable<TaskFacts['question']> | undefined>
  readSubagents?(sessionId: string): Promise<NonNullable<TaskFacts['subagents']> | undefined>
  /**
   * 「跑完了但没被确认」的近似判定（七态里唯一的缺口）。
   * 宿主给不出来就别传 —— 那时收件箱不会出现 `needs_review`（如实缺一个状态，
   * 而不是编一个）。
   */
  readAwaitingReview?(sessionId: string): Promise<NonNullable<TaskFacts['awaitingReview']> | undefined>
}

export interface TaskInboxOptions {
  /** 结果缓存多久（毫秒）。默认 3s：够挡住连续渲染，又不会让「刚跑完」看不到 */
  ttlMs?: number
  now?: () => number
}

/** 读取口安全调用：抛错当成「这项没有」，并计数 */
async function safe<T>(fn: ((id: string) => Promise<T | undefined>) | undefined, id: string): Promise<{ value?: T; failed: boolean }> {
  if (!fn) return { failed: false }
  try {
    return { value: await fn(id), failed: false }
  } catch {
    return { failed: true }
  }
}

export function createTaskInboxService(sources: TaskInboxSources, options: TaskInboxOptions = {}) {
  const ttlMs = options.ttlMs ?? 3000
  const now = options.now ?? (() => Date.now())
  let cache: { at: number; cards: TaskCard[]; degraded: number } | null = null

  /** 投影全部会话（缓存内不重复扫） */
  async function projectAll(): Promise<{ cards: TaskCard[]; degraded: number }> {
    if (cache && now() - cache.at < ttlMs) return { cards: cache.cards, degraded: cache.degraded }

    /*
     * 顶层三个源也要降级：文件头写的硬边界是「某个来源读不到只让那一项为空」。
     * `listSessions` 要读 433MB 的会话目录，正是最容易抛的那一个 ——
     * 它抛了不应让整页 reject。
     */
    let sessions: InboxSession[] = []
    let runners: RunnerFacts[] = []
    let dismissed: string[] = []
    let topFailed = 0
    try {
      sessions = await sources.listSessions()
    } catch {
      topFailed++
    }
    try {
      runners = sources.runners()
    } catch {
      topFailed++
    }
    try {
      dismissed = sources.dismissed?.() ?? []
    } catch {
      topFailed++
    }
    const runnerBySession = new Map(runners.map((r) => [r.sessionId, r]))
    const dismissedSet = new Set(dismissed)

    let degraded = topFailed
    const cards: TaskCard[] = []
    for (const s of sessions) {
      const [plan, goal, question, subagents, awaitingReview] = await Promise.all([
        safe(sources.readPlan, s.id),
        safe(sources.readGoal, s.id),
        safe(sources.readQuestion, s.id),
        safe(sources.readSubagents, s.id),
        safe(sources.readAwaitingReview, s.id)
      ])
      if ([plan, goal, question, subagents, awaitingReview].some((r) => r.failed)) degraded++

      const run = runnerBySession.get(s.id)
      const facts: TaskFacts = {
        sessionId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        ...(s.spaceId ? { spaceId: s.spaceId } : {}),
        ...(run ? { run: { running: run.running, waiting: run.waiting, failed: run.failed, reason: run.reason } } : {}),
        ...(plan.value ? { plan: plan.value } : {}),
        ...(goal.value ? { goal: goal.value } : {}),
        ...(question.value ? { question: question.value } : {}),
        ...(subagents.value ? { subagents: subagents.value } : {}),
        ...(awaitingReview.value ? { awaitingReview: awaitingReview.value } : {}),
        ...(dismissedSet.has(s.id) ? { dismissed: true } : {})
      }
      const card = projectTaskCard(facts)
      if (card) cards.push(card)
    }

    cache = { at: now(), cards, degraded }
    return { cards, degraded }
  }

  return {
    /** 列一页（默认全部状态、按优先级排序） */
    async page(filter: InboxFilter = {}, paging: { limit?: number; offset?: number } = {}): Promise<TaskInboxPage> {
      const { cards, degraded } = await projectAll()
      const filtered = filterTaskCards(cards, filter).sort(compareTaskCards)
      const offset = Math.max(0, paging.offset ?? 0)
      const limit = paging.limit && paging.limit > 0 ? paging.limit : 50
      return {
        cards: filtered.slice(offset, offset + limit),
        total: filtered.length,
        counts: inboxCounts(cards),
        degraded
      }
    },
    /** 手动失效（用户点了「刷新」/ 刚跑完一个回合） */
    invalidate(): void {
      cache = null
    }
  }
}

export type TaskInboxService = ReturnType<typeof createTaskInboxService>
