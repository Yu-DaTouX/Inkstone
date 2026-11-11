import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
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
const TICK_MS = 2400
const GHOSTS = [0, 1, 2]

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

function pageName(page: WebSearchSourceView | undefined, url: string): string {
  const title = page && page.title && page.title !== page.url && page.title !== page.domain ? page.title : ''
  return title || domainOf(url) || url
}

function QueryTicker({ items, active, glow }: { items: readonly string[]; active: boolean; glow: boolean }): JSX.Element {
  const [turn, setTurn] = useState(0)
  const cycling = active && items.length > 1
  useEffect(() => {
    if (!cycling) return undefined
    const timer = window.setInterval(() => setTurn((value) => value + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [cycling])
  const text = items[cycling ? turn % items.length : 0] ?? ''
  return (
    <span className="ws-cap-target">
      <span key={cycling ? turn : 0} className="ws-tick" data-cycling={cycling || undefined}>
        {active ? <ShimmerText active={glow}>{text}</ShimmerText> : text}
      </span>
    </span>
  )
}

interface SearchCapProps {
  testId: string
  running: boolean
  busy: boolean
  glow: boolean
  warn?: boolean
  targets: readonly string[]
  count: number | null
  sites: readonly { site: string; url: string }[]
  summary: string
  open: boolean
  panelId: string
  expandable: boolean
  onToggle: (cap: HTMLElement) => void
}

function SearchCap({ testId, running, busy, glow, warn, targets, count, sites, summary, open, panelId, expandable, onToggle }: SearchCapProps): JSX.Element {
  const [fresh, setFresh] = useState(false)
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) setFresh(true)
    wasBusy.current = busy
  }, [busy])
  const hint = [summary, ...targets].join('\n')
  const body = (
    <>
      <span className="ws-cap-icon" aria-hidden="true">
        <Globe size={14} strokeWidth={1.75} />
        {running ? <span className="ws-orbit"><span /></span> : null}
      </span>
      <QueryTicker items={targets} active={busy} glow={glow} />
      {targets.length > 1 ? <span className="ws-cap-more" aria-hidden="true">+{targets.length - 1}</span> : null}
      {count === null ? null : <span className="ws-cap-count" data-testid="ws-capsule-count" aria-hidden="true">{count}</span>}
      {sites.length ? (
        <span className="ws-cap-sites ui-source-stack" aria-hidden="true">
          {sites.map((site) => <WebsiteIcon key={site.url} url={site.url} />)}
        </span>
      ) : null}
      {expandable ? <CollapsibleChevron expanded={open} className="ws-cap-chevron" /> : null}
    </>
  )
  const shared = {
    className: 'ws-cap',
    title: hint,
    'data-testid': testId,
    'data-state': running ? 'running' : 'done',
    'data-tone': warn ? 'warn' : undefined,
    'data-empty': count === 0 || undefined,
    'data-fresh': fresh || undefined
  }
  if (!expandable) return <div {...shared} role="group" aria-label={summary}>{body}</div>
  return (
    <button type="button" {...shared} aria-expanded={open} aria-controls={panelId} aria-label={summary} onClick={(event) => onToggle(event.currentTarget)}>
      {body}
    </button>
  )
}

