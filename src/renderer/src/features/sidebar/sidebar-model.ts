import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'

export interface SidebarGroup {
  key: string
  slot: string
  label: string
  projectId?: string
  cwd: string
  current: boolean
  list: SessionSummary[]
}

export function sameCwd(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b)
}

function normalizeCwd(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function shortProject(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function activityOf(session: SessionSummary): number {
  return session.lastActivityAt ?? session.updatedAt
}

export interface RunIndex {
  latest(session: { id?: string | null; path?: string | null }): RunSnapshot | null
}

export function indexRuns(runs: readonly RunSnapshot[]): RunIndex {
  const byId = new Map<string, RunSnapshot>()
  const byPath = new Map<string, RunSnapshot>()
  const keep = (map: Map<string, RunSnapshot>, key: string, run: RunSnapshot): void => {
    const previous = map.get(key)
    if (!previous || run.startedAt > previous.startedAt) map.set(key, run)
  }
  for (const run of runs) {
    if (run.sessionId) keep(byId, run.sessionId, run)
    if (run.sessionPath) keep(byPath, run.sessionPath, run)
  }
  return {
    latest(session) {
      const bySession = session.id ? byId.get(session.id) : undefined
      const byFile = session.path ? byPath.get(session.path) : undefined
      if (!bySession) return byFile ?? null
      if (!byFile) return bySession
      return byFile.startedAt > bySession.startedAt ? byFile : bySession
    }
  }
}

export function unreadRunIdsForSession(
  runs: readonly RunSnapshot[],
  session: { id?: string | null; path?: string | null }
): string[] {
  if (!session.id && !session.path) return []
  return runs
    .filter((run) => (!!session.id && run.sessionId === session.id) || (!!session.path && run.sessionPath === session.path))
    .filter((run) => (run.phase.kind === 'done' || run.phase.kind === 'failed') && !run.phase.seen)
    .map((run) => run.runId)
}

interface BuildOptions {
  sessions: readonly SessionSummary[]
  query: string
  projects: readonly ProjectRecord[]
  projectNames: Record<string, string>
  currentProjectId?: string
  currentCwd?: string
  titles: Record<string, string>
  manualTitles: Record<string, string>
  pinnedLabel?: string
}

export function buildSidebarGroups(options: BuildOptions): SidebarGroup[] {
  const { sessions, projects, projectNames, currentProjectId, currentCwd, titles, manualTitles } = options
  const query = options.query.trim().toLowerCase()
  const recordById = new Map(projects.map((project) => [project.id, project]))
  const recordByCwd = new Map<string, ProjectRecord>()
  for (const project of projects) {
    const key = normalizeCwd(project.cwd)
    if (!recordByCwd.has(key)) recordByCwd.set(key, project)
  }

  const labelFor = (session: SessionSummary): { key: string; slot: string; label: string; projectId?: string; cwd: string } => {
    const record =
      (session.projectId ? recordById.get(session.projectId) : undefined) ??
      (session.cwd ? recordByCwd.get(normalizeCwd(session.cwd)) : undefined)
    if (record) {
      return {
        key: `project:${record.id}`,
        slot: `cwd:${record.cwd.toLowerCase()}`,
        projectId: record.id,
        cwd: record.cwd,
        label: record.name || projectNames[record.cwd] || shortProject(record.cwd)
      }
    }
    const cwd = session.cwd || ''
    const label = (cwd && projectNames[cwd]) || (cwd ? shortProject(cwd) : '')
    return { key: `cwd:${cwd}`, slot: `cwd:${cwd.toLowerCase()}`, cwd, label }
  }

  const archivedIds = new Set(projects.filter((project) => project.archived).map((project) => project.id))
  const archivedCwds = new Set(projects.filter((project) => project.archived).map((project) => project.cwd.toLowerCase()))
  const inArchivedProject = (session: SessionSummary): boolean =>
    session.projectId ? archivedIds.has(session.projectId) : !!session.cwd && archivedCwds.has(session.cwd.toLowerCase())
  const active = sessions.filter((session) => !session.archivedAt && !inArchivedProject(session))
  const decorated = active.map((session) => {
    const group = labelFor(session)
    const title = manualTitles[session.id] ?? titles[session.id] ?? session.title
    return { session, group, title }
  })

  const matches = (item: (typeof decorated)[number]): boolean => {
    if (!query) return true
    const haystack = [item.title, item.session.cwd, item.group.label, item.session.path]
    return haystack.some((value) => value.toLowerCase().includes(query))
  }
  const groupLabels = new Map<string, string>()
  for (const item of decorated) {
    if (!groupLabels.has(item.group.key)) groupLabels.set(item.group.key, item.group.label)
  }
  const groupHit = (key: string): boolean => {
    if (!query) return false
    const label = groupLabels.get(key)
    return label ? label.toLowerCase().includes(query) : false
  }

  const byKey = new Map<string, SidebarGroup>()
  for (const item of decorated) {
    if (!matches(item) && !groupHit(item.group.key)) continue
    const existing = byKey.get(item.group.key)
    if (existing) existing.list.push(item.session)
    else
      byKey.set(item.group.key, {
        key: item.group.key,
        slot: item.group.slot,
        label: item.group.label,
        projectId: item.group.projectId,
        cwd: item.group.cwd,
        current: false,
        list: [item.session]
      })
  }

  const groups = [...byKey.values()]
  for (const group of groups) {
    group.list.sort((a, b) => activityOf(b) - activityOf(a))
    group.current =
      (!!group.projectId && group.projectId === currentProjectId) ||
      (!currentProjectId && !!currentCwd && group.cwd.toLowerCase() === currentCwd.toLowerCase())
  }
  groups.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    const at = a.list[0] ? activityOf(a.list[0]) : 0
    const bt = b.list[0] ? activityOf(b.list[0]) : 0
    return bt - at
  })
  if (!options.pinnedLabel) return groups
  const pinned: SessionSummary[] = []
  for (const group of groups) {
    group.list = group.list.filter((session) => {
      if (!session.pinned) return true
      pinned.push(session)
      return false
    })
  }
  const rest = groups.filter((group) => group.list.length > 0)
  if (!pinned.length) return rest
  pinned.sort((a, b) => activityOf(b) - activityOf(a))
  return [{ key: 'pinned', slot: 'pinned', label: options.pinnedLabel, cwd: '', current: false, list: pinned }, ...rest]
}

