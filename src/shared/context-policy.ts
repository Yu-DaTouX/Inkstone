/**
 * 上下文策略（N21-3）：砚按**工作集**决定什么时候压缩。
 *
 * ── 它解决什么问题 ──
 * pi 的原生自动压缩守的是**物理窗口**：`contextTokens > contextWindow − reserveTokens`。
 * 对 1M 窗口的模型，那条线在 984k —— 上下文可以涨到接近一百万 token 才被压，
 * 而编码任务真正需要的上下文远小于这个数（长上下文带来的成本与注意力稀释都是真实的）。
 * 所以砚自己算一条**工作集**线，到线就调 pi 的 `compact()`；
 * pi 那条线继续留在原地作为物理兜底（砚不写 pi 的设置文件，也不关它）。
 *
 * 公式（方案 §5，批注第 4、5 点的修订版）：
 *
 *     responseReserve = max(16k, min(32k, 窗口 × 25%))
 *     safetyMargin    = max(8k, 窗口 × 2%)
 *     workingSet      = min(240k, 窗口 × 70%, 窗口 − 预留 − 余量)
 *     triggers        = { sweep: 70%, fold: 85%, compact: 100% } × 工作集
 *     emergency       = min(窗口 × 90%, 窗口 − 预留)   // 最后一道防线，见下
 *
 * 验算（与方案里的表一致）：64k → 40k、128k → 88k、256k → 179k、1M → 240k。
 *
 * ── 兜底线为什么也要减输出预留（§12 修改 1 / D31）──
 * 只按 90% 窗口算时，64k 模型上兜底线是 57.6k，而输出预留是 16k ——
 * 也就是说这条线自己就吃掉了留给模型回答的空间（只剩 6.4k）。
 * 硬规则：**物理兜底不能突破输出预留**。
 *
 * 不减安全余量（方案里给的更保守那个写法）：`工作集` 在小窗口上正好由
 * `窗口 − 预留 − 余量` 决定，再减一次余量会让兜底线**等于**压缩线（64k 下都是 40k）。
 * 那时「兜底不看是否上膛」就等于「压缩线不看是否上膛」—— 冷却与上膛在
 * 小窗口模型上整体失效，退化成每轮重试。收了 `min` 之后可以证明
 * `emergency > triggers.compact` 恒成立（余量 ≥ 8k > 0），兜底仍是兜底。
 *
 * ── 为什么放在 shared 而不是 main ──
 * 判定（主进程做）与显示（渲染端的「下一步」那行）必须用**同一套**阶段规则，
 * 否则界面预报的和真的会发生的会不是一回事。这里只放纯逻辑：
 * 读 `YAN_CONTEXT_POLICY` 的入口在 `src/main/context-policy.ts`（那需要 process.env）。
 *
 * ── 为什么整块逻辑是纯函数 ──
 * 「什么时候压缩」是个会写坏用户上下文的决定，必须能一次把边界算清：
 * 窗口为 0 / 小到装不下预留 / 已过线 / 刚压完还没降下来 / 关了开关。
 * 这些分支在真实模型上要么很贵（要填几十万 token）要么很难构造，
 * 所以判定与预算全放在这里，只留「调 RPC」那一行给 agent.ts。
 *
 * ── 阶段边界（不要在阶段 3 提前实现阶段 4 的事）──
 * 这里只做 `compaction`：`tool-sweep` / `episode-fold` 需要 pi 扩展的 `context`
 * 钩子去真的改送给模型的消息（阶段 4）。`kinds` 就是这道边界的唯一出处，
 * 界面上未接管的阶段按「未生效」显示。
 */
import type { ContextBudget, ContextNextStage, ContextOperationKind, ContextPolicy } from './ipc'

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  enabled: true,
  workingSetCap: 240_000,
  windowRatio: 0.7,
  responseReservePreferred: 32_000,
  responseReserveMin: 16_000,
  safetyMarginMin: 8_000,
  safetyMarginRatio: 0.02,
  emergencyRatio: 0.9,
  triggerRatios: { sweep: 0.7, fold: 0.85, compact: 1 },
  /* 阶段 3 只会执行压缩；清理 / 折叠等阶段 4 的上下文扩展落地后再加进来 */
  kinds: ['compaction']
}

const ALL_KINDS: readonly ContextOperationKind[] = [
  'tool-sweep',
  'episode-fold',
  'compaction',
  'recall'
]

/**
 * 算工作集预算。
 *
 * 窗口未知（0 / NaN）或**小到装不下预留与余量**时返回 `null` —— 策略在这种模型上
 * 不生效，而不是给出一条 ≤ 0 的“压缩线”（那会让每一轮都触发压缩）。
 * 小窗口继续由 pi 的原生压缩负责，这是有意的降级，不是遗漏。
 */
