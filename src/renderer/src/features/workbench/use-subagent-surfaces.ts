import { useEffect } from 'react'
import { useStore } from '../../state/store'
import { useRightPanel } from '../../state/right-panel'
import { removedRunIds, subagentPaneId, subagentRunOfPane } from './subagent-panes'

function watchedSubagent(): string | null {
  const state = useRightPanel.getState()
  const entry = state.byKey[state.key]
  return entry?.open ? subagentRunOfPane(entry.active) : null
}

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
    let watched: string | null | undefined
    const syncWatched = (): void => {
      const next = watchedSubagent()
      if (next === watched) return
      watched = next
      void window.yan.subagents.watch?.(next ? [next] : [])?.catch(() => undefined)
    }
    syncWatched()
    const unwatch = useRightPanel.subscribe(syncWatched)
    return () => {
      alive = false
      unsubscribe()
      unwatch()
    }
  }, [])
}
