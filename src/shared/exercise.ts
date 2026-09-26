/**
 * 练习与反馈（Exercise / Attempt）—— 契约与纯逻辑（实施-25 P10）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * 陪读里最便宜也最有害的一件事，是**把「看过答案」记成「做对了」**：
 * 界面把答案和题目一起铺开，用户点一下「看解释」，进度条就往前走一格。
 * 结果是进度很好看，人什么也没学会（T10-2 的验收就卡在这一点）。
 *
 * 所以这里有三条不变量：
 *   ① **题目与答案分开**：给界面的 {@link exerciseView} 里没有 `solution`，
 *      也没有客观题的参考答案 —— 要拿答案必须走显式的揭示动作（并因此被记一笔）。
 *   ② **「看过解释」不是独立完成**：{@link isIndependent} 要求
 *      `correct === true` + 没用过提示 + 没看过解释，三者缺一不可；
 *      `correct === null` 的开放题**永远**不算独立完成，也不用「打了多少分」来假装客观。
 *   ③ **用户说的是最终事实**：用户纠正 agent 的判断时，{@link correctAttempt}
 *      把纠正记下来并接受它 —— 系统观察与用户自评分别保存，互不覆盖（与 P11 同源）。
 *
 * 反馈（T10-4）是**宿主规则**先给一版：错在哪里、怎么改、再练什么。
 * 对开放题，宿主不装懂 —— `needsModel: true` 明确要求模型补具体反馈，
 * 而不是用一段模板冒充「批改」。
 *
 * 边界：本片不生成 ConceptProgress（P11）；`Attempt` 是事实源，
 * 进度只是它的稳定摘要 —— 所以这里的记录刻意保留得足够细（提示层级 / 看没看解释 / 纠正）。
 */

import type { CourseSourceRef } from './course'

export const EXERCISE_KINDS = ['explain', 'cloze', 'choice', 'match', 'derive', 'apply', 'work', 'debug'] as const
export type ExerciseKind = (typeof EXERCISE_KINDS)[number]

export const EXERCISE_KIND_LABELS: Record<ExerciseKind, string> = {
  explain: '用自己的话解释',
  cloze: '填空',
  choice: '选择',
  match: '配对',
  derive: '计算与推导',
  apply: '场景应用',
  work: '小作品',
  debug: '找错改正'
}

/** 客观题：宿主能判定对错；其余是开放题，判定是 `null`（不强行打数字分）。 */
const OBJECTIVE_KINDS: readonly ExerciseKind[] = ['cloze', 'choice', 'match', 'derive']

export function isObjectiveKind(kind: ExerciseKind): boolean {
  return OBJECTIVE_KINDS.includes(kind)
}

/** 提示层级（T10-3）：一次给一层，方向 → 关键概念 → 下一步 → 完整示例。 */
export const HINT_LEVELS = ['direction', 'concept', 'next-step', 'example'] as const
export type HintLevel = (typeof HINT_LEVELS)[number]

export const HINT_LEVEL_LABELS: Record<HintLevel, string> = {
  direction: '方向',
  concept: '关键概念',
  'next-step': '下一步',
  example: '完整示例'
}

export type OriginKind = 'material' | 'model'

export interface ExerciseOption {
  id: string
  text: string
}

export interface ExercisePair {
  left: string
  right: string
}

export interface ExerciseHint {
  level: HintLevel
  text: string
}

/** 客观题的参考答案；开放题的 `answer` 是 `{ kind: 'open' }`。 */
export type ExerciseAnswer =
  | { kind: 'choice'; optionId: string }
  | { kind: 'cloze'; blanks: string[] }
  | { kind: 'match'; pairs: ExercisePair[] }
  | { kind: 'text'; accepted: string[] }
  | { kind: 'open' }

export interface Exercise {
  id: string
  courseId: string
  unitId: string
  /** 这道题练的是哪几个概念（P11 用它聚合进度；可以为空）。 */
  conceptIds: string[]
  kind: ExerciseKind
  /** 题目本身 —— 永远可以给学生看。 */
  prompt: string
  options?: ExerciseOption[]
  pairs?: ExercisePair[]
  answer: ExerciseAnswer
  /** 分层提示，最多四层；缺哪层就少哪层，不硬凑。 */
  hints: ExerciseHint[]
  /** 完整解释 / 示例。只在 `reveal-solution` 之后发给界面。 */
  solution?: string
  /** 题干带的图（资料库引用；P19。只存引用，不内联图片数据）。 */
  images?: ExerciseImageRef[]
  origin: OriginKind
  sources: CourseSourceRef[]
  createdAt: number
  updatedAt: number
}

