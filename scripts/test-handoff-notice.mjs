export async function runHandoffNoticeTests(ok, notice, diagnostics) {
  const ev = (stage, outcome, at, reason = null) => ({ at, stage, outcome, reason, op: null, handoffId: null, runnerId: null, sessionKey: null, detail: {} })
  const view = (over = {}) => ({
    sessionKey: 'C:/s/a.jsonl',
    tally: null,
    segmentTally: null,
    chainSegments: 1,
    package: null,
    pending: false,
    threshold: 2,
    transaction: null,
    events: [],
    autoCommit: true,
    ...over
  })
  const NOW = 1_000_000

  ok(notice.handoffNoticeOf(null, NOW) === null, '没有状态快照 → 不显示（启动早期不占地方）')
  ok(notice.handoffNoticeOf(view(), NOW) === null, '没有事件 → 不显示')
  ok(
    notice.handoffNoticeOf(view({ pending: true }), NOW)?.tone === 'working',
    '正在生成交接包 → 「任务继续中」（无感但不静默）'
  )

  ok(
    notice.handoffNoticeOf(view({ events: [ev('generate', 'request-written', NOW - 1_000)] }), NOW) === null,
    '只写了请求（还没有结论）→ 不显示（那是进行中，由 pending 表达）'
  )

  const ready = notice.handoffNoticeOf(view({ events: [ev('generate', 'package-ready', NOW - 5_000)] }), NOW)
  ok(ready?.tone === 'done' && ready.canRetry === false, '包刚生成 → 短暂显示「已整理」')
  ok(
    notice.handoffNoticeOf(view({ events: [ev('generate', 'package-ready', NOW - 90_000)] }), NOW) === null,
    '成功超过窗口 → 自动收起（不长期占地方）'
  )

  const timeout = notice.handoffNoticeOf(
    view({
      events: [ev('generate', 'package-ready', NOW - 90_000), ev('generate', 'abandoned', NOW - 10_000, 'timeout')]
    }),
    NOW
  )
  ok(timeout?.tone === 'failed' && timeout.reason === 'timeout' && timeout.canRetry === true, '超时放弃 → 失败态 + 可重试')

  const recovered = notice.handoffNoticeOf(
    view({
      events: [
        ev('generate', 'abandoned', NOW - 30_000, 'timeout'),
        ev('commit', 'ok', NOW - 10_000)
      ]
    }),
    NOW
  )
  ok(recovered?.tone === 'done', '失败之后又成功 → 回到成功态（不把陈旧失败一直挂着）')

  ok(
    notice.handoffNoticeOf(view({ events: [ev('generate', 'result-mismatch', NOW - 1_000, 'result-not-for-this-operation')] }), NOW) ===
      null,
    '结果文件 id 对不上不算失败（本次操作还在正常等待）'
  )

  const routine = [
    ev('eligibility', 'rejected', NOW - 1_000, 'below-threshold'),
    ev('eligibility', 'rejected', NOW - 2_000, 'no-goal'),
    ev('eligibility', 'rejected', NOW - 3_000, 'not-autonomous'),
    ev('eligibility', 'rejected', NOW - 4_000, 'busy'),
    ev('safety-boundary', 'rejected', NOW - 5_000, 'source-watermark-moved'),
    ev('generate', 'abandoned', NOW - 6_000, 'user-message'),
    ev('generate', 'abandoned', NOW - 7_000, 'user-stop'),
    ev('generate', 'abandoned', NOW - 8_000, 'manual-retry')
  ]
  ok(notice.handoffNoticeOf(view({ events: routine }), NOW) === null, '常态拒绝 / 用户自己打断 → 一行都不显示')
  ok(
    notice.handoffNoticeOf(view({ events: [...routine, ev('generate', 'unparsable', NOW - 500, 'no-json-object')] }), NOW)
      ?.tone === 'failed',
    '混在常态里的**真失败**照旧显示（不是把这一层筛没了）'
  )

  const boundary = notice.handoffNoticeOf(
    view({ events: [ev('generate', 'package-ready', NOW - notice.HANDOFF_DONE_WINDOW_MS)] }),
    NOW
  )
  ok(boundary?.tone === 'done', '成功窗口的边界值仍算「刚发生」')

  ok(notice.handoffReasonText('timeout')?.includes('超时'), '登记过的原因翻成人话')
  ok(notice.handoffReasonText('some-new-code') === 'some-new-code', '没登记的原因原样回传')
  ok(notice.handoffReasonText(null) === null && notice.handoffReasonText('  ') === null, '空原因返回 null')

  if (typeof diagnostics?.eventsForSession !== 'function') throw new Error('缺少 shared/handoff-diagnostics 的 eventsForSession')
  {
    const mine = 'C:/tmp/sessions/a.jsonl'
    const other = 'C:/tmp/sessions/b.jsonl'
    const failedOther = {
      at: NOW - 1_000,
      stage: 'generate',
      outcome: 'unparsable',
      op: null,
      handoffId: null,
      runnerId: 'run-b',
      sessionKey: other,
      reason: 'no-json-object',
      detail: {}
    }
    const visible = (events) => notice.handoffNoticeOf(view({ sessionKey: mine, events }), NOW)
    ok(visible([failedOther])?.tone === 'failed', '前提：这条事件本身确实是「失败」口气')
    ok(
      visible(diagnostics.eventsForSession([failedOther], { keys: [mine], runnerId: 'run-a' })) === null,
      '别的会话的失败不会让本条会话弹出「整理未完成」'
    )
    ok(
      visible(
        diagnostics.eventsForSession([failedOther, { ...failedOther, runnerId: 'run-a', sessionKey: mine }], {
          keys: [mine],
          runnerId: 'run-a'
        })
      )?.tone === 'failed',
      '自己会话的失败照旧显示（筛得准，不是筛没了）'
    )
  }
}
