import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, CollapsibleChevron, MiniBars, SegmentBar, Swatch } from '../../ui'
import { useT } from '../../i18n'
import { useStore, type Store } from '../../state/store'
import { useStreamingThrottledStore } from '../../state/streaming-throttle'
import { subagentCost, subagentTokens, viewSubagentRuns } from '../../state/subagent-view'
import { useMoney } from '../usage/UsageOverview'
import {
  latencyFloor,
  liveActivitySince,
  liveStepId,
  liveStepSpeed,
  projectSessionMetrics,
  splitLiveStep,
  stepSpeeds,
  stepSpeed
} from '../../../../shared/session-metrics'
import type { UIMessage } from '../../../../shared/ipc'
import { buildRailStats, railTimeText, retainRailSpeed, type RailSpeedHold, type RailSegment, type RailStatsModel } from './rail-stats'
import { railOperationCounts } from './rail-data'
import { sessionViewIdentity } from '../session/view-state'
import './rail-stats.css'

const SPEED_BARS = 12

let breakdownRemembered = false

function useBreakdownOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(breakdownRemembered)
  return [open, (next) => {
    breakdownRemembered = next
    setOpen(next)
  }]
}

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
  const history = useMemo(() => {
    if (!enabled) return null
    const { messages, liveId, running } = snapshot
    const { settled, live } = splitLiveStep(messages, liveId)
    const floor = latencyFloor(settled)
    const latestSpeed = settled.reduceRight<number | null>((found, message) => found ?? stepSpeed(message, floor), null)
    const reading = (live ? liveStepSpeed(live, floor) : null) ?? (latestSpeed === null ? null : { speed: latestSpeed, estimated: false })
    const identity = JSON.stringify([view, messages.findLast((message) => message.role === 'user')?.id])
    speedHold.current = retainRailSpeed(speedHold.current, identity, reading)
    const heldReading = speedHold.current.sample
    return {
      metrics: projectSessionMetrics(settled, stats, { historyPartial }),
      counts: railOperationCounts(messages),
      speeds: stepSpeeds(settled, live ? SPEED_BARS - 1 : SPEED_BARS),
      heldReading,
      running,
      liveSince: liveActivitySince(messages, live, running)
    }
  }, [enabled, snapshot, stats, historyPartial, view])
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

export function RailStatsBody({ model, breakdownLabel }: { model: RailStatsModel; breakdownLabel: string }): ReactElement {
  const live = model.liveSince !== null
  const now = useLiveClock(live)
  const liveMs = model.liveSince !== null ? Math.max(0, now - model.liveSince) : 0
  const [breakdownOpen, setBreakdownOpen] = useBreakdownOpen()
  const { tokens, time, speed } = model
  const breakdown: ReactElement[] = []
  if (tokens && tokens.segments.length) {
    const fresh = tokens.segments.filter((seg) => seg.key !== 'cacheRead')
    const barSegments = fresh.some((seg) => seg.value > 0) ? fresh : tokens.segments
    breakdown.push(
      <section key="tokens" className="wb-rs-block" data-block="tokens">
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
    <div className="wb-rail-stats" data-testid="wb-rail-stats" data-live={live ? '1' : undefined} data-breakdown={breakdownOpen ? '1' : undefined}>
      {model.facts.length || time || speed ? (
        <ul className="wb-rs-rows">
          {model.facts.map((fact) => (
            <li key={fact.key} className="wb-rs-line" data-row={fact.key} title={fact.title ?? undefined} data-testid={`wb-rail-stats-${fact.key}`}>
              <span className="wb-rs-label">{fact.label}</span>
              <span className="wb-rs-num wb-rs-strong">
                {fact.value}
                {fact.unit ? <> <span className="wb-rs-unit">{fact.unit}</span></> : null}
              </span>
            </li>
          ))}
          {time ? (
            <li className="wb-rs-line" data-row="time" title={time.title ?? undefined}>
              <span className="wb-rs-label">{time.label}</span>
              <span className="wb-rs-num wb-rs-strong" data-testid="wb-rail-stats-time">
                {railTimeText(time, liveMs)}
              </span>
            </li>
          ) : null}
          {speed ? (
            <li className="wb-rs-line" data-row="speed" title={speed.title ?? undefined}>
              <span className="wb-rs-label">{speed.label}</span>
              <span className="wb-rs-num wb-rs-strong">
                {speed.value} <span className="wb-rs-unit">{speed.unit}</span>
              </span>
            </li>
          ) : null}
        </ul>
      ) : null}
      {breakdown.length ? (
        <Button
          variant="plain"
          size="sm"
          className="wb-rs-toggle"
          aria-expanded={breakdownOpen}
          onPress={() => setBreakdownOpen(!breakdownOpen)}
          data-testid="wb-rail-stats-breakdown-toggle"
        >
          <span>{breakdownLabel}</span>
          <CollapsibleChevron expanded={breakdownOpen} />
        </Button>
      ) : null}
      {breakdownOpen && breakdown.length ? (
        <div className="wb-rs-breakdown" data-testid="wb-rail-stats-breakdown">
          {breakdown}
        </div>
      ) : null}
    </div>
  )
}
