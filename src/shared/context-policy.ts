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
 * ── 阶段边界（`kinds` 是唯一出处）──
 * 主进程只做 `compaction`（调 pi 的 `compact()`）；`tool-sweep` / `recall` / `episode-fold`
 * 由 pi 扩展的 `context` 钩子执行（`episode-fold` 的状态生成器 2026-09-17 已落地，
 * 2026-09-18 用户拍板进默认接管集）。`kinds` 说明**真会执行**的那些，
 * 界面据此把尚未接管的阶段画成未生效（而不是假装它会触发）。
 * 默认值是 `['tool-sweep', 'recall', 'episode-fold', 'compaction']`（清理默认开但必须保留
 * 可召回引用、2026-09-17 拍板；`episode-fold` 2026-09-18 拍板加入），可用
 * `YAN_CONTEXT_POLICY` 的 `kinds` 覆盖；用户要关掉 `episode-fold` 时有专用开关
 * （`AppSettings.contextFold` → `ContextPolicyLayers.foldEnabled`），不必自己写 `kinds`。
 * **扩展侧 `resources/pi-extensions/context.js`
 * 的同名默认值必须与此保持一致** —— 两边不一致时，界面（主进程侧）会与真实生效的行为不同。
 */
import type {
  ContextBudget,
  ContextNextStage,
  ContextOperationKind,
  ContextPolicy,
  ContextPolicyOverrides,
  ContextPolicySource
} from './ipc'

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
  /*
   * 阶段 4 的默认接管范围：清理（Tool Sweep）+ 召回 + 压缩。
   *
   * · `tool-sweep` **默认开**（用户 2026-09-17 拍板）：墓碑里带 `ctx://tool/<entryId>`
   *   引用与取回说明，原文只从**送给模型的窗口**里拿掉，会话文件一行不动 ——
   *   所以“扫掉”是可逆的，不是删除。
   * · `recall` 必须与 `tool-sweep` **同时**在线：墓碑引用的唯一取回通道就是它，
   *   少了它，默认开启的 sweep 会变成“拿掉且取不回”。
   * · `episode-fold` **2026-09-18 起在默认里**（用户拍板，见方案 §17.5.7）：状态生成器
   *   已经落地。但它**不是每轮都跑** —— 会话级门槛（`foldEligible`）与脏判定
   *   （`shouldRefresh`）决定真正生成与否，短会话照样不花钱。
   */
  kinds: ['tool-sweep', 'recall', 'episode-fold', 'compaction']
}

const ALL_KINDS: readonly ContextOperationKind[] = [
  'tool-sweep',
  'episode-fold',
  'compaction',
  'recall'
]

/**
 * 设置面板里的**预设**（N21-7）。
 *
 * `default` 是空对象而不是一份数值 —— 与 `railWidth: 0` 同一个约定：
 * “用完默认”必须能被表达，否则用户没法从预设切回去；而默认值本身只有
 * `DEFAULT_CONTEXT_POLICY` 一个出处（写两份必然漂移）。
 *
 * `reference` 是外部参考方案的数值（300k / 0.75）。**只改这一组两个值**：
 * 参考方案的“五档阶段”在我们这里没有对应物（我们只有三档 + 兜底，
 * 而且 `kinds` 是不可调的），所以不能假装选它就多了两档 —— 界面文案要写清。
 * 小窗口下 `windowRatio: 0.75` 会侵占输出预留，但公式里那个
 * `窗口 − 预留 − 余量` 的 `min` 项仍然拦着（见 contextBudget 的注释），
 * 所以这个预设是安全的，只是更激进。
 */
export const CONTEXT_POLICY_PRESETS: Record<'default' | 'reference', ContextPolicyOverrides> = {
  default: {},
  reference: { workingSetCap: 300_000, windowRatio: 0.75 }
}

