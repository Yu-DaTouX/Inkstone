/**
 * 跨会话交接：计数、资格与交接包契约（实施-05 S5a）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 「一个非常大的任务」迟早会超出单个会话：上下文被压了又压，直到某一次压缩之后
 * 模型已经看不见足够的历史。§7 定的口径是 ——
 *
 *   **同一个片段里成功自动完整压缩累计到 2 次，下一次正常策略压缩需求优先尝试新会话续接。**
 *
 * 所以这一层干三件事（都是纯逻辑，能单测、也能被宿主与界面共用）：
 *   ① **数得准**：只数「成功 + 自动」的完整压缩，手动 / 失败 / 取消 / 工具清扫一律不计；
 *      同一份压缩记录重复到达（`state` 推送会重放 `lastCompaction`）用稳定键去重；
 *      计数按**片段**持久化，重启不归零 —— 否则重启一次就能躲开阈值。
 *   ② **判得清**：够数之后还要看「现在该不该交接」（目标还在推进、自主档、没有后台工作）。
 *      任何一个条件不成立都要给出**可读的原因**（排障与界面都要用它）。
 *   ③ **交接包的形状**：由**模型**写（用户 2026-09-19 拍板），宿主只负责给提示与**校验** ——
 *      模型自评不能替代字段校验（与就绪提交同一个立场）。
 *
 * ── 为什么「自动」包括砚自己发起的那次 ──
 *   砚按工作集调用 `compact()` 时，pi 报 `reason: 'manual'`（对 pi 而言确实是外部让它压的），
 *   但发起方是砚自己知道的（`triggeredBy: 'policy'`）。§7 要数的是「自动完整压缩」，
 *   所以判定是 `status === 'completed' && (triggeredBy === 'policy' || reason 是 pi 的原生自动原因)`。
 *   用户手点「压缩上下文」既没有 `triggeredBy`、也不是原生自动原因，因而不计。
 *
 * ── 这一层**不做**什么 ──
 *   不创建目的会话、不碰执行租约、不发 resume —— 那是事务状态机（S5b）的活。
 *   这里只回答「够不够数、该不该交接、交接包长什么样」。
 */

import type { CompactionRun } from './ipc'
import { isActiveGoalPhase, type GoalState } from './goal'
import type { HandoffStage } from './handoff-transaction'
import type { HandoffEvent } from './handoff-diagnostics'

/** 同一片段里成功自动完整压缩到这个数，下一次正常压缩需求优先尝试交接（§7）。 */
export const HANDOFF_AUTO_COMPACT_THRESHOLD = 2

/**
 * 写交接包这一次 completion 的输出上限（tokens）。
 *
 * §8 建议交接包 4k–8k tokens —— 那是**交接包本身**的目标区间，不是模型一次要吐的字数：
 * 这里只让它写 JSON 里的那几栏文本，2000 足够，超了说明它在写小作文（那部分会被清洗截断）。
 */
export const HANDOFF_PACKAGE_MAX_TOKENS = 2_000

/** 去重键最多留多少个（防无界；超了丢最旧的）。 */
export const HANDOFF_TALLY_KEY_LIMIT = 50

/** 一个交接片段（segment）的压缩计数。交接成功后 `segmentId` 换新、计数从零开始。 */
export interface HandoffTally {
  /** 片段标识。S5a 里恒为 `initial`；S5b 的移交会给新片段一个新 id。 */
  segmentId: string
  /** 本片段内**成功自动完整压缩**的次数。 */
  count: number
  /** 已计数的稳定键（去重，同时是「重启不重算」的凭据）。 */
  keys: string[]
  updatedAt: number
}

export function emptyTally(now = 0): HandoffTally {
  return { segmentId: 'initial', count: 0, keys: [], updatedAt: now }
}

/**
 * 一份压缩记录的**稳定去重键**。
 *
 * 为什么需要它：`state` 推送会把 `lastCompaction` 一遍遍重放（每次刷新用量、每次
 * 流起停都推一次 state）。没有稳定键，一次压缩会被数成几十次。
 * 优先用 pi 给的摘要条目 id（durable 路径唯一），否则用「起止时间 + 原因」合成 ——
 * 同一份记录在重放里这几个字段不会变。
 */
