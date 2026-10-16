import type { ContextNextStage, ContextOperationKind } from '../../../shared/ipc'
import type { TFunc } from '../i18n'

export const CONTEXT_STAGES: readonly ContextOperationKind[] = [
  'tool-sweep',
  'episode-fold',
  'compaction'
]

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}

export function contextStageLabel(t: TFunc, kind: ContextOperationKind): string {
  if (kind === 'tool-sweep') return t('ctx.stageSweep')
  if (kind === 'episode-fold') return t('ctx.stageFold')
  if (kind === 'compaction') return t('ctx.stageCompact')
  return t('ctx.stageRecall')
}

export function contextStageWhat(t: TFunc, kind: ContextOperationKind): string {
  if (kind === 'tool-sweep') return t('ctx.stageWhatSweep')
  if (kind === 'episode-fold') return t('ctx.stageWhatFold')
  if (kind === 'compaction') return t('ctx.stageWhatCompact')
  return t('ctx.stageWhatRecall')
}

export function contextStageTip(
  t: TFunc,
  kind: ContextOperationKind,
  opts: { at: number; ratio: number; active: boolean }
): string {
  const name = contextStageLabel(t, kind)
  const what = contextStageWhat(t, kind)
  const pct = Math.max(0, Math.round(opts.ratio * 100))
  return opts.active
    ? t('ctx.stageTip', { name, what, pct, n: formatTokens(opts.at) })
    : t('ctx.stagePlannedTip', { name, what, pct })
}

export function nextContextStageText(t: TFunc, stage: ContextNextStage): string {
  if (stage.reached) return t('ctx.nextReached', { name: contextStageLabel(t, stage.kind) })
  if (stage.kind === 'tool-sweep') return t('ctx.nextSweep', { n: formatTokens(stage.at) })
  if (stage.kind === 'episode-fold') return t('ctx.nextFold', { n: formatTokens(stage.at) })
  if (stage.kind === 'compaction') return t('ctx.nextCompact', { n: formatTokens(stage.at) })
  return contextStageLabel(t, stage.kind)
}
