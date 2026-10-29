import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, FileDiff, RefreshCw } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleHeader,
  CollapsiblePanel,
  DiffStat,
  IconButton,
  MiddleTruncate,
  Notice,
  SegmentedControl,
  Spinner,
  StatusDot,
  Tooltip,
  TooltipHint,
  TooltipTrigger
} from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { DiffView } from '../diff'
import { Markdown } from '../session/Markdown'
import type { PrDetailTab } from '../../state/right-panel'
import {
  ageOf,
  normalizePrDetail,
  parseViewed,
  serializeViewed,
  toggleViewed,
  viewedCount,
  type PrCheckItem,
  type PrChecks,
  type PrDetail,
  type PrReviewerState,
  type PrState
} from './pr-model'
import { prDetailText } from './pr-detail-text'
import './pull-requests.css'

const VIEWED_KEY = 'inkstone.github.pr.viewed'

function readViewedRaw(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(VIEWED_KEY)
  } catch {
    return null
  }
}

function writeViewedRaw(value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEWED_KEY, value)
  } catch {
    return
  }
}

type BadgeTone = 'neutral' | 'accent' | 'ok' | 'run' | 'ask' | 'stall' | 'fail'

export function stateTone(state: PrState): BadgeTone {
  if (state === 'merged') return 'accent'
  if (state === 'closed') return 'fail'
  if (state === 'draft') return 'neutral'
  return 'ok'
}

function checkTone(item: PrCheckItem): 'ok' | 'pending' | 'fail' {
  if (item.state === 'pass') return 'ok'
  if (item.state === 'fail') return 'fail'
  return 'pending'
}

function checksDot(checks: PrChecks): 'ok' | 'pending' | 'fail' | 'idle' {
  if (checks.state === 'pass') return 'ok'
  if (checks.state === 'fail') return 'fail'
  if (checks.state === 'pending') return 'pending'
  return 'idle'
}

function reviewerTone(state: PrReviewerState): BadgeTone {
  if (state === 'approved') return 'ok'
  if (state === 'changes') return 'fail'
  if (state === 'pending') return 'ask'
  return 'neutral'
}

function Tip({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <TooltipTrigger>
      {children}
      <Tooltip>
        <TooltipHint label={label} />
      </Tooltip>
    </TooltipTrigger>
  )
}

function CopyCommand({ value, label, copiedLabel }: { value: string; label: string; copiedLabel: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <Tip label={label}>
      <Button
        size="xs"
        variant="ghost"
        className="gh-prd__checkout"
        aria-label={copied ? copiedLabel : `${label}: ${value}`}
        icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        data-testid="gh-pr-checkout"
        onPress={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined)}
      >
        <code>{copied ? copiedLabel : value}</code>
      </Button>
    </Tip>
  )
}

export interface PullRequestDetailProps {
  cwd: string
  number: number
  seedTitle?: string
  tab: PrDetailTab
  onTabChange: (tab: PrDetailTab) => void
  onState?: (state: PrState, title: string) => void
}