export function compactionKeyOf(run: CompactionRun | null | undefined): string | null {
  if (!run || typeof run !== 'object') return null
  if (typeof run.entryId === 'string' && run.entryId.trim()) return `entry:${run.entryId.trim()}`
  const started = Number.isFinite(run.startedAt) ? run.startedAt : 0
  const ended = Number.isFinite(run.endedAt) ? run.endedAt : 0
  const reason = run.reason ?? run.reasonRaw ?? 'unknown'
  if (!started && !ended) return null
  return `t:${started}-${ended}:${reason}`
}

/**
 * 这一次压缩算不算「成功自动完整压缩」（§7 的计入规则）。
 *
 * 不计的四类：手动点的那次、失败、取消、被拒（declined）。
 * 砚自己发起（`triggeredBy: 'policy'`）与 pi 原生自动（`threshold` / `overflow`）都算。
 */
export function isCountableCompaction(run: CompactionRun | null | undefined): boolean {
  if (!run || typeof run !== 'object') return false
  if (run.status !== 'completed') return false
  if (run.triggeredBy === 'policy') return true
  return run.reason === 'threshold' || run.reason === 'overflow'
}

/**
 * 把一份压缩记录并进计数。
 *
 * 幂等：键已经记过就原样返回（`counted: false` + `reason: 'duplicate'`）。
 * 计数在到达阈值后**继续累加**（不封顶）—— 界面与排障需要看到「到底压了几次」，
 * 阈值只在资格判定里用。
 */
export function applyCompactionTally(
  tally: HandoffTally,
  run: CompactionRun | null | undefined,
  now = 0
): { tally: HandoffTally; counted: boolean; reason: string } {
  if (!isCountableCompaction(run)) {
    const why = run?.status === 'completed' ? 'manual-or-unknown' : (run?.status ?? 'no-record')
    return { tally, counted: false, reason: why }
  }
  const key = compactionKeyOf(run)
  if (!key) return { tally, counted: false, reason: 'no-stable-key' }
  if (tally.keys.includes(key)) return { tally, counted: false, reason: 'duplicate' }
  const keys = [...tally.keys, key].slice(-HANDOFF_TALLY_KEY_LIMIT)
  return {
    tally: { ...tally, count: tally.count + 1, keys, updatedAt: now },
    counted: true,
    reason: 'counted'
  }
}

/** 交接成功之后，新片段从零开始数（§7）。`keys` 一并丢掉是对的 —— 那些压缩属于上一个片段。 */
export function resetTallyForNewSegment(segmentId: string, now = 0): HandoffTally {
  const id = typeof segmentId === 'string' && segmentId.trim() ? segmentId.trim() : 'initial'
  return { segmentId: id, count: 0, keys: [], updatedAt: now }
}

export type HandoffRejectReason =
  | 'below-threshold'
  | 'no-goal'
  | 'goal-not-active'
  | 'not-autonomous'
  | 'busy'

export interface HandoffEligibility {
  eligible: boolean
  /** 不可交接时的原因（可读，界面与诊断都用它） */
  reason: HandoffRejectReason | 'eligible'
  /** 计数值（界面显示「已压 2 次」）；无论是否 eligible 都回。 */
  count: number
  threshold: number
}

/**
 * 该不该开始一次交接。
 *
 * 四个条件（§7 / §8）：够数、有在推进的目标、当前是**自主档**、没有后台工作。
 * 「有未完成子代理 / 长命令先等待，不遗弃后台工作」就落在 `busy` 这一条上。
 */
export function handoffEligibility(input: {
  tally: HandoffTally
  goal: GoalState | null | undefined
  mode: string
  busy: boolean
  /** 阈值覆盖（默认 `HANDOFF_AUTO_COMPACT_THRESHOLD`；测试通道用它把门槛压到 0） */
  threshold?: number
}): HandoffEligibility {
  const threshold =
    Number.isFinite(input.threshold) && (input.threshold as number) >= 0
      ? Math.floor(input.threshold as number)
      : HANDOFF_AUTO_COMPACT_THRESHOLD
  const count = Math.max(0, Math.floor(input.tally?.count ?? 0))
  const base = { count, threshold }
  if (count < threshold) {
    return { ...base, eligible: false, reason: 'below-threshold' }
  }
  const goal = input.goal
  if (!goal || goal.revision <= 0) return { ...base, eligible: false, reason: 'no-goal' }
  if (!isActiveGoalPhase(goal.phase)) return { ...base, eligible: false, reason: 'goal-not-active' }
  if (input.mode !== 'autonomous') return { ...base, eligible: false, reason: 'not-autonomous' }
  if (input.busy) return { ...base, eligible: false, reason: 'busy' }
  return { ...base, eligible: true, reason: 'eligible' }
}

