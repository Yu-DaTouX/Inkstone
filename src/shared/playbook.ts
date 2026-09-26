/**
 * 办事模板（playbook）的**契约层 + 纯逻辑**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件解决什么
 * ══════════════════════════════════════════════════════════════════
 * 「做过的整理、汇总、改写可以再来一次」（实施-25 P14）。
 * 模板记的是**这件事怎么做**：步骤、输入、输出，以及
 * **每一步会不会动东西**。
 *
 * ── 三条边界（比功能更重要）──
 *  ① **模板不执行**。宿主不跑模板、不批量改文件：`playbook.*` 只保存、
 *     只解释、只把「将要做什么」摊开。真正干活的是模型在用户确认之后。
 *     所以这个模块里没有「执行」这个词，只有「说明」。
 *  ② **授权点必须写出来**（T14-3）。任何会写文件 / 会向外发的步骤都算授权点，
 *     而且要带上**作用范围**（哪些文件、哪份来源、哪份成果）。
 *     写步骤没有范围 → 直接拒绝保存（`missing_scope`）：
 *     「不知道会动哪些文件」不许变成模板，因为那正是「静默动文件」的入口。
 *  ③ **不猜该不该确认**。只要有一个非只读步骤，`needsConfirmation` 就是真 ——
 *     不看它是不是「安全的写」、不看用户上次确认过没有。
 *
 * ── 保存的模板从哪来 ──
 * `origin` 只有两种：从一次**成功用过**的任务里带出来（`from-task`，必须带来源），
 * 或用户当场自己存（`user`）。宿主**不**从标题猜「这大概是个模板」——
 * 认得出的来源是名单，不是正则。
 *
 * 它不碰 electron / pi / 文件系统，所以主进程、随包 CLI 与单测共用同一份规则。
 */

/** 首批场景（T14-2）+ 自定义。 */
export const PLAYBOOK_KINDS = ['files', 'digest', 'rewrite', 'custom'] as const
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number]

export const PLAYBOOK_KIND_LABELS: Record<PlaybookKind, string> = {
  files: '整理文件',
  digest: '汇总材料',
  rewrite: '改写内容',
  custom: '自定义'
}

/**
 * 一步的**影响**。只有三档，因为只有三类事需要用户知情：
 * 看（`read`）、改（`write`）、发出去（`external`）。
 */
export const STEP_EFFECTS = ['read', 'write', 'external'] as const
export type StepEffect = (typeof STEP_EFFECTS)[number]

export const STEP_EFFECT_LABELS: Record<StepEffect, string> = {
  read: '只读',
  write: '会改东西',
  external: '会对外发出'
}

export function stepEffectNote(effect: StepEffect): string {
  switch (effect) {
    case 'read':
      return '只读，不改任何东西'
    case 'write':
      return '会写文件或成果（必须写清范围）'
    case 'external':
      return '会向外发出内容（消息 / 上传 / 调外部服务）'
  }
}

/** 这些影响需要用户先确认。 */
export function effectNeedsConfirmation(effect: StepEffect): boolean {
  return effect === 'write' || effect === 'external'
}

export const PLAYBOOK_LIMITS = {
  /** 最多保存多少份模板。 */
  maxPlaybooks: 200,
  /** 一份模板最多多少步。 */
  maxSteps: 30,
  /** 单步最多写多少个作用范围。 */
  maxScope: 50,
  /** 单段文字最长多少字符（按 code point 数）。 */
  maxText: 2000,
  /** 标题最长多少字符。 */
  maxTitle: 120
} as const

/** 模板里的一步。 */
export interface PlaybookStep {
  /** 这一步做什么（祈使句，给模型看也给人看）。 */
  title: string
  /** 可选补充说明。 */
  detail?: string
  /** 影响：只读 / 会改 / 会发出去。 */
  effect: StepEffect
  /**
   * 作用范围：具体到「哪个文件 / 哪份资料 / 哪份成果」。
   *
   * `write` / `external` 步骤**必填且非空** —— 空范围等于「看情况」，那不叫范围。
   */
  scope?: string[]
}

