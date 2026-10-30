import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../../state/store'
import { buildContentMatches, CONTENT_SEARCH_LIMIT, shouldSearchContent, type ContentMatch } from '../../../features/sidebar/content-search'
import type { SessionSearchHit } from '../../../../../shared/ipc'
import type { SidebarThreadView } from './types'
import { useSidebarSections } from './threads'

const DEBOUNCE_MS = 160

export interface SidebarSearch {
  threads: SidebarThreadView[]
  matches: ContentMatch[]
  pending: boolean
}

function matchesThread(view: SidebarThreadView, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return false
  return [view.title, view.path, view.projectDisplayName ?? ''].some((value) => value.toLowerCase().includes(needle))
}

export function useSidebarSearch(query: string): SidebarSearch {
  const sections = useSidebarSections()
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [pending, setPending] = useState(false)
  const trimmed = query.trim()

  useEffect(() => {
    if (!shouldSearchContent(trimmed)) {
      setHits([])
      setPending(false)
      return undefined
    }
    let alive = true
    setPending(true)
    const id = window.setTimeout(() => {
      window.yan
        .searchSessions(trimmed, CONTENT_SEARCH_LIMIT * 2)
        .then((result) => {
          if (!alive) return
          setHits(result.hits)
          setPending(false)
        })
        .catch(() => {
          if (!alive) return
          setHits([])
          setPending(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [trimmed])

  const all = useMemo(
    () => [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled],
    [sections]
  )
  const threads = useMemo(() => all.filter((view) => matchesThread(view, trimmed)), [all, trimmed])
  const matches = useMemo(
    () =>
      buildContentMatches({
        hits,
        sessions,
        shownPaths: threads.map((view) => view.path),
        titleOf: (item) => manualTitles[item.id] ?? titles[item.id] ?? item.title,
        fallbackTitle: (updatedAt) => new Date(updatedAt).toLocaleString()
      }),
    [hits, sessions, threads, manualTitles, titles]
  )
  return { threads, matches, pending }
}