/** 学习者的一次作答（P11 的事实源）。 */
export interface Attempt {
  id: string
  exerciseId: string
  courseId: string
  unitId: string
  /** 学习者原样提交的内容（文本题的原文；客观题的序列化答案）。 */
  raw: string
  /** 判分结果；`null` = 开放题，不判定。 */
  correct: boolean | null
  /** 作答前已经看到过的最高提示层（`none` = 没要提示）。 */
  hintLevelSeen: HintLevel | 'none'
  /** 是否在作答前看过完整解释（T10-2 的关键记录）。 */
  lookedAtSolution: boolean
  /** 用户对判定的纠正（T10-5）：记下纠正内容与当时给的新判定。 */
  correction?: { text: string; correct: boolean | null; at: number }
  at: number
}

export interface ExerciseDocument {
  version: 1
  exercises: Exercise[]
  attempts: Attempt[]
}

export const MAX_EXERCISES = 5000
export const MAX_ATTEMPTS = 20000
export const MAX_PROMPT_CHARS = 2000
export const MAX_HINT_CHARS = 1000
export const MAX_SOLUTION_CHARS = 8000
export const MAX_ATTEMPT_CHARS = 8000
export const MAX_CORRECTION_CHARS = 2000
export const MAX_OPTIONS = 10
export const MAX_PAIRS = 10
/** 一道题最多带几张图（图片题与图解都用它）。 */
export const MAX_EXERCISE_IMAGES = 4

/**
 * 题目里的图（实施-25 P19）。
 *
 * 只存**资料库引用**（`sourceId` + `version`），不内联 base64：
 *   · 图片属资料库（P03 的不变量：按版本可追溯）；
 *   · 题面落盘文件不会因为一张图膨胀；
 *   · 读图仍然走资料库那一条路径（不另建识别服务）。
 */
export interface ExerciseImageRef {
  sourceId: string
  version: number
  /** 图在题目里的作用（给人看的小标）。 */
  caption?: string
}

/**
 * 这道题要不要看图。
 *
 * 与 P17 同一立场：能力不够时**如实说**，不假装能用 —— 界面据此提醒
 * 「当前模型不支持看图」（不自建 OCR）。
 */
export function exerciseNeedsVision(exercise: { images?: ExerciseImageRef[] }): boolean {
  return (exercise.images?.length ?? 0) > 0
}
export const MAX_CONCEPTS_PER_EXERCISE = 20

export type ExerciseMutation = { ok: true; exercise: Exercise; unchanged?: boolean } | { ok: false; reason: string }
export type AttemptMutation = { ok: true; attempt: Attempt } | { ok: false; reason: string }

/* ------------------------------------------------------------------ *
 * 归一化与判分
 * ------------------------------------------------------------------ */

/**
 * 客观题比较用的归一化：去首尾空白、折叠内部空白、去常见中英标点、大小写不敏感。
 *
 * 有意**不**做同义词与拼写宽容 —— 那道判断需要模型，宿主硬猜只会把「答错」
 * 判成「答对」，而这是本片最不该出错的方向。
 */
export function normalizeAnswer(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）【】《》…—,\.!\?;:'"()\[\]<>]/g, '')
}

/** 学习者提交的作答形态（与题型一一对应）。 */
export type ExerciseResponse =
  | { kind: 'choice'; optionId: string }
  | { kind: 'cloze'; blanks: string[] }
  | { kind: 'match'; pairs: ExercisePair[] }
  | { kind: 'text'; text: string }
  | { kind: 'open'; text: string }

/**
 * 判分。
 *
 * 返回 `null` = 这道题**没有**客观判定（开放题，或题目本身没给参考答案）——
 * 返回 `false` 反而是在假装客观，会把「没标准答案」记成「答错了」。
 */
