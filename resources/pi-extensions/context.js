/**
 * 砚内置「上下文状态化压缩」扩展（N21-4 / S2–S6）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它负责的三件事
 * ══════════════════════════════════════════════════════════════════
 * ① **Tool Sweep**（§12.5）：把 `recentTail` 之外的大块工具输出换成
 *    指向 `ctx://tool/<原始 entryId>` 的墓碑。原文一条不动 ——
 *    模型需要时用随包 CLI 的 `yan context recall --ref <ctx://…>` 取回。
 *    确定性、不调模型、幂等。
 * ② **Task State 前置注入**（§13.1 第 1 条）：状态文件存在且水位与
 *    当前会话**完全一致**时，把 `<TASK_STATE>` 放在历史**之前**。
 *    没有状态文件就不注入（绝不拿过期状态去误导模型）。
 * ③ **召回**的 TTL / 账本（§12.9）：回读入口**不在本扩展里** —— 模型经
 *    `yan context recall` 请求宿主（实现见 `src/main/context-recall.ts`），
 *    由宿主按单次 / 累计上限拒绝超预算请求、写审计、把逐字原文落成受管文件。
 *    本扩展只做两件配套的事：用真实消息重算召回账本，以及下一轮用户输入
 *    到来时把上一轮的召回正文清成只留引用的存根（`[Recalled context]` 前缀）。
 *    扩展**不注册任何模型工具**（01 §1 的架构检查）。
 *
 * 另外接管 `session_before_compact`（§12.8）——但**只在**已经有一份
 * 水位一致、六类字段齐备的 Task State 时才接管；否则原样返回
 * `undefined`，让 pi 用它自己的摘要。这是 §12.0 要求的降级路径：
 * 结构化生成失败/缺失 → 交回 pi 原生行为，不产生半状态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界：`episode-fold` 自 2026-09-18 起**进默认接管集**（但短会话不生成）
 * ══════════════════════════════════════════════════════════════════
 * 状态生成器（N21-4 剩余项 / N21-5 的语义部分）挂在 `agent_settled` 上，
 * 由扩展自己调一次无工具 completion（`ctx.modelRegistry.complete()`，
 * 方案 §16.1 已核实可行），产出 TaskState 的**语义字段**；
 * `files` / `commandsRun` / `testsRun` 由确定性 reducer 从真实工具调用里抄，
 * 落盘前**覆盖**模型返回的同名字段（防幻觉污染 durable state）。
 *
 * 它只在 `kinds` 含 **`episode-fold`** 时工作 —— **2026-09-18 用户拍板把它加进默认
 * 接管集**，默认 kinds 现在含它。请分清「在集合里」与「每轮都跑」：默认开的是
 * **资格**，真正跑不跑由下面那道**会话级门槛**（`foldEligible`）决定，所以
 * **短会话仍然不花钱**。要彻底关掉就把 `kinds` 里的 `episode-fold` 去掉，
 * 或者用 `state.generate` 分路只关注入。
 * 生成失败 / 超时（20s）/ 水位对不上 / CAS 失败 一律**保留旧状态**，不落半成品。
 *
 * 两道额外的闸（第四轮外部评审，2026-09-17 晚）：
 *   · **分路开关** `state: { generate, inject }`（P0-5）—— 可以只生成不注入
 *     （shadow 模式：先看它写得对不对、贵不贵），也可以只注入不生成；
 *   · **会话级门槛** `foldEligible`（第四问 A）—— 短会话不生成：回合数、
 *     转录 token、是否已经清扫过东西三个信号，命中后本会话 sticky。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么所有钩子都包在 try/catch 里、失败返回 undefined
 * ══════════════════════════════════════════════════════════════════
 * 这个扩展会重写发给模型的消息。任何一次异常如果不能安全退出，
 * 坏上下文就会直接进推理。所以规则是：**宁可这次什么都没做，
 * 也不发出半份结果**。诊断写进 `YAN_CONTEXT_EXT_LOG`，真实链路靠探针取证。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_RECALL,
  DEFAULT_RECENT_TAIL,
  DEFAULT_SWEEP,
  activePathsOf,
  activeRecallTokens,
  alignEntryIds,
  applyToolSweep,
  buildStructuredSummary,
  contextEntries,
  diagnostic,
  entryProducesMessage,
  entryMessageRole,
  episodeWindow,
  DEFAULT_EPISODE_WINDOW,
  estimateTokens,
  injectTaskState,
  mergeEpisodeRefs,
  messageText,
  planToolSweep,
  recentTailFor,
  renderTaskState,
  stripStaleRecalls,
  sweepViolations,
  userTurnCount,
  watermarkOfEntries,
} from './context-transform.js'
import {
  PRODUCER_SYSTEM_PROMPT,
  applyFreshness,
  buildProducerPrompt,
  buildStateFile,
  casAllows,
  citableEntries,
  clipTaskStateToBudget,
  dirtyMask,
  dirtyMaskWithEvidence,
  evidenceFromMessages,
  foldEligible,
  freshView,
  freshnessOf,
  mergeEpisodeState,
  mergeTaskState,
  parseProducerOutput,
  provenanceCounts,
  shouldRefresh,
  stateItemCounts,
  stripSyntheticMessages,
  tailRolesOf,
  transcriptStats,
  userDirectives
} from './context-producer.js'
import {
  STAGE_COOLDOWN_MS,
  STAGE_REARM_MS,
  createStageRuntime,
  recordStageObservation,
  recordStageRun,
  stageStep
} from './context-stage-runtime.js'
import {
  DEEP_MAX_OUTPUT_TOKENS,
  DEEP_SYSTEM_PROMPT,
  DEEP_TIMEOUT_MS,
  buildDeepInput,
  buildDeepPrompt,
  deepEligible,
  deepSwitches,
  injectWorkingTrace,
  parseDeepOutput,
  renderWorkingTrace,
  turnKeyOf
} from './context-deep.js'
import {
  budgetOf,
  budgetOverridesFromPolicy,
  estimateMessagesTokens,
  estimateRequestTokens,
  mergeBudgetOverrides,
  overridesOfEffectiveDocument,
  requestBudgetLevel
} from './context-budget.js'

/* ---------------------------------------------------------------- 环境与设置 */

function dataDir() {
  const dir = process.env.YAN_DATA_DIR?.trim()
  return dir || join(homedir(), '.pi', 'agent', 'yan')
}

function stateDir() {
  return join(dataDir(), 'context-state')
}

/**
 * 宿主交给薄层的生效策略（一种读盘 + 一个缓存，与 desktopSettings 同一个约定）。
 *
 * 为什么不让宿主写 `YAN_CONTEXT_POLICY`：那个 env 的优先级**高于**设置面板
 * （测试通道），宿主自己写它会把用户设置静默盖掉。所以走独立文件。
 */
let effectivePolicyCache = { at: 0, value: null }
function hostPolicyDocument() {
  const now = Date.now()
  if (now - effectivePolicyCache.at < 1000) return effectivePolicyCache.value
  const raw = readJson(join(dataDir(), 'context-policy.effective.json'))
  effectivePolicyCache = { at: now, value: raw && typeof raw === 'object' ? raw : null }
  return effectivePolicyCache.value
}

/**
 * 这一轮该用哪份预算（实施-05 S4 / 实施-11 C-4）。
 *
 * 窗口从 `ctx.model.contextWindow` 拿（06-S4 的 `contextrefresh` 已证它在真实链路可用）；
 * 取不到就交回 `null`（判定为 `unknown`，策略不生效，回落 pi 原生压缩）。
 *
 * 覆盖值的两个来源，优先级从高到低：
 *   ① `YAN_CONTEXT_POLICY`（测试通道，与主进程同一份 env）；
 *   ② 宿主的 `context-policy.effective.json`（用户级 / 模型级设置的投影）。
 * 公式仍是 `shared/context-policy.ts` 那一套（`context-budget.js` 与它交叉校验）。
 */
function requestBudgetFor(ctx) {
  const raw = process.env.YAN_CONTEXT_POLICY
  let envOverrides = {}
  if (raw && raw.trim()) {
    try {
      envOverrides = budgetOverridesFromPolicy(JSON.parse(raw))
    } catch {
      envOverrides = {}
    }
  }
  const modelKey =
    ctx?.model?.provider && ctx?.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined
  const hostOverrides = budgetOverridesFromPolicy(
    overridesOfEffectiveDocument(hostPolicyDocument(), modelKey)
  )
  const overrides = mergeBudgetOverrides(envOverrides, hostOverrides)
  const win = ctx?.model?.contextWindow
  return budgetOf(typeof win === 'number' ? win : 0, overrides)
}

/**
 * `before_provider_request`：请求真的发出去之前的最后一眼（实施-05 S4）。
 *
 * 做两件事，顺序不能反：
 *   ① **记诊断**（`request-budget`）：估算体积 / 三档判定 / 当时的预算线。
 *      没有这一行，「它为什么没发出去」就只能靠猜 —— 而估算是**估算**，
 *      与真实 usage 的偏差正是要靠这条日志长期校准的。
 *   ② 只在 `physical` 时**拒绝发送**（`ctx.abort()`）：连「估算 + 输出预留」都超过
 *      窗口的请求，provider 只会报错 —— 发出去的唯一效果是把这一轮白烧掉。
 *      代价是这一轮以 `Request aborted` 结束（S1 实测），所以必须写清原因：
 *      会话留痕 + 诊断行，两边都能看到「是预算把它挡下的，不是崩了」。
 *
 * `soft` 不在这里处理：清扫要改 messages（属于 `context` 钩子的活），
 * 压缩要跨回合（属于宿主 settled 后的活）。这里只观察与止损。
 */
