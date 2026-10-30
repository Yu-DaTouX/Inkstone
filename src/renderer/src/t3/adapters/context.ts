import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useContextUsage } from '../../patterns/ContextRing'

export interface ContextWindowCost {
  readonly amount: number
  readonly currency: string
}

export interface ContextWindowSnapshot {
  readonly usedTokens: number
  readonly maxTokens: number | null
  readonly usedPercentage: number | null
  readonly totalProcessedTokens: number | null
  readonly cost: ContextWindowCost | null
  readonly compactsAutomatically: boolean
  readonly autoCompactThreshold: number | null
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '0'
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
  if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

export function useContextWindowSnapshot(): ContextWindowSnapshot | null {
  const { known, tokens, windowSize, percent, autoCompactLimit } = useContextUsage()
  const stats = useStore((s) => s.stats)
  const session = useStore((s) => s.session)
  if (!known) return null
  const total = stats?.tokens.total ?? null
  const cost = stats && typeof stats.cost === 'number' && stats.cost > 0 ? stats.cost : null
  return {
    usedTokens: tokens,
    maxTokens: windowSize > 0 ? windowSize : null,
    usedPercentage: percent,
    totalProcessedTokens: typeof total === 'number' && total > 0 ? total : null,
    cost: cost === null ? null : { amount: cost, currency: '$' },
    compactsAutomatically: session?.autoCompactionEnabled !== false,
    autoCompactThreshold: autoCompactLimit ?? null
  }
}

export interface ContextCompactAdapter {
  modelDisplayName: string | null
  busy: boolean
  onCompact: () => void
  compactDisabled: boolean
  compactDisabledReason: string | null
}

export function useContextCompactAdapter(): ContextCompactAdapter {
  const t = useT()
  const session = useStore((s) => s.session)
  const compact = useStore((s) => s.compact)
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const hasSession = !!session?.sessionId
  return {
    modelDisplayName: session?.model?.name ?? null,
    busy,
    onCompact: () => void compact(),
    compactDisabled: !hasSession || busy,
    compactDisabledReason: busy ? t('composer.t3.compactBusy') : null
  }
}
