/**
 * 持续关注与提醒（follow）的**契约层 + 纯逻辑**（实施-25 P16）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件解决什么
 * ══════════════════════════════════════════════════════════════════
 * 「能让 agent 隔一段时间跟进一件事，并在空间里看到变化」。
 * 一次「关注」记四件事（T16-1）：**关注什么 / 多久看一次 / 结果放哪 / 什么时候提醒**。
 *
 * ── 四条边界（比功能更重要）──
 *  ① **随应用运行，不装系统级定时任务**。应用没开就不跟进 —— 所以
 *     **不能写「已跟进」**：`followAppOnlyNote()` 就是把这句话钉在界面上与数据里。
 *     状态里只有 `lastCheckedAt`（上次真的看过）与 `nextDueAt`（下次该看），
 *     没有「正在后台跑」这种字段。
 *  ② **用户没启用的关注不自行建立**。模型可以**提议**（`enabled: false` 存下来），
 *     但只有用户点过启用才会出现在「到点了」里（T16-3）。
 *  ③ **不自动代学**：复习类关注只提示，不做「自动开始学习」这件事（T16-4）——
 *     复盘与挑题仍然走 P12 的 `planToday`，这里只读它。
 *  ④ **通知以变化 / 完成 / 需要决定为主**（T16-5）：`no-change` 不打扰，
 *     它只留在运行记录里（用户主动看时能看到「那天确实看过，没变化」）。
 *
 * 它不碰 electron / pi / 文件系统，所以主进程与单测共用同一份规则。
 */

/** 关注的两类节奏：看一次 / 每隔一段时间看一次。 */
export const FOLLOW_CADENCES = ['once', 'interval'] as const
export type FollowCadence = (typeof FOLLOW_CADENCES)[number]

/** 一次跟进的结局（决定要不要打扰用户）。 */
export const FOLLOW_OUTCOMES = ['no-change', 'changed', 'needs-decision', 'failed'] as const
export type FollowOutcome = (typeof FOLLOW_OUTCOMES)[number]

export const FOLLOW_OUTCOME_LABELS: Record<FollowOutcome, string> = {
  'no-change': '没有变化',
  changed: '有变化',
  'needs-decision': '需要你定',
  failed: '这次没看成'
}

/** 关注什么类型的事（只影响展示与默认文案）。 */
export const FOLLOW_KINDS = ['sources', 'files', 'review', 'custom'] as const
export type FollowKind = (typeof FOLLOW_KINDS)[number]

export const FOLLOW_KIND_LABELS: Record<FollowKind, string> = {
  sources: '资料有没有更新',
  files: '文件有没有变化',
  review: '该复习的内容',
  custom: '别的事'
}

export const FOLLOW_LIMITS = {
  maxWatches: 200,
  /** 单个关注最多留多少条运行记录（老的先丢）。 */
  maxRunsPerWatch: 50,
  maxTitle: 120,
  maxText: 2000,
  maxList: 20,
  /** 最短间隔：太短就等于「一直跑」，那不是关注。 */
  minIntervalMinutes: 30,
  /** 最长间隔：一年。 */
  maxIntervalMinutes: 525_600
} as const

export interface Watch {
  id: string
  /** 关注什么（一句话，给人看也给模型看）。 */
  title: string
  kind: FollowKind
  /** 空间归属（null = 不挑空间）；概览按空间显示。 */
  spaceId: string | null
  cadence: FollowCadence
  /** `cadence === 'interval'` 时的间隔（分钟）。 */
  intervalMinutes?: number
  /** 结果放哪（例如「写进成果：XX」「只在空间概览里记一笔」）。 */
  resultPlace: string
  /** 提醒条件（默认只在有变化或需要决定时提醒）。 */
  notifyOn: 'change' | 'decision' | 'always'
  /** **用户没启用就不会自动出现在「到点了」里**（T16-3）。 */
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 上次真的看过的时间（没看过就是 undefined —— 不写「已跟进」）。 */
  lastCheckedAt?: number
  /** 下次该看的时间；一次性关注做完就为 undefined。 */
  nextDueAt?: number
  /** 最近一次运行的结局（列表上显示）。 */
  lastOutcome?: FollowOutcome
  /** 是谁提出来的：模型提议 / 用户自己建。 */
  origin: 'user' | 'agent'
}

