import type { RunSnapshot } from '../../shared/runs'

export interface AttentionSummary {
  needsYou: RunSnapshot[]
  failed: RunSnapshot[]
  doneUnread: RunSnapshot[]
  stalled: RunSnapshot[]
  active: RunSnapshot[]
  waiting: boolean
  busy: boolean
  attentionCount: number
  total: number
}

function phaseTime(run: RunSnapshot): number {
  const phase = run.phase
  if (phase.kind === 'failed' || phase.kind === 'done' || phase.kind === 'stopped') return phase.at
  return phase.since
}

const byTimeAsc = (a: RunSnapshot, b: RunSnapshot): number =>
  phaseTime(a) - phaseTime(b) || a.code.localeCompare(b.code)

const byTimeDesc = (a: RunSnapshot, b: RunSnapshot): number =>
  phaseTime(b) - phaseTime(a) || a.code.localeCompare(b.code)

export function summarizeAttention(runs: readonly RunSnapshot[]): AttentionSummary {
  const needsYou: RunSnapshot[] = []
  const failed: RunSnapshot[] = []
  const doneUnread: RunSnapshot[] = []
  const stalled: RunSnapshot[] = []
  const active: RunSnapshot[] = []

  for (const run of runs) {
    const phase = run.phase
    switch (phase.kind) {
      case 'needs-you':
        needsYou.push(run)
        active.push(run)
        break
      case 'stalled':
        stalled.push(run)
        active.push(run)
        break
      case 'queued':
      case 'running':
        active.push(run)
        break
      case 'failed':
        if (!phase.seen) failed.push(run)
        break
      case 'done':
        if (!phase.seen) doneUnread.push(run)
        break
      case 'stopped':
        break
    }
  }

  needsYou.sort(byTimeAsc)
  stalled.sort(byTimeAsc)
  active.sort(byTimeAsc)
  failed.sort(byTimeDesc)
  doneUnread.sort(byTimeDesc)

  return {
    needsYou,
    failed,
    doneUnread,
    stalled,
    active,
    waiting: needsYou.length > 0,
    busy: active.length > 0,
    attentionCount: needsYou.length + failed.length + doneUnread.length,
    total: runs.length
  }
}
