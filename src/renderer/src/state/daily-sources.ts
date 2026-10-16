import { useEffect, useRef, useState } from 'react'
import type { SourceLinkView, SourceRefView } from '../../../shared/ipc'
import { listSourceFiles } from './source-files'

interface WebLink {
  id: string
  sessionId: string
  url: string
  title: string
  addedAt: number
}

const WEB_KEY = 'yan.source-links.v1'

function loadJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export interface SessionSourcesState {
  loading: boolean
  error: boolean
  images: SourceRefView[]
  files: SourceRefView[]
  webs: SourceRefView[]
  links: SourceLinkView[]
  all: SourceRefView[]
}

const EMPTY: SessionSourcesState = {
  loading: false,
  error: false,
  images: [],
  files: [],
  webs: [],
  links: [],
  all: []
}

export function useSessionSources(sessionId: string | undefined): SessionSourcesState {
  const [state, setState] = useState<SessionSourcesState>({ ...EMPTY, loading: Boolean(sessionId) })
  const gate = useRef(0)

  useEffect(() => {
    if (!sessionId) {
      ++gate.current
      setState(EMPTY)
      return
    }
    const mine = ++gate.current
    setState((s) => ({ ...s, loading: true, error: false }))
    void (async () => {
      let images: SourceRefView[] = []
      let files: SourceRefView[] = []
      let links: SourceLinkView[] = []
      let failed = false

      try {
        const listed = await window.yan.sources.list(sessionId)
        if (gate.current !== mine) return
        images = listed.images ?? []
        links = listed.links ?? []
      } catch {
        failed = true
      }

      const refs = listSourceFiles(sessionId)
      try {
        const verified = await window.yan.sources.verifyFiles({ sessionId, entries: refs })
        if (gate.current !== mine) return
        files = verified
      } catch {
        failed = true
      }

      const webs: SourceRefView[] = loadJson<WebLink>(WEB_KEY)
        .filter((x) => x.sessionId === sessionId)
        .map((l) => ({
          sourceId: `web:${l.id}`,
          sessionId,
          kind: 'web' as const,
          title: l.title || l.url,
          ref: l.url,
          fingerprint: l.url,
          origin: l.url,
          addedAt: l.addedAt,
          available: true
        }))

      if (gate.current !== mine) return
      const all = [...images, ...files, ...webs].sort((a, b) => b.addedAt - a.addedAt)
      setState({ loading: false, error: failed, images, files, webs, links, all })
    })()
  }, [sessionId])

  return state
}
