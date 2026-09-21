/**
 * 压缩可观测性（N21-2）的纯逻辑单测。
 *
 * 两个被测模块都不碰 Electron：
 *   · `src/main/compaction.ts` 的 `reduceCompaction` / `compactionStatusOf` /
 *     `clearStaleRunning` —— 把 pi 的两种 `compaction_end` 形状归一化；
 *   · `src/renderer/src/state/compaction-view.ts` —— reason × status → 文案。
 *
 * 为什么这块值得单测：这里全是「上游字段缺失 / 形状不一致」的分支，
 * 而真实触发压缩（尤其阈值那条）要花额度、还要等上下文涨上来，
 * 不可能靠 live 场景把十二条分支都跑一遍。
 */

export function runCompactionStatusTests(ok, mod, view) {
  const { reduceCompaction, compactionStatusOf, clearStaleRunning, EMPTY_COMPACTION_STATE, projectTrustedFrom } = mod

  /* 假 t：只验分支与占位符，不验具体措辞（措辞由 i18n 文件与 audit:refs 管） */
  const t = (key, vars) => (vars ? `${key}(${Object.values(vars).join(',')})` : key)

  const start = (evt) => reduceCompaction(EMPTY_COMPACTION_STATE, { type: 'compaction_start', ...evt })

  console.log('\n--- N21-2 压缩事件归一化 ---')

  /* ---- 1. compaction_start ---- */
  {
    const s = start({ reason: 'manual', startedAt: 1000 })
    ok(s?.running?.status === 'running', 'start：进入 running')
    ok(s?.running?.reason === 'manual', 'start：reason=manual 归一化')
    ok(s?.running?.startedAt === 1000, 'start：采用事件里的 startedAt')
    ok(s?.last === null, 'start：不清上一次的结果（last 仍为 null 只是因为它本来就是空的）')
  }
  {
    /* 没有 startedAt 的 start（`Session.compact()` 那条路就不带）→ 用本地时钟兜底 */
    const s = reduceCompaction(EMPTY_COMPACTION_STATE, { type: 'compaction_start', reason: 'manual' }, 7777)
    ok(s?.running?.startedAt === 7777, 'start：上游没给 startedAt 时用本地时钟兜底')
  }
  {
    const s = start({ reason: 'task-boundary' })
    ok(s?.running?.reason === undefined, 'start：认不出的 reason 不进 reason')
    ok(s?.running?.reasonRaw === 'task-boundary', 'start：认不出的 reason 保留原文（不显示成“未知”）')
  }
  {
    const s = reduceCompaction(EMPTY_COMPACTION_STATE, { type: 'compaction_start' })
    ok(s?.running !== null && s?.running?.reason === undefined, 'start：完全没有 reason 时仍进入 running')
  }
  ok(reduceCompaction(EMPTY_COMPACTION_STATE, { type: 'message_update' }) === null, '非压缩事件返回 null')
  ok(reduceCompaction(EMPTY_COMPACTION_STATE, { type: 'compaction_delta' }) === null, 'compaction_delta 不当作 start/end')

  /* ---- 2. compaction_end：durable lane 形状（有 status） ---- */
  {
    const running = start({ reason: 'threshold', startedAt: 500 })
    const s = reduceCompaction(running, {
      type: 'compaction_end',
      reason: 'threshold',
      status: 'completed',
      entryId: 'e1',
      endedAt: 900
    })
    ok(s?.running === null, 'end：running 被清掉')
    ok(s?.last?.status === 'completed', 'end：status=completed')
    ok(s?.last?.reason === 'threshold', 'end：reason 保留')
    ok(s?.last?.entryId === 'e1', 'end：带回 pi 写入的摘要条目 id')
    ok(s?.last?.startedAt === 500, 'end：沿用 start 的 startedAt（能算耗时）')
    ok(s?.last?.endedAt === 900, 'end：采用事件里的 endedAt')
  }
  {
    const s = reduceCompaction(EMPTY_COMPACTION_STATE, {
      type: 'compaction_end',
      reason: 'threshold',
      status: 'declined'
    })
    ok(s?.last?.status === 'declined', 'end：status=declined 原样保留（不写成失败）')
    ok(s?.last?.error === undefined, 'end：declined 不是错误，没有 error')
  }
  {
    const s = reduceCompaction(EMPTY_COMPACTION_STATE, {
      type: 'compaction_end',
      reason: 'overflow',
      status: 'failed',
      error: { message: 'boom' },
      endedAt: 42
    })
    ok(s?.last?.status === 'failed', 'end：status=failed')
    ok(s?.last?.error === 'boom', 'end：error 取 message 文本')
    ok(s?.last?.endedAt === 42, 'end：failed 也带 endedAt')
  }

  /* ---- 3. compaction_end：Session.compact() 形状（没有 status） ---- */
  const manualEnd = (extra) =>
    reduceCompaction(start({ reason: 'manual', startedAt: 1 }), {
      type: 'compaction_end',
      reason: 'manual',
      willRetry: false,
      ...extra
    })

  ok(compactionStatusOf({ result: { summary: 's' }, aborted: false }) === 'completed', '无 status：有 result → completed')
  ok(compactionStatusOf({ result: undefined, aborted: false, errorMessage: 'x' }) === 'failed', '无 status：有 errorMessage → failed')
  ok(compactionStatusOf({ aborted: true }) === 'cancelled', '无 status：aborted=true → cancelled')
  ok(compactionStatusOf({}) === 'failed', '无 status：什么都没说 → failed（不许猜成功）')

  {
    const s = manualEnd({ result: { summary: 's', tokensBefore: 10 } })
    ok(s?.last?.status === 'completed', '手动压缩成功：识别为 completed')
    ok(s?.last?.reason === 'manual', '手动压缩成功：reason=manual')
  }
  {
    const s = manualEnd({ errorMessage: 'Compaction failed: Nothing to compact (session too small)' })
    ok(s?.last?.status === 'failed', '手动压缩失败：识别为 failed')
    ok(
      s?.last?.error === 'Compaction failed: Nothing to compact (session too small)',
      '手动压缩失败：原文保留（界面要能显示，不许静默）'
    )
  }
  {
    const s = manualEnd({ aborted: true })
    ok(s?.last?.status === 'cancelled', '中断：识别为 cancelled（不是失败）')
    ok(s?.last?.error === undefined, '中断：不编造错误信息')
  }
  {
    /* 结束事件没带 reason 时，沿用 start 记下的原因 —— 否则「最近一次」会突然没有原因 */
    const s = reduceCompaction(start({ reason: 'threshold', startedAt: 3 }), {
      type: 'compaction_end',
      status: 'completed'
    })
    ok(s?.last?.reason === 'threshold', 'end 缺 reason 时沿用 start 的原因')
    ok(s?.last?.startedAt === 3, 'end 缺 reason 时仍沿用 start 的 startedAt')
  }
  {
    /* 新一轮开始不能擦掉上一次的结果 */
    const first = reduceCompaction(EMPTY_COMPACTION_STATE, {
      type: 'compaction_end',
      reason: 'manual',
      status: 'completed'
    })
    const second = reduceCompaction(first, { type: 'compaction_start', reason: 'threshold' })
    ok(second?.last?.status === 'completed', '开始新一次压缩时，上一次的结果仍在 last')
    ok(second?.running?.reason === 'threshold', '开始新一次压缩时 running 是新的一次')
  }

  {
    const s = reduceCompaction(EMPTY_COMPACTION_STATE, {
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 1596, estimatedTokensAfter: 160 }
    })
    ok(s?.last?.beforeTokens === 1596, 'end：从 result.tokensBefore 取压缩前 token')
    ok(s?.last?.afterTokens === 160, 'end：从 result.estimatedTokensAfter 取压缩后 token')
  }
  {
    /* 手动失败那条路没有 result —— 不能编出 0 */
    const s = reduceCompaction(EMPTY_COMPACTION_STATE, {
      type: 'compaction_end',
      reason: 'manual',
      errorMessage: 'Compaction failed: Already compacted'
    })
    ok(s?.last?.beforeTokens === undefined, 'end：没有 result 时不留 beforeTokens（不编 0）')
  }

  /* ---- 4. 自愈：pi 说没在压缩 ---- */  {
    const running = start({ reason: 'manual' })
    const kept = clearStaleRunning(running, true)
    ok(kept === running, 'isCompacting=true 时不动 running')
    const after = clearStaleRunning({ running: running.running, last: null }, false)
    ok(after.running === null, 'isCompacting=false 时清掉残留的 running（防“永久正在压缩”）')
    const withLast = clearStaleRunning(
      { running: running.running, last: { status: 'completed', reason: 'manual' } },
      false
    )
    ok(withLast.last?.status === 'completed', '自愈不清 last（上次结果是事实）')
    const idle = clearStaleRunning(EMPTY_COMPACTION_STATE, false)
    ok(idle === EMPTY_COMPACTION_STATE, '本来就空闲时返回原对象（不制造无谓的状态变更）')
  }

  /* ---- 4b. 发起方（N21-3）：砚自己压的那一次不能被说成「手动」 ---- */
  {
    /* 砚调 compact() 时 pi 报的是 reason='manual'，发起方由主进程盖章（见 agent.setCompaction） */
    const stamped = {
      running: { status: 'running', reason: 'manual', triggeredBy: 'policy', policyStage: 'compact' },
      last: null
    }
    const done = reduceCompaction(stamped, { type: 'compaction_end', result: {} })
    ok(done?.last?.triggeredBy === 'policy', '结束记录带着发起方（不然“工作集”会变回“手动”）')
    ok(done?.last?.policyStage === 'compact', '结束记录带着命中的线')
    const emergent = reduceCompaction(
      { running: { status: 'running', triggeredBy: 'policy', policyStage: 'emergency' }, last: null },
      { type: 'compaction_end', result: {} }
    )
    ok(emergent?.last?.policyStage === 'emergency', '兜底那条线也带得住')
    ok(reduceCompaction(EMPTY_COMPACTION_STATE, { type: 'compaction_end', result: {} })?.last?.policyStage === undefined, '用户自己压的一次不带这些字段')
  }

  /* ---- 5. 文案映射 ---- */
  console.log('\n--- N21-2 文案映射 ---')

  const reasonOf = (run) => view.compactionReasonText(t, run)
  ok(reasonOf({ status: 'running', reason: 'manual' }) === 'ctx.reasonManual', 'reason=manual → ctx.reasonManual')
  /*
   * 砚按工作集发起时 pi 一律报 manual —— 界面不能因此写成「手动」
   * （用户根本没点那个按钮）。发起方是主进程盖章的，以它为准。
   */
  ok(
    reasonOf({ status: 'completed', reason: 'manual', triggeredBy: 'policy', policyStage: 'compact' }) ===
      'ctx.reasonPolicy',
    '砚发起的工作集压缩 → 「工作集」（不是「手动」）'
  )
  ok(
    reasonOf({ status: 'completed', reason: 'manual', triggeredBy: 'policy', policyStage: 'emergency' }) ===
      'ctx.reasonEmergency',
    '物理兜底触发 → 「物理兜底」'
  )
  ok(
    view.compactionSummary(t, { status: 'completed', reason: 'manual', triggeredBy: 'policy', policyStage: 'compact' }) ===
      'ctx.reasonPolicy · ctx.statusCompleted',
    '摘要里也用真实发起方'
  )
  ok(reasonOf({ status: 'running', reason: 'threshold' }) === 'ctx.reasonThreshold', 'reason=threshold → ctx.reasonThreshold')
  ok(reasonOf({ status: 'running', reason: 'overflow' }) === 'ctx.reasonOverflow', 'reason=overflow → ctx.reasonOverflow')
  ok(reasonOf({ status: 'running', reasonRaw: 'task-boundary' }) === 'task-boundary', '认不出的原因显示原文，不显示“未知”')
  ok(reasonOf({ status: 'running' }) === null, '连原文都没有时返回 null（界面不写这一段）')

  ok(view.compactionStatusText(t, 'completed') === 'ctx.statusCompleted', 'status=completed 文案')
  ok(view.compactionStatusText(t, 'declined') === 'ctx.statusDeclined', 'status=declined 文案（不是失败）')
  ok(view.compactionStatusText(t, 'failed') === 'ctx.statusFailed', 'status=failed 文案')
  ok(view.compactionStatusText(t, 'cancelled') === 'ctx.statusCancelled', 'status=cancelled 文案（不是失败）')

  ok(
    view.compactionSummary(t, { status: 'completed', reason: 'threshold' }) ===
      'ctx.reasonThreshold · ctx.statusCompleted',
    '摘要 = 原因 · 结局'
  )
  ok(
    view.compactionSummary(t, { status: 'failed', reasonRaw: 'task-boundary' }) ===
      'task-boundary · ctx.statusFailed',
    '摘要：原因认不出时用原文'
  )
  ok(
    view.compactionSummary(t, { status: 'declined' }) === 'ctx.statusDeclined',
    '摘要：没有原因时不拿“未知”占位'
  )

  ok(view.compactionTone({ status: 'completed' }) === 'ok', 'completed → ok')
  ok(view.compactionTone({ status: 'failed' }) === 'err', 'failed → err')
  ok(view.compactionTone({ status: 'declined' }) === 'warn', 'declined → warn（不是错误）')
  ok(view.compactionTone({ status: 'cancelled' }) === 'warn', 'cancelled → warn（不是错误）')

  ok(
    view.compactionRunningText(t, { status: 'running', reason: 'threshold' }) ===
      'ctx.compactingReason(ctx.reasonThreshold)',
    '进行中：带上原因与占位符替换'
  )
  ok(
    view.compactionRunningText(t, undefined) === 'status.compacting',
    '进行中：拿不到原因时退回短文案，不编原因'
  )

  /* ---- 6. 压缩前后 token ---- */  ok(view.compactionTokensText({ status: 'completed', beforeTokens: 1596, afterTokens: 160 }) === '1.6k → 160', 'token 段：1.6k → 160')
  ok(view.compactionTokensText({ status: 'completed', beforeTokens: 160000, afterTokens: 20000 }) === '160k → 20k', 'token 段：大于 10k 不再保留一位小数')
  ok(view.compactionTokensText({ status: 'completed', beforeTokens: 800, afterTokens: 300 }) === '800 → 300', 'token 段：小于 1000 用原数')
  ok(view.compactionTokensText({ status: 'completed', beforeTokens: 100 }) === null, 'token 段：只有一端有数就不显示')
  ok(view.compactionTokensText({ status: 'failed' }) === null, 'token 段：失败时没有 token 段')

  /* ---- 6.5 C-2：回收比例与「此后新增量」（全在渲染端派生） ---- */
  console.log('\n--- C-2 压缩可观测性的两个派生量 ---')
  {
    const { compactionReclaimPercent, compactionReclaimText, compactionGrowthText } = view
    const completed = { status: 'completed', beforeTokens: 36_230, afterTokens: 18_400 }
    ok(compactionReclaimPercent(completed) === 49, `回收比例四舍五入到整数（${compactionReclaimPercent(completed)}）`)
    ok(compactionReclaimText(t, completed) === 'ctx.reclaimed(49)', '有前后 token 时给百分比')

    ok(
      compactionReclaimPercent({ status: 'completed', beforeTokens: 1000, afterTokens: 1200 }) === 0,
      '压完反而更大（摘要比原文长）→ 0%，不显示负数'
    )
    ok(
      compactionReclaimPercent({ status: 'completed', afterTokens: 160 }) === null,
      '缺压缩前 token → 不能算比例'
    )
    ok(
      compactionReclaimPercent({ status: 'completed', beforeTokens: 0, afterTokens: 0 }) === null,
      '压缩前为 0 → 不能算比例（不能除零，也不能报 100%）'
    )
    ok(
      compactionReclaimText(t, { status: 'completed', beforeTokens: 1000 }) === 'ctx.reclaimPending',
      '没有压缩后 token 时写「回收待测」，不编百分比'
    )

    ok(
      compactionGrowthText(t, { status: 'completed', afterTokens: 1000 }, 12_000)?.startsWith('ctx.growthAfter('),
      '有当前用量时给「此后新增」'
    )
    ok(
      compactionGrowthText(t, { status: 'completed', afterTokens: 12_000 }, 10_000) === null,
      '当前用量低于压缩后估算 → 不显示（不是“没新增”，是还没测准）'
    )
    ok(
      compactionGrowthText(t, { status: 'completed', afterTokens: 1000 }, undefined) === null,
      '当前用量未知（刚压完 pi 故意报 null）→ 不显示'
    )
    ok(
      compactionGrowthText(t, { status: 'completed', beforeTokens: 36_230 }, 99_999) === null,
      '缺压缩后 token → 不显示（没有基准就没有“新增”）'
    )
  }

  /* ---- 7. 项目信任（D21）：决定项目级设置算不算生效 ---- */
  console.log('\n--- D21 项目信任判定 ---')

  ok(projectTrustedFrom({ 'c:\\work\\proj': true }, 'C:\\work\\proj') === true, '大小写与反斜杠差异不影响命中')
  ok(projectTrustedFrom({ 'c:/work/proj': true }, 'C:/work/proj/') === true, '末尾斜杠不影响命中')
  ok(projectTrustedFrom({ 'c:/work': true }, 'C:/work/proj') === true, '父目录受信任则子目录也算')
  ok(projectTrustedFrom({ 'c:/work': false }, 'C:/work/proj') === false, '父目录明确不信任 → false（不继续向上找）')
  ok(projectTrustedFrom({ 'c:/other': true }, 'C:/work/proj') === false, '只有别的目录受信任 → false')
  ok(projectTrustedFrom({}, 'C:/work/proj') === false, '没有 trust.json / 空表 → 未信任')
  ok(projectTrustedFrom(null, 'C:/work/proj') === false, 'trust.json 读不到 → 未信任（宁可不那么肯定）')
  ok(projectTrustedFrom([], 'C:/work/proj') === false, 'trust.json 是数组（脏数据）→ 未信任')
}