/** 一次跟进的记录（T16-2 的「变化摘要」与「运行记录」）。 */
export interface FollowRun {
  id: string
  watchId: string
  at: number
  outcome: FollowOutcome
  /** 一句话说明这次看到了什么。 */
  summary: string
  /** 具体变化（列表，可能为空）。 */
  changed: string[]
  /** 需要用户决定的事（列表，可能为空）。 */
  decisions: string[]
}

export interface FollowDocument {
  version: number
  watches: Watch[]
  runs: FollowRun[]
}

export function emptyFollowDocument(): FollowDocument {
  return { version: 1, watches: [], runs: [] }
}

/* ══════════════════════════════════════════════════════════════════
 * 一、节奏与到点（纯计算）
 * ══════════════════════════════════════════════════════════════════ */

/** 把间隔说成人话（界面上不显示裸数字）。 */
export function describeCadence(watch: Pick<Watch, 'cadence' | 'intervalMinutes'>): string {
  if (watch.cadence === 'once') return '看一次就好'
  const minutes = watch.intervalMinutes ?? 0
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天看一次`
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时看一次`
  return `每 ${minutes} 分钟看一次`
}

/**
 * 下一次该看的时间。
 *
 * `once` 没有下一次（一次性的关注做完就结束）—— 返回 `undefined` 而不是
 * 把 `nextDueAt` 推到无穷，免得列表上永远挂着一条「待办」。
 */
export function nextDueAfter(watch: Pick<Watch, 'cadence' | 'intervalMinutes'>, from: number): number | undefined {
  if (watch.cadence === 'once') return undefined
  const minutes = watch.intervalMinutes ?? 0
  if (minutes < FOLLOW_LIMITS.minIntervalMinutes) return undefined
  return from + minutes * 60_000
}

/**
 * 到点了该看的关注。
 *
 * **只数用户启用过的**（T16-3）：模型提议但用户没启用的不在这里出现。
 * 顺序按到期时间由早到晚 —— 界面上先看最该看的。
 */
export function dueWatches(watches: readonly Watch[], now: number): Watch[] {
  return watches
    .filter((watch) => watch.enabled)
    .filter((watch) => {
      if (watch.cadence === 'once') {
        /* 一次性的：没看过就一直是「该看」；看过就不再出现 */
        return watch.lastCheckedAt === undefined
      }
      return watch.nextDueAt !== undefined && watch.nextDueAt <= now
    })
    /*
     * 一次性关注没有 `nextDueAt`，用它的创建时间当排序键：
     * 否则它会被当成 0 永远插在最前面，把真到期的周期性关注挤下去。
     */
    .sort((a, b) => (a.nextDueAt ?? a.createdAt) - (b.nextDueAt ?? b.createdAt) || a.createdAt - b.createdAt)
}

/** 是不是「已经看过、还在等下次」的状态（界面上写「下次 X」）。 */
export function waitingFor(watch: Watch, now: number): boolean {
  if (!watch.enabled) return false
  if (watch.cadence === 'once') return watch.lastCheckedAt !== undefined
  return watch.nextDueAt !== undefined && watch.nextDueAt > now
}

/* ══════════════════════════════════════════════════════════════════
 * 二、提醒规则（T16-5）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 这次运行要不要提醒用户。
 *
 * 「没有变化」默认不打扰（`no-change` 只在运行记录里），
 * 因为它没有新信息 —— 每次都提醒等于把关注变成噪音。
 */
export function shouldNotify(outcome: FollowOutcome, notifyOn: Watch['notifyOn']): boolean {
  if (notifyOn === 'always') return true
  if (outcome === 'no-change') return false
  if (outcome === 'failed') return true
  if (notifyOn === 'decision') return outcome === 'needs-decision'
  /* 'change'（默认）：有变化或有错都提醒；需要决定当然也提醒 */
  return outcome === 'changed' || outcome === 'needs-decision'
}

/** 一句话说明这次运行（列表 / 记录里都用它）。 */
export function runSummaryText(run: FollowRun): string {
  const head = FOLLOW_OUTCOME_LABELS[run.outcome]
  const detail = run.summary.trim()
  const extra = run.decisions.length > 0 ? `（等你定：${run.decisions.join('、')}）` : ''
  return detail ? `${head}：${detail}${extra}` : `${head}${extra}`
}

