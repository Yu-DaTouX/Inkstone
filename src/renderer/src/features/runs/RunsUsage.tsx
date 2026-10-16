/**
 * 运行总览的用量区（WP-54）。
 *
 * 数据分两半：当日费用 / 运行数 / 失败数 / 工具调用来自已读取的当天历史记录，
 * 子 Agent 并发来自渲染端实时运行镜像。只汇总记录里真实存在的 `costUsd`，
 * 一条都没有时显示「—」，不估算、不编额度。
 */
import { useMemo, type ReactElement } from 'react'
import type { RunsHistoryRecord } from '../../../../shared/ipc'
import { isTerminalPhase, type RunSnapshot } from '../../../../shared/runs'
import type { RunLang } from '../../state/runs-v3'

export interface RunsUsageProps {
  /** 当天全部历史记录（不随列表筛选变化）。 */
  records: readonly RunsHistoryRecord[]
  /** 实时运行快照，用来数当前活跃的子 Agent。 */
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
        <span className="runs-usage-value">{totals.hasCost ? `$${totals.cost.toFixed(2)}` : text.none}</span>
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
