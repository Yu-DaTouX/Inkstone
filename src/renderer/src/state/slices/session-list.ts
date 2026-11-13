import { uiText } from '../../i18n/ui-text'
import { composerSubmitIdentity } from '../composer-recovery'
import { pickProjectSession as pickProjectSessionTarget } from '../project-session'
import { reuseSessionSummaries } from '../session-list'
import type { Store } from '../store'
import { expectedRuntimeFor } from './runtime'
import { piCall, pushNotice, type SliceContext } from './shared'

interface DeletedTitles {
  manualTitles: Record<string, string>
  titles: Record<string, string>
}

const DELETED_TITLES_MAX = 50

const deletedTitles = new Map<string, DeletedTitles>()

function rememberDeletedTitles(token: string, kept: DeletedTitles): void {
  deletedTitles.set(token, kept)
  while (deletedTitles.size > DELETED_TITLES_MAX) {
    const oldest = deletedTitles.keys().next().value
    if (oldest === undefined) break
    deletedTitles.delete(oldest)
  }
}

export type SessionListSlice = Pick<Store, 'sessions' | 'titles' | 'manualTitles' | 'refreshSessions' | 'pickProjectSession' | 'moveSession' | 'setSessionArchived' | 'setSessionPinned' | 'setSessionSnoozed' | 'setSessionMarkedUnread' | 'renameSession' | 'setManualTitle' | 'regenerateTitle' | 'deleteSession' | 'restoreDeletedSession'>

export function createSessionListSlice({ set, get }: SliceContext): SessionListSlice {
  return {
  sessions: [],
  titles: {},
  manualTitles: {},
  refreshSessions: async () => {
    try {
      const listed = await window.yan.listSessions()
      const sessions = reuseSessionSummaries(get().sessions, Array.isArray(listed) ? listed : [])
      if (sessions !== get().sessions) set({ sessions })
    } catch {
    }
  },
  pickProjectSession: (cwd, projectId) => {
    const s = get()
    return pickProjectSessionTarget({ cwd, projectId, runners: s.runners, sessions: s.sessions })
  },
  moveSession: async (sessionId, projectId, cwd) => {
    const before = get()
    const showing = before.session?.sessionId === sessionId
    const showingPath = showing ? before.session?.sessionFile : undefined
    const res = await window.yan.moveSession(sessionId, projectId, cwd)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.moveFailed')) })
      return false
    }
    await get().refreshSessions()
    if (res.cwdChanged && showingPath && get().session?.sessionId === sessionId) await get().switchSession(showingPath)
    return true
  },
  setSessionArchived: async (sessionId, archived) => {
    const res = await window.yan.setSessionArchived(sessionId, archived)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.archiveFailed')) })
      return false
    }
    await get().refreshSessions()
    return true
  },
  setSessionPinned: async (sessionId, pinned) => {
    const res = await window.yan.setSessionPinned(sessionId, pinned)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.pinFailed')) })
      return false
    }
    await get().refreshSessions()
    return true
  },
  setSessionSnoozed: async (sessionId, until) => {
    const res = await window.yan.setSessionSnoozed(sessionId, until)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.snoozeFailed')) })
      return false
    }
    await get().refreshSessions()
    return true
  },
  setSessionMarkedUnread: async (sessionId, marked) => {
    const res = await window.yan.setSessionMarkedUnread(sessionId, marked)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.markUnreadFailed')) })
      return false
    }
    await get().refreshSessions()
    return true
  },
  renameSession: async (name) => {
    const expected = expectedRuntimeFor(get(), composerSubmitIdentity(get()))
    const res = expected
      ? await piCall(() => window.yan.renameSession(name, expected))
      : { ok: false, error: uiText('state.error.sessionNotActivated') }
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.renameFailed')) })
      return
    }
    await get().refreshSessions()
  },
  setManualTitle: async (sessionId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const state = get()
    const sid = sessionId || state.session?.sessionId || ''
    if (!sid) return
    const previous = state.manualTitles[sid]
    set({ manualTitles: { ...state.manualTitles, [sid]: trimmed } })
    if (sid === state.session?.sessionId) {
      const expected = expectedRuntimeFor(state, composerSubmitIdentity(state))
      if (expected) await piCall(() => window.yan.renameSession(trimmed, expected))
    }
    const res = await piCall(() => window.yan.setManualTitle(sid, trimmed))
    if (!res.ok) {
      const rolled = { ...get().manualTitles }
      if (previous === undefined) delete rolled[sid]
      else rolled[sid] = previous
      set({
        manualTitles: rolled,
        notices: pushNotice(get().notices, 'error', uiText('state.error.renameSaveFailed', { error: res.error ?? uiText('state.error.writeFailed') }))
      })
    }
    await get().refreshSessions()
  },
  regenerateTitle: async (sessionId) => {
    const sid = sessionId || get().session?.sessionId || ''
    if (!sid) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.noSessionForTitle')) })
      return
    }
    let res: { ok: boolean; title?: string; error?: string }
    try {
      res = await window.yan.regenerateTitle(sid)
    } catch (error) {
      res = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!res.ok || !res.title) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.titleFailedKept')) })
      return
    }
    if (get().manualTitles[sid]) await get().setManualTitle(sid, res.title)
    set({ notices: pushNotice(get().notices, 'info', uiText('state.title.changed', { title: res.title })) })
  },
  deleteSession: async (path) => {
    const res = await piCall(() => window.yan.deleteSession(path))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.deleteFailed')) })
      return { ok: false }
    }
    const cache = { ...get().sessionRuntimes }
    const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
    const removedIds = new Set(get().sessions.filter((item) => normalize(item.path) === normalize(path)).map((item) => item.id))
    for (const [key, snapshot] of Object.entries(cache)) {
      if (snapshot.session?.sessionFile && normalize(snapshot.session.sessionFile) === normalize(path)) {
        delete cache[key]
        removedIds.add(snapshot.session.sessionId)
      }
    }
    const manualTitles = { ...get().manualTitles }
    const titles = { ...get().titles }
    const kept: DeletedTitles = { manualTitles: {}, titles: {} }
    for (const id of removedIds) {
      if (manualTitles[id] !== undefined) kept.manualTitles[id] = manualTitles[id]
      if (titles[id] !== undefined) kept.titles[id] = titles[id]
      delete manualTitles[id]
      delete titles[id]
    }
    if (res.undoToken) rememberDeletedTitles(res.undoToken, kept)
    set({ sessionRuntimes: cache, manualTitles, titles })
    await get().refreshSessions()
    return { ok: true, undoToken: res.undoToken }
  },
  restoreDeletedSession: async (undoToken) => {
    let res: { ok: boolean; error?: string }
    try {
      res = await window.yan.restoreSession(undoToken)
    } catch (error) {
      res = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!res.ok) return { ok: false, error: res.error ?? uiText('state.error.restoreFailed') }
    const kept = deletedTitles.get(undoToken)
    deletedTitles.delete(undoToken)
    if (kept) {
      set({
        manualTitles: { ...kept.manualTitles, ...get().manualTitles },
        titles: { ...kept.titles, ...get().titles }
      })
    }
    await get().refreshSessions()
    return { ok: true }
  },
  }
}
