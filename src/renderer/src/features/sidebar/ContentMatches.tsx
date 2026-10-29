import { useEffect, useState, type ReactElement } from 'react'
import type { SessionSearchHit } from '../../../../shared/ipc'
import { EmptyState, ListRow, Spinner } from '../../ui'
import { CONTENT_SEARCH_LIMIT, focusSnippet, shouldSearchContent, splitSnippet, type ContentMatch } from './content-search'
import type { SidebarText } from './sidebar-text'

export type ContentSearchState =
  | { status: 'idle'; hits: readonly SessionSearchHit[] }
  | { status: 'searching'; hits: readonly SessionSearchHit[] }
  | { status: 'done'; hits: readonly SessionSearchHit[] }
  | { status: 'failed'; hits: readonly SessionSearchHit[] }

const IDLE: ContentSearchState = { status: 'idle', hits: [] }
const DEBOUNCE_MS = 300

export function useContentSearch(query: string, enabled: boolean): ContentSearchState {
  const [state, setState] = useState<ContentSearchState>(IDLE)
  const trimmed = query.trim()
  const active = enabled && shouldSearchContent(trimmed)

  useEffect(() => {
    if (!active) {
      setState(IDLE)
      return undefined
    }
    let alive = true
    setState((prev) => ({ status: 'searching', hits: prev.hits }))
    const id = window.setTimeout(() => {
      window.yan
        .searchSessions(trimmed, CONTENT_SEARCH_LIMIT * 2)
        .then((result) => {
          if (alive) setState({ status: 'done', hits: result.hits })
        })
        .catch(() => {
          if (alive) setState({ status: 'failed', hits: [] })
        })
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [trimmed, active])

  return state
}

interface Props {
  query: string
  state: ContentSearchState
  matches: readonly ContentMatch[]
  currentPath: string | undefined
  text: SidebarText
  onOpen: (match: ContentMatch) => void
}

export function ContentMatches({ query, state, matches, currentPath, text, onOpen }: Props): ReactElement | null {
  if (state.status === 'idle') return null
  if (state.status === 'done' && matches.length === 0) return null
  return (
    <div className="v3-group v3-content" data-testid="v3-content-matches" aria-busy={state.status === 'searching'}>
      <div className="v3-grp">
        <span className="v3-grp-label">{text.contentMatches}</span>
      </div>
      {state.status === 'failed' ? (
        <EmptyState size="sm" role="status" title={text.contentFailed} />
      ) : null}
      {state.status === 'searching' && matches.length === 0 ? (
        <EmptyState size="sm" role="status" icon={<Spinner size="sm" />} title={text.contentSearching} />
      ) : null}
      {matches.map((match) => (
        <ListRow
          key={match.path}
          className="v3-hit"
          current={currentPath === match.path}
          onClick={() => onOpen(match)}
          data-testid="v3-content-match"
        >
          <span className="v3-hit-body">
            <span className="v3-hit-head">
              <span className="v3-hit-title">{match.title}</span>
              {match.archived ? <span className="v3-hit-tag">{text.contentArchived}</span> : null}
            </span>
            <span className="v3-hit-snippet">
              {splitSnippet(focusSnippet(match.snippet, query), query).map((part, index) =>
                part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
              )}
            </span>
          </span>
        </ListRow>
      ))}
    </div>
  )
}
