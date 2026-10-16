/**
 * 运行时间线（WP-54）。
 *
 * 横轴是当天的 00:00–24:00，每个运行一条泳道；色段按历史记录里的真实状态时间段
 * 定位，颜色只来自 design/tokens 的状态令牌。一天可能有 200 个运行，所以泳道按
 * 视口做虚拟化：只渲染可见区间，上下用占位高度撑起滚动条。
 *
 * 布局计算在 `runs-timeline-model.ts`（纯函数，单测覆盖 200 条合成数据）。
 * 数据来自 `window.yan.runs.history`，本组件不做任何读取。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { RunsHistoryRecord } from '../../../../shared/ipc'
import { formatDuration, type RunLang } from '../../state/runs-v3'
import { DAY_TICKS, layoutDayTimeline, tickLabel, visibleLaneRange, type DayTimelineLane } from './runs-timeline-model'

/** 每条泳道的固定高度；虚拟化与 CSS 共用同一个值。 */
const ROW_PX = 24
/** 滚动视口的最大高度；泳道少时按行数收缩，超过它才出现滚动。 */
const VIEWPORT_PX = 320
/** 视口的最小高度：只有一两条泳道时也不会缩成一条细线。 */
const VIEWPORT_MIN_PX = 48
/** 视口外多渲染几条，滚动时不至于闪白。 */
const OVERSCAN = 4

export interface RunsTimelineProps {
  /** 已经过筛选的当天历史记录。 */
  records: readonly RunsHistoryRecord[]
  /** 当天日期（本地 `YYYY-MM-DD`），决定横轴窗口。 */
  day: string
  lang: RunLang
  /** 点一条泳道：回到它的会话或子代理。 */
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

  /* 切到另一天时回到顶部，避免停在昨天的滚动位置。 */
  useEffect(() => {
    setScrollTop(0)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [day])

  /* 视口高度按泳道数自适应（夹在最小与最大值之间），虚拟化区间用同一个高度计算 */
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
