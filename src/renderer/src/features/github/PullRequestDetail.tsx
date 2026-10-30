import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type UIEvent } from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, FileDiff, Pencil, RefreshCw } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { serializeLineComment } from '../preview/code-line-comment'
import type { DiffAnnotate } from '../diff'
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleHeader,
  CollapsiblePanel,
  Dialog,
  DialogTrigger,
  DiffStat,
  IconButton,
  MiddleTruncate,
  Notice,
  Popover,
  SegmentedControl,
  Separator,
  Skeleton,
  Spinner,
  StatusDot,
  TextField,
  Tooltip,
  TooltipHint,
  TooltipTrigger
} from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { DiffView } from '../diff'
import type { PrDetailTab } from '../../state/right-panel'
import {
  ageOf,
  normalizePrDetail,
  parseViewed,
  serializeViewed,
  toggleViewed,
  viewedCount,
  type PrChecks,
  type PrDetail,
  type PrState,
  type PrTimelineItem
} from './pr-model'
import { prDetailText } from './pr-detail-text'
import { prActionText } from './pr-action-text'
import { addPendingComment, inferCommentSide, nextCondensed, parsePending, pendingStorageKey, type PendingComment } from './pr-actions-model'
import { PrActionStatus, usePrAction } from './PrActionStatus'
import { PrActionBar } from './PrDetailActions'
import { EditFooter } from './PrEditors'
import { ChecksList, CommentCard, FloatingComment, PrSummaryTab } from './PrSummaryTab'
import './pull-requests.css'
import './pr-actions.css'

const VIEWED_KEY = 'inkstone.github.pr.viewed'
const TABS: readonly PrDetailTab[] = ['summary', 'timeline', 'code']

function readStored(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    return
  }
}

type CommentTarget = 'review' | 'agent'
type BadgeTone = 'neutral' | 'accent' | 'ok' | 'run' | 'ask' | 'stall' | 'fail'

export function stateTone(state: PrState): BadgeTone {
  if (state === 'merged') return 'accent'
  if (state === 'closed') return 'fail'
  if (state === 'draft') return 'neutral'
  return 'ok'
}

