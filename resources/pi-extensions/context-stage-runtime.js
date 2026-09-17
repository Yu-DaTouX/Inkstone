/**
 * 阶段运行状态（方案 §12.3 的统一流程）。
 *
 * ── 为什么需要它 ──
 * 「超过阈值 → 每轮都尝试执行」是本项目已经踩过的坑（阶段 3 的 D30）：
 * 压缩失败后每一轮都重试一次，日志很吵、额度也在烧。当时的修法是给压缩加三个
 * 参数：`armed`（上膛）/ `cooldownUntil`（冷却）/ 重试窗口（`rearmMs`）。
 * 阶段 4 有三个阶段，所以把这三个参数从「压缩专用」抽成**每个阶段一份**。
 *
 * ── 为什么是纯函数 ──
 * 上膛 / 冷却的判定错一个分支，后果是「该整理时不动」或者「每轮都动」——
 * 两者都不报错，都要靠真实长会话才看得出来。抽成纯函数就能把边界一次算清。
 *
 * ── 运行状态住在哪：谁执行阶段，谁持有它 ──
 *   · `tool-sweep` / `episode-fold` 由本扩展执行 → 状态在扩展内存里（本模块的调用方持有）；
 *   · `compaction` 由**主进程**执行 → 状态是 `src/shared/context-policy.ts` 的 `ContextPolicyState`。
 * 两组状态不共享任何东西（连进程都不是同一个），所以「一个阶段 disarm 不影响
 * 另一个」是**结构上成立**的，不需要额外机制去保证 —— 这也是 §12.11 第 4 条的验收口径。
 *
 * ── 为什么 `tool-sweep` 不受冷却约束（有意的例外）──
 * 方案 §12.3 的注脚写着「sweep 是幂等的，重复尝试无副作用」，而它的准入已经由
 * **收益门槛**（`minReclaimTokens`）把关 —— 没有可回收的东西时它本来就不动。
 * 再加一道冷却只会带来真实损失：被冷却窗口盖住的那几轮里新产生的工具输出不会被
 * 清理，上下文继续往上涨，而 sweep 正是压缩前的第一道防线。
 * 所以 sweep 只**记录**运行状态（观测与将来调参）而不因此跳过；
 * 真正需要冷却的是 `episode-fold`（一次模型调用）与 `compaction`（一次真实压缩）。
 */

/** 重新上膛的水位比例：用量回落到「线 × 0.9」以下才算上一次真的生效了 */
export const STAGE_REARM_RATIO = 0.9

/** 每阶段的默认冷却 / 重试窗口（与主进程 `POLICY_COOLDOWN_MS` / `POLICY_REARM_MS` 同值） */
export const STAGE_COOLDOWN_MS = 30_000
export const STAGE_REARM_MS = 5 * 60_000

/** 初始运行状态：可以跑、没有冷却 */
export function createStageRuntime() {
  return {
    armed: true,
    lastRunAt: undefined,
    cooldownUntil: undefined,
    lastOk: undefined,
    lastReclaimedCount: 0
  }
}

/**
 * 「到线之后能不能动手」的判定。
 *
 * 调用方必须**先**确认「到线了」（水位 / 收益门槛 / 脏判定都过了）——
 * 本函数只回答上膛与冷却这两件事。顺序不能颠倒：反过来会让「还没到线」的轮次
 * 也消耗冷却，于是真正到线时反而被自己的冷却挡住。
 *
 * `tokens` / `line` 给「用量回落」那条重新上膛路径用；拿不到（扩展侧没有主进程的
 * 工作集）时传 `null`，此时只剩时间窗口那条路径 —— 与 `POLICY_REARM_MS` 的用意相同：
 * 上一次执行**失败**时用量永远不会回落，只靠回落会让这个阶段永久失效。
 */
export function stageStep({ runtime, line, tokens, now, cooldownMs, rearmMs } = {}) {
  const state = runtime ?? createStageRuntime()
  const at = Number.isFinite(now) ? now : Date.now()
  const sinceRun = state.lastRunAt === undefined ? Infinity : at - state.lastRunAt
  const window = Number.isFinite(rearmMs) ? rearmMs : STAGE_REARM_MS
  const rearmed =
    state.armed === true ||
    (Number.isFinite(tokens) && Number.isFinite(line) && tokens < line * STAGE_REARM_RATIO) ||
    sinceRun >= window
  if (!rearmed) return { run: false, reason: 'waiting-rearm', runtime: { ...state, armed: false } }
  const cool = Number.isFinite(cooldownMs) ? cooldownMs : STAGE_COOLDOWN_MS
  if (state.cooldownUntil !== undefined && at < state.cooldownUntil) {
    return { run: false, reason: 'cooling', runtime: { ...state, armed: true } }
  }
  return { run: true, reason: 'run', runtime: { ...state, armed: true } }
}

/**
 * 记一次**真实执行**（成功或失败）并立即上锁（`armed = false`）。
 *
 * 成功与失败都要 disarm（方案 §12.3：失败要 disarm，否则下一轮还会再试一次），
 * 两者都用同样的冷却 —— 失败时更需要它。`lastOk` 只是留痕，判定不看它：
 * 成功的下一次也应当等冷却，否则「刚刷完状态又刷一次」同样没有意义。
 */
export function recordStageRun(runtime, { now, ok, cooldownMs, reclaimedCount } = {}) {
  const state = runtime ?? createStageRuntime()
  const at = Number.isFinite(now) ? now : Date.now()
  const cool = Number.isFinite(cooldownMs) ? cooldownMs : STAGE_COOLDOWN_MS
  return {
    armed: false,
    lastRunAt: at,
    cooldownUntil: at + cool,
    lastOk: ok === true,
    lastReclaimedCount: Number.isFinite(reclaimedCount)
      ? reclaimedCount
      : state.lastReclaimedCount ?? 0
  }
}

/**
 * 只留痕、**不动上锁状态**（`tool-sweep` 用；见文件头「为什么 sweep 不受冷却约束」）。
 *
 * 为什么还要有它：将来调 `minReclaimTokens` 这类数值时，第一个要问的就是
 * 「它上一次到底动了多少」—— 没有这条记录就只能靠猜。
 */
export function recordStageObservation(runtime, { now, reclaimedCount } = {}) {
  const state = runtime ?? createStageRuntime()
  const at = Number.isFinite(now) ? now : Date.now()
  return {
    ...state,
    armed: state.armed !== false,
    lastRunAt: at,
    lastReclaimedCount: Number.isFinite(reclaimedCount)
      ? reclaimedCount
      : state.lastReclaimedCount ?? 0
  }
}
