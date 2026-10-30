import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ListFilter, RefreshCw, UserRound } from 'lucide-react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogTrigger,
  DiffStat,
  EmptyState,
  IconButton,
  ListBoxItem,
  MiddleTruncate,
  Notice,
  Popover,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  StatusDot,
  Toggle,
  ToggleGroup
} from '../../ui'
import type { GhPrListState, GhPrLabelJson, GithubStatus } from '../../../../shared/github'
import type { PullRequestsPaneProps } from '../workbench/types'
import { ageOf, filterByListState, filterPrRows, normalizePrRow, type PrChecks, type PrRow } from './pr-model'
import {
  activeFilterCount,
  AUTHOR_ME,
  buildListOptions,
  DEFAULT_LIST_FILTERS,
  toggleLabel,
  type PrDraftFilter,
  type PrListFilters,
  type PrReviewFilter,
  type PrSortKey
} from './pr-actions-model'
import { prActionText, type PrActionText } from './pr-action-text'
import { stateTone } from './PullRequestDetail'
import { CreatePullRequestButton } from './CreatePullRequest'
import { openPanelSurface } from '../workbench/panel-actions'
import { pullRequestSurface } from '../../state/right-panel'
import './pull-requests.css'
import './pr-actions.css'

const LIST_STATES: readonly { id: GhPrListState; label: MessageKey }[] = [
  { id: 'open', label: 'github.pr.tab.open' },
  { id: 'merged', label: 'github.pr.tab.merged' },
  { id: 'closed', label: 'github.pr.tab.closed' },
  { id: 'all', label: 'github.pr.tab.all' }
]

const REVIEW_FILTERS: readonly PrReviewFilter[] = ['any', 'required', 'approved', 'changes_requested', 'none']
const SORT_KEYS: readonly PrSortKey[] = ['updated', 'created', 'comments']
const LABEL_LIMIT = 3
const ALL_AUTHORS = '*'

function checkDot(checks: PrChecks): 'ok' | 'pending' | 'fail' | 'idle' {
  if (checks.state === 'pass') return 'ok'
  if (checks.state === 'fail') return 'fail'
  if (checks.state === 'pending') return 'pending'
  return 'idle'
}

function reviewBadge(decision: string, text: PrActionText['list']): { label: string; tone: 'ok' | 'fail' | 'ask' } | null {
  const value = decision.toUpperCase()
  if (value === 'APPROVED') return { label: text.reviewOptions.approved, tone: 'ok' }
  if (value === 'CHANGES_REQUESTED') return { label: text.reviewOptions.changes_requested, tone: 'fail' }
  if (value === 'REVIEW_REQUIRED') return { label: text.reviewOptions.required, tone: 'ask' }
  return null
}

interface FilterPanelProps {
  cwd: string
  viewer: string
  filters: PrListFilters
  onChange: (next: PrListFilters) => void
  text: PrActionText['list']
}

