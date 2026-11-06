import { useStore } from '../state/store'
import { autoCompactLimitOf, contextUsageSummary } from '../features/workbench/context-pane-view'

export function useContextUsage() {
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const usage = stats?.contextUsage
  const autoCompactTokens = useStore((s) => s.settings?.autoCompactTokens)
  const autoCompactLimit = autoCompactLimitOf(session, { autoCompactTokens })
  const summary = contextUsageSummary(session, stats, autoCompactLimit)
  return {
    autoCompactLimit,
    summary,
    session,
    usage,
    matches: summary.matchesModel,
    windowSize: summary.windowSize,
    known: summary.known,
    tokens: summary.tokens,
    percent: summary.percent,
    tone: summary.tone,
    windowAssumed: summary.windowAssumed
  }
}