/** 关注卡上的一行状态。 */
export function watchStatusText(watch: Watch, now: number): string {
  if (!watch.enabled) return '还没启用（你点一下才会开始看）'
  if (watch.cadence === 'once') {
    return watch.lastCheckedAt ? '看过了（一次性关注）' : '还没看过'
  }
  if (watch.nextDueAt !== undefined && watch.nextDueAt <= now) return '到点了'
  return `下次 ${formatWhen(watch.nextDueAt)}`
}

export function formatWhen(at?: number): string {
  if (!at) return '时间未知'
  try {
    return new Date(at).toLocaleString()
  } catch {
    return '时间未知'
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 三、把「应用没开就不跟进」写进文案（验收那条）
 * ══════════════════════════════════════════════════════════════════ */

/** 创建 / 启用时必须告知的一句话（T16-3 与验收共用）。 */
export const FOLLOW_APP_ONLY_NOTE =
  '关注只在砚开着的时候看：应用没开的那段时间不会被跟进，也不会补看漏过的次数。'

export function followAppOnlyNote(): string {
  return FOLLOW_APP_ONLY_NOTE
}

/** 概览卡上的说明（把「没开就没跟进」与「不会自动开始学」一次讲清）。 */
export function followScopeText(): string {
  return [
    FOLLOW_APP_ONLY_NOTE,
    '关注只负责提醒与记录：需要做的事仍然由你按发送，复习类关注不会自动开始学习。'
  ].join('\n')
}

/** 未启用时的提示（模型提议过、等用户点）。 */
export function proposedNote(): string {
  return '这是别人替你提的关注，还没启用 —— 你点「开始关注」之后才会出现在到点提醒里。'
}

/* ══════════════════════════════════════════════════════════════════
 * 四、输入校验与创建（严格：新写入用）
 * ══════════════════════════════════════════════════════════════════ */

export type FollowErrorCode =
  | 'bad_title'
  | 'title_too_long'
  | 'bad_kind'
  | 'bad_cadence'
  | 'bad_interval'
  | 'bad_result_place'
  | 'bad_notify'
  | 'too_many_watches'
  | 'not_found'

export interface WatchInput {
  title?: unknown
  kind?: unknown
  spaceId?: unknown
  cadence?: unknown
  intervalMinutes?: unknown
  resultPlace?: unknown
  notifyOn?: unknown
  enabled?: unknown
  origin?: unknown
}

function charLength(text: string): number {
  return [...text].length
}

function fail(code: FollowErrorCode, message: string): { ok: false; code: FollowErrorCode; message: string } {
  return { ok: false, code, message }
}

function textOf(value: unknown, code: FollowErrorCode, label: string, required: boolean): string | { ok: false; code: FollowErrorCode; message: string } {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const trimmed = text.trim()
  if (!trimmed) {
    if (required) return fail(code, `${label}不能为空`)
    return ''
  }
  if (charLength(trimmed) > FOLLOW_LIMITS.maxText) {
    return fail(code, `${label}超过 ${FOLLOW_LIMITS.maxText} 字符`)
  }
  return trimmed
}

export function validateWatchInput(
  input: WatchInput
): { ok: true; value: Omit<Watch, 'id' | 'createdAt' | 'updatedAt'> } | { ok: false; code: FollowErrorCode; message: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return fail('bad_title', '关注要写清关注什么（title）')
  if (charLength(title) > FOLLOW_LIMITS.maxTitle) {
    return fail('title_too_long', `标题最长 ${FOLLOW_LIMITS.maxTitle} 字符`)
  }
  const kind = input.kind === undefined || input.kind === null ? 'custom' : input.kind
  if (typeof kind !== 'string' || !FOLLOW_KINDS.includes(kind as FollowKind)) {
    return fail('bad_kind', `kind 必须是 ${FOLLOW_KINDS.join(' / ')} 之一`)
  }
  const cadence = input.cadence === undefined || input.cadence === null ? 'interval' : input.cadence
  if (typeof cadence !== 'string' || !FOLLOW_CADENCES.includes(cadence as FollowCadence)) {
    return fail('bad_cadence', `cadence 必须是 ${FOLLOW_CADENCES.join(' / ')} 之一`)
  }
  let intervalMinutes: number | undefined
  if (cadence === 'interval') {
    const raw = Number(input.intervalMinutes)
    if (!Number.isFinite(raw)) return fail('bad_interval', '隔一段时间看一次的关注要写清间隔（分钟）')
    const rounded = Math.round(raw)
    if (rounded < FOLLOW_LIMITS.minIntervalMinutes || rounded > FOLLOW_LIMITS.maxIntervalMinutes) {
      return fail(
        'bad_interval',
        `间隔要在 ${FOLLOW_LIMITS.minIntervalMinutes} 分钟到 ${Math.round(FOLLOW_LIMITS.maxIntervalMinutes / 1440)} 天之间`
      )
    }
    intervalMinutes = rounded
  }
  const resultPlace = textOf(input.resultPlace, 'bad_result_place', '结果放在哪', true)
  if (typeof resultPlace !== 'string') return resultPlace
  const notifyOn = input.notifyOn === undefined || input.notifyOn === null ? 'change' : input.notifyOn
  if (typeof notifyOn !== 'string' || !['change', 'decision', 'always'].includes(notifyOn)) {
    return fail('bad_notify', 'notifyOn 只能是 change / decision / always')
  }
  return {
    ok: true,
    value: {
      title,
      kind: kind as FollowKind,
      spaceId: typeof input.spaceId === 'string' && input.spaceId.trim() ? input.spaceId.trim() : null,
      cadence: cadence as FollowCadence,
      ...(intervalMinutes ? { intervalMinutes } : {}),
      resultPlace,
      notifyOn: notifyOn as Watch['notifyOn'],
      /* 默认**不启用**：模型提议的关注必须由用户点一下才会真的跑（T16-3） */
      enabled: input.enabled === true,
      origin: input.origin === 'agent' ? 'agent' : 'user'
    }
  }
}

/** 造一个关注（id 与时间由调用方给，便于单测与查重）。 */
export function createWatch(
  input: Omit<Watch, 'id' | 'createdAt' | 'updatedAt'>,
  options: { id: string; now: number }
): Watch {
  return {
    ...input,
    id: options.id,
    createdAt: options.now,
    updatedAt: options.now,
    /* 新建时下一次到期就是「建的时候 + 间隔」；一次性关注没有 nextDueAt */
    ...(input.cadence === 'interval' ? { nextDueAt: nextDueAfter(input, options.now) } : {})
  }
}

/** 改一个关注（启用 / 改节奏 / 改标题…）。 */
export function applyWatchPatch(
  prev: Watch,
  patch: { title?: unknown; cadence?: unknown; intervalMinutes?: unknown; resultPlace?: unknown; notifyOn?: unknown; enabled?: unknown; kind?: unknown },
  now: number
): { ok: true; watch: Watch } | { ok: false; code: FollowErrorCode; message: string } {
  const mergedInput: WatchInput = {
    title: patch.title === undefined ? prev.title : patch.title,
    kind: patch.kind === undefined ? prev.kind : patch.kind,
    spaceId: prev.spaceId,
    cadence: patch.cadence === undefined ? prev.cadence : patch.cadence,
    intervalMinutes: patch.intervalMinutes === undefined ? prev.intervalMinutes : patch.intervalMinutes,
    resultPlace: patch.resultPlace === undefined ? prev.resultPlace : patch.resultPlace,
    notifyOn: patch.notifyOn === undefined ? prev.notifyOn : patch.notifyOn,
    enabled: patch.enabled === undefined ? prev.enabled : patch.enabled,
    origin: prev.origin
  }
  const valid = validateWatchInput(mergedInput)
  if (!valid.ok) return valid
  const cadenceChanged = valid.value.cadence !== prev.cadence || valid.value.intervalMinutes !== prev.intervalMinutes
  return {
    ok: true,
    watch: {
      ...prev,
      ...valid.value,
      updatedAt: now,
      /*
       * 节奏变了就重算下一次到期；只改标题 / 提醒条件不动它 ——
       * 否则用户改个错别字就把「下次什么时候看」推后了。
       */
      nextDueAt: cadenceChanged
        ? valid.value.cadence === 'once'
          ? undefined
          : nextDueAfter(valid.value, now)
        : prev.nextDueAt
    }
  }
}

/**
 * 记一次运行（T16-2）。
 *
 * 只看两件事：`lastCheckedAt` 推进到这次，`nextDueAt` 按节奏往后排。
 * **一次性关注做完就没有下一次** —— 这是「不累积欠账」在关注上的对应规则。
 */
export function applyRunToWatch(
  watch: Watch,
  run: { outcome: FollowOutcome; at: number }
): Watch {
  return {
    ...watch,
    lastCheckedAt: run.at,
    lastOutcome: run.outcome,
    updatedAt: run.at,
    nextDueAt: nextDueAfter(watch, run.at)
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 五、容错读盘与集合操作
 * ══════════════════════════════════════════════════════════════════ */

export function sanitizeWatch(raw: unknown): Watch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  const id = typeof w.id === 'string' && w.id.trim() ? w.id.trim() : ''
  const valid = validateWatchInput({
    title: w.title,
    kind: w.kind,
    spaceId: w.spaceId,
    cadence: w.cadence,
    intervalMinutes: w.intervalMinutes,
    resultPlace: w.resultPlace,
    notifyOn: w.notifyOn,
    enabled: w.enabled,
    origin: w.origin
  })
  /* 校验不过就丢掉这条：一条读不通的关注会一直出现在「到点了」里 */
  if (!id || !valid.ok) return undefined
  const createdAt = Number.isFinite(w.createdAt) ? Number(w.createdAt) : 0
  const updatedAt = Number.isFinite(w.updatedAt) ? Number(w.updatedAt) : createdAt
  const lastCheckedAt = Number.isFinite(w.lastCheckedAt) ? Number(w.lastCheckedAt) : undefined
  const nextDueAt = Number.isFinite(w.nextDueAt) ? Number(w.nextDueAt) : undefined
  const lastOutcome =
    typeof w.lastOutcome === 'string' && (FOLLOW_OUTCOMES as readonly string[]).includes(w.lastOutcome)
      ? (w.lastOutcome as FollowOutcome)
      : undefined
  return {
    ...valid.value,
    id,
    createdAt,
    updatedAt,
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    ...(nextDueAt !== undefined ? { nextDueAt } : {}),
    ...(lastOutcome !== undefined ? { lastOutcome } : {})
  }
}

export function sanitizeRun(raw: unknown): FollowRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : ''
  const watchId = typeof r.watchId === 'string' && r.watchId.trim() ? r.watchId.trim() : ''
  if (!id || !watchId) return undefined
  if (typeof r.outcome !== 'string' || !(FOLLOW_OUTCOMES as readonly string[]).includes(r.outcome)) return undefined
  const list = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (!trimmed || charLength(trimmed) > FOLLOW_LIMITS.maxText) continue
      if (!out.includes(trimmed)) out.push(trimmed)
      if (out.length >= FOLLOW_LIMITS.maxList) break
    }
    return out
  }
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, FOLLOW_LIMITS.maxText) : ''
  return {
    id,
    watchId,
    at: Number.isFinite(r.at) ? Number(r.at) : 0,
    outcome: r.outcome as FollowOutcome,
    summary,
    changed: list(r.changed),
    decisions: list(r.decisions)
  }
}