/**
 * 大窗口的模型级试行档。
 *
 * 这两档不是新的全局默认，也不是对“模型名带 1M”作出的自动判断；
 * 设置页只把它们写入当前精确的 `provider/model` 覆盖。真正生效时仍会
 * 经过 `contextBudget()` 的窗口、输出预留与安全余量三重 `min` 约束，
 * 因此切到较小窗口模型不会继承一个裸的 600K/700K 上限。
 */
export const LARGE_CONTEXT_POLICY_PRESETS: Record<'balanced' | 'long', ContextPolicyOverrides> = {
  balanced: { workingSetCap: 600_000, windowRatio: 0.7 },
  long: { workingSetCap: 700_000, windowRatio: 0.7 }
}

/**
 * 与设置层同口径的归一化：**与默认值相同的字段不会留在覆盖里**。
 *
 * 为什么必须照做：`LARGE_CONTEXT_POLICY_PRESETS` 的 `windowRatio: 0.7` 与默认值一样，
 * 落盘后会被丢掉，于是覆盖只剩 `{ workingSetCap: 600_000 }`。
 * 拿「键的数量」当判据会让设置页与右栏都说「这不是试行档」，
 * 而用户明明点的是试行档按钮 —— 2026-09-22 的真实 Electron 探针就是这样踩到的。
 */
function effectiveOverrides(overrides: ContextPolicyOverrides): Record<string, unknown> {
  const base = DEFAULT_CONTEXT_POLICY as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue
    if (base[key] === value) continue
    out[key] = value
  }
  return out
}

/**
 * 这份模型级覆盖是否**行为等价于**某个大窗口试行档（混合覆盖一律返回 undefined）。
 *
 * 设置页（哪个按钮亮）与右栏（现在用的是哪档）必须用同一个判据：
 * 各写一份的话，用户会在右栏看到「均衡 600K」而设置页显示「自定义」——
 * 这正是 C-5 要消除的那类「界面上的数不等于真正在用的数」。
 * 「等价」而不是「字面相等」：只设 `workingSetCap: 600_000` 与
 * `{ workingSetCap: 600_000, windowRatio: 0.7 }`（= 默认 0.7）是同一件事。
 */
export function largePresetOf(overrides?: ContextPolicyOverrides): 'balanced' | 'long' | undefined {
  if (!overrides) return undefined
  const mine = effectiveOverrides(overrides)
  for (const preset of ['balanced', 'long'] as const) {
    const target = effectiveOverrides(LARGE_CONTEXT_POLICY_PRESETS[preset])
    const keys = new Set([...Object.keys(mine), ...Object.keys(target)])
    let same = true
    for (const key of keys) {
      if (mine[key] !== target[key]) {
        same = false
        break
      }
    }
    if (same) return preset
  }
  return undefined
}

/** 试行档的显示名 i18n key（设置页按钮与右栏档位行共用，不手拼字符串） */
export const LARGE_PRESET_NAME_KEYS: Record<'balanced' | 'long', string> = {
  balanced: 'set.ctxModelPresetBalanced',
  long: 'set.ctxModelPresetLong'
}

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

/* ------------------------------------------------------------ 参数覆盖（env / 设置 / 模型） */

function num(v: unknown, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < min || v > max) return null
  return v
}

/**
 * 把一份覆盖写进策略，返回**真的被采纳**的字段名。
 *
 * 为什么返回字段名而不是 void：设置层有好几层（用户 → provider → model → env），
 * 界面要能回答“这个值是谁定的”。非法值一律忽略并退回上一层 —— 设置文件可以被手改，
 * 写坏的数值不能让预算变成 NaN。
 */