/** 模板的输入与输出（T14-1：保存「用过的输入 / 输出」）。 */
export interface PlaybookIO {
  inputs: string[]
  outputs: string[]
}

/** 这份模板是从哪来的。 */
export interface PlaybookSource {
  kind: 'task' | 'session'
  /** 任务卡 id 或会话文件路径。 */
  id: string
  /** 发生在第几轮（可选，纯诊断）。 */
  round?: number
}

export interface Playbook {
  id: string
  kind: PlaybookKind
  title: string
  /** 这件事想达到什么（可以跟任务卡的目标不同：模板是通用的）。 */
  goal: string
  steps: PlaybookStep[]
  io: PlaybookIO
  spaceId: string | null
  /** `from-task` 表示从一次成功用过的任务里带出来；`user` 是用户当场存的。 */
  origin: 'from-task' | 'user'
  source?: PlaybookSource
  createdAt: number
  updatedAt: number
  /** 用过几次 + 上次什么时候用（只是记录，不代表成功率）。 */
  runs: number
  lastRunAt?: number
  /** 内置起步模板（未落盘时也在列表里）。 */
  seeded?: boolean
}

/** 落盘文档（与笔记 / 学习记忆同一套容错读盘立场）。 */
export interface PlaybookDocument {
  version: number
  playbooks: Playbook[]
}

export function emptyPlaybookDocument(): PlaybookDocument {
  return { version: 1, playbooks: [] }
}

/* ══════════════════════════════════════════════════════════════════
 * 一、授权点与范围（T14-3 的落点）
 * ══════════════════════════════════════════════════════════════════ */

export interface ScopeSummary {
  read: number
  write: number
  external: number
  /** 所有写 / 发步骤的作用范围，去重后按首次出现排序。 */
  targets: string[]
}

/** 汇总一份模板的读取 / 写入 / 外发步骤数与写范围。 */
export function scopeSummary(steps: readonly PlaybookStep[]): ScopeSummary {
  const summary: ScopeSummary = { read: 0, write: 0, external: 0, targets: [] }
  const seen = new Set<string>()
  for (const step of steps) {
    summary[step.effect] += 1
    if (!effectNeedsConfirmation(step.effect)) continue
    for (const target of step.scope ?? []) {
      const trimmed = target.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      summary.targets.push(trimmed)
    }
  }
  return summary
}

/** 需要用户确认的步骤（只读步骤不算）。 */
export function confirmationPoints(steps: readonly PlaybookStep[]): PlaybookStep[] {
  return steps.filter((step) => effectNeedsConfirmation(step.effect))
}

/**
 * 占位写法（起步模板用 `<要整理的目录>` 这种写法）。
 *
 * 它**不是**真实范围：复用前必须换掉。不把它当成「已填」是为了让
 * 「填到输入框」在起步模板上默认不可用 —— 否则用户点一下就把
 * 「<要整理的目录>」这句话发给模型了。
 */
export function isPlaceholderScope(text: string): boolean {
  const value = String(text ?? '').trim()
  return value.startsWith('<') && value.endsWith('>')
}

/**
 * 一步的范围是不是「还没填」。
 *
 * 三条都算没填：没写、写了空、写了 `<占位>`。
 * 只要还剩占位就算没填完 —— 宁可让用户多看一眼，
 * 也不要把「<要整理的目录>」这句占位话发给模型。
 */
export function stepScopeUnfilled(step: PlaybookStep): boolean {
  const scope = step.scope ?? []
  if (scope.length === 0) return true
  return scope.some((item) => isPlaceholderScope(item))
}

/** 有没有需要确认的步骤。 */
export function needsConfirmation(steps: readonly PlaybookStep[]): boolean {
  return steps.some((step) => effectNeedsConfirmation(step.effect))
}

/**
 * 复用前给用户看的那段话（T14-3）。
 *
 * 刻意不写「已获授权」这类结论：这里只说**将要发生什么**，
 * 确认是用户看完之后的一次点击，不是这句话本身能给出的。
 */
