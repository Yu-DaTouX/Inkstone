import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { Badge, Button, Checkbox, IconButton, Notice, Spinner, StatusDot } from '../../ui'
import { DiffView } from '../diff'
import { Markdown } from '../session/Markdown'
import {
  ageOf,
  normalizePrDetail,
  parseViewed,
  serializeViewed,
  toggleViewed,
  viewedCount,
  type PrCheckItem,
  type PrDetail,
  type PrRow,
  type PrState
} from './pr-model'

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

interface PullRequestDetailProps {
  cwd: string
  repo: string
  row: PrRow
  onBack: () => void
}

export function PullRequestDetail({ cwd, repo, row, onBack }: PullRequestDetailProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [diffNote, setDiffNote] = useState<{ kind: 'truncated' | 'error'; message?: string } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [viewed, setViewed] = useState<string[]>(() => parseViewed(readViewedRaw()))
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setDiffNote(null)
    setDetail(null)
    setExpanded(new Set())
    const github = window.yan?.github
    if (!github) {
      setError(t('github.pr.bridgeMissing'))
      setLoading(false)
      return undefined
    }
    void (async () => {
      try {
        const [detailRes, diffRes] = await Promise.all([github.detail(cwd, row.number), github.diff(cwd, row.number)])
        if (!alive) return
        if (!detailRes.ok || !detailRes.pr) {
          setError(detailRes.error || t('github.pr.detail.failed', { msg: '' }))
          return
        }
        setDetail(normalizePrDetail(detailRes.pr, { repo, diff: diffRes.ok ? diffRes.patch : '' }))
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
  }, [cwd, repo, row.number, t])

  useEffect(() => {
    writeViewedRaw(serializeViewed(viewed))
  }, [viewed])

  const viewedSet = useMemo(() => new Set(viewed), [viewed])
  const files = detail?.files ?? []
  const readCount = viewedCount(viewed, files.map((file) => file.key))
  const url = detail?.url || row.url

  const when = (iso: string): string => {
    const age = ageOf(iso, Date.now())
    if (age.unit === 'now') return t('github.pr.time.now')
    if (age.unit === 'minute') return t('github.pr.time.minutes', { n: age.value })
    if (age.unit === 'hour') return t('github.pr.time.hours', { n: age.value })
    if (age.unit === 'day') return t('github.pr.time.days', { n: age.value })
    if (!age.value) return ''
    return new Date(age.value).toLocaleDateString(lang === 'en-US' ? 'en-US' : 'zh-CN')
  }

  const reviewText = (review: string): { label: string; tone: BadgeTone } | null => {
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

  const openInBrowser = (): void => {
    const github = window.yan?.github
    if (!github || !url) return
    setNotice('')
    void github.openUrl(url).then((res) => {
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

  return (
    <div className="gh-pr-detail" data-testid={`gh-pr-detail-${row.number}`}>
      <div className="gh-pr-detail__bar">
        <IconButton size="sm" variant="ghost" aria-label={t('github.pr.back')} title={t('github.pr.back')} onPress={onBack} data-testid="gh-pr-back">
          <ArrowLeft size={14} aria-hidden />
        </IconButton>
        <span className="gh-pr-detail__num">#{row.number}</span>
        <span className="gh-pr-detail__title" title={detail?.title ?? row.title}>{detail?.title ?? row.title}</span>
        <Badge tone={stateTone(detail?.state ?? row.state)}>{stateText(detail?.state ?? row.state)}</Badge>
        <Button size="sm" variant="secondary" isDisabled={!url} onPress={openInBrowser} data-testid="gh-pr-open-browser">
          <ExternalLink size={13} aria-hidden />
          {t('github.pr.openInBrowser')}
        </Button>
      </div>
      {notice ? <Notice tone="fail" compact>{notice}</Notice> : null}
      {loading && !detail ? (
        <p className="gh-pr-detail__note"><Spinner size={14} /> {t('github.pr.detail.loading')}</p>
      ) : null}
      {error ? (
        <Notice tone="fail" compact data-testid="gh-pr-detail-error">
          {t('github.pr.detail.failed', { msg: error })}
        </Notice>
      ) : null}
      {detail ? (
        <div className="gh-pr-detail__body">
          <p className="gh-pr-detail__meta">
            <span>{detail.author}</span>
            <span className="gh-pr-detail__branches" title={`${detail.head} → ${detail.base}`}>
              {detail.head} → {detail.base}
            </span>
            {detail.commitCount ? <span>{t('github.pr.detail.commits', { n: detail.commitCount })}</span> : null}
            {detail.updatedAt ? <span>{t('github.pr.detail.updated', { time: when(detail.updatedAt) })}</span> : null}
          </p>
          <section className="gh-pr-detail__section" aria-label={t('github.pr.detail.description')}>
            {detail.body ? <Markdown text={detail.body} sourceCwd={cwd} /> : <p className="gh-pr-detail__note">{t('github.pr.detail.noBody')}</p>}
          </section>
          <section className="gh-pr-detail__section" aria-label={t('github.pr.detail.checks')}>
            <h3 className="gh-pr-detail__heading">{t('github.pr.detail.checks')}</h3>
            {detail.checkItems.length ? (
              <ul className="gh-pr-checks">
                {detail.checkItems.map((item) => (
                  <li key={`${item.name}:${item.detail}`} className="gh-pr-check" data-state={checkTone(item)}>
                    <StatusDot kind={checkTone(item)} />
                    <span className="gh-pr-check__name" title={item.name}>{item.name}</span>
                    <span className="gh-pr-check__state">{item.detail}</span>
                    {item.url ? (
                      <button type="button" className="gh-pr-check__link" onClick={() => void window.yan?.github?.openUrl(item.url)}>
                        {t('github.pr.checks.details')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="gh-pr-detail__note">{t('github.pr.detail.noChecks')}</p>
            )}
          </section>
          <section className="gh-pr-detail__section" aria-label={t('github.pr.detail.files')}>
            <h3 className="gh-pr-detail__heading">
              {t('github.pr.detail.files')}
              {files.length ? <span className="gh-pr-detail__count" data-testid="gh-pr-files-read">{t('github.pr.detail.readOf', { read: readCount, total: files.length })}</span> : null}
            </h3>
            {diffNote?.kind === 'truncated' ? (
              <Notice tone="ask" compact>{t('github.pr.detail.diffTruncated')}</Notice>
            ) : null}
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
                      <div className="gh-pr-file__head">
                        <IconButton
                          size="sm"
                          variant="ghost"
                          aria-label={open ? t('github.pr.detail.collapse') : t('github.pr.detail.expand')}
                          aria-expanded={open}
                          onPress={() => toggleFile(file.key)}
                          data-testid={`gh-pr-file-toggle-${file.path}`}
                        >
                          <ChevronRight size={14} aria-hidden className="gh-pr-file__chev" />
                        </IconButton>
                        <button type="button" className="gh-pr-file__path" title={file.path} onClick={() => toggleFile(file.key)}>
                          {file.path}
                        </button>
                        <span className="gh-pr-file__diff">
                          <span className="gh-pr-add">+{file.additions}</span>
                          <span className="gh-pr-del">-{file.deletions}</span>
                        </span>
                        <Checkbox
                          isSelected={read}
                          onChange={(on) => setViewed((prev) => toggleViewed(prev, file.key, on))}
                          data-testid={`gh-pr-file-read-${file.path}`}
                        >
                          {t('github.pr.detail.read')}
                        </Checkbox>
                      </div>
                      {open ? (
                        file.patch ? (
                          <div className="gh-pr-file__diffview">
                            <DiffView patch={file.patch} embedded showFileHeader={false} lang={lang} />
                          </div>
                        ) : (
                          <p className="gh-pr-detail__note">{t('github.pr.detail.diffMissing')}</p>
                        )
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="gh-pr-detail__note">{t('github.pr.detail.filesNone')}</p>
            )}
          </section>
          <section className="gh-pr-detail__section" aria-label={t('github.pr.detail.timeline')}>
            <h3 className="gh-pr-detail__heading">{t('github.pr.detail.timeline')}</h3>
            {detail.timeline.length ? (
              <ol className="gh-pr-timeline">
                {detail.timeline.map((item) => {
                  const review = reviewText(item.review)
                  return (
                    <li key={item.id} className="gh-pr-event" data-kind={item.kind}>
                      <div className="gh-pr-event__head">
                        <span className="gh-pr-event__author">{item.author}</span>
                        {review ? <Badge tone={review.tone}>{review.label}</Badge> : null}
                        <span className="gh-pr-event__time">{when(item.at)}</span>
                      </div>
                      {item.body ? (
                        <div className="gh-pr-event__body">
                          <Markdown text={item.body} sourceCwd={cwd} />
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            ) : (
              <p className="gh-pr-detail__note">{t('github.pr.detail.timelineEmpty')}</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
