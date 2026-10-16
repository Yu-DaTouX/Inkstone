import type { GoalPhase } from './goal'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'failed'
  | 'needs_review'
  | 'done'
  | 'dismissed'

export const TASK_STATUS_SOURCE: Record<TaskStatus, string> = {
  pending: '任务计划里有还没开始的步骤',
  running: '运行实例注册表里这条会话正在跑',
  waiting_user: '提问挂起 / 目标 blocked',
  failed: '运行实例报失败',
  needs_review: '**没有精确来源**：调用方传入的近似（跑完了但用户没确认）',
  done: '任务计划全部完成，或目标 completed',
  dismissed: '用户在收件箱里忽略 / 已处理（本地可见性）'
}

export interface TaskFacts {
  sessionId: string
  title: string
  spaceId?: string
  updatedAt: number
  run?: {
    running?: boolean
    waiting?: boolean
    failed?: boolean
    reason?: string
  }
  plan?: {
    total: number
    done: number
    blocked?: number
    current?: string
  }
  goal?: {
    phase: GoalPhase
    title: string
    blockedReason?: string
  }
  question?: { pending: boolean; text?: string }
  subagents?: { running?: number; waiting?: number; failed?: number }
  awaitingReview?: { since: number; reason?: string }
  dismissed?: boolean
}

export interface TaskCard {
  id: string
  title: string
  status: TaskStatus
  reason?: string
  sessionId: string
  spaceId?: string
  updatedAt: number
  progress?: string
  evidence?: string
  approximate?: boolean
}

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

  if (facts.goal && facts.goal.phase !== 'stopped') {
    return { ...base, status: 'pending', ...extras }
  }

  return null
}

function waitingReason(facts: TaskFacts): string | undefined {
  if (facts.question?.pending) {
    return facts.question.text ? `等你的回答：${facts.question.text}` : '有一个提问在等你回答'
  }
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
  const head = plan.done >= plan.total ? `已完成 ${plan.total} / ${plan.total} 步` : `第 ${Math.min(plan.done + 1, plan.total)} / ${plan.total} 步`
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

export interface TaskInboxPage {
  cards: TaskCard[]
  total: number
  counts: Record<TaskStatus, number>
  degraded: number
}

export interface TaskInboxQuery extends InboxFilter {
  limit?: number
  offset?: number
}

export function taskInboxPageQuery(limit: number, status: TaskStatus | 'all'): TaskInboxQuery {
  return {
    limit,
    offset: 0,
    ...(status === 'all' ? {} : { statuses: [status] })
  }
}

export interface InboxFilter {
  statuses?: TaskStatus[]
  spaceId?: string
  query?: string
}

export function filterTaskCards(cards: TaskCard[], filter: InboxFilter = {}): TaskCard[] {
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

export function actionableCards(cards: TaskCard[]): TaskCard[] {
  return cards.filter((c) => c.status === 'needs_review' || c.status === 'waiting_user' || c.status === 'failed')
}