export function contextBudget(
  contextWindow: number,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY
): ContextBudget | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null
  const win = Math.round(contextWindow)

  const responseReserve = Math.max(
    policy.responseReserveMin,
    Math.min(policy.responseReservePreferred, Math.round(win * 0.25))
  )
  const safetyMargin = Math.max(policy.safetyMarginMin, Math.round(win * policy.safetyMarginRatio))
  const workingSet = Math.min(
    policy.workingSetCap,
    Math.round(win * policy.windowRatio),
    win - responseReserve - safetyMargin
  )
  if (workingSet <= 0) return null

  const ratio = policy.triggerRatios
  return {
    contextWindow: win,
    responseReserve,
    safetyMargin,
    workingSet,
    triggers: {
      sweep: Math.round(workingSet * ratio.sweep),
      fold: Math.round(workingSet * ratio.fold),
      compact: Math.round(workingSet * ratio.compact)
    },
    /*
     * 兜底线：取「窗口 × 比例」与「窗口 − 输出预留」的较小者。
     * 上面的 null 分支保证这里 `win - responseReserve > 0`
     * （`workingSet ≤ win − 预留 − 余量` 且 > 0），所以不会出现 ≤ 0 的线。
     */
    emergency: Math.min(Math.round(win * policy.emergencyRatio), win - responseReserve)
  }
}

/* ------------------------------------------------------------ 参数覆盖（env） */

function num(v: unknown, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < min || v > max) return null
  return v
}

/**
 * 解析 `YAN_CONTEXT_POLICY`（JSON）里的覆盖值。
 *
 * 为什么需要有这个入口：策略的**真实触发**需要在真实模型上把上下文填到工作集
 * （默认 240k），那是几十万 token 的额度。测试把 `workingSetCap` 调成
 * 一两千就能用一次普通回合走完整条路径（与 N21-2 把 `reserveTokens` 调到
 * 比窗口还大是同一个手法）。非法字段一律忽略、退回默认值 —— 测试参数写错时
 * 应当退回生产默认值，而不是让预算变成 NaN。
 */
export function policyFrom(
  raw: string | undefined | null,
  base: ContextPolicy = DEFAULT_CONTEXT_POLICY
): ContextPolicy {
  if (!raw || !raw.trim()) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
  const o = parsed as Record<string, unknown>
  const out: ContextPolicy = { ...base, triggerRatios: { ...base.triggerRatios } }

  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  const cap = num(o.workingSetCap, { min: 1 })
  if (cap !== null) out.workingSetCap = Math.round(cap)
  const winRatio = num(o.windowRatio, { min: 0.05, max: 1 })
  if (winRatio !== null) out.windowRatio = winRatio
  const preferred = num(o.responseReservePreferred)
  if (preferred !== null) out.responseReservePreferred = Math.round(preferred)
  const reserveMin = num(o.responseReserveMin)
  if (reserveMin !== null) out.responseReserveMin = Math.round(reserveMin)
  const marginMin = num(o.safetyMarginMin)
  if (marginMin !== null) out.safetyMarginMin = Math.round(marginMin)
  const marginRatio = num(o.safetyMarginRatio, { max: 1 })
  if (marginRatio !== null) out.safetyMarginRatio = marginRatio
  const emergency = num(o.emergencyRatio, { min: 0.0001, max: 1 })
  if (emergency !== null) out.emergencyRatio = emergency

  const ratios = o.triggerRatios
  if (ratios && typeof ratios === 'object' && !Array.isArray(ratios)) {
    const r = ratios as Record<string, unknown>
    for (const key of ['sweep', 'fold', 'compact'] as const) {
      const v = num(r[key], { min: 0.01, max: 1 })
      if (v !== null) out.triggerRatios[key] = v
    }
  }

  const kinds = o.kinds
  if (Array.isArray(kinds)) {
    const picked = kinds.filter(
      (k): k is ContextOperationKind => typeof k === 'string' && (ALL_KINDS as readonly string[]).includes(k)
    )
    /* 空数组是「什么都没接管」的合法表达；只有给了合法项才覆盖 */
    if (picked.length || kinds.length === 0) out.kinds = picked
  }
  return out
}

/* ---------------------------------------------------------------- 触发决策 */

/** 连续两次策略压缩之间的最小间隔：压缩失败时不要每一轮都重试同一个动作 */
export const POLICY_COOLDOWN_MS = 30_000
/** 用量回落到触发线的这个比例以下才重新“上膛”，避免刚压完又被判定过线 */
export const POLICY_REARM_RATIO = 0.9
/**
 * 超过这个时间还没等到上下文回落，就允许再试一次。
 *
 * 为什么需要：`armed = false` 的本意是「等上一次压缩真的把上下文降下来」。但如果
 * 那次压缩**失败**（pi 回 `Already compacted`、被扩展取消、或根本没压成），上下文
 * 永远不会回落 —— 只按「回落」上膛会让策略永久失效：界面上一直停在
 * 「已达工作集上限」，却再也不会动手。所以给一个可解释的重试窗口：
 * 5 分钟既不会每轮都重试，也不会真的卡死。
 */