export function PullRequestDetail({ cwd, number, seedTitle, tab, onTabChange, onState }: PullRequestDetailProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = prDetailText(lang)
  const [repo, setRepo] = useState<{ name: string; url: string } | null>(null)
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [diffNote, setDiffNote] = useState<{ kind: 'truncated' | 'error'; message?: string } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [viewed, setViewed] = useState<string[]>(() => parseViewed(readViewedRaw()))
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setDiffNote(null)
    const github = window.yan?.github
    if (!github) {
      setError(t('github.pr.bridgeMissing'))
      setLoading(false)
      return undefined
    }
    void (async () => {
      try {
        const status = await github.status(cwd)
        if (!alive) return
        const name = status.repo?.nameWithOwner ?? ''
        setRepo(status.repo ? { name, url: status.repo.url } : null)
        if (!status.repo) {
          setError(status.error || t('github.pr.notRepoBody'))
          return
        }
        const [detailRes, diffRes] = await Promise.all([github.detail(cwd, number), github.diff(cwd, number)])
        if (!alive) return
        if (!detailRes.ok || !detailRes.pr) {
          setError(detailRes.error || t('github.pr.detail.failed', { msg: '' }))
          return
        }
        const next = normalizePrDetail(detailRes.pr, { repo: name, diff: diffRes.ok ? diffRes.patch : '' })
        setDetail(next)
        onState?.(next.state, next.title)
        if (!diffRes.ok) setDiffNote({ kind: 'error', message: diffRes.error ?? '' })
        else if (diffRes.truncated) setDiffNote({ kind: 'truncated' })
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [cwd, number, reload, t])

  useEffect(() => {
    writeViewedRaw(serializeViewed(viewed))
  }, [viewed])

  const viewedSet = useMemo(() => new Set(viewed), [viewed])
  const files = detail?.files ?? []
  const readCount = viewedCount(viewed, files.map((file) => file.key))
  const url = detail?.url || (repo?.url ? `${repo.url}/pull/${number}` : '')

  const when = (iso: string): string => {
    const age = ageOf(iso, Date.now())
    if (age.unit === 'now') return t('github.pr.time.now')
    if (age.unit === 'minute') return t('github.pr.time.minutes', { n: age.value })
    if (age.unit === 'hour') return t('github.pr.time.hours', { n: age.value })
    if (age.unit === 'day') return t('github.pr.time.days', { n: age.value })
    if (!age.value) return ''
    return new Date(age.value).toLocaleDateString(lang === 'en-US' ? 'en-US' : 'zh-CN')
  }

  const openExternal = (target: string): void => {
    const github = window.yan?.github
    if (!github || !target) return
    setNotice('')
    void github.openUrl(target).then((res) => {
      if (!res.ok) setNotice(t('github.pr.openFailed', { msg: res.error ?? '' }))
    })
  }

  const toggleFile = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const stateText = (state: PrState): string =>
    state === 'merged'
      ? t('github.pr.state.merged')
      : state === 'closed'
        ? t('github.pr.state.closed')
        : state === 'draft'
          ? t('github.pr.state.draft')
          : t('github.pr.state.open')

  const checksLabel = (checks: PrChecks): string => {
    if (checks.state === 'none') return text.noChecks
    if (checks.state === 'fail') return text.checksFailing(checks.failed, checks.total)
    if (checks.state === 'pending') return text.checksPending(checks.pending, checks.total)
    return text.checksSummary(checks.passed, checks.total)
  }

  const reviewLabel = (review: string): { label: string; tone: BadgeTone } | null => {
    switch (review) {
      case 'APPROVED':
        return { label: t('github.pr.review.approved'), tone: 'ok' }
      case 'CHANGES_REQUESTED':
        return { label: t('github.pr.review.changesRequested'), tone: 'fail' }
      case 'COMMENTED':
        return { label: t('github.pr.review.commented'), tone: 'neutral' }
      case 'DISMISSED':
        return { label: t('github.pr.review.dismissed'), tone: 'neutral' }
      case 'PENDING':
        return { label: t('github.pr.review.pending'), tone: 'ask' }
      default:
        return null
    }
  }

  const title = detail?.title ?? seedTitle ?? ''
  const updated = detail
    ? detail.state === 'merged' && detail.mergedAt
      ? text.merged(when(detail.mergedAt))
      : detail.state === 'closed' && detail.closedAt
        ? text.closed(when(detail.closedAt))
        : detail.updatedAt
          ? t('github.pr.detail.updated', { time: when(detail.updatedAt) })
          : ''
    : ''

  const note = (message: string): ReactElement => (
    <Notice variant="hint" className="gh-pr-detail__note">
      {message}
    </Notice>
  )

  return (
    <div className="gh-prd" data-testid={`gh-pr-detail-${number}`}>
      <header className="gh-prd__head">
        <div className="gh-prd__crumbs">
          {repo ? (
            <Tip label={text.repoLink(repo.name)}>
              <Button size="sm" variant="plain" className="gh-prd__crumb" onPress={() => openExternal(repo.url)} data-testid="gh-pr-repo-link">
                {repo.name}
              </Button>
            </Tip>
          ) : null}
          {repo ? <span className="gh-prd__sep" aria-hidden>/</span> : null}
          <Tip label={text.prLink(number)}>
            <Button
              size="sm"
              variant="plain"
              className="gh-prd__crumb"
              isDisabled={!url}
              trailingIcon={<ExternalLink size={12} aria-hidden />}
              onPress={() => openExternal(url)}
              data-testid="gh-pr-open-browser"
            >
              #{number}
            </Button>
          </Tip>
          {detail ? (
            <Badge tone={stateTone(detail.state)} className="gh-prd__state">
              {stateText(detail.state)}
            </Badge>
          ) : null}
          <span className="gh-prd__spacer" />
          <IconButton size="sm" variant="ghost" aria-label={text.refresh} tooltip={text.refresh} onPress={() => setReload((value) => value + 1)} data-testid="gh-pr-detail-refresh">
            {loading ? <Spinner size="xs" /> : <RefreshCw size={14} aria-hidden />}
          </IconButton>
        </div>
        {title ? <h2 className="gh-prd__title">{title}</h2> : null}
        {detail ? (
          <>
            <div className="gh-prd__meta">
              <Avatar name={detail.author || '?'} />
              <span className="gh-prd__author">{detail.author}</span>
              {updated ? <span className="gh-prd__dim">· {updated}</span> : null}
              <CopyCommand value={`gh pr checkout ${number}`} label={text.copyCheckout} copiedLabel={text.copied} />
            </div>
            <div className="gh-prd__refs">
              <span className="gh-prd__branches">
                <code className="gh-prd__ref" title={detail.base}>{detail.base}</code>
                <ArrowLeft size={12} aria-label={text.receives} className="gh-prd__arrow" />
                <code className="gh-prd__ref" title={detail.head}>{detail.head}</code>
              </span>
              <span className="gh-prd__stat">
                <FileDiff size={12} aria-hidden />
                <span>{text.files(detail.changedFiles)}</span>
                <DiffStat added={detail.additions} removed={detail.deletions} />
              </span>
            </div>
          </>
        ) : null}
      </header>
      <nav className="gh-prd__tabs" aria-label={text.tabsLabel}>
        <SegmentedControl<PrDetailTab>
          label={text.tabsLabel}
          value={tab}
          onChange={onTabChange}
          options={[
            { value: 'summary', label: text.tabs.summary, testId: 'gh-pr-tab-summary' },
            { value: 'timeline', label: text.tabs.timeline, testId: 'gh-pr-tab-timeline' },
            { value: 'code', label: text.tabs.code, testId: 'gh-pr-tab-code' }
          ]}
        />
        {detail ? (
          <span className="gh-prd__checks" title={checksLabel(detail.checks)} data-testid="gh-pr-checks-line">
            <StatusDot kind={checksDot(detail.checks)} />
            <span>{checksLabel(detail.checks)}</span>
          </span>
        ) : null}
      </nav>
      {notice ? <Notice tone="fail" compact className="gh-prd__notice">{notice}</Notice> : null}
      {error ? (
        <Notice tone="fail" compact className="gh-prd__notice" data-testid="gh-pr-detail-error">
          {t('github.pr.detail.failed', { msg: error })}
        </Notice>
      ) : null}
      {loading && !detail ? (
        <Notice variant="hint" icon={<Spinner size="xs" />} className="gh-prd__notice">
          {t('github.pr.detail.loading')}
        </Notice>
      ) : null}
      {detail ? (
        <div className="gh-prd__body">
          {tab === 'summary' ? (
            <>
              <section className="gh-prd__section" aria-label={text.reviewers}>
                <h3 className="gh-prd__heading">{text.reviewers}</h3>
                {detail.reviewers.length ? (
                  <ul className="gh-prd__people">
                    {detail.reviewers.map((reviewer) => (
                      <li key={reviewer.name} className="gh-prd__person">
                        <Avatar name={reviewer.name} />
                        <span className="gh-prd__author">{reviewer.name}</span>
                        <Badge tone={reviewerTone(reviewer.state)}>{text.reviewer[reviewer.state]}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  note(text.noReviewers)
                )}
              </section>
              <section className="gh-prd__section" aria-label={text.labels}>
                <h3 className="gh-prd__heading">{text.labels}</h3>
                {detail.labels.length ? (
                  <div className="gh-prd__labels">
                    {detail.labels.map((label) => (
                      <Badge key={label}>{label}</Badge>
                    ))}
                  </div>
                ) : (
                  note(text.noLabels)
                )}
              </section>
              <Collapsible className="gh-prd__section" isExpanded={descriptionOpen} onExpandedChange={setDescriptionOpen}>
                <CollapsibleHeader
                  tone="emphasized"
                  aria-label={descriptionOpen ? text.hideDescription : text.showDescription}
                  data-testid="gh-pr-description-toggle"
                >
                  {text.description}
                </CollapsibleHeader>
                <CollapsiblePanel>
                  {descriptionOpen ? (
                    detail.body ? (
                      <div className="gh-prd__markdown">
                        <Markdown text={detail.body} sourceCwd={cwd} />
                      </div>
                    ) : (
                      note(t('github.pr.detail.noBody'))
                    )
                  ) : null}
                </CollapsiblePanel>
              </Collapsible>
              <section className="gh-prd__section" aria-label={t('github.pr.detail.checks')}>
                <h3 className="gh-prd__heading">{t('github.pr.detail.checks')}</h3>
                {detail.checkItems.length ? (
                  <ul className="gh-pr-checks">
                    {detail.checkItems.map((item) => (
                      <li key={`${item.name}:${item.detail}`} className="gh-pr-check" data-state={checkTone(item)}>
                        <StatusDot kind={checkTone(item)} />
                        <span className="gh-pr-check__name" title={item.name}>{item.name}</span>
                        <span className="gh-pr-check__state">{item.detail}</span>
                        {item.url ? (
                          <Button size="xs" variant="plain" onPress={() => openExternal(item.url)}>
                            {t('github.pr.checks.details')}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  note(t('github.pr.detail.noChecks'))
                )}
              </section>
            </>
          ) : null}
          {tab === 'timeline' ? (
            detail.timeline.length ? (
              <ol className="gh-pr-timeline" data-testid="gh-pr-timeline">
                {detail.timeline.map((item) => {
                  const review = item.kind === 'review' ? reviewLabel(item.review) : null
                  return (
                    <li key={item.id} className="gh-pr-event" data-kind={item.kind}>
                      <div className="gh-pr-event__head">
                        <Avatar name={item.author || '?'} />
                        <span className="gh-pr-event__author">{item.author}</span>
                        {review ? <Badge tone={review.tone}>{review.label}</Badge> : null}
                        {item.kind === 'commit' ? <Badge>{text.commit} {item.review}</Badge> : null}
                        <span className="gh-pr-event__time">{when(item.at)}</span>
                      </div>
                      {item.body ? (
                        <div className="gh-pr-event__body">
                          {item.kind === 'commit' ? <p className="gh-prd__commit">{item.body}</p> : <Markdown text={item.body} sourceCwd={cwd} />}
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            ) : (
              note(t('github.pr.detail.timelineEmpty'))
            )
          ) : null}
          {tab === 'code' ? (
            <section className="gh-prd__section" aria-label={t('github.pr.detail.files')}>
              <h3 className="gh-prd__heading">
                {t('github.pr.detail.files')}
                {files.length ? <span className="gh-pr-detail__count" data-testid="gh-pr-files-read">{t('github.pr.detail.readOf', { read: readCount, total: files.length })}</span> : null}
              </h3>
              {diffNote?.kind === 'truncated' ? <Notice tone="ask" compact>{t('github.pr.detail.diffTruncated')}</Notice> : null}
              {diffNote?.kind === 'error' ? (
                <Notice tone="ask" compact data-testid="gh-pr-diff-error">
                  {t('github.pr.detail.diffFailed', { msg: diffNote.message ?? '' })}
                </Notice>
              ) : null}
              {files.length ? (
                <ul className="gh-pr-files">
                  {files.map((file) => {
                    const open = expanded.has(file.key)
                    const read = viewedSet.has(file.key)
                    return (
                      <li key={file.key} className="gh-pr-file" data-read={read ? '1' : undefined} data-open={open ? '1' : undefined}>
                        <Collapsible isExpanded={open} onExpandedChange={() => toggleFile(file.key)}>
                          <CollapsibleHeader
                            className="gh-pr-file__head"
                            tone={read ? 'muted' : 'emphasized'}
                            aria-label={`${open ? t('github.pr.detail.collapse') : t('github.pr.detail.expand')} ${file.path}`}
                            data-testid={`gh-pr-file-toggle-${file.path}`}
                            icon={<FileTypeIcon name={file.path} size={12} />}
                            accessory={<DiffStat added={file.additions} removed={file.deletions} />}
                            actions={
                              <Checkbox
                                isSelected={read}
                                onChange={(on) => setViewed((prev) => toggleViewed(prev, file.key, on))}
                                data-testid={`gh-pr-file-read-${file.path}`}
                              >
                                {t('github.pr.detail.read')}
                              </Checkbox>
                            }
                          >
                            <MiddleTruncate value={file.path} />
                          </CollapsibleHeader>
                          <CollapsiblePanel className="gh-pr-file__diffview">
                            {open ? (
                              file.patch ? (
                                <DiffView patch={file.patch} title={file.path} embedded showFileHeader={false} lang={lang} />
                              ) : (
                                note(t('github.pr.detail.diffMissing'))
                              )
                            ) : null}
                          </CollapsiblePanel>
                        </Collapsible>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                note(t('github.pr.detail.filesNone'))
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
