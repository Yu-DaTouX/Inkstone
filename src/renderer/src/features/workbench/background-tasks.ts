import type { SubagentTaskRow } from '../../../../shared/subagent-task-rows'
import type { SubagentRun } from '../../../../shared/ipc'

export const TASK_OUTPUT_TAIL = 8000
export const FOLLOW_EDGE_PX = 16

export interface BackgroundTaskEntry {
  id: string
  live: boolean
  startedAt: number
  endedAt: number | null
}

export interface BackgroundTaskSections<T extends BackgroundTaskEntry> {
  running: T[]
  finished: T[]
}

export interface OutputTail {
  text: string
  clipped: boolean
}

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function tailOutput(text: string, max = TASK_OUTPUT_TAIL): OutputTail {
  if (text.length <= max) return { text, clipped: false }
  const cut = text.slice(text.length - max)
  const newline = cut.indexOf('\n')
  return { text: newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut, clipped: true }
}

export function isNearBottom(metrics: ScrollMetrics, edge = FOLLOW_EDGE_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= edge
}

export function sectionTasks<T extends BackgroundTaskEntry>(entries: readonly T[]): BackgroundTaskSections<T> {
  const running = entries.filter((entry) => entry.live).sort((a, b) => a.startedAt - b.startedAt)
  const finished = entries
    .filter((entry) => !entry.live)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return { running, finished }
}

export function isLiveTaskRow(row: Pick<SubagentTaskRow, 'state'>): boolean {
  return row.state === 'starting' || row.state === 'running' || row.state === 'stopping' || row.state === 'unknown'
}

export function subagentOutputText(run: Pick<SubagentRun, 'transcript' | 'result' | 'latestActivity'>): string {
  for (let index = run.transcript.length - 1; index >= 0; index -= 1) {
    const message = run.transcript[index]
    if (message.role === 'assistant' && message.text?.trim()) return message.text
  }
  return run.result?.summary?.trim() || run.latestActivity?.trim() || ''
}
