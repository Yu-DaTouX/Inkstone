import { useMemo } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { SessionSummary } from '../../../../shared/ipc'
import { rankOf } from '../../../../shared/rail-order'
import { compareBy, type RailSortBy } from '../../../../shared/rail-view'
import { ancestorPaths } from './sidebar-state'
import { shortProject } from './rail-utils'
import { shouldIncludeSyntheticCurrent } from '../toolbar/workspace-control-guards'

export function useRailProjects({ query, showArchived, sortBy, showArchivedSessions }: { query: string; showArchived: boolean; sortBy: RailSortBy; showArchivedSessions: boolean }) {
  const t = useT()
  const allSessions = useStore((s) => s.sessions)
  const sessions = useMemo(() => allSessions.filter((s) => showArchivedSessions === !!s.archivedAt), [allSessions, showArchivedSessions])
  const session = useStore((s) => s.session)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const settings = useStore((s) => s.settings)
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const projectNames = settings?.projectNames ?? EMPTY_PROJECT_NAMES
  const projectRecords = settings?.projects ?? EMPTY_RECORDS
  const projectGroups = settings?.projectGroups ?? EMPTY_GROUPS
  const projectOrder = settings?.projectOrder ?? EMPTY_IDS

  const projects = useMemo(() => {
    const q = query.trim().toLowerCase()
    const activity = (s: SessionSummary): number => s.lastActivityAt ?? s.updatedAt
    const recordsById = new Map(projectRecords.map((project) => [project.id, project]))
    const activeProjectId = runners.find((runner) => runner.id === activeRunnerId)?.projectId
    const currentSummary = sessions.find((item) => item.id === session?.sessionId || item.path === session?.sessionFile)
    const currentProjectId = activeProjectId ?? currentSummary?.projectId

    const orderFamily = (list: SessionSummary[]): SessionSummary[] => {
      const inList = new Set(list.map((s) => s.path))
      const children = new Map<string, SessionSummary[]>()
      for (const s of list) {
        if (!s.parentSession || !inList.has(s.parentSession)) continue
        const arr = children.get(s.parentSession) ?? []
        arr.push(s)
        children.set(s.parentSession, arr)
      }
      for (const arr of children.values()) arr.sort((a, b) => a.createdAt - b.createdAt)

      const roots = list.filter((s) => !s.parentSession || !inList.has(s.parentSession))
      roots.sort(compareBy(sortBy))
      const out: SessionSummary[] = []
      const seen = new Set<string>()
      const push = (s: SessionSummary): void => {
        if (seen.has(s.path)) return
        seen.add(s.path)
        out.push(s)
        for (const c of children.get(s.path) ?? []) push(c)
      }
      for (const r of roots) push(r)
      for (const s of list) push(s)
      return out
    }

    const currentPath = session?.sessionFile
    const synthetic: SessionSummary[] = currentPath && shouldIncludeSyntheticCurrent(showArchivedSessions, currentPath) && !sessions.some((x) => x.path === currentPath)
      ? [{
          id: session?.sessionId ?? 'current',
          path: currentPath,
          cwd: session?.cwd ?? '',
          title: session?.sessionName ?? t('rail.untitled'),
          named: !!session?.sessionName,
          ...(currentProjectId ? { projectId: currentProjectId, scope: 'project' as const } : { scope: 'global' as const }),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0
        }]
      : []

    const all = [...synthetic, ...sessions].map((x) => {
      const manual = manualTitles[x.id]
      if (manual) return { ...x, title: manual, named: true }
      const generated = titles[x.id]
      return generated ? { ...x, title: generated } : x
    })
    const parents = new Map(all.filter((s) => s.parentSession).map((s) => [s.path, s.parentSession!]))
    const projectFor = (s: SessionSummary): {
      id: string
      cwd: string
      label: string
      projectId?: string
    } => {
      const record = s.projectId ? recordsById.get(s.projectId) : undefined
      if (record) {
        return {
          id: `project:${record.id}`,
          projectId: record.id,
          cwd: record.cwd,
          label: record.name || projectNames[record.cwd] || shortProject(record.cwd)
        }
      }
      const cwd = s.cwd || '—'
      return {
        id: `global:${cwd}`,
        cwd,
        label: cwd === '—' ? t('rail.local') : shortProject(cwd)
      }
    }

    const matches = new Set<string>()
    for (const s of all) {
      const project = projectFor(s)
      if (!q || [s.title, s.cwd, project.label, projectNames[s.cwd] ?? ''].some((v) => v.toLowerCase().includes(q))) {
        matches.add(s.path)
        for (const p of ancestorPaths(s.path, parents)) matches.add(p)
      }
    }
    const filtered = all.filter((s) => matches.has(s.path))
    const byProject = new Map<string, { id: string; cwd: string; label: string; projectId?: string; list: SessionSummary[] }>()
    const addProject = (project: ReturnType<typeof projectFor>, list: SessionSummary[] = []): void => {
      const previous = byProject.get(project.id)
      if (previous) previous.list.push(...list)
      else byProject.set(project.id, { ...project, list: [...list] })
    }

    const sameCwd = (a: string, b?: string): boolean => !!b && a.toLowerCase() === b.toLowerCase()
    for (const record of projectRecords) {
      const label = record.name || projectNames[record.cwd] || shortProject(record.cwd)
      const isCurrent = record.id === currentProjectId || sameCwd(record.cwd, session?.cwd)
      if (isCurrent && (!q || label.toLowerCase().includes(q) || record.cwd.toLowerCase().includes(q))) {
        addProject({ id: `project:${record.id}`, projectId: record.id, cwd: record.cwd, label })
      }
    }
    for (const s of filtered) addProject(projectFor(s), [s])

    for (const cwd of settings?.recentCwds ?? []) {
      const alreadyShown = [...byProject.values()].some((project) => project.cwd.toLowerCase() === cwd.toLowerCase())
      if (!alreadyShown && sameCwd(cwd, session?.cwd) && (!q || (projectNames[cwd] || cwd).toLowerCase().includes(q))) {
        addProject({ id: `global:${cwd}`, cwd, label: shortProject(cwd) })
      }
    }

    const cur = session?.cwd
    const rank = rankOf(projectOrder)
    return [...byProject.values()]
      .map((project) => ({
        ...project,
        list: orderFamily(project.list),
        isCurrent: project.projectId ? project.projectId === currentProjectId : !currentProjectId && project.cwd === cur
      }))
      .filter((project) => showArchived === !!(project.projectId && recordsById.get(project.projectId)?.archived))
      .filter((project) => !showArchivedSessions || project.list.length > 0)
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        const ar = a.projectId ? rank.get(a.projectId) : undefined
        const br = b.projectId ? rank.get(b.projectId) : undefined
        if (ar !== undefined || br !== undefined) {
          if (ar === undefined) return 1
          if (br === undefined) return -1
          if (ar !== br) return ar - br
        }
        const at = (p: { list: SessionSummary[] }) => p.list[0] ? activity(p.list[0]) : 0
        return at(b) - at(a)
      })
  }, [sessions, query, session, t, titles, manualTitles, projectNames, projectRecords, projectOrder, settings?.recentCwds, showArchived, showArchivedSessions, runners, activeRunnerId, sortBy])

  const displayProjects = useMemo(() => {
    const groupIdFor = (project: (typeof projects)[number]): string | undefined =>
      project.projectId ? projectRecords.find((record) => record.id === project.projectId)?.groupId : undefined
    const byGroup = new Map<string, typeof projects>()
    for (const project of projects) {
      const key = groupIdFor(project) ?? ''
      const list = byGroup.get(key) ?? []
      list.push(project)
      byGroup.set(key, list)
    }
    const ordered: typeof projects = []
    for (const group of projectGroups) ordered.push(...(byGroup.get(group.id) ?? []))
    ordered.push(...(byGroup.get('') ?? []))
    return ordered
  }, [projects, projectRecords, projectGroups])

  return { projects, displayProjects }
}

const EMPTY_PROJECT_NAMES: Record<string, string> = {}
const EMPTY_IDS: string[] = []
const EMPTY_RECORDS: NonNullable<ReturnType<typeof useStore.getState>['settings']>['projects'] = []
const EMPTY_GROUPS: NonNullable<ReturnType<typeof useStore.getState>['settings']>['projectGroups'] = []