function onBeforeProviderRequest(event, ctx, pi) {
  const payload = event?.payload
  const budget = requestBudgetFor(ctx)
  const usage = estimateRequestTokens(payload)
  const verdict = requestBudgetLevel({ estimatedTokens: usage.total, budget })
  const sessionId = sessionIdOf(ctx)

  trace(`request-budget-${verdict.level}`, {
    sessionId,
    messages: usage.messages,
    tools: usage.tools,
    system: usage.system,
    estimatedTokens: verdict.estimatedTokens,
    projectedTokens: verdict.projectedTokens,
    reason: verdict.reason,
    window: budget?.contextWindow ?? null,
    workingSet: budget?.workingSet ?? null,
    emergency: budget?.emergency ?? null,
    responseReserve: budget?.responseReserve ?? null
  })

  if (verdict.level !== 'physical') return

  /* 留痕：会话文件里能查到「这一轮为什么没跑起来」（appendEntry 不进模型上下文） */
  try {
    pi?.appendEntry?.('yan-budget-abort', {
      at: Date.now(),
      estimatedTokens: verdict.estimatedTokens,
      projectedTokens: verdict.projectedTokens,
      contextWindow: budget?.contextWindow ?? null,
      reason: verdict.reason
    })
  } catch (err) {
    trace('budget-abort-entry-failed', { sessionId, error: errorText(err) })
  }

  try {
    ctx?.abort?.()
    trace('budget-abort', {
      sessionId,
      aborted: true,
      estimatedTokens: verdict.estimatedTokens,
      projectedTokens: verdict.projectedTokens,
      contextWindow: budget?.contextWindow ?? null
    })
  } catch (err) {
    trace('budget-abort-failed', { sessionId, error: errorText(err) })
  }
}

function trace(hook, payload) {
  const file = process.env.YAN_CONTEXT_EXT_LOG
  if (!file) return
  try {
    appendFileSync(file, diagnostic(hook, payload) + '\n')
  } catch {
    /* 诊断写不进去不影响变换本身 */
  }
}

/* ---------------------------------------------------------------- 三类动作账本（C-2b） */

/**
 * 整理动作账本（实施-11 C-2b）。
 *
 * 为什么必须由扩展写：`tool-sweep` 与 `episode-fold` **不产生** pi 的
 * `compaction_*` 事件 —— 宿主没有别的途径知道“这一轮到底动没动上下文”。
 * 写进 `<YAN_DATA_DIR>/context-actions/<sessionId>.jsonl`，宿主读出来，
 * 界面上把三类（清扫 / 状态刷新 / 整轮压缩）**分开**显示。
 *
 * 与 `trace()` 的分工：`trace` 是排查用的诊断线（默认关，走 env 指定的
 * 任意路径）；账本是**产品口径**的读数，宿主必读，所以路径固定、默认开。
 *
 * 只记动作口径：做了什么、动了多少条、省了多少**估算** token、为什么没做。
 * 不记消息正文 —— 账本是诊断，不是第二份转录。
 */
const ACTION_LOG_MAX_LINES = 500
const ACTION_LOG_KEEP_LINES = 300
/** 已写入行数（省掉每次 append 前都读整文件） */
const actionLineCounts = new Map()

function actionsFile(sessionId) {
  return join(dataDir(), 'context-actions', `${sessionId}.jsonl`)
}

function countLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/**
 * `sessionId` 必须已经过 `sessionIdOf()` 的合法校验（与宿主的
 * `isSafeSessionId` 同一条判据）—— 这里不再做第二套清洗，
 * 否则两边文件名会不一致，宿主就读不到。
 */
function recordAction(sessionId, action) {
  if (!sessionId) return
  try {
    const file = actionsFile(sessionId)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ at: Date.now(), ...action }) + '\n')
    const known = actionLineCounts.get(file)
    const count = typeof known === 'number' ? known + 1 : countLines(file)
    actionLineCounts.set(file, count)
    /* 有界：只留最后一段。账本是读数，不是无限增长的历史。 */
    if (count > ACTION_LOG_MAX_LINES) {
      const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-ACTION_LOG_KEEP_LINES)
      writeFileSync(file, kept.join('\n') + '\n')
      actionLineCounts.set(file, kept.length)
    }
  } catch {
    /* 账本写不进去不影响变换本身 */
  }
}

/**
 * 扩展侧的策略读取。
 *
 * 与主进程的 `shared/context-policy.ts` 是**同一份 env**（pi 子进程继承
 * `process.env`），所以「哪些阶段已接管」只有一个真源（`kinds`）。
 * 这里额外认几个只在扩展里用的门槛（recentTail / sweep / recall），
 * 主进程不认识它们、也不需要认识 —— 它们只影响「怎么改消息」。
 */
/**
 * 默认接管集。与 `src/shared/context-policy.ts` 的 `DEFAULT_CONTEXT_POLICY.kinds`
 * **必须一致**：主进程读同一份 env，两边不一致时界面（主进程侧）会与真实生效的
 * 扩展行为不同。`recall` 与 `tool-sweep` 捆绑（墓碑引用的唯一取回通道就是它）；
 * `episode-fold` 自 2026-09-18 起在默认集里（用户拍板）—— 它**不是**每轮都跑，
 * 见 `foldEligible` 的会话级门槛。
 */
const DEFAULT_KINDS = ['tool-sweep', 'recall', 'episode-fold', 'compaction']

function policy() {
  const raw = process.env.YAN_CONTEXT_POLICY ?? ''
  /*
   * 生效的接管集 = 默认集去掉用户关掉的项（P2-7）。
   * `DEFAULT_KINDS` 本身不变 —— 用户开关只是它上面的一层，
   * 而且 `YAN_CONTEXT_POLICY` 显式给了 `kinds` 时它会原样放行（测试通道优先）。
   */
  const baseKinds = applyFoldSwitch([...DEFAULT_KINDS])
  const base = {
    kinds: baseKinds,
    recentTail: { ...DEFAULT_RECENT_TAIL },
    sweep: { ...DEFAULT_SWEEP },
    recall: { ...DEFAULT_RECALL },
    /*
     * 两个分路的默认值**必须由（生效的）`kinds` 推导**，不能硬编码 false。
     * `episode-fold` 进默认集之后，写死 false 就会出现「总闸说接管了、分路却说关着」
     * —— 生成器永远不会跑，而界面显示已接管。这里用 `stateSwitches` 保证
     * 「在集合里 → 分路默认开」与 `stateSwitches` 自己的语义始终一致。
     */
    state: stateSwitches(undefined, baseKinds),
    /*
     * Episode 候选区间的门槛（§12.6 / §12.12 的 P2）。与 sweep 的收益门槛同类：
     * 初值保守，而标定时**必须能单独覆盖** —— 所以走策略而不是写死在调用处。
     */
    episodes: { ...DEFAULT_EPISODE_WINDOW },
    /*
     * Deep Context（N21-8）：**默认关闭** —— 它挂在 `context` 钩子里，会在用户每次
     * 开口前多调一次模型并**同步阻塞**本轮。开与不开是用户的判断，见 `context-deep.js`。
     */
    deep: { enabled: false, minTokens: 0 }
  }
  /*
   * Deep Context 的开关解析，三个来源，优先级从高到低：
   *   ① 策略里的 `deep`（`YAN_CONTEXT_POLICY`，测试通道）；
   *   ② 专用 env `YAN_CONTEXT_DEEP`（也是测试/CI 用；`0` 是**明确关**，不会被 ③ 盖掉）；
   *   ③ 桌面端设置 `desktop.json` 的 `contextDeep.enabled`（用户真正能按的那个开关）。
   *
   * 抽成函数是因为 `policy()` 有**三处早退**（没设策略 / JSON 不合法 / JSON 形状不对）——
   * 早退路径也必须带上它，否则「用户开了但没设过任何策略」这种最常见的
   * 生产情形会静默地一直是关的（先只在正常路径里处理，单测当场就红了）。
   */
  const resolveDeep = (fromPolicy) => deepSwitches(fromPolicy ?? deepFromEnv() ?? deepFromSettings())
  if (!raw.trim()) return { ...base, deep: resolveDeep(undefined) }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...base, deep: resolveDeep(undefined) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...base, deep: resolveDeep(undefined) }
  /*
   * `YAN_CONTEXT_POLICY` 显式给了 `kinds` 数组时，接管集完全由它决定：
   * 这是测试通道，`contexttakeover` / `contextproduce` 靠它精确控制接管集，
   * 让它被用户设置盖掉会让那些场景静默失效（与 `deep` 的优先级立场一致）。
   * 只给了其它字段（如只降门槛）时，`kinds` 仍走 `base.kinds`（已含用户开关）。
   */
  const kindsFromEnv = Array.isArray(parsed.kinds)
  const kinds = kindsFromEnv
    ? parsed.kinds.filter((k) => typeof k === 'string')
    : base.kinds
  const pick = (source, defaults, zeroKeys) => {
    const out = { ...defaults }
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value
        else if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value === 0 &&
          zeroKeys && zeroKeys.has(key)
        )
          out[key] = 0
        else if (key === 'ttl' && (value === 'turn' || value === 'episode')) out.ttl = value
      }
    }
    return out
  }
  return {
    kinds,
    recentTail: pick(parsed.recentTail, base.recentTail),
    /*
     * `forcedMinReclaim*` 允许显式写 0（= 到线后无条件清扫，旧行为）。
     * 其余字段仍然是“正数才生效” —— 写坏的值不得把预算变成 0。
     */
    sweep: pick(parsed.sweep, base.sweep, new Set(['forcedMinReclaimTokens', 'forcedMinReclaimRatio'])),
    recall: pick(parsed.recall, base.recall),
    episodes: pick(parsed.episodes, base.episodes),
    state: stateSwitches(parsed.state, kinds),
    /*
     * Deep Context 的开关有三个来源：`YAN_CONTEXT_POLICY.deep`（测试通道，最高）、
     * `YAN_CONTEXT_DEEP`、以及桌面端设置文件。
     *
     * **刻意不让砚把用户设置写进 `YAN_CONTEXT_POLICY`**：那个 env 在
     * `src/shared/context-policy.ts` 的 lookup 里优先级**高于设置面板**，
     * 砚一旦自己写它，用户改设置就会被静默盖掉（这正是测试通道想要的性质，
     * 但对生产反向）。所以用户设置走 `desktop.json`。
     */
    deep: resolveDeep(parsed.deep)
  }
}

/**
 * Deep Context 的用户开关（`YAN_CONTEXT_DEEP=1|0`）。
 *
 * 返回 `undefined` 表示「没表态」，交由 `deepSwitches` 的默认值（关）。
 * 认不出的值（如拼错的 `yes`）也当没表态 —— 宁可不开，也不要因为一个拼写
 * 把「同步阻塞一次模型调用」这个重选项悄悄打开。
 */
