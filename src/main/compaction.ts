/**
 * 读 pi 的**压缩设置**，用来在界面上说明「什么时候会自动压缩上下文」。
 *
 * ── 为什么要读 pi 的文件，而不是写死 16384 ──
 * 阈值是用户可配的（`<pi 目录>/settings.json` 或 `<项目>/.pi/settings.json` 里的
 * `compaction.reserveTokens`）。界面上显示一个和实际生效值不符的数字，比不显示更糟 ——
 * 用户会据此判断「还能聊多久」，而这是个会让他丢掉上下文的决定。
 *
 * 事实来源（已核实，见 pi 的 docs/compaction.md 与 bundle 里的
 * `DEFAULT_COMPACTION_SETTINGS`）：
 *
 *     触发条件：contextTokens > contextWindow - reserveTokens
 *     默认值：  reserveTokens = 16384, keepRecentTokens = 20000, enabled = true
 *
 * ── 两个踩过的坑（2026-09-16 实测，N21-2 时发现）──
 *
 * ① **用户级设置的路径不是 `~/.pi/agent`**：pi 拿到的是
 *    `PI_CODING_AGENT_DIR`（= 砚的 `PI_AGENT_DIR`）。便携版 / `YAN_PI_DIR`
 *    下两者不同，照 `homedir()` 拼就会读到**另一份文件**（甚至不存在），
 *    于是界面显示的值与 pi 生效的值不是一回事。
 *
 * ② **项目级设置只在 pi 信任该项目时生效**：pi 把存在 `.pi/settings.json`
 *    的项目视为 “trust-requiring”（该文件可以带 packages/extensions）；
 *    信任与否记在 `<pi 目录>/trust.json`。RPC 模式**没有信任弹窗**
 *    （`trustPromptMode` 只在 interactive 下问），所以用户不在 TUI 里点过
 *    Trust 的项目，其 `.pi/settings.json` 会被 pi **整份忽略**。
 *    既然被忽略，就不能拿它的值当“生效值”显示（见 `projectIgnored`）。
 *    实测：同一个 `reserveTokens` 放全局 → 第一轮就触发压缩；只放项目级
 *    且无 trust.json → 一轮都不触发；补上 trust.json → 又触发。
 *
 * ⚠️ 只读，不写 pi 的设置文件 —— 那是 TUI 和扩展的领地
 *    （与 main/settings.ts 的第一条约定相同）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import type { CompactionInfo, CompactionReason, CompactionRun, CompactionStatus } from '../shared/ipc'

/** pi 的默认值。改这里之前先看 pi 的 docs/compaction.md */
const DEFAULTS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }

interface PartialCompaction {
  enabled?: unknown
  reserveTokens?: unknown
  keepRecentTokens?: unknown
}

function pick(v: unknown, base: typeof DEFAULTS): typeof DEFAULTS {
  const o = (v && typeof v === 'object' ? v : {}) as PartialCompaction
  const num = (x: unknown, d: number): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : d
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    reserveTokens: num(o.reserveTokens, base.reserveTokens),
    keepRecentTokens: num(o.keepRecentTokens, base.keepRecentTokens)
  }
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    // 文件不存在 / 坏了都当「没配」
    return null
  }
}

/**
 * 这个项目会不会被 pi 当成“值得信任”。
 *
 * 只实现我们需要的那一半：pi 的规则是「从 cwd 向上找第一个 trust 条目」，
 * 条目为 `true` 才算信任（`false` 会被视为“明确不信任”而中止向上查找）。
 * 对比前先归一化：Windows 上同一个目录可能是 `C:\a\b` / `c:/a/b`，
 * 且 pi 写进 trust.json 的键是它自己规范化过的路径。
 *
 * 为什么不一并实现“向上找 `.agents/skills`”：那只影响**是否需要**信任；
 * 而我们需要判断的是「已经有了 `.pi/settings.json`（它本身就属于
 * trust-requiring 资源）时，pi 到底会不会读它」—— 只看 trust.json 就够。
 * 宁可不那么肯定：拿不准就返回 false（当作“没生效”），
 * 因为把被忽略的值当成生效值显示才是更难发现的错。
 */
