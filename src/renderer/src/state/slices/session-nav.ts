import type { SessionState, UIMessage } from '../../../../shared/ipc'
import { uiText } from '../../i18n/ui-text'
import { sameComposerView, type ComposerSubmitIdentity } from '../composer-recovery'
import { beginSessionSwitch as markSessionSwitch, endSessionSwitch as unmarkSessionSwitch } from '../session-activation'
import { mergePeekedHistory } from '../session-message-merge'
import { migratePathDraft } from '../session-runtime'
import { sameSessionFile, viewIdentityOf } from '../view-identity'
import { discardPendingMessagePatches, type Store } from '../store'
import {
  EMPTY_QUEUE,
  findNewSessionSnapshot,
  findRuntimeSnapshot,
  findSnapshotByPath,
  hasComposerIdentity,
  nav,
  projectSnapshotKeepingHistory,
  sameSessionPath,
  sessionActionTarget,
  snapshotForView,
  switchToRuntimeSnapshot
} from './runtime'
import { piCall, pushNotice, type SliceContext } from './shared'

function beginSessionSwitch(gate: number): () => void {
  discardPendingMessagePatches()
  let resolve!: () => void
  const done = new Promise<void>((r) => { resolve = r })
  nav.switchInFlight = { gate, done }
  markSessionSwitch(gate)
  return () => {
    if (nav.switchInFlight?.gate === gate) nav.switchInFlight = null
    unmarkSessionSwitch(gate)
    resolve()
  }
}

function beginNewSession(): () => void {
  let resolve!: () => void
  const done = new Promise<void>((r) => { resolve = r })
  nav.newInFlight = done
  return () => {
    if (nav.newInFlight === done) nav.newInFlight = null
    resolve()
  }
}

export type SessionNavSlice = Pick<Store, 'compactCommand' | 'peekedPath' | 'peekedSessionId' | 'peekNote' | 'switchLoading' | 'pendingActivation' | 'newSession' | 'switchSession' | 'ensureActivated' | 'fork' | 'clone' | 'exportHtml' | 'compact' | 'stop'>

