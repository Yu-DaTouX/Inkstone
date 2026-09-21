/**
 * 请求前预算诊断（实施-05 S4）的纯逻辑单测。
 *
 * 被测对象是**随包的扩展源码** `resources/pi-extensions/context-budget.js` ——
 * 它跑在 pi 子进程里，拿的是真实 payload，所以判定错了没法在事后补救
 * （要么白跑一轮，要么发一个已知装不下的请求）。这里用数字把三种判定钉死。
 *
 * 两块重点：
 *   · **公式交叉校验**：扩展侧的 JS 版必须与 `src/shared/context-policy.ts` 的
 *     `contextBudget()` 算出同一个数 —— 这是「预算只有一个公式源」的可执行检查；
 *   · **边界**：正好在工作集线 / 正好等于窗口 / 差一个 token，都必须落在预定的档位上。
 *
 * 用法：npm run test:unit
 */
export function runContextBudgetTests(ok, mod, policyMod) {
  const {
    DEFAULT_BUDGET_POLICY,
    budgetOf,
    budgetOverridesFromPolicy,
    estimateMessagesTokens,
    estimateToolsTokens,
    estimateRequestTokens,
    requestBudgetLevel
  } = mod
  const { DEFAULT_CONTEXT_POLICY, contextBudget } = policyMod

  console.log('\n--- 实施-05 S4 请求前预算诊断 ---')

  /* ------------------------------------------- 默认值一致（防两边漂移） */

  for (const field of [
    'workingSetCap',
    'windowRatio',
    'responseReservePreferred',
    'responseReserveMin',
    'safetyMarginMin',
    'safetyMarginRatio',
    'emergencyRatio'
  ]) {
    ok(
      DEFAULT_BUDGET_POLICY[field] === DEFAULT_CONTEXT_POLICY[field],
      `默认值 ${field} 与 shared/context-policy.ts 相同（${DEFAULT_BUDGET_POLICY[field]}）`
    )
  }
  ok(
    DEFAULT_BUDGET_POLICY.triggerRatios.compact === DEFAULT_CONTEXT_POLICY.triggerRatios.compact &&
      DEFAULT_BUDGET_POLICY.triggerRatios.sweep === DEFAULT_CONTEXT_POLICY.triggerRatios.sweep,
    '分阶段比例默认值与 shared 相同'
  )

  /* --------------------------------------------------- 公式交叉校验 */

  for (const win of [8_000, 12_000, 64_000, 128_000, 256_000, 1_000_000]) {
    const js = budgetOf(win)
    const ts = contextBudget(win, DEFAULT_CONTEXT_POLICY)
    if (!ts) {
      ok(js === null, `${win} 窗口：两边都判「预算不生效」（js=${js === null ? 'null' : '有值'}）`)
      continue
    }
    ok(
      !!js &&
        js.workingSet === ts.workingSet &&
        js.emergency === ts.emergency &&
        js.responseReserve === ts.responseReserve &&
        js.safetyMargin === ts.safetyMargin,
      `${win} 窗口：JS 与 shared 同值（工作集 ${js?.workingSet} / 兜底 ${js?.emergency}）`
    )
    ok(
      !!js &&
        js.triggers.sweep === ts.triggers.sweep &&
        js.triggers.fold === ts.triggers.fold &&
        js.triggers.compact === ts.triggers.compact,
      `${win} 窗口：三阶段触发线也与 shared 一致`
    )
  }

  const refTs = contextBudget(1_000_000, { ...DEFAULT_CONTEXT_POLICY, workingSetCap: 300_000, windowRatio: 0.75 })
  const refJs = budgetOf(1_000_000, { workingSetCap: 300_000, windowRatio: 0.75 })
  ok(
    refJs?.workingSet === refTs?.workingSet && refJs.workingSet === 300_000,
    `覆盖值（cap 300k / ratio 0.75）两边一致：${refJs?.workingSet}`
  )

  ok(budgetOf(0) === null && budgetOf(Number.NaN) === null, '窗口未知 → 预算不生效（不给 ≤ 0 的线）')

  /* --------------------------------------------------- 覆盖值解析 */

  const picked = budgetOverridesFromPolicy({
    workingSetCap: 1_000,
    windowRatio: 0,
    safetyMarginRatio: 2,
    emergencyRatio: 0.5,
    triggerRatios: { sweep: 0.5, fold: 'x' },
    kinds: ['tool-sweep']
  })
  ok(picked.workingSetCap === 1_000, '合法覆盖被采纳')
  ok(picked.windowRatio === undefined && picked.safetyMarginRatio === undefined, '0 / >1 的比例被忽略（不回落成 0）')
  ok(picked.emergencyRatio === 0.5, '比例 0.5 合法')
  ok(picked.triggerRatios?.sweep === 0.5 && picked.triggerRatios.fold === undefined, '分阶段比例只认数字')
  ok(picked.kinds === undefined, '与预算无关的字段不进来')
  ok(Object.keys(budgetOverridesFromPolicy(null)).length === 0, '非对象 → 空覆盖')
  ok(Object.keys(budgetOverridesFromPolicy([1, 2])).length === 0, '数组 → 空覆盖（形状不对就整份忽略）')

  /* --------------------------------------------------- 估算口径 */

  ok(estimateMessagesTokens([]) === 0 && estimateMessagesTokens(null) === 0, '空消息 → 0')
  const userOnly = estimateMessagesTokens([{ role: 'user', content: 'abcd' }])
  ok(userOnly === 6, `短英文消息 = 固定开销 + 角色 + 正文（实际 ${userOnly}）`)
  const chinese = estimateMessagesTokens([{ role: 'user', content: '你好' }])
  ok(chinese > estimateMessagesTokens([{ role: 'user', content: 'ni' }]), '中文按宽字符算，比同长度英文估得多')
  const withCall = estimateMessagesTokens([
    { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls -la' } }] }
  ])
  ok(withCall > userOnly, 'toolCall 的参数也计入（不然长参数会系统性低估）')
  const withResult = estimateMessagesTokens([{ role: 'toolResult', toolCallId: 'call_1', content: 'x'.repeat(400) }])
  ok(withResult > 100, `工具结果按体积计入（实际 ${withResult}）`)

  ok(estimateToolsTokens([]) === 0, '空工具表 → 0')
  const oneTool = estimateToolsTokens([{ function: { name: 'bash', description: 'run a command' } }])
  const fullTool = estimateToolsTokens([
    { function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }
  ])
  ok(oneTool > 0 && fullTool > oneTool, 'schema 体积也计入')

  const whole = estimateRequestTokens({
    messages: [{ role: 'user', content: 'abcd' }],
    tools: [{ function: { name: 'bash' } }],
    system: 'sys'
  })
  ok(whole.system > 0, '顶层 system 单独计入')
  ok(whole.total === whole.messages + whole.tools + whole.system, 'total 是三部分之和')

  /* --------------------------------------------------- 三档判定边界 */

  const budget = budgetOf(64_000)
  ok(budget?.workingSet === 40_000, `64k 窗口的工作集是 40k（实际 ${budget?.workingSet}）`)

  const normal = requestBudgetLevel({ estimatedTokens: budget.workingSet - 1, budget })
  ok(normal.level === 'normal', '工作集线下一 token → normal')
  const onLine = requestBudgetLevel({ estimatedTokens: budget.workingSet, budget })
  ok(onLine.level === 'soft', '正好在工作集线上 → soft（先清扫）')
  ok(requestBudgetLevel({ estimatedTokens: 0, budget }).level === 'normal', '空请求 → normal')

  /* physical 的线是「估算 + 输出预留 > 窗口」 */
  const justFits = requestBudgetLevel({
    estimatedTokens: budget.contextWindow - budget.responseReserve,
    budget
  })
  ok(justFits.level === 'soft', '估算 + 输出预留 正好等于窗口 → 仍可发（只是 soft）')
  const tooBig = requestBudgetLevel({
    estimatedTokens: budget.contextWindow - budget.responseReserve + 1,
    budget
  })
  ok(tooBig.level === 'physical', '多一个 token 装不下 → physical（不发送）')
  ok(tooBig.projectedTokens > budget.contextWindow, 'physical 的判据写进结果（诊断要能解释）')
  ok(/不发送/.test(tooBig.reason), 'physical 的原因说清「不发送」')

  /* emergency 是**压缩**的兜底线，不该被当成「发不出去」的线 */
  const betweenEmergencyAndWindow = requestBudgetLevel({
    estimatedTokens: Math.min(budget.emergency + 1, budget.contextWindow - budget.responseReserve),
    budget
  })
  ok(
    betweenEmergencyAndWindow.level !== 'physical' || budget.emergency + 1 > budget.contextWindow - budget.responseReserve,
    '过 emergency 不等于发不出去（两条线用途不同，别合并）'
  )

  const unknown = requestBudgetLevel({ estimatedTokens: 123, budget: null })
  ok(unknown.level === 'unknown' && /原生/.test(unknown.reason), '窗口未知 → unknown 且说明回落原生压缩')

  const negative = requestBudgetLevel({ estimatedTokens: -5, budget })
  ok(negative.estimatedTokens === 0 && negative.level === 'normal', '负估算被夹到 0（脏值不制造假 soft）')
}