export function gradeResponse(exercise: Exercise, response: ExerciseResponse): boolean | null {
  if (!isObjectiveKind(exercise.kind)) return null
  const answer = exercise.answer
  if (response.kind === 'choice') {
    if (answer.kind !== 'choice') return null
    return response.optionId === answer.optionId
  }
  if (response.kind === 'cloze') {
    if (answer.kind !== 'cloze') return null
    if (answer.blanks.length === 0) return null
    if (response.blanks.length !== answer.blanks.length) return false
    return answer.blanks.every((expected, index) => normalizeAnswer(response.blanks[index]) === normalizeAnswer(expected))
  }
  if (response.kind === 'match') {
    if (answer.kind !== 'match') return null
    if (answer.pairs.length === 0) return null
    const expected = new Map(answer.pairs.map((pair) => [normalizeAnswer(pair.left), normalizeAnswer(pair.right)]))
    if (response.pairs.length !== answer.pairs.length) return false
    for (const pair of response.pairs) {
      const want = expected.get(normalizeAnswer(pair.left))
      if (want === undefined || want !== normalizeAnswer(pair.right)) return false
    }
    return true
  }
  if (response.kind === 'text') {
    if (answer.kind !== 'text') return null
    const accepted = answer.accepted.map(normalizeAnswer).filter(Boolean)
    if (accepted.length === 0) return null
    return accepted.includes(normalizeAnswer(response.text))
  }
  return null
}

/** 把学习者的作答序列化成可存的 `raw`（排障与回看要能还原他到底交了什么）。 */
export function serializeResponse(response: ExerciseResponse): string {
  switch (response.kind) {
    case 'choice':
      return response.optionId
    case 'cloze':
      return JSON.stringify(response.blanks)
    case 'match':
      return JSON.stringify(response.pairs.map((pair) => [pair.left, pair.right]))
    default:
      return response.text
  }
}

/* ------------------------------------------------------------------ *
 * 答案可见性与「独立完成」
 * ------------------------------------------------------------------ */

/**
 * 给界面的题目视图：**不含答案**。
 *
 * 客观题的 `answer` 也不进来 —— 否则打开 Network 面板就能看到答案，
 * 而「先等用户作答」就成了界面自觉。
 */
export interface ExerciseView {
  id: string
  courseId: string
  unitId: string
  conceptIds: string[]
  kind: ExerciseKind
  kindLabel: string
  prompt: string
  options?: ExerciseOption[]
  pairs?: ExercisePair[]
  /** 已揭示的提示（按层级顺序）。 */
  hints: ExerciseHint[]
  /** 还能再揭示一层吗（四层都揭完就是 false）。 */
  hasMoreHints: boolean
  /** 客观题才会是 true；开放题界面不显示「判对错」。 */
  objective: boolean
  /** 这道题有没有完整解释（界面据此决定要不要显示「看完整解释」）。 */
  hasSolution: boolean
  /** 题干带的图（**view 里也不含图片数据**，只有引用；界面自己去资料库取）。 */
  images?: ExerciseImageRef[]
  origin: OriginKind
  sources: CourseSourceRef[]
  createdAt: number
}

export function exerciseView(exercise: Exercise, revealed: readonly HintLevel[] = []): ExerciseView {
  const revealedSet = new Set(revealed)
  const hints = exercise.hints.filter((hint) => revealedSet.has(hint.level))
  return {
    id: exercise.id,
    courseId: exercise.courseId,
    unitId: exercise.unitId,
    conceptIds: [...exercise.conceptIds],
    kind: exercise.kind,
    kindLabel: EXERCISE_KIND_LABELS[exercise.kind] ?? exercise.kind,
    prompt: exercise.prompt,
    ...(exercise.options ? { options: exercise.options.map((o) => ({ ...o })) } : {}),
    ...(exercise.pairs ? { pairs: exercise.pairs.map((p) => ({ ...p })) } : {}),
    hints,
    hasMoreHints: hints.length < exercise.hints.length,
    objective: isObjectiveKind(exercise.kind),
    hasSolution: typeof exercise.solution === 'string' && exercise.solution.length > 0,
    ...(exercise.images && exercise.images.length > 0 ? { images: exercise.images.map((image) => ({ ...image })) } : {}),
    origin: exercise.origin,
    sources: exercise.sources.map((s) => ({ ...s })),
    createdAt: exercise.createdAt
  }
}

/** 揭示提示：返回从最浅到 `upto` 的全部已揭示层级（不能跳层给）。 */
export function revealHints(exercise: Exercise, upto: HintLevel): ExerciseHint[] {
  const limit = HINT_LEVELS.indexOf(upto)
  if (limit < 0) return []
  const allowed = new Set(HINT_LEVELS.slice(0, limit + 1))
  return exercise.hints.filter((hint) => allowed.has(hint.level))
}

