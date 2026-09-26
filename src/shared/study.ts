/**
 * 学习状态与继续（StudySession）—— 契约与纯逻辑（实施-25 P08）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么（R3 落点）
 * ══════════════════════════════════════════════════════════
 * 陪读最容易出的坏结果不是「讲得不好」，而是**自问自答把课学完**：
 * 模型抛出一个问题，没人回答，它自己接着答、接着讲下一节，进度条一路涨 ——
 * 用户回来看到的是一份「已经学完」的空壳。
 *
 * 所以这里有一条**硬闸门**：
 *   · `waiting_for_learner` 是一个**持久化阶段**（T08-2），不是某轮的临时标志；
 *   · 进入等待只能由宿主命令触发，并且必须带上要问的问题（T08-7）；
 *   · **从等待里出来必须有学习者的作答**（`answer`），模型自己调 `advance`
 *     一律被拒 —— 这是 T08-7「模型不得自判讲完了而推进」的落点；
 *   · 等待期间自动续跑要停下来（T08-3）：闸门在宿主 arm 与薄层真正发消息前各查一次。
 *
 * 另一条边界（T08-6）：**后台可以准备，不可以代替学习者**。
 * 允许整理教材、备下一节、生成适量练习、整理笔记；禁止替答、刷课、虚增进度。
 * 这段约束写进 {@link backgroundStudySummary} —— 它会被作为续行正文发给模型。
 *
 * 状态所有权在 `learning-service`（T08-4）：本文件只做判定与拼装，不做调度。
 */

import type { CourseSourceRef } from './course'

export const STUDY_PHASES = ['preparing', 'explaining', 'waiting_for_learner', 'feedback', 'applying', 'summary'] as const

export type StudyPhase = (typeof STUDY_PHASES)[number]

/** 等待学习者作答的阶段（各处判闸门都用这一个常量）。 */
export const WAITING_PHASE: StudyPhase = 'waiting_for_learner'

export const STUDY_PHASE_LABELS: Record<StudyPhase, string> = {
  preparing: '准备',
  explaining: '讲解',
  waiting_for_learner: '等你作答',
  feedback: '反馈',
  applying: '应用',
  summary: '小结'
}

/**
 * 允许的阶段推进。
 *
 * 有意收紧的两处：
 *   · `explaining` 不能直接到 `feedback` / `applying` —— 想往下走就必须先
 *     **提出问题并等作答**（否则「讲完就算练过」）；
 *   · `waiting_for_learner` 只能到 `feedback` —— 而 `feedback` 又要先有作答（见下）。
 */
const TRANSITIONS: Record<StudyPhase, readonly StudyPhase[]> = {
  preparing: ['explaining', 'summary'],
  explaining: ['waiting_for_learner', 'summary'],
  waiting_for_learner: ['feedback'],
  feedback: ['applying', 'explaining', 'summary'],
  applying: ['summary', 'explaining', 'waiting_for_learner'],
  summary: ['explaining']
}

export const STUDY_ORIGINS = ['material', 'model'] as const
export type StudyOrigin = (typeof STUDY_ORIGINS)[number]

/** 正在等学习者回答的问题。 */
export interface StudyPending {
  question: string
  /** 期望学习者做到什么（给模型的说明，不直接给学习者看）。 */
  expectation?: string
  /** 问题出处：来自教材段落，还是模型补充（与课程的 origin 同一条边界）。 */
  origin: StudyOrigin
  sources?: CourseSourceRef[]
  askedAt: number
}

/** 学习位置（T08-5）：第几节 + 节内字符区间（与资料库的定位对齐，不编页码）。 */
export interface StudyPosition {
  /** 0 基单元序号。 */
  unitIndex: number
  /** 节内字符区间（取课程单元的 locator）。 */
  locator?: { start: number; end: number }
}