/* ------------------------------------------------------------ 交接包契约 */

/**
 * 交接包（§8）。**由模型写**（用户 2026-09-19 拍板），宿主只校验形状与来源字段。
 *
 * `source*` / `generatedAt` 由宿主填（模型不能自称来源），模型只填内容那几栏。
 */
export interface HandoffPackage {
  /** 用户目标与最近补充（一句话，尽量引用原话） */
  goal: string
  /** 交付物 */
  deliverable: string
  /** 约束与授权（不许把未授权的扩大写成授权） */
  constraints: string[]
  /** 验收标准 */
  acceptance: string[]
  /** 已完成的证据（命令输出 / 文件 / 测试结果） */
  done: string[]
  /** 未完成与失败原因 */
  remaining: string[]
  /** 下一步动作 */
  nextActions: string[]
  /** 阻塞（没有就空数组） */
  blockers: string[]
  /** 涉及的文件 */
  files: string[]
  /** 别的要说的话（长进程、外部状态……） */
  notes: string[]
  /** 来源会话（宿主填） */
  sourceSession: string
  /** 截取时的会话水位（宿主填；缺省 null 表示没拿到） */
  sourceHead: string | null
  /** 生成时的模式 / 模型（宿主填） */
  mode: string
  model: string | null
  generatedAt: number
  generator: 'model'
}

/** 模型必须给出的内容栏（缺一栏就整包不可用 —— 交接包宁可重做，不要半份）。 */
const REQUIRED_TEXT_FIELDS = ['goal', 'deliverable'] as const

const LIST_FIELDS = [
  'constraints',
  'acceptance',
  'done',
  'remaining',
  'nextActions',
  'blockers',
  'files',
  'notes'
] as const

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 列表字段的宽容读法：数组、逗号 / 换行分隔的字符串都接受。
 *
 * 为什么要宽容：模型常把单元素列表写成裸字符串（`"acceptance": "点一下能下载"`）。
 * 因为这一个形状就丢掉整份交接包不值得 —— 与 `goal.ts` 的 `asList` 同一口径。
 */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).slice(0, 40)
  const single = text(value)
  if (!single) return []
  return single
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 40)
}

/**
 * 把模型输出清洗成交接包。
 *
 * 三道校验：两栏必填非空、列表形状合法、**来源字段由调用方覆盖**（模型给的一律丢弃）。
 * 返回 `null` 表示这份输出不能用 —— 宿主据此重来一次或降级，不把半份包写进事务。
 */
export function sanitizeHandoffPackage(
  raw: unknown,
  source: { sourceSession: string; sourceHead: string | null; mode: string; model: string | null; now?: number }
): HandoffPackage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!text(item[field])) return null
  }
  const out: HandoffPackage = {
    goal: text(item.goal),
    deliverable: text(item.deliverable),
    constraints: [],
    acceptance: [],
    done: [],
    remaining: [],
    nextActions: [],
    blockers: [],
    files: [],
    notes: [],
    sourceSession: source.sourceSession,
    sourceHead: source.sourceHead ?? null,
    mode: source.mode,
    model: source.model ?? null,
    generatedAt: source.now ?? Date.now(),
    generator: 'model'
  }
  for (const field of LIST_FIELDS) out[field] = list(item[field])
  return out
}