/** 作答前看到过的最高提示层。 */
export function highestHint(revealed: readonly HintLevel[]): HintLevel | 'none' {
  let best: HintLevel | 'none' = 'none'
  for (const level of HINT_LEVELS) if (revealed.includes(level)) best = level
  return best
}

/**
 * 这次作答算不算**独立完成**（T10-2 / T11-4 的判据）。
 *
 * 三个条件同时成立才算：判对 + 没要过提示 + 没看过解释。
 * `correct === null` 的开放题恒为 false —— 「用自己的话解释」不可能靠宿主判定，
 * 假装它完成了是最典型的自欺。
 */
export function isIndependent(attempt: Attempt): boolean {
  return attempt.correct === true && attempt.hintLevelSeen === 'none' && attempt.lookedAtSolution !== true
}

/* ------------------------------------------------------------------ *
 * 反馈（T10-4）
 * ------------------------------------------------------------------ */

export interface AttemptFeedback {
  /** 客观判定；`null` = 开放题，不下结论。 */
  verdict: boolean | null
  /** 哪一步是对的（客观题给规则结论；开放题留空）。 */
  correctSteps: string[]
  /** 哪里可能混淆。 */
  confusions: string[]
  /** 怎么改。 */
  howToFix: string[]
  /** 可以再练什么。 */
  nextPractice: string
  /** 需要模型补具体反馈（开放题，或客观题答错但原因不明）。 */
  needsModel: boolean
  /** 这次是否**不**算独立完成（用了提示 / 看过解释）。 */
  assisted: boolean
}

/**
 * 宿主版反馈规则。
 *
 * 这是**兜底**，不是批改：宿主只知道对错与作答时已经拿了多少帮助，
 * 不知道学习者的思路。所以它如实给出可以确定的那部分，
 * 并把「需要看懂他的思路」这件事交给模型（`needsModel`）。
 */
export function buildFeedback(exercise: Pick<Exercise, 'hints'>, attempt: Attempt): AttemptFeedback {
  const assisted = attempt.hintLevelSeen !== 'none' || attempt.lookedAtSolution === true
  const verdict = attempt.correct

  if (verdict === null) {
    return {
      verdict: null,
      correctSteps: [],
      confusions: [],
      howToFix: [],
      nextPractice: '试着用这道题里的概念，再举一个你自己的例子 —— 说出来才算真的会。',
      /* 开放题的具体反馈必须由模型给；宿主不用模板冒充批改。 */
      needsModel: true,
      assisted
    }
  }

  if (verdict === true) {
    return {
      verdict,
      correctSteps: [assisted ? '答案是对的，但这次用了提示或看过解释。' : '这是你独立做对的。'],
      confusions: [],
      howToFix: assisted ? ['合上提示再做一遍同类题，才算真正拿下来。'] : [],
      nextPractice: assisted ? '再做一道同类题，这次先不看提示。' : '换一个情境再做一题，确认能迁移。',
      needsModel: false,
      assisted
    }
  }

  return {
    verdict,
    correctSteps: [],
    confusions: [
      attempt.lookedAtSolution ? '看过完整解释之后再作答，容易照着解释写，不容易发现真正卡住的地方。' : '这一步的答案和参考不一致。'
    ],
    howToFix: [
      '先说清楚你当时是怎么想的，再对照提示找出分歧从哪一步开始。',
      attemptedHint(exercise) ? `先回到「${HINT_LEVEL_LABELS.direction}」那一层，只用一个方向提示重做。` : '先只用一个方向提示重做，别急着看解释。'
    ],
    nextPractice: '同类题再做一道，重点练刚才分歧的那一步。',
    needsModel: true,
    assisted
  }
}

function attemptedHint(exercise: Pick<Exercise, 'hints'>): boolean {
  return exercise.hints.some((hint) => hint.level === 'direction')
}

/* ------------------------------------------------------------------ *
 * 校对与容错读盘
 * ------------------------------------------------------------------ */

