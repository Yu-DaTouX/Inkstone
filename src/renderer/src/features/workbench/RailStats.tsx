import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { MiniBars, SegmentBar, Swatch } from '../../ui'
import { useT } from '../../i18n'
import { useStore, type Store } from '../../state/store'
import { useStreamingThrottledStore } from '../../state/streaming-throttle'
import { subagentCost, subagentTokens, viewSubagentRuns } from '../../state/subagent-view'
import { useMoney } from '../usage/UsageOverview'
import {
  latencyFloor,
  liveActivitySince,
  liveStepId,
  projectSessionMetrics,
  splitLiveStep,
  stepSpeeds,
  windowSpeed
} from '../../../../shared/session-metrics'
import type { UIMessage } from '../../../../shared/ipc'
import { buildRailStats, railTimeText, retainRailSpeed, type RailFact, type RailSpeedHold, type RailSegment, type RailStatsModel } from './rail-stats'
import { railOperationCounts, useToolStructureMessages } from './rail-data'
import { sessionViewIdentity } from '../session/view-state'
import './rail-stats.css'

const SPEED_BARS = 12

interface RailSnapshot {
  messages: UIMessage[]
  liveId: string | null
  running: boolean
}

function railSnapshot(s: Store): RailSnapshot {
  const peeking = !!s.peekedSessionId
  return {
    messages: s.messages,
    liveId: peeking ? null : liveStepId(s.messages, !!s.session?.isStreaming),
    running: !peeking && (!!s.session?.isStreaming || !!s.session?.isAgentRunning)
  }
}

function sameSnapshot(a: RailSnapshot, b: RailSnapshot): boolean {
  return a.messages === b.messages && a.liveId === b.liveId && a.running === b.running
}

function viewKey(s: Store): string {
  return sessionViewIdentity({ session: s.session, peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath }).key
}

export function useRailStats(enabled: boolean): RailStatsModel | null {
  const t = useT()
  const money = useMoney()
  const snapshot = useStreamingThrottledStore(railSnapshot, undefined, sameSnapshot)
  const stats = useStore((s) => s.stats)
  const peekNote = useStore((s) => s.peekNote)
  const view = useStore(viewKey)
  const childTokens = useStore((s) => (enabled ? subagentTokens(viewSubagentRuns(s)) : 0))
  const childCost = useStore((s) => (enabled ? subagentCost(viewSubagentRuns(s)) : 0))
  const historyPartial = (peekNote?.truncated ?? 0) > 0
  const speedHold = useRef<RailSpeedHold | null>(null)
  const countSource = useToolStructureMessages(snapshot.messages)
  const counts = useMemo(() => (enabled ? railOperationCounts(countSource) : null), [enabled, countSource])
  const history = useMemo(() => {
    if (!enabled) return null
    const { messages, liveId, running } = snapshot
    const { settled, live } = splitLiveStep(messages, liveId)
    const floor = latencyFloor(settled)
    const reading = windowSpeed(settled, live, floor)
    const identity = JSON.stringify([view, messages.findLast((message) => message.role === 'user')?.id])
    speedHold.current = retainRailSpeed(speedHold.current, identity, reading)
    const heldReading = speedHold.current.sample
    return {
      metrics: projectSessionMetrics(settled, stats, { historyPartial }),
      counts: counts ?? railOperationCounts(messages),
      speeds: stepSpeeds(settled, live ? SPEED_BARS - 1 : SPEED_BARS),
      heldReading,
      running,
      liveSince: liveActivitySince(messages, live, running)
    }
  }, [enabled, snapshot, stats, historyPartial, view, counts])
  return useMemo(() => {
    if (!history) return null
    const { metrics, counts, speeds, heldReading, running, liveSince } = history
    return buildRailStats({
      metrics,
      counts,
      historyPartial,
      subagentTokens: childTokens,
      subagentCost: childCost,
      speeds,
      latestSpeed: heldReading?.speed ?? null,
      latestSpeedEstimated: heldReading?.estimated ?? false,
      liveSpeed: running ? (heldReading?.speed ?? null) : undefined,
      liveSpeedEstimated: heldReading?.estimated ?? false,
      liveSince,
      money,
      t
    })
  }, [history, historyPartial, childTokens, childCost, money, t])
}

function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function barLabel(label: string, segments: readonly RailSegment[]): string {
  return `${label}: ${segments.map((s) => `${s.label} ${s.text}`).join(', ')}`
}

interface StatCell {
  key: 'total' | 'cost' | 'hit' | 'time' | 'speed'
  label: string
  value: string
  unit?: string
  extra?: string
  extraTitle?: string
  title?: string
}

