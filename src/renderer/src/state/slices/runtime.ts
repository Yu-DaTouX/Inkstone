import type { ExpectedRuntimeOwner, QueueState, RunnerStatus, RuntimeEnvelope } from '../../../../shared/ipc'
import { composerSubmitIdentity, sameComposerView, type ComposerSubmitIdentity } from '../composer-recovery'
import { reuseIfSame } from '../same-messages'
import type { SessionRuntimeMap, SessionRuntimeSnapshot } from '../session-runtime'
import { viewingSessionId } from '../push-routing'
import type { Store } from '../store'

export const nav: {
  gate: number
  seq: number
  switchInFlight: { gate: number; done: Promise<void> } | null
  newInFlight: Promise<void> | null
} = { gate: 0, seq: 0, switchInFlight: null, newInFlight: null }

export const EMPTY_QUEUE: QueueState = { steering: [], followUp: [] }

export function runtimeFromRunner(runner: RunnerStatus): RuntimeEnvelope {
  return {
    sessionId: runner.sessionId ?? '',
    runId: runner.runId ?? runner.id,
    projectId: runner.projectId,
    generation: runner.generation
  }
}

export function runtimeForState(
  state: Pick<Store, 'session' | 'activeRunnerId' | 'runners'>
): RuntimeEnvelope | null {
  const runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
  const runId = runner?.runId ?? runner?.id ?? state.activeRunnerId
  if (!runId) return null
  return {
    sessionId: state.session?.sessionId ?? runner?.sessionId ?? '',
    runId,
    projectId: runner?.projectId,
    generation: runner?.generation ?? 0
  }
}

export function hasComposerIdentity(id: ComposerSubmitIdentity): boolean {
  return !!(id.sessionId || id.path || id.runId)
}

export function expectedRuntimeFor(state: Store, id: ComposerSubmitIdentity): ExpectedRuntimeOwner | undefined {
  const norm = (p?: string): string => (p ?? '').replace(/\\/g, '/').toLowerCase()
  const byRun = id.runId ? state.runners.find((item) => (item.runId ?? item.id) === id.runId) : undefined
  const bySession = id.sessionId && !id.sessionId.startsWith('pending:')
    ? state.runners.find((item) => item.sessionId === id.sessionId)
    : undefined
  const byPath = id.path ? state.runners.find((item) => norm(item.sessionFile) === norm(id.path)) : undefined
  let runner = byRun ?? bySession ?? byPath
  if (runner && id.sessionId && !id.sessionId.startsWith('pending:') && runner.sessionId && runner.sessionId !== id.sessionId) {
    runner = undefined
  }
  if (runner && id.path && runner.sessionFile && norm(runner.sessionFile) !== norm(id.path)) {
    runner = undefined
  }
  if (!runner && !id.sessionId && !id.path && !id.runId && state.activeRunnerId) {
    runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
  }
  if (!runner) return undefined
  const runId = runner.runId ?? runner.id
  if (!runId) return undefined
  return {
    ...(runner.sessionId ? { sessionId: runner.sessionId } : {}),
    runId,
    ...(runner.projectId ? { projectId: runner.projectId } : {}),
    ...(runner.generation !== undefined ? { generation: runner.generation } : {})
  }
}

export async function submitRuntimeFor(get: () => Store, id: ComposerSubmitIdentity): Promise<ExpectedRuntimeOwner | null | undefined> {
  const found = expectedRuntimeFor(get(), id)
  const saved = (!!id.sessionId && !id.sessionId.startsWith('pending:')) || !!id.path
  if (found || !saved) return found
  await get().syncRunners()
  return expectedRuntimeFor(get(), id) ?? (get().runners.length ? null : undefined)
}

export async function sessionActionTarget(get: () => Store) {
  for (let i = 0; i < 8 && nav.newInFlight; i += 1) {
    await nav.newInFlight
  }
  if (nav.newInFlight) return null
  const identity = composerSubmitIdentity(get())
  const gate = nav.gate
  if (!(await get().ensureActivated(identity))) return null
  await get().syncRunners()
  const current = () => gate === nav.gate && sameComposerView(get(), identity)
  if (!current()) return null
  const expected = expectedRuntimeFor(get(), composerSubmitIdentity(get()))
  if (!expected || expected.generation === undefined) return null
  return { expected, current }
}