/** 给模型的提示（一次额外调用，只回 JSON）。 */
export function renderHandoffPrompt(input: {
  goal: GoalState | null | undefined
  cwd: string
  recentUser: string[]
  extra?: string
}): string {
  const goal = input.goal
  const steps = (goal?.steps ?? [])
    .map((step) => `- [${step.status === 'done' ? 'x' : step.status === 'blocked' ? '!' : ' '}] ${step.title}`)
    .join('\n')
  const evidence = (goal?.evidence ?? []).map((item) => `- ${item}`).join('\n')
  const recent = input.recentUser.map((item, index) => `${index + 1}. ${item}`).join('\n')
  return [
    '你正在为一次**跨会话交接**写交接包：当前会话马上要换一个新会话继续干，接手的是同一个模型但没有这段对话的记忆。',
    '只输出一个 JSON 对象，不要围栏、不要解释。字段：',
    '{',
    '  "goal": "用户目标（尽量用用户原话）",',
    '  "deliverable": "交付物",',
    '  "constraints": ["约束与授权"], "acceptance": ["验收标准"],',
    '  "done": ["已经完成并有证据的事"], "remaining": ["未完成 / 失败与原因"],',
    '  "nextActions": ["接手后先做什么"], "blockers": [], "files": ["涉及的文件（相对路径）"], "notes": []',
    '}',
    '规则：只写**事实**；不要把没做过的写成已完成；不要复制密钥或凭证；',
    '约束里不要扩大用户给的授权；没有把握的写进 notes，不要编造。',
    `工作目录：${input.cwd}`,
    steps ? `已登记步骤：\n${steps}` : '（还没登记步骤）',
    evidence ? `已有证据：\n${evidence}` : '',
    recent ? `最近的用户消息（由旧到新）：\n${recent}` : '',
    input.extra ?? ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** 一行摘要（界面 / 日志）。 */
export function handoffSummary(pkg: HandoffPackage | null): string {
  if (!pkg) return '没有交接包'
  const parts = [pkg.goal.slice(0, 40)]
  if (pkg.remaining.length) parts.push(`未完成 ${pkg.remaining.length} 项`)
  if (pkg.nextActions.length) parts.push(`下一步 ${pkg.nextActions[0].slice(0, 30)}`)
  if (pkg.blockers.length) parts.push(`阻塞 ${pkg.blockers.length} 项`)
  return parts.join(' · ')
}

/* ------------------------------------------------------------ 生成链路（S5b-2） */

/**
 * 写交接包时的 system prompt。
 *
 * 为什么要单独一条：提示词主体（`renderHandoffPrompt`）每轮都不同，
 * 而这一句是稳定文本 —— 放在 system 里对上游缓存友好，也把「只回 JSON」
 * 这条约束放在模型最不会忘的位置。
 */
export const HANDOFF_SYSTEM_PROMPT =
  '你是同一条工程线上下一次会话的接棒者。只输出一个 JSON 对象，不要围栏、不要解释、不要复述任务背景。'

/**
 * 宿主写给薄层的「请写一份交接包」请求（`YAN_DIR/handoff-request/<runnerId>.json`）。
 *
 * 分工的要点：**提示词在宿主侧渲染**（`renderHandoffPrompt` 是 TS，扩展用不了它），
 * 薄层只做唯一一件 RPC 做不到的事 —— 调一次 completion（§16.1 / S5a 的分工）。
 * 这样提示词、字段表、校验口径都只有一份真源，扩展改不动交接包的内容口径。
 */
export interface HandoffRequest {
  /** 本次交接的稳定 id（事务日志用它串起来；结果文件必须回同一个） */
  handoffId: string
  /** 幂等键：同一次交接只生成一次（消费证据与结果文件都靠它判重） */
  operationId: string
  /** 会话文件路径（宿主侧的键） */
  sessionKey: string
  /** 已渲染好的提示词（user 消息正文） */
  prompt: string
  /** system prompt（稳定文本） */
  systemPrompt: string
  maxTokens: number
  /** 截取时的会话水位（写进交接包的 `sourceHead`） */
  sourceHead: string | null
  /** 写请求时的模式 / 模型（写进交接包 —— 模型不能自报来源） */
  mode: string
  model: string | null
  createdAt: number
}

function longText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 读请求文件时的清洗。两个 id 与提示词缺一不可（缺了就让这次生成作废，不猜）。 */
export function sanitizeHandoffRequest(raw: unknown): HandoffRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const handoffId = longText(item.handoffId)
  const operationId = longText(item.operationId)
  const prompt = longText(item.prompt)
  if (!handoffId || !operationId || !prompt) return null
  const maxTokens =
    typeof item.maxTokens === 'number' && Number.isFinite(item.maxTokens) && item.maxTokens > 0
      ? Math.min(8_000, Math.floor(item.maxTokens))
      : HANDOFF_PACKAGE_MAX_TOKENS
  return {
    handoffId,
    operationId,
    sessionKey: longText(item.sessionKey),
    prompt,
    systemPrompt: longText(item.systemPrompt) || HANDOFF_SYSTEM_PROMPT,
    maxTokens,
    sourceHead: typeof item.sourceHead === 'string' && item.sourceHead ? item.sourceHead : null,
    mode: longText(item.mode) || 'unknown',
    model: typeof item.model === 'string' && item.model ? item.model : null,
    createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
  }
}

/** 薄层写回来的生成结果（`YAN_DIR/handoff-result/<runnerId>.json`）。 */
export interface HandoffResult {
  handoffId: string
  operationId: string
  /** 模型的原始输出（宿主负责解析与校验 —— 扩展判断不了字段对不对） */
  text: string
  /** 失败原因（成功时空） */
  error: string | null
  /** 这一次 completion 花了多久（诊断用） */
  ms: number
  at: number
}

/**
 * 读结果文件的清洗。
 *
 * 允许 `text` 与 `error` 同时为空（模型什么都没回）：那是失败的一种，
 * 但**必须留下结果文件** —— 否则宿主会一直等，分不清「没跑」与「跑了没结果」。
 */
export function sanitizeHandoffResult(raw: unknown): HandoffResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const handoffId = longText(item.handoffId)
  const operationId = longText(item.operationId)
  if (!handoffId || !operationId) return null
  const error = longText(item.error)
  return {
    handoffId,
    operationId,
    text: typeof item.text === 'string' ? item.text : '',
    error: error || null,
    ms: typeof item.ms === 'number' && Number.isFinite(item.ms) ? Math.max(0, Math.floor(item.ms)) : 0,
    at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0
  }
}

