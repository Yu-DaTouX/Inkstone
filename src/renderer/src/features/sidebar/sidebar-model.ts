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
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

export function shortProject(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function activityOf(session: SessionSummary): number {
  return session.lastActivityAt ?? session.updatedAt
}

export function latestRunForSession(
  runs: readonly RunSnapshot[],
  session: { id?: string; path?: string }
): RunSnapshot | null {
  let found: RunSnapshot | null = null
  for (const run of runs) {
    const matches =
      (!!session.id && run.sessionId === session.id) || (!!session.path && run.sessionPath === session.path)
    if (!matches) continue
    if (!found || run.startedAt > found.startedAt) found = run
  }
  return found
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

  const labelFor = (session: SessionSummary): { key: string; slot: string; label: string; projectId?: string; cwd: string } => {
    const record =
      (session.projectId ? recordById.get(session.projectId) : undefined) ??
      (session.cwd ? projects.find((project) => sameCwd(project.cwd, session.cwd)) : undefined)
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
  const groupHit = (key: string): boolean => {
    if (!query) return false
    const sample = decorated.find((item) => item.group.key === key)
    return sample ? sample.group.label.toLowerCase().includes(query) : false
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
  const labelOf = (record: ProjectRecord): string => record.name || options.projectNames[record.cwd] || shortProject(record.cwd)
  const titleOf = (session: SessionSummary): string =>
    options.manualTitles[session.id] ?? options.titles[session.id] ?? session.title

  const projects = archivedProjects
    .map((record) => ({
      record,
      label: labelOf(record),
      sessionCount: options.sessions.filter(
        (session) =>
          !session.archivedAt &&
          (session.projectId ? session.projectId === record.id : !!session.cwd && session.cwd.toLowerCase() === record.cwd.toLowerCase())
      ).length
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
