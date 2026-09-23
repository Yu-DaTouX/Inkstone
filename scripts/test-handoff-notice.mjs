/**
 * 交接状态一行提示的判定（实施-14 F5 / H5）。
 *
 * 这一层判错的两种方式都是静默的：
 *   · 判松 → 用户每轮都看到「正在整理上下文」（把正常对话变成一直有事在发生）；
 *   · 判紧 → 失败不显示，又回到用户报的「没有提示」。
 * 所以窗口边界、优先级（进行中 > 失败 > 成功）和「哪些事件算结论」都要钉死。
 *
 * 用法：npm run test:unit
 */
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

  /*
   * 常态不算失败（2026-09-23 用户现场：新会话第一眼就显示「整理未完成 ·
   * 这个片段还没有压够次数」）。
   *
   * 资格检查每回合结束都跑一次，所以每个会话都会留下 `below-threshold` ——
   * 把它当失败就等于「所有对话都在报错」。`getHandoff().events` 里仍然查得到它。
   */
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

  /* 原因翻人话：登记的翻，没登记的原样留（不能让真实原因消失） */
  ok(notice.handoffReasonText('timeout')?.includes('超时'), '登记过的原因翻成人话')
  ok(notice.handoffReasonText('some-new-code') === 'some-new-code', '没登记的原因原样回传')
  ok(notice.handoffReasonText(null) === null && notice.handoffReasonText('  ') === null, '空原因返回 null')

  /*
   * 「提示只属于它自己那条会话」（实施-14 F8，用户 2026-09-23 报）。
   *
   * 两者串起来才是完整链路：`getHandoff()` 先用 `eventsForSession` 把别的会话的
   * 事件剪掉，`handoffNoticeOf` 再判该不该显示。这里把「B 会话失败了，A 会话的提示
   * 不该变」这个用户可见的结论钉成单测。
   */
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