export function sanitizeFollowDocument(raw: unknown): FollowDocument {
  if (!raw || typeof raw !== 'object') return emptyFollowDocument()
  const box = raw as { watches?: unknown; runs?: unknown }
  const watches: Watch[] = []
  if (Array.isArray(box.watches)) {
    const seen = new Set<string>()
    for (const item of box.watches) {
      const watch = sanitizeWatch(item)
      if (!watch || seen.has(watch.id)) continue
      seen.add(watch.id)
      watches.push(watch)
      if (watches.length >= FOLLOW_LIMITS.maxWatches) break
    }
  }
  const runs: FollowRun[] = []
  if (Array.isArray(box.runs)) {
    const seen = new Set<string>()
    for (const item of box.runs) {
      const run = sanitizeRun(item)
      if (!run || seen.has(run.id)) continue
      seen.add(run.id)
      runs.push(run)
    }
  }
  return { version: 1, watches, runs: pruneRuns(runs) }
}

/** 每个关注只留最近 N 条运行记录（老的先丢）。 */
export function pruneRuns(runs: readonly FollowRun[]): FollowRun[] {
  const byWatch = new Map<string, FollowRun[]>()
  for (const run of runs) {
    const list = byWatch.get(run.watchId)
    if (list) list.push(run)
    else byWatch.set(run.watchId, [run])
  }
  const kept: FollowRun[] = []
  for (const list of byWatch.values()) {
    /* 新的在前，多出来的丢掉 */
    kept.push(...[...list].sort((a, b) => b.at - a.at).slice(0, FOLLOW_LIMITS.maxRunsPerWatch))
  }
  return kept.sort((a, b) => b.at - a.at)
}

