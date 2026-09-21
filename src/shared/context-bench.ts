/**
 * N21-9 的 A/B 基准口径（实施-06 S2）。
 *
 * ════════════════════════════════════════════════════════════
 * 这一份回答什么、不回答什么
 * ════════════════════════════════════════════════════════════
 * 实施-06 §2 把 N21-9 定性为**架构决策基准**，不是给现实现做验收：它要回答的是
 * 「State-First / Trace 这两个策略值不值得保留」，因为那个结论决定
 * [实施-01] 那份**允许钩子白名单**的长度。所以这里只放**口径**：
 *
 *   · 四组对照策略**怎么用现有开关表达**（`BENCH_STRATEGIES`）；
 *   · 一份回答算不算「守住了约束」的**判分规则**（规则式，不用第二个模型打分 ——
 *     让模型给自己打分会把「策略收益」和「评委偏好」混在一起）；
 *   · 主判据（LCR 相对下降 ≥ 25% + 成功率 non-inferior −3pp）与三项副指标
 *     （state 开销 > 25%、矛盾率三档）。
 *
 * **它不跑的**：真实对照跑批（那要真实模型额度，见 `npm run bench:context`）。
 * 把口径冻在代码里、用单测钉住边界，是为了让**将来那次跑批**的结果可复核 ——
 * 数字变了要能区分「策略变了」还是「口径变了」。
 *
 * ⚠️ 结论的表述纪律（实施-06 §2）：只能写「**该策略在当前实现下的收益**」，
 * 不能反推「未来载体必须是 pi extension」。
 */
import type { ContextOperationKind } from './ipc'

/* ------------------------------------------------------------------ 四组策略 */

export type BenchStrategyId = 'A' | 'B' | 'C' | 'D'

export interface BenchStrategy {
  id: BenchStrategyId
  /** 界面上与文档里用的短名 */
  title: string
  /** 这一组**接管**哪些阶段（直接可写成 `YAN_CONTEXT_POLICY` 的 `kinds`） */
  kinds: ContextOperationKind[]
  /** 一句话说明它代表什么 */
  blurb: string
}

/**
 * 四组对照（实施-06 §2 的 A/B/C/D）。
 *
 * 映射到产品开关是**一对一**的：`kinds` 就是「砚接管哪些阶段」的完整表达
 * （见 `context-policy.ts` 的阶段边界注释）。所以这四组不需要新代码路径 ——
 * 它们跑的是**同一个产品的四种配置**，这正是「冻结现实现、只跑既定四组」的要求。
 *
 *   · A 原始长上下文：砚什么都不接管，pi 的原生压缩仍在物理线上兜底；
 *   · B 传统摘要：砚只调 pi 的 `compact()` —— 摘要由 pi 生成，砚不加状态；
 *   · C State-First：多出 `episode-fold`（确定性 reducer + 一次无工具 completion
 *     产出 `<TASK_STATE>`，压缩时以状态为第一手材料）；
 *   · D State-First + Trace：再多出 `tool-sweep` + `recall`（墓碑 + `ctx://`
 *     引用，被扫掉的原文仍可取回）。
 *
 * ⚠️ C 与 D 的差别**只在 Trace**。若 C 已经明显优于 B，而 D 相对 C 没有额外收益，
 * 那么「墓碑 + `ctx://` 引用」这套复杂度就该被削掉 —— 这是本基准最想看清的一件事。
 */
export const BENCH_STRATEGIES: readonly BenchStrategy[] = [
  {
    id: 'A',
    title: '原始长上下文',
    kinds: [],
    blurb: '砚不接管任何阶段：上下文一路涨到 pi 的物理线，由 pi 原生压缩兜底'
  },
  {
    id: 'B',
    title: '传统摘要',
    kinds: ['compaction'],
    blurb: '砚只在自己的工作集线上调 pi 的 compact()，摘要由 pi 生成，砚不注入状态'
  },
  {
    id: 'C',
    title: 'State-First',
    kinds: ['compaction', 'episode-fold'],
    blurb: '在 B 之上让任务状态先落地（<TASK_STATE> 注入），压缩以状态为第一手材料'
  },
  {
    id: 'D',
    title: 'State-First + Trace',
    kinds: ['tool-sweep', 'recall', 'compaction', 'episode-fold'],
    blurb: '在 C 之上加墓碑与 ctx:// 引用：被扫掉的工具原文仍可取回（= 产品默认集）'
  }
]

/** 按 id 取一组；未知 id 抛出（基准跑批里写错策略名必须立刻看得见，不静默退回 A） */
export function benchStrategy(id: string): BenchStrategy {
  const hit = BENCH_STRATEGIES.find((s) => s.id === id)
  if (!hit) throw new Error(`未知的基准策略：${id}（可选 ${BENCH_STRATEGIES.map((s) => s.id).join('/')}）`)
  return hit
}

/**
 * 这一组策略对应的 `YAN_CONTEXT_POLICY` 覆盖（可直接 `JSON.stringify` 进环境变量）。
 *
 * 为什么只给 `kinds`：其它数值（工作集、门槛）**必须四组一致**，否则差异来自预算而不是
 * 策略。基准要控制的是「接管范围」这一个变量。
 */