function deepFromEnv() {
  const raw = (process.env.YAN_CONTEXT_DEEP ?? '').trim().toLowerCase()
  if (raw === '1' || raw === 'true') return { enabled: true }
  if (raw === '0' || raw === 'false') return { enabled: false }
  return undefined
}

/**
 * 桌面端设置里的两个上下文开关（**一次读盘、一个缓存**）。
 *
 * 与 `language.js` / `response-detail.js` / `question.js` 是**同一个约定**（扩展自己读
 * 桌面端设置）：好处是**改设置立即生效**，不需要重建 pi 实例、也不动已有会话。
 * 代价是每轮一次 IO —— 文件很小，再加一个 1 秒缓存补齐（`policy()` 在一个回合里
 * 会被调好几次：`onContext` / `onBeforeCompact` / `onAgentSettled`）。
 *
 * 为什么两个开关合在一起读：它们来自**同一个文件**，分开读就是两倍 IO 与两份要
 * 各自失效的缓存。
 *
 * 两个开关的**默认方向相反**，这是有意的：
 *   · `contextDeep`（N21-8）默认关 —— 它每轮同步阻塞一次模型调用，重；
 *   · `contextFold`（N21-5 / P2-7）默认开 —— 它已在默认接管集里，用户能按的是“关”。
 * 读不到 / 解析不了 / 字段不是期望的字面量一律当「没表态」，交由各自默认值。
 */
let desktopSettingsCache = { at: 0, value: {} }
function desktopSettings() {
  const now = Date.now()
  if (now - desktopSettingsCache.at < 1000) return desktopSettingsCache.value
  const raw = readJson(join(dataDir(), 'desktop.json'))
  const value = {}
  if (raw?.contextDeep?.enabled === true) value.deep = { enabled: true }
  if (raw?.contextFold?.enabled === false) value.fold = { enabled: false }
  desktopSettingsCache = { at: now, value }
  return value
}

/**
 * Deep Context 的桌面端开关（`desktop.json` 的 `contextDeep.enabled`）。
 *
 * 读不到 / 解析不了 / 字段不是 `true` 一律当没表态，交由默认值（关）。
 */
function deepFromSettings() {
  return desktopSettings().deep
}

/**
 * `episode-fold` 的桌面端开关（`desktop.json` 的 `contextFold.enabled`）。
 *
 * 返回 `undefined` = 没表态（按默认：开）；只有明确 `false` 才返回 `{enabled:false}`。
 * 之所以不是“字段是 `true` 才算开”：它本来就在默认接管集里，磁盘上没有这个键
 * 与用户主动打开是同一件事，不该被区分成两种（与 `sanitizeContextFold` 同一条约定）。
 */
function foldFromSettings() {
  return desktopSettings().fold
}

/**
 * `episode-fold` 的测试通道（`YAN_CONTEXT_FOLD=1|0`）。
 *
 * 与 `YAN_CONTEXT_DEEP` 对称：`0` 是**明确关**，不会被设置里的开盖回去；
 * 认不出的值（如拼错的 `yes`）当没表态。**不给它加新语义** —— 它只是让场景
 * 能在不写 `desktop.json` 的前提下走“用户关掉”那条分支。
 */
function foldFromEnv() {
  const raw = (process.env.YAN_CONTEXT_FOLD ?? '').trim().toLowerCase()
  if (raw === '1' || raw === 'true') return { enabled: true }
  if (raw === '0' || raw === 'false') return { enabled: false }
  return undefined
}

/**
 * 把 `episode-fold` 的用户开关折算到接管集上。
 *
 * `kindsFromEnv: true`（`YAN_CONTEXT_POLICY` 显式给了 `kinds` 数组）时**原样返回**：
 * 那是测试通道，`contexttakeover` / `contextproduce` 这类场景靠它精确控制接管集，
 * 让它被用户设置盖掉会让那些场景静默失效（与 `deep` 的优先级立场一致）。
 *
 * 注意它改的是**生效的** kinds，不是 `DEFAULT_KINDS` —— 默认值仍然只有一处，
 * 主进程侧的 `DEFAULT_CONTEXT_POLICY.kinds` 与这里必须始终保持一致。
 */
function applyFoldSwitch(kinds, { kindsFromEnv = false } = {}) {
  if (kindsFromEnv) return kinds
  const fold = foldFromEnv() ?? foldFromSettings()
  return fold?.enabled === false ? kinds.filter((k) => k !== 'episode-fold') : kinds
}

/**
 * 「生成」与「注入」分开的两个分路（第四轮外部评审 P0-5）。
 *
 * `kinds` 是**总闸**（不含 `episode-fold` 就什么都不做）；这两个是闸内的分路：
 *   · `generate:false` → 只用已有状态（不再花钱生成）；
 *   · `inject:false`  → 只生成不注入，即 **shadow 模式**：
 *     先看它写得对不对、贵不贵，再决定让它进上下文。
 * 出问题时的期望操作是「先关注入、保留生成」或「先停生成、保留已注入的状态」，
 * 而不是把整个 context 扩展拔掉（那就连 Tool Sweep 也没了）。
 *
 * **`inject` 的准确含义是「允许 TaskState 参与任何模型可见的上下文」**，不只是
 * 「插入 `<TASK_STATE>` 块」—— 压缩接手（`session_before_compact` 的结构化摘要）也算在内；
 * **以后任何新增的模型可见消费点都必须走这个开关**，否则 `inject:false` 的语义就是假的。
 * 两个组合的行为契约：`generate:false + inject:true` 时没有合法已有状态就 no-op（**不临时生成**）；
 * `generate:true + inject:false` 允许落盘与诊断，但任何模型可见路径都不得消费它。
 */
function stateSwitches(raw, kinds) {
  const on = kindEnabled({ kinds }, 'episode-fold')
  /*
   * `episodeInject`（Episode 扇叠的**消费门**）：默认 **false** = 只生成、不消费。
   *
   * 它与 `inject` 不是一回事：`inject` 管的是「让 TaskState 参与模型可见上下文」，
   * 而 Episode 是**另一类东西** —— 模型自己写出来的「段结论」，一旦消费就直接进 pi 的
   * 压缩摘要。没有真实会话的质量数据前先只落盘（质量可以从状态文件里看），
   * 这是与 `inject` 当初的 shadow 模式同一条做法。
   * 用户拍板（2026-09-18）：先 shadow，看几轮真实质量再决定是否放行。
   */
  const out = { generate: on, inject: on, episodeGenerate: false, episodeInject: false, minTurns: 0, minTokens: 0, refreshRatio: 0, rearmMs: 0, cooldownMs: 0 }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.generate === 'boolean') out.generate = raw.generate && on
    if (typeof raw.inject === 'boolean') out.inject = raw.inject && on
    /*
     * Episode 的**生成门**（默认关）。
     *
     * 为什么生成也要一道门（原本只打算做「生成但不消费」的 shadow）：
     * 实测（2026-09-18，deepseek-v4.1-flash）——**窗口非空的两次生成全部 `not-json`**，
     * 而同一个场景里窗口为空的那一次正常提交。也就是说，在提示词里多要一个嵌套对象
     * 会让**整次生成**（包括 TaskState 本身）更容易失败。
     * TaskState 是现有能力，不能为了一个还没验收的新东西去降低它。
     * 所以：默认不发这个要求；要看真实质量时显式打开，并用诊断里的 `episodeReason` 观察。
     */
    if (typeof raw.episodeGenerate === 'boolean') out.episodeGenerate = raw.episodeGenerate === true && on
    if (typeof raw.episodeInject === 'boolean') out.episodeInject = raw.episodeInject === true && on
    /*
     * 上锁后的两个时间参数（默认 `STAGE_REARM_MS` 5 分钟 / `STAGE_COOLDOWN_MS` 30 秒）。
     * 它们成对出现是有原因的：**只有重试窗口比冷却短时冷却才会命中** —— 默认参数下
     * 重试窗口长得多，所以先被上膛判定拦住；测试场景把两者一起调短才能在一场里跑两次生成。
     */
    if (Number.isFinite(raw.rearmMs) && raw.rearmMs > 0) out.rearmMs = raw.rearmMs
    if (Number.isFinite(raw.cooldownMs) && raw.cooldownMs > 0) out.cooldownMs = raw.cooldownMs
    if (raw.gate && typeof raw.gate === 'object' && !Array.isArray(raw.gate)) {
      if (Number.isFinite(raw.gate.minTurns) && raw.gate.minTurns > 0) out.minTurns = raw.gate.minTurns
      if (Number.isFinite(raw.gate.minTokens) && raw.gate.minTokens > 0) out.minTokens = raw.gate.minTokens
      /* State Refresh 档的窗口比例（N21-6）；不设就用 `FOLD_REFRESH_RATIO` */
      if (Number.isFinite(raw.gate.refreshRatio) && raw.gate.refreshRatio > 0) {
        out.refreshRatio = raw.gate.refreshRatio
      }
    }
  }
  return out
}

const kindEnabled = (policyValue, kind) => policyValue.kinds.includes(kind)

/* ---------------------------------------------------------------- 文件 IO */

/** 原子写：临时文件 → rename。失败时不动旧文件（与 S1 的 store 同一约定） */
function writeJsonAtomic(target, value) {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* 临时文件清不掉不是致命问题 */
    }
    throw error
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function sessionFilePath(sessionId, suffix) {
  return join(stateDir(), `${sessionId}${suffix}`)
}

/**
 * 读派生状态（只做**形状 + 水位**的轻检查）。
 *
 * 完整的 schema 执法在主进程的 `context-state-store`（TS），扩展侧拿不到它。
 * 所以这里故意只信「这份状态是不是给这个会话、水位是不是同一刻」这两件事：
 * 其余交给主进程的读取路径；扩展侧的最坏情况是**少注入一次**，不是注入错状态。
 */
function loadState(sessionId) {
  const state = readJson(sessionFilePath(sessionId, '.json'))
  if (!state || typeof state !== 'object') return { status: 'missing' }
  if (state.sessionId !== sessionId) return { status: 'invalid', reason: 'session-mismatch' }
  if (!state.task || typeof state.task !== 'object') return { status: 'invalid', reason: 'no-task' }
  return { status: 'ok', state }
}

