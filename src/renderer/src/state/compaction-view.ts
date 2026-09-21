import type { CompactionRun, CompactionStatus } from '../../../shared/ipc'
import type { TFunc } from '../i18n'
import { formatTokens } from './context-view'

/**
 * 压缩状态 → 界面文案（N21-2）。
 *
 * 为什么单独一个纯模块：这是「reason/status 到底显示成什么」的**唯一**决策点，
 * 而它有三个必须钉死的边界：
 *   ① 认不出的 `reason` **不能**显示成「未知」——上游给了原文就显示原文，
 *      显示“未知”等于把信息丢掉（与 capability 三态同一个原则）；
 *   ② `declined`（上游决定不压缩）不能写成“失败”，`cancelled`（用户/扩展
 *      中断）也不能写成“失败”——三者的用户动作完全不同；
 *   ③ 压缩失败时那行**必须有话说**，不许静默。
 * 放在纯函数里就能把 reason × status 的整张表一次测完，不用起 Electron。
 */

/** 触发原因的可显示文本；连原文都没有时返回 null（界面就不显示这一段）。 */
export function compactionReasonText(t: TFunc, run: CompactionRun): string | null {
  /*
   * 砚按工作集发起时 pi 一律报 `manual`（对 pi 而言确实是“外部让它压的”）。
   * 显示「手动」会让用户以为是自己点的按钮 —— 以砚知道的发起方为准。
   */
  if (run.triggeredBy === 'policy') {
    return run.policyStage === 'emergency' ? t('ctx.reasonEmergency') : t('ctx.reasonPolicy')
  }
  if (run.reason === 'manual') return t('ctx.reasonManual')
  if (run.reason === 'threshold') return t('ctx.reasonThreshold')
  if (run.reason === 'overflow') return t('ctx.reasonOverflow')
  return run.reasonRaw ? run.reasonRaw : null
}

/** 结局的文本。 */
export function compactionStatusText(t: TFunc, status: CompactionStatus): string {
  if (status === 'completed') return t('ctx.statusCompleted')
  if (status === 'declined') return t('ctx.statusDeclined')
  if (status === 'failed') return t('ctx.statusFailed')
  if (status === 'cancelled') return t('ctx.statusCancelled')
  return t('ctx.statusRunning')
}

/**
 * 「阈值触发 · 已完成」。
 *
 * 没有原因时只给结局 —— 不要用「未知」占位（见模块头注释 ①）。
 */
export function compactionSummary(t: TFunc, run: CompactionRun): string {
  const reason = compactionReasonText(t, run)
  const status = compactionStatusText(t, run.status)
  return reason ? `${reason} · ${status}` : status
}

/**
 * 结局的语气色。
 *
 * `declined` / `cancelled` 用 warn 而不是 err：它们不是错误，
 * 但也不是“做完了”，值得看一眼。
 */
export function compactionTone(run: CompactionRun): 'ok' | 'warn' | 'err' {
  if (run.status === 'completed') return 'ok'
  if (run.status === 'failed') return 'err'
  return 'warn'
}

/**
 * 「1.6k → 160」。
 *
 * 只在两端都有数时给（pi 不一定两个都报）；精度随量级变 —— 1596 → `1.6k`，
 * 160000 → `160k`，都不假装比 pi 更精确。
 */
export function compactionTokensText(run: CompactionRun): string | null {
  if (typeof run.beforeTokens !== 'number' || typeof run.afterTokens !== 'number') return null
  return `${formatTokens(run.beforeTokens)} → ${formatTokens(run.afterTokens)}`
}

/**
 * 压缩回收比例（C-2「回收比例」）。
 *
 * 只在 before / after 都是可用数且 before > 0 时给值；`after > before`
 * （压完反而更大：摘要比原文长）夹到 0% —— 那是真实的“没回收到”，
 * 不该用负数或直接隐藏把它吞掉。缺任一端就返回 `null`，由界面写「待测」。
 */
export function compactionReclaimPercent(run: CompactionRun): number | null {
  const { beforeTokens, afterTokens } = run
  if (typeof beforeTokens !== 'number' || typeof afterTokens !== 'number') return null
  if (!Number.isFinite(beforeTokens) || beforeTokens <= 0) return null
  if (!Number.isFinite(afterTokens) || afterTokens < 0) return null
  const saved = beforeTokens - afterTokens
  return Math.max(0, Math.min(100, Math.round((saved / beforeTokens) * 100)))
}

/**
 * 「回收 90%」/「回收待测」。
 *
 * 为什么“待测”而不是不显示：用户问的是“这次压得到底有没有用”，
 * 而 pi 不一定报压缩后的 token。没数时不能说“没回收”（那是个结论），
 * 也不能编一个百分比（那是假证据）—— 只能明说还没测出来。
 */
export function compactionReclaimText(t: TFunc, run: CompactionRun): string {
  const percent = compactionReclaimPercent(run)
  if (percent === null) return t('ctx.reclaimPending')
  return t('ctx.reclaimed', { percent: String(percent) })
}

/**
 * 「此后新增 12k」—— 上一次压缩到现在又涨回来多少（C-2「此后新增量」）。
 *
 * 为什么在界面算而不是落进那次压缩的记录：它随**当前**用量变化，写进历史快照
 * 就成了会变的历史。两个前提缺一不可（有 `afterTokens`、当前用量已知），
 * 否则返回 `null` 不显示 —— 只增量为 0 不显示也是意：那是“没新增”，
 * 而这里常常只是“还没拿到下一条带 usage 的消息”。
 */
export function compactionGrowthText(
  t: TFunc,
  run: CompactionRun,
  currentTokens: number | undefined
): string | null {
  if (typeof run.afterTokens !== 'number') return null
  if (typeof currentTokens !== 'number' || !Number.isFinite(currentTokens)) return null
  const growth = Math.round(currentTokens - run.afterTokens)
  if (growth <= 0) return null
  return t('ctx.growthAfter', { tokens: formatTokens(growth) })
}

/**
 * 进行中那一行：「压缩中 · 已达阈值」。
 *
 * 拿不到原因时退回 `status.compacting`（pi 只说了在做，没说为什么）。
 */
export function compactionRunningText(t: TFunc, run: CompactionRun | undefined): string {
  const reason = run ? compactionReasonText(t, run) : null
  return reason ? t('ctx.compactingReason', { reason }) : t('status.compacting')
}
