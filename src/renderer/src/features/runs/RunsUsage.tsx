import { useMoney } from '../../components/chat/UsageOverview'
import { useMemo, type ReactElement } from 'react'
import type { RunsHistoryRecord } from '../../../../shared/ipc'
import { isTerminalPhase, type RunSnapshot } from '../../../../shared/runs'
import type { RunLang } from '../../state/runs-v3'

export interface RunsUsageProps {
  records: readonly RunsHistoryRecord[]
  liveRuns: readonly RunSnapshot[]
  lang: RunLang
}

interface UsageText {
  title: string
  cost: string
  runs: string
  failed: string
  tools: string
  subagents: string
  none: string
}

function usageText(lang: RunLang): UsageText {
  if (lang === 'en-US') {
    return {
      title: 'Usage for this day',
      cost: 'Cost',
      runs: 'Runs',
      failed: 'Failed',
      tools: 'Tool calls',
      subagents: 'Active subagents',
      none: '—'
    }
  }
  return {
    title: '当日用量',
    cost: '费用',
    runs: '运行',
    failed: '失败',
    tools: '工具调用',
    subagents: '子 Agent 并发',
    none: '—'
  }
}

export function RunsUsage({ records, liveRuns, lang }: RunsUsageProps): ReactElement {
  const text = usageText(lang)
  const money = useMoney()
  const totals = useMemo(() => {
    let cost = 0
    let hasCost = false
    let tools = 0
    let failed = 0
    for (const record of records) {
      if (record.costUsd !== undefined) {
        cost += record.costUsd
        hasCost = true
      }
      tools += record.counts.tools
      if (record.terminal === 'failed') failed += 1
    }
    const subagents = liveRuns.filter((run) => run.kind === 'subagent' && !isTerminalPhase(run.phase)).length
    return { cost, hasCost, tools, failed, subagents }
  }, [records, liveRuns])

  return (
    <section className="runs-usage" aria-label={text.title} data-testid="runs-usage">
      <div className="runs-usage-item">
        <span className="runs-usage-label">{text.cost}</span>
        <span className="runs-usage-value">{totals.hasCost ? money(totals.cost) : text.none}</span>
      </div>
      <div className="runs-usage-item">
        <span className="runs-usage-label">{text.runs}</span>
        <span className="runs-usage-value">{records.length}</span>
      </div>
      <div className="runs-usage-item">
        <span className="runs-usage-label">{text.failed}</span>
        <span className="runs-usage-value">{totals.failed}</span>
      </div>
      <div className="runs-usage-item">
        <span className="runs-usage-label">{text.tools}</span>
        <span className="runs-usage-value">{totals.tools}</span>
      </div>
      <div className="runs-usage-item">
        <span className="runs-usage-label">{text.subagents}</span>
        <span className="runs-usage-value">{totals.subagents}</span>
      </div>
    </section>
  )
}
