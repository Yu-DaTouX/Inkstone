import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { MiniBars, SegmentBar, Swatch } from '../../ui'
import { useT } from '../../i18n'
import { useStore, type Store } from '../../state/store'
import { useStreamingThrottledStore } from '../../state/streaming-throttle'
import { viewSubagentMetrics } from '../../state/subagent-view'
import { useMoney } from '../usage/UsageOverview'
import {
  latencyFloor,
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

const NO_MESSAGES: UIMessage[] = []

function viewKey(s: Store): string {
  return sessionViewIdentity({ session: s.session, peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath }).key
}

function antigravityMessages(messages: readonly UIMessage[]): UIMessage[] {
  const result: UIMessage[] = []
  let user: UIMessage | undefined
  for (const message of messages) {
    if (message.role === 'user') user = message
    else if (message.role === 'assistant' && message.model?.startsWith('antigravity/')) {
      if (user) result.push(user)
      result.push(message)
      user = undefined
    }
  }
  return result
}

export function useRailStats(enabled: boolean, timeline?: UIMessage[]): RailStatsModel | null {
  const t = useT()
  const money = useMoney()
  const stats = useStore((s) => enabled ? s.stats : null)
  const antigravity = useStore((s) => enabled && !s.peekedSessionId && s.session?.model?.provider === 'antigravity')
  const streaming = useStore((s) => enabled && !s.peekedSessionId && !!s.session?.isStreaming)
  const running = useStore((s) => enabled && !s.peekedSessionId && !!(s.session?.isAgentRunning || s.session?.isStreaming))
  const startedAt = useStore((s) => enabled && !s.peekedSessionId && s.session?.isAgentRunning ? s.session.runStartedAt ?? null : null)
  const historyPartial = useStore((s) => enabled && (s.peekNote?.truncated ?? 0) > 0)
  const view = useStore((s) => enabled ? viewKey(s) : '')
  const childTokens = useStore((s) => (enabled && !antigravity ? viewSubagentMetrics(s).tokens : 0))
  const childCost = useStore((s) => (enabled && !antigravity ? viewSubagentMetrics(s).cost : 0))
  const speedHold = useRef<RailSpeedHold | null>(null)
  const fallback = useStreamingThrottledStore((s) => enabled && !timeline ? s.messages : NO_MESSAGES)
  const source = enabled ? timeline ?? fallback : NO_MESSAGES
  const messages = useMemo(() => antigravity ? antigravityMessages(source) : source, [antigravity, source])
  const countSource = useToolStructureMessages(messages)
  const counts = useMemo(() => (enabled ? railOperationCounts(countSource) : null), [enabled, countSource])
  const history = useMemo(() => {
    if (!enabled) return null
    const liveId = liveStepId(source, streaming)
    const { settled, live } = splitLiveStep(messages, liveId)
    const floor = latencyFloor(settled)
    const last = settled.findLast((message) => message.role === 'assistant')
    const reading = antigravity ? (live ? windowSpeed(settled, live, floor) : last ? windowSpeed([last], null, floor) : null) : windowSpeed(settled, live, floor)
    const identity = JSON.stringify([view, antigravity, messages.findLast((message) => message.role === 'user')?.id])
    speedHold.current = retainRailSpeed(speedHold.current, identity, reading)
    const heldReading = speedHold.current.sample
    return {
      metrics: projectSessionMetrics(settled, stats, { historyPartial, activeRunStartedAt: startedAt, antigravity }),
      counts: antigravity ? { turns: messages.filter((m) => m.role === 'user').length, steps: messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0) } : counts ?? railOperationCounts(messages),
      speeds: stepSpeeds(settled, live ? SPEED_BARS - 1 : SPEED_BARS),
      heldReading,
      running,
      liveSince: startedAt !== null && settled.some((m) => m.turnTiming?.startedAt === startedAt) ? null : startedAt
    }
  }, [enabled, source, streaming, running, startedAt, messages, stats, historyPartial, view, counts, antigravity])
  return useMemo(() => {
    if (!history) return null
    const { metrics, counts, speeds, heldReading, running, liveSince } = history
    return buildRailStats({
      metrics,
      counts,
      historyPartial,
      subagentTokens: antigravity ? 0 : childTokens,
      subagentCost: antigravity ? 0 : childCost,
      speeds,
      latestSpeed: heldReading?.speed ?? null,
      latestSpeedEstimated: heldReading?.estimated ?? false,
      liveSpeed: running ? (heldReading?.speed ?? null) : undefined,
      liveSpeedEstimated: heldReading?.estimated ?? false,
      liveSince,
      money,
      t
    })
  }, [history, historyPartial, childTokens, childCost, money, t, antigravity])
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

function noteParts(text: string): ReactElement[] {
  return text.split(' · ').map((part, i) => (
    <span key={i} className="wb-rs-part">{part}</span>
  ))
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
      value: time?.baseMs != null || live ? railTimeText({ baseMs: time?.baseMs ?? 0 }, liveMs) : '—',
      title: time?.elapsedTitle ?? undefined
    },
    { key: 'speed', label: speed?.label ?? t('sm.tps'), value: speed?.value ?? '—', unit: speed ? speed.unit : undefined, title: speed?.title ?? undefined }
  ]
  const shown = timed ? allCells : allCells.filter((cell) => cell.key === 'total' || cell.key === 'cost' || cell.key === 'hit')
  const settled = running || live ? shown : shown.filter((cell) => cell.value !== '—')
  const cells = settled.length ? settled : shown
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
  if (time?.segments.length) {
    breakdown.push(
      <section key="time" className="wb-rs-block" data-block="time" title={time.title ?? undefined}>
        <span className="wb-rs-label">{time.ariaLabel}</span>
        <SegmentBar aria-label={barLabel(time.ariaLabel, time.segments)} segments={time.segments} />
        <ul className="wb-rs-legend">
          {time.segments.map((seg) => (
            <li key={seg.key} title={seg.title} data-seg={seg.key}>
              <Swatch tone={seg.tone} />
              <span className="wb-rs-name">{seg.label}</span>
              <span className="wb-rs-num wb-rs-val">{seg.text}</span>
            </li>
          ))}
          {time.ttft ? (
            <li key="ttft" data-seg="ttft">
              <span aria-hidden="true" />
              <span className="wb-rs-name">{time.ttft.label}</span>
              <span className="wb-rs-num wb-rs-val">{time.ttft.text}</span>
            </li>
          ) : null}
        </ul>
      </section>
    )
  }
  if (speed) {
    breakdown.push(
      <section key="speed" className="wb-rs-block" data-block="speed" title={speed.title ?? undefined}>
        <span className="wb-rs-label">{speed.label}</span>
        <MiniBars values={speed.bars} pending={speed.live} slots={SPEED_BARS} stretch />
        {speed.caption ? <p className="wb-rs-note wb-rs-num">{noteParts(speed.caption)}</p> : null}
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