export function applyOverrides(
  policy: ContextPolicy,
  raw: ContextPolicyOverrides | undefined | null
): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const o = raw as Record<string, unknown>
  const applied: string[] = []

  const cap = num(o.workingSetCap, { min: 1 })
  if (cap !== null) {
    policy.workingSetCap = Math.round(cap)
    applied.push('workingSetCap')
  }
  const winRatio = num(o.windowRatio, { min: 0.05, max: 1 })
  if (winRatio !== null) {
    policy.windowRatio = winRatio
    applied.push('windowRatio')
  }
  const preferred = num(o.responseReservePreferred)
  if (preferred !== null) {
    policy.responseReservePreferred = Math.round(preferred)
    applied.push('responseReservePreferred')
  }
  const reserveMin = num(o.responseReserveMin)
  if (reserveMin !== null) {
    policy.responseReserveMin = Math.round(reserveMin)
    applied.push('responseReserveMin')
  }
  const marginMin = num(o.safetyMarginMin)
  if (marginMin !== null) {
    policy.safetyMarginMin = Math.round(marginMin)
    applied.push('safetyMarginMin')
  }
  const marginRatio = num(o.safetyMarginRatio, { max: 1 })
  if (marginRatio !== null) {
    policy.safetyMarginRatio = marginRatio
    applied.push('safetyMarginRatio')
  }
  const emergency = num(o.emergencyRatio, { min: 0.0001, max: 1 })
  if (emergency !== null) {
    policy.emergencyRatio = emergency
    applied.push('emergencyRatio')
  }

  const ratios = o.triggerRatios
  if (ratios && typeof ratios === 'object' && !Array.isArray(ratios)) {
    const r = ratios as Record<string, unknown>
    for (const key of ['sweep', 'fold', 'compact'] as const) {
      const v = num(r[key], { min: 0.01, max: 1 })
      if (v !== null) {
        policy.triggerRatios[key] = v
        applied.push(`triggerRatios.${key}`)
      }
    }
  }
  return applied
}

/**
 * 解析 `YAN_CONTEXT_POLICY`（JSON）里的覆盖值。
 *
 * 为什么需要有这个入口：策略的**真实触发**需要在真实模型上把上下文填到工作集
 * （默认 240k），那是几十万 token 的额度。测试把 `workingSetCap` 调成
 * 一两千就能用一次普通回合走完整条路径（与 N21-2 把 `reserveTokens` 调到
 * 比窗口还大是同一个手法）。非法字段一律忽略、退回默认值 —— 测试参数写错时
 * 应当退回生产默认值，而不是让预算变成 NaN。
 *
 * 这是**测试/调试通道**，优先级高于设置（见 resolveContextPolicy）：
 * 否则用户设置会静默盖掉 `YAN_CONTEXT_POLICY`，让测试失去意义。
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

  applyOverrides(out, o as ContextPolicyOverrides)
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled

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

/* -------------------------------------------------------- 生效层解析（N21-7） */

/** 一层覆盖：在哪里、覆盖了哪些字段 */
export interface ContextPolicyLayer {
  source: ContextPolicySource
  /** provider 层是供应商名，model 层是 `provider/model` */
  key?: string
  overrides: ContextPolicyOverrides
}

export interface ResolvedContextPolicy {
  policy: ContextPolicy
  /** 数值的生效层（`overridden` 非空时才有意义；全默认时为 `default`） */
  source: ContextPolicySource
  sourceKey?: string
  /** 被覆盖（非默认）的字段名 */
  overridden: string[]
}

/** 三层设置层的 lookup 输入（`env` 单独给，因为它是测试通道而非持久设置） */
export interface ContextPolicyLayers {
  /** 用户级（`AppSettings.contextPolicy`） */
  user?: ContextPolicyOverrides
  /** 模型 / 供应商级（`AppSettings.contextPolicyByModel`），key 两种形式 */
  byModel?: Record<string, ContextPolicyOverrides>
  /** 当前模型的 `provider/model`（`modelKeyOf` 的输出）；没有当前模型时不传 */
  modelKey?: string
  /** 显式供应商名；缺省从 `modelKey` 推 */
  provider?: string
  /** `YAN_CONTEXT_POLICY` 原文（测试通道，优先级最高） */
  envRaw?: string
  /**
   * `episode-fold`（Task State 生成 + 注入）的**用户开关**（`AppSettings.contextFold`）。
   *
   * `undefined` = 用户没改过 = 按默认（它在默认接管集里）；`false` = 明确关掉。
   * 为什么单独一个字段而不是塞进 `user` 覆盖：`applyOverrides` 只认**数值**，
   * 一个布尔开关放进去会被静默丢掉。
   * 为什么位置在 `user` 之后、`provider` / `model` 之前：它本身就是用户层意图，
   * 排在数值覆盖之前，`source` 才会正确地被更具体的层（model）接管；
   * 而 `env` 排在最后，所以显式给了 `kinds` 的测试场景仍能完全控制接管集。
   */
  foldEnabled?: boolean
}

