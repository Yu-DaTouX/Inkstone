import { useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { Globe } from 'lucide-react'
import { useStore } from '../../../state/store'
import { Avatar, Button, Card, ShimmerText, Skeleton } from '../../../ui'
import type { UIToolCall, WebSearchSourceView } from '../../../../../shared/ipc'
import { Icon } from '../Icon'
import { useCitationIndex } from './citations'
import { citationFor, domainOf, searchStepLabel, siteLabel, siteTone, type SearchStep } from './model'
import { useSearchOp } from './op-store'
import { useWebSearchText } from './text'
import './web-search.css'

const MAX_SITES = 3

function pageSource(state: ReturnType<typeof useSearchOp>): WebSearchSourceView[] {
  if (state.status !== 'ready' || !state.view.ok) return []
  if (state.view.kind === 'fetch') {
    const page = state.view.page
    return [{ title: page.title, url: page.url, domain: page.domain, snippet: page.excerpt, source: '' }]
  }
  return state.view.sources
}

function uniqueSites(sources: readonly WebSearchSourceView[]): { site: string; seed: string }[] {
  const out: { site: string; seed: string }[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const domain = source.domain || domainOf(source.url)
    const site = siteLabel(domain) || domain
    if (!site || seen.has(site)) continue
    seen.add(site)
    out.push({ site, seed: domain || site })
    if (out.length >= MAX_SITES) break
  }
  return out
}

export function SearchStepView({ call, step, children, glow = true }: { call: UIToolCall; step: SearchStep; children: ReactNode; glow?: boolean }): JSX.Element {
  const tt = useWebSearchText()
  const openLink = useStore((s) => s.openLink)
  const turnIndex = useCitationIndex()
  const [open, setOpen] = useState(step.command.action === 'query')
  const [showAll, setShowAll] = useState(false)
  const running = call.status === 'running' || call.status === 'pending'
  const fromDetails = step.sources !== undefined
  const state = useSearchOp(running || fromDetails ? null : step.operationId)
  const sources = useMemo(() => (running ? [] : fromDetails ? step.sources ?? [] : pageSource(state)), [running, fromDetails, step, state])
  const sites = useMemo(() => uniqueSites(sources), [sources])
  const fetching = step.command.action === 'fetch'
  const settled = !running && (fromDetails || !!step.fromTool || state.status === 'ready')
  const label = settled
    ? fetching ? tt('fetched') : sources.length ? tt('searched', { n: sources.length }) : tt('searchedAny')
    : fetching ? tt('fetching') : tt('searching')

  if (!running && !step.fromTool) {
    if (!step.operationId) return <>{children}</>
    if (state.status === 'ready' && !state.view.ok) return <>{children}</>
  }

  const expanded = open && settled
  const pending = open && !settled && !fetching
  const folded = !showAll && sources.length > SOURCE_PREVIEW + 1

  return (
    <>
      <button
        type="button"
        className="ws-cap"
        aria-expanded={expanded}
        aria-label={`${label} ${searchStepLabel(step.command)}`.trim()}
        title={`${label} ${searchStepLabel(step.command)}`.trim()}
        onClick={() => {
          setOpen((value) => !value)
          setShowAll(false)
        }}
        data-testid="ws-capsule"
        data-state={running ? 'running' : 'done'}
      >
        <span className="ws-cap-icon" data-done={running ? undefined : true} aria-hidden="true">
          <Globe size={13} strokeWidth={1.75} />
          <svg className="ws-ring" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="ws-ring-track" cx="12" cy="12" r="10" />
            {running ? <circle className="ws-ring-arc" cx="12" cy="12" r="10" /> : null}
          </svg>
        </span>
        <span className="ws-cap-label">
          {settled ? label : <ShimmerText active={glow}>{label}</ShimmerText>}
        </span>
        <span className="ws-cap-target" title={searchStepLabel(step.command)}>{searchStepLabel(step.command)}</span>
        {sites.length ? (
          <span className="ws-cap-sites" aria-hidden="true">
            {sites.map((site) => <Avatar key={site.site} name={site.site} className={`ws-site ws-tone-${siteTone(site.seed)}`} />)}
          </span>
        ) : null}
        <Icon name="chevron-right" size={14} className="v3-chev" />
      </button>
      {expanded ? (
        <div className="ws-op" role="group" aria-label={tt('sources')} data-testid="ws-sources">
          {sources.length ? (
            <>
              {(folded ? sources.slice(0, SOURCE_PREVIEW) : sources).map((source, i) => (
                <SourceCard
                  key={`${source.url}#${i}`}
                  source={source}
                  index={i < SOURCE_PREVIEW ? i : i - SOURCE_PREVIEW}
                  n={citationFor(turnIndex, source.url)?.n ?? i + 1}
                  onOpen={() => void openLink(source.url)}
                />
              ))}
              {folded ? <MoreSourcesCard rest={sources.slice(SOURCE_PREVIEW)} onPress={() => setShowAll(true)} /> : null}
              {showAll && sources.length > SOURCE_PREVIEW + 1 ? (
                <Button variant="plain" size="sm" className="ws-less" onPress={() => setShowAll(false)}>
                  <Icon name="chevron-up" size={14} />
                  {tt('showLess')}
                </Button>
              ) : null}
            </>
          ) : (
            <div className="ws-empty">{tt('empty')}</div>
          )}
        </div>
      ) : pending ? (
        <div className="ws-op" aria-hidden="true" data-testid="ws-sources-pending">
          {Array.from({ length: SOURCE_PREVIEW }, (_, i) => <PendingCard key={i} index={i} />)}
        </div>
      ) : null}
    </>
  )
}

const SOURCE_PREVIEW = 3

function PendingCard({ index }: { index: number }): JSX.Element {
  return (
    <Card padding="sm" quiet className="ws-source ws-source-pending" style={{ '--ws-i': index } as CSSProperties}>
      <span className="ws-source-pending-title">
        <Skeleton width="92%" />
        <Skeleton width="64%" />
      </span>
      <span className="ws-source-meta">
        <Skeleton shape="circle" width={15} height={15} />
        <Skeleton width="48%" />
      </span>
    </Card>
  )
}

function MoreSourcesCard({ rest, onPress }: { rest: WebSearchSourceView[]; onPress: () => void }): JSX.Element {
  const tt = useWebSearchText()
  const sites = uniqueSites(rest).slice(0, 3)
  return (
    <Card padding="sm" className="ws-source ws-more" interactive quiet style={{ '--ws-i': SOURCE_PREVIEW } as CSSProperties}>
      <button type="button" className="ws-source-main" onClick={onPress} data-testid="ws-more">
        <span className="ws-cap-sites ws-more-sites" aria-hidden="true">
          {sites.map((site) => <Avatar key={site.site} name={site.site} className={`ws-site ws-tone-${siteTone(site.seed)}`} />)}
        </span>
        <span className="ws-more-label">{tt('moreSources', { n: rest.length })}</span>
      </button>
    </Card>
  )
}

function SourceCard({ source, n, index, onOpen }: { source: WebSearchSourceView; n: number; index: number; onOpen: () => void }): JSX.Element {
  const tt = useWebSearchText()
  const domain = source.domain || domainOf(source.url)
  const site = siteLabel(domain) || domain
  const hint = [source.title, domain, source.snippet].filter(Boolean).join('\n')
  return (
    <Card padding="sm" className="ws-source" interactive style={{ '--ws-i': index } as CSSProperties}>
      <a
        className="ws-source-main"
        href={source.url}
        aria-label={tt('openSource', { title: source.title })}
        title={hint}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpen()
        }}
        onAuxClick={(event) => event.preventDefault()}
      >
        <span className="ws-source-title">{source.title}</span>
        <span className="ws-source-meta">
          <Avatar name={site} className={`ws-site ws-tone-${siteTone(domain || site)}`} />
          <span className="ws-source-domain">{site}</span>
          <span className="ws-source-n" aria-hidden>{n}</span>
        </span>
      </a>
    </Card>
  )
}