function FilterPanel({ cwd, viewer, filters, onChange, text }: FilterPanelProps): ReactElement {
  const [labels, setLabels] = useState<GhPrLabelJson[] | null>(null)
  const [authors, setAuthors] = useState<string[]>([])
  const [query, setQuery] = useState('')
  useEffect(() => {
    let alive = true
    const github = window.yan?.github
    if (!github) return undefined
    void github
      .candidates(cwd, { kind: 'reviewers', perPage: 100 })
      .then((res) => {
        if (alive && res.ok) setAuthors((res.reviewers ?? []).map((item) => item.login ?? '').filter(Boolean))
      })
      .catch(() => undefined)
    void github
      .candidates(cwd, { kind: 'labels', perPage: 100 })
      .then((res) => {
        if (alive) setLabels(res.ok ? (res.labels ?? []) : [])
      })
      .catch(() => {
        if (alive) setLabels([])
      })
    return () => {
      alive = false
    }
  }, [cwd])
  const others = authors.filter((login) => login !== viewer && login !== AUTHOR_ME)
  const authorOptions = filters.author && filters.author !== AUTHOR_ME && !others.includes(filters.author) ? [filters.author, ...others] : others
  const authorLabel = (login: string): string => (login === ALL_AUTHORS ? text.authorAll : login === AUTHOR_ME ? text.authorMe(viewer) : login)
  const needle = query.trim().toLowerCase()
  const shown = (labels ?? []).filter((label) => label.name && (!needle || label.name.toLowerCase().includes(needle)))
  const set = (patch: Partial<PrListFilters>): void => onChange({ ...filters, ...patch })
  return (
    <div className="gh-pr-filter" data-testid="gh-pr-filter-panel">
      <Select<{ id: string }>
        label={text.author}
        selectedKey={filters.author || ALL_AUTHORS}
        onSelectionChange={(key) => key != null && set({ author: String(key) === ALL_AUTHORS ? '' : String(key) })}
        data-testid="gh-pr-filter-author"
      >
        {[ALL_AUTHORS, AUTHOR_ME, ...authorOptions].map((login) => (
          <ListBoxItem key={login} id={login} textValue={authorLabel(login)} data-testid={login === AUTHOR_ME ? 'gh-pr-filter-author-me' : undefined}>
            {authorLabel(login)}
          </ListBoxItem>
        ))}
      </Select>
      <div className="gh-pr-filter__row">
        <span className="gh-pr-filter__label ui-field__label">{text.draft}</span>
        <SegmentedControl<PrDraftFilter>
          label={text.draft}
          value={filters.draft}
          onChange={(value) => set({ draft: value })}
          options={[
            { value: 'any', label: text.draftAny },
            { value: 'draft', label: text.draftOnly, testId: 'gh-pr-filter-draft' },
            { value: 'ready', label: text.readyOnly }
          ]}
        />
      </div>
      <Select<{ id: PrReviewFilter }>
        label={text.review}
        selectedKey={filters.review}
        onSelectionChange={(key) => key != null && set({ review: String(key) as PrReviewFilter })}
        data-testid="gh-pr-filter-review"
      >
        {REVIEW_FILTERS.map((item) => (
          <ListBoxItem key={item} id={item} textValue={text.reviewOptions[item]}>
            {text.reviewOptions[item]}
          </ListBoxItem>
        ))}
      </Select>
      <div className="gh-pr-filter__labels">
        <span className="gh-pr-filter__label ui-field__label">{text.labels}</span>
        <SearchField aria-label={text.labelsSearch} placeholder={text.labelsSearch} value={query} onChange={setQuery} />
        {labels === null ? (
          <Notice variant="hint" icon={<Spinner size="xs" />}>
            {text.labelsLoading}
          </Notice>
        ) : shown.length ? (
          <ul className="gh-pr-filter__label-list">
            {shown.map((label) => (
              <li key={label.name}>
                <Checkbox isSelected={filters.labels.includes(label.name ?? '')} onChange={() => set({ labels: toggleLabel(filters.labels, label.name ?? '') })}>
                  {label.name}
                </Checkbox>
              </li>
            ))}
          </ul>
        ) : (
          <Notice variant="hint">{text.labelsEmpty}</Notice>
        )}
      </div>
      <div className="gh-pr-act__footer">
        <Button
          size="xs"
          variant="ghost"
          isDisabled={!activeFilterCount(filters)}
          onPress={() => onChange({ ...DEFAULT_LIST_FILTERS, state: filters.state, sort: filters.sort, direction: filters.direction })}
          data-testid="gh-pr-filter-reset"
        >
          {text.reset}
        </Button>
      </div>
    </div>
  )
}

