/**
 * 错题与复习（实施-25 P12）—— 契约与调度规则。
 *
 * ── 这一片要守住的两条 ──
 * 1. **复习只到「提醒与挑题」**：宿主不会因为一条复习到期就自动去学、
 *    自动发消息、自动推进 `StudySession`。挑出题来，用户自己决定做不做。
 * 2. **再练要换同概念的新例子**：一道题做错过，下次复习**不复用原题**
 *    （原题有「这道题我记住答案了」的效应）。宁可如实说「没有新例子」，
 *    也不把原题端回来充数。
 *
 * ── 间隔是调度规则，不是效果保证 ──
 * `REVIEW_INTERVAL_DAYS` 只是「什么时候再看一眼」的排期，**不代表学会了**。
 * 文案与数据都不能把它说成掌握程度的证明：掌握程度看 `ConceptProgress`
 * 的观察层级（P11），两条轴互不替代。
 *
 * ── 为什么「错过一天」不用补 ──
 * 每条复习项只有一份，逾期只是「现在可以做」，不按逾期天数复制成多条。
 * 用户断三天回来，看到的是三条到期，不是九条欠账。
 */

import type { Attempt, Exercise } from './exercise'

/** 默认复习间隔（天）。是**调度规则**，不是「学没学会」的证明。 */
export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14] as const

/** 「今天十分钟」的默认预算（分钟）。 */
export const REVIEW_QUICK_MINUTES = 10
/** 一条复习项的粗略用时（分钟）——用于预计时间，不做精确承诺。 */
export const REVIEW_MINUTES_PER_ITEM = 3

/** 同一概念被反复问到第几次才建复习项（第一次不算「反复」）。 */
export const REVIEW_QUESTION_REPEAT = 2

export const MAX_REVIEWS = 1000
export const MAX_REVIEW_PROMPT = 200

export const REVIEW_REASONS = [
  'wrong-answer',
  'hinted',
  'misread',
  'repeated-question',
  'not-transferable',
  'confused'
] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  'wrong-answer': '做错过',
  hinted: '用了提示才完成',
  misread: '这段原文没看懂',
  'repeated-question': '反复问过',
  'not-transferable': '换个场景就不会用',
  confused: '和前置概念搅在一起'
}

export function reviewReasonLabel(reason: ReviewReason): string {
  return REVIEW_REASON_LABELS[reason] ?? reason
}

export type ReviewPriority = 'high' | 'normal' | 'low'

export const REVIEW_PRIORITY_LABELS: Record<ReviewPriority, string> = {
  high: '优先',
  normal: '一般',
  low: '可以不急'
}

const PRIORITY_RANK: Record<ReviewPriority, number> = { high: 0, normal: 1, low: 2 }

export interface ReviewItem {
  id: string
  courseId: string
  /** 关联概念（错题 / 反复问 / 不会迁移都有）。 */
  conceptId?: string
  unitId?: string
  reason: ReviewReason
  /** 哪一次作答带出来的（错题与提示）。 */
  attemptId?: string
  /** 关联的题（**只用于记录「已经做过哪道题」**，复习时不再出这道）。 */
  exerciseId?: string
  /** 一句话说清要复习什么（给用户看，不给模型当指令）。 */
  prompt: string
  /** 「这段原文没看懂」的出处。 */
  source?: { sourceId: string; version: number; locator?: { start: number; end: number } }
  /** 下次建议时间。 */
  dueAt: number
  /** 推进到第几档（0 起，对应 `REVIEW_INTERVAL_DAYS`）。 */
  stage: number
  priority: ReviewPriority
  /** 连续独立成功次数；够 `REVIEW_CLEAR_STREAK` 就从列表里收掉。 */
  streak: number
  /** 同一概念被提到的累计次数（「反复问」靠它）。 */
  seenCount: number
  /** 出现混淆时指回的前置概念（「补前置」）。 */
  prerequisiteConceptId?: string
  createdAt: number
  updatedAt: number
}

const DAY_MS = 86400000

export function intervalDaysForStage(stage: number): number {
  const index = Math.max(0, Math.min(Math.trunc(stage), REVIEW_INTERVAL_DAYS.length - 1))
  return REVIEW_INTERVAL_DAYS[index]
}

export interface ScheduleInput {
  reason: ReviewReason
  /** 本次观察：真 = 判对，假 = 判错，null = 没判定（开放题）。 */
  correct: boolean | null
  /** 是否独立完成（与 P11 同一口径：判对 + 没要提示 + 没看解释）。 */
  independent: boolean
  /** 是不是新情境（应用题）——「仍能应用 → 再延后」。 */
  transfer?: boolean
  /** 出现混淆 → 补前置。 */
  prerequisiteConceptId?: string
  /** 已有档位（第一次建时省略）。 */
  stage?: number
  now: number
}

export interface ScheduleResult {
  dueAt: number
  stage: number
  priority: ReviewPriority
}