export function findWatch(doc: FollowDocument, id: string): Watch | undefined {
  return doc.watches.find((w) => w.id === id)
}

/** 按空间过滤（不挑空间的关注在每个空间都看得到，与办事模板同一约定）。 */
export function watchesForSpace(doc: FollowDocument, spaceId?: string | null): Watch[] {
  if (!spaceId) return [...doc.watches]
  return doc.watches.filter((w) => !w.spaceId || w.spaceId === spaceId)
}

export function upsertWatchIn(doc: FollowDocument, watch: Watch): FollowDocument {
  const index = doc.watches.findIndex((w) => w.id === watch.id)
  if (index < 0) {
    if (doc.watches.length >= FOLLOW_LIMITS.maxWatches) return doc
    return { ...doc, watches: [...doc.watches, watch] }
  }
  const next = [...doc.watches]
  next[index] = watch
  return { ...doc, watches: next }
}

/** 删一个关注：它的运行记录也一起走（记录只对它有意义）。 */
export function removeWatchFrom(doc: FollowDocument, id: string): FollowDocument {
  return {
    ...doc,
    watches: doc.watches.filter((w) => w.id !== id),
    runs: doc.runs.filter((r) => r.watchId !== id)
  }
}

export function removeSpaceWatchesFrom(doc: FollowDocument, spaceId: string): { doc: FollowDocument; removed: number } {
  const kept = doc.watches.filter((w) => w.spaceId !== spaceId)
  const removed = doc.watches.length - kept.length
  const keptIds = new Set(kept.map((w) => w.id))
  return {
    doc: { watches: kept, runs: doc.runs.filter((r) => keptIds.has(r.watchId)), version: 1 },
    removed
  }
}