export function projectTrustedFrom(trustRaw: unknown, cwd: string): boolean {
  if (!trustRaw || typeof trustRaw !== 'object' || Array.isArray(trustRaw)) return false
  const table = trustRaw as Record<string, unknown>
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  let cur = norm(cwd)
  for (;;) {
    for (const [key, value] of Object.entries(table)) {
      if (norm(key) === cur) return value === true
    }
    const idx = cur.lastIndexOf('/')
    if (idx <= 0) return false
    cur = cur.slice(0, idx)
  }
}

/**
 * 取生效的压缩设置（项目级覆盖用户级），并算出触发点。
 *
 * `contextWindow` 由调用方传入（来自当前模型 / 会话状态）——
 * 本模块不猜它，因为不同模型的窗口差很多。
 */
export async function compactionInfo(cwd: string, contextWindow: number): Promise<CompactionInfo> {
  /*
   * 用户级设置必须跟着 **pi 自己的目录**（`PI_CODING_AGENT_DIR`），
   * 而不是拼 `~/.pi/agent` —— 便携版与 YAN_PI_DIR 下两者不是一个地方。
   */
  const userFile = join(PI_AGENT_DIR, 'settings.json')
  const projFile = join(cwd, '.pi', 'settings.json')
  const trustFile = join(PI_AGENT_DIR, 'trust.json')

  const [userRaw, projRaw, trustRaw] = await Promise.all([
    readJson(userFile),
    readJson(projFile),
    readJson(trustFile)
  ])
  const fromUser = pick((userRaw as { compaction?: unknown })?.compaction, DEFAULTS)

  /* 项目级里到底有没有压缩配置：没有就没有“忽略”这回事 */
  const projCompaction = (projRaw as { compaction?: unknown } | null)?.compaction
  const hasProjCompaction =
    !!projCompaction && typeof projCompaction === 'object' && Object.keys(projCompaction).length > 0
  const trusted = hasProjCompaction ? projectTrustedFrom(trustRaw, cwd) : false
  const honored = hasProjCompaction && trusted

  const effective = honored ? pick(projCompaction, fromUser) : fromUser

  /*
   * 触发线：窗口 - 预留。
   * 夹到 ≥0 —— 预留比窗口还大时（用户把 reserveTokens 配得离谱）
   * 不能给出负数，那会让界面显示「已经该压缩了」。
   */
  const win = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.round(contextWindow) : 0
  const threshold = Math.max(0, win - effective.reserveTokens)

  const info: CompactionInfo = {
    enabled: effective.enabled,
    reserveTokens: effective.reserveTokens,
    keepRecentTokens: effective.keepRecentTokens,
    contextWindow: win,
    threshold,
    /** 生效值是用户自己配的，还是 pi 的默认值 —— 界面上要能说清 */
    custom: JSON.stringify(effective) !== JSON.stringify(DEFAULTS),
    scope: honored ? 'project' : 'global'
  }
  /*
   * 项目里配了、pi 却不会读：说出来。
   * 不说的话，用户改了项目里的 reserveTokens 会看到一个假的触发线（D21）。
   */
  if (hasProjCompaction && !trusted) info.projectIgnored = true
  return info
}

/* ------------------------------------------------------------------ 事件归一化 */

/**
 * 压缩的可观测状态（N21-2）。
 *
 * `running` 与 `last` 分开的理由见 `SessionState.compaction` 的注释：
 * 开始新一次压缩时上一次的结果必须留着。
 */
export interface CompactionState {
  running: CompactionRun | null
  last: CompactionRun | null
}

export const EMPTY_COMPACTION_STATE: CompactionState = { running: null, last: null }

const REASONS: readonly string[] = ['manual', 'threshold', 'overflow']

/** 认得出就归一化，认不出返回 undefined 并把原文留在 `reasonRaw` 里。 */
function readReason(evt: Record<string, unknown>): {
  reason?: CompactionReason
  reasonRaw?: string
} {
  const raw = typeof evt.reason === 'string' ? evt.reason.trim() : ''
  if (!raw) return {}
  return REASONS.includes(raw)
    ? { reason: raw as CompactionReason }
    : { reasonRaw: raw }
}

function readError(evt: Record<string, unknown>): string | undefined {
  // 手动路径给 `errorMessage`，durable 路径给 `error`（可能是 Error 或 { message }）
  const direct = evt.errorMessage
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const err = evt.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string' && m.trim()) return m.trim()
  }
  return undefined
}

