/**
 * 单一调度判定与操作所有权的测试（实施-14 F2 / H1+H2）。
 *
 * 这两件事都不碰 IO，所以判定必须钉在纯函数层：宿主 `index.ts` 里那张
 * `Map` 与两个定时器无法在单测里构造真实竞态，但**优先级**和
 * 「旧回调还算不算数」是可以穷举的 —— 而它们正是现场那两类故障的根：
 * 「源一边交接一边续跑」、「旧 timeout 清掉了新操作」。
 *
 * 用法：npm run test:unit
 */
export async function runHandoffScheduleTests(ok, shared) {
  const { decideSessionWork, ownsHandoffOperation, sessionWorkSummary } = shared

  /* ---------------------------------------------- 优先级（H1） */

  ok(
    decideSessionWork({ busy: true, handoffPending: true, errorRetryPending: true, handoffAllowed: true }) ===
      'wait-busy',
    'H1：实例仍在工作 → 什么都不做（安全边界未到，优先级最高）'
  )
  ok(
    decideSessionWork({ busy: false, handoffPending: true, errorRetryPending: true, handoffAllowed: true }) ===
      'wait-error-retry',
    'H1：已排模型错误重试 → 不做别的（免得两条腿抢同一个回合）'
  )
  ok(
    decideSessionWork({ busy: false, handoffPending: true, errorRetryPending: false, handoffAllowed: true }) ===
      'wait-handoff',
    'H1：交接在准备包 → 冻结源续跑'
  )
  ok(
    decideSessionWork({ busy: false, handoffPending: false, errorRetryPending: false, handoffAllowed: true }) ===
      'prefer-handoff',
    'H1：空闲且允许交接 → 先试交接'
  )
  ok(
    decideSessionWork({ busy: false, handoffPending: false, errorRetryPending: false, handoffAllowed: false }) ===
      'continue',
    'H1：不允许交接 → 直接普通续跑'
  )

  /* 每个分支都有可读原因（排障时不能只看到一个空动作） */
  const summaries = [
    sessionWorkSummary('wait-busy'),
    sessionWorkSummary('wait-error-retry'),
    sessionWorkSummary('wait-handoff'),
    sessionWorkSummary('prefer-handoff'),
    sessionWorkSummary('continue')
  ]
  ok(
    summaries.every((text) => typeof text === 'string' && text.length > 0) && new Set(summaries).size === 5,
    'H1：五种决定各有不同的可读摘要'
  )

  /* ---------------------------------------------- 操作所有权（H2） */

  ok(ownsHandoffOperation('op-1', undefined) === true, 'H2：不带身份的回调按当前操作处理（同步调用点）')
  ok(ownsHandoffOperation('op-1', 'op-1') === true, 'H2：带当前身份 → 拥有')
  ok(ownsHandoffOperation('op-2', 'op-1') === false, 'H2：带旧身份 → 不拥有（旧 timeout 不能清新操作）')
  ok(ownsHandoffOperation(null, 'op-1') === false, 'H2：当前没有操作时，带身份的旧回调不拥有任何东西')
  ok(ownsHandoffOperation('', '') === true, 'H2：空身份等同「没带」')
  ok(ownsHandoffOperation('op-1', '  ') === true, 'H2：空白身份等同「没带」')
  ok(ownsHandoffOperation(' op-1 ', 'op-1') === true, 'H2：身份比较前先去空白')

  /* ---------------------------------------------- 常态拒绝记账去重（F8） */

  const log = new shared.EligibilityRejectLog()
  ok(log.shouldRecord('r1', 'below-threshold', 0) === true, 'F8：同一结论第一次出现 → 记一条')
  ok(log.shouldRecord('r1', 'below-threshold', 0) === false, 'F8：同一个结论（原因与次数都没变）→ 不再刷屏')
  ok(log.shouldRecord('r1', 'below-threshold', 1) === true, 'F8：次数变了 → 结论变了，再记一条')
  ok(log.shouldRecord('r1', 'no-goal', 1) === true, 'F8：原因变了 → 再记一条')
  ok(log.shouldRecord('r2', 'below-threshold', 1) === true, 'F8：另一个实例各算各的')
}