/** 某个关注的运行记录（新的在前）。 */
export function runsForWatch(doc: FollowDocument, watchId: string, limit = 10): FollowRun[] {
  return doc.runs
    .filter((r) => r.watchId === watchId)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
}

/* ══════════════════════════════════════════════════════════════════
 * 六、给模型看的说明
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 交给模型的正文：把「该看什么」摊开。
 *
 * 与 P14 同一思路：宿主不替模型执行 —— 它只说清这次要看什么、
 * 结果该记到哪里，真正去看还是模型（在用户按下发送之后）。
 */
export function watchBriefText(watch: Watch, runs: readonly FollowRun[]): string {
  const lines = [`按这个关注看一遍：${watch.title}`, `关注类型：${FOLLOW_KIND_LABELS[watch.kind]}`, `节奏：${describeCadence(watch)}`]
  lines.push(`上次看：${watch.lastCheckedAt ? formatWhen(watch.lastCheckedAt) : '还没看过'}`)
  lines.push(`结果记到：${watch.resultPlace}`)
  if (runs.length > 0) {
    lines.push('上次的结果：')
    for (const run of runs.slice(0, 3)) lines.push(`- ${formatWhen(run.at)} ${runSummaryText(run)}`)
  }
  lines.push('', FOLLOW_APP_ONLY_NOTE)
  lines.push('看完请回报：这次是「没有变化 / 有变化 / 需要我定 / 没看成」，以及具体变了什么。')
  lines.push('每类关注看什么、怎么回报见 `follow` 技能（`yan skill read --id skill:follow`）。')
  return lines.join('\n')
}

/** 概览卡上的一条关注（合给界面用）。 */
export interface WatchView {
  watch: Watch
  status: string
  /** 这是个模型提议、还没启用的关注。 */
  proposed: boolean
  lastRun?: FollowRun
}

export function watchViews(doc: FollowDocument, spaceId: string | null | undefined, now: number, limit = 12): WatchView[] {
  return watchesForSpace(doc, spaceId)
    .sort((a, b) => {
      /* 到点的排前面，然后按更新时间 */
      const aDue = a.enabled && (a.cadence === 'once' ? a.lastCheckedAt === undefined : (a.nextDueAt ?? Infinity) <= now)
      const bDue = b.enabled && (b.cadence === 'once' ? b.lastCheckedAt === undefined : (b.nextDueAt ?? Infinity) <= now)
      if (aDue !== bDue) return aDue ? -1 : 1
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
    .slice(0, limit)
    .map((watch) => {
      const [lastRun] = runsForWatch(doc, watch.id, 1)
      return {
        watch,
        status: watchStatusText(watch, now),
        proposed: !watch.enabled && watch.origin === 'agent',
        ...(lastRun ? { lastRun } : {})
      }
    })
}
