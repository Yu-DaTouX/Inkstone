/**
 * 阶段运行状态（方案 §12.3）的单测。
 *
 * 为什么这些断言值得钉住：上膛 / 冷却的每一种错法都是**静默**的 ——
 *   · 少判一条重新上膛路径 → 阶段永久失效（界面上只会看到「再也不整理了」）；
 *   · 少判一条冷却 → 每轮都重试（真金白银，而且日志很吵）；
 *   · 两个阶段的 runtime 不小心共享 → 一个阶段动手之后另一个再也不动。
 * 三者都不会让应用崩，只能靠这里的边界断言 + 真实长会话的用量曲线发现。
 */
export async function runContextStageRuntimeTests(ok, { stage }) {
  const { createStageRuntime, stageStep, recordStageRun, recordStageObservation, STAGE_REARM_RATIO } = stage

  /* ---------------- 初始状态与缺省入参 ---------------- */

  const fresh = createStageRuntime()
  ok(fresh.armed === true, '新阶段默认已上膛')
  ok(stageStep({ runtime: fresh }).run === true, '初始状态可以直接跑')
  ok(stageStep({ runtime: undefined }).run === true, '没给 runtime 时按「新阶段」处理（不崩、也不拦住）')
  ok(stageStep({}).run === true, '完全不给参数也能判定')

  /* ---------------- disarm 之后的三条重新上膛路径 ---------------- */

  const disarmed = recordStageRun(createStageRuntime(), { now: 1000, ok: true, cooldownMs: 30_000 })
  ok(disarmed.armed === false, '执行过就上锁')
  ok(
    stageStep({ runtime: disarmed, now: 1000 + 31_000, rearmMs: 10 * 60_000 }).run === false,
    '冷却过了但还没到重试窗口、用量也没回落 → 仍然不上膛'
  )
  ok(
    stageStep({ runtime: disarmed, now: 31_000, tokens: 100, line: 1000, rearmMs: 10 * 60_000 }).run === true,
    '用量回落到线下 → 重新上膛（冷却已过、重试窗口还没到，只有这一条路径能放行）'
  )
  ok(
    stageStep({
      runtime: disarmed,
      now: 1000,
      tokens: 1000 * STAGE_REARM_RATIO,
      line: 1000,
      rearmMs: 10 * 60_000
    }).run === false,
    '用量刚好等于「线 × 0.9」不算回落（边界是严格小于，避免临界值抖动着一直重跑）'
  )
  ok(
    stageStep({ runtime: disarmed, now: 1000 + 10 * 60_000, rearmMs: 10 * 60_000 }).run === true,
    '超过重试窗口 → 重新上膛（上一次失败时用量不会回落，只靠回落会让阶段永久失效）'
  )
  ok(
    stageStep({ runtime: disarmed, now: 1000 + 31_000, rearmMs: 10 * 60_000 }).reason === 'waiting-rearm',
    '不上膛时给出可解释的原因（不是静默返回 false）'
  )

  /* ---------------- 冷却窗口（与上膛是两件事） ---------------- */

  const cooling = stageStep({ runtime: disarmed, now: 1000 + 10_000, tokens: 1, line: 1000 })
  ok(cooling.run === false && cooling.reason === 'cooling', '用量已回落、但冷却还没到期 → 仍然不动（上膛与冷却是两件事）')
  ok(
    stageStep({ runtime: disarmed, now: 31_000, rearmMs: 0 }).run === true,
    '冷却到期那一刻就放行（边界是「早于才拦」，否则会白白多等一轮；`rearmMs:0` 单独排掉重试窗口那条路径）'
  )

  /* ---------------- 成功与失败都上锁（方案 §12.3：失败要 disarm） ---------------- */

  const failed = recordStageRun(createStageRuntime(), { now: 2000, ok: false })
  ok(failed.armed === false && failed.lastOk === false, '失败同样 disarm（否则下一轮还会再试一次）')
  ok(failed.cooldownUntil === 2000 + 30_000, '失败用默认冷却')
  const okRun = recordStageRun(createStageRuntime(), { now: 2000, ok: true, cooldownMs: 5000 })
  ok(okRun.cooldownUntil === 7000, '成功的冷却时长可配（每阶段自己的默认值）')
  ok(
    recordStageRun(disarmed, { now: 9000, ok: true, cooldownMs: 1 }).lastReclaimedCount === 0,
    '这次没给回收量时保留上一次的值（不把已有观测抹成 undefined）'
  )
  ok(
    recordStageRun(disarmed, { now: 9000, ok: true, reclaimedCount: 42 }).lastReclaimedCount === 42,
    '给了回收量就记下来'
  )

  /* ---------------- 两个阶段互不影响（§12.11 第 4 条） ---------------- */

  const sweep = createStageRuntime()
  const fold = createStageRuntime()
  const sweepAfter = recordStageObservation(sweep, { now: 5000, reclaimedCount: 7 })
  ok(sweepAfter.armed === true, 'sweep 只留痕、不上锁（幂等且便宜，加了冷却会压住后续清理）')
  ok(sweepAfter.lastReclaimedCount === 7 && sweepAfter.lastRunAt === 5000, '留痕记下时间与回收量')
  ok(fold.armed === true && fold.lastRunAt === undefined, '一个阶段留痕不影响另一个阶段')
  const foldAfter = recordStageRun(fold, { now: 6000, ok: true })
  ok(foldAfter.armed === false, '另一个阶段可以独立上锁')
  ok(
    stageStep({ runtime: foldAfter, now: 6000 + 31_000, rearmMs: 0 }).run === true &&
      stageStep({ runtime: sweepAfter, line: 100, tokens: 1 }).run === true,
    '两个 runtime 各自判定，互不牵连'
  )
  ok(
    recordStageObservation({ armed: false, lastRunAt: 1, cooldownUntil: 2, lastReclaimedCount: 3 }, { now: 9 })
      .armed === false,
    '观测记录不会把一个已上锁的阶段悄悄解锁'
  )

  /* ---------------- 纯函数与脏输入 ---------------- */

  const frozen = Object.freeze({
    armed: false,
    lastRunAt: 100,
    cooldownUntil: 200,
    lastOk: true,
    lastReclaimedCount: 5
  })
  let mutated = false
  try {
    stageStep({ runtime: frozen, now: 300 })
    recordStageRun(frozen, { now: 300, ok: true })
    recordStageObservation(frozen, { now: 300, reclaimedCount: 1 })
  } catch {
    mutated = true
  }
  ok(!mutated, '三个函数都不修改传入的 runtime（冻结对象下不抛错）')
  ok(
    stageStep({ runtime: createStageRuntime(), now: Number.NaN }).run === true,
    '`now` 非法时退回当前时间而不是判成「没过冷却」'
  )
  ok(
    recordStageRun(createStageRuntime(), { now: Number.NaN }).cooldownUntil > Date.now() - 1000,
    '`now` 非法时冷却起点退回当前时间'
  )
}