function loadArchive(sessionId) {
  const archive = readJson(sessionFilePath(sessionId, '.archive.json'))
  if (!archive || typeof archive !== 'object' || !Array.isArray(archive.entries)) return null
  return archive
}

/** 合并归档元数据（按 ref 去重；最多保留最近 MAX_ARCHIVE_ENTRIES 条） */
const MAX_ARCHIVE_ENTRIES = 500

function mergeArchive(sessionId, additions, now, watermark) {
  const existing = loadArchive(sessionId)
  const entries = Array.isArray(existing?.entries) ? existing.entries.slice() : []
  const known = new Set(entries.map((e) => e?.ref))
  let added = 0
  for (const addition of additions) {
    if (!addition?.ref || known.has(addition.ref)) continue
    known.add(addition.ref)
    entries.push({
      ref: addition.ref,
      kind: addition.kind ?? 'tool',
      label: addition.label || 'tool',
      createdAt: now,
      tokens: addition.tokens ?? 0,
      recallable: addition.recallable ?? 'agent',
      sourceRange: addition.sourceRange ?? { from: '', to: '' },
      watermark: addition.watermark ?? watermark,
      contentStored: false
    })
    added++
  }
  if (!added) return { added: 0 }
  const trimmed = entries.length > MAX_ARCHIVE_ENTRIES ? entries.slice(entries.length - MAX_ARCHIVE_ENTRIES) : entries
  writeJsonAtomic(sessionFilePath(sessionId, '.archive.json'), {
    schemaVersion: 1,
    sessionId,
    updatedAt: now,
    entries: trimmed
  })
  return { added }
}

function findArchiveEntry(sessionId, ref) {
  const archive = loadArchive(sessionId)
  return archive?.entries?.find((entry) => entry?.ref === ref) ?? null
}

/* ---------------------------------------------------------------- 召回账本 */

/**
 * 召回账本（`<sessionId>.recall.json`）：只记「当前 active context 里
 * 召回内容占了多少 token」与「当前回合号」。宿主（`yan context recall`）
 * 用它做累计预算判定并回写；上下文钩子每轮用真实消息重算一遍
 * （账本与真实上下文对不上时以钩子为准）。
 */
function loadLedger(sessionId) {
  const ledger = readJson(sessionFilePath(sessionId, '.recall.json'))
  if (!ledger || typeof ledger !== 'object') return { turn: 0, activeTokens: 0 }
  return {
    turn: Number.isFinite(ledger.turn) ? ledger.turn : 0,
    activeTokens: Number.isFinite(ledger.activeTokens) ? ledger.activeTokens : 0
  }
}

function saveLedger(sessionId, ledger) {
  writeJsonAtomic(sessionFilePath(sessionId, '.recall.json'), ledger)
}

/* ---------------------------------------------------------------- 钩子实现 */

/**
 * 取当前会话的原始 entry 身份。
 * `sessionManager` 在 RPC 模式下由扩展上下文提供（§13.3 已核实）。
 */
function entryIdsFor(ctx, messages) {
  const manager = ctx?.sessionManager
  if (!manager || typeof manager.getBranch !== 'function') return null
  try {
    return alignEntryIds(manager.getBranch(), messages)
  } catch {
    return null
  }
}