export function confirmationText(playbook: Playbook): string {
  const summary = scopeSummary(playbook.steps)
  if (!needsConfirmation(playbook.steps)) {
    return `「${playbook.title}」${playbook.steps.length} 步都是只读，不会改动任何文件或成果。`
  }
  const parts: string[] = []
  if (summary.write > 0) parts.push(`会改东西 ${summary.write} 步`)
  if (summary.external > 0) parts.push(`会对外发出 ${summary.external} 步`)
  const targets =
    summary.targets.length > 0
      ? `作用范围：${summary.targets.slice(0, 8).join('、')}${summary.targets.length > 8 ? ` 等 ${summary.targets.length} 处` : ''}`
      : '作用范围：未写明'
  return `「${playbook.title}」${parts.join('，')}（其余 ${summary.read} 步只读）。${targets}。确认之前不会动任何东西。`
}

/** 用过几次的说明（不承诺效果）。 */
export function playbookRunNote(playbook: Playbook): string {
  if (playbook.runs <= 0) return '还没用过'
  const when = playbook.lastRunAt ? new Date(playbook.lastRunAt).toLocaleDateString() : '时间未知'
  return `用过 ${playbook.runs} 次，上次 ${when}`
}

/* ══════════════════════════════════════════════════════════════════
 * 二、输入校验（严格：新写入用）
 * ══════════════════════════════════════════════════════════════════ */

export type PlaybookErrorCode =
  | 'bad_title'
  | 'title_too_long'
  | 'bad_kind'
  | 'bad_goal'
  | 'bad_steps'
  | 'too_many_steps'
  | 'empty_step'
  | 'bad_effect'
  | 'missing_scope'
  | 'too_many_scope'
  | 'text_too_long'
  | 'bad_io'
  | 'missing_source'
  /** 复用确认时给的几组作用范围数量对不上。 */
  | 'bad_scope'
  | 'not_found'
  | 'too_many_playbooks'

export interface PlaybookInput {
  kind?: unknown
  title?: unknown
  goal?: unknown
  steps?: unknown
  io?: unknown
  spaceId?: unknown
  origin?: unknown
  source?: unknown
}

function charLength(text: string): number {
  return [...text].length
}

function bad(code: PlaybookErrorCode, message: string): { ok: false; code: PlaybookErrorCode; message: string } {
  return { ok: false, code, message }
}

function textOf(value: unknown, code: PlaybookErrorCode, label: string, required: boolean): string | { ok: false; code: PlaybookErrorCode; message: string } {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const trimmed = text.trim()
  if (!trimmed) {
    if (required) return bad(code, `${label}不能为空`)
    return ''
  }
  if (charLength(trimmed) > PLAYBOOK_LIMITS.maxText) {
    return bad('text_too_long', `${label}超过 ${PLAYBOOK_LIMITS.maxText} 字符（实际 ${charLength(trimmed)}）`)
  }
  return trimmed
}