export interface StudySession {
  id: string
  courseId: string
  unitId: string
  /**
   * 绑定的 pi 会话（runnerId）。
   *
   * 闸门按它查（自动续跑是**会话级**的），所以它必须跟着「谁在陪这门课」走：
   * 换会话接着学时更新它，`waiting_for_learner` 不会因为换了会话就失效。
   */
  runtimeKey: string
  phase: StudyPhase
  position: StudyPosition
  /** `phase === waiting_for_learner` 时必有。 */
  pending?: StudyPending
  /** 学习者最近一次作答（**只由 `answer` 写入**）。 */
  lastAnswer?: { text: string; at: number }
  /** 下一步要做什么（恢复时带这一句就够，不带整份课程）。 */
  nextStep?: string
  /** 用户暂停：自动续跑不该叫醒它。 */
  paused: boolean
  startedAt: number
  updatedAt: number
}

export interface StudyDocument {
  version: 1
  sessions: StudySession[]
}

export const MAX_STUDY_SESSIONS = 500
export const MAX_QUESTION_CHARS = 2000
export const MAX_EXPECTATION_CHARS = 500
export const MAX_ANSWER_CHARS = 4000
export const MAX_NEXT_STEP_CHARS = 300

export type StudyMutation = { ok: true; session: StudySession; unchanged?: boolean } | { ok: false; reason: string }

/* ------------------------------------------------------------------ *
 * 阶段推进
 * ------------------------------------------------------------------ */

export type PhaseTransition =
  | { ok: true }
  | { ok: false; reason: 'same-phase' | 'invalid-transition' | 'no-question' | 'awaiting-learner'; message: string }

export function phaseLabel(phase: StudyPhase): string {
  return STUDY_PHASE_LABELS[phase] ?? phase
}

export function isWaitingPhase(phase: StudyPhase): boolean {
  return phase === WAITING_PHASE
}

/**
 * 能不能从 `from` 走到 `to`。
 *
 * `hasQuestion` / `hasAnswer` 由调用方据**真实数据**给（不是模型说的）：
 *   · 进等待必须带问题；
 *   · 从等待出来必须已有学习者作答 —— 这一条就是防自问自答的闸。
 */
export function planPhaseTransition(input: {
  from: StudyPhase
  to: StudyPhase
  hasQuestion?: boolean
  hasAnswer?: boolean
}): PhaseTransition {
  const { from, to } = input
  if (from === to) return { ok: false, reason: 'same-phase', message: `已经在「${phaseLabel(from)}」阶段了。` }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: 'invalid-transition',
      message: `「${phaseLabel(from)}」不能直接到「${phaseLabel(to)}」。`
    }
  }
  if (isWaitingPhase(to) && input.hasQuestion !== true) {
    return {
      ok: false,
      reason: 'no-question',
      message: '要进入「等你作答」就必须先给出问题 —— 不能空着手停在等待上。'
    }
  }
  if (isWaitingPhase(from) && input.hasAnswer !== true) {
    return {
      ok: false,
      reason: 'awaiting-learner',
      message: '学习者还没作答，不能自己往下走：这不是进度，是自问自答。'
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 会话读写（纯函数）
 * ------------------------------------------------------------------ */

export function makeStudyId(random: () => number = Math.random): string {
  return `st_${Math.floor(random() * 36 ** 10).toString(36)}`
}

function clampText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, max)
}

function sanitizePending(raw: unknown): StudyPending | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Partial<StudyPending>
  const question = clampText(item.question, MAX_QUESTION_CHARS)
  if (!question) return undefined
  const expectation = clampText(item.expectation, MAX_EXPECTATION_CHARS)
  const origin: StudyOrigin = item.origin === 'model' ? 'model' : 'material'
  const sources = Array.isArray(item.sources)
    ? item.sources
        .filter((ref): ref is CourseSourceRef => !!ref && typeof ref === 'object' && typeof (ref as CourseSourceRef).sourceId === 'string')
        .slice(0, 20)
    : undefined
  const askedAt = typeof item.askedAt === 'number' && Number.isFinite(item.askedAt) ? item.askedAt : 0
  return {
    question,
    ...(expectation ? { expectation } : {}),
    origin,
    ...(sources && sources.length ? { sources } : {}),
    askedAt
  }
}

