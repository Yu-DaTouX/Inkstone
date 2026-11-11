import { useId, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowUpRight, Globe } from 'lucide-react'
import { useStore } from '../../../state/store'
import { Button, Card, CollapsibleChevron, revealCollapsedHeader, ShimmerText, SourceCard as SourceCardFrame } from '../../../ui'
import type { UIToolCall, WebSearchSourceView } from '../../../../../shared/ipc'
import { Icon } from '../Icon'
import { useToolExpansion } from '../use-tool-run'
import { useCitationIndex } from './citations'
import { searchExpansionKeys, searchExpansionOpen } from './expansion'
import { citationFor, domainOf, isBlockedPage, mergeSearchSources, searchStepLabel, searchStepsOf, siteLabel, type SearchStep } from './model'
import { useSearchOp, useSearchOps, type SearchOpState } from './op-store'
import { useWebSearchText } from './text'
import { WebsiteIcon } from './WebsiteIcon'
import './web-search.css'

const MAX_SITES = 3

function pageSource(state: SearchOpState | undefined): WebSearchSourceView[] {
  if (state?.status !== 'ready' || !state.view.ok) return []
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
  const entryRef = useRef<HTMLDivElement | null>(null)
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
  const keys = searchExpansionKeys(call.id, step)
  const [stableOpen, setStableOpen] = useToolExpansion(keys.stable)
  const [taggedOpen, setTaggedOpen] = useToolExpansion(keys.tagged)
  const [showAll, setShowAll] = useState(false)
  const open = searchExpansionOpen(stableOpen ?? taggedOpen)

  if (!running && !step.fromTool) {
    if (!step.operationId) return <>{children}</>
    if (state.status === 'ready' && !state.view.ok) return <>{children}</>
  }

  const toggle = (): void => {
    const next = !open
    if (!next) revealCollapsedHeader(entryRef.current?.querySelector<HTMLElement>('.ws-cap') ?? null)
    setStableOpen(next)
    setTaggedOpen(next)
    setShowAll(false)
  }

  return (
    <div className="ws-entry" ref={entryRef}>
      <button
        type="button"
        className="ws-cap"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={summary}
        title={summary}
        onClick={toggle}
        data-testid="ws-capsule"
        data-state={running ? 'running' : 'done'}
        data-tone={blocked ? 'warn' : undefined}
      >
        <CollapsibleChevron expanded={open} className="ws-cap-chevron" />
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
      </button>
      <div id={panelId} className="ui-source-reveal" data-open={open} aria-hidden={!open || undefined} inert={!open}>
        <div className="ui-source-reveal__inner">
          {settled ? (
            <SourceList sources={sources} showAll={showAll} onShowAll={setShowAll} testId="ws-sources" />
          ) : (
            <SearchProgress />
          )}
        </div>
      </div>
    </div>
  )
}

function SearchProgress(): JSX.Element {
  return (
    <div className="ui-source-progress" data-testid="ws-sources-pending" aria-hidden="true">
      <span className="ui-source-progress__icon"><Globe size={13} strokeWidth={1.75} /></span>
      <span className="ui-source-progress__track"><span /></span>
    </div>
  )
}

export function WebGroupView({ calls, glow = true, renderFallback }: { calls: readonly UIToolCall[]; glow?: boolean; renderFallback: (call: UIToolCall) => ReactNode }): JSX.Element {
  const tt = useWebSearchText()
  const panelId = useId()
  const groups = useMemo(() => calls.map((call) => ({ call, running: call.status === 'running' || call.status === 'pending', steps: searchStepsOf(call) })), [calls])
  const ids = groups.flatMap(({ running, steps }) => running ? [] : steps.flatMap((step) => step.sources === undefined && step.operationId ? [step.operationId] : []))
  const states = useSearchOps(ids)
  const byId = new Map(ids.map((id, i) => [id, states[i]]))
  const fallback = groups.filter(({ running, steps }) => !steps.length || !running && steps.some((step) => {
    const state = step.operationId ? byId.get(step.operationId) : undefined
    return !step.fromTool && (!step.operationId || state?.status === 'ready' && !state.view.ok)
  }))
  const entries = groups.filter((group) => !fallback.includes(group)).flatMap(({ running, steps }) => steps.map((step) => ({ running, step })))
  const sources = mergeSearchSources(entries.flatMap(({ running, step }) => running ? [] : step.sources ?? pageSource(step.operationId ? byId.get(step.operationId) : undefined)))
  const sites = uniqueSites(sources)
  const running = entries.some((entry) => entry.running)
  const loading = running || entries.some(({ step }) => step.sources === undefined && !!step.operationId && byId.get(step.operationId)?.status === 'loading')
  const fetched = entries.filter(({ step }) => step.command.action === 'fetch').length
  const searched = entries.length - fetched
  const label = [searched ? tt('groupSearched', { n: searched }) : '', fetched ? tt('groupFetched', { n: fetched }) : '', sources.length ? tt('results', { n: sources.length }) : ''].filter(Boolean).join(' \u00b7 ')
  const first = groups[0]
  const keys = first?.steps[0] ? searchExpansionKeys(first.call.id, first.steps[0]) : { stable: `web:${first?.call.id ?? ''}`, tagged: `web:${first?.call.id ?? ''}` }
  const [stableOpen, setStableOpen] = useToolExpansion(keys.stable)
  const [taggedOpen, setTaggedOpen] = useToolExpansion(keys.tagged)
  const [showAll, setShowAll] = useState(false)
  const open = searchExpansionOpen(stableOpen ?? taggedOpen)
  const title = [label, ...entries.map(({ step }) => searchStepLabel(step.command))].join('\n')
  return (
    <div className="v3-web-group" data-testid="v3-web-group">
      {entries.length ? <div className="ws-entry">
        <button type="button" className="ws-cap" aria-label={label} aria-expanded={open} aria-controls={panelId} title={title} onClick={(event) => {
          if (open) revealCollapsedHeader(event.currentTarget)
          setStableOpen(!open)
          setTaggedOpen(!open)
          setShowAll(false)
        }} data-testid="ws-group" data-state={running ? 'running' : 'done'}>
          <CollapsibleChevron expanded={open} className="ws-cap-chevron" />
          <span className="ws-cap-icon" data-done={running ? undefined : true} aria-hidden="true">
            <Globe size={13} strokeWidth={1.75} />
            <svg className="ws-ring" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="ws-ring-track" cx="12" cy="12" r="10" />
              {running ? <circle className="ws-ring-arc" cx="12" cy="12" r="10" /> : null}
            </svg>
          </span>
          <span className="ws-cap-label"><ShimmerText active={loading && glow}>{label}</ShimmerText></span>
          <span className="ws-cap-sites ui-source-stack" aria-hidden="true">
            {sites.map((site) => <WebsiteIcon key={site.url} url={site.url} />)}
          </span>
        </button>
        <div id={panelId} className="ui-source-reveal" data-open={open} aria-hidden={!open || undefined} inert={!open}>
          <div className="ui-source-reveal__inner">
            {sources.length || !loading ? <SourceList sources={sources} showAll={showAll} onShowAll={setShowAll} testId="ws-sources" /> : null}
            {loading ? <SearchProgress /> : null}
          </div>
        </div>
      </div> : null}
      {fallback.map(({ call }) => <div key={call.id}>{renderFallback(call)}</div>)}
    </div>
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