export const POLICY_REARM_MS = 5 * 60_000

export interface ContextPolicyState {
  /** 可以触发一次新的压缩（回落到线下后重新为 true） */
  armed: boolean
  /** 上一次由策略发起的压缩时间 */
  lastTriggerAt: number | null
}

export const INITIAL_POLICY_STATE: ContextPolicyState = { armed: true, lastTriggerAt: null }

export type ContextTrigger = 'compact' | 'emergency'

export interface PolicyStepInput {
  state: ContextPolicyState
  /** 当前上下文用量；pi 刚压缩完时会报 null（未知，不是 0） */
  tokens: number | null
  budget: ContextBudget | null
  policy: ContextPolicy
  /** 回合 / 压缩正在进行：不在中途动手，等它停下来 */
  busy: boolean
  now?: number
  cooldownMs?: number
}

export interface PolicyStepResult {
  state: ContextPolicyState
  trigger: ContextTrigger | null
}

/**
 * 一次决策。只回答「现在要不要让 pi 压一次」，不碰任何 IO。
 *
 * 规则（顺序即优先级）：
 *   ① 策略关 / 窗口未知 → 什么都不做（预算为 null 时也不动 armed，窗口恢复后接着用）；
 *   ② 重新上膛有两条路：用量回落到 `工作集 × 0.9` 以下（上次压缩真的生效了），
 *      或者距上次触发已超过 `POLICY_REARM_MS`（上次压根没成功，给一次重试机会）；
 *   ③ 命中哪条线：`emergency` 优先于 `compact`（前者是物理兜底，必须最先生效）；
 *   ④ 忙的时候不触发；`compact` 还要求已上膛；两者都受冷却时间约束。
 *
 * 冷却对两类触发都生效：压缩失败（例如 pi 回 `Already compacted`）时，
 * 每一轮都重试一次既没有意义也很吵 —— 30 秒后再说。
 */
export function contextPolicyStep(input: PolicyStepInput): PolicyStepResult {
  const { policy, budget, tokens, busy } = input
  const now = input.now ?? Date.now()
  const cooldown = input.cooldownMs ?? POLICY_COOLDOWN_MS
  const state = input.state

  if (!policy.enabled || tokens === null || !Number.isFinite(tokens) || !budget) {
    return { state, trigger: null }
  }

  const armed =
    state.armed ||
    tokens < budget.triggers.compact * POLICY_REARM_RATIO ||
    (state.lastTriggerAt !== null && now - state.lastTriggerAt >= POLICY_REARM_MS)
  const rearmed: ContextPolicyState = { ...state, armed }

  const crossed: ContextTrigger | null =
    tokens >= budget.emergency ? 'emergency' : tokens >= budget.triggers.compact ? 'compact' : null
  if (!crossed) return { state: rearmed, trigger: null }

  /* 兜底那条线不看是否上膛：它本来就是“策略已经不灵了”的最后一道 */
  if (crossed === 'compact' && !armed) return { state: rearmed, trigger: null }
  if (busy) return { state: rearmed, trigger: null }
  if (state.lastTriggerAt !== null && now - state.lastTriggerAt < cooldown) {
    return { state: rearmed, trigger: null }
  }

  return { state: { armed: false, lastTriggerAt: now }, trigger: crossed }
}

/* ------------------------------------------------------------ 界面用的下一步 */

/**
 * 「下一步会发生什么」（界面那行说明）。
 *
 * 只收 `kinds` 而不是整份策略：渲染端只拿得到策略**视图**（主进程推来的），
 * 而它真正需要的只是“哪些阶段已接管”。
 * 只在**真正会执行的阶段**里挑，所以阶段 3 永远返回 compaction ——
 * 清理 / 折叠虽然在工作集上有刻度，现在并不会触发。
 * 全部过线时返回当前最高阶段的 `reached: true`。
 */
export function nextContextStage(
  tokens: number | null,
  budget: ContextBudget | null,
  kinds: readonly ContextOperationKind[]
): ContextNextStage | null {
  if (!budget) return null
  const used = tokens === null || !Number.isFinite(tokens) ? 0 : tokens
  const candidates: ContextNextStage[] = []
  if (kinds.includes('tool-sweep')) {
    candidates.push({ kind: 'tool-sweep', at: budget.triggers.sweep, reached: false })
  }
  if (kinds.includes('episode-fold')) {
    candidates.push({ kind: 'episode-fold', at: budget.triggers.fold, reached: false })
  }
  if (kinds.includes('compaction')) {
    candidates.push({ kind: 'compaction', at: budget.triggers.compact, reached: false })
  }
  if (!candidates.length) return null

  const ahead = candidates.find((c) => c.at > used)
  if (ahead) return ahead
  const last = candidates[candidates.length - 1]
  return { ...last, reached: true }
}
