import type { TaskCard, TaskFacts, InboxFilter, TaskInboxPage } from '../shared/task-inbox'

export type { TaskInboxPage }
import { filterTaskCards, inboxCounts, compareTaskCards, projectTaskCard } from '../shared/task-inbox'

export interface InboxSession {
  id: string
  title: string
  spaceId?: string
  updatedAt: number
}

export interface RunnerFacts {
  sessionId: string
  running?: boolean
  waiting?: boolean
  failed?: boolean
  reason?: string
}

export interface TaskInboxSources {
  listSessions(): Promise<InboxSession[]>
  runners(): RunnerFacts[]
  dismissed?(): string[]
  readPlan?(sessionId: string): Promise<NonNullable<TaskFacts['plan']> | undefined>
  readGoal?(sessionId: string): Promise<NonNullable<TaskFacts['goal']> | undefined>
  readQuestion?(sessionId: string): Promise<NonNullable<TaskFacts['question']> | undefined>
  readSubagents?(sessionId: string): Promise<NonNullable<TaskFacts['subagents']> | undefined>
  readAwaitingReview?(sessionId: string): Promise<NonNullable<TaskFacts['awaitingReview']> | undefined>
}

export interface TaskInboxOptions {
  ttlMs?: number
  now?: () => number
}

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

  async function projectAll(): Promise<{ cards: TaskCard[]; degraded: number }> {
    if (cache && now() - cache.at < ttlMs) return { cards: cache.cards, degraded: cache.degraded }

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
    invalidate(): void {
      cache = null
    }
  }
}

export type TaskInboxService = ReturnType<typeof createTaskInboxService>
