import { useEffect, useMemo, useState } from 'react'
import { useRunsV3 } from '../../../state/runs-v3'
import { useStore } from '../../../state/store'
import { sessionActivityAt } from '../../../features/sidebar/sidebar-model'
import { scopedKeyOf, type SidebarThreadView, type ThreadRef } from './types'
import { buildSidebarSections, type SidebarSections } from './sections'

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export function useSidebarSections(): SidebarSections {
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const runs = useRunsV3((s) => s.runs)
  const now = useMinuteClock()
  return useMemo(
    () =>
      buildSidebarSections({
        sessions,
        runs,
        projects: projects ?? [],
        projectNames: projectNames ?? {},
        titles,
        manualTitles,
        now
      }),
    [sessions, runs, projects, projectNames, titles, manualTitles, now]
  )
}

export function useThreadView(ref: ThreadRef): SidebarThreadView | null {
  const session = useStore((s) => s.sessions.find((item) => item.id === ref.threadId) ?? null)
  const title = useStore((s) => (session ? (s.manualTitles[session.id] ?? s.titles[session.id] ?? session.title) : ''))
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const now = useMinuteClock()
  return useMemo(() => {
    if (!session) return null
    const sections = buildSidebarSections({
      sessions: [session],
      runs: useRunsV3.getState().runs,
      projects: projects ?? [],
      projectNames: projectNames ?? {},
      titles: {},
      manualTitles: {},
      now
    })
    const view = [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled][0]
    return view ? { ...view, title } : null
  }, [session, projects, projectNames, now, title])
}

export function useActiveThreadKey(): string | null {
  const sessionId = useStore((s) => s.session?.sessionId)
  return sessionId ? scopedKeyOf(sessionId) : null
}

export function useThreadsActivitySignature(): string {
  const sessions = useStore((s) => s.sessions)
  return useMemo(
    () => sessions.map((session) => `${session.id}:${sessionActivityAt(session)}:${session.archivedAt ?? ''}:${session.pinned ? 1 : 0}:${session.snoozedUntil ?? ''}`).join('|'),
    [sessions]
  )
}