export const GROUP_PAGE_SIZE = 20

export interface SidebarGroupPage {
  rows: SessionSummary[]
  hidden: number
  revealable: number
  expanded: boolean
}

export function groupPage(
  list: readonly SessionSummary[],
  revealed = 0,
  keep?: SessionSummary | null
): SidebarGroupPage {
  const limit = GROUP_PAGE_SIZE + Math.max(0, revealed)
  const expanded = list.length <= limit
  const rows = expanded ? [...list] : list.slice(0, limit)
  if (keep && !rows.includes(keep)) rows.push(keep)
  const hidden = expanded ? 0 : list.length - limit
  return { rows, hidden, revealable: Math.min(GROUP_PAGE_SIZE, hidden), expanded }
}

export interface ArchivedProject {
  record: ProjectRecord
  label: string
  sessionCount: number
}

export interface ArchivedView {
  projects: ArchivedProject[]
  sessions: SessionSummary[]
}

export function buildArchivedView(options: {
  sessions: readonly SessionSummary[]
  projects: readonly ProjectRecord[]
  projectNames: Record<string, string>
  titles: Record<string, string>
  manualTitles: Record<string, string>
  query: string
}): ArchivedView {
  const query = options.query.trim().toLowerCase()
  const archivedProjects = options.projects.filter((project) => project.archived)
  const idCounts = new Map<string, number>()
  const cwdCounts = new Map<string, number>()
  for (const session of options.sessions) {
    if (session.archivedAt) continue
    if (session.projectId) idCounts.set(session.projectId, (idCounts.get(session.projectId) ?? 0) + 1)
    else if (session.cwd) {
      const key = session.cwd.toLowerCase()
      cwdCounts.set(key, (cwdCounts.get(key) ?? 0) + 1)
    }
  }
  const labelOf = (record: ProjectRecord): string => record.name || options.projectNames[record.cwd] || shortProject(record.cwd)
  const titleOf = (session: SessionSummary): string =>
    options.manualTitles[session.id] ?? options.titles[session.id] ?? session.title

  const projects = archivedProjects
    .map((record) => ({
      record,
      label: labelOf(record),
      sessionCount: (idCounts.get(record.id) ?? 0) + (cwdCounts.get(record.cwd.toLowerCase()) ?? 0)
    }))
    .filter((item) => !query || item.label.toLowerCase().includes(query) || item.record.cwd.toLowerCase().includes(query))
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt)

  const sessions = options.sessions
    .filter((session) => !!session.archivedAt)
    .filter((session) => {
      if (!query) return true
      return [titleOf(session), session.cwd, session.path].some((value) => value.toLowerCase().includes(query))
    })
    .sort((a, b) => activityOf(b) - activityOf(a))
  return { projects, sessions }
}
