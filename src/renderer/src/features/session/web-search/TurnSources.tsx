import { useState, type JSX } from 'react'
import { useTurnSources } from './citations'
import { SourceList } from './SearchStep'
import { useWebSearchText } from './text'

export function TurnSources(): JSX.Element | null {
  const tt = useWebSearchText()
  const sources = useTurnSources()
  const [showAll, setShowAll] = useState(false)
  if (!sources.length) return null
  return (
    <section className="ws-turn-sources" aria-label={tt('sources')} data-testid="ws-turn-sources">
      <span className="ws-turn-sources-head">{tt('sources')} · {sources.length}</span>
      <SourceList sources={sources} showAll={showAll} onShowAll={setShowAll} testId="ws-turn-source-list" />
    </section>
  )
}