function clampText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (text.length > max) return null
  if (/[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

function normalizeHintLevel(raw: unknown): HintLevel | null {
  return (HINT_LEVELS as readonly string[]).includes(String(raw)) ? (raw as HintLevel) : null
}

export interface ExerciseInput {
  courseId: string
  unitId: string
  kind: ExerciseKind
  prompt: string
  conceptIds?: string[]
  options?: ExerciseOption[]
  pairs?: ExercisePair[]
  answer?: ExerciseAnswer
  hints?: ExerciseHint[]
  solution?: string
  origin?: OriginKind
  sources?: CourseSourceRef[]
  /** 题干带的图（P19）：只存资料库引用。 */
  images?: ExerciseImageRef[]
}

function sanitizeAnswer(raw: unknown): ExerciseAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kind = String(o.kind ?? '')
  if (kind === 'open') return { kind: 'open' }
  if (kind === 'choice') {
    const optionId = clampText(o.optionId, 200)
    return optionId ? { kind: 'choice', optionId } : null
  }
  if (kind === 'cloze') {
    const blanks = Array.isArray(o.blanks) ? o.blanks.map((b) => (typeof b === 'string' ? b : '')).filter(Boolean) : []
    return blanks.length ? { kind: 'cloze', blanks } : null
  }
  if (kind === 'match') {
    const pairs = Array.isArray(o.pairs)
      ? o.pairs
          .map((p) => {
            if (!p || typeof p !== 'object') return null
            const pp = p as Record<string, unknown>
            const left = clampText(pp.left, 300)
            const right = clampText(pp.right, 300)
            return left && right ? { left, right } : null
          })
          .filter((p): p is ExercisePair => p !== null)
          .slice(0, MAX_PAIRS)
      : []
    return pairs.length ? { kind: 'match', pairs } : null
  }
  if (kind === 'text') {
    const accepted = Array.isArray(o.accepted) ? o.accepted.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean) : []
    return accepted.length ? { kind: 'text', accepted } : null
  }
  return null
}

/** 建题校验：题面必须有；客观题必须有参考答案，开放题的 `answer` 一律落成 `open`。 */
export function validateExerciseInput(raw: unknown): { ok: true; value: ExerciseInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '输入不是对象' }
  const o = raw as Record<string, unknown>
  const courseId = clampText(o.courseId, 80)
  const unitId = clampText(o.unitId, 80)
  if (!courseId) return { ok: false, reason: '缺少课程 id' }
  if (!unitId) return { ok: false, reason: '缺少单元 id' }
  const kind = String(o.kind ?? '')
  if (!(EXERCISE_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `未知的题型：${kind}` }
  const prompt = clampText(o.prompt, MAX_PROMPT_CHARS)
  if (!prompt) return { ok: false, reason: `题目不能为空，且最多 ${MAX_PROMPT_CHARS} 个字符` }

  const value: ExerciseInput = { courseId, unitId, kind: kind as ExerciseKind, prompt }
  if (Array.isArray(o.conceptIds)) {
    value.conceptIds = o.conceptIds.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, MAX_CONCEPTS_PER_EXERCISE)
  }
  if (Array.isArray(o.options)) {
    const options: ExerciseOption[] = []
    for (const item of o.options) {
      if (!item || typeof item !== 'object') continue
      const io = item as Record<string, unknown>
      const id = clampText(io.id, 80)
      const text = clampText(io.text, 500)
      if (id && text) options.push({ id, text })
    }
    if (options.length) value.options = options.slice(0, MAX_OPTIONS)
  }
  if (Array.isArray(o.pairs)) {
    const pairs: ExercisePair[] = []
    for (const item of o.pairs) {
      if (!item || typeof item !== 'object') continue
      const io = item as Record<string, unknown>
      const left = clampText(io.left, 300)
      const right = clampText(io.right, 300)
      if (left && right) pairs.push({ left, right })
    }
    if (pairs.length) value.pairs = pairs.slice(0, MAX_PAIRS)
  }
  /*
   * 题干带的图（P19）：只接受**资料库引用**。
   * 不接受 data URL / 本地路径 —— 那会让题面变成第二份图片存储（P03 的不变量）。
   */
  if (Array.isArray(o.images)) {
    const images: ExerciseImageRef[] = []
    for (const item of o.images) {
      if (!item || typeof item !== 'object') continue
      const io = item as Record<string, unknown>
      const sourceId = clampText(io.sourceId, 80)
      const version = Number(io.version)
      if (!sourceId || !Number.isInteger(version) || version < 1) continue
      const caption = clampText(io.caption, 200)
      images.push({ sourceId, version, ...(caption ? { caption } : {}) })
    }
    if (images.length) value.images = images.slice(0, MAX_EXERCISE_IMAGES)
  }
  if (Array.isArray(o.hints)) {
    const hints: ExerciseHint[] = []
    for (const item of o.hints) {
      if (!item || typeof item !== 'object') continue
      const io = item as Record<string, unknown>
      const level = normalizeHintLevel(io.level)
      const text = clampText(io.text, MAX_HINT_CHARS)
      if (level && text) hints.push({ level, text })
    }
    if (hints.length) value.hints = dedupeHints(hints)
  }
  const solution = clampText(o.solution, MAX_SOLUTION_CHARS)
  if (solution) value.solution = solution
  if (o.origin === 'model') value.origin = 'model'
  if (Array.isArray(o.sources)) {
    const sources = o.sources.filter(
      (s): s is CourseSourceRef => !!s && typeof s === 'object' && typeof (s as CourseSourceRef).sourceId === 'string'
    )
    if (sources.length) value.sources = sources.slice(0, 20)
  }

  /* 客观题必须有可判定的答案；开放题即使传了答案也忽略。 */
  if (isObjectiveKind(value.kind)) {
    const answer = sanitizeAnswer(o.answer)
    if (!answer || answer.kind === 'open') return { ok: false, reason: '客观题必须给出参考答案' }
    if (value.kind === 'choice' && (!value.options || value.options.length < 2)) {
      return { ok: false, reason: '选择题至少要两个选项' }
    }
    if (value.kind === 'match' && (!value.pairs || value.pairs.length < 2)) {
      return { ok: false, reason: '配对题至少要两对' }
    }
    value.answer = answer
  } else {
    value.answer = { kind: 'open' }
  }
  return { ok: true, value }
}

