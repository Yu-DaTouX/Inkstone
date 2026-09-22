/**
 * 上下文策略（N21-3）的纯逻辑单测。
 *
 * 三块被测逻辑都不碰 Electron / pi：
 *   · `src/shared/context-policy.ts` —— 工作集预算公式、触发决策、下一步阶段；
 *   · `src/main/context-policy.ts` —— `YAN_CONTEXT_POLICY` 的解析入口（按 env 记忆化）；
 *   · `src/renderer/src/state/context-view.ts` —— 阶段文案。
 *
 * 为什么值得这么细：这里决定的是**什么时候把用户的上下文压掉**。
 * 真实触发要求上下文涨到工作集（默认 240k），是几十万 token 的额度；
 * 「刚压完又压」「忙的时候插一刀」「压缩失败后每轮重试」这些坏行为
 * 在真实环境里既贵又难复现 —— 但它们全都能在这里用数字钉死。
 */

export function runContextPolicyTests(ok, mod, mainMod, view) {
  const {
    DEFAULT_CONTEXT_POLICY,
    LARGE_CONTEXT_POLICY_PRESETS,
    LARGE_PRESET_NAME_KEYS,
    contextBudget,
    contextPolicyStep,
    largePresetOf,
    nextContextStage,
    policyFrom,
    rearmAfterCompaction,
    INITIAL_POLICY_STATE,
    POLICY_COOLDOWN_MS,
    POLICY_REARM_MS
  } = mod
  const { activeContextPolicy } = mainMod

  console.log('\n--- N21-3 工作集预算（方案 §5 的验算表）---')

  const budgetOf = (win) => contextBudget(win)

  /* ---- 1. 参考值：与方案里的表逐一对照（十进制 k，表就是这么算的） ---- */
  {
    const cases = [
      { win: 64_000, reserve: 16_000, margin: 8_000, workingSet: 40_000, emergency: 48_000 },
      { win: 128_000, reserve: 32_000, margin: 8_000, workingSet: 88_000, emergency: 96_000 },
      { win: 256_000, reserve: 32_000, margin: 8_000, workingSet: 179_200, emergency: 224_000 },
      { win: 1_000_000, reserve: 32_000, margin: 20_000, workingSet: 240_000, emergency: 900_000 }
    ]
    for (const c of cases) {
      const b = budgetOf(c.win)
      ok(b?.contextWindow === c.win, `窗口 ${c.win}：原样保留`)
      ok(b?.responseReserve === c.reserve, `窗口 ${c.win}：输出预留 ${c.reserve}（实际 ${b?.responseReserve}）`)
      ok(b?.safetyMargin === c.margin, `窗口 ${c.win}：安全余量 ${c.margin}（实际 ${b?.safetyMargin}）`)
      ok(b?.workingSet === c.workingSet, `窗口 ${c.win}：工作集 ${c.workingSet}（实际 ${b?.workingSet}）`)
      ok(
        b?.emergency === c.emergency,
        `窗口 ${c.win}：物理兜底 ${c.emergency}（实际 ${b?.emergency}，= min(90% 窗口, 窗口 − 预留)）`
      )
    }
  }

  /* ---- 2. 真实模型的窗口（列表里真实存在的两个） ---- */
  {
    const small = budgetOf(128_000)
    const big = budgetOf(1_048_576)
    ok(small?.workingSet === 88_000, '128k 模型（gpt-5.3-codex-spark）工作集 88k')
    ok(big?.workingSet === 240_000, '1M 模型（deepseek-v4-flash）工作集被 240k 天花板压住')
    /* 大窗口的兜底线必须**远在**工作集之上，否则两条线会互相打架 */
    ok((big?.emergency ?? 0) > (big?.workingSet ?? 0) * 2, '大窗口的物理兜底远高于工作集')
  }

  /* ---- 3. 三阶段刻度与物理兜底 ---- */
  {
    const b = budgetOf(128_000)
    ok(b?.triggers.sweep === Math.round(88_000 * 0.7), '清理线 = 工作集 × 70%')
    ok(b?.triggers.fold === Math.round(88_000 * 0.85), '折叠线 = 工作集 × 85%')
    ok(b?.triggers.compact === 88_000, '压缩线 = 工作集本身')
    /* 128k 窗口：90% 是 115.2k，但窗口 − 预留 = 96k 更小 —— 兜底不能吃掉输出空间 */
    ok(b?.emergency === 96_000, '物理兜底 = min(90% 窗口, 窗口 − 预留)，128k 下由预留决定')
    ok(b?.emergency === b.contextWindow - b.responseReserve, '小窗口：兜底线正好落在输出预留的边界上')
  }

  /* ---- 3b. 兜底线的不变式（§12 修改 1 / D31）---- */
  {
    /*
     * 三个必须对所有窗口成立的性质。逐点扫窗口而不是只验参考表：
     * 公式里有 min/max/clamp 三处转折，转折点附近最容易写错。
     * 违规只累计不逐条打印 —— 700 行 ✓ 会把真正失败的那条淹掉。
     */
    const bad = { reserve: [], above: [], ratio: [], positive: [] }
    let checked = 0
    for (let win = 1_000; win <= 2_048_000; win = win < 40_000 ? win + 500 : Math.round(win * 1.07)) {
      const b = budgetOf(win)
      if (!b) continue
      checked++
      /* ① 硬规则：兜底线不能突破输出预留（就是它存在的理由） */
      if (b.emergency > b.contextWindow - b.responseReserve) bad.reserve.push(win)
      /* ② 兜底仍是兜底：必须严格在压缩线之上，否则“不看上膛”会顶掉上膛与冷却 */
      if (b.emergency <= b.triggers.compact) bad.above.push(win)
      /* ③ 比例仍是上限（用户把 emergencyRatio 调小时要生效） */
      if (b.emergency > Math.round(win * 0.9) + 1) bad.ratio.push(win)
      if (!(b.emergency > 0)) bad.positive.push(win)
    }
    const show = (list) => list.slice(0, 4).join(', ') + (list.length > 4 ? '…' : '')
    ok(bad.reserve.length === 0, `兜底线从不突破输出预留（扫 ${checked} 个窗口，违规 ${bad.reserve.length}：${show(bad.reserve)}）`)
    ok(bad.above.length === 0, `兜底线恒高于压缩线（违规 ${bad.above.length}：${show(bad.above)}）`)
    ok(bad.ratio.length === 0, `兜底线不超过窗口 × 90%（违规 ${bad.ratio.length}：${show(bad.ratio)}）`)
    ok(bad.positive.length === 0, `兜底线恒为正（违规 ${bad.positive.length}）`)
    ok(checked > 50, `扫过足够多的窗口（${checked} 个）`)
  }

  /* ---- 4. 不给出假预算的窗口 ---- */
  ok(contextBudget(0) === null, '窗口 0 → 没有预算（不编一条 0 的压缩线）')
  ok(contextBudget(Number.NaN) === null, '窗口 NaN → 没有预算')
  ok(contextBudget(-5) === null, '负数窗口 → 没有预算')
  ok(contextBudget(20_000) === null, '窗口小到装不下预留与余量 → 没有预算（交给 pi 原生压缩）')

  console.log('\n--- N21-3 触发决策 ---')

  const budget = budgetOf(1_000_000) // triggers.compact = 240k，emergency = 900k
  const step = (tokens, over = {}) =>
    contextPolicyStep({
      state: INITIAL_POLICY_STATE,
      tokens,
      budget,
      policy: DEFAULT_CONTEXT_POLICY,
      busy: false,
      now: 1_000_000,
      ...over
    })

  /* ---- 5. 什么时候不该动 ---- */
  {
    ok(step(1000).trigger === null, '远低于工作集：不动手')
    ok(step(239_999).trigger === null, '差一个 token 到线：不动手')
    ok(
      contextPolicyStep({ state: INITIAL_POLICY_STATE, tokens: 999_999, budget, policy: { ...DEFAULT_CONTEXT_POLICY, enabled: false }, busy: false })
        .trigger === null,
      '策略关掉后即使过了物理兜底也不动手（开关是权威）'
    )
    ok(step(null).trigger === null, '用量未知（刚压缩完 pi 报 null）：不动手')
    ok(step(999_999, { budget: null }).trigger === null, '没有预算：不动手')
  }

  /* ---- 6. 到了工作集线 ---- */
  {
    const at = step(240_000)
    ok(at.trigger === 'compact', '到工作集线 → 压缩')
    ok(at.state.armed === false, '触发后卸膛（不会每轮都压）')
    ok(at.state.lastTriggerAt === 1_000_000, '记下触发时间（冷却用）')

    /* 还没回落就又过线：不许再压一次 */
    ok(step(245_000, { state: at.state }).trigger === null, '用量没回落前不重复触发')

    /* 忙的时候（回合/压缩进行中）不动手，且不消耗上膛状态 */
    const busy = step(300_000, { busy: true })
    ok(busy.trigger === null, '回合（或压缩）进行中不触发')
    ok(busy.state.armed === true, '忙的时候不消耗上膛状态')

    /* 回落到线下 90% 以下 → 重新上膛 */
    const low = step(200_000, { state: at.state })
    ok(low.trigger === null, '回落后当然不触发')
    ok(low.state.armed === true, '回落到触发线 90% 以下重新上膛')
    const again = step(240_000, { state: low.state, now: 1_000_000 })
    ok(again.trigger === null, '刚触发过：冷却时间内不再触发')
    const later = step(240_000, { state: low.state, now: 1_000_000 + POLICY_COOLDOWN_MS + 1 })
    ok(later.trigger === 'compact', '冷却结束后可以再触发一次')
  }

  /* ---- 6b. 压缩失败不能把策略永久关死（重试窗口） ---- */
  {
    /*
     * 场景：砚压了一次，但 pi 回 `Already compacted`（或扩展取消）——
     * 上下文永远不会回落，只按“回落”上膛就会永久停在「已达工作集上限」。
     */
    const first = step(240_000)
    ok(first.trigger === 'compact', '第一次触发')
    const soon = step(300_000, { state: first.state, now: 1_000_000 + POLICY_REARM_MS - 1 })
    ok(soon.trigger === null, '没回落、也没到重试窗口：不重复触发')
    const retry = step(300_000, { state: first.state, now: 1_000_000 + POLICY_REARM_MS })
    ok(retry.trigger === 'compact', '到了重试窗口：允许再试一次（否则策略永久失效）')
    ok(retry.state.lastTriggerAt === 1_000_000 + POLICY_REARM_MS, '重试也记时间（下一次重试再等一轮）')
    /* 回落仍然是最快的上膛路径 */
    const 回落 = step(100_000, { state: first.state, now: 1_000_000 + 1000 })
    ok(回落.state.armed === true, '用量回落到线下：立刻重新上膛（不必等重试窗口）')
  }

  /* ---- 7. 物理兜底 ---- */
  {
    const cold = { armed: false, lastTriggerAt: 1_000_000 }
    ok(step(899_999, { state: cold, now: 1_000_000 + POLICY_COOLDOWN_MS + 1 }).trigger === null, '物理兜底线之下不触发')
    const fired = step(900_000, { state: cold, now: 1_000_000 + POLICY_COOLDOWN_MS + 1 })
    ok(fired.trigger === 'emergency', '到物理兜底线 → 无条件压缩（不看是否上膛）')
    ok(fired.state.armed === false, '兜底触发后同样卸膛')
  }

  /* ---- 8. 两条线都被覆盖参数压低时，低的先赢 ---- */
  {
    const policy = policyFrom(JSON.stringify({ workingSetCap: 1_000_000, emergencyRatio: 0.001 }))
    const tight = contextBudget(1_000_000, policy)
    const hit = contextPolicyStep({
      state: INITIAL_POLICY_STATE,
      tokens: tight.emergency + 1,
      budget: tight,
      policy,
      busy: false,
      now: 0
    })
    ok(hit.trigger === 'emergency', '兜底线低于工作集时，先是兜底（不会先报 compact）')
    ok(
      tight.emergency <= tight.contextWindow - tight.responseReserve,
      '把比例压到 0.001 也仍然不突破输出预留'
    )
  }

  /* ---- 8b. 压缩成功后重新上膛（N21-4 尾压力测试发现） ---- */
  {
    const cold = { armed: false, lastTriggerAt: 1_000_000 }
    const warm = rearmAfterCompaction(cold)
    ok(warm.armed === true, '未上膛时，压缩成功结束 → 重新上膛')
    ok(warm.lastTriggerAt === cold.lastTriggerAt, '重新上膛不会改动上次触发时间（冷却仍按它算）')
    ok(rearmAfterCompaction(warm) === warm, '已经上膛时是幂等（返回同一个对象）')
    /*
     * 为什么这条值得单独立测：`armed` 只有「回落到线下」与 5 分钟窗口两条恢复路径，
     * 当基线开销本身就压在工作集线上时两条都走不通 —— 策略会退化成 5 分钟压一次。
     * 真实线索：22 个连续回合只压了 2 次、转录涨到工作集的 3 倍（压力测试）。
     */
    const overLine = { armed: false, lastTriggerAt: 1_000_000 }
    const after = rearmAfterCompaction(overLine)
    const step2 = contextPolicyStep({
      state: after,
      tokens: 9_000,
      budget: contextBudget(1_000_000, { ...DEFAULT_CONTEXT_POLICY, workingSetCap: 6_000 }),
      policy: { ...DEFAULT_CONTEXT_POLICY, workingSetCap: 6_000 },
      busy: false,
      now: 1_000_000 + POLICY_COOLDOWN_MS + 1
    })
    ok(
      step2.trigger === 'compact',
      '即使 tokens 仍高于工作集（基线开销压线），重新上膛后过冷却就能再压'
    )
  }

  console.log('\n--- N21-3 参数覆盖（YAN_CONTEXT_POLICY）---')

  {
    ok(policyFrom(undefined).workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap, '没有 env：用默认值')
    ok(policyFrom('').workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap, '空字符串：用默认值')
    ok(policyFrom('{oops').workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap, '坏 JSON：退回默认值（不抛）')
    ok(policyFrom('[]').workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap, '不是对象：退回默认值')

    const p = policyFrom(JSON.stringify({ workingSetCap: 1500 }))
    ok(p.workingSetCap === 1500, '只给 workingSetCap：覆盖它')
    ok(p.windowRatio === DEFAULT_CONTEXT_POLICY.windowRatio, '其余字段保持默认')
    ok(contextBudget(1_000_000, p)?.workingSet === 1500, '覆盖后工作集变成 1500（测试用小额度走完整路径）')

    const bad = policyFrom(JSON.stringify({ workingSetCap: -1, windowRatio: 5, emergencyRatio: 'x', safetyMarginMin: Number.NaN }))
    ok(bad.workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap, '负数上限被忽略')
    ok(bad.windowRatio === DEFAULT_CONTEXT_POLICY.windowRatio, '比例 > 1 被忽略')
    ok(bad.emergencyRatio === DEFAULT_CONTEXT_POLICY.emergencyRatio, '非数字被忽略')
    ok(bad.safetyMarginMin === DEFAULT_CONTEXT_POLICY.safetyMarginMin, 'NaN 被忽略')

    const kinds = policyFrom(JSON.stringify({ kinds: ['tool-sweep', 'nonsense', 'compaction'] }))
    ok(kinds.kinds.join(',') === 'tool-sweep,compaction', '只保留认得出的阶段名')
    const none = policyFrom(JSON.stringify({ kinds: [] }))
    ok(none.kinds.length === 0, '空数组是「什么都没接管」的合法表达')
    ok(policyFrom(JSON.stringify({ triggerRatios: { sweep: 0.5 } })).triggerRatios.sweep === 0.5, '阶段比例可单独覆盖')
  }

  /* ---- 9. env 入口（优先级最高，见 N21-7 段） ---- */
  {
    const env = { YAN_CONTEXT_POLICY: JSON.stringify({ workingSetCap: 2222 }) }
    ok(activeContextPolicy(env).policy.workingSetCap === 2222, 'activeContextPolicy 读 YAN_CONTEXT_POLICY')
    env.YAN_CONTEXT_POLICY = JSON.stringify({ workingSetCap: 3333 })
    ok(activeContextPolicy(env).policy.workingSetCap === 3333, 'env 变了立刻跟上（不是缓存死值）')
    delete env.YAN_CONTEXT_POLICY
    ok(
      activeContextPolicy(env).policy.workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap,
      'env 清掉后回到默认值'
    )
  }

  console.log('\n--- N21-3 下一步阶段 ---')

  {
    const b = budgetOf(128_000)
    /* 默认接管集（2026-09-18 用户拍板加进 `episode-fold`）：清理 + 召回 + 折叠 + 压缩 */
    const defaults = DEFAULT_CONTEXT_POLICY.kinds
    ok(
      defaults.join(',') === 'tool-sweep,recall,episode-fold,compaction',
      '默认接管：清理 + 召回 + 折叠 + 压缩'
    )
    ok(defaults.includes('recall'), '召回与清理一起默认开（否则墓碑引用取不回）')
    ok(
      defaults.includes('episode-fold'),
      '折叠在默认里（2026-09-18 拍板；短会话由 foldEligible 挡住）'
    )

    /* 只看压缩时（关掉清理）的行为仍要成立 —— 阶段 3 的那套判定不能丢 */
    const compactOnly = ['compaction']
    const next = nextContextStage(10_000, b, compactOnly)
    ok(next?.kind === 'compaction', '只接管压缩时，下一步预报压缩')
    ok(next?.at === b.triggers.compact, '下一步的数字来自工作集预算')
    ok(next?.reached === false, '没过线时 reached=false')
    ok(nextContextStage(b.triggers.compact, b, compactOnly)?.reached === true, '过线后 reached=true')
    ok(nextContextStage(null, b, compactOnly)?.kind === 'compaction', '用量未知按 0 处理（说清下一步，不报错）')
    ok(nextContextStage(10_000, null, compactOnly) === null, '没有预算就没有下一步')
    ok(nextContextStage(10_000, b, []) === null, '什么都没接管时不预报任何阶段')
    /* 默认接管了清理之后，“下一步”先到清理线，而不是压缩线 */
    ok(nextContextStage(10_000, b, defaults)?.kind === 'tool-sweep', '默认接管后下一步先是清理')
    ok(nextContextStage(b.triggers.compact + 1, b, defaults)?.reached === true, '默认接管下全过线 reached')
    /* `recall` 是取回通道，不是工作集刻度：它不下场排序 */
    ok(nextContextStage(0, b, ['recall']) === null, '只有 recall 时不预报阶段（它不是刻度）')

    /* 阶段 4 的 kinds 一旦接上，顺序就必须是 清理 → 折叠 → 压缩 */
    const full = ['tool-sweep', 'episode-fold', 'compaction']
    ok(nextContextStage(0, b, full)?.kind === 'tool-sweep', '接管了清理：下一步先是清理')
    ok(nextContextStage(b.triggers.sweep + 1, b, full)?.kind === 'episode-fold', '过了清理线：下一步是折叠')
    ok(nextContextStage(b.triggers.fold + 1, b, full)?.kind === 'compaction', '过了折叠线：下一步是压缩')
    ok(nextContextStage(b.triggers.compact + 1, b, full)?.reached === true, '全过线：reached')
  }

  console.log('\n--- N21-3 阶段文案 ---')

  {
    /* 假 t：只验分支与占位符，措辞由 i18n 文件与 audit:refs 管 */
    const t = (key, vars) => (vars ? `${key}(${Object.values(vars).join(',')})` : key)
    ok(view.contextStageLabel(t, 'tool-sweep') === 'ctx.stageSweep', 'tool-sweep → 清理')
    ok(view.contextStageLabel(t, 'episode-fold') === 'ctx.stageFold', 'episode-fold → 折叠')
    ok(view.contextStageLabel(t, 'compaction') === 'ctx.stageCompact', 'compaction → 压缩')
    ok(view.contextStageLabel(t, 'recall') === 'ctx.stageRecall', 'recall → 回溯（阶段 4）')

    const b = budgetOf(128_000)
    const pending = view.nextContextStageText(t, { kind: 'compaction', at: b.triggers.compact, reached: false })
    ok(/ctx\.nextStage/.test(pending), '未过线：走「下一步：…」')
    ok(pending.includes('88k'), `把 tokens 写成紧凑形式（实际 ${pending}）`)
    const reached = view.nextContextStageText(t, { kind: 'compaction', at: b.triggers.compact, reached: true })
    ok(/ctx\.nextReached/.test(reached), '已过线：改说“已达工作集上限”')
    ok(!reached.includes('88k'), '已过线时不再重复报“约 88k 时”')

    /* 阶段顺序表：与主进程判定用的是同一套 kinds，界面不能自己另排一套 */
    ok(
      view.CONTEXT_STAGES.join(',') === 'tool-sweep,episode-fold,compaction',
      '阶段图例的顺序固定为 清理 → 折叠 → 压缩'
    )
    ok(view.formatTokens(1596) === '1.6k' && view.formatTokens(160000) === '160k', 'token 紧凑写法')
  }

  /*
   * N21-7：生效层解析。
   *
   * 这里钉住的是“界面上的数就是真正在用的数”的另一半 ——
   * 用户改了设置却在界面看到别的值、模型级覆盖被用户级默默盖掉、
   * env 测试通道被设置文件盖掉，这三类都会让“可解释”变成空话。
   */
  console.log('\n--- N21-7 生效层解析（用户 / 供应商 / 模型 / env）---')
  {
    const {
      resolveContextPolicy,
      sanitizeContextPolicyOverrides,
      sanitizeContextPolicyByModel,
      CONTEXT_POLICY_PRESETS,
      LARGE_CONTEXT_POLICY_PRESETS
    } = mod
    const { setContextPolicySettings } = mainMod

    const plain = resolveContextPolicy()
    ok(plain.source === 'default' && plain.overridden.length === 0, '没有覆盖时来源就是默认值')
    ok(plain.policy.workingSetCap === DEFAULT_CONTEXT_POLICY.workingSetCap, '默认值原样保留')

    const user = resolveContextPolicy({ user: { workingSetCap: 100_000 } })
    ok(user.source === 'user' && user.policy.workingSetCap === 100_000, '用户级覆盖生效且来源可解释')
    ok(user.overridden.join(',') === 'workingSetCap', `只报告真的被覆盖的字段（实际 ${user.overridden}）`)

    const byModel = {
      anthropic: { workingSetCap: 111_000 },
      'anthropic/x': { workingSetCap: 222_000 }
    }
    const prov = resolveContextPolicy({ user: { windowRatio: 0.5 }, byModel, modelKey: 'anthropic/y' })
    ok(
      prov.source === 'provider' && prov.sourceKey === 'anthropic' && prov.policy.workingSetCap === 111_000,
      'specific 不命中时用供应商层'
    )
    ok(prov.policy.windowRatio === 0.5, '供应商层不会丢掉用户级里没被覆盖的字段')

    const spec = resolveContextPolicy({ byModel, modelKey: 'anthropic/x' })
    ok(
      spec.source === 'model' && spec.sourceKey === 'anthropic/x' && spec.policy.workingSetCap === 222_000,
      '`provider/model` 比 `provider` 更具体'
    )

    const env = resolveContextPolicy({ user: { workingSetCap: 1000 }, envRaw: '{"workingSetCap":5000}' })
    ok(env.source === 'env' && env.policy.workingSetCap === 5000, 'env（测试通道）优先于用户设置')

    /*
     * P2-7：`episode-fold` 的用户开关。
     * 它不是一个数值（`applyOverrides` 认不了布尔），所以单独一层，
     * 但最终效果必须表现在 `kinds` 上 —— 界面上的阶段预报与扩展真做的事
     * 都是从这个数组读的，这里少改一处就会出现“界面说已接管、实际没跑”。
     */
    const foldOff = resolveContextPolicy({ foldEnabled: false })
    ok(
      !foldOff.policy.kinds.includes('episode-fold') &&
        foldOff.policy.kinds.includes('tool-sweep') &&
        foldOff.policy.kinds.includes('compaction'),
      `关掉任务状态记忆只摘掉 episode-fold（实际 ${foldOff.policy.kinds.join(',')}）`
    )
    ok(
      foldOff.source === 'user' && foldOff.overridden.includes('kinds'),
      `关掉后来源是用户级、被覆盖字段含接管阶段（实际 ${foldOff.source} / ${foldOff.overridden}）`
    )
    const foldOn = resolveContextPolicy({ foldEnabled: true })
    ok(
      foldOn.policy.kinds.includes('episode-fold') && foldOn.overridden.length === 0,
      '显式打开 = 默认（不记为覆盖）'
    )
    const foldVsModel = resolveContextPolicy({
      foldEnabled: false,
      byModel: { 'anthropic/x': { workingSetCap: 222_000 } },
      modelKey: 'anthropic/x'
    })
    ok(
      foldVsModel.source === 'model' && !foldVsModel.policy.kinds.includes('episode-fold'),
      '模型级数值覆盖仍报 model，但用户关掉的状态层不会被它打开'
    )
    const foldVsEnv = resolveContextPolicy({
      foldEnabled: false,
      envRaw: '{"kinds":["tool-sweep","recall","episode-fold","compaction"]}'
    })
    ok(
      foldVsEnv.policy.kinds.includes('episode-fold') && foldVsEnv.source === 'env',
      'env 显式给了 kinds 时用户开关不生效（测试通道优先）'
    )

    const bad = resolveContextPolicy({ user: { workingSetCap: -5, windowRatio: 3 } })
    ok(bad.source === 'default' && bad.overridden.length === 0, '非法覆盖被忽略并退回默认值')

    ok(
      sanitizeContextPolicyOverrides({ workingSetCap: 123.7, nope: 1 })?.workingSetCap === 124,
      '清洗会取整并丢掉未知键'
    )
    ok(sanitizeContextPolicyOverrides({}) === undefined, '空覆盖清洗成 undefined（用完默认）')
    ok(
      sanitizeContextPolicyOverrides({ workingSetCap: DEFAULT_CONTEXT_POLICY.workingSetCap }) === undefined,
      '与默认相同的值不落盘（否则以后改默认值会被空壳配置挡住）'
    )
    const bm = sanitizeContextPolicyByModel({ 'a/b': { windowRatio: 0.6 }, '': { windowRatio: 0.5 }, nope: 3 })
    ok(Object.keys(bm).join(',') === 'a/b', '模型表丢掉空 key 与非法项')

    const tr = resolveContextPolicy({ user: { triggerRatios: { sweep: 0.5 } } })
    ok(
      tr.policy.triggerRatios.sweep === 0.5 && tr.policy.triggerRatios.compact === 1,
      '阶段刻度可以只覆盖一档，其余保持默认'
    )
    ok(tr.overridden.join(',') === 'triggerRatios.sweep', `只报告改过的刻度（实际 ${tr.overridden}）`)

    ok(
      CONTEXT_POLICY_PRESETS.reference.workingSetCap === 300_000 &&
        CONTEXT_POLICY_PRESETS.reference.windowRatio === 0.75,
      '参考方案预设是 300k / 0.75'
    )
    ok(Object.keys(CONTEXT_POLICY_PRESETS.default).length === 0, '默认预设是空覆盖（用完默认）')

    /*
     * 实施-11：1M 模型试行档只允许落在精确的 provider/model 覆盖上。
     * 这里不测 React 按钮，而是把按钮最终写入的纯数据与预算公式钉住：
     * 全局默认不能被污染，较小窗口也不能把裸上限照搬进去。
     */
    ok(
      LARGE_CONTEXT_POLICY_PRESETS.balanced.workingSetCap === 600_000 &&
        LARGE_CONTEXT_POLICY_PRESETS.balanced.windowRatio === 0.7,
      '大窗口平衡试行档是 600k / 70%'
    )
    ok(
      LARGE_CONTEXT_POLICY_PRESETS.long.workingSetCap === 700_000 &&
        LARGE_CONTEXT_POLICY_PRESETS.long.windowRatio === 0.7,
      '大窗口长上下文试行档是 700k / 70%'
    )
    ok(
      contextBudget(1_000_000)?.workingSet === DEFAULT_CONTEXT_POLICY.workingSetCap,
      '试行档不会改变全局默认 240k'
    )
    ok(
      contextBudget(1_000_000, { ...DEFAULT_CONTEXT_POLICY, ...LARGE_CONTEXT_POLICY_PRESETS.balanced })?.workingSet ===
        600_000,
      '平衡试行档写入精确模型后得到 600k 工作集'
    )
    ok(
      contextBudget(1_000_000, { ...DEFAULT_CONTEXT_POLICY, ...LARGE_CONTEXT_POLICY_PRESETS.long })?.workingSet ===
        700_000,
      '长上下文试行档写入精确模型后得到 700k 工作集'
    )
    ok(
      contextBudget(800_000, { ...DEFAULT_CONTEXT_POLICY, ...LARGE_CONTEXT_POLICY_PRESETS.long })?.workingSet ===
        560_000,
      '较小窗口不会照搬 700k 裸上限（受 70% 窗口约束）'
    )

    /*
     * 实施-11 C-4：生效策略交给薄层的文档（revision + 分层覆盖）。
     *
     * 两侧（宿主 TS 与扩展 JS）用同一套挑选规则 —— 这里钉 TS 侧，
     * 扩展侧的同名纯函数由 `test-context-budget.mjs` 用同一批输入验。
     */
    {
      const { contextPolicyRevision, buildEffectivePolicyDocument, overridesOfEffectiveDocument } = mod
      const a = { user: { workingSetCap: 300_000 }, byModel: { 'a/b': { windowRatio: 0.6 } }, foldEnabled: true }
      const b = { byModel: { 'a/b': { windowRatio: 0.6 } }, user: { workingSetCap: 300_000 }, foldEnabled: true }
      ok(contextPolicyRevision(a) === contextPolicyRevision(b), 'revision 与对象键顺序无关')
      ok(
        contextPolicyRevision(a) !== contextPolicyRevision({ ...a, foldEnabled: false }),
        'revision 对开关变化敏感'
      )
      ok(
        contextPolicyRevision(a) !== contextPolicyRevision({ ...a, user: { workingSetCap: 300_001 } }),
        'revision 对数值变化敏感'
      )

      const doc = buildEffectivePolicyDocument({ ...a, now: 123 })
      ok(doc.v === 1 && doc.updatedAt === 123, '文档带版本号与时间戳')
      ok(doc.revision === contextPolicyRevision(a), '文档里的 revision 与纯函数一致')
      ok(doc.default.workingSetCap === 300_000 && doc.byModel['a/b'].windowRatio === 0.6, '分层覆盖原样写进文档')
      ok(doc.foldEnabled === true, 'foldEnabled 默认开')

      const hostDoc = {
        v: 1,
        revision: 'x',
        updatedAt: 1,
        default: { workingSetCap: 300_000 },
        byModel: { 'a/b': { workingSetCap: 600_000 }, a: { workingSetCap: 111_000 } },
        foldEnabled: true
      }
      ok(overridesOfEffectiveDocument(hostDoc, 'a/b').workingSetCap === 600_000, '精确模型命中模型层')
      ok(overridesOfEffectiveDocument(hostDoc, 'a/c').workingSetCap === 111_000, '缺失时回落 provider 段')
      ok(overridesOfEffectiveDocument(hostDoc, 'z/y').workingSetCap === 300_000, '都没命中时用默认层')
      ok(overridesOfEffectiveDocument({ ...hostDoc, v: 9 }, 'a/b').workingSetCap === undefined, '未知版本当作没有文档')
      ok(Object.keys(overridesOfEffectiveDocument(null, 'a/b')).length === 0, 'null 文档返回空覆盖')
    }

    /* 主进程入口：登记设置层后按当前模型查表，env 仍然最高 */
    setContextPolicySettings({ user: { workingSetCap: 42_000 }, byModel: { 'm/a': { windowRatio: 0.5 } } })
    const a1 = activeContextPolicy({}, 'm/a')
    ok(
      a1.policy.workingSetCap === 42_000 && a1.policy.windowRatio === 0.5 && a1.source === 'model',
      '主进程入口按当前模型 key 查表'
    )
    const a2 = activeContextPolicy({ YAN_CONTEXT_POLICY: '{"workingSetCap":7}' }, 'm/a')
    ok(a2.policy.workingSetCap === 7 && a2.source === 'env', '主进程入口优先 env')
    setContextPolicySettings({ foldEnabled: false })
    const a3 = activeContextPolicy({}, 'm/a')
    ok(
      !a3.policy.kinds.includes('episode-fold') && a3.source === 'user',
      '主进程入口把任务状态记忆的开关折算进 kinds（界面读的就是这一份）'
    )
    setContextPolicySettings(null)
    ok(activeContextPolicy({}).source === 'default', '清空设置层后回到默认值')
  }

  /*
   * C-5 尾：大窗口试行档的**识别**。
   *
   * 设置页（哪个按钮亮）与右栏（现在用哪一档）必须用同一个判据，
   * 所以这个纯函数是两份界面唯一的真相源。判据是「恰好等于预设原文」——
   * 「接近」就认的话，用户手填 650K 会被界面叫成「均衡 600K」。
   */
  console.log('\n--- C-5 尾 试行档识别（largePresetOf）---')
  {
    ok(largePresetOf({ ...LARGE_CONTEXT_POLICY_PRESETS.balanced }) === 'balanced', '均衡档（预设原文）被识别')
    ok(largePresetOf({ ...LARGE_CONTEXT_POLICY_PRESETS.long }) === 'long', '长材料档被识别')
    ok(
      largePresetOf({ workingSetCap: 600_000 }) === 'balanced',
      '只留上限也算均衡档（预设的 windowRatio 与默认相同，落盘时会被设置层丢掉）'
    )
    ok(
      largePresetOf({ workingSetCap: 600_000, windowRatio: 0.65 }) === undefined,
      '上限同、比例不同 → 自定义（行为不等价）'
    )
    ok(
      largePresetOf({ workingSetCap: 650_000, windowRatio: 0.7 }) === undefined,
      '数值接近但不等 → 自定义'
    )
    ok(
      largePresetOf({ ...LARGE_CONTEXT_POLICY_PRESETS.balanced, responseReservePreferred: 40_000 }) === undefined,
      '多改一个字段 → 自定义'
    )
    ok(largePresetOf(undefined) === undefined, '没有模型级覆盖 → 不显示档位行')
    ok(
      LARGE_PRESET_NAME_KEYS.balanced === 'set.ctxModelPresetBalanced' &&
        LARGE_PRESET_NAME_KEYS.long === 'set.ctxModelPresetLong',
      '档位名 i18n key 与设置页按钮同源（不手拼字符串）'
    )
  }
}
