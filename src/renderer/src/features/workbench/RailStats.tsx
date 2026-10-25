import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { MiniBars, SegmentBar, Separator, Swatch } from '../../ui'
import { useT } from '../../i18n'
import { useStore, type Store } from '../../state/store'
import { useStreamingThrottledStore } from '../../state/streaming-throttle'
import { selectSubagentRuns, subagentCost, subagentScopeForView, subagentTokens } from '../../state/subagent-view'
import { useMoney } from '../usage/UsageOverview'
import {
  liveActivitySince,
  liveStepId,
  liveStepSpeed,
  projectSessionMetrics,
  sessionTurnCounts,
  splitLiveStep,
  stepSpeeds,
  stepSpeed
} from '../../../../shared/session-metrics'
import type { UIMessage } from '../../../../shared/ipc'
import { buildRailStats, railTimeText, type RailSegment, type RailStatsModel } from './rail-stats'
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

export function useRailStats(enabled: boolean): RailStatsModel | null {
  const t = useT()
  const money = useMoney()
  const snapshot = useStreamingThrottledStore(railSnapshot, undefined, sameSnapshot)
  const stats = useStore((s) => s.stats)
  const peekNote = useStore((s) => s.peekNote)
  const subagents = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const runners = useStore((s) => s.runners)
  const historyPartial = (peekNote?.truncated ?? 0) > 0
  return useMemo(() => {
    if (!enabled) return null
    const { messages, liveId, running } = snapshot
    const { settled, live } = splitLiveStep(messages, liveId)
    const liveReading = liveStepSpeed(live)
    const metrics = projectSessionMetrics(settled, stats, { historyPartial })
    const runs = selectSubagentRuns(subagents, subagentScopeForView({ session, peekedSessionId, peekedPath, runners })).all
    return buildRailStats({
      metrics,
      counts: sessionTurnCounts(messages),
      historyPartial,
      subagentTokens: subagentTokens(runs),
      subagentCost: subagentCost(runs),
      speeds: stepSpeeds(settled, live ? SPEED_BARS - 1 : SPEED_BARS),
      latestSpeed: stepSpeed(settled.findLast((message) => message.role === 'assistant')),
      liveSpeed: live ? (liveReading?.speed ?? null) : undefined,
      liveSpeedEstimated: liveReading?.estimated ?? false,
      liveSince: liveActivitySince(messages, live, running),
      money,
      t
    })
  }, [enabled, snapshot, stats, historyPartial, subagents, session, peekedSessionId, peekedPath, runners, money, t])
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

export function RailStatsBody({ model }: { model: RailStatsModel }): ReactElement {
  const live = model.liveSince !== null
  const now = useLiveClock(live)
  const liveMs = model.liveSince !== null ? Math.max(0, now - model.liveSince) : 0
  const { tokens, time, speed } = model
  const extras = model.extras ? (
    <p className="wb-rs-note" title={model.extrasTitle ?? undefined} data-testid="wb-rail-stats-extras">
      {model.extras}
    </p>
  ) : null
  const blocks: ReactElement[] = []
  if (tokens || extras) {
    blocks.push(
      <section key="tokens" className="wb-rs-block" data-block="tokens">
        {tokens ? (
          <>
            <div className="wb-rs-line">
              <span className="wb-rs-total" title={tokens.title}>
                <span className="wb-rs-big">{tokens.total}</span>
                <span className="wb-rs-unit">{tokens.unit}</span>
              </span>
              {tokens.hit ? (
                <span className="wb-rs-note wb-rs-num" title={tokens.hitTitle ?? undefined}>
                  {tokens.hit}
                </span>
              ) : null}
            </div>
            <SegmentBar aria-label={barLabel(tokens.ariaLabel, tokens.segments)} segments={tokens.segments} />
            <ul className="wb-rs-legend">
              {tokens.segments.map((seg) => (
                <li key={seg.key} title={seg.title} data-seg={seg.key}>
                  <Swatch tone={seg.tone} />
                  <span className="wb-rs-name">{seg.label}</span>
                  <span className="wb-rs-num wb-rs-val">{seg.text}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {extras}
      </section>
    )
  }
  if (time) {
    blocks.push(
      <section key="time" className="wb-rs-block" data-block="time" title={time.title ?? undefined}>
        <div className="wb-rs-line">
          <span className="wb-rs-label">{time.label}</span>
          <span className="wb-rs-num wb-rs-strong" data-testid="wb-rail-stats-time">
            {railTimeText(time, liveMs)}
          </span>
        </div>
        <SegmentBar aria-label={barLabel(time.ariaLabel, time.segments)} segments={time.segments} />
        <p className="wb-rs-note wb-rs-num">{time.detail}</p>
      </section>
    )
  }
  if (speed) {
    blocks.push(
      <section key="speed" className="wb-rs-block" data-block="speed" title={speed.title ?? undefined}>
        <div className="wb-rs-line">
          <span className="wb-rs-label">{speed.label}</span>
          <span className="wb-rs-num wb-rs-strong">
            {speed.value} <span className="wb-rs-unit">{speed.unit}</span>
          </span>
        </div>
        <MiniBars values={speed.bars} pending={speed.live} slots={SPEED_BARS} stretch />
        {speed.caption ? <p className="wb-rs-note wb-rs-num">{speed.caption}</p> : null}
      </section>
    )
  }
  return (
    <div className="wb-rail-stats" data-testid="wb-rail-stats" data-live={live ? '1' : undefined}>
      {blocks.flatMap((block, i) => (i === 0 ? [block] : [<Separator key={`sep-${block.key}`} />, block]))}
    </div>
  )
}