export function projectRuntimeSnapshot(snapshot: SessionRuntimeSnapshot): Partial<Store> {
  const projection: Partial<Store> = {
    messages: snapshot.messages,
    stats: snapshot.stats,
    queue: snapshot.queue,
    todos: snapshot.todos,
    todoHistory: snapshot.todoHistory,
    uiRequests: snapshot.uiRequests,
    statuses: snapshot.statuses,
    widgets: snapshot.widgets,
    widgetPlacements: snapshot.widgetPlacements ?? {},
    models: snapshot.models,
    thinkingLevels: snapshot.thinkingLevels,
    commands: snapshot.commands,
    commandsAt: snapshot.commands.length ? Date.now() : 0
  }
  if (snapshot.session) projection.session = snapshot.session
  return projection
}

export function switchToRuntimeSnapshot(snapshot: SessionRuntimeSnapshot): Partial<Store> {
  return { ...projectRuntimeSnapshot(snapshot), session: snapshot.session }
}

export function projectSnapshotKeepingHistory(state: Store, snapshot: SessionRuntimeSnapshot): Partial<Store> {
  const projection = projectRuntimeSnapshot(snapshot)
  if (projection.messages) projection.messages = reuseIfSame(state.messages, projection.messages) as typeof state.messages
  if (snapshot.messagesLoaded === false && state.messages.length > 0) {
    delete projection.messages
  }
  if (snapshot.models.length === 0 && state.models.length > 0) delete projection.models
  if (snapshot.thinkingLevels.length === 0 && state.thinkingLevels.length > 0) delete projection.thinkingLevels
  return projection
}

export function findRuntimeSnapshot(
  map: SessionRuntimeMap,
  sessionId?: string,
  runId?: string
): SessionRuntimeSnapshot | undefined {
  if (sessionId && map[sessionId]) return map[sessionId]
  if (runId) {
    const byRun = map[`run:${runId}`]
    if (byRun && (!sessionId || byRun.runtime.sessionId === sessionId)) return byRun
  }
  return undefined
}

export function sameSessionPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

export function findSnapshotByPath(map: SessionRuntimeMap, path: string): SessionRuntimeSnapshot | undefined {
  for (const snapshot of Object.values(map)) {
    const file = snapshot.session?.sessionFile
    if (file && sameSessionPath(file, path)) return snapshot
  }
  return undefined
}

export function findNewSessionSnapshot(
  map: SessionRuntimeMap,
  sessionId: string | undefined,
  runId: string | undefined,
  generation: number | undefined
): SessionRuntimeSnapshot | undefined {
  const all = Object.values(map)
  if (sessionId) {
    const exact = all.find(
      (snapshot) =>
        snapshot.runtime.sessionId === sessionId &&
        (generation === undefined || snapshot.runtime.generation === generation)
    )
    if (exact) return exact
  }
  if (generation === undefined || !runId) return undefined
  return all.find(
    (snapshot) =>
      snapshot.runtime.runId === runId &&
      snapshot.runtime.generation === generation &&
      (!sessionId ||
        !snapshot.runtime.sessionId ||
        snapshot.runtime.sessionId === sessionId ||
        snapshot.runtime.sessionId.startsWith('pending:'))
  )
}

export function viewedActiveRunner(s: Store, list: RunnerStatus[]): RunnerStatus | undefined {
  const active = list.find((runner) => runner.isActive)
  if (!active) return undefined
  const viewing = viewingSessionId(s)
  return !viewing || !active.sessionId || active.sessionId === viewing ? active : undefined
}

export function snapshotForView(s: Store, snapshot?: SessionRuntimeSnapshot): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined
  const viewing = viewingSessionId(s)
  return !viewing || snapshot.runtime.sessionId === viewing ? snapshot : undefined
}
