/**
 * 运行时间线的纯布局计算（WP-54）。
 *
 * 输入是 `window.yan.runs.history` 读到的一天历史记录，输出是可直接渲染的泳道：
 * 横轴固定为当天的 00:00–24:00，每个运行一条泳道，泳道上的色段按真实状态时间段
 * 定位。这里不做任何 IO / React / DOM 访问，方便单测直接覆盖 200 条合成数据。
 *
 * 两个边界：
 *   · 运行可能横跨零点（昨天开始、今天结束）；只把落在当天窗口内的部分画出来。
 *   · 历史记录缺 `segments` 时退化成一条终态色段，不画空泳道。
 */
import type { RunsHistoryRecord } from '../../../../shared/ipc'
import type { RunCounts, RunKind, RunModel } from '../../../../shared/runs'

/** 时间线横轴上的刻度小时；标签由 `tickLabel` 生成。 */
export const DAY_TICKS: readonly number[] = [0, 6, 12, 18, 24]

/** 一条泳道里的状态色段，位置是相对当天的 0–1 比例。 */
export interface DayTimelineSegment {
  phase: string
  /** 色段的真实起止（已夹到当天窗口内） */
  from: number
  to: number
  /** 距当天起点的比例 [0,1] */
  left: number
  /** 占当天的比例 (0,1] */
  width: number
  durationMs: number
}

/** 一个运行在时间线上的一条泳道。 */
export interface DayTimelineLane {
  runId: string
  code: string
  kind: RunKind
  title: string
  terminal: RunsHistoryRecord['terminal']
  sessionId: string
  sessionPath?: string
  /** 子 Agent 的父运行 id；用来在历史里反查父会话路径。 */
  parentRunId?: string
  model?: RunModel
  startedAt: number
  endedAt: number
  /** 整段运行时长（未夹到当天；跨天运行仍显示真实总时长） */
  durationMs: number
  costUsd?: number
  counts: RunCounts
  /** 落在当天窗口内的色段；至少一条 */
  segments: DayTimelineSegment[]
}

export interface DayTimelineLayout {
  day: string
  /** 当天 00:00 的本地时间戳 */
  from: number
  /** 次日 00:00 的本地时间戳 */
  to: number
  totalMs: number
  lanes: DayTimelineLane[]
}

/** 虚拟化窗口：要渲染的泳道区间与上下占位高度（像素）。 */
export interface LaneWindow {
  start: number
  end: number
  padTop: number
  padBottom: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 一天的本地时间窗口。用「次日 00:00」而不是 +24h，夏令时切换当天才是正确的长度。
 * 非法日期回退到当天起点 +24h，不产生 NaN。
 */
export function dayWindow(day: string): { from: number; to: number } {
  const [year, month, date] = day.split('-').map((part) => Number(part))
  const from = new Date(year || 1970, (month || 1) - 1, date || 1, 0, 0, 0, 0).getTime()
  if (!Number.isFinite(from)) {
    const fallback = new Date().setHours(0, 0, 0, 0)
    return { from: fallback, to: fallback + 86_400_000 }
  }
  const to = new Date(year, (month || 1) - 1, (date || 1) + 1, 0, 0, 0, 0).getTime()
  return { from, to }
}

/** 把某个小时（0–24）格式化成 `HH:00` 刻度标签。 */
export function tickLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/**
 * 一天的时间线布局：泳道按开始时间升序，色段夹到当天窗口。
 * O(n·段数)，200 条记录、每条几条段即可瞬时完成（单测覆盖耗时上限）。
 */
export function layoutDayTimeline(
  records: readonly RunsHistoryRecord[],
  day: string
): DayTimelineLayout {
  const { from, to } = dayWindow(day)
  const totalMs = Math.max(1, to - from)
  const lanes: DayTimelineLane[] = []

  for (const record of records) {
    const source = record.segments.length
      ? record.segments
      : [{ phase: record.terminal, from: record.startedAt, to: record.endedAt }]
    const segments: DayTimelineSegment[] = []
    for (const segment of source) {
      const segFrom = clamp(segment.from, from, to)
      const segTo = clamp(segment.to, from, to)
      if (segTo <= segFrom) continue
      segments.push({
        phase: segment.phase,
        from: segFrom,
        to: segTo,
        left: (segFrom - from) / totalMs,
        width: (segTo - segFrom) / totalMs,
        durationMs: segTo - segFrom
      })
    }
    /* 记录起止都在当天之外（数据异常）时补一条 1ms 的可见段，不画空泳道。 */
    if (segments.length === 0) {
      const segFrom = clamp(record.startedAt, from, Math.max(from, to - 1))
      segments.push({
        phase: record.terminal,
        from: segFrom,
        to: Math.min(to, segFrom + 1),
        left: (segFrom - from) / totalMs,
        width: 1 / totalMs,
        durationMs: 1
      })
    }
    lanes.push({
      runId: record.runId,
      code: record.code,
      kind: record.kind,
      title: record.title,
      terminal: record.terminal,
      sessionId: record.sessionId,
      ...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
      ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
      ...(record.model ? { model: record.model } : {}),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: Math.max(0, record.endedAt - record.startedAt),
      ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
      counts: record.counts,
      segments
    })
  }

  lanes.sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
  return { day, from, to, totalMs, lanes }
}

/**
 * 只渲染视口内的泳道：返回区间与上下占位高度。
 * 调用方把占位高度渲染成空 div，滚动条因此仍反映全部泳道的总高度。
 */
export function visibleLaneRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 4
): LaneWindow {
  if (rowHeight <= 0 || total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const safeTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0)
  const start = clamp(Math.floor(safeTop / rowHeight) - overscan, 0, total)
  const count = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2 + 1
  const end = Math.min(total, start + count)
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight)
  }
}