function sessionIdOf(ctx) {
  const manager = ctx?.sessionManager
  try {
    const id = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : null
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * `context` 钩子：唯一的消息改写点。
 *
 * 顺序（每一步都基于上一步的结果，任一步异常就整轮放弃）：
 *   ① TTL 清理（上一轮召回的正文 → 存根）；
 *   ② Tool Sweep（kinds 含 `tool-sweep`）；
 *   ③ Task State 前置注入（kinds 含 `episode-fold` 且状态水位一致）；
 *   ④ 校验：`sweepViolations` 非空则整轮放弃（回退到原始消息）。
 */
async function onContext(event, ctx) {
  const messages = event?.messages
  if (!Array.isArray(messages) || messages.length === 0) return
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return
  const p = policy()

  try {
    let next = messages
    const currentTurn = userTurnCount(next)
    let swept = 0
    let injectedTaskState = false
    let injectedWorkingTrace = false
    let expiredRecalls = 0

    /* ① TTL：上一轮的召回正文只在当轮有效 */
    const cleaned = stripStaleRecalls(next, currentTurn)
    if (cleaned.changed) {
      next = cleaned.messages
      expiredRecalls = cleaned.changed
    }

    /*
     * 预算驱动的清扫（实施-05 S4）：估算已到工作集线时，**跳过收益门槛**再清一次 ——
     * 平时「收益太小、不值得动上下文」的判据，在这里让位于「这一轮本来就快装不下」。
     *
     * 为什么不在 `before_provider_request` 里做：清扫要改 messages，那是这个钩子的活；
     * 那边只能看与止损（abort）。两处用**同一份**预算与估算口径，诊断才对得上。
     */
    const budget = requestBudgetFor(ctx)
    const transcriptTokens = estimateMessagesTokens(next)
    const overWorkingSet = !!budget && transcriptTokens >= budget.workingSet

    /* ② Tool Sweep */
    if (kindEnabled(p, 'tool-sweep')) {
      const entryIds = entryIdsFor(ctx, next)
      if (entryIds) {
        const manager = ctx.sessionManager
        const watermark = watermarkOfEntries(manager.getEntries?.() ?? [])
        const planned = planToolSweep({
          messages: next,
          entryIds,
          watermark,
          /* 大窗口档把近期末尾放宽到 64K–96K（C-6）；小窗口保持 32K/48K */
          recentTail: recentTailFor(budget?.workingSet, p.recentTail),
          /*
           * 到线只放宽到 `forced*` 这一组（默认等于普通门槛）—— C-6 之前是直接清零，
           * “到线”本身就成了清扫理由。需要更激进时由策略显式调低这两个数。
           */
          sweep: overWorkingSet
            ? {
                ...p.sweep,
                minReclaimTokens: p.sweep.forcedMinReclaimTokens ?? p.sweep.minReclaimTokens,
                minReclaimRatio: p.sweep.forcedMinReclaimRatio ?? p.sweep.minReclaimRatio
              }
            : p.sweep,
          /*
           * 硬约束①：**本回合正在动的文件**不得清扫。呼叫方只给路径清单，判定在 context-safety。
           * 旧回合的编辑不在此列 —— 它们已经不在“正在使用”，否则清扫永远压不动。
           */
          opts: { activePaths: activePathsOf(next) }
        })
        if (overWorkingSet) {
          trace('context', {
            sessionId,
            hook: 'sweep-forced-by-budget',
            transcriptTokens,
            workingSet: budget?.workingSet ?? null,
            applied: planned.ok,
            reason: planned.ok ? null : planned.reason
          })
        }
        if (planned.ok) {
          const applied = applyToolSweep(next, planned.plan)
          if (applied.changed > 0) {
            const bad = sweepViolations(applied.messages, entryIds, { activePaths: activePathsOf(next) })
            if (bad.length === 0) {
              next = applied.messages
              swept = applied.changed
              sweepSeen.add(sessionId)
              /*
               * C-2b：轻量整理不产生 pi 的 `compaction_*` 事件，
               * 所以这一个动作只能由扩展自己留痕，否则界面上看不到它发生过。
               * `savedTokens` 是估算差（不是供应商口径）。
               */
              recordAction(sessionId, {
                kind: 'tool-sweep',
                status: 'applied',
                reclaimed: applied.changed,
                savedTokens: Math.max(0, transcriptTokens - estimateMessagesTokens(next))
              })
              mergeArchive(sessionId, planned.archiveEntries ?? [], Date.now(), watermark)
              /*
               * 阶段运行状态：sweep **只留痕、不上锁**（幂等且便宜，冷却会压住
               * 后续清理 —— 见 `context-stage-runtime.js` 里那条有意的例外）。
               */
              stageRuntimes['tool-sweep'].set(
                sessionId,
                recordStageObservation(stageRuntimeOf('tool-sweep', sessionId), {
                  now: Date.now(),
                  reclaimedCount: applied.changed
                })
              )
            } else {
              trace('context', { sessionId, hook: 'sweep-rejected', violations: bad })
              recordAction(sessionId, { kind: 'tool-sweep', status: 'rejected', reason: 'violations' })
            }
          }
        } else {
          trace('context', { sessionId, hook: 'sweep-skipped', reason: planned.reason, details: planned.details ?? null })
          recordAction(sessionId, { kind: 'tool-sweep', status: 'skipped', reason: planned.reason })
        }
      } else {
        const sm = ctx?.sessionManager
        const branchProbe = (() => {
          try {
            const b = sm?.getBranch?.()
            return Array.isArray(b)
              ? { len: b.length, firstKeys: b[0] ? Object.keys(b[0]).slice(0, 12) : null, types: b.slice(0, 6).map((e) => e?.type ?? null) }
              : { len: null, value: typeof b }
          } catch (e) {
            return { threw: String(e?.message ?? e) }
          }
        })()
        trace('context', {
          sessionId,
          hook: 'sweep-skipped',
          reason: 'entry-identity-unavailable',
          details: {
            hasSessionManager: !!sm,
            hasGetBranch: typeof sm?.getBranch === 'function',
            messages: Array.isArray(next) ? next.length : null,
            branch: branchProbe,
            align: (() => {
              try {
                const b = sm?.getBranch?.() ?? []
                const prod = contextEntries(b).filter(entryProducesMessage)
                return {
                  producing: prod.length,
                  entryRoles: prod.map((e) => entryMessageRole(e)),
                  msgRoles: Array.isArray(next) ? next.map((m) => m?.role ?? null) : null
                }
              } catch (e) {
                return { threw: String(e?.message ?? e) }
              }
            })()
          }
        })
        recordAction(sessionId, { kind: 'tool-sweep', status: 'skipped', reason: 'entry-identity-unavailable' })
      }
    }

    /*
     * ③ Task State 前置注入（freshness 分档，§16.2 第 3 条）。
     * `p.state.inject` 是**独立分路**（第四轮外部评审 P0-5）：关掉它 = shadow 模式，
     * 状态照生成、只是不进上下文 —— 出问题时不必把整个扩展拔掉。
     */
    if (kindEnabled(p, 'episode-fold') && p.state.inject) {
      const loaded = loadState(sessionId)
      if (loaded.status === 'ok') {
        const entries = ctx.sessionManager?.getEntries?.() ?? []
        /* `freshView`：只落后「用户刚开口的那一条」不算陈旧（见 context-producer 的说明） */
        const fresh = freshView(freshnessOf({ stateWatermark: loaded.state.sourceWatermark, entries }))
        const applied = applyFreshness(loaded.state.task, fresh)
        if (applied.task) {
          const text = renderTaskState(applied.task, {
            freshness: freshnessLabel(applied.tier),
            sourceHead: loaded.state.sourceWatermark?.entryCount
          })
          if (text) {
            const injected = injectTaskState(next, text)
            next = injected.messages
            injectedTaskState = injected.injected
            /*
             * 记下**真的注入了什么档位**：注入块本身不进任何落盘文件（它是临时消息），
             * 所以这条诊断行就是“契约头到底写了什么”在真实链路里的唯一取证点。
             */
            if (injected.injected) {
              recordAction(sessionId, {
                kind: 'episode-fold',
                status: 'injected',
                freshness: freshnessLabel(applied.tier),
                tokens: estimateTokens(text)
              })
              trace('context', {
                sessionId,
                hook: 'task-state-injected',
                freshness: freshnessLabel(applied.tier),
                sourceHead: loaded.state.sourceWatermark?.entryCount ?? null,
                tokens: estimateTokens(text),
                /*
                 * 条目状态分布：`skipped` 就是被 `activeTexts` 挡在注入块之外的旧条目
                 * （`superseded` / `resolved`）。渲染侧过滤了它们，但注入块不落盘 ——
                 * 这是「被推翻的旧决策真的没进去」唯一能取证的地方。
                 */
                items: stateItemCounts(applied.task),
                /* 排查用：水位之后到底多了几条、都是什么（只看 gap 数字排查不了） */
                gap: fresh.gap,
                turnsGap: fresh.turnsGap,
                pendingOnly: fresh.pendingOnly === true,
                tail: tailRolesOf(entries, loaded.state.sourceWatermark)
              })
            }
            if (applied.tier !== 'fresh') {
              trace('context', {
                sessionId,
                hook: 'task-state-freshness',
                tier: applied.tier,
                gap: fresh.gap,
                stale: applied.stale,
                dropped: applied.dropped
              })
            }
          }
        } else {
          /* 太旧 / 对不上：**不注入**比注入一份过期世界模型安全（宁少不错） */
          trace('context', { sessionId, hook: 'task-state-skipped', reason: `freshness-${applied.tier}`, gap: fresh.gap })
          recordAction(sessionId, {
            kind: 'episode-fold',
            status: 'skipped',
            reason: `freshness-${applied.tier}`
          })
        }
      }
    }

    /*
     * ④ Deep Context（N21-8，默认关）：回答之前先把**工作集**归纳一遍。
     * 与 ③ 的分工：③ 给的是跨会话累积的持久状态（决策 / 约束 / 未决），
     * ④ 给的是「当前这件事进行到哪了」；两者可以同时在。
     * 这一步会真的**等一次模型调用**（语义如此：归纳必须在请求发出前完成），
     * 所以四道闸门（开关 / 新用户消息 / 没跑过 / 转录够长）缺一不可。
     */
    if (p.deep.enabled) {
      const deep = await runDeepPass({ sessionId, ctx, messages: next, p })
      if (deep.injected) {
        next = deep.messages
        injectedWorkingTrace = true
      }
    }

    /*
     * 召回账本用**真实消息**重算（账本记录当轮回合号，供工具包装召回内容用）。
     *
     * 只在「召回真的可能发生时」才落盘（`tool-sweep` / `recall` 已接管）：
     * 若显式把 `kinds` 收窄到只有 `compaction`，就不该给每个会话都多出一份文件。
     * 为什么不能“有召回才写”：工具要拿当轮回合号给召回内容打 TTL 标记，
     * 而第一次召回的**那一刻**账本还不存在 —— 那时只能读到 0，会让刚召回
     * 的正文在同一回合的下一个请求里就被误清理（实测踩过：模型被迫二次召回）。
     */
    if (kindEnabled(p, 'tool-sweep') || kindEnabled(p, 'recall')) {
      const active = activeRecallTokens(next)
      const ledger = loadLedger(sessionId)
      if (ledger.activeTokens !== active || ledger.turn !== currentTurn) {
        saveLedger(sessionId, { turn: currentTurn, activeTokens: active })
      }
    }

    if (swept === 0 && !injectedTaskState && !injectedWorkingTrace && expiredRecalls === 0) return
    trace('context', {
      sessionId,
      hook: 'context',
      swept,
      injectedTaskState,
      injectedWorkingTrace,
      expiredRecalls,
      activeRecallTokens: activeRecallTokens(next)
    })
    return { messages: next }
  } catch (error) {
    trace('context', { sessionId, hook: 'error', message: errorText(error) })
    return undefined
  }
}

/**
 * 当前上下文的用量（token）。
 *
 * 优先问 pi（`ctx.getContextUsage()`，方案 §16.1）—— 它才是权威口径；
 * 拿不到时退回 `transcriptStats` 的估算（那个口径只用于相对比较，所以**只当退路**）。
 */
function transcriptTokensOf(ctx) {
  const direct = Number(ctx?.getContextUsage?.()?.tokens)
  if (Number.isFinite(direct) && direct > 0) return direct
  const entries = ctx?.sessionManager?.getEntries?.() ?? []
  return transcriptStats(entries).tokens
}

/** `complete()` 的返回形状随 provider 而异，这里只认几种常见的；认不出就当没产出 */
function resultTextOf(result) {
  if (typeof result === 'string') return result
  if (typeof result?.text === 'string') return result.text
  if (Array.isArray(result?.content)) {
    return result.content.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('\n')
  }
  if (typeof result?.message?.content === 'string') return result.message.content
  return ''
}

/**
 * Deep Context（N21-8）的 Pass 1 + Pass 2。
 *
 * 任何失败都**静默降级为「不注入」** 并留一条诊断 —— 这是一次可选优化，
 * 它出问题不该影响用户这一轮能不能正常提问（宁可少一份归纳，不要卡住输入）。
 *
 * `ctx.modelRegistry.complete()` 是扩展侧唯一能自己发起模型调用的通道（§16.1）。
 * 它**不经过会话循环**，所以不会递归触发 `context` 钩子。
 */
async function runDeepPass({ sessionId, ctx, messages, p }) {
  const key = turnKeyOf(messages)
  const ranForTurn = !!key && deepRan.get(sessionId) === key
  const tokens = transcriptTokensOf(ctx)
  const verdict = deepEligible({
    enabled: true,
    tokens,
    minTokens: p.deep.minTokens,
    hasNewTurn: !!key,
    ranForTurn
  })
  if (!verdict.ok) {
    trace('deep', { sessionId, stage: 'deep', hook: 'skipped', reason: verdict.reason, tokens })
    return { injected: false }
  }
  const registry = ctx?.modelRegistry
  const model = ctx?.model
  if (typeof registry?.complete !== 'function' || !model) {
    trace('deep', { sessionId, stage: 'deep', hook: 'skipped', reason: 'no-model-registry', tokens })
    return { injected: false }
  }
  const materials = buildDeepInput(messages)
  if (!materials.text) {
    trace('deep', { sessionId, stage: 'deep', hook: 'skipped', reason: 'no-materials', tokens })
    return { injected: false }
  }
  /*
   * 先记「跑过了」再调用：超时或失败也不重试 ——
   * 否则一次卡住的请求会让后面每一轮都再等 30s，把「慢」变成「不可用」。
   */
  deepRan.set(sessionId, key)
  if (deepRan.size > 200) deepRan.clear()
  const startedAt = Date.now()
  let text = ''
  try {
    const result = await registry.complete(
      model,
      {
        systemPrompt: DEEP_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildDeepPrompt(materials.text) }] }]
      },
      { maxTokens: DEEP_MAX_OUTPUT_TOKENS, signal: AbortSignal.timeout(DEEP_TIMEOUT_MS) }
    )
    text = resultTextOf(result)
  } catch (error) {
    trace('deep', { sessionId, stage: 'deep', hook: 'error', ms: Date.now() - startedAt, message: errorText(error) })
    return { injected: false }
  }
  const parsed = parseDeepOutput(text)
  if (!parsed.ok) {
    trace('deep', { sessionId, stage: 'deep', hook: 'empty', reason: parsed.reason, ms: Date.now() - startedAt })
    return { injected: false }
  }
  const block = renderWorkingTrace(parsed.text, { turns: materials.count })
  const applied = injectWorkingTrace(messages, block)
  trace('deep', {
    sessionId,
    stage: 'deep',
    hook: 'injected',
    ms: Date.now() - startedAt,
    inputTokens: materials.tokens,
    outputChars: parsed.text.length,
    blockTokens: estimateTokens(block)
  })
  return { injected: applied.injected, messages: applied.messages }
}

/**
 * `session_before_compact` 钩子：结构化压缩的**接管闸门**。
 *
 * 接管条件（N21-4 生成器落地后放宽，§16.6.2）：
 *   ① 状态文件存在（`loadState` 为 ok）；
 *   ② 水位按 **freshness 分档**可用 —— 完全一致最好，“有效但较早”也接（带 stale 标记），
 *      对不上就交回 pi 原生摘要（不是“必须完全一致”）；
 *   ③ `buildStructuredSummary` 通过 —— 它不再要求六类字段齐备，
 *      `requiredFields` 默认为空数组（形状合法性由 schema 校验负责）。
 * 接管时保留 pi 给的 `firstKeptEntryId` 与 `tokensBefore`（我们只换摘要文本）。
 */
/**
 * pi 的「整轮压缩失败 / 被取消」（`session_compact_failed`）—— C-3 取证用。
 *
 * 为什么单独记：`reason=overflow` 只说 pi 走了恢复路径，不说**为何**。
 * provider 的错误原文（`errorMessage`）只在这个事件里；没有它，
 * 「端点容量不足」与「请求形状被拒」在日志里长得一模一样。
 */
function onCompactFailed(event, ctx) {
  trace('compact-failed', {
    sessionId: sessionIdOf(ctx),
    reason: event?.reason ?? null,
    aborted: !!event?.aborted,
    willRetry: !!event?.willRetry,
    fromExtension: !!event?.fromExtension,
    errorMessage: String(event?.errorMessage ?? '').slice(0, 700)
  })
}

