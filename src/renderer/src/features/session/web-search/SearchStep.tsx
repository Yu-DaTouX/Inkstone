import { useId, useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowUpRight, Globe } from 'lucide-react'
import { useStore } from '../../../state/store'
import { Button, Card, ShimmerText, Skeleton, SourceCard as SourceCardFrame } from '../../../ui'
import type { UIToolCall, WebSearchSourceView } from '../../../../../shared/ipc'
import { Icon } from '../Icon'
import { useCitationIndex } from './citations'
import { citationFor, domainOf, isBlockedPage, searchStepLabel, siteLabel, type SearchStep } from './model'
import { useSearchOp } from './op-store'
import { useWebSearchText } from './text'
import { WebsiteIcon } from './WebsiteIcon'
import './web-search.css'

const MAX_SITES = 3
const PENDING_CARDS = 4

function pageSource(state: ReturnType<typeof useSearchOp>): WebSearchSourceView[] {
  if (state.status !== 'ready' || !state.view.ok) return []
  if (state.view.kind === 'fetch') {
    const page = state.view.page
    return [{ title: page.title, url: page.url, domain: page.domain, snippet: page.excerpt, source: '', fetchedAt: page.fetchedAt, cached: page.cached, readState: page.truncated || page.sourceTruncated ? 'partial' : 'read' }]
  }
  return state.view.sources
}

function uniqueSites(sources: readonly WebSearchSourceView[]): { site: string; url: string }[] {
  const out: { site: string; url: string }[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const domain = source.domain || domainOf(source.url)
    const site = siteLabel(domain) || domain
    if (!site || seen.has(domain)) continue
    seen.add(domain)
    out.push({ site, url: source.url })
    if (out.length >= MAX_SITES) break
  }
  return out
}

export function SearchStepView({ call, step, children, glow = true }: { call: UIToolCall; step: SearchStep; children: ReactNode; glow?: boolean }): JSX.Element {
  const tt = useWebSearchText()
  const panelId = useId()
  const [open, setOpen] = useState(step.command.action === 'query')
  const [showAll, setShowAll] = useState(false)
  const running = call.status === 'running' || call.status === 'pending'
  const fromDetails = step.sources !== undefined
  const state = useSearchOp(running || fromDetails ? null : step.operationId)
  const sources = useMemo(() => (running ? [] : fromDetails ? step.sources ?? [] : pageSource(state)), [running, fromDetails, step, state])
  const sites = useMemo(() => uniqueSites(sources), [sources])
  const fetching = step.command.action === 'fetch'
  const settled = !running && (fromDetails || !!step.fromTool || state.status === 'ready')
  const page = fetching && settled ? sources[0] : undefined
  const blocked = !!page && isBlockedPage(page)
  const pageTitle = page && page.title && page.title !== page.url && page.title !== page.domain ? page.title : ''
  const label = settled ? (fetching ? (blocked ? tt('fetchBlocked') : tt('fetched')) : tt('searched')) : fetching ? tt('fetching') : tt('searching')
  const target = fetching ? pageTitle || searchStepLabel(step.command) : `\u201c${searchStepLabel(step.command)}\u201d`
  const count = settled && !fetching && sources.length ? tt('results', { n: sources.length }) : ''
  const summary = [label, target, count ? `\u00b7 ${count}` : '', pageTitle ? searchStepLabel(step.command) : ''].filter(Boolean).join(' ')

  if (!running && !step.fromTool) {
    if (!step.operationId) return <>{children}</>
    if (state.status === 'ready' && !state.view.ok) return <>{children}</>
  }

  const expanded = open && settled
  const pending = open && !settled && !fetching

  return (
    <>
      <button
        type="button"
        className="ws-cap"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={summary}
        title={summary}
        onClick={() => {
          setOpen((value) => !value)
          setShowAll(false)
        }}
        data-testid="ws-capsule"
        data-state={running ? 'running' : 'done'}
        data-tone={blocked ? 'warn' : undefined}
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
        <span className="ws-cap-target">{target}</span>
        {count ? <span className="ws-cap-count" data-testid="ws-capsule-count">{count}</span> : null}
        <span className="ws-cap-sites ui-source-stack" aria-hidden="true">
          {sites.map((site) => <WebsiteIcon key={site.url} url={site.url} />)}
        </span>
        <Icon name="chevron-right" size={14} className="v3-chev" />
      </button>
      <div id={panelId} className="ui-source-reveal" data-open={expanded || pending} aria-hidden={!expanded || undefined} inert={!expanded}>
        <div className="ui-source-reveal__inner">
          {pending ? (
            <div className="ws-op" aria-hidden="true" data-testid="ws-sources-pending">
              {Array.from({ length: PENDING_CARDS }, (_, i) => <PendingCard key={i} index={i} />)}
            </div>
          ) : (
            <SourceList sources={sources} showAll={showAll} onShowAll={setShowAll} testId="ws-sources" />
          )}
        </div>
      </div>
    </>
  )
}