/**
 * 从模型输出里抽 JSON 对象。
 *
 * 宽容但**不猜语义**：去围栏、截第一个 `{` 到最后一个 `}`，再交给 `JSON.parse`。
 * 解析失败就是失败（返回 `reason` 供诊断）—— 交接包宁可重做一次，
 * 也不要把半份包写进事务（§8：「失败降级，不静默裁掉」）。
 */
/**
 * 从原文里截出**第一个完整的 JSON 对象**。
 *
 * 为什么不用「第一个 `{` 到最后一个 `}`」：模型偶尔会在末尾再接一段话或再吐一个对象，
 * 那样截出来的是 `{...}{...`，`JSON.parse` 直接失败 —— 明明第一份是好的却被丢掉。
 * 括号平衡扫描器顺便处理字符串里的括号与转义（`"}` 不能当成结束）。
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function parseHandoffOutput(raw: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { ok: false, reason: 'empty' }
  const unfenced = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  const object = firstJsonObject(unfenced)
  if (!object) return { ok: false, reason: 'no-json-object' }
  try {
    const value = JSON.parse(object)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-an-object' }
    return { ok: true, value }
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
}

/**
 * 请求 / 结果文件的文件名（按 runnerId）。
 *
 * 必须与薄层 `goal-resume.js` 的 `safeKey()` **同语义**：那边用 `YAN_SESSION_ID`、
 * 这边用宿主手里的 runnerId，两个值本来就相等；清洗规则不一致会让它们指向不同文件，
 * 表现为「请求写了但薄层永远看不见」—— 单测对这两处做了交叉校验。
 */
