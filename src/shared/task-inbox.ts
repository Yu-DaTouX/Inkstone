/**
 * 任务收件箱契约（实施-28 T1）。
 *
 * 这是**投影**，不是第二事实源：`TaskCard` 的每个字段都必须能指回某个既有事实
 * （运行实例 / 任务计划 / 目标 / 提问挂起 / 学习等待 / 子代理 / 用户忽略）。
 * 所以这里的核心是 `projectTaskCard(facts)` —— 纯函数，输入是各事实源的投影，
 * 输出是一张卡或 `null`（这条会话没有什么可说的时候，就不占位置）。
 *
 * 七态里有一个**没有事实源**：
 *   · `needs_review`（「跑完了但用户还没确认」）——
 *     当前数据层没有「用户是否已确认」这个字段，所以只能由调用方传
 *     `awaitingReview` **近似**（例如「运行已结束且之后没有新的用户消息」）。
 *     近似必须在卡片的 `approximate` 上写明，界面照样显示，但不假装它是精确状态。
 *   其余六态都有明确来源，见 `TASK_STATUS_SOURCE`。
 */
import type { GoalPhase } from './goal'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'failed'
  | 'needs_review'
  | 'done'
  | 'dismissed'

/** 每个状态的事实来源（文档用，也是单测的口径表） */
export const TASK_STATUS_SOURCE: Record<TaskStatus, string> = {
  pending: '任务计划里有还没开始的步骤',
  running: '运行实例注册表里这条会话正在跑',
  waiting_user: '提问挂起 / 学习等待 / 目标 blocked',
  failed: '运行实例报失败',
  needs_review: '**没有精确来源**：调用方传入的近似（跑完了但用户没确认）',
  done: '任务计划全部完成，或目标 completed',
  dismissed: '用户在收件箱里忽略 / 已处理（本地可见性）'
}

/** 投影输入：一条会话能提供的全部事实（全部可选，缺了就降级，不报错） */
export interface TaskFacts {
  sessionId: string
  title: string
  spaceId?: string
  /** 最近活动时间（排序用） */
  updatedAt: number
  run?: {
    running?: boolean
    /** 用户接管 / 等待用户输入 */
    waiting?: boolean
    failed?: boolean
    reason?: string
  }
  plan?: {
    total: number
    done: number
    /** 被阻塞的步骤数（>0 时算 waiting_user） */
    blocked?: number
    /** 当前正在做的那一步，用作 progress 的可读文本 */
    current?: string
  }
  goal?: {
    phase: GoalPhase
    title: string
    /** `blocked` 时必填（来自 goal 契约） */
    blockedReason?: string
  }
  /** 提问挂起（`yan question ask` 正在等用户回答） */
  question?: { pending: boolean; text?: string }
  /** 学习：这一节在等学习者（`waiting_for_learner`） */
  study?: { waiting: boolean; reason?: string }
  subagents?: { running?: number; waiting?: number; failed?: number }
  /**
   * 「跑完了但没被确认」的近似标记（见文件头：这是七态里唯一的缺口）。
   * 传了就出 `needs_review`，并在卡片上标 `approximate`。
   */
  awaitingReview?: { since: number; reason?: string }
  /** 用户在收件箱里忽略过（本地可见性，不删会话） */
  dismissed?: boolean
}

export interface TaskCard {
  id: string
  title: string
  status: TaskStatus
  /** 等待 / 失败 / 近似的可读原因 */
  reason?: string
  sessionId: string
  spaceId?: string
  updatedAt: number
  /**
   * 进度**不用百分比**：只在有依据时给「第几步 / 共几步」或一句状态词。
   * 没有依据就不给 —— 编一个进度比没有进度更糟。
   */
  progress?: string
  /** 检查项 / 证据的可读摘要（不做「完成度」合成） */
  evidence?: string
  /** 该状态是近似投影（目前只有 needs_review） */
  approximate?: boolean
}

/** 收件箱里的排序：要人处理的排前面；同档按最近活动 */
export const TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  needs_review: 0,
  waiting_user: 1,
  failed: 2,
  running: 3,
  pending: 4,
  done: 5,
  dismissed: 6
}

export function compareTaskCards(a: TaskCard, b: TaskCard): number {
  const byStatus = TASK_STATUS_ORDER[a.status] - TASK_STATUS_ORDER[b.status]
  if (byStatus !== 0) return byStatus
  return b.updatedAt - a.updatedAt
}

/**
 * 一条会话 → 一张卡（或 null）。
 *
 * 判定顺序即优先级，从「必须有人处理」到「只是有安排」：
 *   dismissed → failed → waiting_user → running → needs_review → done → pending
 *
 * 为什么 `dismissed` 放最前：用户已经说过「这条我不管了」，它不该因为
 * 又出现别的信号就冒回来。
 */
