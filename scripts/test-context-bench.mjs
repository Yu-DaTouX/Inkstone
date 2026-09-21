/**
 * N21-9 A/B 基准口径（`src/shared/context-bench.ts`，实施-06 S2）的单测。
 *
 * 为什么值得单测：这一片的结论会决定 [实施-01] 那份**允许钩子白名单**的长度
 * （收益不成立 → 该削复杂度）。口径写错会让那次跑批得出反向结论，而口径的错误
 * 在报告里是**看不出来**的（数字都长得正常）。所以每条判据的边界都钉在这里：
 * 四组策略真的只用 `kinds` 区分、判分规则的方向、`inconclusive` 与
 * `not-supported` 不能混、`stateOverhead` 分母为 0 时不能当成「无开销」。
 */

export function runContextBenchTests(ok, mod, policy, tasks) {
  const {
    BENCH_STRATEGIES,
    benchPolicyPatch,
    benchStrategy,
    judgeConstraints,
    lostConstraintRate,
    successRate,
    hasSignal,
    compareStrategies,
    stateOverhead,
    overheadVerdict,
    contradictionBand,
    pct,
    MIN_LCR_DROP_RATIO,
    MAX_SUCCESS_DROP_PP
  } = mod

  /* ---------------------------------------------------------- 1. 四组策略 */

  ok(BENCH_STRATEGIES.length === 4, '四组策略（A/B/C/D）齐全')
  ok(
    BENCH_STRATEGIES.map((s) => s.id).join('') === 'ABCD',
    '顺序就是 A→B→C→D（报告里的表格顺序依赖它）'
  )

  const byId = Object.fromEntries(BENCH_STRATEGIES.map((s) => [s.id, s]))
  ok(byId.A.kinds.length === 0, 'A（原始长上下文）不接管任何阶段')

  /* 每一组的 kinds 都必须是产品认得的项 —— 用产品自己的解析器验，而不是抄一份清单 */
  const { policyFrom, DEFAULT_CONTEXT_POLICY } = policy
  let allLegal = true
  for (const s of BENCH_STRATEGIES) {
    const parsed = policyFrom(JSON.stringify({ kinds: s.kinds }))
    if (parsed.kinds.length !== s.kinds.length) allLegal = false
  }
  ok(allLegal, '四组 kinds 全部是产品认得的阶段（用 policyFrom 交叉校验）')
  ok(
    [...byId.D.kinds].sort().join(',') === [...DEFAULT_CONTEXT_POLICY.kinds].sort().join(','),
    'D（State-First + Trace）就是产品默认集 —— 它是「今天真实在跑的那套」'
  )

  /* 单调包含：B ⊂ C ⊂ D。「C 相对 B 只多了状态」「D 相对 C 只多了 Trace」是指标可解释的前提 */
  const subset = (a, b) => a.every((k) => b.includes(k))
  ok(subset(byId.B.kinds, byId.C.kinds), 'B ⊂ C（C 只比 B 多状态生成那一项）')
  ok(subset(byId.C.kinds, byId.D.kinds), 'C ⊂ D（D 只比 C 多墓碑 + 召回）')
  const cExtra = byId.C.kinds.filter((k) => !byId.B.kinds.includes(k))
  ok(cExtra.length === 1 && cExtra[0] === 'episode-fold', 'C 相对 B 多出的恰好是 episode-fold')
  const dExtra = byId.D.kinds.filter((k) => !byId.C.kinds.includes(k))
  ok(
    dExtra.length === 2 && dExtra.includes('tool-sweep') && dExtra.includes('recall'),
    'D 相对 C 多出的恰好是 tool-sweep + recall（Trace 那对必须同时出现）'
  )

  ok(byId.C.kinds.includes('compaction'), 'C/D 都含 compaction（状态优先不等于不压缩）')
  ok(
    !byId.A.kinds.includes('compaction') && !byId.B.kinds.includes('episode-fold'),
    'A 不接管压缩、B 不注入状态（否则四组之间的差异就不是那一个变量了）'
  )

  /* ------------------------------------------------------ 2. patch 与取值 */

  ok(benchStrategy('D').id === 'D', '按 id 取策略')
  let threw = false
  try {
    benchStrategy('E')
  } catch {
    threw = true
  }
  ok(threw, '未知策略 id 立刻抛错（不静默退回 A）')

  const patch = benchPolicyPatch('C')
  ok(JSON.stringify(patch) === JSON.stringify({ kinds: byId.C.kinds }), 'patch 形状是 { kinds }（可直接进 YAN_CONTEXT_POLICY）')
  patch.kinds.push('recall')
  ok(byId.C.kinds.length === 2, 'patch 返回的是拷贝（改它不会污染常量表）')

  /* ------------------------------------------------------------ 3. 判分 */

  const specs = [
    { id: 'c1', text: '魔数', check: { kind: 'must-include', needle: '7f3a91' } },
    { id: 'c2', text: '不许用 git reset', check: { kind: 'must-exclude', needle: 'git reset' } },
    { id: 'c3', text: '必须双空格缩进', check: { kind: 'must-match', pattern: '^  \\S' } },
    { id: 'c4', text: '不许出现 TODO', check: { kind: 'must-not-match', pattern: 'TODO' } }
  ]

  const good = judgeConstraints('  7f3a91 是魔数\n  继续', specs)
  ok(good.length === 4 && good.every((o) => o.kept), '四条都守住时全部 kept')

  const bad = judgeConstraints('git reset --hard 然后 TODO 待办，魔数忘了', specs)
  ok(bad[0].kept === false, '缺魔数 → must-include 不通过')
  ok(bad[1].kept === false, '写了 git reset → must-exclude 不通过')
  ok(bad[2].kept === false, '不以两个空格开头 → must-match 不通过')
  ok(bad[3].kept === false, '出现 TODO → must-not-match 不通过')

  ok(
    judgeConstraints('', [{ id: 'x', text: '', check: { kind: 'must-match', pattern: '[' } }])[0].kept === false,
    '正则写坏时如实记「没守住」（宁可高估丢失率）'
  )
  ok(
    judgeConstraints('随便', [{ id: 'x', text: '', check: { kind: 'must-not-match', pattern: '[' } }])[0].kept === false,
    'must-not-match 的坏正则同样记「没守住」（不默认通过）'
  )
  ok(judgeConstraints(undefined, specs).length === 4, '非字符串输入按空文本处理（不抛）')
  ok(
    judgeConstraints('第一行\n  缩进行', [
      { id: 'f', text: '', check: { kind: 'must-match', pattern: '^  [^ ]', flags: 'm' } }
    ])[0].kept === true,
    'flags 真的传进正则（多行锚点靠 m）—— `(?m)` 那类 PCRE 写法 JS 不认，会静默变成永远不匹配'
  )
  ok(
    judgeConstraints('Coming Soon', [
      { id: 'f', text: '', check: { kind: 'must-not-match', pattern: 'coming soon', flags: 'i' } }
    ])[0].kept === false,
    'flags=i 大小写不敏感（禁止项不区分大小写）'
  )

  /* ------------------------------------------------------------ 4. 指标 */

  const run = (strategyId, keptFlags, success = true) => ({
    strategyId,
    success,
    outcomes: keptFlags.map((kept, i) => ({ constraintId: `c${i}`, kept }))
  })

  ok(lostConstraintRate([]) === 0, '空跑批 LCR = 0')
  ok(hasSignal([]) === false, '空跑批**没有信号**（不能当成 0% 丢失）')
  ok(hasSignal([run('A', [true])]) === true, '有约束条次才有信号')

  const baseline = [run('A', [true, false]), run('A', [false, false])]
  ok(Math.abs(lostConstraintRate(baseline) - 0.75) < 1e-9, 'LCR = 丢失 3 / 检查 4 = 0.75')
  ok(Math.abs(successRate([run('A', [true], true), run('A', [true], false)]) - 0.5) < 1e-9, '成功率 1/2')
  ok(successRate([]) === 0, '空跑批成功率 0')

  /* -------------------------------------------------- 5. 主判据与三种结论 */

  /* 基线丢 1/4，候选丢 0/4 → 相对下降 100% ≥ 25%、成功率持平 → supported */
  const cmp1 = compareStrategies(baseline, [run('C', [true, true]), run('C', [true, true])], {
    baselineId: 'A',
    candidateId: 'C'
  })
  ok(cmp1.verdict === 'supported', '下降远超门槛 + 成功率不掉 → supported')
  ok(Math.abs(cmp1.lcrDropRatio - 1) < 1e-9, '相对下降 = (0.75 − 0) / 0.75 = 1')
  ok(cmp1.reasons.length >= 2, '判定理由逐条列出（报告里原文照抄）')

  /* 基线丢 4/8，候选丢 3/8 → 相对下降 25% 正好压线 → supported（门槛是「≥」） */
  const b2 = [run('A', [false, false, false, false]), run('A', [true, true, true, true])]
  const c2 = [run('C', [false, false, false, true]), run('C', [true, true, true, true])]
  const cmp2 = compareStrategies(b2, c2, { baselineId: 'A', candidateId: 'C' })
  ok(Math.abs(cmp2.lcrDropRatio - MIN_LCR_DROP_RATIO) < 1e-9, '构造出「正好 25%」')
  ok(cmp2.verdict === 'supported', '正好压线算通过（门槛写的是 ≥ 25%）')

  /* 同数据但成功率掉 5pp → not-supported（LCR 达标也不放过） */
  const c3 = [run('C', [false, false, false, true], true), run('C', [true, true, true, true], false)]
  const a3 = [run('A', [false, false, false, false], true), run('A', [true, true, true, true], true)]
  const cmp3 = compareStrategies(a3, c3, { baselineId: 'A', candidateId: 'C' })
  ok(cmp3.lcrDropRatio >= MIN_LCR_DROP_RATIO, 'LCR 仍然达标')
  ok(cmp3.successDeltaPp < -MAX_SUCCESS_DROP_PP, '成功率掉出区间')
  ok(cmp3.verdict === 'not-supported', '成功率不达标 → not-supported')
  ok(cmp3.reasons.some((r) => r.includes('成功率掉出')), '理由里点名成功率')

  /* 基线 0 丢失 → inconclusive（不是「策略没收益」） */
  const cmp4 = compareStrategies([run('A', [true, true])], [run('C', [true, true])], {
    baselineId: 'A',
    candidateId: 'C'
  })
  ok(cmp4.verdict === 'inconclusive', '基线 LCR = 0 → inconclusive')
  ok(cmp4.reasons.some((r) => r.includes('任务集')), '理由指出是任务集的问题')

  /* 空跑批 → inconclusive */
  const cmp5 = compareStrategies([], [], { baselineId: 'A', candidateId: 'C' })
  ok(cmp5.verdict === 'inconclusive', '空跑批 → inconclusive')
  ok(cmp5.reasons.some((r) => r.includes('空跑批')), '空跑批的理由写明「空跑批不能当成完美」')

  /* ------------------------------------------- 6. 副指标：开销 / 矛盾率 / 显示 */

  ok(stateOverhead(1000, 10000) === 0.1, 'stateOverhead = 1000 / 10000 = 0.1')
  ok(stateOverhead(0, 0) === 0, '分母为 0 时返回 0')
  ok(overheadVerdict(0, 0) === 'no-signal', '分母为 0 时判定 no-signal（不是 ok）')
  ok(overheadVerdict(0.25, 10000) === 'ok', '正好 25% 算 ok（关注线是「>」）')
  ok(overheadVerdict(0.2501, 10000) === 'over', '刚过 25% 算 over')
  ok(stateOverhead(Number.NaN, 100) === 0, 'NaN 输入按 0 处理')

  ok(contradictionBand(0) === '<1%', '0 → <1%')
  ok(contradictionBand(0.0099) === '<1%', '0.99% → <1%')
  ok(contradictionBand(0.01) === '1%-3%', '正好 1% 归到上一档')
  ok(contradictionBand(0.03) === '1%-3%', '正好 3% 归到上一档（>3% 才要动作）')
  ok(contradictionBand(0.0301) === '>3%', '刚过 3% → >3%')
  ok(contradictionBand(Number.NaN) === '<1%', 'NaN 按 0 处理')

  ok(pct(0.25) === '25.0%' && pct(1) === '100.0%', '百分比显示统一（避免一处 0.25 一处 25%）')

  /* ------------------------------------------------ 7. 任务集与判分规则对得上 */

  const { BENCH_TASKS, benchPlanSize } = tasks
  ok(BENCH_TASKS.length >= 3, `合成任务集至少 3 个任务（实际 ${BENCH_TASKS.length}）`)
  ok(new Set(BENCH_TASKS.map((t) => t.id)).size === BENCH_TASKS.length, '任务 id 不重')

  let badSample = 0
  let totalConstraints = 0
  let emptyFiller = 0
  for (const task of BENCH_TASKS) {
    if (!task.filler?.length || !task.deliverable) emptyFiller += 1
    const ids = task.constraints.map((c) => c.id)
    if (new Set(ids).size !== ids.length) badSample += 1
    for (const c of task.constraints) {
      totalConstraints += 1
      /*
       * 每条约束必须**自证**：拿它自己的两个最小样例跑一遍判分规则。
       * 这是这一节存在的全部理由 —— 一条永远匹配不上的约束会让真实跑批的
       * 「丢失率」变成假数据，而那时谁也看不出是任务集写错了。
       */
      const kept = judgeConstraints(c.kept ?? '', [{ id: c.id, text: c.text, check: c.check }])[0]
      const violated = judgeConstraints(c.violated ?? '', [{ id: c.id, text: c.text, check: c.check }])[0]
      if (kept.kept !== true || violated.kept !== false) badSample += 1
    }
  }
  ok(badSample === 0, '每条约束的两个样例都能被判分规则正确区分（写错的约束会在跑批之前就暴露）')
  ok(totalConstraints >= 12, `约束总条次 ≥ 12（实际 ${totalConstraints}）—— 条次太少，丢失率会碎`)
  ok(emptyFiller === 0, '每个任务都有灌噪音的指令与交付要求')

  const size = benchPlanSize()
  ok(size.runs === BENCH_TASKS.length * 4, `跑批规模 = 任务数 × 4 组策略（${size.runs} 次）`)
}