/**
 * 调度规则（透明、纯函数、可单测）。
 *
 * 一句话版本：
 *   · 出错 / 和前置搅在一起 → 近期（1 天）+ 优先；
 *   · 用了提示才完成 → 近期（1 天），但不加优先；
 *   · 独立完成 → 延后一档；
 *   · 在新情境里也独立完成 → 再延后一档；
 *   · 没判定（开放题）→ 按 1 天排，**不因为「没判错」就当学会了**。
 */
export function scheduleReview(input: ScheduleInput): ScheduleResult {
  const stage = Math.max(0, Math.trunc(input.stage ?? 0))
  const at = (nextStage: number, priority: ReviewPriority): ScheduleResult => ({
    dueAt: input.now + intervalDaysForStage(nextStage) * DAY_MS,
    stage: nextStage,
    priority
  })

  if (input.prerequisiteConceptId) return at(0, 'high')
  if (input.correct === false) return at(0, 'high')
  if (input.correct === null) return at(0, 'normal')
  if (!input.independent) return at(0, 'normal')
  const advanced = input.transfer ? stage + 2 : stage + 1
  const next = Math.min(advanced, REVIEW_INTERVAL_DAYS.length - 1)
  return at(next, next >= 2 ? 'low' : 'normal')
}

/** 独立成功够次数就从复习列表里收掉（与 P11 的 `REVIEW_CLEAR_STREAK` 同口径）。 */
export const REVIEW_CLEAR_STREAK = 2

/** 排序：优先 → 到期早 → 建得早（同一天里先出最该出的）。 */
export function compareReview(a: ReviewItem, b: ReviewItem): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt
  return a.createdAt - b.createdAt
}

export function dueReviews(items: readonly ReviewItem[], now: number): ReviewItem[] {
  return items.filter((item) => item.dueAt <= now).sort(compareReview)
}

/**
 * 逾期不乘倍：一条逾期项无论迟了几天都只算一次。
 *
 * 这个函数存在的意义是**把这条规则写下来、可测**，而不是做一次改写 ——
 * 我们的模型里一条复习项只有一份，所以「重新安排」就是把到期时间如实留在
 * 过去（`dueAt <= now` 即到期），不复制、不叠加。
 */
export function replanMissed(items: readonly ReviewItem[], now: number): ReviewItem[] {
  return items.map((item) => (item.dueAt < now ? { ...item, dueAt: Math.min(item.dueAt, now) } : item))
}

/* ------------------------------------------------------------------ *
 * 挑题：换同概念的新例子
 * ------------------------------------------------------------------ */

export interface ReviewPlanEntry {
  item: ReviewItem
  /** 挑出来的题；没有新例子时为空。 */
  exerciseId?: string
  /** 这一条大概要几分钟。 */
  minutes: number
}

export interface ReviewPlan {
  entries: ReviewPlanEntry[]
  /** 这一份计划大概几分钟。 */
  minutes: number
  /** 有复习项、但同概念没有「没做过」的题 —— 需要新例子（**不复用原题**）。 */
  needsNewExercise: ReviewItem[]
  /** 到期的总数（不管有没有题）。 */
  dueCount: number
}

/**
 * 挑出今天要复习的东西。
 *
 * `mode: 'due'` 只看到期的；`'quick'` 在到期之外**也**把薄弱（high）项算进来，
 * 并卡在时间预算内（「今天十分钟」）。
 *
 * 不挑题的两种情形都如实回报：概念缺新题 → `needsNewExercise`；
 * 「没看懂的原文」本来就没有题 → 直接给一个重看原文的条目。
 */
export function planReview(input: {
  items: readonly ReviewItem[]
  exercises: readonly Exercise[]
  attempts: readonly Attempt[]
  now: number
  mode?: 'due' | 'quick'
  minutesBudget?: number
}): ReviewPlan {
  const mode = input.mode ?? 'due'
  const budget = mode === 'quick' ? (input.minutesBudget ?? REVIEW_QUICK_MINUTES) : Number.POSITIVE_INFINITY
  const doneExerciseIds = new Set(input.attempts.map((a) => a.exerciseId))

  const pool = mode === 'quick' ? input.items.filter((i) => i.dueAt <= input.now || i.priority === 'high') : dueReviews(input.items, input.now)
  const sorted = [...pool].sort(compareReview)

  const entries: ReviewPlanEntry[] = []
  const needsNewExercise: ReviewItem[] = []
  let minutes = 0

  for (const item of sorted) {
    const cost = REVIEW_MINUTES_PER_ITEM
    if (mode === 'quick' && minutes + cost > budget) break
    const conceptId = item.conceptId
    if (!conceptId) {
      /* 「没看懂原文」这类没有概念的：给一个重看条目，不假装有题。 */
      entries.push({ item, minutes: cost })
      minutes += cost
      continue
    }
    const fresh = input.exercises.find((e) => e.conceptIds.includes(conceptId) && !doneExerciseIds.has(e.id))
    if (!fresh) {
      needsNewExercise.push(item)
      continue
    }
    entries.push({ item, exerciseId: fresh.id, minutes: cost })
    minutes += cost
  }

  return {
    entries,
    minutes,
    needsNewExercise,
    dueCount: dueReviews(input.items, input.now).length
  }
}