export function RailStatsBody({ model, running = false }: { model: RailStatsModel | null; running?: boolean }): ReactElement {
  const t = useT()
  const liveSince = model?.liveSince ?? null
  const live = liveSince !== null
  const now = useLiveClock(live)
  const liveMs = liveSince !== null ? Math.max(0, now - liveSince) : 0
  const tokens = model?.tokens ?? null
  const time = model?.time ?? null
  const speed = model?.speed ?? null
  const fact = (key: RailFact['key']): RailFact | undefined => model?.facts.find((item) => item.key === key)
  const total = fact('total')
  const hit = fact('hit')
  const cost = fact('cost')
  const subagents = fact('subagents')
  const timed = running || live || time !== null || speed !== null
  const lead: StatCell = cost
    ? { key: 'cost', label: cost.label, value: cost.value, extra: subagents?.value, extraTitle: subagents?.title ?? undefined, title: cost.title ?? undefined }
    : {
        key: 'total',
        label: total?.label ?? t('sm.total'),
        value: total?.value ?? '—',
        unit: total?.unit,
        extra: subagents?.value,
        extraTitle: subagents?.title ?? undefined,
        title: [total?.title, subagents?.title].filter(Boolean).join('\n') || undefined
      }
  const tokenTitle = tokens ? [tokens.title, ...tokens.segments.map((seg) => seg.title), subagents?.title].filter(Boolean).join('\n') : undefined
  const allCells: StatCell[] = [
    lead,
    { key: 'hit', label: hit?.label ?? t('sm.hitRate'), value: hit?.value ?? '—', title: hit?.title ?? undefined },
    {
      key: 'time',
      label: time?.label ?? t('sm.elapsed'),
      value: time ? railTimeText(time, liveMs) : live || running ? railTimeText({ baseMs: 0 }, liveMs) : '—',
      title: time?.title ?? undefined
    },
    { key: 'speed', label: speed?.label ?? t('sm.tps'), value: speed?.value ?? '—', unit: speed ? speed.unit : undefined, title: speed?.title ?? undefined }
  ]
  const cells = timed ? allCells : allCells.filter((cell) => cell.key === 'total' || cell.key === 'cost' || cell.key === 'hit')
  const breakdown: ReactElement[] = []
  if (tokens && tokens.segments.length) {
    const fresh = tokens.segments.filter((seg) => seg.key !== 'cacheRead')
    const barSegments = fresh.some((seg) => seg.value > 0) ? fresh : tokens.segments
    breakdown.push(
      <section key="tokens" className="wb-rs-block" data-block="tokens" title={tokenTitle}>
        <span className="wb-rs-label wb-rs-num">{`${t('sm.total')} ${tokens.total} ${tokens.unit}`}</span>
        <SegmentBar aria-label={barLabel(tokens.ariaLabel, tokens.segments)} segments={barSegments} />
        <ul className="wb-rs-legend">
          {tokens.segments.map((seg) => (
            <li key={seg.key} title={seg.title} data-seg={seg.key}>
              {barSegments.includes(seg) ? <Swatch tone={seg.tone} /> : <span aria-hidden="true" />}
              <span className="wb-rs-name">{seg.label}</span>
              <span className="wb-rs-num wb-rs-val">{seg.text}</span>
            </li>
          ))}
        </ul>
      </section>
    )
  }
  if (time) {
    breakdown.push(
      <section key="time" className="wb-rs-block" data-block="time" title={time.title ?? undefined}>
        <span className="wb-rs-label">{time.label}</span>
        <SegmentBar aria-label={barLabel(time.ariaLabel, time.segments)} segments={time.segments} />
        <p className="wb-rs-note wb-rs-num">{time.detail}</p>
      </section>
    )
  }
  if (speed) {
    breakdown.push(
      <section key="speed" className="wb-rs-block" data-block="speed" title={speed.title ?? undefined}>
        <span className="wb-rs-label">{speed.label}</span>
        <MiniBars values={speed.bars} pending={speed.live} slots={SPEED_BARS} stretch />
        {speed.caption ? <p className="wb-rs-note wb-rs-num">{speed.caption}</p> : null}
      </section>
    )
  }
  return (
    <div className="wb-rail-stats" data-testid="wb-rail-stats" data-live={live ? '1' : undefined}>
      <ul className="wb-rs-grid">
        {cells.map((cell) => (
          <li key={cell.key} className="wb-rs-cell" data-row={cell.key} data-empty={cell.value === '—' ? '1' : undefined} title={cell.title} data-testid={`wb-rail-stats-${cell.key}`}>
            <span className="wb-rs-label">{cell.label}</span>
            <span className="wb-rs-num wb-rs-strong">
              {cell.value}
              {cell.unit ? <> <span className="wb-rs-unit">{cell.unit}</span></> : null}
            </span>
            {cell.extra ? <span className="wb-rs-num wb-rs-extra" title={cell.extraTitle} data-testid="wb-rail-stats-subagents">{t('sm.subagentsExtra', { n: cell.extra })}</span> : null}
          </li>
        ))}
      </ul>
      {breakdown.length ? (
        <div className="wb-rs-breakdown" data-testid="wb-rail-stats-breakdown">
          {breakdown}
        </div>
      ) : null}
    </div>
  )
}