/** 逐字段比较两份策略，返回值不同的字段名（含 `triggerRatios.*` 与 `kinds`） */
function diffPolicy(a: ContextPolicy, b: ContextPolicy): string[] {
  const out: string[] = []
  const flat = [
    'enabled',
    'workingSetCap',
    'windowRatio',
    'responseReservePreferred',
    'responseReserveMin',
    'safetyMarginMin',
    'safetyMarginRatio',
    'emergencyRatio'
  ] as const
  for (const key of flat) if (a[key] !== b[key]) out.push(key)
  for (const key of ['sweep', 'fold', 'compact'] as const) {
    if (a.triggerRatios[key] !== b.triggerRatios[key]) out.push(`triggerRatios.${key}`)
  }
  if (JSON.stringify(a.kinds) !== JSON.stringify(b.kinds)) out.push('kinds')
  return out
}

/**
 * 把各层盖成**一份**策略，并说清它来自哪一层（N21-7 的“可解释”）。
 *
 * lookup 顺序（后者赢）：`default` → `user` → `provider` → `model` → `env`。
 * `provider` 与 `model` 共用 `byModel` 这张表，按 key 的**具体程度**排序 ——
 * 所以 `anthropic` 与 `anthropic/claude-sonnet-4` 同时存在时，后者赢。
 *
 * `source` 取**最后一个真的改了值的层**，不是遍历到的最后一层：一个只有
 * 供应商覆盖、用户级为空的会话，不该被说成“用户设的”。
 */
export function resolveContextPolicy(layers: ContextPolicyLayers = {}): ResolvedContextPolicy {
  const policy: ContextPolicy = {
    ...DEFAULT_CONTEXT_POLICY,
    triggerRatios: { ...DEFAULT_CONTEXT_POLICY.triggerRatios },
    kinds: [...DEFAULT_CONTEXT_POLICY.kinds]
  }
  let source: ContextPolicySource = 'default'
  let sourceKey: string | undefined
  const overridden: string[] = []

  const apply = (
    raw: ContextPolicyOverrides | undefined,
    src: ContextPolicySource,
    key?: string
  ): void => {
    const applied = applyOverrides(policy, raw)
    if (!applied.length) return
    source = src
    sourceKey = key
    for (const f of applied) if (!overridden.includes(f)) overridden.push(f)
  }

  apply(layers.user, 'user')
  /*
   * `episode-fold` 的用户开关（P2-7）：它不是数值，`applyOverrides` 认不了，
   * 所以在这里单独折算成 `kinds` 的增删。放在 provider / model 之前 ——
   * 它属于用户层，不该抢走 model 层“数值来源”的位置（见 `foldEnabled` 的说明）。
   */
  if (layers.foldEnabled === false && policy.kinds.includes('episode-fold')) {
    policy.kinds = policy.kinds.filter((k) => k !== 'episode-fold')
    source = 'user'
    sourceKey = undefined
    if (!overridden.includes('kinds')) overridden.push('kinds')
  }
  const provider = layers.provider ?? (layers.modelKey ? layers.modelKey.split('/')[0] : undefined)
  if (provider) apply(layers.byModel?.[provider], 'provider', provider)
  if (layers.modelKey) apply(layers.byModel?.[layers.modelKey], 'model', layers.modelKey)

  const envRaw = layers.envRaw
  if (envRaw && envRaw.trim()) {
    const withEnv = policyFrom(envRaw, policy)
    const diff = diffPolicy(policy, withEnv)
    if (diff.length) {
      /* `policyFrom` 已经夹过合法区间、也认了 `enabled` 与 `kinds`，整份替换即可 */
      Object.assign(policy, withEnv)
      source = 'env'
      sourceKey = undefined
      for (const f of diff) if (!overridden.includes(f)) overridden.push(f)
    }
  }

  return { policy, source, sourceKey, overridden }
}