/** 压缩前后 token 数（`result` 里的 `tokensBefore` / `estimatedTokensAfter`）。 */
function readTokens(evt: Record<string, unknown>): { beforeTokens?: number; afterTokens?: number } {
  const r = evt.result
  if (!r || typeof r !== 'object') return {}
  const o = r as { tokensBefore?: unknown; estimatedTokensAfter?: unknown }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
  const before = num(o.tokensBefore)
  const after = num(o.estimatedTokensAfter)
  return { ...(before !== undefined ? { beforeTokens: before } : {}), ...(after !== undefined ? { afterTokens: after } : {}) }
}

/**
 * 这次 `compaction_end` 的结局。
 *
 * 两套事件形状都要认（见 `CompactionRun` 的注释）：
 *   ① 有 `status`（durable lane 路径）→ 直接用它，但只认三个已知值；
 *   ② 没有 `status`（`Session.compact()` 路径）→ 按 `aborted` / `result` / 错误逐条判。
 * 两者都没有时**不许猜成功** —— 返回 `failed`，让用户看到而不是静默。
 */
export function compactionStatusOf(evt: Record<string, unknown>): CompactionStatus {
  const s = typeof evt.status === 'string' ? evt.status : ''
  if (s === 'completed' || s === 'declined' || s === 'failed') return s
  // 用户按了停止 / pi 自己中断了这次压缩：与「失败」是两回事（方案附录 A 之外补充）
  if (evt.aborted === true) return 'cancelled'
  if (evt.result) return 'completed'
  return 'failed'
}

/**
 * 把一条 `compaction_start` / `compaction_end` 折进状态。
 *
 * 不是压缩事件时返回 `null`，调用方据此跳过（不要把状态推送浪费在每条事件上）。
 * 纯函数：不读时钟以外的外部状态（`now` 可注入，便于单测）。
 */
export function reduceCompaction(
  state: CompactionState,
  evt: Record<string, unknown>,
  now: number = Date.now()
): CompactionState | null {
  const type = String(evt.type ?? '')

  if (type === 'compaction_start') {
    const startedAt = evt.startedAt ?? evt.endedAt
    return {
      ...state,
      running: {
        status: 'running',
        ...readReason(evt),
        startedAt: typeof startedAt === 'number' ? startedAt : now
      }
    }
  }

  if (type !== 'compaction_end') return null

  const status = compactionStatusOf(evt)
  /*
   * 结束事件里未必带 `reason`（`Session.compact()` 会带，durable 路径也带；
   * 但取消分支可能缺），缺失就沿用开始事件记下的那个 —— 否则界面上
   * 「最近一次」会突然没有原因。
   */
  const fromEnd = readReason(evt)
  const reason = fromEnd.reason ?? state.running?.reason
  const reasonRaw = fromEnd.reasonRaw ?? (fromEnd.reason ? undefined : state.running?.reasonRaw)
  const endedAt = typeof evt.endedAt === 'number' ? evt.endedAt : now
  const error = readError(evt)

  const run: CompactionRun = {
    status,
    ...(reason ? { reason } : {}),
    ...(reasonRaw ? { reasonRaw } : {}),
    ...(state.running?.startedAt !== undefined ? { startedAt: state.running.startedAt } : {}),
    /*
     * 发起方由**砚**在开压时就盖好了（`compaction_start` 里没有这个信息，
     * pi 对砚发起的压缩一律报 reason='manual'）—— 这里只是把它带到结束记录上，
     * 否则「正在压缩」写着“工作集”、结束后突然变回“手动”。
     */
    ...(state.running?.triggeredBy ? { triggeredBy: state.running.triggeredBy } : {}),
    ...(state.running?.policyStage ? { policyStage: state.running.policyStage } : {}),
    endedAt,
    ...(error ? { error } : {}),
    ...(typeof evt.entryId === 'string' && evt.entryId ? { entryId: evt.entryId } : {}),
    ...readTokens(evt)
  }
  return { running: null, last: run }
}

/**
 * 观测到 pi 说「没在压缩」时，把残留的 running 记录清掉。
 *
 * 为什么需要：`compaction_end` 万一没到（pi 崩了 / 事件被丢），running 记录会
 * 永久留着，界面就一直显示正在压缩 —— 和 D19「文件树卡在正在读取目录…」同一类 bug。
 * 以 pi 的 `get_state.isCompacting` 为准自愈；`last` 不动（上次结果仍是事实）。
 */
export function clearStaleRunning(
  state: CompactionState,
  isCompacting: boolean
): CompactionState {
  if (isCompacting || state.running === null) return state
  return { ...state, running: null }
}
