import type { CompactionRun, CompactionStatus } from '../../../shared/ipc'
import type { TFunc } from '../i18n'

export function compactionReasonText(t: TFunc, run: CompactionRun): string | null {
  if (run.triggeredBy === 'policy') {
    return run.policyStage === 'emergency' ? t('ctx.reasonEmergency') : t('ctx.reasonPolicy')
  }
  if (run.reason === 'manual') return t('ctx.reasonManual')
  if (run.reason === 'threshold') return t('ctx.reasonThreshold')
  if (run.reason === 'overflow') return t('ctx.reasonOverflow')
  return run.reasonRaw ? run.reasonRaw : null
}

export function compactionStatusText(t: TFunc, status: CompactionStatus): string {
  if (status === 'completed') return t('ctx.statusCompleted')
  if (status === 'declined') return t('ctx.statusDeclined')
  if (status === 'failed') return t('ctx.statusFailed')
  if (status === 'cancelled') return t('ctx.statusCancelled')
  return t('ctx.statusRunning')
}

export function compactionSummary(t: TFunc, run: CompactionRun): string {
  const reason = compactionReasonText(t, run)
  const status = compactionStatusText(t, run.status)
  return reason ? `${reason} · ${status}` : status
}

export function compactionTone(run: CompactionRun): 'ok' | 'warn' | 'err' {
  if (run.status === 'completed') return 'ok'
  if (run.status === 'failed') return 'err'
  return 'warn'
}

export function compactionTokensText(run: CompactionRun): string | null {
  if (typeof run.beforeTokens !== 'number' || typeof run.afterTokens !== 'number') return null
  return `${formatTokens(run.beforeTokens)} → ${formatTokens(run.afterTokens)}`
}

export function compactionReclaimPercent(run: CompactionRun): number | null {
  const { beforeTokens, afterTokens } = run
  if (typeof beforeTokens !== 'number' || typeof afterTokens !== 'number') return null
  if (!Number.isFinite(beforeTokens) || beforeTokens <= 0) return null
  if (!Number.isFinite(afterTokens) || afterTokens < 0) return null
  const saved = beforeTokens - afterTokens
  return Math.max(0, Math.min(100, Math.round((saved / beforeTokens) * 100)))
}

export function compactionReclaimText(t: TFunc, run: CompactionRun): string {
  const percent = compactionReclaimPercent(run)
  if (percent === null) return t('ctx.reclaimPending')
  return t('ctx.reclaimed', { percent: String(percent) })
}

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

export function compactionRunningText(t: TFunc, run: CompactionRun | undefined): string {
  const reason = run ? compactionReasonText(t, run) : null
  return reason ? t('ctx.compactingReason', { reason }) : t('status.compacting')
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}