export function createSessionNavSlice({ set, get }: SliceContext): SessionNavSlice {
  return {
  compactCommand: null,
  peekedPath: null,
  peekedSessionId: null,
  peekNote: null,
  switchLoading: false,
  pendingActivation: null,
  newSession: async (target) => {
    nav.seq += 1
    discardPendingMessagePatches()
    const gate = ++nav.gate
    const finishNewSession = beginNewSession()
    try {
    if (get().switchLoading) set({ switchLoading: false })
    const res = await piCall(() => window.yan.newSession(target))
    if (gate !== nav.gate) {
      return res.ok
        ? { ok: true, sessionId: res.sessionId ?? undefined, runId: res.runId ?? res.id }
        : { ok: false, error: res.error }
    }
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.newSessionFailed')) })
      return { ok: false, error: res.error }
    }
    const before = get()
    const arrived = findNewSessionSnapshot(
      before.sessionRuntimes,
      res.sessionId ?? undefined,
      res.runId ?? res.id,
      res.generation
    )
    set({
      ...(res.id || res.runId ? { activeRunnerId: res.runId ?? res.id } : {}),
      ...(arrived
        ? switchToRuntimeSnapshot(arrived)
        : {
            messages: [],
            session: null,
            todos: [],
            todoHistory: [],
            uiRequests: [],
            statuses: {},
            widgets: {},
            widgetPlacements: {},
            stats: null
          }),
      queue: arrived?.queue ?? EMPTY_QUEUE,
      pendingActivation: null,
      peekedPath: null,
      peekedSessionId: null,
      peekNote: null
    })
    void get().syncRunners()
    void get().reloadModels()
    void get().reloadCommands()
    await get().refreshSessions()
    return { ok: true, sessionId: res.sessionId ?? undefined, runId: res.runId ?? res.id }
    } finally {
      finishNewSession()
    }
  },
  switchSession: async (path) => {
    nav.seq += 1
    const gate = ++nav.gate
    const finishSwitch = beginSessionSwitch(gate)
    try {
    const findSummary = () => get().sessions.find((x) => x.path === path) ?? get().sessions.find((x) => sameSessionPath(x.path, path))
    let sum = findSummary()
    const cachedSnapshot = (sum?.id ? get().sessionRuntimes[sum.id] : undefined) ??
      findSnapshotByPath(get().sessionRuntimes, path)
    const cachedMessages = cachedSnapshot?.messages
    const left = get()
    const leftView = {
      peekedPath: left.peekedPath,
      peekedSessionId: left.peekedSessionId,
      peekNote: left.peekNote,
      messages: left.messages,
      session: left.session,
      stats: left.stats,
      queue: left.queue,
      todos: left.todos,
      todoHistory: left.todoHistory,
      uiRequests: left.uiRequests,
      statuses: left.statuses,
      widgets: left.widgets,
      widgetPlacements: left.widgetPlacements,
      pendingActivation: left.pendingActivation
    }
    set({
      peekedPath: path,
      peekedSessionId: sum?.id ?? cachedSnapshot?.runtime.sessionId ?? null,
      peekNote: null,
      switchLoading: !cachedMessages?.length,
      messages: cachedMessages ?? [],
      session: cachedSnapshot?.session ?? null,
      stats: cachedSnapshot?.stats ?? null,
      queue: cachedSnapshot?.queue ?? EMPTY_QUEUE,
      todos: cachedSnapshot?.todos ?? [],
      todoHistory: cachedSnapshot?.todoHistory ?? [],
      uiRequests: cachedSnapshot?.uiRequests ?? [],
      statuses: cachedSnapshot?.statuses ?? {},
      widgets: cachedSnapshot?.widgets ?? {},
      widgetPlacements: cachedSnapshot?.widgetPlacements ?? {}
    })

    performance.mark('yan:switch-start')
    try {
      const peek = await window.yan.peekSession(path, { trackSync: !cachedMessages?.length })
      if (gate !== nav.gate) return
      performance.mark('yan:switch-peeked')
      if (peek) {
        const stableId = peek.sessionId ?? sum?.id
        const before = get()
        const migrated = migratePathDraft(before.sessionRuntimes, path, stableId)
        if (peek.messages.length) {
          set({
            messages: mergePeekedHistory(peek.messages, before.messages),
            peekedPath: path,
            peekedSessionId: stableId ?? null,
            peekNote: peek.truncated > 0 ? { truncated: peek.truncated, total: peek.total } : null,
            switchLoading: false,
            ...(migrated !== before.sessionRuntimes ? { sessionRuntimes: migrated } : {})
          })
        } else if (migrated !== before.sessionRuntimes) {
          set({ sessionRuntimes: migrated })
        }
        requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('yan:switch-painted')))
      }
    } catch {
      if (gate !== nav.gate) return
    }
    if (get().switchLoading) set({ switchLoading: false })

    if (!sum && !cachedSnapshot?.session?.cwd) {
      await get().refreshSessions().catch(() => undefined)
      if (gate !== nav.gate) return
      sum = findSummary()
    }
    const cwd = sum?.cwd || cachedSnapshot?.session?.cwd || get().session?.cwd || get().settings?.cwd || ''
    const settings = get().settings
    const projectId = sum?.scope === 'global'
      ? undefined
      : (sum?.projectId ?? settings?.projects.find((project) => project.cwd.toLowerCase() === cwd.toLowerCase())?.id)
    const scope = sum?.scope ?? (projectId ? 'project' : 'global')
    const res = await piCall(() =>
      window.yan.selectSession({ sessionFile: sum?.path ?? path, sessionId: sum?.id, projectId, scope, cwd, preview: true })
    )
    performance.mark('yan:switch-selected')
    if (gate !== nav.gate) return
    if (!res.ok) {
      const leftId = viewIdentityOf(leftView).sessionId
      const leftCache = leftId ? get().sessionRuntimes[leftId] : undefined
      set({
        ...leftView,
        ...(leftCache?.messages?.length ? { messages: leftCache.messages } : {}),
        ...(leftCache?.session ? { session: leftCache.session } : {}),
        ...(leftCache?.queue ? { queue: leftCache.queue } : {}),
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.switchFailed'))
      })
      return
    }
    if (res.sessionId && !get().peekedSessionId && get().peekedPath) {
      set({ peekedSessionId: res.sessionId })
    }
    if (res.deferred) {
      set({
        pendingActivation: { sessionFile: sum?.path ?? path, sessionId: res.sessionId ?? sum?.id, projectId, scope, cwd },
        peekedPath: path,
        peekedSessionId: res.sessionId ?? sum?.id ?? null,
        ...(res.deferredReason === 'limit' ? {} : {
          notices: pushNotice(
            get().notices,
            'info',
            uiText('state.session.readOnlyNotice')
          )
        })
      })
      void get().syncRunners()
      return
    }
    const runId = res.runId ?? res.id
    const snapshot = findRuntimeSnapshot(
      get().sessionRuntimes,
      res.sessionId ?? sum?.id,
      runId
    )
    const usable = snapshotForView(get(), snapshot)
    set({
      ...(usable ? projectSnapshotKeepingHistory(get(), usable) : {}),
      queue: usable?.queue ?? EMPTY_QUEUE,
      ...(runId ? { activeRunnerId: runId } : {}),
      pendingActivation: null
    })
    void get().syncRunners()
    void get().reloadModels()
    void get().reloadCommands()
    } finally {
      if (gate === nav.gate && get().switchLoading) set({ switchLoading: false })
      finishSwitch()
    }
  },
  ensureActivated: async (expected?: ComposerSubmitIdentity): Promise<boolean> => {
    for (let i = 0; i < 8 && nav.switchInFlight; i += 1) {
      await nav.switchInFlight.done
    }
    if (nav.switchInFlight) return false
    const pending = get().pendingActivation
    if (!pending) return true
    if (expected && hasComposerIdentity(expected) && !sameComposerView(get(), expected)) return false
    const gate = nav.gate
    const res = await piCall(() => window.yan.selectSession(pending))
    if (gate !== nav.gate || get().pendingActivation !== pending) return false
    if (expected && hasComposerIdentity(expected) && !sameComposerView(get(), expected)) return false
    if (!res.ok || res.deferred) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.switchFailedMessageNotSent'))
      })
      return false
    }
    const activated = get()
    set({
      pendingActivation: null,
      ...(res.runId ?? res.id ? { activeRunnerId: res.runId ?? res.id } : {}),
      ...(res.sessionId && !activated.peekedSessionId && sameSessionFile(activated.peekedPath, pending.sessionFile)
        ? { peekedSessionId: res.sessionId }
        : {})
    })
    const activatedCache = get().sessionRuntimes
    const migrated = migratePathDraft(activatedCache, pending.sessionFile, res.sessionId)
    if (migrated !== activatedCache) set({ sessionRuntimes: migrated })
    void get().syncRunners()
    void get().reloadModels()
    void get().reloadCommands()
    return true
  },
  fork: async (entryId) => {
    nav.seq += 1
    ++nav.gate
    if (get().switchLoading) set({ switchLoading: false })
    const target = await sessionActionTarget(get)
    if (!target) return false
    const sourceRunner = get().activeRunnerId
    const res = await piCall(() => window.yan.fork(entryId, target.expected))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.forkFailed')) })
      return false
    }
    let branchState: SessionState | null
    let branchMessages: UIMessage[]
    try { [branchState, branchMessages] = await Promise.all([window.yan.getState(), window.yan.getMessages()]) }
    catch (error) {
      set({ notices: pushNotice(get().notices, 'warning', uiText('state.fork.createdNotActivated', { error: String(error) })) })
      await get().refreshSessions()
      return true
    }
    if (get().activeRunnerId !== sourceRunner || !target.current()) {
      set({ notices: pushNotice(get().notices, 'warning', uiText('state.fork.createdSessionChanged')) })
      await get().refreshSessions()
      return true
    }
    if (branchState) set({ session: branchState, messages: branchMessages, pendingActivation: null, peekedPath: null, peekedSessionId: null, peekNote: null })
    set({
      queue: EMPTY_QUEUE,
      notices: pushNotice(
        get().notices,
        'info',
        res.text
          ? uiText('state.fork.beforeMessage', { text: res.text.slice(0, 30) })
          : uiText('state.fork.done')
      )
    })
    if (res.text) get().injectComposerText(res.text)
    await get().refreshSessions()
    return true
  },
  clone: async () => {
    nav.seq += 1
    ++nav.gate
    if (get().switchLoading) set({ switchLoading: false })
    const target = await sessionActionTarget(get)
    const res = target
      ? await piCall(() => window.yan.clone(target.expected))
      : { ok: false, error: uiText('state.error.sessionNotActivated') }
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.cloneFailed')) })
      return
    }
    set({ queue: EMPTY_QUEUE, notices: pushNotice(get().notices, 'info', uiText('state.clone.done')) })
    await get().refreshSessions()
  },
  exportHtml: async (outputPath) => {
    const target = await sessionActionTarget(get)
    if (!target) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    const res = await piCall(() => window.yan.exportHtml(outputPath, target.expected))
    if (res.ok && target.current()) get().notify('info', uiText('state.export.done', { path: res.path ?? '' }))
    return res
  },
  compact: async (customInstructions) => {
    const target = await sessionActionTarget(get)
    if (!target) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    const sessionId = get().session?.sessionId
    if (sessionId) set({ compactCommand: { sessionId, text: customInstructions ? `/compact ${customInstructions}` : '/compact' } })
    return piCall(() => window.yan.compact(customInstructions, target.expected))
  },
  stop: async () => {
    try {
      await window.yan.abort()
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.commandFailed')) })
    }
  },
  }
}