/** 同一层只留第一条提示（层级是给用户看的，重复层会让界面解锁顺序乱掉）。 */
export function dedupeHints(hints: readonly ExerciseHint[]): ExerciseHint[] {
  const seen = new Set<HintLevel>()
  const out: ExerciseHint[] = []
  for (const level of HINT_LEVELS) {
    const found = hints.find((hint) => hint.level === level)
    if (!found || seen.has(found.level)) continue
    seen.add(found.level)
    out.push({ ...found })
  }
  return out
}

export function makeExerciseId(random: () => number = Math.random): string {
  return `ex_${Math.floor(random() * 36 ** 10).toString(36)}`
}

export function makeAttemptId(random: () => number = Math.random): string {
  return `at_${Math.floor(random() * 36 ** 10).toString(36)}`
}

export function createExercise(input: ExerciseInput, at: number, makeId: () => string): ExerciseMutation {
  const checked = validateExerciseInput(input)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const v = checked.value
  const exercise: Exercise = {
    id: makeId(),
    courseId: v.courseId,
    unitId: v.unitId,
    conceptIds: [...(v.conceptIds ?? [])],
    kind: v.kind,
    prompt: v.prompt,
    ...(v.options ? { options: v.options } : {}),
    ...(v.pairs ? { pairs: v.pairs } : {}),
    answer: v.answer ?? { kind: 'open' },
    hints: v.hints ? [...v.hints] : [],
    ...(v.solution ? { solution: v.solution } : {}),
    ...(v.images && v.images.length > 0 ? { images: v.images.map((image) => ({ ...image })) } : {}),
    origin: v.origin === 'model' ? 'model' : 'material',
    sources: v.sources ? [...v.sources] : [],
    createdAt: at,
    updatedAt: at
  }
  return { ok: true, exercise }
}

/* ------------------------------------------------------------------ *
 * 从单元生成确定性的练习题（宿主规则，不接模型）
 * ------------------------------------------------------------------ */

export interface GeneratedExercise {
  kind: ExerciseKind
  prompt: string
  answer: ExerciseAnswer
  hints: ExerciseHint[]
  solution?: string
  origin: OriginKind
}

/**
 * 从一段材料正文生成 1–3 道确定性练习。
 *
 * 为什么是**确定性**的：宿主在这里不调模型（无额度也能跑、单测与探针 cost 0），
 * 但它也不假装这是「为你量身出的题」—— `origin: 'material'`，
 * 题面直接取自原文，答案就是原文里的词。模型出的题走 `yan exercise create`。
 */