export function handoffFileKey(runnerId: unknown): string {
  const key = typeof runnerId === 'string' ? runnerId.trim() : ''
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/**
 * 请求文件的寿命。
 *
 * 薄层会看 `createdAt`：上一轮没跑完的遗物（应用被杀 / 扩展没加载）不该在
 * 半小时后突然冒出来生成一份过期交接包 —— 那时候上下文已经往前走了。
 */
export const HANDOFF_REQUEST_TTL_MS = 30 * 60 * 1_000

/**
 * 交接状态的一次只读快照（`yan:getHandoff`；界面与探针共用）。
 *
 * 为什么要把 `pending` / `threshold` 也带上：探针要能区分
 * 「资格没过」与「过了但薄层没写出结果」——只看 `package` 为 null 是分不清的，
 * 而这两种失败的修法完全不同（前者是资格判定，后者是文件交换 / 扩展没加载）。
 */
export interface HandoffView {
  sessionKey: string
  /** 本片段压了几次（`null` = 没有活动会话） */
  tally: HandoffTally | null
  /**
   * **当前片段**的压缩计数（实施-14 F5）。
   *
   * 与 `tally` 区分开：那个按链首取（历史口径，用来回答「这条会话一共交接/压缩过多少」），
   * 而交接阈值看的是**本片段**又压了几次。两者混用会让用户在交接之后
   * 看到一个永远不再增长（或被重置）的数字。
   */
  segmentTally: HandoffTally | null
  /** 链上共有几段（1 = 没交接过的单文件） */
  chainSegments: number
  /**
   * 最近一次生成的交接包（`null` = 还没生成过）
   */
  package: HandoffPackage | null
  /** 这一次是否正在等待薄层写包 */
  pending: boolean
  /** 当前生效的阈值（可能被测试通道覆盖） */
  threshold: number
  /**
   * 当前会话相关的交接事务（实施-05 S5b-3b；`null` = 没有）。
   *
   * 只读给探针与界面用：事务一旦停在 `committed`（resume 发出但没拿到证据），
   * 外面完全看不出区别 —— 只看 `package` 有没有是判不了「交接到哪一步」的。
   */
  transaction: {
    handoffId: string
    stage: HandoffStage
    destinationSession: string | null
    /**
     * 续接回执（实施-15 A-3）：已投递（`persistedAt`）与已运行（`startedAt`）分开。
     *
     * 为什么要分开给界面：`stage==='resumed'` 只说明**已投递**（标记是本地写的），
     * 界面不能据此说「目的运行已启动」；`startedAt` 只在续接扩展为同一 operationId
     * 写下 `before_provider_request` 回执后才填写。
     */
    receipts: { sentAt?: number; persistedAt?: number; startedAt?: number }
    /**
     * 最近几步转移（旧→新，最多 4 条）。
     *
     * 给恢复视图用：用户/探针能回答「最后**确认**到哪一步了」——
     * 只看 `stage` 区分不出「已提交但续接还没发」与「已发但没证据」。
     */
    steps: { at: number; from: HandoffStage; to: HandoffStage; detail?: string }[]
    /** 已尝试发送续接的次数（≥2 = 已重发过一次仍无证据，需人工判断）。 */
    resumeAttempts: number
  } | null
  /**
   * 最近的阶段诊断事件（实施-14 F0，由旧到新）。
   *
   * 它的存在就是为了回答「为什么什么都没发生」：资格没过（`eligibility:rejected`）、
   * 请求没写成功、结果对不上、提交停在哪个阶段、resume 有没有拿到证据。
   * 只看 `tally` / `package` 区分不出这几种，而它们的修法完全不同。
   */
  events: HandoffEvent[]
  /** 自动交接开关是否打开（**默认开**；`YAN_HANDOFF_COMMIT=0` 显式关闭） */
  autoCommit: boolean
}

/**
 * 自动交接开关的解析（实施-05 S6）。
 *
 * 2026-09-19 用户拍板：**默认打开**。§7 原先的「先完成真实长任务验证再开默认值」
 * 前置已经满足 —— `handoffcommit`（cost 1）跑通了真实链路，崩溃恢复有单测全矩阵
 * 与磁盘核对，会话链 / 消费证据都取到过证据。
 *
 * 显式关闭：`YAN_HANDOFF_COMMIT=0`（`false` / `off` / `no` 同样认）—— 给回归与
 * 排查留一个不用改代码的出口，与其它测试通道同一口径。
 *
 * ⚠️ 「打开」只是**允许**交接：实际发生仍要过 §7 四条资格
 * （够数 / 目标在推进 / 自主档 / 不忙），所以标准档会话不会被它带走。
 */
export function handoffCommitEnabled(env?: Record<string, string | undefined> | null): boolean {
  const raw = String(env?.YAN_HANDOFF_COMMIT ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return true
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}
