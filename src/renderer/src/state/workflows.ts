import { create } from 'zustand'
import type { WorkflowRunView } from '../../../shared/workflows'

interface WorkflowsState {
  runs: Record<string, WorkflowRunView>
  loaded: boolean
  upsert(run: WorkflowRunView): void
  load(): Promise<void>
}

export const useWorkflows = create<WorkflowsState>((set, get) => ({
  runs: {},
  loaded: false,
  upsert: (run) => set({ runs: { ...get().runs, [run.id]: run } }),
  load: async () => {
    if (get().loaded || typeof window === 'undefined' || typeof window.yan?.workflows?.list !== 'function') return
    set({ loaded: true })
    const list = await window.yan.workflows.list().catch(() => null)
    if (!list) {
      set({ loaded: false })
      return
    }
    const runs = { ...get().runs }
    for (const run of list) if (!runs[run.id]) runs[run.id] = run
    set({ runs })
  }
}))

export function workflowsForTurn(
  runs: Record<string, WorkflowRunView>,
  turnIds: ReadonlySet<string>,
  sessionIds: readonly string[],
  parentRunIds: readonly string[] = []
): WorkflowRunView[] {
  const sessions = new Set(sessionIds.filter(Boolean))
  const parents = new Set(parentRunIds.filter(Boolean))
  return Object.values(runs)
    .filter((run) => !!run.parentMessageId && turnIds.has(run.parentMessageId) &&
      ((!!run.sessionId && sessions.has(run.sessionId)) || (!!run.parentRunId && parents.has(run.parentRunId))))
    .sort((a, b) => a.startedAt - b.startedAt)
}