function onBeforeCompact(event, ctx) {
  const sessionId = sessionIdOf(ctx)
  /*
   * 「钩子**被调到**」本身是一条独立事实，必须在任何早退之前记下来。
   * 在此之前分不清两种情况：pi 压根没调（prepareCompaction 返回 falsy 时它直接跳过），
   * 还是调了但我们在某个分支里早退 —— 两者的日志**都是空的**，排查只能靠猜。
   * 它只在压缩真的发生时产生，不会污染常规运行的日志。
   */
  trace('compact', {
    sessionId,
    stage: 'compact',
    hook: 'entered',
    hasPreparation: !!event?.preparation,
    reason: event?.reason ?? null
  })
  if (!sessionId) return
  const p = policy()
  /*
   * 与注入同一条分路（第四轮外部评审 P0-5）：`inject=false` 的含义是
   * 「不让派生状态进入发给模型的上下文」，压缩接手也属于其中。
   * 关掉它不会连带停掉生成（那是 `state.generate` 的事）。
   */
  if (!p.state.inject) {
    trace('compact', { sessionId, stage: 'compact', hook: 'fallback', reason: 'inject-off' })
    return
  }
  try {
    const loaded = loadState(sessionId)
    if (loaded.status !== 'ok') {
      trace('compact', { sessionId, stage: 'compact', hook: 'fallback', reason: 'no-state' })
      return
    }
    const entries = ctx.sessionManager?.getEntries?.() ?? []
    const state = loaded.state
    /*
     * 水位判定改用 freshness 分档（同注入路径）：完全一致最好，
     * “有效但较早”也接（带 stale 标记）；对不上就不接 —— 交回 pi 原生摘要。
     */
    const fresh = freshView(freshnessOf({ stateWatermark: state.sourceWatermark, entries }))
    const applied = applyFreshness(state.task, fresh)
    if (!applied.task) {
      trace('compact', { sessionId, stage: 'compact', hook: 'fallback', reason: `freshness-${applied.tier}`, gap: fresh.gap })
      return
    }
    const built = buildStructuredSummary(
      { ...state, task: applied.task },
      /*
       * 头行要写**真实**档位，不能默写 fresh（它已经是 stale-soft / stale-hard）；
       * `includeEpisodes` 是 Episode 的消费门：默认关（只生成不消费），
       * 放行由 `YAN_CONTEXT_POLICY.state.episodeInject` 控制。
       */
      { freshness: freshnessLabel(applied.tier), includeEpisodes: p.state.episodeInject === true }
    )
    if (!built.ok) {
      trace('compact', { sessionId, stage: 'compact', hook: 'fallback', reason: built.reason, missing: built.missing ?? null })
      return
    }
    const preparation = event?.preparation ?? {}
    const firstKeptEntryId = preparation.firstKeptEntryId
    const tokensBefore = Number(preparation.tokensBefore)
    if (typeof firstKeptEntryId !== 'string' || !firstKeptEntryId || !Number.isFinite(tokensBefore)) {
      trace('compact', { sessionId, stage: 'compact', hook: 'fallback', reason: 'bad-preparation' })
      return
    }
    trace('compact', { sessionId, stage: 'compact', hook: 'takeover', fields: built.fields, tier: applied.tier, gap: fresh.gap })
    return { compaction: { summary: built.summary, firstKeptEntryId, tokensBefore } }
  } catch (error) {
    trace('compact', { sessionId, stage: 'compact', hook: 'error', message: errorText(error) })
    return undefined
  }
}

/* ---------------------------------------------------------------- 状态生成器（N21-4 剩余项） */

/**
 * `sessionManager.getEntries()` → 与 `entryIds` 等长的消息数组。
 *
 * 为什么要自己配对：`onContext` 用的是 `event.messages`（模型即将看到的上下文），
 * 而 `agent_settled` 只给得到 entry 列表。两者必须用**同一套**「哪条 entry
 * 产生哪条消息」的规则，否则 evidence 里的 `entryId` 会贴到别的条目上
 * （那会让 Recall 取回别人的历史）。配对不成功就返回 null —— 宁可这次不生成。
 */
function messagePairsFromEntries(entries) {
  const list = contextEntries(entries)
  const messages = []
  const entryIds = []
  for (const entry of list) {
    if (!entryProducesMessage(entry)) continue
    if (typeof entry.id !== 'string' || !entry.id) return null
    let message = null
    if (entry.type === 'message') message = entry.message ?? null
    else if (entry.type === 'custom_message') message = { role: 'custom', summary: entry.summary ?? '' }
    else if (entry.type === 'branch_summary') message = { role: 'branchSummary', summary: entry.summary ?? '' }
    else if (entry.type === 'compaction') message = { role: 'compactionSummary', summary: entry.summary ?? '' }
    if (!message) return null
    messages.push(message)
    entryIds.push(entry.id)
  }
  return messages.length ? { messages, entryIds } : null
}

/** 生成器一次调用的墙钟上限（§16.6.1 建议 20s；超时保留旧状态，绝不落半成品） */
const PRODUCER_TIMEOUT_MS = 20_000
/*
 * 本地模型通常把结构化 JSON 生成放在同一个 llama.cpp 槽位里，
 * 速度明显慢于在线模型；只放宽它，不改变在线模型的 20s 失败边界。
 * 仍然是有界等待，超时继续保留旧状态，绝不落半成品。
 */
const LOCAL_PRODUCER_TIMEOUT_MS = 45_000
/** 输出上限：状态是短 JSON，给太多会让模型写散文 */
const PRODUCER_MAX_TOKENS = 1_200

/**
 * 单飞标志（§16.6.1）。epoch 用 sessionId 代替：换会话 = 换 epoch，
 * 旧会话的结果在 CAS 阶段自然被拒（不需要显式的 epoch 对账）。
 */
let producerFlight = null

/**
 * 会话级 eligibility gate 的两个会话内标记（第四轮外部评审第四问 A）。
 *
 * 都是**进程内**状态，不落盘：
 *   · `sweepSeen`   —— 本会话真的清扫过东西（说明上下文已经大到需要回收）；
 *   · `foldSticky`  —— 本会话已经满足过激活条件（一旦命中不再退回）。
 * 为什幺要 sticky：压缩之后用量会掉下来，不 sticky 会出现「开→关→开」，
 * 状态生命周期会变得没有意义。进程重启后重新判定是可接受的代价。
 */
const sweepSeen = new Set()
const foldSticky = new Set()

/*
 * 阶段运行状态（方案 §12.3）——两个由**本扩展**执行的阶段各一份。
 *
 * 为什么放在会话内、而不是落盘：重启后状态回到「新阶段」（armed、无冷却），
 * 最坏结果是下一次多跑一遍 —— 比落一份要维护、要版本化的账便宜得多。
 * `compaction` 的状态不在（它在主进程，见 `context-stage-runtime.js` 的说明）。
 *
 * 键是会话 id，所以同时开着几个会话时它们互不影响；上限只是防长跑的实例里
 * 无界增长（丢最旧的一个 = 那个会话下一次多跑一遍，不是错误）。
 */
const MAX_STAGE_RUNTIMES = 200
const stageRuntimes = { 'tool-sweep': new Map(), 'episode-fold': new Map() }

