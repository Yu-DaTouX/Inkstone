import { currentLang } from '../../../i18n/lang'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../../state/store'
import { buildContentMatches, CONTENT_SEARCH_LIMIT, shouldSearchContent, type ContentMatch } from '../../../features/sidebar/content-search'
import type { SessionSearchHit } from '../../../../../shared/ipc'
import type { SidebarThreadView } from './types'
import type { SidebarSections } from './sections'

const DEBOUNCE_MS = 160

export interface SidebarSearch {
  threads: SidebarThreadView[]
  matches: ContentMatch[]
  pending: boolean
  failed: boolean
}

const EMPTY_HITS: SessionSearchHit[] = []
type SearchResult = { query: string; hits: SessionSearchHit[]; failed: boolean }

function matchesThread(view: SidebarThreadView, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return false
  return [view.title, view.path, view.projectDisplayName ?? ''].some((value) => value.toLowerCase().includes(needle))
}

export function useSidebarSearch(query: string, sections: SidebarSections): SidebarSearch {
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const [result, setResult] = useState<SearchResult | null>(null)
  const trimmed = query.trim()
  const searchable = shouldSearchContent(trimmed)
  const current = searchable && result?.query === trimmed ? result : null
  const hits = current?.hits ?? EMPTY_HITS

  useEffect(() => {
    setResult(null)
    if (!searchable) return undefined
    let alive = true
    const id = window.setTimeout(() => {
      window.yan
        .searchSessions(trimmed, CONTENT_SEARCH_LIMIT * 2)
        .then((result) => {
          if (!alive) return
          setResult({ query: trimmed, hits: result.hits, failed: false })
        })
        .catch(() => {
          if (!alive) return
          setResult({ query: trimmed, hits: EMPTY_HITS, failed: true })
        })
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [trimmed, searchable])

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
        fallbackTitle: (updatedAt) => new Date(updatedAt).toLocaleString(currentLang())
      }),
    [hits, sessions, threads, manualTitles, titles]
  )
  return { threads, matches, pending: searchable && !current, failed: current?.failed ?? false }
}