function sanitizePosition(raw: unknown): StudyPosition {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Partial<StudyPosition>
  const unitIndex =
    typeof item.unitIndex === 'number' && Number.isFinite(item.unitIndex) && item.unitIndex >= 0 ? Math.floor(item.unitIndex) : 0
  const locator =
    item.locator && typeof item.locator === 'object' && Number.isFinite(item.locator.start) && Number.isFinite(item.locator.end)
      ? { start: Math.max(0, Math.floor(item.locator.start)), end: Math.max(0, Math.floor(item.locator.end)) }
      : undefined
  return { unitIndex, ...(locator ? { locator } : {}) }
}

/** 脏记录一律降级成「准备阶段」，宁可让用户重说一遍，也不要卡在假等待上。 */
export function sanitizeStudySession(raw: unknown): StudySession | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<StudySession>
  const id = clampText(item.id, 80)
  const courseId = clampText(item.courseId, 80)
  const unitId = clampText(item.unitId, 80)
  if (!id || !courseId) return null
  const rawPhase = STUDY_PHASES.includes(item.phase as StudyPhase) ? (item.phase as StudyPhase) : 'preparing'
  const pending = sanitizePending(item.pending)
  /*
   * 等待阶段没有问题时不能原样留着：那会让闸门永远拦住续跑，
   * 而模型手里又没有任何可问的东西（死锁）。降级到讲解。
   */
  const phase: StudyPhase = rawPhase === WAITING_PHASE && !pending ? 'explaining' : rawPhase
  const lastAnswerText = clampText(item.lastAnswer?.text, MAX_ANSWER_CHARS)
  const lastAnswerAt = typeof item.lastAnswer?.at === 'number' && Number.isFinite(item.lastAnswer.at) ? item.lastAnswer.at : 0
  const nextStep = clampText(item.nextStep, MAX_NEXT_STEP_CHARS)
  const runtimeKey = clampText(item.runtimeKey, 400)
  const startedAt = typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? item.startedAt : 0
  const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : startedAt
  return {
    id,
    courseId,
    unitId,
    runtimeKey,
    phase,
    position: sanitizePosition(item.position),
    ...(phase === WAITING_PHASE && pending ? { pending } : {}),
    ...(lastAnswerText ? { lastAnswer: { text: lastAnswerText, at: lastAnswerAt } } : {}),
    ...(nextStep ? { nextStep } : {}),
    paused: item.paused === true,
    startedAt,
    updatedAt
  }
}

export function sanitizeStudyDocument(raw: unknown): StudyDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, sessions: [] }
  const doc = raw as Partial<StudyDocument>
  const sessions: StudySession[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(doc.sessions) ? doc.sessions : []) {
    const session = sanitizeStudySession(item)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
    if (sessions.length >= MAX_STUDY_SESSIONS) break
  }
  return { version: 1, sessions }
}

/** 这门课的学习会话（一门课同时只进行一个）。 */
export function findSessionForCourse(sessions: readonly StudySession[], courseId: string): StudySession | null {
  return sessions.find((item) => item.courseId === courseId) ?? null
}

/** 这个 pi 会话正在陪的课（闸门按它判）。 */
export function findSessionForRuntime(sessions: readonly StudySession[], runtimeKey: string): StudySession | null {
  if (!runtimeKey) return null
  return sessions.find((item) => item.runtimeKey === runtimeKey) ?? null
}

/** 等待闸门：这个会话此刻是不是在等学习者作答。 */
export function isWaitingForLearner(session: StudySession | null | undefined): boolean {
  return !!session && isWaitingPhase(session.phase) && session.paused !== true
}

export function upsertSession(sessions: readonly StudySession[], session: StudySession): StudySession[] {
  const index = sessions.findIndex((item) => item.id === session.id)
  if (index < 0) return [...sessions, session].slice(-MAX_STUDY_SESSIONS)
  const next = [...sessions]
  next[index] = session
  return next
}