export function PullRequestsPane({ owner }: PullRequestsPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const actText = prActionText(lang).list
  const cwd = owner.cwd
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  const [filters, setFilters] = useState<PrListFilters>(DEFAULT_LIST_FILTERS)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PrRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')

  const repo = status?.repo?.nameWithOwner ?? ''
  const ready = !!status && status.installed && status.authed && !!status.repo
  const listState = filters.state

  useEffect(() => {
    let alive = true
    setStatusLoading(true)
    setStatus(null)
    const github = window.yan?.github
    if (!github) {
      setStatus({ installed: false, authed: false, repo: null, error: t('github.pr.bridgeMissing') })
      setStatusLoading(false)
      return () => {
        alive = false
      }
    }
    void (async () => {
      try {
        const next = await github.status(cwd)
        if (alive) setStatus(next)
      } catch (cause) {
        if (alive) {
          setStatus({
            installed: false,
            authed: false,
            repo: null,
            error: cause instanceof Error ? cause.message : String(cause)
          })
        }
      } finally {
        if (alive) setStatusLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [cwd, reloadToken, t])

  useEffect(() => {
    if (!ready || !repo) return undefined
    let alive = true
    setListLoading(true)
    const github = window.yan?.github
    if (!github) return undefined
    void (async () => {
      try {
        const res = await github.list(cwd, buildListOptions(filters, page))
        if (!alive) return
        if (!res.ok) {
          setListError(res.failure?.message || res.error || '')
          setRows([])
          setHasMore(false)
          return
        }
        setListError('')
        setRows(res.items.map(normalizePrRow))
        setHasMore(res.hasMore === true)
      } catch (cause) {
        if (alive) setListError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (alive) setListLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [ready, repo, cwd, filters, page, reloadToken])

  const shown = useMemo(() => filterPrRows(filterByListState(rows, listState), query), [rows, query, listState])
  const changeFilters = (next: PrListFilters): void => {
    setFilters(next)
    setPage(1)
  }
  const activeCount = activeFilterCount(filters)

  const when = (iso: string): string => {
    const age = ageOf(iso, Date.now())
    if (age.unit === 'now') return t('github.pr.time.now')
    if (age.unit === 'minute') return t('github.pr.time.minutes', { n: age.value })
    if (age.unit === 'hour') return t('github.pr.time.hours', { n: age.value })
    if (age.unit === 'day') return t('github.pr.time.days', { n: age.value })
    if (!age.value) return ''
    return new Date(age.value).toLocaleDateString(lang === 'en-US' ? 'en-US' : 'zh-CN')
  }

  const checkText = (checks: PrChecks): string => {
    if (checks.state === 'none') return actText.checks.none
    if (checks.state === 'fail') return actText.checks.fail
    if (checks.state === 'pending') return actText.checks.pending
    return actText.checks.pass
  }

  const stateText = (state: PrRow['state']): string =>
    state === 'merged'
      ? t('github.pr.state.merged')
      : state === 'closed'
        ? t('github.pr.state.closed')
        : state === 'draft'
          ? t('github.pr.state.draft')
          : t('github.pr.state.open')

  const loadingHint = (): ReactElement => (
    <Notice variant="hint" icon={<Spinner size="xs" />} className="gh-pr-hint">
      {t('github.pr.loading')}
    </Notice>
  )

  if (statusLoading && !status) {
    return (
      <div className="gh-pr-pane" data-testid="v3-wb-pulls">
        {loadingHint()}
      </div>
    )
  }

  const reload = (): void => setReloadToken((value) => value + 1)

  const hint = (title: string, body: string, detail?: string): ReactElement => (
    <EmptyState
      size="sm"
      className="gh-pr-empty"
      data-testid="gh-pr-hint"
      title={title}
      description={
        <>
          {body}
          {detail ? <code className="gh-pr-empty__detail">{detail}</code> : null}
        </>
      }
      action={
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden />} onPress={reload} data-testid="gh-pr-hint-refresh">
          {t('github.pr.refresh')}
        </Button>
      }
    />
  )

  const content = (): ReactElement | null => {
    if (!status) return loadingHint()
    if (status.error && !status.authed) return hint(t('github.pr.errorTitle'), status.error)
    if (!status.installed) return hint(t('github.pr.missingGhTitle'), t('github.pr.missingGhBody'))
    if (!status.authed) return hint(t('github.pr.signedOutTitle'), t('github.pr.signedOutBody'))
    if (!status.repo) return hint(t('github.pr.notRepoTitle'), t('github.pr.notRepoBody'), status.error)
    return null
  }

  return (
    <div className="gh-pr-pane" data-testid="v3-wb-pulls">
      {ready ? (
        <>
          <div className="gh-pr-toolbar">
            <ToggleGroup
              variant="segmented"
              size="xs"
              aria-label={t('github.pr.filterLabel')}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[listState]}
              onSelectionChange={(keys) => {
                const next = [...keys][0]
                if (next !== undefined) changeFilters({ ...filters, state: next as GhPrListState })
              }}
            >
              {LIST_STATES.map((item) => (
                <Toggle key={item.id} id={item.id} data-testid={`gh-pr-tab-${item.id}`}>
                  {t(item.label)}
                </Toggle>
              ))}
            </ToggleGroup>
            <span className="gh-pr-toolbar__spacer" />
            <CreatePullRequestButton cwd={cwd} lang={lang} />
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('github.pr.refresh')}
              tooltip={t('github.pr.refresh')}
              onPress={reload}
              data-testid="gh-pr-refresh"
            >
              <RefreshCw size={14} aria-hidden />
            </IconButton>
          </div>
          <div className="gh-pr-toolbar gh-pr-toolbar--sub">
            <SearchField
              className="gh-pr-search"
              aria-label={t('github.pr.searchPlaceholder')}
              placeholder={t('github.pr.searchPlaceholder')}
              value={query}
              onChange={setQuery}
            />
            <Toggle
              size="sm"
              variant="outline"
              isSelected={filters.author === AUTHOR_ME}
              onChange={(on) => changeFilters({ ...filters, author: on ? AUTHOR_ME : '' })}
              tooltip={status?.viewerLogin ? `${actText.mineHint} · ${status.viewerLogin}` : actText.mineHint}
              data-testid="gh-pr-mine"
            >
              <UserRound size={14} aria-hidden />
              {actText.mine}
            </Toggle>
            <DialogTrigger>
              <Button
                size="sm"
                variant={activeCount ? 'secondary' : 'ghost'}
                icon={<ListFilter size={14} aria-hidden />}
                data-testid="gh-pr-filter-open"
              >
                {activeCount ? actText.filtersActive(activeCount) : actText.filters}
              </Button>
              <Popover variant="panel" placement="bottom end" className="gh-pr-filter-pop">
                <Dialog aria-label={actText.filters} showClose={false}>
                  <FilterPanel cwd={cwd} viewer={status?.viewerLogin ?? ''} filters={filters} onChange={changeFilters} text={actText} />
                </Dialog>
              </Popover>
            </DialogTrigger>
            <Select<{ id: PrSortKey }>
              aria-label={actText.sort}
              className="gh-pr-sort"
              selectedKey={filters.sort}
              onSelectionChange={(key) => key != null && changeFilters({ ...filters, sort: String(key) as PrSortKey })}
              data-testid="gh-pr-sort"
            >
              {SORT_KEYS.map((key) => (
                <ListBoxItem key={key} id={key} textValue={actText.sortOptions[key]}>
                  {actText.sortOptions[key]}
                </ListBoxItem>
              ))}
            </Select>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={filters.direction === 'desc' ? actText.descending : actText.ascending}
              tooltip={filters.direction === 'desc' ? actText.descending : actText.ascending}
              onPress={() => changeFilters({ ...filters, direction: filters.direction === 'desc' ? 'asc' : 'desc' })}
              data-testid="gh-pr-direction"
            >
              {filters.direction === 'desc' ? <ArrowDownWideNarrow size={14} aria-hidden /> : <ArrowUpNarrowWide size={14} aria-hidden />}
            </IconButton>
          </div>
          {listError ? (
            <Notice tone="fail" compact data-testid="gh-pr-list-error">
              {t('github.pr.listFailed', { msg: listError })}
            </Notice>
          ) : null}
          {listLoading && !rows.length ? (
            <div className="gh-pr-list__skeleton" aria-busy="true" aria-label={t('github.pr.loading')} data-testid="gh-pr-list-skeleton">
              {[0, 1, 2, 3, 4].map((index) => (
                <div key={index} className="gh-pr-list__skeleton-row">
                  <Skeleton width={`${78 - index * 7}%`} />
                  <Skeleton width={`${52 - index * 4}%`} />
                </div>
              ))}
            </div>
          ) : null}
          {!listLoading && !shown.length ? (
            <EmptyState size="sm" className="gh-pr-empty" title={t('github.pr.emptyList')} description={status?.repo?.nameWithOwner} />
          ) : null}
          <ul className="gh-pr-list">
            {shown.map((row) => {
              const review = reviewBadge(row.reviewDecision, actText)
              return (
                <li key={row.number} className="gh-pr-list__item">
                  <button
                    type="button"
                    className="gh-pr-row"
                    aria-label={`#${row.number} ${row.title}`}
                    onClick={() => openPanelSurface(pullRequestSurface(row.number, { title: row.title, state: row.state }))}
                    data-testid={`gh-pr-row-${row.number}`}
                  >
                    <span className="gh-pr-row__top">
                      <span className="gh-pr-row__num">#{row.number}</span>
                      <span className="gh-pr-row__title">{row.title}</span>
                      {row.state !== 'open' ? <Badge tone={stateTone(row.state)}>{stateText(row.state)}</Badge> : null}
                      {review ? <Badge tone={review.tone}>{review.label}</Badge> : null}
                    </span>
                    <span className="gh-pr-row__meta">
                      <span className="gh-pr-row__author">{row.author}</span>
                      <span className="gh-pr-row__branches ui-num" title={`${row.head} → ${row.base}`}>
                        <MiddleTruncate className="gh-pr-row__branch" value={row.head} showTitle={false} />
                        <span aria-hidden>→</span>
                        <MiddleTruncate className="gh-pr-row__branch" value={row.base} showTitle={false} />
                      </span>
                      <span className="gh-pr-row__check" title={checkText(row.checks)} aria-label={checkText(row.checks)}>
                        <StatusDot kind={checkDot(row.checks)} />
                        {row.checks.total ? <span className="ui-num">{row.checks.passed}/{row.checks.total}</span> : null}
                      </span>
                      <DiffStat added={row.additions} removed={row.deletions} hideZero />
                      <span className="gh-pr-row__time">{when(row.updatedAt)}</span>
                    </span>
                    {row.labels.length ? (
                      <span className="gh-pr-row__labels">
                        {row.labels.slice(0, LABEL_LIMIT).map((label) => (
                          <Badge key={label}>{label}</Badge>
                        ))}
                        {row.labels.length > LABEL_LIMIT ? <Badge>+{row.labels.length - LABEL_LIMIT}</Badge> : null}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
            {hasMore || (listLoading && rows.length) ? (
              <li className="gh-pr-list__more">
                <Button size="sm" variant="ghost" isPending={listLoading} isDisabled={listLoading || !hasMore} onPress={() => setPage((value) => value + 1)} data-testid="gh-pr-load-more">
                  {listLoading ? actText.loadingMore : actText.loadMore}
                </Button>
                <span className="gh-pr-list__count ui-meta-text">{actText.shown(rows.length)}</span>
              </li>
            ) : null}
          </ul>
        </>
      ) : (
        content()
      )}
    </div>
  )
}
