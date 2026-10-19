import { useMemo, type ReactElement } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { selectSubagentRuns, subagentTokens } from '../../state/subagent-view'
import { projectSessionMetrics } from '../../../../shared/session-metrics'
import type { UIMessage } from '../../../../shared/ipc'
import { buildRailStats, type RailStatsModel, type RailStatsRow } from './rail-stats'

export function useRailStats(messages: UIMessage[], enabled: boolean): RailStatsModel | null {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const peekNote = useStore((s) => s.peekNote)
  const subagents = useStore((s) => s.subagents)
  const viewSessionId = useStore((s) => s.peekedSessionId ?? s.session?.sessionId ?? null)
  const historyPartial = (peekNote?.truncated ?? 0) > 0
  return useMemo(() => {
    if (!enabled) return null
    const metrics = projectSessionMetrics(messages, stats, { historyPartial })
    const subTokens = subagentTokens(
      selectSubagentRuns(subagents, { sessionIds: viewSessionId ? [viewSessionId] : [] }).all
    )
    return buildRailStats({ metrics, historyPartial, subagentTokens: subTokens, t })
  }, [enabled, messages, stats, historyPartial, subagents, viewSessionId, t])
}

function StatsRows({ rows, testId }: { rows: RailStatsRow[]; testId: string }): ReactElement {
  return (
    <ul className="wb-ov-items" data-testid={testId}>
      {rows.map((row) => (
        <li key={row.key} className="wb-ov-item" title={`${row.label} ${row.value}`}>
          <span className="wb-ov-item-label">{row.label}</span>
          <span className="wb-ov-item-value ui-meta-num">{row.value}</span>
        </li>
      ))}
    </ul>
  )
}

export function RailStatsBody({ model }: { model: RailStatsModel }): ReactElement {
  return (
    <>
      <StatsRows rows={model.session} testId="wb-rail-stats-session" />
      <StatsRows rows={model.tokens} testId="wb-rail-stats-tokens" />
      {model.notes.map((note) => (
        <p key={note} className="wb-ov-note">
          {note}
        </p>
      ))}
    </>
  )
}