export function removeSession(sessions: readonly StudySession[], id: string): StudySession[] {
  return sessions.filter((item) => item.id !== id)
}

/* ------------------------------------------------------------------ *
 * 恢复信息（T08-5：只带必要信息，不含整份课程）
 * ------------------------------------------------------------------ */

/** 拼装恢复摘要时真正用到的那几个字段（避免把整个 `Course` 拽进来）。 */
export interface StudyCourseView {
  id: string
  title: string
  units: readonly { id: string; title: string }[]
}

export interface StudyResume {
  sessionId: string
  courseId: string
  courseTitle: string
  unitId: string
  unitTitle: string
  /** 1 基，给用户看。 */
  unitIndex: number
  totalUnits: number
  phase: StudyPhase
  phaseLabel: string
  waiting: boolean
  paused: boolean
  question?: string
  nextStep?: string
  position: StudyPosition
  updatedAt: number
}

export function buildStudyResume(session: StudySession, course: StudyCourseView | null): StudyResume {
  const units = course?.units ?? []
  /*
   * 单元可能已经被移出路線：那时不能把「第一节」冒充成当前节（会把用户带到错的上面），
   * 位置退回会话里存着的位置，标题如实说不在路线上。
   */
  const found = units.findIndex((unit) => unit.id === session.unitId)
  const index = found >= 0 ? found : Math.max(0, session.position.unitIndex)
  return {
    sessionId: session.id,
    courseId: session.courseId,
    courseTitle: course?.title ?? '（课程已删除）',
    unitId: session.unitId,
    unitTitle: found >= 0 ? units[found].title : '（这一节已不在路线里）',
    unitIndex: index + 1,
    totalUnits: Math.max(units.length, session.position.unitIndex + 1),
    phase: session.phase,
    phaseLabel: phaseLabel(session.phase),
    waiting: isWaitingForLearner(session),
    paused: session.paused,
    ...(session.pending ? { question: session.pending.question } : {}),
    ...(session.nextStep ? { nextStep: session.nextStep } : {}),
    position: session.position,
    updatedAt: session.updatedAt
  }
}

/** 「《课程》·第 3/12 节「标题」」——各处提示共用的一段。 */
export function studyWhere(resume: StudyResume): string {
  return `《${resume.courseTitle}》·第 ${resume.unitIndex}/${resume.totalUnits} 节「${resume.unitTitle}」`
}

/** 拦住自动续跑时给模型/用户的说明（T08-3）。 */
export function waitingNote(resume: StudyResume): string {
  return `正在等学习者作答（${studyWhere(resume)}）：这一轮收尾后不会自动继续 —— 等他答完再往下走，不要自问自答。`
}

/** 后台准备（T08-6）：允许什么、禁止什么，写清楚，别指望模型自觉。 */
export function backgroundStudySummary(resume: StudyResume): string {
  return [
    `（后台准备）你正在陪学${studyWhere(resume)}，当前阶段：${resume.phaseLabel}。`,
    '这一轮只做**后台准备**：',
    '- 可以做：整理这一段教材、把下一节要用的材料备好、生成适量练习、整理笔记；',
    '- **不要**替学习者作答、不要把他没做到的事记成做到、不要把他的进度往前提；',
    '- 需要他作答就停下来等他，别自己往下讲。',
    '做完用 `yan goal report` 报进展；需要学习者发话就如实停下。'
  ].join('\n')
}

/** 重开 / 换会话后「接着学」的正文（T08-5）。 */
export function resumeStudySummary(resume: StudyResume): string {
  /* 用 `phase` 现算标签，不信传进来的 `phaseLabel`（两者不一致时以阶段为准）。 */
  return [
    `${studyWhere(resume)} 接着学：上次停在「${phaseLabel(resume.phase)}」。`,
    ...(resume.question ? [`上次问了他：${resume.question}`] : []),
    ...(resume.nextStep ? [`下一步：${resume.nextStep}`] : []),
    '- 不要从头重讲他已经过的部分；不要替他作答；',
    '- 需要他回答就先问清楚，再停下等他。'
  ].join('\n')
}
