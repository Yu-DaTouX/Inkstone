import { useMemo } from 'react'
import { useStore } from '../../../state/store'
import { toProjectView, type SidebarProjectView } from './types'

export interface SidebarProjectCollection {
  byKey: Map<string, SidebarProjectView>
  byId: Map<string, SidebarProjectView>
  list: SidebarProjectView[]
}

export function useSidebarProjects(): SidebarProjectCollection {
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  return useMemo(() => {
    const list = (projects ?? []).map((record) => toProjectView(record, projectNames ?? {}))
    return {
      byKey: new Map(list.map((project) => [project.projectKey, project])),
      byId: new Map(list.map((project) => [project.projectId, project])),
      list
    }
  }, [projects, projectNames])
}

export function useSidebarProject(projectId: string | null): SidebarProjectView | null {
  const projects = useSidebarProjects()
  return projectId ? (projects.byId.get(projectId) ?? null) : null
}
