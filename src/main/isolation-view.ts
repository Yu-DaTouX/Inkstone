import { pick } from '../shared/ui-lang'
import type { RunnerStatus, SessionState } from '../shared/ipc'
import { discardIdleEmptyIsolations, hasSavedSessionUnder } from './isolation-cleanup'
import {
  AutoIsolationStore,
  discardUnusedIsolation,
  isolateCwdForConflict,
  isolatedSessionCwd,
  isolationCwdKey,
  pendingIsolationChanges,
  type AutoIsolationRecord
} from './session-isolation'

const ISOLATION_SYNC_MIN_INTERVAL = 3000

type IsolationViewState = NonNullable<RunnerStatus['isolation']>

export interface IsolationViewEntry {
  state: IsolationViewState
  branch: string
}

export interface IsolationRegistry {
  statuses(): RunnerStatus[]
  agentOf(id: string): { getState(): SessionState | null } | null
  stopOne(id: string): Promise<unknown>
  hasBusyCwd(cwd: string): boolean
}

export interface IsolationViewPort {
  registry: () => IsolationRegistry | null
  window: () => { isDestroyed(): boolean } | null
  isVisible: (state: SessionState | null) => boolean
  sessionsDir: string
  publishStatus: (text: string | undefined) => void
  onChange: () => void
  store?: AutoIsolationStore
}

export interface IsolationView {
  of(cwd: string): IsolationViewEntry | undefined
  initialize(): Promise<void>
  scheduleRefresh(): void
  discardUnused(): Promise<void>
  openWorktree(cwd: string): Promise<{ ok: true; cwd: string; branch: string } | { ok: false; error: string }>
  worktrees(): Promise<{ cwd: string; branch: string }[]>
  recordFor(cwd: string): Promise<AutoIsolationRecord | null>
  bindSession(cwd: string, sessionId: string): Promise<void>
}

export function createIsolationView(port: IsolationViewPort): IsolationView {
  const store = port.store ?? new AutoIsolationStore()
  const views = new Map<string, IsolationViewEntry>()
  let sweepAt = 0
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const publishStatus = (): void => {
    const pending = [...views.values()].filter((x) => x.state !== 'waiting').length
    port.publishStatus(pending === 0 ? undefined : pick(`工作树：${pending} 个有未合并的改动`, `Worktrees: ${pending} with unmerged changes`))
  }

  const setView = (worktree: string, view: IsolationViewEntry | null): void => {
    const key = isolationCwdKey(worktree)
    const before = views.get(key)
    if (view === null) {
      if (!before) return
      views.delete(key)
    } else {
      if (before && before.state === view.state && before.branch === view.branch) return
      views.set(key, view)
    }
    publishStatus()
    port.onChange()
  }

  const scheduleRefresh = (): void => {
    if (refreshTimer) return
    const wait = Math.max(0, ISOLATION_SYNC_MIN_INTERVAL - (Date.now() - sweepAt))
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, wait)
  }

  const discardUnused = async (): Promise<void> => {
    const registry = port.registry()
    if (!registry) return
    const discarded = await discardIdleEmptyIsolations({
      records: () => store.all(),
      runners: () => registry.statuses().map((status) => ({
        id: status.id,
        cwd: status.cwd,
        isActive: status.isActive,
        busy: status.running || status.waiting,
        visible: port.isVisible(registry.agentOf(status.id)?.getState() ?? null),
        messageCount: registry.agentOf(status.id)?.getState()?.messageCount ?? 0
      })),
      stopRunner: (id) => registry.stopOne(id),
      hasSavedSession: (record) => hasSavedSessionUnder(port.sessionsDir, record),
      discard: discardUnusedIsolation,
      forget: (record) => store.remove(record.worktree)
    }).catch(() => [])
    for (const record of discarded) setView(isolatedSessionCwd(record), null)
    if (discarded.length) port.onChange()
  }

  const refresh = async (): Promise<void> => {
    sweepAt = Date.now()
    const win = port.window()
    if (!port.registry() || !win) {
      scheduleRefresh()
      return
    }
    if (win.isDestroyed()) return
    await discardUnused()
    const records = await store.all().catch(() => [])
    for (const record of records) {
      if (port.registry()?.hasBusyCwd(isolatedSessionCwd(record)) === true) {
        setView(isolatedSessionCwd(record), { state: 'waiting', branch: record.branch })
        continue
      }
      const changes = await pendingIsolationChanges(record)
      const pending = changes.ok && changes.files + changes.commits > 0
      setView(isolatedSessionCwd(record), { state: pending ? 'ready' : 'waiting', branch: record.branch })
    }
    const alive = new Set(records.map((record) => isolationCwdKey(isolatedSessionCwd(record))))
    for (const key of [...views.keys()]) {
      if (!alive.has(key)) setView(key, null)
    }
  }

  return {
    of: (cwd) => views.get(isolationCwdKey(cwd)),
    initialize: async () => {
      const records = await store.all().catch(() => [])
      for (const record of records) setView(isolatedSessionCwd(record), { state: 'waiting', branch: record.branch })
      scheduleRefresh()
    },
    scheduleRefresh,
    discardUnused,
    openWorktree: async (cwd) => {
      const outcome = await isolateCwdForConflict(cwd)
      if (!outcome.ok) return { ok: false, error: outcome.reason }
      await store.add(outcome.record).catch(() => undefined)
      const target = isolatedSessionCwd(outcome.record)
      setView(target, { state: 'waiting', branch: outcome.record.branch })
      return { ok: true, cwd: target, branch: outcome.record.branch }
    },
    worktrees: async () => (await store.all()).map((record) => ({ cwd: isolatedSessionCwd(record), branch: record.branch })),
    recordFor: (cwd) => store.byWorktree(cwd),
    bindSession: (cwd, sessionId) => store.bindSession(cwd, sessionId)
  }
}
