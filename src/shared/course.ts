/**
 * 课程与路线（Course / LearningUnit / Concept）—— 契约与纯逻辑（实施-25 P07）。
 *
 * 为什么需要它：日常学习里「资料」只是素材，**路线**才是用户真正在走的东西。
 * 路线不是会话地图（T07-5）：会话分支是「我聊到哪了」，课程单元是「我要学会什么」，
 * 两套数据混在一起后，删一条会话就会让课程掉一节。
 *
 * 三条边界：
 *   · **材料内容与模型补充必须分开**（T07-3）：单元有 `origin`。
 *     `material` 单元的 `sources` 指回资料库的真实版本与**真实字符区间**，
 *     没有出处就不许标成 material；`model` 单元必须写清为什么加这一段。
 *   · **不生成不存在的页码**：解析出来的正文只有字符偏移，没有逐页边界，
 *     所以定位一律用 `{start, end}` 字符区间，不编 `page: 3` 这种数字。
 *   · 先开始，边学边调整（T07-2）：建课时只要目标、基础、可用时间；
 *     单元可以是空的，之后再加、再排、再删。
 */

import type { SourceReference } from './library'

export type CourseEntry = 'source' | 'topic' | 'stuck'
export type CourseLevel = 'new' | 'some' | 'confident'
export type CourseStatus = 'active' | 'archived'

/**
 * 单元的来源性质。
 *
 * `material` = 这条来自资料本身（必须带出处）；`model` = 宿主/模型补充的解释
 * （必须带 note 说明为什么加）。**两者不能含糊**：混起来之后用户无法判断
 * 「这一节是书上有的，还是 AI 编的」。
 */
export type UnitOrigin = 'material' | 'model'

/** 指回资料库某一份、某一版、某个字符区间。 */
export interface CourseSourceRef extends SourceReference {
  /** 在资料正文里的字符区间（0 基，右开）。没有它就只能定位到整份资料。 */
  locator?: { start: number; end: number }
}

export interface LearningUnit {
  id: string
  title: string
  /** 这一节要达成什么（可空：先开始，边学边补）。 */
  target?: string
  /** 建议学习量（分钟）。 */
  estimateMinutes: number
  origin: UnitOrigin
  /** `origin='material'` 时至少一条；`origin='model'` 时可以为空。 */
  sources: CourseSourceRef[]
  /** `origin='model'` 时必须写清这一段补充是什么、为什么加。 */
  note?: string
  concepts: string[]
}

export interface Concept {
  id: string
  name: string
  note?: string
}

export interface Course {
  id: string
  spaceId?: string
  title: string
  /** 想学会什么（必填 —— 没有目标的路线会退化成阅读清单）。 */
  goal: string
  level: CourseLevel
  /** 每天能投入多少分钟（可用时间）。 */
  minutesPerDay: number
  entry: CourseEntry
  /** 入口的原始输入（主题名 / 卡点描述 / 资料标题），如实保留。 */
  entryInput?: string
  status: CourseStatus
  units: LearningUnit[]
  concepts: Concept[]
  /** 从某份资料生成时记下用的是哪一份、哪一版。 */
  basedOn?: CourseSourceRef
  /** 生成时因为超上限被截断过（如实标注，不假装覆盖了全书）。 */
  truncated?: boolean
  createdAt: number
  updatedAt: number
}

export interface CourseDocument {
  version: 1
  courses: Course[]
}

export const MAX_COURSES = 500
export const MAX_COURSE_TITLE = 120
export const MAX_COURSE_GOAL = 400
export const MAX_ENTRY_INPUT = 400
export const MAX_UNITS_PER_COURSE = 60
/** 一次生成的单元上限（超了截断并标注，不让一条命令生成 300 节）。 */
export const MAX_ROUTE_UNITS = 40
export const MAX_UNIT_TITLE = 120
export const MAX_UNIT_TARGET = 300
export const MAX_UNIT_NOTE = 400
export const MAX_CONCEPTS = 200
export const MAX_CONCEPT_NAME = 60
export const MIN_MINUTES_PER_DAY = 5
export const MAX_MINUTES_PER_DAY = 600
export const DEFAULT_MINUTES_PER_DAY = 30