export function projectTaskCard(facts: TaskFacts): TaskCard | null {
  const base = {
    id: facts.sessionId,
    title: facts.title,
    sessionId: facts.sessionId,
    updatedAt: facts.updatedAt,
    ...(facts.spaceId ? { spaceId: facts.spaceId } : {})
  }
  const progress = planProgress(facts)
  const evidence = subagentEvidence(facts)
  /* 所有分支共用：进度与证据只在有依据时才出现 */
  const extras = { ...(progress ? { progress } : {}), ...(evidence ? { evidence } : {}) }

  if (facts.dismissed) {
    return { ...base, status: 'dismissed', ...extras }
  }

  if (facts.run?.failed) {
    return {
      ...base,
      status: 'failed',
      reason: facts.run.reason ?? '运行失败',
      ...extras
    }
  }

  const waiting = waitingReason(facts)
  if (waiting) {
    return {
      ...base,
      status: 'waiting_user',
      reason: waiting,
      ...extras
    }
  }

  if (facts.run?.running) {
    return { ...base, status: 'running', ...extras }
  }

  if (facts.awaitingReview) {
    return {
      ...base,
      status: 'needs_review',
      approximate: true,
      reason: facts.awaitingReview.reason ?? '这一步跑完了，还没有人看过结果',
      ...extras
    }
  }

  if (facts.goal?.phase === 'completed' || (facts.plan && facts.plan.total > 0 && facts.plan.done >= facts.plan.total)) {
    return {
      ...base,
      status: 'done',
      reason: facts.goal?.phase === 'completed' ? `目标已完成：${facts.goal.title}` : undefined,
      ...extras
    }
  }

  if (facts.plan && facts.plan.total > 0) {
    return { ...base, status: 'pending', ...extras }
  }

  /*
   * 目标还有推进阶段（planning / executing / verifying）也算「有安排」。
   * 放在 plan 后面：有计划时计划更具体，用计划的步骤数。
   * 这里不把 `verifying` 当成 done —— 它只是「在验证」，还没完成。
   */
  if (facts.goal && facts.goal.phase !== 'stopped') {
    return { ...base, status: 'pending', ...extras }
  }

  /* 什么都没发生：不占收件箱的位置 */
  return null
}

/** 三类「等用户」的合一判定 —— 原因要能读出来是谁在等、等什么 */
function waitingReason(facts: TaskFacts): string | undefined {
  if (facts.question?.pending) {
    return facts.question.text ? `等你的回答：${facts.question.text}` : '有一个提问在等你回答'
  }
  if (facts.study?.waiting) return facts.study.reason ?? '学习这一节在等你的作答'
  if (facts.goal?.phase === 'blocked') {
    return facts.goal.blockedReason ? `目标被阻塞：${facts.goal.blockedReason}` : '目标被阻塞，需要你决定方向'
  }
  if (facts.plan?.blocked && facts.plan.blocked > 0) return `计划里有 ${facts.plan.blocked} 步被阻塞`
  if (facts.run?.waiting) return facts.run.reason ?? '运行在等你接管'
  return undefined
}

function planProgress(facts: TaskFacts): string | undefined {
  const plan = facts.plan
  if (!plan || plan.total <= 0) {
    const goal = facts.goal
    if (goal && goal.phase !== 'completed' && goal.phase !== 'stopped') return `目标阶段：${goal.phase}`
    return undefined
  }
  const head = `第 ${Math.min(plan.done + 1, plan.total)} / ${plan.total} 步`
  return plan.current ? `${head}：${plan.current}` : head
}

function subagentEvidence(facts: TaskFacts): string | undefined {
  const s = facts.subagents
  if (!s) return undefined
  const parts: string[] = []
  if (s.running) parts.push(`${s.running} 个在跑`)
  if (s.waiting) parts.push(`${s.waiting} 个在等`)
  if (s.failed) parts.push(`${s.failed} 个失败`)
  return parts.length ? `子代理：${parts.join(' · ')}` : undefined
}

/**
 * 收件箱的传输形状（跨进程用，所以放在 shared）。
 *
 * 由 main 侧的纯投影服务产出；界面只读不写（忽略名单是另一条 IPC）。
 */
export interface TaskInboxPage {
  cards: TaskCard[]
  /** 过滤后的总数（分页前） */
  total: number
  counts: Record<TaskStatus, number>
  /** 本次投影时有多少条会话的某个来源读失败（只报数，不抛） */
  degraded: number
}

/** 界面的查询：过滤 + 分页 */
export interface TaskInboxQuery extends InboxFilter {
  limit?: number
  offset?: number
}

export interface InboxFilter {
  /** 只看这些状态；省略 = 全部（含 dismissed，由界面自己决定要不要请求） */
  statuses?: TaskStatus[]
  /** 只看某个空间 */
  spaceId?: string
  /** 标题/原因里的关键词（大小写不敏感） */
  query?: string
}

export function filterTaskCards(cards: TaskCard[], filter: InboxFilter = {}): TaskCard[] {
  /*
   * **总是复制**：调用方拿到的可能是服务缓存里的数组，
   * 不复制的话后面的 `.sort()` 会就地改缓存顺序（共享可变状态）。
   */
  let out = [...cards]
  if (filter.statuses && filter.statuses.length > 0) {
    const want = new Set(filter.statuses)
    out = out.filter((c) => want.has(c.status))
  }
  if (filter.spaceId) out = out.filter((c) => c.spaceId === filter.spaceId)
  if (filter.query && filter.query.trim()) {
    const q = filter.query.trim().toLowerCase()
    out = out.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.reason ?? '').toLowerCase().includes(q)
    )
  }
  return out
}

/** 收件箱顶部的一组计数（不做百分比，只给数） */
export function inboxCounts(cards: TaskCard[]): Record<TaskStatus, number> {
  const counts = {
    pending: 0,
    running: 0,
    waiting_user: 0,
    failed: 0,
    needs_review: 0,
    done: 0,
    dismissed: 0
  } as Record<TaskStatus, number>
  for (const c of cards) counts[c.status]++
  return counts
}

/** 需要人处理的那些（首页「当前阻塞」用得到） */
export function actionableCards(cards: TaskCard[]): TaskCard[] {
  return cards.filter((c) => c.status === 'needs_review' || c.status === 'waiting_user' || c.status === 'failed')
}