/* ---------------------------------------------------------------- 触发决策 */

/** 连续两次策略压缩之间的最小间隔：压缩失败时不要每一轮都重试同一个动作 */
export const POLICY_COOLDOWN_MS = 30_000
/** 用量回落到触发线的这个比例以下才重新“上膛”，避免刚压完又被判定过线 */
export const POLICY_REARM_RATIO = 0.9
/**
 * 压缩**实际回收后**的占用回落到软线这个比例以下 → 视为压力已解除（C-6）。
 *
 * 与 `POLICY_REARM_RATIO`（0.9）的分工：那个回答“自动压缩还允不允许再压”，
 * 这个回答“上一轮压缩是否真的把上下文降下来了”。0.8 是 C-6 的候选值，
 * 比 0.9 更严 —— 只降到 85% 不算“压下来了”，那种低回收的重复压缩正是要防的。
 */
export const POLICY_RESET_RATIO = 0.8
/**
 * 压缩后仍高于软线时，此后新增至少要达到这个绝对值才允许再压（C-6 候选值）。
 * 与 `POLICY_GROWTH_RATIO` 取 `max`；两者都夹在软线以内，见 `contextPolicyStep`。
 */
export const POLICY_GROWTH_MIN_TOKENS = 16_000
/** 压缩后“此后新增”相对软线的最低比例（C-6 的 `max(16K, 软线×5%)` 那一半） */
export const POLICY_GROWTH_RATIO = 0.05
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

/**
 * 策略发起的压缩**成功结束后**重新上膛。
 *
 * 为什么需要（2026-09-19 压力测试发现）：`armed` 的恢复原本只靠「用量回落到线下」
 * 或 5 分钟重试窗口。当工作集上限接近、甚至小于「系统提示 + 工具定义」的基线开销时
 * （测试通道会把工作集压到几千 token；真实用户也可能把窗口调得很小），压缩完成后
 * `tokens` 仍然高于 `工作集 × 0.9` —— 于是 `armed` 永远回不来，策略退化成
 * **每 5 分钟才压一次**：22 个连续回合只压了 2 次，转录涨到工作集的 3 倍。
 *
 * 而「压缩成功结束」本身就是上下文一定变小了的确凿证据（pi 的 `compaction_end`
 * 带 `tokensBefore` / `estimatedTokensAfter`）。此时重新上膛，让下一次过线由
 * 30 秒冷却约束，而不是由 5 分钟兜底窗口约束。
 * 只认 `completed`：失败 / 被取消的压缩没有让上下文变小，仍按原规则等回落。
 */
export function rearmAfterCompaction(
  state: ContextPolicyState,
  tokensAfter?: number | null
): ContextPolicyState {
  /*
   * 把这次压缩**实际压到多少**记下来（`compaction_end` 的 `estimatedTokensAfter`）。
   * 它是下一步防抖的基准：没有它，防抖只能退化回“软线以下的整体回落”，
   * 而基线开销本身就在软线以上时那条路永远不成立（见下）。
   * 认不出的数值记 `null`（不是 0）—— “不知道压到多少”与“压到 0”是两件事。
   */
  const mark = Number.isFinite(tokensAfter) && (tokensAfter as number) > 0 ? Math.round(tokensAfter as number) : null
  if (state.armed && state.tokensAfterCompaction === mark) return state
  return { ...state, armed: true, tokensAfterCompaction: mark }
}