/** 生成路线：每几段合成一个单元。 */
export const PARAGRAPHS_PER_UNIT = 4
/** 单元标题取首段的头几个字。 */
export const UNIT_TITLE_CHARS = 24
/** 估算学习量的口径：每 200 字 1 分钟（写下来就不算「拍脑袋」）。 */
export const CHARS_PER_MINUTE = 200
export const MIN_UNIT_MINUTES = 5

export const COURSE_ENTRIES: readonly CourseEntry[] = ['source', 'topic', 'stuck']
export const COURSE_LEVELS: readonly CourseLevel[] = ['new', 'some', 'confident']
export const UNIT_ORIGINS: readonly UnitOrigin[] = ['material', 'model']

export type CourseMutation = { ok: true; course: Course; unchanged?: boolean } | { ok: false; reason: string }

/* ------------------------------------------------------------------ *
 * 校验与建课
 * ------------------------------------------------------------------ */

export interface CourseInput {
  title: string
  goal: string
  spaceId?: string
  level?: CourseLevel
  minutesPerDay?: number
  entry: CourseEntry
  entryInput?: string
}

function clampText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (text.length > max) return null
  if (/[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

export function validateCourseInput(raw: unknown): { ok: true; value: CourseInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '输入不是对象' }
  const o = raw as Record<string, unknown>
  const title = clampText(o.title, MAX_COURSE_TITLE)
  if (!title) return { ok: false, reason: `课程名称不能为空，且最多 ${MAX_COURSE_TITLE} 个字符` }
  const goal = clampText(o.goal, MAX_COURSE_GOAL)
  if (!goal) return { ok: false, reason: `目标不能为空，且最多 ${MAX_COURSE_GOAL} 个字符` }
  const entry = String(o.entry ?? '')
  if (!(COURSE_ENTRIES as readonly string[]).includes(entry)) return { ok: false, reason: `未知的入口：${entry}` }
  const level = o.level === undefined ? 'new' : String(o.level)
  if (!(COURSE_LEVELS as readonly string[]).includes(level)) return { ok: false, reason: `未知的基础水平：${level}` }
  let minutesPerDay = o.minutesPerDay === undefined ? DEFAULT_MINUTES_PER_DAY : Number(o.minutesPerDay)
  if (!Number.isFinite(minutesPerDay)) return { ok: false, reason: '可用时间不是数字' }
  minutesPerDay = Math.round(minutesPerDay)
  if (minutesPerDay < MIN_MINUTES_PER_DAY || minutesPerDay > MAX_MINUTES_PER_DAY) {
    return { ok: false, reason: `可用时间要在 ${MIN_MINUTES_PER_DAY}–${MAX_MINUTES_PER_DAY} 分钟之间` }
  }
  const out: CourseInput = { title, goal, entry: entry as CourseEntry, level: level as CourseLevel, minutesPerDay }
  if (o.spaceId !== undefined && o.spaceId !== null) {
    if (typeof o.spaceId !== 'string' || !o.spaceId.trim()) return { ok: false, reason: '空间 id 不合法' }
    out.spaceId = o.spaceId.trim()
  }
  if (o.entryInput !== undefined && o.entryInput !== null) {
    const entryInput = clampText(o.entryInput, MAX_ENTRY_INPUT)
    if (!entryInput) return { ok: false, reason: `入口输入最多 ${MAX_ENTRY_INPUT} 个字符` }
    out.entryInput = entryInput
  }
  return { ok: true, value: out }
}

function makeId(prefix: string, taken: (id: string) => boolean, random: () => number): string {
  for (let i = 0; i < 200; i++) {
    const id = `${prefix}_${Math.floor(random() * 0xffffffff).toString(36)}${Date.now().toString(36).slice(-4)}`
    if (!taken(id)) return id
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`
}

export function makeCourseId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  return makeId('co', taken, random)
}

export function createCourse(input: CourseInput, at: number, makeCourseId: () => string): CourseMutation {
  const checked = validateCourseInput(input)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const v = checked.value
  const course: Course = {
    id: makeCourseId(),
    ...(v.spaceId ? { spaceId: v.spaceId } : {}),
    title: v.title,
    goal: v.goal,
    level: v.level ?? 'new',
    minutesPerDay: v.minutesPerDay ?? DEFAULT_MINUTES_PER_DAY,
    entry: v.entry,
    ...(v.entryInput ? { entryInput: v.entryInput } : {}),
    status: 'active',
    units: [],
    concepts: [],
    createdAt: at,
    updatedAt: at
  }
  return { ok: true, course }
}

/** 改课程本身（标题 / 目标 / 基础 / 时间）。单元与概念走各自的函数。 */
export function updateCourse(
  course: Course,
  patch: { title?: unknown; goal?: unknown; level?: unknown; minutesPerDay?: unknown },
  at: number
): CourseMutation {
  const next: Course = { ...course }
  if (patch.title !== undefined) {
    const title = clampText(patch.title, MAX_COURSE_TITLE)
    if (!title) return { ok: false, reason: `课程名称不能为空，且最多 ${MAX_COURSE_TITLE} 个字符` }
    next.title = title
  }
  if (patch.goal !== undefined) {
    const goal = clampText(patch.goal, MAX_COURSE_GOAL)
    if (!goal) return { ok: false, reason: `目标不能为空，且最多 ${MAX_COURSE_GOAL} 个字符` }
    next.goal = goal
  }
  if (patch.level !== undefined) {
    const level = String(patch.level)
    if (!(COURSE_LEVELS as readonly string[]).includes(level)) return { ok: false, reason: `未知的基础水平：${level}` }
    next.level = level as CourseLevel
  }
  if (patch.minutesPerDay !== undefined) {
    const minutes = Math.round(Number(patch.minutesPerDay))
    if (!Number.isFinite(minutes) || minutes < MIN_MINUTES_PER_DAY || minutes > MAX_MINUTES_PER_DAY) {
      return { ok: false, reason: `可用时间要在 ${MIN_MINUTES_PER_DAY}–${MAX_MINUTES_PER_DAY} 分钟之间` }
    }
    next.minutesPerDay = minutes
  }
  if (
    next.title === course.title &&
    next.goal === course.goal &&
    next.level === course.level &&
    next.minutesPerDay === course.minutesPerDay
  ) {
    return { ok: true, course, unchanged: true }
  }
  next.updatedAt = at
  return { ok: true, course: next }
}

/* ------------------------------------------------------------------ *
 * 单元：材料 vs 补充
 * ------------------------------------------------------------------ */

/**
 * 单元自身的合法性。
 *
 * 这条是 T07-3 在数据层的落点：
 *   · material 必须指回真实位置（没有出处的「材料」就是编的）；
 *   · model 必须写清为什么加（没有说明的「补充」用户无法判断可信度）。
 */
export function validateUnit(unit: LearningUnit): { ok: true } | { ok: false; reason: string } {
  if (!(UNIT_ORIGINS as readonly string[]).includes(unit.origin)) {
    return { ok: false, reason: `未知的单元来源：${String(unit.origin)}` }
  }
  const title = clampText(unit.title, MAX_UNIT_TITLE)
  if (!title) return { ok: false, reason: `单元标题不能为空，且最多 ${MAX_UNIT_TITLE} 个字符` }
  if (unit.origin === 'material') {
    if (unit.sources.length === 0) return { ok: false, reason: '材料单元必须指回资料位置（不能凭空生成）' }
    for (const source of unit.sources) {
      if (!source.sourceId || !Number.isFinite(source.version)) return { ok: false, reason: '来源引用的 id / 版本不合法' }
      if (source.locator) {
        const { start, end } = source.locator
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
          return { ok: false, reason: '来源区间不合法' }
        }
      }
    }
  } else if (!clampText(unit.note, MAX_UNIT_NOTE)) {
    return { ok: false, reason: '补充单元必须写清为什么加这一段' }
  }
  if (!Number.isFinite(unit.estimateMinutes) || unit.estimateMinutes <= 0) {
    return { ok: false, reason: '建议学习量必须是正数' }
  }
  return { ok: true }
}

export function makeUnitId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  return makeId('u', taken, random)
}

export function makeConceptId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  return makeId('c', taken, random)
}

function withUnits(course: Course, units: LearningUnit[], at: number): Course {
  return { ...course, units, updatedAt: at }
}

export function addUnit(course: Course, unit: LearningUnit, at: number, index?: number): CourseMutation {
  const checked = validateUnit(unit)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  if (course.units.length >= MAX_UNITS_PER_COURSE) return { ok: false, reason: `一门课最多 ${MAX_UNITS_PER_COURSE} 个单元` }
  if (course.units.some((u) => u.id === unit.id)) return { ok: false, reason: '这个单元已经在课程里了' }
  const units = [...course.units]
  const at2 = index === undefined ? units.length : Math.max(0, Math.min(index, units.length))
  units.splice(at2, 0, unit)
  return { ok: true, course: withUnits(course, units, at) }
}

export function updateUnit(
  course: Course,
  unitId: string,
  patch: { title?: unknown; target?: unknown; estimateMinutes?: unknown; note?: unknown },
  at: number
): CourseMutation {
  const index = course.units.findIndex((u) => u.id === unitId)
  if (index < 0) return { ok: false, reason: '找不到这个单元' }
  const current = course.units[index]
  const next: LearningUnit = { ...current }
  if (patch.title !== undefined) {
    const title = clampText(patch.title, MAX_UNIT_TITLE)
    if (!title) return { ok: false, reason: `单元标题不能为空，且最多 ${MAX_UNIT_TITLE} 个字符` }
    next.title = title
  }
  if (patch.target !== undefined) {
    if (patch.target === null || patch.target === '') delete next.target
    else {
      const target = clampText(patch.target, MAX_UNIT_TARGET)
      if (!target) return { ok: false, reason: `这一节的目标最多 ${MAX_UNIT_TARGET} 个字符` }
      next.target = target
    }
  }
  if (patch.estimateMinutes !== undefined) {
    const minutes = Math.round(Number(patch.estimateMinutes))
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, reason: '建议学习量必须是正数' }
    next.estimateMinutes = minutes
  }
  if (patch.note !== undefined) {
    if (current.origin !== 'model') return { ok: false, reason: '只有补充单元才有「为什么加」' }
    const note = clampText(patch.note, MAX_UNIT_NOTE)
    if (!note) return { ok: false, reason: '补充单元必须写清为什么加这一段' }
    next.note = note
  }
  const units = [...course.units]
  units[index] = next
  return { ok: true, course: withUnits(course, units, at) }
}

/** 上移 / 下移（`delta = -1 / +1`）；到头了就如实说没动。 */
export function moveUnit(course: Course, unitId: string, delta: number, at: number): CourseMutation {
  const index = course.units.findIndex((u) => u.id === unitId)
  if (index < 0) return { ok: false, reason: '找不到这个单元' }
  const target = index + Math.sign(delta)
  if (target < 0 || target >= course.units.length) return { ok: true, course, unchanged: true }
  const units = [...course.units]
  const [moved] = units.splice(index, 1)
  units.splice(target, 0, moved)
  return { ok: true, course: withUnits(course, units, at) }
}

export function removeUnit(course: Course, unitId: string, at: number): CourseMutation {
  const units = course.units.filter((u) => u.id !== unitId)
  if (units.length === course.units.length) return { ok: false, reason: '找不到这个单元' }
  return { ok: true, course: withUnits(course, units, at) }
}

/* ------------------------------------------------------------------ *
 * 概念（P07 只登记；进度两轴在 P11）
 * ------------------------------------------------------------------ */

export function addConcept(course: Course, name: unknown, at: number, makeConceptId: () => string): CourseMutation {
  const text = clampText(name, MAX_CONCEPT_NAME)
  if (!text) return { ok: false, reason: `概念名不能为空，且最多 ${MAX_CONCEPT_NAME} 个字符` }
  if (course.concepts.some((c) => c.name === text)) return { ok: true, course, unchanged: true }
  if (course.concepts.length >= MAX_CONCEPTS) return { ok: false, reason: `一门课最多 ${MAX_CONCEPTS} 个概念` }
  const concepts = [...course.concepts, { id: makeConceptId(), name: text }]
  return { ok: true, course: { ...course, concepts, updatedAt: at } }
}

export function removeConcept(course: Course, conceptId: string, at: number): CourseMutation {
  const concepts = course.concepts.filter((c) => c.id !== conceptId)
  if (concepts.length === course.concepts.length) return { ok: false, reason: '找不到这个概念' }
  return { ok: true, course: { ...course, concepts, updatedAt: at } }
}

/* ------------------------------------------------------------------ *
 * 从资料生成路线（T07-3）
 * ------------------------------------------------------------------ */

/** 段落 + 它在原文里的位置。 */
export interface ParagraphSpan {
  text: string
  start: number
  end: number
}

/**
 * 按空行切段，并记录每段在原文里的字符区间。
 *
 * 与 `artifact-doc` 的 `splitParagraphs` 不同：那份只关心文本，这份要为
 * 「指回资料位置」留下偏移 —— 所以偏移是这段代码的存在理由。
 */
export function paragraphSpans(text: string): ParagraphSpan[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const out: ParagraphSpan[] = []
  const re = /\n{2,}/g
  let cursor = 0
  const push = (from: number, to: number) => {
    const raw = normalized.slice(from, to)
    if (!raw.trim()) return
    const lead = raw.length - raw.trimStart().length
    const trail = raw.length - raw.trimEnd().length
    out.push({ text: raw.trim(), start: from + lead, end: to - trail })
  }
  let match: RegExpExecArray | null
  while ((match = re.exec(normalized)) !== null) {
    push(cursor, match.index)
    cursor = match.index + match[0].length
  }
  push(cursor, normalized.length)
  return out
}

/** 从一段文本里取一个能当标题的短句。 */
function titleFromParagraph(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= UNIT_TITLE_CHARS) return flat
  return `${flat.slice(0, UNIT_TITLE_CHARS)}…`
}

export interface RouteDraft {
  units: LearningUnit[]
  truncated: boolean
  paragraphCount: number
}

/**
 * 把一份资料的正文切成单元。
 *
 * 规则是**确定性的**（不调模型）：每 `paragraphsPerUnit` 段一节，
 * 每节带真实的 `{start, end}` 区间。所以「指回资料位置」永远指得准，
 * 也不会出现原文里没有的页码（我们干脆不用页码这个概念）。
 */
export function draftRouteFromText(
  source: { sourceId: string; version: number },
  text: string,
  options: { maxUnits?: number; paragraphsPerUnit?: number } = {},
  makeUnitId: () => string = makeId.bind(null, 'u', () => false, Math.random)
): RouteDraft {
  const maxUnits = options.maxUnits ?? MAX_ROUTE_UNITS
  const perUnit = Math.max(1, options.paragraphsPerUnit ?? PARAGRAPHS_PER_UNIT)
  const spans = paragraphSpans(text)
  if (spans.length === 0) return { units: [], truncated: false, paragraphCount: 0 }

  const groups: ParagraphSpan[][] = []
  for (let i = 0; i < spans.length; i += perUnit) groups.push(spans.slice(i, i + perUnit))
  const kept = groups.slice(0, maxUnits)

  const units = kept.map((group, index) => {
    const first = group[0]
    const last = group[group.length - 1]
    const chars = group.reduce((sum, span) => sum + span.text.length, 0)
    const unit: LearningUnit = {
      id: makeUnitId(),
      title: titleFromParagraph(first.text) || `第 ${index + 1} 节`,
      estimateMinutes: Math.max(MIN_UNIT_MINUTES, Math.ceil(chars / CHARS_PER_MINUTE)),
      origin: 'material',
      sources: [{ sourceId: source.sourceId, version: source.version, locator: { start: first.start, end: last.end } }],
      concepts: []
    }
    return unit
  })
  return { units, truncated: groups.length > kept.length, paragraphCount: spans.length }
}

interface SkeletonStep {
  title: string
  target: string
  note: string
}

/**
 * 主题 / 卡点的骨架。
 *
 * 这些单元标成 `model`：它们是宿主按固定规则搭的脚手架，**不是**从材料里读出来的，
 * 也不是模型生成的（agent 侧还没接模型）。note 里如实写明这一点。
 */
const TOPIC_SKELETON: readonly SkeletonStep[] = [
  { title: '先搭出轮廓', target: '能用一句话说出这个主题解决什么问题', note: '按主题骨架生成（宿主规则，未接模型）：先有轮廓再补材料' },
  { title: '做一个最小的例子', target: '亲手跑通一次最小的例子，并记下卡住的点', note: '按主题骨架生成（宿主规则，未接模型）：动手比读更容易暴露缺口' },
  { title: '讲给别人听一遍', target: '不看稿解释一遍，讲不清的地方就是下一步', note: '按主题骨架生成（宿主规则，未接模型）：复述是最省事的检验' }
]

const BLOCKER_SKELETON: readonly SkeletonStep[] = [
  { title: '把卡点写成一句话', target: '写清「我在哪一步、期望什么、实际什么」', note: '按卡点骨架生成（宿主规则，未接模型）：说不清通常是缺一个前提' },
  { title: '定位最小的缺口', target: '找到那个前提，只补它', note: '按卡点骨架生成（宿主规则，未接模型）：先缩小范围，别整章重读' },
  { title: '重做一次', target: '用同一个例子再做一遍，确认真的通了', note: '按卡点骨架生成（宿主规则，未接模型）：重做才算证据' }
]

function skeletonUnits(steps: readonly SkeletonStep[], minutesPerDay: number): LearningUnit[] {
  const minutes = Math.max(MIN_UNIT_MINUTES, minutesPerDay)
  return steps.map((step) => ({
    id: makeId('u', () => false, Math.random),
    title: step.title,
    target: step.target,
    estimateMinutes: minutes,
    origin: 'model' as const,
    sources: [],
    note: step.note,
    concepts: []
  }))
}

export function planTopicUnits(_topic: string, minutesPerDay: number, makeUnitId: () => string = () => makeId('u', () => false, Math.random)): LearningUnit[] {
  return skeletonUnits(TOPIC_SKELETON, minutesPerDay).map((unit) => ({ ...unit, id: makeUnitId() }))
}

export function planBlockerUnits(
  _blocker: string,
  minutesPerDay: number,
  makeUnitId: () => string = () => makeId('u', () => false, Math.random)
): LearningUnit[] {
  return skeletonUnits(BLOCKER_SKELETON, minutesPerDay).map((unit) => ({ ...unit, id: makeUnitId() }))
}

/* ------------------------------------------------------------------ *
 * 查询与容错读盘
 * ------------------------------------------------------------------ */

export function totalMinutes(course: Course): number {
  return course.units.reduce((sum, unit) => sum + unit.estimateMinutes, 0)
}

/** 材料单元里用到的资料引用去重（用于「这门课用了哪些资料」）。 */
export function courseSourceRefs(course: Course): CourseSourceRef[] {
  const seen = new Set<string>()
  const out: CourseSourceRef[] = []
  for (const unit of course.units) {
    for (const ref of unit.sources) {
      const key = `${ref.sourceId}@${ref.version}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
  }
  return out
}

export function activeCourses(courses: readonly Course[]): Course[] {
  return courses.filter((c) => c.status !== 'archived').sort((a, b) => b.updatedAt - a.updatedAt)
}

export function coursesForSpace(courses: readonly Course[], spaceId?: string | null): Course[] {
  return courses.filter((c) => (spaceId === undefined ? true : (c.spaceId ?? null) === spaceId))
}

function sanitizeSourceRef(raw: unknown): CourseSourceRef | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const sourceId = typeof o.sourceId === 'string' ? o.sourceId.trim() : ''
  const version = Number(o.version)
  if (!sourceId || !Number.isFinite(version) || version <= 0) return null
  const ref: CourseSourceRef = { sourceId, version: Math.round(version) }
  const locator = o.locator
  if (locator && typeof locator === 'object') {
    const l = locator as Record<string, unknown>
    const start = Number(l.start)
    const end = Number(l.end)
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
      ref.locator = { start: Math.round(start), end: Math.round(end) }
    }
  }
  return ref
}