/* ------------------------------------------------------------------ *
 * 容错读盘
 * ------------------------------------------------------------------ */

function clampText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (text.length > max) return null
  if (/[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

export function sanitizeReview(raw: unknown): ReviewItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = clampText(o.id, 120)
  const courseId = clampText(o.courseId, 120)
  const prompt = clampText(o.prompt, MAX_REVIEW_PROMPT)
  if (!id || !courseId || !prompt) return null
  if (!(REVIEW_REASONS as readonly string[]).includes(String(o.reason))) return null
  const stage = Math.max(0, Math.min(Math.trunc(numberOr(o.stage, 0)), REVIEW_INTERVAL_DAYS.length - 1))
  const priority = (['high', 'normal', 'low'] as const).includes(o.priority as ReviewPriority)
    ? (o.priority as ReviewPriority)
    : 'normal'
  const createdAt = numberOr(o.createdAt, 0)
  const source = ((): ReviewItem['source'] => {
    if (!o.source || typeof o.source !== 'object') return undefined
    const s = o.source as Record<string, unknown>
    const sourceId = clampText(s.sourceId, 120)
    const version = Math.trunc(numberOr(s.version, 1))
    if (!sourceId || version < 1) return undefined
    const locator = (() => {
      if (!s.locator || typeof s.locator !== 'object') return undefined
      const l = s.locator as Record<string, unknown>
      const start = Math.max(0, Math.trunc(numberOr(l.start, -1)))
      const end = Math.max(0, Math.trunc(numberOr(l.end, -1)))
      if (start < 0 || end < start) return undefined
      return { start, end }
    })()
    return { sourceId, version, ...(locator ? { locator } : {}) }
  })()
  return {
    id,
    courseId,
    ...(clampText(o.conceptId, 120) ? { conceptId: String(o.conceptId) } : {}),
    ...(clampText(o.unitId, 120) ? { unitId: String(o.unitId) } : {}),
    reason: o.reason as ReviewReason,
    ...(clampText(o.attemptId, 120) ? { attemptId: String(o.attemptId) } : {}),
    ...(clampText(o.exerciseId, 120) ? { exerciseId: String(o.exerciseId) } : {}),
    prompt,
    ...(source ? { source } : {}),
    dueAt: numberOr(o.dueAt, createdAt),
    stage,
    priority,
    streak: Math.max(0, Math.trunc(numberOr(o.streak, 0))),
    seenCount: Math.max(1, Math.trunc(numberOr(o.seenCount, 1))),
    ...(clampText(o.prerequisiteConceptId, 120) ? { prerequisiteConceptId: String(o.prerequisiteConceptId) } : {}),
    createdAt,
    updatedAt: numberOr(o.updatedAt, createdAt)
  }
}

/* ------------------------------------------------------------------ *
 * 查询与合并
 * ------------------------------------------------------------------ */

/** 同一 `key` 只留一条；新的一条覆盖旧的一条（复习项按概念去重）。 */
export function reviewKey(item: Pick<ReviewItem, 'courseId' | 'conceptId' | 'reason' | 'source'>): string {
  if (item.conceptId) return `${item.courseId}:concept:${item.conceptId}`
  if (item.source) return `${item.courseId}:source:${item.source.sourceId}:${item.source.version}:${item.source.locator?.start ?? ''}`
  return `${item.courseId}:${item.reason}`
}

export function upsertReviewIn(items: readonly ReviewItem[], item: ReviewItem): ReviewItem[] {
  const key = reviewKey(item)
  const index = items.findIndex((existing) => existing.id === item.id || reviewKey(existing) === key)
  if (index < 0) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

export function reviewsForCourse(items: readonly ReviewItem[], courseId: string): ReviewItem[] {
  return items.filter((item) => item.courseId === courseId).sort(compareReview)
}

export function findReview(items: readonly ReviewItem[], id: string): ReviewItem | null {
  return items.find((item) => item.id === id) ?? null
}

export function findReviewForConcept(
  items: readonly ReviewItem[],
  courseId: string,
  conceptId: string
): ReviewItem | null {
  return items.find((item) => item.courseId === courseId && item.conceptId === conceptId) ?? null
}

export function makeReviewId(random: () => number = Math.random): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = 'rv_'
  for (let i = 0; i < 10; i += 1) out += chars[Math.floor(random() * chars.length)] ?? 'a'
  return out
}

/** 给用户看的一句话（界面上不解释内部规则，只说「什么时候再看一眼」）。 */
export function reviewWhenText(item: ReviewItem, now: number): string {
  const days = Math.ceil((item.dueAt - now) / DAY_MS)
  if (days <= 0) return '现在可以复习'
  if (days === 1) return '明天再看一眼'
  return `${days} 天后再看一眼`
}

/** 复习计划的说明文案（透明：把规则说出来，不暗示「学会了」）。 */
export function reviewRuleText(): string {
  return `间隔按 ${REVIEW_INTERVAL_DAYS.join(' / ')} 天推进：独立完成往后延，用了提示或做错了回到最近一档。这是复习排期，不代表已经掌握了。`
}