export function draftExercisesFromText(
  text: string,
  options: { unitTitle?: string; maxExercises?: number } = {}
): GeneratedExercise[] {
  const max = options.maxExercises ?? 3
  const compact = text.replace(/\r\n/g, '\n').trim()
  if (!compact) return []
  const paragraphs = compact
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  /*
   * 题面里不能带原始换行与控制字符：那会被 `validateExerciseInput` 拒掉，
   * 而真实材料的段落内部经常有单换行（Markdown 折行）。
   * 折成一行既好读，也让「填空题的题面」是一句完整的话。
   */
  const flatten = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const first = flatten(paragraphs[0] ?? compact.slice(0, 400))
  const out: GeneratedExercise[] = []

  /* ① 用自己的话解释 —— 开放题，不判定。 */
  out.push({
    kind: 'explain',
    prompt: `用自己的话解释这一段：${first.slice(0, 240)}${first.length > 240 ? '…' : ''}`,
    answer: { kind: 'open' },
    hints: dedupeHints([
      { level: 'direction', text: '先说这一段在讲什么，再说它为什么重要。' },
      { level: 'concept', text: '把它拆成「前提 → 结论」两句话。' },
      { level: 'example', text: '举一个你自己的例子来说明它。' }
    ]),
    origin: 'material'
  })

  /* ② 填空 —— 从首段挖一个够长的词，答案就在原文里。 */
  const blank = pickBlankWord(first)
  if (blank) {
    out.push({
      kind: 'cloze',
      prompt: `补上缺的那个词：${first.replace(blank, '____')}`.slice(0, MAX_PROMPT_CHARS),
      answer: { kind: 'cloze', blanks: [blank] },
      hints: dedupeHints([
        { level: 'direction', text: '回到原文看这一句的主语和谓语。' },
        { level: 'next-step', text: `它和「${first.slice(0, 12)}…」出现在同一句里。` }
      ]),
      solution: `原文这一句是：${first}`,
      origin: 'material'
    })
  }

  /* ③ 场景应用 —— 开放题，练迁移而不是记忆。 */
  if (paragraphs.length > 1) {
    out.push({
      kind: 'apply',
      prompt: `如果换到你的场景里，这一段说的做法会变成什么样？用两三句话写下来。（本节的要点：${flatten(options.unitTitle ?? first).slice(0, 40)}）`,
      answer: { kind: 'open' },
      hints: dedupeHints([
        { level: 'direction', text: '先找出这一段里可以照搬的那一步。' },
        { level: 'concept', text: '把它换到你熟悉的对象上，其余条件保持不变。' }
      ]),
      origin: 'material'
    })
  }

  return out.slice(0, max)
}

/** 从一个句子里挑一个能当填空题答案的词（挑不到就不出填空题）。 */
function pickBlankWord(sentence: string): string | null {
  /* 拉丁词按长度挑；中文没有分词，取最长的连续汉字串的前几个字 ——
     宁可挖一个四字的片段，也不要把整句当“一个词”让人填。 */
  const latin = sentence.match(/[A-Za-z][A-Za-z-]{4,}/g)
  if (latin && latin.length) return latin.sort((a, b) => b.length - a.length)[0]
  const cjk = sentence.match(/[\u4e00-\u9fa5]{4,}/g)
  if (!cjk || cjk.length === 0) return null
  const longest = cjk.sort((a, b) => b.length - a.length)[0]
  return longest.slice(0, 4)
}

/* ------------------------------------------------------------------ *
 * 容错读盘
 * ------------------------------------------------------------------ */

function sanitizeConceptIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, MAX_CONCEPTS_PER_EXERCISE) : []
}

function sanitizeSourceList(raw: unknown): CourseSourceRef[] {
  if (!Array.isArray(raw)) return []
  const out: CourseSourceRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const sourceId = typeof o.sourceId === 'string' ? o.sourceId.trim() : ''
    const version = Number(o.version)
    if (!sourceId || !Number.isFinite(version) || version <= 0) continue
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
    out.push(ref)
  }
  return out.slice(0, 20)
}

