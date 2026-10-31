import { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { displayedSessionOf, indexOfSession, useSplitView } from '../../state/split-view'
import { readSavedSplit, restoreSplit, serializeSplit, writeSavedSplit } from './split-persist'
import { focusSplitSession } from './split-actions'

const SAVE_DELAY_MS = 300

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function useSplitPersistence(): void {
  const sessions = useStore((s) => s.sessions)
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current || sessions.length === 0) return
    const view = useSplitView.getState()
    if (view.split) {
      restored.current = true
      return
    }
    const snapshot = restoreSplit(readSavedSplit(storage()), sessions)
    if (!snapshot?.split) return
    restored.current = true
    useSplitView.setState({ split: snapshot.split, weights: snapshot.weights, rowSplit: snapshot.rowSplit })
    const displayed = displayedSessionOf(useStore.getState())
    const live = snapshot.split.tiles[snapshot.split.live]
    if (live && (!displayed || indexOfSession(snapshot.split.tiles, displayed) < 0)) focusSplitSession(live)
  }, [sessions])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      timer = null
      if (!restored.current) return
      const state = useSplitView.getState()
      writeSavedSplit(storage(), serializeSplit({ split: state.split, weights: state.weights, rowSplit: state.rowSplit }))
    }
    const off = useSplitView.subscribe((state, previous) => {
      if (state.split === previous.split && state.weights === previous.weights && state.rowSplit === previous.rowSplit) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, SAVE_DELAY_MS)
    })
    window.addEventListener('pagehide', flush)
    return () => {
      off()
      window.removeEventListener('pagehide', flush)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}
