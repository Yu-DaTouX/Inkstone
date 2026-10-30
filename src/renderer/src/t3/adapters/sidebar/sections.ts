import type { ProjectRecord, SessionSummary } from '../../../../../shared/ipc'
import type { RunSnapshot } from '../../../../../shared/runs'
import { shortProject } from '../../../features/sidebar/sidebar-model'
import { isThreadWorking } from '../../internal/thread-inbox'
import { effectiveSnoozed } from '../../internal/thread-settled'
import { sortSettledThreads } from '../../internal/thread-sort'
import { NO_PROJECT_ID, toThreadView, type SidebarThreadView } from './types'

export interface SidebarSections {
  pinned: SidebarThreadView[]
  active: SidebarThreadView[]
  working: SidebarThreadView[]
  snoozed: SidebarThreadView[]
  settled: SidebarThreadView[]
}

function normalize(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function projectLookups(projects: readonly ProjectRecord[]): {
  byId: Map<string, ProjectRecord>
  byCwd: Map<string, ProjectRecord>
} {
  const byId = new Map<string, ProjectRecord>()
  const byCwd = new Map<string, ProjectRecord>()
  for (const project of projects) {
    byId.set(project.id, project)
    const key = normalize(project.cwd)
    if (!byCwd.has(key)) byCwd.set(key, project)
  }
  return { byId, byCwd }
}

function latestRunOf(runs: readonly RunSnapshot[], session: SessionSummary): RunSnapshot | null {
  let latest: RunSnapshot | null = null
  for (const run of runs) {
    const mine = (!!session.id && run.sessionId === session.id) || (!!session.path && run.sessionPath === session.path)
    if (!mine) continue
    if (!latest || run.startedAt > latest.startedAt) latest = run
  }
  return latest
}

export interface BuildSidebarSectionsInput {
  readonly sessions: readonly SessionSummary[]
  readonly runs: readonly RunSnapshot[]
  readonly projects: readonly ProjectRecord[]
  readonly projectNames: Record<string, string>
  readonly titles: Record<string, string>
  readonly manualTitles: Record<string, string>
  readonly now: number
}

export function buildSidebarSections(input: BuildSidebarSectionsInput): SidebarSections {
  const { byId, byCwd } = projectLookups(input.projects)
  const archivedProjectIds = new Set(input.projects.filter((project) => project.archived).map((project) => project.id))
  const archivedProjectCwds = new Set(input.projects.filter((project) => project.archived).map((project) => normalize(project.cwd)))
  const views: SidebarThreadView[] = []
  for (const session of input.sessions) {
    const record =
      (session.projectId ? byId.get(session.projectId) : undefined) ??
      (session.cwd ? byCwd.get(normalize(session.cwd)) : undefined)
    const title = input.manualTitles[session.id] ?? input.titles[session.id] ?? session.title
    const project = record
      ? { id: record.id, label: record.name || input.projectNames[record.cwd] || shortProject(record.cwd) }
      : session.cwd
        ? { id: NO_PROJECT_ID, label: input.projectNames[session.cwd] || shortProject(session.cwd) }
        : null
    const view = toThreadView(session, { run: latestRunOf(input.runs, session), title, project })
    const inArchivedProject =
      session.projectId !== undefined
        ? archivedProjectIds.has(session.projectId)
        : !!session.cwd && archivedProjectCwds.has(normalize(session.cwd))
    views.push(inArchivedProject && view.archivedAt === null ? { ...view, archivedAt: view.updatedAt, settledAt: view.updatedAt } : view)
  }

  const pinned: SidebarThreadView[] = []
  const active: SidebarThreadView[] = []
  const working: SidebarThreadView[] = []
  const snoozed: SidebarThreadView[] = []
  const settled: SidebarThreadView[] = []
  for (const view of views) {
    if (effectiveSnoozed(view, input.now)) snoozed.push(view)
    else if (view.archivedAt !== null) settled.push(view)
    else if (view.pinnedAt !== null) pinned.push(view)
    else if (isThreadWorking(view)) working.push(view)
    else active.push(view)
  }

  const byActivity = (left: SidebarThreadView, right: SidebarThreadView): number => right.activityAt - left.activityAt
  return {
    pinned: pinned.sort((left, right) => (Date.parse(right.pinnedAt ?? '') || 0) - (Date.parse(left.pinnedAt ?? '') || 0) || byActivity(left, right)),
    active: active.sort(byActivity),
    working: working.sort((left, right) => (Date.parse(right.latestUserAuthoredMessageAt ?? '') || 0) - (Date.parse(left.latestUserAuthoredMessageAt ?? '') || 0) || byActivity(left, right)),
    snoozed: snoozed.sort((left, right) => (Date.parse(left.snoozedUntil ?? '') || 0) - (Date.parse(right.snoozedUntil ?? '') || 0)),
    settled: sortSettledThreads(settled)
  }
}