/**
 * 压缩后“此后新增多少才允许再压”的门槛（C-6）：`max(16k, 软线×5%)`，
 * 并夹在软线以内。`contextPolicyStep` 与界面的「不可压缩基础开销」提示共用它，
 * 避免两处各写一份而慢慢漂移。
 */
export function policyGrowthMinTokens(budget: ContextBudget | null): number {
  if (!budget) return 0
  const line = budget.triggers.compact
  if (line <= 0) return 0
  return Math.min(line, Math.max(POLICY_GROWTH_MIN_TOKENS, Math.round(line * POLICY_GROWTH_RATIO)))
}

/**
 * 「主要为不可压缩基础开销」提示的判据（C-6）。
 *
 * 能得出的只是一个**观察**，不是一个更聪明的策略：
 *   · 上一次成功的压缩压完仍然停在软线 80% 以上（低回收）；
 *   · 且当前用量还没到「软线 + 新增门槛」（所以现在真的不会动手）。
 * 两条同时成立时，把“为什么不着手”说给用户听（而不是一直显示“已达工作集”却不动作）。
 * 数据不齐（没压过 / pi 没给 `estimatedTokensAfter`）一律不显示 —— 不编原因。
 */
export function incompressibleBaselineNotice(
  tokens: number | null,
  budget: ContextBudget | null,
  afterTokens: number | null | undefined
): boolean {
  if (!budget || tokens === null || !Number.isFinite(tokens)) return false
  if (typeof afterTokens !== 'number' || !Number.isFinite(afterTokens) || afterTokens <= 0) return false
  const line = budget.triggers.compact
  if (line <= 0) return false
  if (afterTokens < line * POLICY_RESET_RATIO) return false
  return tokens < line + policyGrowthMinTokens(budget)
}

export interface ContextPolicyState {
  /** 可以触发一次新的压缩（回落到线下后重新为 true） */
  armed: boolean
  /** 上一次由策略发起的压缩时间 */
  lastTriggerAt: number | null
  /**
   * 上一次成功压缩之后的估算占用（`estimatedTokensAfter`）；未知 / 没压过是 `null`。
   * 只用于 C-6 的“此后新增多少才再压”防抖，不参与预算计算。
   */
  tokensAfterCompaction?: number | null
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

  const retryReached = state.lastTriggerAt !== null && now - state.lastTriggerAt >= POLICY_REARM_MS
  const armed =
    state.armed || tokens < budget.triggers.compact * POLICY_REARM_RATIO || retryReached

  /*
   * C-6：`armed` 只说明“允许再压”，不说明“值得再压”。上一次压缩**实际压到了多少**
   * 才是防抖基准 —— 低回收（压完还在软线上）且此后几乎没新增时，再压一次几乎必然
   * 只是重复摘要（`<YAN_DATA_DIR>/context-actions/` 与 pi 事件里会看到连续两次
   * 成功的压缩，而正文几乎没变）。三条放行里任意一条成立才继续：
   *   ① 回落：实际占用已到软线 80% 以下 —— 压力真的解除了；
   *   ② 增长：此后新增达到 `max(16k, 软线×5%)` —— 确实又长出了新内容；
   *   ③ 重试窗口：`POLICY_REARM_MS` 到了 —— 上次可能压根没压成。
   * `tokensAfterCompaction` 未知（老状态 / 只跑过测试通道）时不加这道额外条件，
   * 保持 S3 的“成功后重新上膛”语义不被削弱。
   * 增长门槛夹在软线以内：工作集被压到低于基线开销时（`contextpressurelow`，
   * 那正是 S3 的场景），门槛不能长得比软线还高，否则策略又退化成永不触发。
   */
  const growthMin = policyGrowthMinTokens(budget)
  const after = state.tokensAfterCompaction
  const settled =
    after === null ||
    after === undefined ||
    tokens < budget.triggers.compact * POLICY_RESET_RATIO ||
    tokens - after >= growthMin ||
    retryReached

  const rearmed: ContextPolicyState = { ...state, armed }

