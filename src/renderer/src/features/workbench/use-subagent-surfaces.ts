import { useEffect } from 'react'
import { useStore } from '../../state/store'
import { useRightPanel } from '../../state/right-panel'
import { removedRunIds, subagentPaneId } from './subagent-panes'

export function usePruneSubagentSurfaces(): void {
  useEffect(() => {
    let alive = true
    void window.yan.subagents
      .list()
      .then((runs) => {
        if (!alive) return
        const known = new Set(runs.map((run) => run.id))
        const stale = new Set<string>()
        for (const entry of Object.values(useRightPanel.getState().byKey)) {
          for (const surface of entry.surfaces) if (surface.kind === 'subagent' && !known.has(surface.runId)) stale.add(surface.id)
        }
        if (stale.size) useRightPanel.getState().drop([...stale])
      })
      .catch(() => undefined)
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.subagents === previous.subagents) return
      const removed = removedRunIds(previous.subagents, state.subagents)
      if (removed.length) useRightPanel.getState().drop(removed.map(subagentPaneId))
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
}