function checksDot(checks: PrChecks): 'ok' | 'pending' | 'fail' | 'idle' {
  if (checks.state === 'pass') return 'ok'
  if (checks.state === 'fail') return 'fail'
  if (checks.state === 'pending') return 'pending'
  return 'idle'
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

function Branches({ base, head, receives }: { base: string; head: string; receives: string }): ReactElement {
  return (
    <span className="gh-prd__branches ui-num">
      <MiddleTruncate className="gh-prd__ref" value={base} />
      <ArrowLeft size={12} aria-label={receives} className="gh-prd__arrow" />
      <MiddleTruncate className="gh-prd__ref gh-prd__ref--head" value={head} />
    </span>
  )
}

function DetailSkeleton(): ReactElement {
  return (
    <div className="gh-prd__skeleton" aria-busy="true" data-testid="gh-pr-detail-skeleton">
      <Skeleton width="72%" height={20} />
      <Skeleton width="45%" />
      <Skeleton width="60%" />
      <Skeleton shape="rect" height={28} width="50%" />
      <Skeleton width="90%" />
      <Skeleton width="84%" />
      <Skeleton width="66%" />
    </div>
  )
}

function readViewedRaw(): string | null {
  return readStored(VIEWED_KEY)
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
  const actText = prActionText(lang)
  const [repo, setRepo] = useState<{ name: string; url: string } | null>(null)
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [diffNote, setDiffNote] = useState<{ kind: 'truncated' | 'error'; message?: string } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [viewed, setViewed] = useState<string[]>(() => parseViewed(readViewedRaw()))
  const [notice, setNotice] = useState('')
  const action = usePrAction(cwd, () => setReload((value) => value + 1))
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [target, setTarget] = useState<CommentTarget>('review')
  const [pending, setPending] = useState<PendingComment[]>([])
  const [sideNote, setSideNote] = useState(false)
  const [mounted, setMounted] = useState<ReadonlySet<PrDetailTab>>(() => new Set([tab]))
  const [condensedByTab, setCondensedByTab] = useState<Partial<Record<PrDetailTab, boolean>>>({})
  const condensed = condensedByTab[tab] ?? false
  const scrollers = useRef<Partial<Record<PrDetailTab, HTMLDivElement | null>>>({})
  const foldRef = useRef<HTMLDivElement | null>(null)
  const condensedRowRef = useRef<HTMLDivElement | null>(null)
  const compensation = useRef<{ tab: PrDetailTab; scroller: HTMLDivElement; target: number } | null>(null)
  const pendingKey = repo?.name ? pendingStorageKey(repo.name, number) : ''

  if (!mounted.has(tab)) setMounted(new Set(mounted).add(tab))

  useLayoutEffect(() => {
    const next = compensation.current
    if (!next) return
    compensation.current = null
    if (!condensed || next.tab !== tab || scrollers.current[tab] !== next.scroller) return
    next.scroller.scrollTop = Math.max(0, next.target)
  }, [condensed, tab])

  const onScrollCapture = (event: UIEvent<HTMLDivElement>): void => {
    const scroller = scrollers.current[tab]
    if (!scroller || event.target !== scroller) return
    const previous = condensedByTab[tab] ?? false
    const result = nextCondensed({
      previous,
      top: scroller.scrollTop,
      foldHeight: foldRef.current?.scrollHeight ?? 0,
      condensedHeight: condensedRowRef.current?.scrollHeight ?? 0
    })
    if (result.condensed === previous) return
    if (result.scrollTo !== null) compensation.current = { tab, scroller, target: result.scrollTo }
    setCondensedByTab({ ...condensedByTab, [tab]: result.condensed })
  }

  useEffect(() => {
    setPending(pendingKey ? parsePending(readStored(pendingKey)) : [])
  }, [pendingKey])

  const updatePending = useCallback(
    (change: (prev: PendingComment[]) => PendingComment[]): void => {
      setPending((prev) => {
        const next = change(prev)
        if (pendingKey) writeStored(pendingKey, next.length ? JSON.stringify(next) : null)
        return next
      })
    },
    [pendingKey]
  )
  const changePending = (next: PendingComment[]): void => updatePending(() => next)

  const saveTitle = async (): Promise<void> => {
    const value = titleDraft.trim()
    if (!value || value === detail?.title) return
    const result = await action.run({ kind: 'edit', number, title: value })
    if (result?.ok) setEditingTitle(false)
  }

  const annotateFor = (path: string, patch: string): DiffAnnotate => ({
    labels: {
      add: target === 'review' ? actText.review.addPending : t('changes.annotateAdd'),
      line: (line) => t('changes.annotateLine', { line }),
      lines: (start, end) => t('changes.annotateLines', { start, end }),
      placeholder: target === 'review' ? actText.review.pendingPlaceholder : t('changes.annotatePlaceholder'),
      submit: target === 'review' ? actText.review.addPending : t('changes.annotateSubmit'),
      cancel: t('changes.annotateCancel'),
      hint: t('changes.annotateHint')
    },
    onSubmit: (annotation) => {
      if (target === 'agent') {
        const serialized = serializeLineComment({
          path,
          start: annotation.start,
          end: annotation.end,
          code: annotation.code,
          text: annotation.text,
          lang: lang === 'en-US' ? 'en-US' : 'zh-CN'
        })
        if (serialized) useStore.getState().insertIntoComposer(serialized)
        return
      }
      const side = inferCommentSide(patch, annotation.start, annotation.end, annotation.code)
      if (!side) {
        setSideNote(true)
        return
      }
      setSideNote(false)
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      updatePending((prev) => addPendingComment(prev, { path, line: annotation.end, startLine: annotation.start, side, body: annotation.text }, id))
    }
  })

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
    writeStored(VIEWED_KEY, serializeViewed(viewed))
  }, [viewed])

  const viewedSet = useMemo(() => new Set(viewed), [viewed])
  const files = detail?.files ?? []
  const annotations = useMemo(
    () => new Map(files.map((file) => [file.key, annotateFor(file.path, file.patch)] as const)),
    [files, target, lang, t, updatePending]
  )
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

  const reviewBadge = (item: PrTimelineItem): ReactNode => {
    if (item.kind !== 'review') return null
    switch (item.review) {
      case 'APPROVED':
        return <Badge tone="ok">{t('github.pr.review.approved')}</Badge>
      case 'CHANGES_REQUESTED':
        return <Badge tone="fail">{t('github.pr.review.changesRequested')}</Badge>
      case 'COMMENTED':
        return <Badge>{t('github.pr.review.commented')}</Badge>
      case 'DISMISSED':
        return <Badge>{t('github.pr.review.dismissed')}</Badge>
      case 'PENDING':
        return <Badge tone="ask">{t('github.pr.review.pending')}</Badge>
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

  const fileStat = detail ? (
    <span className="gh-prd__stat ui-num" aria-label={text.files(detail.changedFiles)}>
      <FileDiff size={12} aria-hidden />
      <span>{detail.changedFiles}</span>
      <DiffStat added={detail.additions} removed={detail.deletions} />
    </span>
  ) : null

  const tabBody = (which: PrDetailTab): ReactNode => {
    if (!detail) return null
    if (which === 'summary') {
      return (
        <PrSummaryTab
          cwd={cwd}
          detail={detail}
          dText={text}
          text={actText}
          action={action}
          when={when}
          reviewBadge={reviewBadge}
          openExternal={openExternal}
          checksDetailsLabel={t('github.pr.checks.details')}
          checksEmpty={t('github.pr.detail.noChecks')}
          bodyEmpty={t('github.pr.detail.noBody')}
        />
      )
    }
    if (which === 'timeline') {
      return detail.timeline.length ? (
        <ol className="gh-pr-timeline" data-testid="gh-pr-timeline">
          {detail.timeline.map((item) =>
            item.kind === 'commit' ? (
              <li key={item.id} className="gh-pr-event" data-kind="commit">
                <div className="gh-pr-event__head">
                  <Avatar name={item.author || '?'} />
                  <span className="gh-pr-event__author">{item.author}</span>
                  <Badge>
                    {text.commit} <span className="ui-num">{item.review}</span>
                  </Badge>
                  <span className="gh-pr-event__time">{when(item.at)}</span>
                </div>
                {item.body ? <p className="gh-prd__commit">{item.body}</p> : null}
              </li>
            ) : (
              <CommentCard key={item.id} item={item} cwd={cwd} when={when} reviewBadge={reviewBadge(item)} action={action} text={actText} number={number} />
            )
          )}
        </ol>
      ) : (
        note(t('github.pr.detail.timelineEmpty'))
      )
    }
    return (
      <section className="gh-prd__section" aria-label={t('github.pr.detail.files')}>
        <h3 className="gh-prd__heading">
          {t('github.pr.detail.files')}
          {files.length ? (
            <span className="gh-pr-detail__count" data-testid="gh-pr-files-read">
              {t('github.pr.detail.readOf', { read: readCount, total: files.length })}
            </span>
          ) : null}
        </h3>
        <div className="gh-pr-act__target" data-testid="gh-pr-comment-target">
          <SegmentedControl<CommentTarget>
            label={actText.review.target}
            value={target}
            onChange={setTarget}
            options={[
              { value: 'review', label: actText.review.targetReview, testId: 'gh-pr-target-review' },
              { value: 'agent', label: actText.review.targetAgent, testId: 'gh-pr-target-agent' }
            ]}
          />
          {pending.length ? <Badge tone="accent">{actText.review.pending(pending.length)}</Badge> : null}
          <span className="gh-pr-act__hint ui-meta-text">{actText.review.targetHint}</span>
        </div>
        {sideNote ? <Notice tone="ask" compact>{actText.review.sideUnknown}</Notice> : null}
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
                          <DiffView patch={file.patch} title={file.path} embedded showFileHeader={false} lang={lang} annotate={annotations.get(file.key)} />
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
    )
  }

  return (
    <div className="gh-prd" data-testid={`gh-pr-detail-${number}`} data-condensed={condensed ? '1' : undefined}>
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
              className="gh-prd__crumb ui-num"
              isDisabled={!url}
              trailingIcon={<ExternalLink size={12} aria-hidden />}
              onPress={() => openExternal(url)}
              data-testid="gh-pr-open-browser"
            >
              #{number}
            </Button>
          </Tip>
          <span className="gh-prd__spacer" />
          {detail ? (
            <Badge tone={stateTone(detail.state)} className="gh-prd__state" data-testid="gh-pr-state">
              {stateText(detail.state)}
            </Badge>
          ) : null}
          <IconButton size="sm" variant="ghost" aria-label={text.refresh} tooltip={text.refresh} onPress={() => setReload((value) => value + 1)} data-testid="gh-pr-detail-refresh">
            {loading ? <Spinner size="xs" /> : <RefreshCw size={14} aria-hidden />}
          </IconButton>
        </div>
        <div className="gh-prd__fold gh-prd__fold--condensed" data-open={condensed ? '1' : undefined}>
          <div ref={condensedRowRef} className="gh-prd__fold-inner" inert={!condensed} data-testid="gh-pr-condensed">
            {detail ? (
              <div className="gh-prd__compact">
                <span className="gh-prd__compact-title">
                  <span className="ui-meta-num">#{number}</span>
                  <span className="gh-prd__compact-name">{title}</span>
                </span>
                <span className="gh-prd__compact-meta ui-meta-text">
                  <span className="gh-prd__who">
                    <Avatar name={detail.author || '?'} />
                    <span className="gh-prd__dim">{when(detail.updatedAt)}</span>
                  </span>
                  <Separator orientation="vertical" className="gh-prd__rule" />
                  <Branches base={detail.base} head={detail.head} receives={text.receives} />
                  <Separator orientation="vertical" className="gh-prd__rule" />
                  {fileStat}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="gh-prd__fold" data-open={condensed ? undefined : '1'}>
          <div ref={foldRef} className="gh-prd__fold-inner" inert={condensed} data-testid="gh-pr-expanded">
            <div className="gh-prd__expanded">
              {editingTitle && detail ? (
                <div className="gh-pr-act__form" data-testid="gh-pr-title-editor">
                  <TextField
                    aria-label={actText.edit.title}
                    value={titleDraft}
                    onChange={setTitleDraft}
                    autoFocus
                    isDisabled={action.busy}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingTitle(false)
                      if (event.key === 'Enter') void saveTitle()
                    }}
                  />
                  <EditFooter
                    text={actText.edit}
                    busy={action.busy}
                    canSave={!!titleDraft.trim() && titleDraft.trim() !== detail.title}
                    onSave={() => void saveTitle()}
                    onCancel={() => setEditingTitle(false)}
                    testId="gh-pr-title-save"
                  />
                </div>
              ) : title ? (
                <div className="gh-pr-act__title-row">
                  <h2 className="gh-prd__title">{title}</h2>
                  {detail ? (
                    <IconButton
                      size="xs"
                      variant="ghost"
                      aria-label={`${actText.edit.edit} ${actText.edit.title}`}
                      tooltip={actText.edit.edit}
                      isDisabled={action.busy}
                      onPress={() => {
                        action.reset()
                        setTitleDraft(detail.title)
                        setEditingTitle(true)
                      }}
                      data-testid="gh-pr-title-edit"
                    >
                      <Pencil size={12} aria-hidden />
                    </IconButton>
                  ) : null}
                </div>
              ) : null}
              {detail ? (
                <>
                  <div className="gh-prd__meta">
                    <Avatar name={detail.author || '?'} />
                    <span className="gh-prd__author">{detail.author}</span>
                    {updated ? <span className="gh-prd__dim">· {updated}</span> : null}
                    <CopyCommand value={`gh pr checkout ${number}`} label={text.copyCheckout} copiedLabel={text.copied} />
                  </div>
                  <div className="gh-prd__refs">
                    <Branches base={detail.base} head={detail.head} receives={text.receives} />
                    {fileStat}
                  </div>
                </>
              ) : loading ? (
                <DetailSkeleton />
              ) : null}
            </div>
          </div>
        </div>
        {detail ? (
          <PrActionBar
            cwd={cwd}
            detail={detail}
            text={actText}
            action={action}
            pending={pending}
            onPendingChange={changePending}
            onRefresh={() => setReload((value) => value + 1)}
          />
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
          <DialogTrigger>
            <Button size="xs" variant="ghost" className="gh-prd__checks" data-testid="gh-pr-checks-line" aria-label={checksLabel(detail.checks)}>
              <StatusDot kind={checksDot(detail.checks)} />
              <span>{checksLabel(detail.checks)}</span>
            </Button>
            <Popover variant="panel" placement="bottom end" className="gh-pr-checks-pop">
              <Dialog aria-label={t('github.pr.detail.checks')} showClose={false} body="flush">
                {detail.checkItems.length ? (
                  <ChecksList items={detail.checkItems} detailsLabel={t('github.pr.checks.details')} onOpen={openExternal} />
                ) : (
                  <span className="ui-meta-text">{text.noChecks}</span>
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
        ) : null}
      </nav>
      {notice ? <Notice tone="fail" compact className="gh-prd__notice">{notice}</Notice> : null}
      <PrActionStatus controller={action} text={actText.result} onRefresh={() => setReload((value) => value + 1)} className="gh-prd__notice" />
      {error ? (
        <Notice tone="fail" compact className="gh-prd__notice" data-testid="gh-pr-detail-error">
          {t('github.pr.detail.failed', { msg: error })}
        </Notice>
      ) : null}
      <div className="gh-prd__main" onScrollCapture={onScrollCapture}>
        {detail
          ? TABS.filter((which) => mounted.has(which)).map((which) => (
              <div
                key={which}
                ref={(node) => {
                  scrollers.current[which] = node
                }}
                className="gh-prd__body"
                hidden={which !== tab}
                data-tab={which}
              >
                {tabBody(which)}
              </div>
            ))
          : null}
        {detail && tab !== 'code' ? <FloatingComment number={number} action={action} text={actText} /> : null}
      </div>
    </div>
  )
}