  const crossed: ContextTrigger | null =
    tokens >= budget.emergency ? 'emergency' : tokens >= budget.triggers.compact ? 'compact' : null
  if (!crossed) return { state: rearmed, trigger: null }

  /* 兜底那条线不看是否上膛、也不看防抖：它本来就是“策略已经不灵了”的最后一道 */
  if (crossed === 'compact' && (!armed || !settled)) return { state: rearmed, trigger: null }
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
 * 只挑**有工作集刻度**的阶段（清理 / 折叠 / 压缩）—— `recall` 是取回通道、不是刻度，
 * 所以它进 `kinds` 但不参与这条预报。
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

/* ------------------------------------------------------- 覆盖值的清洗与落盘（N21-7） */

/** 只留下与默认值**不同**的字段（“用完默认”必须能被表达，见 CONTEXT_POLICY_PRESETS） */
function overridesFromPolicy(p: ContextPolicy): ContextPolicyOverrides {
  const d = DEFAULT_CONTEXT_POLICY
  const out: ContextPolicyOverrides = {}
  if (p.workingSetCap !== d.workingSetCap) out.workingSetCap = p.workingSetCap
  if (p.windowRatio !== d.windowRatio) out.windowRatio = p.windowRatio
  if (p.responseReservePreferred !== d.responseReservePreferred) {
    out.responseReservePreferred = p.responseReservePreferred
  }
  if (p.responseReserveMin !== d.responseReserveMin) out.responseReserveMin = p.responseReserveMin
  if (p.safetyMarginMin !== d.safetyMarginMin) out.safetyMarginMin = p.safetyMarginMin
  if (p.safetyMarginRatio !== d.safetyMarginRatio) out.safetyMarginRatio = p.safetyMarginRatio
  if (p.emergencyRatio !== d.emergencyRatio) out.emergencyRatio = p.emergencyRatio
  const ratios: { sweep?: number; fold?: number; compact?: number } = {}
  for (const key of ['sweep', 'fold', 'compact'] as const) {
    if (p.triggerRatios[key] !== d.triggerRatios[key]) ratios[key] = p.triggerRatios[key]
  }
  if (Object.keys(ratios).length) out.triggerRatios = ratios
  return out
}

/**
 * 清洗**一层**覆盖值（设置文件可以被手改，不能信）。
 *
 * 校验逻辑复用 `applyOverrides`（唯一真源），再把夹好的值读回来：
 * 非法字段被丢掉、越界值被夹到区间、认不出的键直接消失。
 * 清洗后与默认值完全一致时返回 `undefined` —— 让“没覆盖”在磁盘上就是**没有这个键**，
 * 而不是一个空对象（否则以后改默认值时，这些人会被一份空壳配置挡住）。
 */
export function sanitizeContextPolicyOverrides(v: unknown): ContextPolicyOverrides | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const probe: ContextPolicy = {
    ...DEFAULT_CONTEXT_POLICY,
    triggerRatios: { ...DEFAULT_CONTEXT_POLICY.triggerRatios },
    kinds: [...DEFAULT_CONTEXT_POLICY.kinds]
  }
  if (!applyOverrides(probe, v as ContextPolicyOverrides).length) return undefined
  const clean = overridesFromPolicy(probe)
  /* 全是默认值时同样当“没有覆盖”，否则会落一份空壳配置 */
  return Object.keys(clean).length ? clean : undefined
}

/** 清洗模型级覆盖表：未知形状的项直接丢掉，key 限长（key 会进日志与界面） */
export function sanitizeContextPolicyByModel(
  v: unknown
): Record<string, ContextPolicyOverrides> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, ContextPolicyOverrides> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const trimmed = key.trim()
    if (!trimmed || trimmed.length > 200) continue
    const clean = sanitizeContextPolicyOverrides(value)
    if (clean) out[trimmed] = clean
  }
  return Object.keys(out).length ? out : undefined
}

