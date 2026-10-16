import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { RunsHistoryRecord } from '../../../../shared/ipc'
import { formatDuration, type RunLang } from '../../state/runs-v3'
import { DAY_TICKS, layoutDayTimeline, tickLabel, visibleLaneRange, type DayTimelineLane } from './runs-timeline-model'

const ROW_PX = 24
const VIEWPORT_PX = 320
const VIEWPORT_MIN_PX = 48
const OVERSCAN = 4

export interface RunsTimelineProps {
  records: readonly RunsHistoryRecord[]
  day: string
  lang: RunLang
  onOpenRun?: (lane: DayTimelineLane) => void
}

function Lane({
  lane,
  lang,
  onOpenRun
}: {
  lane: DayTimelineLane
  lang: RunLang
  onOpenRun?: (lane: DayTimelineLane) => void
}): ReactElement {
  const title = lane.title || '—'
  return (
    <button
      type="button"
      className="runs-tl-lane"
      style={{ height: ROW_PX }}
      data-terminal={lane.terminal}
      data-kind={lane.kind}
      onClick={onOpenRun ? () => onOpenRun(lane) : undefined}
      disabled={!onOpenRun}
      title={`${lane.code} · ${title} · ${formatDuration(lane.durationMs, lang)}`}
    >
      <span className="runs-tl-label">
        <span className="runs-tl-code">{lane.code}</span>
        <span className="runs-tl-title">{title}</span>
      </span>
      <span className="runs-tl-track" aria-hidden="true">
        {lane.segments.map((segment, index) => (
          <span
            key={`${segment.phase}-${index}`}
            className="runs-tl-seg"
            data-phase={segment.phase}
            style={{ left: `${segment.left * 100}%`, width: `${segment.width * 100}%` }}
          />
        ))}
      </span>
    </button>
  )
}

export function RunsTimeline({ records, day, lang, onOpenRun }: RunsTimelineProps): ReactElement {
  const layout = useMemo(() => layoutDayTimeline(records, day), [records, day])
  const [scrollTop, setScrollTop] = useState(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setScrollTop(0)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [day])

  const viewportPx = Math.min(VIEWPORT_PX, Math.max(VIEWPORT_MIN_PX, layout.lanes.length * ROW_PX))
  const range = visibleLaneRange(scrollTop, viewportPx, ROW_PX, layout.lanes.length, OVERSCAN)
  const visible = layout.lanes.slice(range.start, range.end)

  return (
    <div className="runs-tl" role="group" aria-label={lang === 'en-US' ? 'Run timeline' : '运行时间线'}>
      <div className="runs-tl-axis" aria-hidden="true">
        <span className="runs-tl-axis-label" />
        <span className="runs-tl-axis-track">
          {DAY_TICKS.map((hour) => (
            <span
              key={hour}
              className="runs-tl-tick"
              data-edge={hour === 0 ? 'start' : hour === 24 ? 'end' : undefined}
              style={{ left: `${(hour / 24) * 100}%` }}
            >
              {tickLabel(hour)}
            </span>
          ))}
        </span>
      </div>
      <div
        className="runs-tl-body"
        ref={bodyRef}
        style={{ height: viewportPx }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {range.padTop > 0 ? <div className="runs-tl-pad" style={{ height: range.padTop }} aria-hidden /> : null}
        {visible.map((lane) => (
          <Lane key={lane.runId} lane={lane} lang={lang} onOpenRun={onOpenRun} />
        ))}
        {range.padBottom > 0 ? <div className="runs-tl-pad" style={{ height: range.padBottom }} aria-hidden /> : null}
      </div>
    </div>
  )
}
