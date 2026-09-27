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
  const invoke = (sessionId, payload) => {
    let aborted = false
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
    return aborted
  }
  ok(!invoke('legacy-session-without-v1-policy', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], max_tokens: 8_192
  }), '未迁移的旧会话绕过 V1 守卫，继续使用原上下文策略')
  ok(invoke('context-budget-corrupt', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], max_tokens: 8_192
  }), '存在损坏 V1 策略的会话失败关闭，不回退到可发送')
  ok(!invoke('context-budget-send', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], max_tokens: 8_192
  }), '有明确 R 且低于软线的最终请求不被中断')
  ok(invoke('context-budget-no-output', {
    system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: []
  }), '最终 payload 未给出本次 R 时真实调用 abort')
  ok(invoke('context-budget-review', {
    system: 'system', messages: [{ role: 'user', content: 'x'.repeat(800_000) }], tools: [], max_tokens: 8_192
  }), '最终估算到达软线时调用 abort 并要求先整理')
  ok(entries.some((entry) => entry.type === 'yan-context-budget-v1' && entry.data.code === 'context_review_required'), '被中断的 review 请求留下不含正文的会话原因条目')

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
}