export function SourceList({ sources, showAll, onShowAll, testId }: { sources: readonly WebSearchSourceView[]; showAll: boolean; onShowAll: (value: boolean) => void; testId: string }): JSX.Element {
  const tt = useWebSearchText()
  const openLink = useStore((s) => s.openLink)
  const turnIndex = useCitationIndex()
  const folded = !showAll && sources.length > SOURCE_PREVIEW + 1
  return (
    <div className="ws-op" role="group" aria-label={tt('sources')} data-testid={testId} data-single={sources.length === 1 || undefined}>
      {sources.length ? (
        <>
          {(folded ? sources.slice(0, SOURCE_PREVIEW) : sources).map((source, i) => (
            <SourceCard
              key={`${source.url}#${i}`}
              source={source}
              index={i}
              n={citationFor(turnIndex, source.url)?.n ?? i + 1}
              onOpen={() => void openLink(source.url)}
            />
          ))}
          {folded ? <MoreSourcesCard rest={sources.slice(SOURCE_PREVIEW)} onPress={() => onShowAll(true)} /> : null}
          {showAll && sources.length > SOURCE_PREVIEW + 1 ? (
            <Button variant="plain" size="sm" className="ws-less" onPress={() => onShowAll(false)}>
              <Icon name="chevron-up" size={14} />
              {tt('showLess')}
            </Button>
          ) : null}
        </>
      ) : (
        <div className="ws-empty">{tt('empty')}</div>
      )}
    </div>
  )
}

const SOURCE_PREVIEW = 3

function PendingCard({ index }: { index: number }): JSX.Element {
  return (
    <Card padding="sm" quiet className="ui-source-card ws-source ws-source-pending" style={{ '--source-index': index } as CSSProperties}>
      <span className="ws-source-meta">
        <Skeleton shape="circle" width={24} height={24} />
        <Skeleton width="48%" height="0.8em" />
      </span>
      <span className="ws-source-pending-title">
        <Skeleton width="92%" height="0.8em" />
        <Skeleton width="64%" height="0.8em" />
      </span>
      <Skeleton width="38%" height="0.8em" />
    </Card>
  )
}

function MoreSourcesCard({ rest, onPress }: { rest: WebSearchSourceView[]; onPress: () => void }): JSX.Element {
  const tt = useWebSearchText()
  const sites = uniqueSites(rest).slice(0, 3)
  return (
    <Card padding="none" className="ui-source-card ws-source ws-more" interactive quiet style={{ '--source-index': SOURCE_PREVIEW } as CSSProperties}>
      <button type="button" className="ui-source-card__link" onClick={onPress} data-testid="ws-more">
        <span className="ui-source-stack" aria-hidden="true">
          {sites.map((site) => <WebsiteIcon key={site.url} url={site.url} />)}
        </span>
        <span className="ui-source-card__title">{tt('moreSources', { n: rest.length })}</span>
        <span className="ui-source-card__foot"><span className="ui-source-card__domain">{sites.map((item) => item.site).join(' · ')}</span><ArrowUpRight size={14} className="ui-source-card__arrow" aria-hidden="true" /></span>
      </button>
    </Card>
  )
}

function SourceCard({ source, n, index, onOpen }: { source: WebSearchSourceView; n: number; index: number; onOpen: () => void }): JSX.Element {
  const tt = useWebSearchText()
  const domain = domainOf(source.url) || source.domain
  const hint = [source.title, domain, source.snippet].filter(Boolean).join('\n')
  const blocked = !!source.readState && isBlockedPage(source)
  return (
    <SourceCardFrame
      title={source.title}
      domain={domain}
      href={source.url}
      icon={<WebsiteIcon url={source.url} />}
      number={n}
      index={index}
      label={tt('openSource', { title: source.title })}
      hint={hint}
      snippet={source.snippet}
      status={blocked ? tt('blocked') : source.readState === 'read' || source.readState === 'partial' ? tt(source.readState) : undefined}
      statusTone={!blocked && source.readState === 'read' ? 'ok' : 'ask'}
      meta={source.published || source.cached ? <>
        {source.published ? <time dateTime={source.published}>{source.published.slice(0, 10)}</time> : null}
        {source.cached ? <span>{tt('cached')}</span> : null}
      </> : undefined}
      onOpen={onOpen}
    />
  )
}
