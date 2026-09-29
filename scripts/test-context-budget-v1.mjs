export async function runContextBudgetV1Tests(ok, budget, observerModule) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const {
    calculateContextBudgetV1,
    checkContextBudgetRequestV1,
    contextEndpointKeyV1,
    selectAutoContextBudgetV1
  } = budget

  console.log('\n--- 上下文预算 V1 ---')

  /*
   * Codex（ChatGPT 订阅）的请求体不带 max_output_tokens，服务端按模型上限截断。
   * 以前这里判「输出上限未知」并 fail closed，结果 Codex 模型每条消息都被中止、没有回复。
   */
  {
    const { resolveContextBudgetOutputReserveV1: resolveR } = budget
    const codexNoField = resolveR({ api: 'openai-codex-responses', payload: { model: 'gpt' }, modelMaxTokens: 128_000 })
    ok(codexNoField.outputReserve === 128_000 && codexNoField.reason === 'model_output_limit_assumed', 'Codex 请求不带输出上限时按模型 maxTokens 预留（不再中止）')
    const codexField = resolveR({ api: 'openai-codex-responses', payload: { max_output_tokens: 9_000 }, modelMaxTokens: 128_000 })
    ok(codexField.outputReserve === 9_000, 'Codex 请求带了字段时仍以字段为准')
    const codexNoModel = resolveR({ api: 'openai-codex-responses', payload: {} })
    ok(codexNoModel.outputReserve === null, 'Codex 连模型上限也没有时仍 fail closed')
    const responsesNoField = resolveR({ api: 'openai-responses', payload: {}, modelMaxTokens: 128_000 })
    ok(responsesNoField.outputReserve === null, '其他接口字段缺失时不借用模型上限（仍 fail closed）')
  }

  const api = {
    endpointKey: 'test/openai-completions/model/default',
    modelId: 'model',
    mode: 'shared',
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    countingAdapter: 'test-estimate-v1',
    outputAccounting: 'shared-window-request-output-limit',
    revision: 'test-r1',
    source: 'runtime'
  }
  const calculated = calculateContextBudgetV1({
    capability: api,
    outputReserve: 8_000,
    selectedBudget: 200_000
  })
  ok(
    calculated.ok && calculated.errorMargin === 2_560 && calculated.hardInputLimit === 117_440 &&
      calculated.reviewLine === 101_440 && calculated.targetAfterReview === 76_080,
    '共享窗口按本次输出 R、误差余量和最小增长线计算 H/S/L'
  )

  const separate = calculateContextBudgetV1({
    capability: { ...api, mode: 'separate', contextWindow: undefined, maxInputTokens: 128_000 },
    outputReserve: 8_000,
    selectedBudget: 200_000
  })
  ok(separate.ok && separate.hardInputLimit === 125_440, '独立输入上限不重复扣除输出额度')
  ok(
    !calculateContextBudgetV1({ capability: api, outputReserve: null, selectedBudget: 200_000 }).ok,
    '本次输出额度未知时不计算可发送预算'
  )

  const select = (requiredInputTokens) => selectAutoContextBudgetV1({
    requiredInputTokens,
    capability: { ...api, contextWindow: 1_000_000 },
    outputReserve: 16_000,
    autoMaxBudget: 700_000,
    currentBudget: 200_000
  })
  ok(select(230_000).selectedBudget === 300_000, '必要材料 230K 一次升到最小够用的 300K')
  ok(select(420_000).selectedBudget === 500_000, '必要材料 420K 一次升到最小够用的 500K')
  ok(!select(950_000).ok, '必要材料到达端点容量边界时不靠继续升档掩盖')

  /* 一键出口的档位计算（临时抬软线 / 降档）：逐档、受上限约束、顶底不动 */
  const { adjacentContextBudgetTierV1 } = budget
  ok(adjacentContextBudgetTierV1(200_000, 'up', 700_000) === 300_000, '抬线逐档上升')
  ok(adjacentContextBudgetTierV1(700_000, 'up', 700_000) === 700_000, '抬到上限就不再动')
  ok(adjacentContextBudgetTierV1(500_000, 'up', 500_000) === 500_000, '自动最高档就是抬线的天花板')
  ok(adjacentContextBudgetTierV1(500_000, 'down') === 300_000, '降档逐档下降')
  ok(adjacentContextBudgetTierV1(200_000, 'down') === 200_000, '到最低档就不再动')
  ok(adjacentContextBudgetTierV1(undefined, 'up', 700_000) === 300_000, '非法当前档按最低档起算（不跳档）')
  ok(adjacentContextBudgetTierV1(300_000, 'down', 700_000) === 200_000, '降档不受上限参数影响')

  /* 临时抬线：到期自动回落（宿主、扩展、界面共用同一个判断）*/
  const { effectiveContextBudgetTierV1, CONTEXT_BUDGET_TEMPORARY_OVERRIDE_MS } = budget
  const now = 1_800_000_000_000
  ok(CONTEXT_BUDGET_TEMPORARY_OVERRIDE_MS === 30 * 60 * 1000, '临时抬线有效期是 30 分钟')
  ok(
    effectiveContextBudgetTierV1({
      selectedBudget: 200_000,
      temporaryBudgetOverride: { selectedBudget: 300_000, expiresAt: now + 1_000 },
      now
    }) === 300_000,
    '未过期的临时抬线生效'
  )
  ok(
    effectiveContextBudgetTierV1({
      selectedBudget: 200_000,
      temporaryBudgetOverride: { selectedBudget: 300_000, expiresAt: now },
      now
    }) === 200_000,
    '到点即失效（边界：等于当前时间算过期）'
  )
  ok(
    effectiveContextBudgetTierV1({
      selectedBudget: 200_000,
      temporaryBudgetOverride: { selectedBudget: 300_000, expiresAt: now - 1 },
      now
    }) === 200_000,
    '过期的抬线自动回落到基础档（不需要定时清理）'
  )
  ok(effectiveContextBudgetTierV1({ selectedBudget: 200_000, now }) === 200_000, '没有抬线时就是基础档')
  ok(
    effectiveContextBudgetTierV1({
      selectedBudget: 200_000,
      temporaryBudgetOverride: { selectedBudget: 250_000, expiresAt: now + 1_000 },
      now
    }) === 200_000,
    '非法档位的抬线被忽略（不编一个新档）'
  )
  ok(
    effectiveContextBudgetTierV1({
      selectedBudget: 500_000,
      temporaryBudgetOverride: { selectedBudget: 300_000, expiresAt: now + 1_000 },
      now
    }) === 500_000,
    '低于基础档的「抬线」不算抬线（那是降档该做的事）'
  )
  ok(
    effectiveContextBudgetTierV1({
      selectedBudget: 700_000,
      temporaryBudgetOverride: { selectedBudget: 700_000, expiresAt: now + 1_000 },
      now: now + 60_000
    }) === 700_000,
    '抬到顶时仍然是合法值（不因为没有更高档而报错）'
  )

  const deferred = selectAutoContextBudgetV1({
    requiredInputTokens: 100_000,
    capability: { ...api, contextWindow: 1_000_000 },
    outputReserve: 16_000,
    autoMaxBudget: 700_000,
    currentBudget: 500_000,
    consecutiveLowBoundaries: 2,
    losslessProjectionFitsCandidate: false
  })
  ok(deferred.ok && deferred.selectedBudget === 500_000 && deferred.deferredDownshift, '无损投影未就绪时保留高档，不丢历史强行降档')
  const phaseDeferred = selectAutoContextBudgetV1({
    requiredInputTokens: 100_000,
    capability: { ...api, contextWindow: 1_000_000 },
    outputReserve: 16_000,
    autoMaxBudget: 700_000,
    currentBudget: 500_000,
    phaseChanged: true,
    losslessProjectionFitsCandidate: false
  })
  ok(phaseDeferred.ok && phaseDeferred.selectedBudget === 500_000 && phaseDeferred.deferredDownshift, '新阶段也不能在当前转录仍超候选软线时直接降档')
  const phaseProjected = selectAutoContextBudgetV1({
    requiredInputTokens: 100_000,
    capability: { ...api, contextWindow: 1_000_000 },
    outputReserve: 16_000,
    autoMaxBudget: 700_000,
    currentBudget: 500_000,
    phaseChanged: true,
    losslessProjectionFitsCandidate: true
  })
  ok(phaseProjected.ok && phaseProjected.selectedBudget === 200_000, '新阶段无损投影容纳时直接回落到最小够用档')

  /* 宿主按实际请求规模回收档位：连续两个低用量回合才降，只降到实际输入的 60% 以下仍放得下的最小档 */
  const { reconcileObservedContextBudgetV1 } = budget
  const reconcile = (observedInputTokens, currentBudget, previousLowTurns) => reconcileObservedContextBudgetV1({
    observedInputTokens,
    capability: { ...api, contextWindow: 1_000_000 },
    outputReserve: 16_000,
    currentBudget,
    previousLowTurns
  })
  const firstLow = reconcile(90_000, 500_000, 0)
  ok(firstLow.lowTurn && !firstLow.apply && firstLow.lowTurns === 1 && firstLow.candidateBudget === 200_000, '整理后实际输入 90K：第一个低用量回合只计数，不降档')
  const secondLow = reconcile(90_000, 500_000, 1)
  ok(secondLow.apply && secondLow.candidateBudget === 200_000, '连续第二个低用量回合降到最小够用的 200K')
  const midLow = reconcile(150_000, 500_000, 1)
  ok(midLow.apply && midLow.candidateBudget === 300_000, '实际输入 150K 超过 200K 档软线的 60%，只降到 300K')
  const notLow = reconcile(260_000, 500_000, 1)
  ok(!notLow.lowTurn && notLow.lowTurns === 0 && !notLow.apply, '实际输入仍接近当前档：不降档并清零计数')
  ok(!reconcile(50_000, 200_000, 1).lowTurn, '已在最低档不再降')
  ok(!reconcile(null, 500_000, 1).lowTurn, '实际输入未知时不降档')
  ok(!reconcileObservedContextBudgetV1({ observedInputTokens: 90_000, capability: api, outputReserve: null, currentBudget: 500_000, previousLowTurns: 1 }).apply, '输出额度未知时不降档')

  const requestCalculation = calculateContextBudgetV1({
    capability: { ...api, contextWindow: 1_000_000 },
    outputReserve: 16_000,
    selectedBudget: 200_000
  })
  ok(
    checkContextBudgetRequestV1({
      inputTokens: requestCalculation.reviewLine,
      outputReserve: 16_000,
      countMode: 'estimated',
      capability: { ...api, contextWindow: 1_000_000 },
      selectedBudget: 200_000
    }).decision === 'review',
    '估算请求到软线进入 review，不被记成普通发送'
  )
  ok(
    checkContextBudgetRequestV1({
      inputTokens: null,
      outputReserve: 16_000,
      countMode: 'unavailable',
      capability: { ...api, contextWindow: 1_000_000 },
      selectedBudget: 200_000
    }).decision === 'unavailable',
    '请求计数不可用时返回 unavailable'
  )

  const keyA = contextEndpointKeyV1({
    provider: 'custom', api: 'openai-completions', modelId: 'm',
    baseUrl: 'https://user:secret@example.test/v1?api_key=first'
  })
  const keyB = contextEndpointKeyV1({
    provider: 'custom', api: 'openai-completions', modelId: 'm',
    baseUrl: 'https://other:secret2@example.test/v1?api_key=second'
  })
  const keyC = contextEndpointKeyV1({
    provider: 'custom', api: 'openai-completions', modelId: 'm',
    baseUrl: 'https://example.test/other'
  })
  ok(keyA === keyB && keyA !== keyC && !keyA.includes('secret') && !keyA.includes('api_key'), '端点身份排除凭据与查询参数，同时区分不同路径')

  const handlers = new Map()
  const entries = []
  const activate = async (sessionId) => {
    const dir = join(process.env.YAN_DATA_DIR, 'context-budget-v1', sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'policy.json'), JSON.stringify({
      version: 1,
      sessionId,
      activePhaseId: 'main',
      revision: 'fixture-policy-revision',
      updatedAt: Date.now(),
      phases: {
        main: {
          phaseId: 'main',
          mode: 'auto',
          selectedBudget: 200_000,
          autoMaxBudget: 700_000,
          materials: []
        }
      }
    }), 'utf8')
  }
  await activate('context-budget-send')
  await activate('context-budget-no-output')
  await activate('context-budget-review')
  const corruptDir = join(process.env.YAN_DATA_DIR, 'context-budget-v1', 'context-budget-corrupt')
  await mkdir(corruptDir, { recursive: true })
  await writeFile(join(corruptDir, 'policy.json'), '{broken policy', 'utf8')
  await observerModule.default({
    on: (event, handler) => handlers.set(event, handler),
    appendEntry: (type, data) => entries.push({ type, data })
  })
  const hook = handlers.get('before_provider_request')
  /*
   * hook 是 async：快照写在 `await` 之后。请把它收集起来，
   * 断言完再统一收干 —— 否则读到的 `latest-request.json` 可能还没落盘。
   */
  const pending = []
  const invoke = (sessionId, payload) => {
    let aborted = false
    pending.push(
      hook(
        { payload },
        {
          model: {
            provider: 'test', api: 'openai-completions', id: 'model',
            contextWindow: 1_000_000, maxTokens: 32_000
          },
          sessionManager: { getSessionId: () => sessionId },
          abort: () => { aborted = true }
        }
      )
    )
    return aborted
  }
  ok(!invoke('legacy-session-without-v1-policy', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], max_tokens: 8_192
  }), '未迁移的旧会话绕过 V1 守卫，继续使用原上下文策略')
  ok(invoke('context-budget-corrupt', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], max_tokens: 8_192
  }), '存在损坏 V1 策略的会话失败关闭，不回退到可发送')
  ok(!invoke('context-budget-send', {
    /*
     * openai-completions 的输出上限字段由 compat 决定：
     * pi 的 bundled builder 在没声明 `maxTokensField` 时写
     * `max_completion_tokens`（声称 `max_tokens` 只在 DeepSeek 一类的
     * 非标兼容里才用）—— 这里不传 compat，就必须给前者。
     */
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], max_completion_tokens: 8_192
  }), '有明确 R 且低于软线的最终请求不被中断')
  ok(invoke('context-budget-no-output', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: []
  }), '最终 payload 未给出本次 R 时真实调用 abort')
  /*
   * review 档的 abort 在 `await maintainContextAutomatically(...)` **之后**，
   * 所以不能像上两条那样拿 invoke 的同步返回值断言 —— 单用一个状态对象，
   * 等 promise 收干后再看（与前面 send / no-output 两条的同步路径不同）。
   */
  const reviewState = { aborted: false }
  pending.push(
    hook(
      { payload: { system: 'system', messages: [{ role: 'user', content: 'x'.repeat(800_000) }], tools: [], max_completion_tokens: 8_192 } },
      {
        model: {
          provider: 'test', api: 'openai-completions', id: 'model',
          contextWindow: 1_000_000, maxTokens: 32_000
        },
        sessionManager: { getSessionId: () => 'context-budget-review' },
        abort: () => { reviewState.aborted = true }
      }
    )
  )
  ok(entries.some((entry) => entry.type === 'yan-context-budget-v1' && entry.data.code === 'context_review_required'), '被中断的 review 请求留下不含正文的会话原因条目')

  /* 快照与 abort 都写在 `await` 之后：先收干所有 hook promise，再断言与读盘 */
  await Promise.allSettled(pending)
  ok(reviewState.aborted, '最终估算到达软线时调用 abort 并要求先整理')

  const latestPath = join(process.env.YAN_DATA_DIR, 'context-budget-v1', 'context-budget-review', 'latest-request.json')
  const latestRaw = JSON.parse(await readFile(latestPath, 'utf8'))
  const safeView = budget.sanitizeContextBudgetRuntimeSnapshotV1(latestRaw, 'context-budget-review')
  ok(
    safeView?.check.decision === 'review' && safeView.inputTokens !== null &&
      !JSON.stringify(latestRaw).includes('x'.repeat(100)),
    '最终快照保留估算/判定，但不写入消息正文'
  )
  ok(
    budget.sanitizeContextBudgetRuntimeSnapshotV1(latestRaw, 'another-session') === null &&
      budget.sanitizeContextBudgetRuntimeSnapshotV1({ ...latestRaw, observedAt: latestRaw.observedAt - 11 * 60_000 }, 'context-budget-review') === null,
    '快照绑定当前会话，并拒绝超过 10 分钟的陈旧数据'
  )

  /*
   * 策略坏掉（读不到 / 坏 JSON）时写出的兜底快照也必须是合法形状。
   * 回归点：`unavailableDetails` 曾经调一个不存在的 `defaultPolicy()`，
   * 于是「策略坏掉」这条兜底路径自己抛 ReferenceError（界面上是「扩展出错」）。
   */
  const corruptRaw = JSON.parse(await readFile(
    join(process.env.YAN_DATA_DIR, 'context-budget-v1', 'context-budget-corrupt', 'latest-request.json'),
    'utf8'
  ))
  const corruptView = budget.sanitizeContextBudgetRuntimeSnapshotV1(corruptRaw, 'context-budget-corrupt')
  ok(
    corruptView?.check.decision === 'unavailable' && corruptView.check.phaseId === 'main',
    '策略不可用时写出的兜底快照形状合法（回归：defaultPolicy 未定义）'
  )
}
