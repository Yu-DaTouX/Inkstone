import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { Badge, EmptyState, IconButton, Notice, SearchField, Spinner, StatusDot, Tab, TabList, Tabs } from '../../ui'
import type { GhPrListState, GithubStatus } from '../../../../shared/github'
import type { PullRequestsPaneProps } from '../workbench/types'
import { ageOf, filterByListState, filterPrRows, normalizePrRow, type PrChecks, type PrRow } from './pr-model'
import { PullRequestDetail, stateTone } from './PullRequestDetail'
import './pull-requests.css'

const LIST_STATES: readonly { id: GhPrListState; label: MessageKey }[] = [
  { id: 'open', label: 'github.pr.tab.open' },
  { id: 'merged', label: 'github.pr.tab.merged' },
  { id: 'closed', label: 'github.pr.tab.closed' },
  { id: 'all', label: 'github.pr.tab.all' }
]

function checkDot(checks: PrChecks): 'ok' | 'pending' | 'fail' | 'idle' {
  if (checks.state === 'pass') return 'ok'
  if (checks.state === 'fail') return 'fail'
  if (checks.state === 'pending') return 'pending'
  return 'idle'
}

export function PullRequestsPane({ owner }: PullRequestsPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const cwd = owner.cwd
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  const [listState, setListState] = useState<GhPrListState>('open')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PrRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [open, setOpen] = useState<PrRow | null>(null)

  const repo = status?.repo?.nameWithOwner ?? ''
  const ready = !!status && status.installed && status.authed && !!status.repo

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
    if (!ready || open || !repo) return undefined
    let alive = true
    setListLoading(true)
    const github = window.yan?.github
    if (!github) return undefined
    void (async () => {
      try {
        const res = await github.list(cwd, listState)
        if (!alive) return
        if (!res.ok) {
          setListError(res.error ?? '')
          setRows([])
          return
        }
        setListError('')
        setRows(res.items.map(normalizePrRow))
      } catch (cause) {
        if (alive) setListError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (alive) setListLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [ready, open, repo, cwd, listState, reloadToken])

  const shown = useMemo(() => filterPrRows(filterByListState(rows, listState), query), [rows, query, listState])

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
    if (checks.state === 'none') return t('github.pr.checks.none')
    if (checks.state === 'fail') return t('github.pr.checks.fail')
    if (checks.state === 'pending') return t('github.pr.checks.pending')
    return t('github.pr.checks.pass')
  }

  const stateText = (state: PrRow['state']): string =>
    state === 'merged'
      ? t('github.pr.state.merged')
      : state === 'closed'
        ? t('github.pr.state.closed')
        : state === 'draft'
          ? t('github.pr.state.draft')
          : t('github.pr.state.open')

  if (statusLoading && !status) {
    return (
      <div className="gh-pr-pane" data-testid="v3-wb-pulls">
        <p className="gh-pr-hint"><Spinner size={14} /> {t('github.pr.loading')}</p>
      </div>
    )
  }

  if (open) {
    return (
      <div className="gh-pr-pane" data-testid="v3-wb-pulls">
        <PullRequestDetail cwd={cwd} repo={repo} row={open} onBack={() => setOpen(null)} />
      </div>
    )
  }

  const hint = (title: string, body: string, detail?: string): ReactElement => (
    <div className="gh-pr-hint-block" data-testid="gh-pr-hint">
      <h2 className="gh-pr-hint-block__title">{title}</h2>
      <p className="gh-pr-hint-block__body">{body}</p>
      {detail ? <p className="gh-pr-hint-block__detail">{detail}</p> : null}
      <div className="gh-pr-hint-block__actions">
        <IconButton
          size="sm"
          variant="ghost"
          aria-label={t('github.pr.refresh')}
          title={t('github.pr.refresh')}
          onPress={() => setReloadToken((value) => value + 1)}
          data-testid="gh-pr-hint-refresh"
        >
          <RefreshCw size={14} aria-hidden />
        </IconButton>
        <span className="gh-pr-hint-block__action-label">{t('github.pr.refresh')}</span>
      </div>
    </div>
  )

  const content = (): ReactElement | null => {
    if (!status) return <p className="gh-pr-hint"><Spinner size={14} /> {t('github.pr.loading')}</p>
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
            <Tabs
              className="gh-pr-tabs"
              selectedKey={listState}
              onSelectionChange={(key) => setListState(key as GhPrListState)}
            >
              <TabList aria-label={t('github.pr.filterLabel')}>
                {LIST_STATES.map((item) => (
                  <Tab key={item.id} id={item.id} data-testid={`gh-pr-tab-${item.id}`}>
                    {t(item.label)}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('github.pr.refresh')}
              title={t('github.pr.refresh')}
              onPress={() => setReloadToken((value) => value + 1)}
              data-testid="gh-pr-refresh"
            >
              <RefreshCw size={14} aria-hidden />
            </IconButton>
            <SearchField
              className="gh-pr-search"
              aria-label={t('github.pr.searchPlaceholder')}
              placeholder={t('github.pr.searchPlaceholder')}
              value={query}
              onChange={setQuery}
            />
          </div>
          {listError ? (
            <Notice tone="fail" compact data-testid="gh-pr-list-error">
              {t('github.pr.listFailed', { msg: listError })}
            </Notice>
          ) : null}
          {listLoading && !rows.length ? (
            <p className="gh-pr-hint"><Spinner size={14} /> {t('github.pr.loading')}</p>
          ) : null}
          {!listLoading && !shown.length ? (
            <EmptyState className="gh-pr-empty" title={t('github.pr.emptyList')} description={status?.repo?.nameWithOwner} />
          ) : null}
          <ul className="gh-pr-list">
            {shown.map((row) => (
              <li key={row.number} className="gh-pr-list__item">
                <button
                  type="button"
                  className="gh-pr-row"
                  aria-label={`#${row.number} ${row.title}`}
                  onClick={() => setOpen(row)}
                  data-testid={`gh-pr-row-${row.number}`}
                >
                  <span className="gh-pr-row__top">
                    <span className="gh-pr-row__num">#{row.number}</span>
                    <span className="gh-pr-row__title">{row.title}</span>
                    {row.state !== 'open' ? <Badge tone={stateTone(row.state)}>{stateText(row.state)}</Badge> : null}
                    <span className="gh-pr-row__check" title={checkText(row.checks)}>
                      <StatusDot kind={checkDot(row.checks)} />
                    </span>
                  </span>
                  <span className="gh-pr-row__meta">
                    <span className="gh-pr-row__author">{row.author}</span>
                    <span className="gh-pr-row__branches" title={`${row.head} → ${row.base}`}>
                      {row.head} → {row.base}
                    </span>
                    <span className="gh-pr-row__diff">
                      <span className="gh-pr-add">+{row.additions}</span>
                      <span className="gh-pr-del">-{row.deletions}</span>
                    </span>
                    <span className="gh-pr-row__time">{when(row.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        content()
      )}
    </div>
  )
}