export function benchPolicyPatch(id: string): { kinds: ContextOperationKind[] } {
  return { kinds: [...benchStrategy(id).kinds] }
}

/* ------------------------------------------------------------------ 判分规则 */

/**
 * 一条约束的检查方式。
 *
 * 全部是**可自动判定**的字符串规则，这条边界很重要：用第二个模型去读回答、
 * 判断「约束还在不在」会把评委的偏好算进指标里，而且无法复核。
 */
export type ConstraintCheck =
  | { kind: 'must-include'; needle: string }
  | { kind: 'must-exclude'; needle: string }
  /** `flags` 用 JS 的构造参数（`'m'` / `'i'`），**不要**写 `(?m)` —— 那是 PCRE 语法，JS 不认 */
  | { kind: 'must-match'; pattern: string; flags?: string }
  | { kind: 'must-not-match'; pattern: string; flags?: string }

export interface ConstraintSpec {
  id: string
  /** 给报告看的一句话（例如「魔数必须还是 7f3a91」） */
  text: string
  check: ConstraintCheck
}

export interface ConstraintOutcome {
  constraintId: string
  /** 这条约束在这条回答里还成立吗 */
  kept: boolean
}

/**
 * 逐条核对一条回答。
 *
 * `must-match` / `must-not-match` 里的正则是**任务集里写死的**（不是不可信输入），
 * 但仍然包一层 try —— 写错正则时应当变成「这条判不了」而不是让整场跑批炸掉；
 * 判不了按**没守住**记（宁可高估丢失率：高估会让我们更保守地保留复杂度，
 * 低估则会误导「可以删掉」，两个方向的代价不对称）。
 */
export function judgeConstraints(reply: string, specs: readonly ConstraintSpec[]): ConstraintOutcome[] {
  const text = typeof reply === 'string' ? reply : ''
  return specs.map((spec) => {
    const c = spec.check
    let kept: boolean
    switch (c.kind) {
      case 'must-include':
        kept = text.includes(c.needle)
        break
      case 'must-exclude':
        kept = !text.includes(c.needle)
        break
      case 'must-match':
      case 'must-not-match': {
        let hit: boolean
        try {
          hit = new RegExp(c.pattern, c.flags ?? '').test(text)
        } catch {
          kept = false
          break
        }
        kept = c.kind === 'must-match' ? hit : !hit
        break
      }
    }
    return { constraintId: spec.id, kept }
  })
}

/* ------------------------------------------------------------------ 指标 */

/** 一轮跑批里、某一组策略的一条结果 */
export interface StrategyRun {
  strategyId: BenchStrategyId
  /** 这一轮算不算「把任务做成了」（口径由任务集自己定，例如最终回答里给了结论） */
  success: boolean
  outcomes: ConstraintOutcome[]
}

/**
 * LCR（Lost Constraint Rate）：**丢失的约束条次 / 检查过的约束条次**。
 *
 * 为什么按「条次」而不是「按会话平均」：约束在压缩后被丢掉的概率与它出现在
 * 哪一轮无关，按条次聚合才不会被「某些会话约束特别多」带偏。
 * 空输入返回 0（没有检查过任何东西 → 没有丢失），调用方必须用
 * `hasSignal()` 区分「0%」与「没有数据」。
 */
export function lostConstraintRate(runs: readonly StrategyRun[]): number {
  let total = 0
  let lost = 0
  for (const run of runs) {
    for (const o of run.outcomes) {
      total += 1
      if (!o.kept) lost += 1
    }
  }
  return total === 0 ? 0 : lost / total
}

/** 成功率（0..1）；空输入返回 0（同样要用 `hasSignal()` 兜） */
export function successRate(runs: readonly StrategyRun[]): number {
  if (runs.length === 0) return 0
  return runs.filter((r) => r.success).length / runs.length
}

/** 这一组有没有可判的数据（空跑批不能当成「完美」） */
export function hasSignal(runs: readonly StrategyRun[]): boolean {
  return runs.some((r) => r.outcomes.length > 0)
}

/** 主判据的阈值（实施-06 §2） */
export const MIN_LCR_DROP_RATIO = 0.25
export const MAX_SUCCESS_DROP_PP = 3
/** state 开销的关注线：`stateOverhead > 25%` 则增量 delta 从 P2 升 P1 */
export const MAX_STATE_OVERHEAD = 0.25

export type BenchVerdict = 'supported' | 'inconclusive' | 'not-supported'

export interface StrategyComparison {
  baselineId: BenchStrategyId
  candidateId: BenchStrategyId
  baselineLcr: number
  candidateLcr: number
  /** 相对下降比例：`(baseline − candidate) / baseline`；baseline 为 0 时是 NaN 语义 → 用 verdict=inconclusive 表达 */
  lcrDropRatio: number
  baselineSuccess: number
  candidateSuccess: number
  /** 成功率的百分点差（candidate − baseline，负数表示变差） */
  successDeltaPp: number
  verdict: BenchVerdict
  /** 判定依据的逐条说明（报告里原文照抄，避免事后各说各话） */
  reasons: string[]
}

