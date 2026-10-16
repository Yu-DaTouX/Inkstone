import type { RunsHistoryRecord } from '../../../../shared/ipc'
import type { RunCounts, RunKind, RunModel } from '../../../../shared/runs'

export const DAY_TICKS: readonly number[] = [0, 6, 12, 18, 24]

export interface DayTimelineSegment {
  phase: string
  from: number
  to: number
  left: number
  width: number
  durationMs: number
}

export interface DayTimelineLane {
  runId: string
  code: string
  kind: RunKind
  title: string
  terminal: RunsHistoryRecord['terminal']
  sessionId: string
  sessionPath?: string
  parentRunId?: string
  model?: RunModel
  startedAt: number
  endedAt: number
  durationMs: number
  costUsd?: number
  counts: RunCounts
  segments: DayTimelineSegment[]
}

export interface DayTimelineLayout {
  day: string
  from: number
  to: number
  totalMs: number
  lanes: DayTimelineLane[]
}

export interface LaneWindow {
  start: number
  end: number
  padTop: number
  padBottom: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

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

export function tickLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

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
