import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react'
import { useStore } from '../../../state/store'
import { Focusable } from 'react-aria-components'
import { Tooltip, TooltipTrigger } from '../../../ui'
import type { UIToolCall, WebSearchSourceView } from '../../../../../shared/ipc'
import { buildCitationIndex, citationFor, collectSearchDetailSources, collectSearchOperationIds, normalizeUrl, siteTone, type CitationRef } from './model'
import { useSearchOps, type SearchOpState } from './op-store'
import { useWebSearchText } from './text'

const CitationIndex = createContext<Map<string, CitationRef> | null>(null)

export function useCitationIndex(): Map<string, CitationRef> | null {
  return useContext(CitationIndex)
}

export function useCitation(href: string | undefined): CitationRef | null {
  const index = useContext(CitationIndex)
  return citationFor(index, href)
}

function sourcesOf(states: readonly SearchOpState[]): WebSearchSourceView[] {
  const out: WebSearchSourceView[] = []
  for (const state of states) {
    if (state.status !== 'ready' || !state.view.ok) continue
    if (state.view.kind === 'search') {
      out.push(...state.view.sources)
      continue
    }
    const page = state.view.page
    out.push({ title: page.title, url: page.url, domain: page.domain, snippet: page.excerpt, source: '' })
  }
  return out
}

export function WebSearchTurnProvider({ tools, children }: { tools: readonly UIToolCall[]; children: ReactNode }): JSX.Element {
  const operationIds = useMemo(() => collectSearchOperationIds(tools), [tools])
  const detailSources = useMemo(() => collectSearchDetailSources(tools), [tools])
  const states = useSearchOps(operationIds)
  const sources = useMemo(() => uniqueSources([...sourcesOf(states), ...detailSources]), [states, detailSources])
  const index = useMemo(() => (sources.length ? buildCitationIndex(sources) : null), [sources])
  return (
    <CitationIndex.Provider value={index}>
      <TurnSourceList.Provider value={sources}>{children}</TurnSourceList.Provider>
    </CitationIndex.Provider>
  )
}

const TurnSourceList = createContext<readonly WebSearchSourceView[]>([])

export function useTurnSources(): readonly WebSearchSourceView[] {
  return useContext(TurnSourceList)
}

function uniqueSources(sources: readonly WebSearchSourceView[]): WebSearchSourceView[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = normalizeUrl(source.url)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function CitationLink({ citation }: { citation: CitationRef }): JSX.Element {
  const tt = useWebSearchText()
  const openLink = useStore((s) => s.openLink)
  const site = citation.site || citation.domain
  const tone = siteTone(citation.domain || site || citation.title)
  return (
    <TooltipTrigger>
      <Focusable>
      <a
        className={`ws-cite ws-tone-${tone}`}
        href={citation.url}
        aria-label={tt('citationAria', { site, n: citation.n })}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void openLink(citation.url)
        }}
        onDoubleClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void window.yan.browser.openExternal(citation.url)
        }}
        onAuxClick={(event) => event.preventDefault()}
      >
        <span className="ws-cite-site">{site}</span>
        <span className="ws-cite-n" aria-hidden>{citation.n}</span>
      </a>
      </Focusable>
      <Tooltip className="ws-cite-tip" variant="card" placement="top" offset={6}>
        <span className="ws-cite-card">
          <span className="ws-cite-card-title">{citation.title}</span>
          <span className="ws-cite-card-domain">{citation.domain}</span>
          {citation.snippet ? <span className="ws-cite-card-snippet">{citation.snippet}</span> : null}
          <span className="ws-cite-card-open">{tt('citationOpenHint')}</span>
        </span>
      </Tooltip>
    </TooltipTrigger>
  )
}
