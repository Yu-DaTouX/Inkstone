import { WORKBENCH_TABS, type SubagentPaneId, type WorkbenchTabId, type WorkspacePaneId } from './types'

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

export function isSubagentPaneId(value: unknown): value is SubagentPaneId {
  return typeof value === 'string' && subagentRunOfPane(value) !== null
}

export function isToolPane(id: string): id is WorkbenchTabId {
  return (WORKBENCH_TABS as readonly string[]).includes(id)
}

export function isWorkspacePaneId(value: unknown): value is WorkspacePaneId {
  return typeof value === 'string' && (isToolPane(value) || isSubagentPaneId(value))
}

export function toolPanes(panes: readonly WorkspacePaneId[]): WorkbenchTabId[] {
  return panes.filter(isToolPane)
}

export function staleSubagentPanes(panes: readonly WorkspacePaneId[], knownRunIds: ReadonlySet<string>): SubagentPaneId[] {
  return panes.filter((id): id is SubagentPaneId => {
    const runId = subagentRunOfPane(id)
    return runId !== null && !knownRunIds.has(runId)
  })
}

export function removedRunIds(previous: readonly { id: string }[], next: readonly { id: string }[]): string[] {
  const kept = new Set(next.map((run) => run.id))
  return previous.filter((run) => !kept.has(run.id)).map((run) => run.id)
}