/**
 * 主判据：LCR 相对下降 ≥ 25% **且**成功率不低于 baseline − 3pp。
 *
 * 三种结论的语义（不要合并）：
 *   · `supported`   —— 收益成立，薄层里对应的钩子**有理由保留**；
 *   · `not-supported` —— 有数据、但收益不达标 → 该削减复杂度；
 *   · `inconclusive`  —— **数据不足或基线为 0**，不能拿它当「没收益」的证据。
 *
 * 「baseline 的 LCR 是 0」是特别要拦的一种：那时相对下降是 0/0，
 * 任何策略都「降不了」——这说明**任务集没能压出约束丢失**，是设计问题，
 * 不是策略问题。
 */
export function compareStrategies(
  baseline: readonly StrategyRun[],
  candidate: readonly StrategyRun[],
  ids: { baselineId: BenchStrategyId; candidateId: BenchStrategyId }
): StrategyComparison {
  const reasons: string[] = []
  const baseLcr = lostConstraintRate(baseline)
  const candLcr = lostConstraintRate(candidate)
  const baseOk = hasSignal(baseline)
  const candOk = hasSignal(candidate)
  const baseSucc = successRate(baseline)
  const candSucc = successRate(candidate)
  const deltaPp = (candSucc - baseSucc) * 100
  const drop = baseLcr === 0 ? 0 : (baseLcr - candLcr) / baseLcr

  let verdict: BenchVerdict = 'inconclusive'
  if (!baseOk || !candOk) {
    reasons.push('数据不足：有一组没有可判的约束条次（空跑批不能当成完美）')
  } else if (baseLcr === 0) {
    reasons.push('基线 LCR = 0：任务集没压出任何约束丢失，这个对照无法区分策略（先改任务集）')
  } else {
    const dropOk = drop >= MIN_LCR_DROP_RATIO
    const succOk = deltaPp >= -MAX_SUCCESS_DROP_PP
    reasons.push(
      `LCR：${pct(baseLcr)} → ${pct(candLcr)}（相对下降 ${pct(drop)}，门槛 ${pct(MIN_LCR_DROP_RATIO)}）`,
      `成功率：${pct(baseSucc)} → ${pct(candSucc)}（${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(1)}pp，下限 −${MAX_SUCCESS_DROP_PP}pp）`
    )
    if (dropOk && succOk) verdict = 'supported'
    else {
      verdict = 'not-supported'
      if (!dropOk) reasons.push('相对下降未达门槛 → 该策略在当前实现下的收益不成立')
      if (!succOk) reasons.push('成功率掉出 non-inferior 区间')
    }
  }

  return {
    baselineId: ids.baselineId,
    candidateId: ids.candidateId,
    baselineLcr: baseLcr,
    candidateLcr: candLcr,
    lcrDropRatio: drop,
    baselineSuccess: baseSucc,
    candidateSuccess: candSucc,
    successDeltaPp: deltaPp,
    verdict,
    reasons
  }
}

/** 百分比显示（报告与断言消息共用，避免一处 25% 一处 0.25） */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/* ----------------------------------------------------- 副指标：state 开销与矛盾率 */

/**
 * `stateOverhead`：状态生成的**输入** token 占主流程输入 token 的比例。
 *
 * ⚠️ 真正的开销是那份**全量快照输入**，不是状态输出的 6000 token 上限 ——
 * 这是方案 §17.5.4 的结论，也是这项单列出来的原因。
 * 分母为 0（没有主输入）时返回 0，调用方不要拿它当「无开销」的证据。
 */
export function stateOverhead(stateGenerationInputTokens: number, promptTokens: number): number {
  if (!(promptTokens > 0)) return 0
  const state = Number.isFinite(stateGenerationInputTokens) ? Math.max(0, stateGenerationInputTokens) : 0
  return state / promptTokens
}

export type OverheadVerdict = 'ok' | 'over' | 'no-signal'

/** `over` → 增量 delta 要从 P2 升 P1（当前决策是「不做」，升 P1 需重新评估） */
export function overheadVerdict(ratio: number, promptTokens: number): OverheadVerdict {
  if (!(promptTokens > 0)) return 'no-signal'
  return ratio > MAX_STATE_OVERHEAD ? 'over' : 'ok'
}

export type ContradictionBand = '<1%' | '1%-3%' | '>3%'

/**
 * 语义矛盾率三档（方案 §17.5.4）。
 *
 * 边界归属：1% 与 3% 都算进**上一档**（`1%-3%`）—— 档位是给决策用的
 * （`>3%` 才要采取动作），把边界算严会让「刚好 3%」被误判成要行动。
 */
export function contradictionBand(rate: number): ContradictionBand {
  const r = Number.isFinite(rate) ? Math.max(0, rate) : 0
  if (r < 0.01) return '<1%'
  if (r <= 0.03) return '1%-3%'
  return '>3%'
}
