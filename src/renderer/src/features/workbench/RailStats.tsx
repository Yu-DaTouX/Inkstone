import { useMemo, type ReactElement } from 'react'
import { MeterRing, MiniBars, Stat, StatGrid } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { selectSubagentRuns, subagentTokens } from '../../state/subagent-view'
import { projectSessionMetrics, stepSpeeds } from '../../../../shared/session-metrics'
import type { UIMessage } from '../../../../shared/ipc'
import { buildRailStats, railStatTitle, type RailStatsModel } from './rail-stats'

const SPEED_BARS = 12

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
    return buildRailStats({ metrics, historyPartial, subagentTokens: subTokens, speeds: stepSpeeds(messages, SPEED_BARS), t })
  }, [enabled, messages, stats, historyPartial, subagents, viewSessionId, t])
}

export function RailStatsBody({ model }: { model: RailStatsModel }): ReactElement {
  return (
    <StatGrid className="wb-rail-stats" data-testid="wb-rail-stats">
      {model.stats.map((stat) => (
        <Stat
          key={stat.key}
          data-stat={stat.key}
          title={railStatTitle(stat)}
          label={stat.label}
          value={stat.value}
          unit={stat.unit}
          span={stat.key === 'tps' ? 2 : undefined}
          aside={
            stat.key === 'tps' && model.speeds.length > 1 ? (
              <MiniBars values={model.speeds} />
            ) : stat.key === 'hitRate' && model.hitPercent !== null ? (
              <MeterRing aria-label={stat.label} value={model.hitPercent} minValue={0} maxValue={100} />
            ) : undefined
          }
        />
      ))}
    </StatGrid>
  )
}
