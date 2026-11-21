import type { Store } from '../state/store'
import { splitColumns, type SplitLayout, type SplitSessionRef } from '../state/split-view'

export function isSessionTile(ref: SplitSessionRef | null | undefined): boolean {
  if (!ref) return false
  return !!(ref.sessionId || ref.path)
}

export function sessionTiles(refs: readonly SplitSessionRef[]): SplitSessionRef[] {
  return refs.filter(isSessionTile)
}

export interface PaneLayout {
  tiles: SplitSessionRef[]
  live: number
}

export function collapsedPanes(split: SplitLayout | null, narrow: boolean, maxColumns = Number.POSITIVE_INFINITY): PaneLayout | null {
  if (!split || split.tiles.length < 2) return null
  if (narrow || maxColumns <= 1) return { tiles: [split.tiles[split.live]], live: 0 }
  const columns = splitColumns(split.tiles)
  if (columns.length <= maxColumns) return { tiles: split.tiles, live: split.live }
  const liveColumn = Math.max(0, columns.findIndex((column) => column.includes(split.live)))
  const start = Math.min(Math.max(0, liveColumn - Math.floor((maxColumns - 1) / 2)), columns.length - maxColumns)
  const kept = columns.slice(start, start + maxColumns).flat()
  return { tiles: kept.map((index) => split.tiles[index]), live: kept.indexOf(split.live) }
}

export function splitColumnsThatFit(width: number, minPaneWidth: number): number {
  return width > 0 ? Math.max(1, Math.floor(width / minPaneWidth)) : Number.POSITIVE_INFINITY
}

export interface SideBySideSession {
  id: string
  path: string
  archivedAt?: number
  lastActivityAt?: number
  updatedAt?: number
}

const normalizePath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b)

type SplitSummary = Store['sessions'][number]
type SplitSummaries = Pick<Store, 'sessions' | 'manualTitles' | 'titles'>
const summaryIndexes = new WeakMap<Store['sessions'], { byId: Map<string, SplitSummary>; byPath: Map<string, SplitSummary> }>()

function splitSummary(sessions: Store['sessions'], target: SplitSessionRef, path: string | undefined): SplitSummary | undefined {
  let index = summaryIndexes.get(sessions)
  if (!index) {
    const byId = new Map<string, SplitSummary>()
    const byPath = new Map<string, SplitSummary>()
    for (const item of sessions) {
      if (item.id && !byId.has(item.id)) byId.set(item.id, item)
      if (item.path) {
        const key = normalizePath(item.path)
        if (!byPath.has(key)) byPath.set(key, item)
      }
    }
    index = { byId, byPath }
    summaryIndexes.set(sessions, index)
  }
  return (target.sessionId ? index.byId.get(target.sessionId) : undefined) ?? (path ? index.byPath.get(path) : undefined)
}

function splitTitle(state: SplitSummaries, target: SplitSessionRef, summary: SplitSummary | undefined): string {
  const id = target.sessionId ?? summary?.id
  return ((id && (state.manualTitles[id] || state.titles[id])) || summary?.title || '').trim()
}

export function createSplitHeaderSelector(target: SplitSessionRef) {
  const path = target.path ? normalizePath(target.path) : undefined
  let previousSummary: SplitSummary | undefined
  let previousProjects: NonNullable<Store['settings']>['projects'] | undefined
  let previous = { title: '', project: '' }
  return (state: SplitSummaries & Pick<Store, 'settings'>) => {
    const summary = splitSummary(state.sessions, target, path)
    const title = splitTitle(state, target, summary)
    const projects = state.settings?.projects
    let project = previous.project
    if (summary?.projectId !== previousSummary?.projectId || summary?.cwd !== previousSummary?.cwd || projects !== previousProjects) {
      const record = summary?.projectId ? projects?.find((item) => item.id === summary.projectId) : undefined
      project = record?.name || (record?.cwd ?? summary?.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || ''
      previousSummary = summary
      previousProjects = projects
    }
    if (title !== previous.title || project !== previous.project) previous = { title, project }
    return previous
  }
}

type SplitRunnerState = Pick<Store, 'session' | 'sessionRuntimes'>
const running = (session: Store['session'] | undefined): boolean => !!(session?.isAgentRunning || session?.isStreaming)

function sameCwdBusy(state: SplitRunnerState, sessionId: string | undefined, cwd: string | undefined): boolean {
  if (!cwd) return false
  const live = state.session
  if (live && live.sessionId !== sessionId && running(live) && samePath(live.cwd, cwd)) return true
  for (const id in state.sessionRuntimes) {
    if (id === sessionId) continue
    const session = state.sessionRuntimes[id]?.session
    if (session?.cwd && running(session) && samePath(session.cwd, cwd)) return true
  }
  return false
}

export function createSplitPeerComposerSelector(target: SplitSessionRef) {
  const path = target.path ? normalizePath(target.path) : undefined
  let previous = { title: '', draft: '', running: false, model: '', cwdBusy: false }
  return (state: SplitSummaries & SplitRunnerState) => {
    const summary = splitSummary(state.sessions, target, path)
    const runtime = target.sessionId ? state.sessionRuntimes[target.sessionId] : undefined
    const session = runtime?.session
    const title = splitTitle(state, target, summary)
    const draft = runtime?.draft ?? ''
    const busy = running(session)
    const model = session?.model?.name ?? ''
    const cwdBusy = !busy && sameCwdBusy(state, target.sessionId, session?.cwd ?? summary?.cwd)
    if (title !== previous.title || draft !== previous.draft || busy !== previous.running || model !== previous.model || cwdBusy !== previous.cwdBusy) {
      previous = { title, draft, running: busy, model, cwdBusy }
    }
    return previous
  }
}

const sameRefAsSession = (ref: SplitSessionRef, session: SideBySideSession): boolean =>
  (!!ref.sessionId && ref.sessionId === session.id) || (!!ref.path && samePath(ref.path, session.path))

export function sideBySideCandidate(
  sessions: readonly SideBySideSession[],
  current: SplitSessionRef | null,
  taken: readonly SplitSessionRef[] = []
): SideBySideSession | null {
  const candidates = sessions.filter((session) => {
    if (session.archivedAt) return false
    if (current && sameRefAsSession(current, session)) return false
    return !taken.some((ref) => sameRefAsSession(ref, session))
  })
  candidates.sort(
    (a, b) => (b.lastActivityAt ?? b.updatedAt ?? 0) - (a.lastActivityAt ?? a.updatedAt ?? 0)
  )
  return candidates[0] ?? null
}