function stageRuntimeOf(stage, sessionId) {
  const map = stageRuntimes[stage]
  const existing = map.get(sessionId)
  if (existing) return existing
  if (map.size >= MAX_STAGE_RUNTIMES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  const fresh = createStageRuntime()
  map.set(sessionId, fresh)
  return fresh
}

/**
 * 记一次生成器的真实执行结果并上锁（§12.3）。
 *
 * 成功与失败**都**要 disarm：失败时更需要冷却 —— 否则下一轮会在同样的输入上
 * 再烧一次调用（模型持续返回坏 JSON 时，这就变成「每轮一次」）。
 */
function noteFoldRun(sessionId, ok) {
  /* 冷却可配（默认 30s）：与 `rearmMs` 成对使用，见 `stateSwitches` 里的说明 */
  const cooldownMs = policy().state.cooldownMs || undefined
  stageRuntimes['episode-fold'].set(
    sessionId,
    recordStageRun(stageRuntimeOf('episode-fold', sessionId), { now: Date.now(), ok, cooldownMs })
  )
}
/*
 * Deep Context 的「同一条用户消息只跑一次」记忆（sessionId → turnKey）。
 * 只活在进程内：重启后多跑一次是可接受的（宁可多花一次，也不要在磁盘上留一份要维护的账）。
 */
const deepRan = new Map()

/** freshness 分档 → 注入契约里的 `freshness`（机器可读，取值只有三个） */
function freshnessLabel(tier) {
  if (tier === 'fresh') return 'fresh'
  if (tier === 'stale-hard') return 'stale'
  return 'partial'
}

function contentTextOf(response) {
  const content = response?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 一次生成尝试的 token 开销（估算口径统一）。
 *
 * 为什么失败路径也记：**失败也花钱**（20s 超时 / 返回空文本 / JSON 解析失败都是真的调了模型），
 * 只统计成功那几次会把开销系统性低估。
 */
function producerUsage(prompt, text, response) {
  const real = response?.usage
  const realIn = real && typeof real === 'object' ? Number(real.input) || 0 : 0
  const realOut = real && typeof real === 'object' ? Number(real.output) || 0 : 0
  /*
   * 「pi 给了 usage」不等于「数字有意义」：请求失败（超时 / 空响应）时 pi 会把
   * 一个 input/output 全 0 的 usage 递过来。若直接当真实值用，诊断会显示
   * 「生成开销 = 0」——比不显示更误导（实测于 2026-09-17 晚的 not-json 路径）。
   * 所以两个都取 0 时当作「没拿到」，让消费方退回估算。
   */
  const realUsable = realIn > 0 || realOut > 0
  return {
    input: estimateTokens(prompt),
    output: estimateTokens(text || ''),
    /* pi 到底给不给真实 usage：记个布尔，下次排查不用再猜 */
    reported: !!real,
    /* 有没有可用的真实数字（可能与 reported 不一致，见上） */
    realUsable,
    /* 给了就把数字也留下 —— 估算值与真实值可以对账（实测 pi 0.85.1 是给的） */
    real:
      real && typeof real === 'object'
        ? {
            input: realIn,
            output: realOut,
            cacheRead: Number(real.cacheRead) || 0
          }
        : null
  }
}

/**
 * `agent_settled`：状态生成器的唯一触发点。
 *
 * 为什么只在这里：① 它是「这一轮真的结束了」的稳定边界（retry / follow-up 都跑完）；
 * ② 生成要读整回合的 evidence，中途生成只会拿到半截会话；
 * ③ 绝不能阻塞下一次输入 —— 整个流程异步，失败就保留旧状态。
 */
function onAgentSettled(_event, ctx) {
  const p = policy()
  /*
   * 总闸是 `episode-fold`（2026-09-18 起**在默认接管集里** —— 但「在集合里」只
   * 意味着**允许**生成，真正跑不跑由下面这道会话级门槛决定：短会话照样不花钱）；
   * 闸内还有两条独立分路（`p.state.generate` /
   * `p.state.inject`，第四轮外部评审 P0-5）与一道**会话级门槛**（`foldEligible`，
   * 第四问 A）：短会话不生成 —— 它没有东西可折叠，却要背上「语义状态变成
   * 下一轮推理输入」的闭环误差风险。
   */
  const sessionId = sessionIdOf(ctx)
  if (!kindEnabled(p, 'episode-fold') || !p.state.generate) {
    /*
     * 关闭时的**正面证据**（P2-7）。
     *
     * 默认接管集里含 `episode-fold`，所以这条分支在默认状态下走不到；
     * 它一旦出现，就是「用户关掉了」或「env 显式排除了」的真实取证。
     * 为什么必须留痕：`contextfoldpref` 要断言「生成器一次都没跑」——
     * **没有痕迹的否定**无法与「扩展压根没加载」区分开，而这两件事的处置完全不同。
     * 把解析后的 `kinds` 一并写进去，证据就不必再靠推断（它同时钉住了
     * 「扩展真的读到了 desktop.json」）。
     */
    if (sessionId) {
      trace('producer', {
        sessionId,
        stage: 'producer',
        hook: 'skipped',
        reason: kindEnabled(p, 'episode-fold') ? 'generate-off' : 'kind-off',
        kinds: p.kinds
      })
    }
    return
  }
  if (!sessionId) return
  if (!foldSticky.has(sessionId)) {
    const stats = transcriptStats(ctx?.sessionManager?.getEntries?.() ?? [])
    /*
     * State Refresh 档（N21-6）要一个「窗口有多大」的近似值。`ctx.model` 是 pi 暴露的
     * 当前模型对象，实测能拿到 `contextWindow`（拿不到就是 0 → 那条分支自动跳过）；
     * 把值一并记进诊断，以后再出问题不用猜。
     */
    const windowTokens = Number(ctx?.model?.contextWindow) || 0
    /*
     * 整轮软线（C-6）：状态刷新的准备线不再只看固定 48K，
     * 而是 `max(48K, 软线 × 60%)`。拿不到预算时 softLine=0，行为与以前一致。
     */
    const foldBudget = requestBudgetFor(ctx)
    const gate = foldEligible({
      settledTurns: stats.userTurns,
      transcriptTokens: stats.tokens,
      firstSweep: sweepSeen.has(sessionId),
      windowTokens,
      softLine: foldBudget?.triggers?.compact ?? 0,
      ...(p.state.minTurns ? { minTurns: p.state.minTurns } : {}),
      ...(p.state.minTokens ? { minTokens: p.state.minTokens } : {}),
      ...(p.state.refreshRatio ? { refreshRatio: p.state.refreshRatio } : {})
    })
    if (!gate.eligible) {
      trace('producer', {
        sessionId,
        stage: 'producer',
        hook: 'gate',
        reason: gate.reason,
        turns: stats.userTurns,
        tokens: stats.tokens,
        window: windowTokens
      })
      return
    }
    foldSticky.add(sessionId)
    trace('producer', {
      sessionId,
      stage: 'producer',
      hook: 'gate',
      reason: gate.reason,
      activated: true,
      window: windowTokens
    })
  }
  if (producerFlight) {
    trace('producer', { sessionId, stage: 'producer', hook: 'skipped', reason: 'in-flight' })
    return
  }
  producerFlight = { sessionId, startedAt: Date.now() }
  void produceAndCommit(sessionId, ctx).finally(() => {
    producerFlight = null
  })
}

/**
 * 上一次折叠到哪里（§12.6）。
 *
 * 取最后一条 Episode 的 `sourceRange.to`，作为下一次窗口的起点 —— 没有它就会
 * 对同一段反复归纳（幂等靠 id 兜底，但白花模型输出）。
 */
function lastEpisodeTo(state) {
  const list = Array.isArray(state?.episodes) ? state.episodes : []
  const last = list[list.length - 1]
  return last?.sourceRange?.to ?? null
}

/**
 * 生成 → 合并 → CAS 落盘。任一环节失败都**不动**旧状态文件。
 */
async function produceAndCommit(sessionId, ctx) {
  try {
    /* 这一次生成要用的开关（`inject` 分路用到；`policy()` 一个回合内会调多次，有缓存） */
    const p = policy()
    const entries = ctx?.sessionManager?.getEntries?.() ?? []
    const pairs = messagePairsFromEntries(entries)
    if (!pairs) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: 'no-message-identity' })
      return
    }
    /*
     * 生成器输入的自净（第四轮外部评审 P0-1）：把**我们注入/改写过的内容**
     * 从输入里剔掉，免得「漂移」变成「递归压缩」。详见 `stripSyntheticMessages`。
     */
    const cleaned = stripSyntheticMessages(pairs.messages, pairs.entryIds)
    if (!cleaned.messages.length) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: 'no-real-input' })
      return
    }
    if (cleaned.removed) {
      trace('producer', { sessionId, stage: 'producer', hook: 'input-cleaned', removed: cleaned.removed })
    }
    const loaded = loadState(sessionId)
    const previous = loaded.status === 'ok' ? loaded.state : null
    const watermark = watermarkOfEntries(entries)
    const evidence = evidenceFromMessages({ messages: cleaned.messages, entryIds: cleaned.entryIds })
    const fresh = freshnessOf({ stateWatermark: previous?.sourceWatermark, entries })
    /*
     * 落后**回合**数（不是条目数）：一个回合会产生多条 entry，用条目差算
     * 会让脏闸门提前触发、把权重（≥6）与净增（≥6000）两道门槛绕过去。
     * 水位条目定位不到（压缩 / 换分支）时退回条目差 —— 宁可多刷新一次，
     * 也不能因为数不出来就把闸门关掉。
     */
    const settledGap = previous
      ? fresh.relation === 'older'
        ? (fresh.turnsGap ?? fresh.gap)
        : fresh.relation === 'same'
          ? 0
          : 99
      : 0
    const mask = dirtyMaskWithEvidence(dirtyMask(entries), evidence)
    const decision = shouldRefresh({ stateMissing: !previous, mask, settledGap })
    if (!decision.needed) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: decision.reason, score: decision.score })
      return
    }

    const registry = ctx?.modelRegistry
    const model = ctx?.model
    if (!registry || typeof registry.complete !== 'function' || !model) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: 'no-model-registry' })
      return
    }

    /*
     * 阶段运行状态（方案 §12.3）：**到线之后**才检查上膛与冷却。
     *
     * 位置在脏判定与 registry 检查**之后**、模型调用**之前** —— 这才是「真的要花钱」
     * 的边界：放到脏判定前面会让纯只读回合也消耗冷却，放到模型调用后面就等于没防住。
     * 环境问题（拿不到 registry）也不该消耗阶段状态，所以这一步在它后面。
     *
     * `rearmMs` / `cooldownMs` 默认是 5 分钟 / 30 秒（两次生成之间的**最小间隔**）：
     * 扩展侧拿不到主进程的工作集，所以「用量回落」那条重新上膛路径在这里不成立，
     * 真正起节流作用的就是这两个参数 —— 失败后 5 分钟内不再重试（否则模型持续返回
     * 坏 JSON 时就是每轮一次）。默认参数下**先被上膛判定拦住**，冷却要等重试窗口
     * 缩短之后才会命中（测试场景就是这么做的）。
     */
    const step = stageStep({
      runtime: stageRuntimeOf('episode-fold', sessionId),
      now: Date.now(),
      /* 默认 5 分钟 / 30 秒；两者都可由 `YAN_CONTEXT_POLICY.state.{rearmMs,cooldownMs}` 调短 */
      rearmMs: p.state.rearmMs || STAGE_REARM_MS,
      cooldownMs: p.state.cooldownMs || STAGE_COOLDOWN_MS
    })
    if (!step.run) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skipped', reason: step.reason })
      return
    }
    stageRuntimes['episode-fold'].set(sessionId, step.runtime)

    const directives = userDirectives(cleaned.messages, cleaned.entryIds)
    /*
     * 可引用清单（第五轮外部意见 Q1 的 P0-③ provenance）：**只装本轮材料** ——
     * 用户原话与确定性 reducer 证据。上一版状态的 id 刻意不在其中，
     * 所以「因为上一版这么说」不能充当证据（那正是语义递归固化的通道）。
     */
    const citable = citableEntries({ directives, evidence })
    /*
     * Episode 的候选区间（§12.6）：**确定性边界** —— 从「上一次折叠到哪里」
     * 到「已经离开 `recentTail` 窗口」的最后一条。窗口为 null（历史太短、或全在
     * 活跃窗口里）时就不做 Episode —— 那是正常的「没有可折叠的东西」，不是失败。
     *
     * **只在生成门开着时才算**（默认关，见 `stateSwitches` 里那段实测说明）：
     * 它决定提示词里要不要多要一个对象，而那个额外要求会拉低整次生成的成功率。
     */
    const episodeWin = p.state.episodeGenerate
      ? episodeWindow({
          messages: cleaned.messages,
          entryIds: cleaned.entryIds,
          recentTail: p.recentTail,
          minEntries: p.episodes.minEntries,
          minTokens: p.episodes.minTokens,
          coveredThrough: lastEpisodeTo(previous)
        })
      : null
    /*
     * 窗口本身也单独留一行诊断。
     *
     * 为什么不等 committed 再报：窗口是在**模型调用之前**算出来的，而模型输出是
     * 它自己的自由文本（`not-json` 拒收很常见）。把证据绑在 committed 行上，
     * 就会出现「边界算出来了、但因为模型没吐合法 JSON 所以看不到」的假缺口。
     */
    if (episodeWin) {
      trace('producer', {
        sessionId,
        stage: 'producer',
        hook: 'episode-window',
        entries: episodeWin.entryIds.length,
        tokens: episodeWin.tokens,
        from: episodeWin.from,
        to: episodeWin.to
      })
    }
    const prompt = buildProducerPrompt({
      previousTask: previous?.task,
      directives,
      evidence,
      citable,
      episodeWin
    })
    const controller = new AbortController()
    const producerTimeoutMs = model?.provider === 'local' ? LOCAL_PRODUCER_TIMEOUT_MS : PRODUCER_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), producerTimeoutMs)
    let response
    try {
      response = await registry.complete(
        model,
        {
          systemPrompt: PRODUCER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }]
        },
        { maxTokens: PRODUCER_MAX_TOKENS, signal: controller.signal }
      )
    } catch (error) {
      trace('producer', { sessionId, stage: 'producer', hook: 'error', message: errorText(error) })
      recordAction(sessionId, { kind: 'episode-fold', status: 'failed', reason: 'model-error' })
      noteFoldRun(sessionId, false)
      return
    } finally {
      clearTimeout(timer)
    }
    if (response?.stopReason === 'aborted') {
      trace('producer', { sessionId, stage: 'producer', hook: 'aborted', usage: producerUsage(prompt, '', response) })
      recordAction(sessionId, { kind: 'episode-fold', status: 'failed', reason: 'aborted' })
      noteFoldRun(sessionId, false)
      return
    }

    const text = contentTextOf(response)
    const usageTokens = producerUsage(prompt, text, response)
    const parsed = parseProducerOutput(text)
    if (!parsed.ok) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: parsed.reason, sample: text.slice(0, 200), usage: usageTokens })
      recordAction(sessionId, { kind: 'episode-fold', status: 'failed', reason: parsed.reason })
      noteFoldRun(sessionId, false)
      return
    }
    const merged = mergeTaskState({ semantics: parsed.value, evidence, previous: previous?.task, directives, citable, now: Date.now() })
    if (!merged) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: 'merge-failed', usage: usageTokens })
      recordAction(sessionId, { kind: 'episode-fold', status: 'failed', reason: 'merge-failed' })
      noteFoldRun(sessionId, false)
      return
    }
    /*
     * Episode 的合并（§12.6）：`unresolved` 非空时 `episodeCandidate` 已经返回 null，
     * 所以这里接到的要么是「一段真的收束了的历史」，要么是空的 —— 不会出现半收束。
     */
    const episodeMerge = mergeEpisodeState({
      candidate: parsed.episode,
      /* 模型没给 / 给了但没收束 —— 诊断里要能分开（决定要不要改提示词） */
      candidateReason: parsed.episodeReason,
      window: episodeWin,
      previous: previous?.episodes,
      watermark,
      now: Date.now()
    })
    /* 工作集在扩展侧拿不到（那是主进程的策略），用它自己的硬上限即可 */
    const clipped = clipTaskStateToBudget(merged, 0)
    if (clipped.over) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: 'over-budget', tokens: clipped.tokens, usage: usageTokens })
      recordAction(sessionId, { kind: 'episode-fold', status: 'failed', reason: 'over-budget' })
      noteFoldRun(sessionId, false)
      return
    }

    /* CAS：读到的 revision 必须仍是生成开始前那一个（§16.6.1） */
    const currentRaw = readJson(sessionFilePath(sessionId, '.json'))
    const allowed = casAllows({
      current: {
        revision: Number.isFinite(currentRaw?.revision) ? currentRaw.revision : 0,
        entryCount: Number(currentRaw?.sourceWatermark?.entryCount) || 0
      },
      precondition: {
        expectedRevision: Number.isFinite(previous?.revision) ? previous.revision : 0,
        baseEntryCount: previous?.sourceWatermark?.entryCount ?? 0
      }
    })
    if (!allowed.ok) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: allowed.reason, expected: allowed.expected, revision: allowed.revision })
      recordAction(sessionId, { kind: 'episode-fold', status: 'failed', reason: allowed.reason })
      noteFoldRun(sessionId, false)
      return
    }

    const state = buildStateFile({
      sessionId,
      watermark,
      /*
       * 引用汇总（§13.4）：把 Episode 的 id 与重要引用并进 TaskState。
       * **跟着消费门一起关** —— `archiveRefs` 会出现在 `<TASK_STATE>` 的
       * 「Archived history」一节（模型可见），而 shadow 的含义是字面「不进任何
       * 模型可见路径」。放行时这里会自动跟着 `episodeInject` 一起打开（一行的事）。
       */
      task: p.state.episodeInject ? mergeEpisodeRefs(clipped.task, episodeMerge.episodes) : clipped.task,
      episodes: episodeMerge.episodes,
      /*
       * 旁路防线（第四轮外部评审 P0-4）到本切片为止已被**取代**：Episode 不再来自
       * 「沿用上一版旧语义」，而是我们自己按**确定性边界 + 收束判据**生成并校验的。
       * 但它仍然**默认不消费**（只落盘）—— 消费门是 `state.episodeInject`，
       * 见 `buildStructuredSummary` 的 `includeEpisodes`。
       */
      now: Date.now(),
      revision: allowed.revision + 1
    })
    writeJsonAtomic(sessionFilePath(sessionId, '.json'), state)
    noteFoldRun(sessionId, true)
    /*
     * C-2b：状态刷新（episode-fold）同样不产生 pi 事件 ——
     * 成功也要留痕，否则「这一轮状态到底刷过没」在界面上无从得知。
     */
    recordAction(sessionId, {
      kind: 'episode-fold',
      status: 'applied',
      reason: decision.reason,
      tokens: clipped.tokens,
      reclaimed: episodeMerge.added ? 1 : 0
    })
    trace('producer', {
      sessionId,
      stage: 'producer',
      hook: 'committed',
      revision: state.revision,
      files: evidence.files.length,
      commands: evidence.commandsRun.length,
      tests: evidence.testsRun.length,
      tokens: clipped.tokens,
      gap: fresh.gap,
      turnsGap: fresh.turnsGap,
      /*
       * provenance 分布。`hypothesis` 占比高 = 模型给不出证据（这些条目注入时会带
       * `inferred` 标记），也是「语义递归有没有被挡住」的唯一观测量。
       */
      provenance: provenanceCounts(clipped.task),
      citable: citable.length,
      usage: usageTokens,
      trigger: decision.reason,
      /* Episode 扇叠的观测点：加了 / 没加、以及没加的原因（not-sealed / no-window / no-watermark） */
      episodes: episodeMerge.added ? 1 : 0,
      episodeReason: episodeMerge.added ? null : episodeMerge.reason ?? null,
      episodeWindow: episodeWin ? episodeWin.entryIds.length : 0
    })
  } catch (error) {
    trace('producer', { sessionId, stage: 'producer', hook: 'error', message: errorText(error) })
    noteFoldRun(sessionId, false)
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------------------------------------------------------- 导出 */

export default function contextExtension(pi) {
  /*
   * 启动诊断：扩展侧看到的策略原文。
   * 「开关开了却没生效」第一个要排除的就是「env 到底有没有到这里」——
   * 主进程侧的策略视图（`resolveContextPolicy`）与扩展侧读的是两回事，
   * 界面显示正确并不代表扩展也读到了（它只认进程 env）。
   */
  trace('boot', {
    stage: 'boot',
    policy: (process.env.YAN_CONTEXT_POLICY ?? '').slice(0, 200),
    log: !!process.env.YAN_CONTEXT_EXT_LOG
  })
  pi.on('context', (event, ctx) => onContext(event, ctx))
  /*
   * 请求前的最后一眼（实施-05 S4）：估算超物理线就不发，并留诊断。
   * 位置有意放在 `context` 之后：清扫已经跑过，这里量到的是**真正要发**的体积。
   */
  pi.on('before_provider_request', (event, ctx) => onBeforeProviderRequest(event, ctx, pi))
  pi.on('session_before_compact', (event, ctx) => onBeforeCompact(event, ctx))
  /*
   * 压缩失败 / 被取消（C-3 取证）：`reason=overflow` 只说明 pi 走了恢复路径，
   * 说明不了**为什么** —— provider 的错误原文只出现在这个事件里。
   * 少了它，「端点容量不足」与「请求形状被拒」在日志里长得一模一样。
   */
  pi.on('session_compact_failed', (event, ctx) => onCompactFailed(event, ctx))
  /*
   * N21-4 生成器：`agent_settled` 是「这一轮真的结束」的稳定边界。
   * 只在 `kinds` 含 `episode-fold` 时才真的会调模型（见 onAgentSettled）。
   */
  pi.on('agent_settled', (event, ctx) => onAgentSettled(event, ctx))
}

/**
 * 供单测直接调用的内部函数（扩展默认导出之外）。
 * 命名带下划线，避免与 pi 的扩展 API 混淆。
 */
export const __internals = {
  policy,
  onContext,
  onBeforeProviderRequest,
  requestBudgetFor,
  onBeforeCompact,
  onAgentSettled,
  mergeArchive,
  findArchiveEntry,
  loadState,
  loadLedger,
  saveLedger,
  messagePairsFromEntries,
  contentTextOf,
  produceAndCommit,
  resetProducerFlight: () => {
    producerFlight = null
  },
  /* 阶段运行状态（§12.3）：sweep / fold 两份 map，测试之间要互不污染 */
  stageRuntimeOf,
  resetStageRuntimes: () => {
    stageRuntimes['tool-sweep'].clear()
    stageRuntimes['episode-fold'].clear()
  },
  /* 测试用：丢掉桌面端设置的缓存（否则改完 `YAN_DATA_DIR` 还要等 1 秒） */
  resetDeepCache: () => {
    desktopSettingsCache = { at: 0, value: {} }
  },
  /* 同上，名字与 `desktopSettings` 对齐（两个开关共用一份缓存） */
  resetDesktopSettingsCache: () => {
    desktopSettingsCache = { at: 0, value: {} }
  }
}