export function SearchStepView({ call, step, children, glow = true }: { call: UIToolCall; step: SearchStep; children: ReactNode; glow?: boolean }): JSX.Element {
  const tt = useWebSearchText()
  const panelId = useId()
  const running = call.status === 'running' || call.status === 'pending'
  const fromDetails = step.sources !== undefined
  const state = useSearchOp(running || fromDetails ? null : step.operationId)
  const sources = useMemo(() => (running ? [] : fromDetails ? step.sources ?? [] : pageSource(state)), [running, fromDetails, step, state])
  const sites = useMemo(() => uniqueSites(sources), [sources])
  const fetching = step.command.action === 'fetch'
  const settled = !running && (fromDetails || !!step.fromTool || state.status === 'ready')
  const page = fetching && settled ? sources[0] : undefined
  const blocked = !!page && isBlockedPage(page)
  const label = settled ? (fetching ? (blocked ? tt('fetchBlocked') : tt('fetched')) : tt('searched')) : fetching ? tt('fetching') : tt('searching')
  const name = fetching ? pageName(page, step.command.url) : ''
  const targets = fetching ? [blocked ? `${tt('fetchBlocked')} · ${domainOf(step.command.url) || name}` : name] : step.command.queries
  const count = settled && !fetching ? sources.length : null
  const summary = [label, fetching ? name : `“${searchStepLabel(step.command)}”`, count ? `· ${tt('results', { n: count })}` : '', fetching && name !== step.command.url ? step.command.url : ''].filter(Boolean).join(' ')
  const keys = searchExpansionKeys(call.id, step)
  const [stableOpen, setStableOpen] = useToolExpansion(keys.stable)
  const [taggedOpen, setTaggedOpen] = useToolExpansion(keys.tagged)
  const [showAll, setShowAll] = useState(false)
  const open = searchExpansionOpen(stableOpen ?? taggedOpen)
  const expandable = !settled || sources.length > 0

  if (!running && !step.fromTool) {
    if (!step.operationId) return <>{children}</>
    if (state.status === 'ready' && !state.view.ok) return <>{children}</>
  }

  const toggle = (cap: HTMLElement): void => {
    const next = !open
    if (!next) revealCollapsedHeader(cap)
    setStableOpen(next)
    setTaggedOpen(next)
    setShowAll(false)
  }

  return (
    <div className="ws-entry">
      <SearchCap testId="ws-capsule" running={running} busy={!settled} glow={glow} warn={blocked} targets={targets} count={count} sites={sites} summary={summary} open={open} panelId={panelId} expandable={expandable} onToggle={toggle} />
      {expandable ? (
        <div id={panelId} className="ui-source-reveal" data-open={open} aria-hidden={!open || undefined} inert={!open}>
          <div className="ui-source-reveal__inner">
            {settled ? <SourceList sources={sources} showAll={showAll} onShowAll={setShowAll} testId="ws-sources" /> : <SearchProgress />}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SearchProgress(): JSX.Element {
  return (
    <div className="ws-op ws-pending" data-testid="ws-sources-pending" aria-hidden="true">
      {GHOSTS.map((i) => (
        <span key={i} className="ws-ghost" style={{ '--source-index': i } as CSSProperties}>
          <span className="ws-ghost__head"><i /><b /></span>
          <b />
          <b data-short="true" />
        </span>
      ))}
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
  const stepSources = (step: SearchStep): WebSearchSourceView[] => step.sources ?? pageSource(step.operationId ? byId.get(step.operationId) : undefined)
  const sources = mergeSearchSources(entries.flatMap(({ running, step }) => running ? [] : stepSources(step)))
  const sites = uniqueSites(sources)
  const running = entries.some((entry) => entry.running)
  const loading = running || entries.some(({ step }) => step.sources === undefined && !!step.operationId && byId.get(step.operationId)?.status === 'loading')
  const fetched = entries.filter(({ step }) => step.command.action === 'fetch').length
  const searched = entries.length - fetched
  const label = [searched ? tt('groupSearched', { n: searched }) : '', fetched ? tt('groupFetched', { n: fetched }) : '', sources.length ? tt('results', { n: sources.length }) : ''].filter(Boolean).join(' · ')
  const targets = [...new Set(entries.flatMap(({ running: active, step }) => step.command.action === 'fetch' ? [pageName(active ? undefined : stepSources(step)[0], step.command.url)] : step.command.queries))]
  const count = searched && (!loading || sources.length) ? sources.length : null
  const first = groups[0]
  const keys = first?.steps[0] ? searchExpansionKeys(first.call.id, first.steps[0]) : { stable: `web:${first?.call.id ?? ''}`, tagged: `web:${first?.call.id ?? ''}` }
  const [stableOpen, setStableOpen] = useToolExpansion(keys.stable)
  const [taggedOpen, setTaggedOpen] = useToolExpansion(keys.tagged)
  const [showAll, setShowAll] = useState(false)
  const open = searchExpansionOpen(stableOpen ?? taggedOpen)
  const expandable = loading || sources.length > 0
  return (
    <div className="v3-web-group" data-testid="v3-web-group">
      {entries.length ? <div className="ws-entry">
        <SearchCap testId="ws-group" running={running} busy={loading} glow={glow} targets={targets} count={count} sites={sites} summary={label} open={open} panelId={panelId} expandable={expandable} onToggle={(cap) => {
          if (open) revealCollapsedHeader(cap)
          setStableOpen(!open)
          setTaggedOpen(!open)
          setShowAll(false)
        }} />
        {expandable ? (
          <div id={panelId} className="ui-source-reveal" data-open={open} aria-hidden={!open || undefined} inert={!open}>
            <div className="ui-source-reveal__inner">
              {sources.length ? <SourceList sources={sources} showAll={showAll} onShowAll={setShowAll} testId="ws-sources" /> : <SearchProgress />}
            </div>
          </div>
        ) : null}
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