export function sanitizeExercise(raw: unknown): Exercise | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const checked = validateExerciseInput({
    courseId: o.courseId,
    unitId: o.unitId,
    kind: o.kind,
    prompt: o.prompt,
    conceptIds: o.conceptIds,
    options: o.options,
    pairs: o.pairs,
    answer: o.answer,
    hints: o.hints,
    solution: o.solution,
    origin: o.origin,
    sources: o.sources,
    /* 读盘时也把图带进来（同一份校验：坏引用丢掉） */
    images: o.images
  })
  if (!checked.ok) return null
  const v = checked.value
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) return null
  const createdAt = Number.isFinite(Number(o.createdAt)) ? Number(o.createdAt) : 0
  return {
    id,
    courseId: v.courseId,
    unitId: v.unitId,
    conceptIds: sanitizeConceptIds(o.conceptIds),
    kind: v.kind,
    prompt: v.prompt,
    ...(v.options ? { options: v.options } : {}),
    ...(v.pairs ? { pairs: v.pairs } : {}),
    answer: v.answer ?? { kind: 'open' },
    hints: v.hints ? [...v.hints] : [],
    ...(v.solution ? { solution: v.solution } : {}),
    ...(v.images && v.images.length > 0 ? { images: v.images.map((image) => ({ ...image })) } : {}),
    origin: v.origin === 'model' ? 'model' : 'material',
    sources: sanitizeSourceList(o.sources),
    createdAt,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : createdAt
  }
}

export function sanitizeAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const exerciseId = typeof o.exerciseId === 'string' ? o.exerciseId.trim() : ''
  const courseId = typeof o.courseId === 'string' ? o.courseId.trim() : ''
  const unitId = typeof o.unitId === 'string' ? o.unitId.trim() : ''
  if (!id || !exerciseId) return null
  const rawText = typeof o.raw === 'string' ? o.raw.slice(0, MAX_ATTEMPT_CHARS) : ''
  const correct = typeof o.correct === 'boolean' ? o.correct : null
  const hintLevelSeen = (HINT_LEVELS as readonly string[]).includes(String(o.hintLevelSeen))
    ? (o.hintLevelSeen as HintLevel)
    : 'none'
  const at = Number.isFinite(Number(o.at)) ? Number(o.at) : 0
  const attempt: Attempt = {
    id,
    exerciseId,
    courseId,
    unitId,
    raw: rawText,
    correct,
    hintLevelSeen,
    lookedAtSolution: o.lookedAtSolution === true,
    at
  }
  const correction = o.correction
  if (correction && typeof correction === 'object') {
    const c = correction as Record<string, unknown>
    const text = clampText(c.text, MAX_CORRECTION_CHARS)
    if (text) {
      attempt.correction = {
        text,
        correct: typeof c.correct === 'boolean' ? c.correct : null,
        at: Number.isFinite(Number(c.at)) ? Number(c.at) : at
      }
    }
  }
  return attempt
}

export function sanitizeExerciseDocument(raw: unknown): ExerciseDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, exercises: [], attempts: [] }
  const o = raw as Record<string, unknown>
  const exercises: Exercise[] = []
  const seenExercises = new Set<string>()
  for (const item of Array.isArray(o.exercises) ? o.exercises : []) {
    const exercise = sanitizeExercise(item)
    if (!exercise || seenExercises.has(exercise.id)) continue
    seenExercises.add(exercise.id)
    exercises.push(exercise)
    if (exercises.length >= MAX_EXERCISES) break
  }
  const attempts: Attempt[] = []
  const seenAttempts = new Set<string>()
  for (const item of Array.isArray(o.attempts) ? o.attempts : []) {
    const attempt = sanitizeAttempt(item)
    if (!attempt || seenAttempts.has(attempt.id)) continue
    seenAttempts.add(attempt.id)
    attempts.push(attempt)
    if (attempts.length >= MAX_ATTEMPTS) break
  }
  return { version: 1, exercises, attempts }
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

export function exercisesForUnit(exercises: readonly Exercise[], courseId: string, unitId: string): Exercise[] {
  return exercises
    .filter((exercise) => exercise.courseId === courseId && exercise.unitId === unitId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function attemptsForExercise(attempts: readonly Attempt[], exerciseId: string): Attempt[] {
  return attempts.filter((attempt) => attempt.exerciseId === exerciseId).sort((a, b) => a.at - b.at)
}

/** 这道题最近一次作答（界面显示反馈用）。 */
export function latestAttempt(attempts: readonly Attempt[], exerciseId: string): Attempt | null {
  const list = attemptsForExercise(attempts, exerciseId)
  return list.length ? list[list.length - 1] : null
}
