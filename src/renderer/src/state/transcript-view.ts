import { create } from 'zustand'
import {
  effectiveView,
  nextTranscriptView,
  parseTranscriptViewPrefs,
  withDefaultView,
  withSessionView,
  type TranscriptView,
  type TranscriptViewPrefs
} from '../features/session/transcript-view-model'

const STORAGE_KEY = 'yan.transcriptView'

function readPrefs(): TranscriptViewPrefs {
  try {
    return parseTranscriptViewPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY))
  } catch {
    return parseTranscriptViewPrefs(null)
  }
}

function writePrefs(prefs: TranscriptViewPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
  }
}

interface TranscriptViewState extends TranscriptViewPrefs {
  setSessionView: (sessionId: string | null | undefined, view: TranscriptView) => void
  setDefaultView: (view: TranscriptView) => void
  cycle: (sessionId: string | null | undefined) => TranscriptView
}

export const useTranscriptViews = create<TranscriptViewState>((set, get) => {
  const commit = (prefs: TranscriptViewPrefs): void => {
    set(prefs)
    writePrefs(prefs)
  }
  const prefsOf = (): TranscriptViewPrefs => ({ defaultView: get().defaultView, sessions: get().sessions })
  return {
    ...readPrefs(),
    setSessionView: (sessionId, view) => {
      if (!sessionId) return get().setDefaultView(view)
      commit(withSessionView(prefsOf(), sessionId, view))
    },
    setDefaultView: (view) => commit(withDefaultView(prefsOf(), view)),
    cycle: (sessionId) => {
      const next = nextTranscriptView(effectiveView(prefsOf(), sessionId))
      get().setSessionView(sessionId, next)
      return next
    }
  }
})

export function useTranscriptView(sessionId: string | null | undefined): TranscriptView {
  return useTranscriptViews((s) => effectiveView(s, sessionId))
}
