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
 * 进行中那一行：「压缩中 · 已达阈值」。
 *
 * 拿不到原因时退回 `status.compacting`（pi 只说了在做，没说为什么）。
 */
export function compactionRunningText(t: TFunc, run: CompactionRun | undefined): string {
  const reason = run ? compactionReasonText(t, run) : null
  return reason ? t('ctx.compactingReason', { reason }) : t('status.compacting')
}