/** 解析一个范围数组（写步骤要非空）。 */
function scopeOf(raw: unknown, stepIndex: number): { ok: true; scope?: string[] } | { ok: false; code: PlaybookErrorCode; message: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (!Array.isArray(raw)) return bad('missing_scope', `第 ${stepIndex} 步的 scope 必须是数组`)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return bad('missing_scope', `第 ${stepIndex} 步的 scope 里第 ${out.length + 1} 项不是字符串`)
    const trimmed = item.trim()
    if (!trimmed) continue
    if (charLength(trimmed) > PLAYBOOK_LIMITS.maxText) {
      return bad('text_too_long', `第 ${stepIndex} 步的作用范围超过 ${PLAYBOOK_LIMITS.maxText} 字符`)
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  if (out.length > PLAYBOOK_LIMITS.maxScope) {
    return bad('too_many_scope', `第 ${stepIndex} 步最多 ${PLAYBOOK_LIMITS.maxScope} 个作用范围（实际 ${out.length}）`)
  }
  return out.length > 0 ? { ok: true, scope: out } : { ok: true }
}

/**
 * 解析 `steps`。
 *
 * 最重要的一条：**写 / 发步骤必须带非空 scope**。
 * 这条不是为了好看 —— 没有它，「复用模板」就变成一次范围未知的写操作，
 * 而验收要求正好相反（不静默动文件）。
 */
export function parsePlaybookSteps(raw: unknown): { ok: true; steps: PlaybookStep[] } | { ok: false; code: PlaybookErrorCode; message: string } {
  if (!Array.isArray(raw)) return bad('bad_steps', 'steps 必须是数组')
  if (raw.length === 0) return bad('bad_steps', '模板至少要一步')
  if (raw.length > PLAYBOOK_LIMITS.maxSteps) {
    return bad('too_many_steps', `最多 ${PLAYBOOK_LIMITS.maxSteps} 步（实际 ${raw.length}）`)
  }
  const steps: PlaybookStep[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const at = i + 1
    const item = raw[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) return bad('empty_step', `第 ${at} 步不是对象`)
    const step = item as { title?: unknown; detail?: unknown; effect?: unknown; scope?: unknown }
    const title = textOf(step.title, 'empty_step', `第 ${at} 步的 title`, true)
    if (typeof title !== 'string') return title
    if (typeof step.effect !== 'string' || !STEP_EFFECTS.includes(step.effect as StepEffect)) {
      return bad('bad_effect', `第 ${at} 步的 effect 必须是 ${STEP_EFFECTS.join(' / ')} 之一`)
    }
    const effect = step.effect as StepEffect
    const detail = textOf(step.detail, 'text_too_long', `第 ${at} 步的 detail`, false)
    if (typeof detail !== 'string') return detail
    const scope = scopeOf(step.scope, at)
    if (!scope.ok) return scope
    if (effectNeedsConfirmation(effect) && (!scope.scope || scope.scope.length === 0)) {
      return bad(
        'missing_scope',
        `第 ${at} 步会${effect === 'write' ? '改东西' : '对外发出'}，必须写清作用范围（scope 不能为空）`
      )
    }
    steps.push({
      title,
      effect,
      ...(detail ? { detail } : {}),
      ...(scope.scope ? { scope: scope.scope } : {})
    })
  }
  return { ok: true, steps }
}

/** 解析输入 / 输出清单。 */
export function parsePlaybookIO(raw: unknown): { ok: true; io: PlaybookIO } | { ok: false; code: PlaybookErrorCode; message: string } {
  if (raw === undefined || raw === null) return { ok: true, io: { inputs: [], outputs: [] } }
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('bad_io', 'io 必须是 { inputs, outputs } 对象')
  const box = raw as { inputs?: unknown; outputs?: unknown }
  const read = (value: unknown, label: string): { ok: true; items: string[] } | { ok: false; code: PlaybookErrorCode; message: string } => {
    if (value === undefined || value === null) return { ok: true, items: [] }
    if (!Array.isArray(value)) return bad('bad_io', `io.${label} 必须是数组`)
    const items: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') return bad('bad_io', `io.${label} 里第 ${items.length + 1} 项不是字符串`)
      const trimmed = item.trim()
      if (!trimmed) continue
      if (charLength(trimmed) > PLAYBOOK_LIMITS.maxText) return bad('text_too_long', `io.${label} 里有一项超过 ${PLAYBOOK_LIMITS.maxText} 字符`)
      if (!items.includes(trimmed)) items.push(trimmed)
    }
    if (items.length > PLAYBOOK_LIMITS.maxScope) return bad('too_many_scope', `io.${label} 最多 ${PLAYBOOK_LIMITS.maxScope} 项`)
    return { ok: true, items }
  }
  const inputs = read(box.inputs, 'inputs')
  if (!inputs.ok) return inputs
  const outputs = read(box.outputs, 'outputs')
  if (!outputs.ok) return outputs
  return { ok: true, io: { inputs: inputs.items, outputs: outputs.items } }
}

/**
 * 校验一次「保存模板」的输入。
 *
 * `origin: 'from-task'` 必须带 `source.id` —— 「从一次成功用过的任务里带出来」
 * 这句话得有具体来源，否则就是宿主在替用户回忆。
 */
