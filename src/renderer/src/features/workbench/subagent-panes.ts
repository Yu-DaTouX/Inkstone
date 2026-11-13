import { type SubagentPaneId } from './types'

const PREFIX = 'subagent:'
const RUN_ID = /^[\w.-]{1,96}$/

export function subagentPaneId(runId: string): SubagentPaneId {
  return `${PREFIX}${runId}`
}

export function subagentRunOfPane(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(PREFIX)) return null
  const runId = id.slice(PREFIX.length)
  return RUN_ID.test(runId) ? runId : null
}

export function removedRunIds(previous: readonly { id: string }[], next: readonly { id: string }[]): string[] {
  const kept = new Set(next.map((run) => run.id))
  return previous.filter((run) => !kept.has(run.id)).map((run) => run.id)
}
