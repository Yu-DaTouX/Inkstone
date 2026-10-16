import type { RunPhase, RunSnapshot } from '../../shared/runs'
import type { AttentionSummary } from '../attention/summary'
import type { MiniItem, MiniStatusKey } from './aux-types'

function phaseTime(phase: RunPhase): number {
  if (phase.kind === 'failed' || phase.kind === 'done' || phase.kind === 'stopped') return phase.at
  return phase.since
}

function toItem(statusKey: MiniStatusKey, run: RunSnapshot): MiniItem {
  const phase = run.phase
  const unread = (phase.kind === 'failed' || phase.kind === 'done') && !phase.seen
  return {
    runId: run.runId,
    code: run.code,
    title: run.title,
    statusKey,
    since: phaseTime(phase),
    unread,
    sessionId: run.sessionId,
    ...(run.sessionPath ? { sessionPath: run.sessionPath } : {}),
    ...(run.projectId ? { projectId: run.projectId } : {})
  }
}

const bySinceAsc = (a: MiniItem, b: MiniItem): number => a.since - b.since || a.runId.localeCompare(b.runId)
const bySinceDesc = (a: MiniItem, b: MiniItem): number => b.since - a.since || a.runId.localeCompare(b.runId)

export function attentionItems(summary: AttentionSummary): MiniItem[] {
  const queued: MiniItem[] = []
  const running: MiniItem[] = []
  for (const run of summary.active) {
    if (run.phase.kind === 'queued') queued.push(toItem('queued', run))
    else if (run.phase.kind === 'running') running.push(toItem('running', run))
  }
  return [
    ...summary.needsYou.map((run) => toItem('needs-you', run)).sort(bySinceAsc),
    ...summary.stalled.map((run) => toItem('stalled', run)).sort(bySinceAsc),
    ...summary.failed.map((run) => toItem('failed', run)).sort(bySinceDesc),
    ...running.sort(bySinceAsc),
    ...queued.sort(bySinceAsc),
    ...summary.doneUnread.map((run) => toItem('done', run)).sort(bySinceDesc)
  ]
}