export function validatePlaybookInput(
  input: PlaybookInput
): { ok: true; value: { kind: PlaybookKind; title: string; goal: string; steps: PlaybookStep[]; io: PlaybookIO; spaceId: string | null; origin: 'from-task' | 'user'; source?: PlaybookSource } } | { ok: false; code: PlaybookErrorCode; message: string } {
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : ''
  if (!rawTitle) return bad('bad_title', '模板要有个名字')
  if (charLength(rawTitle) > PLAYBOOK_LIMITS.maxTitle) {
    return bad('title_too_long', `名字最长 ${PLAYBOOK_LIMITS.maxTitle} 字符（实际 ${charLength(rawTitle)}）`)
  }
  const kind = input.kind === undefined || input.kind === null ? 'custom' : input.kind
  if (typeof kind !== 'string' || !PLAYBOOK_KINDS.includes(kind as PlaybookKind)) {
    return bad('bad_kind', `kind 必须是 ${PLAYBOOK_KINDS.join(' / ')} 之一`)
  }
  const goal = textOf(input.goal, 'bad_goal', '目标', true)
  if (typeof goal !== 'string') return goal
  const steps = parsePlaybookSteps(input.steps)
  if (!steps.ok) return steps
  const io = parsePlaybookIO(input.io)
  if (!io.ok) return io

  const origin = input.origin === 'from-task' ? 'from-task' : 'user'
  const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim() ? input.spaceId.trim() : null
  let source: PlaybookSource | undefined
  if (origin === 'from-task') {
    const raw = input.source
    if (!raw || typeof raw !== 'object') return bad('missing_source', '说「从这次任务存下来」就必须带上来源')
    const s = raw as { kind?: unknown; id?: unknown; round?: unknown }
    const id = typeof s.id === 'string' ? s.id.trim() : ''
    if (!id) return bad('missing_source', '来源缺少 id（任务 id 或会话文件路径）')
    const kindOf: 'task' | 'session' = s.kind === 'session' ? 'session' : 'task'
    const round = Number.isInteger(s.round) && (s.round as number) >= 1 ? (s.round as number) : undefined
    source = { kind: kindOf, id, ...(round ? { round } : {}) }
  }
  return {
    ok: true,
    value: {
      kind: kind as PlaybookKind,
      title: rawTitle,
      goal,
      steps: steps.steps,
      io: io.io,
      spaceId,
      origin,
      ...(source ? { source } : {})
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 三、创建与修改（纯函数，不落盘）
 * ══════════════════════════════════════════════════════════════════ */

/** 造一份新模板（id 与时间由调用方给，方便单测与去重查错）。 */
export function createPlaybook(
  input: { kind: PlaybookKind; title: string; goal: string; steps: PlaybookStep[]; io: PlaybookIO; spaceId: string | null; origin: 'from-task' | 'user'; source?: PlaybookSource },
  options: { id: string; now: number }
): Playbook {
  return {
    id: options.id,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    steps: input.steps,
    io: input.io,
    spaceId: input.spaceId,
    origin: input.origin,
    ...(input.source ? { source: input.source } : {}),
    createdAt: options.now,
    updatedAt: options.now,
    runs: 0
  }
}

/** 改一份模板（改内容会把 `updatedAt` 推后，`runs` 不受影响）。 */
export function applyPlaybookPatch(
  prev: Playbook,
  patch: { title?: unknown; goal?: unknown; steps?: unknown; io?: unknown; kind?: unknown },
  now: number
): { ok: true; playbook: Playbook } | { ok: false; code: PlaybookErrorCode; message: string } {
  const title = patch.title === undefined ? prev.title : (typeof patch.title === 'string' ? patch.title.trim() : '')
  if (!title) return bad('bad_title', '模板要有个名字')
  if (charLength(title) > PLAYBOOK_LIMITS.maxTitle) {
    return bad('title_too_long', `名字最长 ${PLAYBOOK_LIMITS.maxTitle} 字符（实际 ${charLength(title)}）`)
  }
  const goal = patch.goal === undefined ? prev.goal : textOf(patch.goal, 'bad_goal', '目标', true)
  if (typeof goal !== 'string') return goal
  const steps = patch.steps === undefined ? { ok: true as const, steps: prev.steps } : parsePlaybookSteps(patch.steps)
  if (!steps.ok) return steps
  const io = patch.io === undefined ? { ok: true as const, io: prev.io } : parsePlaybookIO(patch.io)
  if (!io.ok) return io
  let kind = prev.kind
  if (patch.kind !== undefined) {
    if (typeof patch.kind !== 'string' || !PLAYBOOK_KINDS.includes(patch.kind as PlaybookKind)) {
      return bad('bad_kind', `kind 必须是 ${PLAYBOOK_KINDS.join(' / ')} 之一`)
    }
    kind = patch.kind as PlaybookKind
  }
  return { ok: true, playbook: { ...prev, kind, title, goal, steps: steps.steps, io: io.io, updatedAt: now } }
}

/* ══════════════════════════════════════════════════════════════════
 * 四、容错读盘与集合操作
 * ══════════════════════════════════════════════════════════════════ */

/** 读盘用：认不出的模板丢掉，但一份坏数据不让整份文档消失。 */
export function sanitizePlaybook(raw: unknown): Playbook | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : ''
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  if (!id || !title) return undefined
  const kind = typeof p.kind === 'string' && PLAYBOOK_KINDS.includes(p.kind as PlaybookKind) ? (p.kind as PlaybookKind) : 'custom'
  const origin = p.origin === 'from-task' ? 'from-task' : 'user'
  const steps = parsePlaybookSteps(p.steps)
  /* 步骤读不出来（例如旧数据里有写步骤但没范围）就丢掉这份模板：留着它比丢掉更危险 */
  if (!steps.ok) return undefined
  const io = parsePlaybookIO(p.io)
  const createdAt = Number.isFinite(p.createdAt) ? Number(p.createdAt) : 0
  const updatedAt = Number.isFinite(p.updatedAt) ? Number(p.updatedAt) : createdAt
  const runs = Number.isInteger(p.runs) && (p.runs as number) >= 0 ? (p.runs as number) : 0
  const source =
    p.source && typeof p.source === 'object' && typeof (p.source as { id?: unknown }).id === 'string'
      ? {
          kind: (p.source as { kind?: unknown }).kind === 'session' ? ('session' as const) : ('task' as const),
          id: String((p.source as { id: string }).id),
          ...(Number.isInteger((p.source as { round?: unknown }).round) ? { round: Number((p.source as { round: number }).round) } : {})
        }
      : undefined
  return {
    id,
    kind,
    title,
    goal: typeof p.goal === 'string' ? p.goal.trim() : '',
    steps: steps.steps,
    io: io.ok ? io.io : { inputs: [], outputs: [] },
    spaceId: typeof p.spaceId === 'string' && p.spaceId.trim() ? p.spaceId.trim() : null,
    origin,
    ...(source ? { source } : {}),
    createdAt,
    updatedAt,
    runs,
    ...(Number.isFinite(p.lastRunAt) ? { lastRunAt: Number(p.lastRunAt) } : {})
  }
}

/** 读盘用：整份文档。 */
export function sanitizePlaybookDocument(raw: unknown): PlaybookDocument {
  if (!raw || typeof raw !== 'object') return emptyPlaybookDocument()
  const list = (raw as { playbooks?: unknown }).playbooks
  if (!Array.isArray(list)) return emptyPlaybookDocument()
  const playbooks: Playbook[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const pb = sanitizePlaybook(item)
    if (!pb || seen.has(pb.id)) continue
    seen.add(pb.id)
    playbooks.push(pb)
    if (playbooks.length >= PLAYBOOK_LIMITS.maxPlaybooks) break
  }
  return { version: 1, playbooks }
}

/** 找一份模板。 */
export function findPlaybook(doc: PlaybookDocument, id: string): Playbook | undefined {
  return doc.playbooks.find((p) => p.id === id)
}

/** 按空间过滤（`spaceId` 为空表示「不挑空间」，把全部给出来）。 */
export function playbooksForSpace(doc: PlaybookDocument, spaceId?: string | null): Playbook[] {
  if (!spaceId) return [...doc.playbooks]
  return doc.playbooks.filter((p) => !p.spaceId || p.spaceId === spaceId)
}

/** 新增或替换（按 id）：返回新文档，不改旧的。 */
export function upsertPlaybookIn(doc: PlaybookDocument, playbook: Playbook): PlaybookDocument {
  const index = doc.playbooks.findIndex((p) => p.id === playbook.id)
  if (index < 0) {
    if (doc.playbooks.length >= PLAYBOOK_LIMITS.maxPlaybooks) return doc
    return { ...doc, playbooks: [...doc.playbooks, playbook] }
  }
  const next = [...doc.playbooks]
  next[index] = playbook
  return { ...doc, playbooks: next }
}

/** 删一份模板。 */
export function removePlaybookFrom(doc: PlaybookDocument, id: string): PlaybookDocument {
  return { ...doc, playbooks: doc.playbooks.filter((p) => p.id !== id) }
}

/** 空间被删时带走它的模板（不挑空间的模板留着 —— 它们不属于任何空间）。 */
export function removeSpacePlaybooksFrom(doc: PlaybookDocument, spaceId: string): { doc: PlaybookDocument; removed: number } {
  const kept = doc.playbooks.filter((p) => p.spaceId !== spaceId)
  return { doc: { ...doc, playbooks: kept }, removed: doc.playbooks.length - kept.length }
}

/* ══════════════════════════════════════════════════════════════════
 * 五、交给模型 / 填进输入框的说明
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一段可直接发出去的说明。
 *
 * 为什么把授权点写进正文而不是只放在界面上：这段话是**模型看的那一份**。
 * 界面上的确认是给人的，模型不知道用户点过什么 —— 把范围写在正文里，
 * 模型才不会自己扩大动作面。
 */
export function playbookStepsText(playbook: Playbook): string {
  const lines: string[] = [`按这个模板做：${playbook.title}`, `目标：${playbook.goal}`]
  if (playbook.io.inputs.length > 0) lines.push(`输入：${playbook.io.inputs.join('、')}`)
  if (playbook.io.outputs.length > 0) lines.push(`产出：${playbook.io.outputs.join('、')}`)
  lines.push('步骤：')
  playbook.steps.forEach((step, i) => {
    const scope = step.scope && step.scope.length > 0 ? `（范围：${step.scope.join('、')}）` : ''
    lines.push(`${i + 1}. ${step.title}${step.detail ? `：${step.detail}` : ''} [${STEP_EFFECT_LABELS[step.effect]}]${scope}`)
  })
  const summary = scopeSummary(playbook.steps)
  if (needsConfirmation(playbook.steps)) {
    lines.push(`边界：只做上面这些，不要把动作面扩大；${summary.targets.length > 0 ? `只动这几处 — ${summary.targets.join('、')}。` : ''}`)
  } else {
    lines.push('边界：只读，不要修改任何文件或成果。')
  }
  return lines.join('\n')
}

/**
 * 把输入框里的一行行文字变成步骤。
 *
 * 每行：`标题` 或 `标题 | 影响` 或 `标题 | 影响 | 范围1、范围2`。
 * 影响不写就是只读（保守默认：不写不会变成写，但写了写步骤就得给范围）。
 *
 * 为什么给用户一个文本入口而不是一个多字段表单：写步骤的**范围**往往是几个路径 /
 * 几个来源，用一行文字比用一组动态表单更接近用户脑子里那段话；
 * 而校验最后仍要回到 `parsePlaybookSteps`（同一份规则，不另写一套）。
 */
export function parseStepLines(text: string): { ok: true; steps: PlaybookStep[] } | { ok: false; code: PlaybookErrorCode; message: string } {
  const EFFECT_ALIASES: Record<string, StepEffect> = {
    read: 'read',
    '只读': 'read',
    '读': 'read',
    write: 'write',
    '会改': 'write',
    '改': 'write',
    '写': 'write',
    external: 'external',
    '对外发': 'external',
    '发': 'external',
    '外发': 'external'
  }
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return bad('bad_steps', '至少要写一步')
  const raw: { title: string; effect: string; scope?: string[] }[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const at = i + 1
    const parts = lines[i].split('|').map((p) => p.trim())
    const title = parts[0] ?? ''
    if (!title) return bad('empty_step', `第 ${at} 行没有写这一步做什么`)
    const effectText = parts[1] ?? ''
    const effect = effectText ? EFFECT_ALIASES[effectText.toLowerCase()] : 'read'
    if (!effect) {
      return bad('bad_effect', `第 ${at} 行的影响写成了「${effectText}」（可用：只读 / 会改 / 对外发）`)
    }
    const scopeText = parts[2] ?? ''
    const scope = scopeText
      ? scopeText
          .split(/[、,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
    raw.push({ title, effect, ...(scope ? { scope } : {}) })
  }
  return parsePlaybookSteps(raw)
}

/* ══════════════════════════════════════════════════════════════════
 * 六、首批起步模板（T14-2）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 三个起步模板。
 *
 * 它们**不落盘**（用户数据目录里不该凭空多出三条「用户存过的模板」），
 * 只在列表里以 `seeded: true` 出现；用户改一次就会落盘覆盖同 id。
 * 写步骤的 scope 用**占位**写法（`<要整理的目录>`）—— 起步模板不知道具体路径，
 * 但必须留出这个位置：用户复用前会把它换成真实路径，这就是 T14-3 的确认点。
 */
export function seedPlaybooks(now = 0): Playbook[] {
  return [
    {
      id: 'pb_seed_files',
      kind: 'files',
      title: '整理一个目录里的文件',
      goal: '把散落在目录里的文件按类型归好，改动前先给出清单',
      steps: [
        { title: '列出目录内容并分类', effect: 'read', detail: '按扩展名 / 用途分组，先不动文件' },
        { title: '给出重命名与移动方案', effect: 'read', detail: '方案要具体到每个文件的新名字与新位置' },
        {
          title: '确认后执行重命名与移动',
          effect: 'write',
          scope: ['<要整理的目录>'],
          detail: '只动方案里列出的文件，不做方案外的整理'
        },
        { title: '记录一份变更摘要', effect: 'write', scope: ['<变更记录成果>'], detail: '改了什么、为什么改' }
      ],
      io: { inputs: ['要整理的目录'], outputs: ['变更清单与变更摘要成果'] },
      spaceId: null,
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      runs: 0,
      seeded: true
    },
    {
      id: 'pb_seed_digest',
      kind: 'digest',
      title: '把几份材料汇总成一份',
      goal: '把选定的资料汇总成一份带出处的说明',
      steps: [
        { title: '读选定的资料', effect: 'read', scope: ['<选定的资料来源>'], detail: '读当前版本，记下版本号' },
        { title: '按主题摘录', effect: 'read', detail: '每条摘录都标回来源与位置' },
        {
          title: '写一份汇总成果',
          effect: 'write',
          scope: ['<汇总成果>'],
          detail: '说法不一致的地方并排保留，不合并结论'
        }
      ],
      io: { inputs: ['资料库里的若干来源'], outputs: ['一份带出处的汇总成果'] },
      spaceId: null,
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      runs: 0,
      seeded: true
    },
    {
      id: 'pb_seed_rewrite',
      kind: 'rewrite',
      title: '按目标改写一段内容',
      goal: '把一段内容改写成指定语气 / 长度，保留原意',
      steps: [
        { title: '读原文', effect: 'read', scope: ['<要改写的成果>'], detail: '记住当前版本，改写基于这一版' },
        {
          title: '改写并开新版本',
          effect: 'write',
          scope: ['<要改写的成果>'],
          detail: '开新版本而不是覆盖旧版本；改动之外的地方不要顺手改'
        }
      ],
      io: { inputs: ['一份成果与改写目标'], outputs: ['同一份成果的新版本'] },
      spaceId: null,
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      runs: 0,
      seeded: true
    }
  ]
}

/** 把起步模板与落盘的模板合起来（同 id 以落盘的为准）。 */
export function withSeedPlaybooks(doc: PlaybookDocument, now: number): Playbook[] {
  const stored = new Map(doc.playbooks.map((p) => [p.id, p]))
  const out: Playbook[] = []
  for (const seed of seedPlaybooks(now)) {
    out.push(stored.get(seed.id) ?? seed)
    stored.delete(seed.id)
  }
  for (const pb of stored.values()) out.push(pb)
  return out
}