function sanitizeUnit(raw: unknown): LearningUnit | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const title = clampText(o.title, MAX_UNIT_TITLE)
  if (!id || !title) return null
  const origin = (UNIT_ORIGINS as readonly string[]).includes(String(o.origin)) ? (o.origin as UnitOrigin) : 'material'
  const sources = Array.isArray(o.sources)
    ? o.sources.map(sanitizeSourceRef).filter((s): s is CourseSourceRef => s !== null)
    : []
  const unit: LearningUnit = {
    id,
    title,
    estimateMinutes: Math.max(MIN_UNIT_MINUTES, Math.round(Number(o.estimateMinutes) || MIN_UNIT_MINUTES)),
    origin,
    sources,
    concepts: Array.isArray(o.concepts) ? o.concepts.filter((c): c is string => typeof c === 'string' && !!c.trim()) : []
  }
  const target = clampText(o.target, MAX_UNIT_TARGET)
  if (target) unit.target = target
  const note = clampText(o.note, MAX_UNIT_NOTE)
  if (note) unit.note = note
  /* 形状对了还要过一遍语义校验：坏单元丢弃，不让它把路线带歪 */
  return validateUnit(unit).ok ? unit : null
}

function sanitizeCourse(raw: unknown): Course | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const title = clampText(o.title, MAX_COURSE_TITLE)
  const goal = clampText(o.goal, MAX_COURSE_GOAL)
  if (!id || !title || !goal) return null
  const entry = (COURSE_ENTRIES as readonly string[]).includes(String(o.entry)) ? (o.entry as CourseEntry) : 'topic'
  const level = (COURSE_LEVELS as readonly string[]).includes(String(o.level)) ? (o.level as CourseLevel) : 'new'
  const minutes = Math.round(Number(o.minutesPerDay))
  const course: Course = {
    id,
    title,
    goal,
    level,
    minutesPerDay: Number.isFinite(minutes) && minutes >= MIN_MINUTES_PER_DAY && minutes <= MAX_MINUTES_PER_DAY ? minutes : DEFAULT_MINUTES_PER_DAY,
    entry,
    status: o.status === 'archived' ? 'archived' : 'active',
    units: Array.isArray(o.units) ? o.units.map(sanitizeUnit).filter((u): u is LearningUnit => u !== null).slice(0, MAX_UNITS_PER_COURSE) : [],
    concepts: Array.isArray(o.concepts)
      ? o.concepts
          .map((c) => {
            if (!c || typeof c !== 'object') return null
            const cc = c as Record<string, unknown>
            const cid = typeof cc.id === 'string' ? cc.id.trim() : ''
            const name = clampText(cc.name, MAX_CONCEPT_NAME)
            if (!cid || !name) return null
            const concept: Concept = { id: cid, name }
            const note = clampText(cc.note, MAX_UNIT_NOTE)
            if (note) concept.note = note
            return concept
          })
          .filter((c): c is Concept => c !== null)
          .slice(0, MAX_CONCEPTS)
      : [],
    createdAt: Number.isFinite(Number(o.createdAt)) ? Number(o.createdAt) : 0,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0
  }
  if (typeof o.spaceId === 'string' && o.spaceId.trim()) course.spaceId = o.spaceId.trim()
  const entryInput = clampText(o.entryInput, MAX_ENTRY_INPUT)
  if (entryInput) course.entryInput = entryInput
  const basedOn = sanitizeSourceRef(o.basedOn)
  if (basedOn) course.basedOn = basedOn
  if (o.truncated === true) course.truncated = true
  return course
}

/** 读盘容错：坏课程丢弃，不影响其它课程。 */
export function sanitizeCourseDocument(raw: unknown): CourseDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, courses: [] }
  const o = raw as Record<string, unknown>
  const list = Array.isArray(o.courses) ? o.courses : []
  const courses: Course[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const course = sanitizeCourse(item)
    if (!course || seen.has(course.id)) continue
    seen.add(course.id)
    courses.push(course)
    if (courses.length >= MAX_COURSES) break
  }
  return { version: 1, courses }
}
