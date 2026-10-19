import { useEffect } from 'react'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { removedRunIds, staleSubagentPanes, subagentPaneId } from './subagent-panes'

export function usePruneSubagentPanes(): void {
  useEffect(() => {
    let alive = true
    void window.yan.subagents
      .list()
      .then((runs) => {
        if (!alive) return
        const stale = staleSubagentPanes(useUiV3.getState().workspacePanes, new Set(runs.map((run) => run.id)))
        if (stale.length) useUiV3.getState().dropWorkspacePanes(stale)
      })
      .catch(() => undefined)
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.subagents === previous.subagents) return
      const removed = removedRunIds(previous.subagents, state.subagents)
      if (removed.length) useUiV3.getState().dropWorkspacePanes(removed.map(subagentPaneId))
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
}
