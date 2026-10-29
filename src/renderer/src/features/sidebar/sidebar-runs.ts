import type { RunSnapshot } from '../../../../shared/runs'

function seen(run: RunSnapshot): boolean | undefined {
  return run.phase.kind === 'done' || run.phase.kind === 'failed' ? run.phase.seen : undefined
}

function sameRowRun(a: RunSnapshot, b: RunSnapshot): boolean {
  return a.runId === b.runId && a.sessionId === b.sessionId && a.sessionPath === b.sessionPath &&
    a.startedAt === b.startedAt && a.phase.kind === b.phase.kind && seen(a) === seen(b) &&
    a.code === b.code && a.model?.provider === b.model?.provider && a.model?.id === b.model?.id && a.model?.label === b.model?.label
}

export function createSidebarRunsSelector(): (state: { runs: RunSnapshot[] }) => RunSnapshot[] {
  let previous: RunSnapshot[] = []
  return ({ runs }) => {
    const byId = new Map(previous.map((run) => [run.runId, run]))
    const next = runs.map((run) => {
      const old = byId.get(run.runId)
      return old && sameRowRun(old, run) ? old : run
    })
    if (next.length === previous.length && next.every((run, index) => run === previous[index])) return previous
    previous = next
    return next
  }
}