/*
 * ══════════════════════════════════════════════════════════════════
 * 生效策略交给薄层（实施-11 C-4）
 * ══════════════════════════════════════════════════════════════════
 *
 * 问题：数值覆盖（用户级 / 模型级）住在 `desktop.json` 里，而 pi 扩展按设计
 * **不读**它（除了两个布尔开关）—— 扩展侧的 `budgetOf()` 于是永远按默认
 * 240K 算阈值，界面却显示 300K。这正是「界面上的数 ≠ 真正在用的数」。
 *
 * 解法：宿主把解析后的覆盖写成一个**独立文件**交给薄层，而不是塞进
 * `YAN_CONTEXT_POLICY` —— 那个 env 在 `resolveContextPolicy` 里优先级高于
 * 设置面板（测试通道），宿主自己写它会让用户设置被静默忽略。
 *
 * 文件里存的是**分层**覆盖（默认层 + 模型层），不是「当前窗口的预算」：
 * 窗口只有 pi 侧知道（`ctx.model.contextWindow`），所以阈值仍由两边用同一套
 * `contextBudget()` 公式各自算 —— 公式的交叉校验在单测里钉着。
 */

export interface EffectiveContextPolicyDocument {
  v: 1
  /** 内容指纹：同内容同值、改一个字段就变（诊断与「要不要重写」用） */
  revision: string
  updatedAt: number
  /** 用户级覆盖（不含模型层）；空对象表示没有覆盖 */
  default: ContextPolicyOverrides
  /** 按 `provider/model` 的模型级覆盖 */
  byModel: Record<string, ContextPolicyOverrides>
  foldEnabled: boolean
}

/** 稳定键序的覆盖序列化 —— 键顺序变了不该让 revision 变。 */
function canonicalOverrides(o: ContextPolicyOverrides | undefined): string {
  if (!o) return '{}'
  const keys = Object.keys(o).sort() as Array<keyof ContextPolicyOverrides>
  return JSON.stringify(keys.map((k) => [k, o[k]]))
}

/** 内容指纹（djb2 变体）。不用于安全，只要求稳定且敏感。 */
export function contextPolicyRevision(input: {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  foldEnabled?: boolean
}): string {
  const byModel = input.byModel ?? {}
  const modelPart = Object.keys(byModel)
    .sort()
    .map((k) => `${k}=${canonicalOverrides(byModel[k])}`)
    .join(';')
  const canonical = `u:${canonicalOverrides(input.user)}|m:${modelPart}|f:${input.foldEnabled === false ? 0 : 1}`
  let hash = 5381
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash * 33) ^ canonical.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

export function buildEffectivePolicyDocument(input: {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  foldEnabled?: boolean
  now?: number
}): EffectiveContextPolicyDocument {
  return {
    v: 1,
    revision: contextPolicyRevision(input),
    updatedAt: input.now ?? Date.now(),
    default: { ...(input.user ?? {}) },
    byModel: { ...(input.byModel ?? {}) },
    foldEnabled: input.foldEnabled !== false
  }
}

/**
 * 从文档里挑出**当前模型**那一份覆盖（扩展侧读文件后用同一套规则）。
 *
 * 匹配顺序：精确 `provider/model` → provider 段（`provider`）→ 文档默认层。
 * 认不出的形状返回 `{}`（宁可回落默认，也不要让坏 JSON 把预算变成 NaN）。
 */
export function overridesOfEffectiveDocument(
  doc: unknown,
  modelKey: string | undefined
): ContextPolicyOverrides {
  if (!doc || typeof doc !== 'object') return {}
  const item = doc as Partial<EffectiveContextPolicyDocument>
  if (item.v !== 1) return {}
  const byModel = item.byModel && typeof item.byModel === 'object' ? item.byModel : {}
  const provider = modelKey && modelKey.includes('/') ? modelKey.split('/')[0] : ''
  if (modelKey && byModel[modelKey]) return { ...byModel[modelKey] }
  if (provider && byModel[provider]) return { ...byModel[provider] }
  return { ...(item.default && typeof item.default === 'object' ? item.default : {}) }
}
