import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { FileDiff, GitCommitHorizontal, GitPullRequest, RefreshCw, Send, Upload } from 'lucide-react'
import type { GitDiffResult } from '../../../../shared/git'
import {
  REVIEW_MAX_ANNOTATION_BODY,
  type ReviewAnnotation,
  type ReviewChangeSet,
  type ReviewChangeSource,
  type ReviewFinding,
  type ReviewGhStatusView,
  type ReviewGitOutcome,
  type ReviewRun
} from '../../../../shared/review'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Notice,
  PageHeader,
  Radio,
  RadioGroup,
  Select,
  TextArea,
  TextField,
  cx
} from '../../ui'
import { DiffView } from '../diff'
import {
  ReviewRequestGate,
  annotationIsStale,
  changeSetUsable,
  classifyGitOutcome,
  ghStatusDegrade,
  groupAnnotationsByPath,
  guardedLoad,
  parseFindingsText,
  reviewDiffQueryForChangeSet,
  reviewLineAnchors,
  reviewOwnerKey,
  reviewQueryForSource,
  reviewSourceOptions,
  suggestedCommitMessage,
  suggestedPullRequestTitle,
  validateReviewAnchor,
  type ReviewLineAnchors,
  type ReviewOwner,
  type ReviewQueryExtras
} from './review-model'
import {
  addAnnotation,
  clearAnnotations,
  commitChanges,
  createPullRequest,
  fetchAnnotationList,
  fetchChangeSet,
  fetchDiff,
  fetchGhStatus,
  pushChanges,
  removeAnnotation,
  requestAnnotationTask,
  resolveReviewBridge,
  startReviewRun,
  updateAnnotation
} from './review-client'
import { reviewText, type ReviewUiText } from './review-text'
import { fileStatusLabel } from '../../lib/file-status'
import './review-page.css'

export type ReviewFindingsLoader = (changeSet: ReviewChangeSet, run: ReviewRun) => Promise<{ ok: boolean; text?: string; error?: string }>

export interface ReviewPageProps {
  bridge?: import('../../../../shared/review').ReviewBridge | null
  owner?: Partial<ReviewOwner>
  loadFindings?: ReviewFindingsLoader
  lang?: string
  initialSource?: ReviewChangeSource
}

type Status = 'idle' | 'loading' | 'ready' | 'error'
type FindingsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

interface AnnotationEditorState {
  id?: string
  side: ReviewAnnotation['side']
  lineStart: string
  lineEnd: string
  body: string
}

const BLANK_EDITOR: AnnotationEditorState = { side: 'new', lineStart: '', lineEnd: '', body: '' }

function severityText(text: ReviewUiText, severity: ReviewFinding['severity']): string {
  return severity === 'high' ? text.severityHigh : severity === 'medium' ? text.severityMedium : text.severityLow
}

function severityTone(severity: ReviewFinding['severity']): 'fail' | 'stall' | 'neutral' {
  return severity === 'high' ? 'fail' : severity === 'medium' ? 'stall' : 'neutral'
}

export interface ReviewFindingsPanelProps {
  text: ReviewUiText
  status: FindingsStatus
  findings: ReviewFinding[]
  error: string
  run: ReviewRun | null
  runError: string
}

export function ReviewFindingsPanel({ text, status, findings, error, run, runError }: ReviewFindingsPanelProps): ReactElement {
  return (
    <section className="review-findings" aria-label={text.findingsTitle} data-testid="review-findings">
      <header className="review-col-head">
        <h3 className="review-col-title">{text.findingsTitle}</h3>
        {status === 'ready' ? <span className="review-col-count">{text.findingsCount(findings.length)}</span> : null}
      </header>

      {run?.code ? (
        <p className="review-run-code" data-testid="review-run-code" data-ok={run.ok ? '1' : '0'}>
          <Badge tone={run.ok ? 'accent' : 'fail'}>{run.code}</Badge>
          <span>{run.ok ? text.runStarted(run.code) : text.runFailed(run.error ?? '')}</span>
        </p>
      ) : null}
      {run && !run.ok && run.requiredWiring && run.requiredWiring.length > 0 ? (
        <Notice tone="stall" compact title={text.runWiring} className="review-run-wiring">
          {run.requiredWiring.join('；')}
        </Notice>
      ) : null}
      {runError ? <Notice tone="fail" compact>{text.runFailed(runError)}</Notice> : null}

      {status === 'loading' ? (
        <p className="review-col-hint">{text.findingsLoading}</p>
      ) : status === 'unavailable' ? (
        <p className="review-col-hint" role="note" data-testid="review-findings-unavailable">
          {text.findingsUnavailable}
        </p>
      ) : status === 'error' ? (
        <Notice tone="fail" compact>
          {text.findingsError(error)}
        </Notice>
      ) : findings.length === 0 ? (
        <EmptyState size="sm" title={text.findingsEmpty} />
      ) : (
        <ul className="review-finding-list">
          {findings.map((finding, index) => (
            <li key={`${finding.path}:${finding.line ?? 0}:${index}`} className="review-finding" data-severity={finding.severity}>
              <div className="review-finding-head">
                <Badge tone={severityTone(finding.severity)}>{severityText(text, finding.severity)}</Badge>
                <span className="review-finding-path">
                  {finding.path}
                  {finding.line ? `:${finding.line}` : ''}
                </span>
              </div>
              <p className="review-finding-message">{finding.message}</p>
              {finding.suggestion ? (
                <p className="review-finding-suggestion">
                  <span>{text.suggestion}</span> {finding.suggestion}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface ReviewAnnotationListProps {
  text: ReviewUiText
  annotations: ReviewAnnotation[]
  changeSetRevision?: string
  busy?: boolean
  onEdit(annotation: ReviewAnnotation): void
  onRemove(annotation: ReviewAnnotation): void
}

export function ReviewAnnotationList({ text, annotations, changeSetRevision, busy, onEdit, onRemove }: ReviewAnnotationListProps): ReactElement {
  return (
    <div className="review-annotations" data-testid="review-annotations">
      <header className="review-col-head">
        <h3 className="review-col-title">{text.annotationTitle}</h3>
        <span className="review-col-count">{text.annotations(annotations.length)}</span>
      </header>
      {annotations.length === 0 ? (
        <EmptyState size="sm" title={text.annotationEmpty} />
      ) : (
        <ul className="review-annotation-list">
          {annotations.map((annotation) => {
            const stale = annotationIsStale(annotation, changeSetRevision)
            const range = annotation.lineEnd !== annotation.lineStart ? `${annotation.lineStart}-${annotation.lineEnd}` : `${annotation.lineStart}`
            return (
              <li key={annotation.id} className="review-annotation" data-stale={stale ? '1' : '0'}>
                <div className="review-annotation-head">
                  <span className="review-annotation-path">
                    {annotation.path}:{range} · {annotation.side}
                  </span>
                  {stale ? <Badge tone="stall">{text.stale}</Badge> : null}
                  <span className="review-annotation-actions">
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => onEdit(annotation)}>
                      {text.editAnnotation}
                    </Button>
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => onRemove(annotation)}>
                      {text.annotationRemove}
                    </Button>
                  </span>
                </div>
                <p className="review-annotation-body">{annotation.body}</p>
                {stale ? <p className="review-annotation-stale">{text.annotationStale}</p> : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function ReviewPage({ bridge: bridgeProp, owner: ownerProp, loadFindings, lang: langProp, initialSource }: ReviewPageProps = {}): ReactElement {
  const { lang: appLang } = useI18n()
  const lang = langProp ?? appLang
  const text = useMemo(() => reviewText(lang), [lang])

  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const models = useStore((s) => s.models)

  const activeRunner = useMemo(
    () => runners.find((runner) => runner.id === activeRunnerId || runner.runId === activeRunnerId),
    [runners, activeRunnerId]
  )
  const derivedOwner = useMemo<ReviewOwner>(
    () => ({
      key: activeRunner ? `run:${activeRunner.runId ?? activeRunner.id}` : `session:${session?.sessionId ?? 'none'}`,
      cwd: activeRunner?.cwd || session?.cwd || settings?.cwd || '',
      ...(activeRunner?.projectId ? { projectId: activeRunner.projectId } : {}),
      ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session?.sessionFile ? { sessionPath: session.sessionFile } : {}),
      active: !!session?.sessionId
    }),
    [activeRunner, session, settings]
  )
  const owner = useMemo<ReviewOwner>(() => ({ ...derivedOwner, ...ownerProp }), [derivedOwner, ownerProp])
  const ownerK = reviewOwnerKey(owner)

  const bridge = useMemo(() => resolveReviewBridge(bridgeProp), [bridgeProp])

  const csGate = useRef(new ReviewRequestGate()).current
  const diffGate = useRef(new ReviewRequestGate()).current
  const annGate = useRef(new ReviewRequestGate()).current

  const [source, setSource] = useState<ReviewChangeSource>(initialSource ?? 'uncommitted')
  const [base, setBase] = useState('')
  const [branch, setBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState('')
  const [tick, setTick] = useState(0)

  const [changeSet, setChangeSet] = useState<ReviewChangeSet | null>(null)
  const [csStatus, setCsStatus] = useState<Status>('idle')
  const [csError, setCsError] = useState('')

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [patch, setPatch] = useState('')
  const [patchMeta, setPatchMeta] = useState<Pick<GitDiffResult, 'truncated' | 'binary'>>({ truncated: false, binary: false })
  const [patchStatus, setPatchStatus] = useState<Status>('idle')
  const [patchError, setPatchError] = useState('')

  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([])
  const [annStatus, setAnnStatus] = useState<Status>('idle')
  const [annError, setAnnError] = useState('')
  const [annNotice, setAnnNotice] = useState('')

  const [editor, setEditor] = useState<AnnotationEditorState>(BLANK_EDITOR)
  const [editorError, setEditorError] = useState('')
  const [annBusy, setAnnBusy] = useState(false)

  const [modelSel, setModelSel] = useState('')
  const [run, setRun] = useState<ReviewRun | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState('')

  const [findings, setFindings] = useState<ReviewFinding[]>([])
  const [findingsStatus, setFindingsStatus] = useState<FindingsStatus>('idle')
  const [findingsError, setFindingsError] = useState('')

  const [task, setTask] = useState<{ message: string; count: number } | null>(null)
  const [taskBusy, setTaskBusy] = useState(false)
  const [taskError, setTaskError] = useState('')
  const [taskCopied, setTaskCopied] = useState(false)

  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [pushOpen, setPushOpen] = useState(false)
  const [pushRemote, setPushRemote] = useState('')
  const [pushBranch, setPushBranch] = useState('')
  const [pushUpstream, setPushUpstream] = useState(true)
  const [prOpen, setPrOpen] = useState(false)
  const [prRemote, setPrRemote] = useState('')
  const [prBase, setPrBase] = useState('')
  const [prHead, setPrHead] = useState('')
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  const [gh, setGh] = useState<ReviewGhStatusView | null>(null)
  const [ghLoading, setGhLoading] = useState(false)
  const [gitBusy, setGitBusy] = useState(false)
  const [gitNotice, setGitNotice] = useState<{ ok: boolean; recoverable: boolean; message: string } | null>(null)

  const extras = useMemo<ReviewQueryExtras>(
    () => ({
      ...(source === 'branch' && base ? { base } : {}),
      ...(source === 'branch' && branch ? { branch } : {}),
      ...(source === 'worktree' && worktreePath ? { worktreePath } : {})
    }),
    [source, base, branch, worktreePath]
  )
  const extrasK = `${extras.base ?? ''}|${extras.branch ?? ''}|${extras.worktreePath ?? ''}`

  useEffect(() => {
    csGate.invalidate()
    diffGate.invalidate()
    annGate.invalidate()
    setChangeSet(null)
    setSelectedPath(null)
    setPatch('')
    setPatchStatus('idle')
    setAnnotations([])
    setAnnStatus('idle')
    setAnnNotice('')
    setEditor(BLANK_EDITOR)
    setRun(null)
    setFindings([])
    setFindingsStatus('idle')
    setTask(null)

    if (!bridge) {
      setCsStatus('error')
      setCsError(text.diffUnavailable)
      return
    }
    if (!owner.cwd) {
      setCsStatus('error')
      setCsError(text.loadFailed('cwd'))
      return
    }
    const id = csGate.next()
    setCsStatus('loading')
    setCsError('')
    void guardedLoad(
      () => csGate.isCurrent(id),
      () => fetchChangeSet(bridge, reviewQueryForSource(source, owner, extras))
    ).then((result) => {
      if (result.stale) return
      if (result.error) {
        setCsStatus('error')
        setCsError(result.error)
        return
      }
      setChangeSet(result.value ?? null)
      setCsStatus('ready')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerK, source, extrasK, tick, bridge])

  useEffect(() => {
    if (!bridge || !changeSet || !changeSet.ok) return
    const id = annGate.next()
    setAnnStatus('loading')
    setAnnError('')
    void guardedLoad(
      () => annGate.isCurrent(id),
      () => fetchAnnotationList(bridge, changeSet.id, changeSet.scopeKey)
    ).then((result) => {
      if (result.stale) return
      if (result.error) {
        setAnnStatus('error')
        setAnnError(result.error)
        return
      }
      const value = result.value
      if (!value) return
      if (!value.ok) {
        setAnnStatus('error')
        setAnnError(value.error ?? '')
        return
      }
      setAnnotations(value.annotations)
      setAnnStatus('ready')
    })
  }, [bridge, changeSet, tick])

  useEffect(() => {
    if (!bridge || !changeSet || !changeSet.ok || !selectedPath) {
      setPatch('')
      setPatchStatus('idle')
      return
    }
    const id = diffGate.next()
    setPatchStatus('loading')
    setPatch('')
    setPatchError('')
    void guardedLoad(
      () => diffGate.isCurrent(id),
      () => {
        const query = reviewDiffQueryForChangeSet(changeSet, owner, selectedPath)
        return fetchDiff(bridge, query ?? { source: changeSet.source, cwd: changeSet.cwd, path: selectedPath })
      }
    ).then((result) => {
      if (result.stale) return
      if (result.error) {
        setPatchStatus('error')
        setPatchError(result.error)
        return
      }
      const value = result.value
      if (!value) return
      if (!value.ok) {
        setPatchStatus('error')
        setPatchError(value.error ?? '')
        return
      }
      setPatch(value.patch)
      setPatchMeta({ truncated: value.truncated === true, binary: value.binary === true })
      setPatchStatus('ready')
    })
  }, [bridge, changeSet, owner, selectedPath, tick])

  const counts = useMemo(() => groupAnnotationsByPath(annotations), [annotations])
  const anchors = useMemo(() => reviewLineAnchors(patch), [patch])
  const currentAnnotations = useMemo(
    () => (selectedPath ? (counts.get(selectedPath) ?? []) : []),
    [counts, selectedPath]
  )
  const usable = changeSetUsable(changeSet)
  const options = useMemo(() => reviewSourceOptions(owner), [owner])
  const modelKey = modelSel || (session?.model ? `${session.model.provider}/${session.model.id}` : '')

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  const reloadAnnotations = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    const id = annGate.next()
    const result = await guardedLoad(
      () => annGate.isCurrent(id),
      () => fetchAnnotationList(bridge, changeSet.id, changeSet.scopeKey)
    )
    if (result.stale || !result.value?.ok) return
    setAnnotations(result.value.annotations)
    setAnnStatus('ready')
  }, [bridge, changeSet, annGate])

  const submitAnnotation = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok || !selectedPath) return
    const lineStart = Number(editor.lineStart)
    const lineEnd = editor.lineEnd === '' ? lineStart : Number(editor.lineEnd)
    const check = validateReviewAnchor(anchors, editor.side, lineStart, lineEnd)
    if (!check.ok) {
      setEditorError(text.annotationError(check.error ?? ''))
      return
    }
    const body = editor.body.trim()
    if (!body) {
      setEditorError(text.annotationError('body'))
      return
    }
    if (body.length > REVIEW_MAX_ANNOTATION_BODY) {
      setEditorError(text.annotationError('tooLong'))
      return
    }
    setAnnBusy(true)
    setEditorError('')
    try {
      const result = editor.id
        ? await updateAnnotation(bridge, changeSet.id, changeSet.scopeKey, editor.id, { body, side: editor.side, lineStart, lineEnd })
        : await addAnnotation(bridge, {
            changeSetId: changeSet.id,
            scopeKey: changeSet.scopeKey,
            path: selectedPath,
            side: editor.side,
            lineStart,
            lineEnd,
            body,
            anchorRevision: changeSet.revision
          })
      if (!result.ok) {
        setEditorError(text.annotationError(result.error ?? ''))
        return
      }
      if (result.annotation) {
        setAnnotations((prev) => {
          const next = prev.filter((annotation) => annotation.id !== result.annotation!.id)
          next.push(result.annotation!)
          return next
        })
        setAnnStatus('ready')
      } else {
        await reloadAnnotations()
      }
      setEditor(BLANK_EDITOR)
      setAnnNotice(text.annotationSaved)
    } catch (error) {
      setEditorError(text.annotationError(error instanceof Error ? error.message : String(error)))
    } finally {
      setAnnBusy(false)
    }
  }, [bridge, changeSet, selectedPath, editor, anchors, annGate, reloadAnnotations, text])

  const removeAnnotationById = useCallback(
    async (annotation: ReviewAnnotation): Promise<void> => {
      if (!bridge || !changeSet || !changeSet.ok) return
      setAnnBusy(true)
      setAnnNotice('')
      try {
        const result = await removeAnnotation(bridge, changeSet.id, changeSet.scopeKey, annotation.id)
        if (!result.ok) {
          setAnnError(result.error ?? '')
          return
        }
        setAnnotations((prev) => prev.filter((item) => item.id !== annotation.id))
      } catch (error) {
        setAnnError(error instanceof Error ? error.message : String(error))
      } finally {
        setAnnBusy(false)
      }
    },
    [bridge, changeSet, text]
  )

  const clearAllAnnotations = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    setAnnBusy(true)
    setAnnNotice('')
    try {
      const result = await clearAnnotations(bridge, changeSet.id, changeSet.scopeKey)
      if (!result.ok) {
        setAnnError(result.error ?? '')
        return
      }
      setAnnotations([])
      setEditor(BLANK_EDITOR)
    } catch (error) {
      setAnnError(error instanceof Error ? error.message : String(error))
    } finally {
      setAnnBusy(false)
    }
  }, [bridge, changeSet, text])

  const startReview = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    setRunBusy(true)
    setRunError('')
    setRun(null)
    setFindings([])
    setFindingsStatus('idle')
    setFindingsError('')
    try {
      const query = reviewQueryForSource(changeSet.source, owner, extras)
      const result = await startReviewRun(bridge, {
        query,
        ...(modelKey ? { model: modelKey } : {}),
        ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
        ...(owner.sessionPath ? { sessionPath: owner.sessionPath } : {}),
        ...(owner.projectId ? { projectId: owner.projectId } : {})
      })
      setRun(result)
      if (!result.ok) return
      if (!loadFindings) {
        setFindingsStatus('unavailable')
        return
      }
      setFindingsStatus('loading')
      const loaded = await loadFindings(changeSet, result)
      if (!loaded.ok) {
        setFindingsStatus('error')
        setFindingsError(loaded.error ?? '')
        return
      }
      const parsed = parseFindingsText(loaded.text ?? '')
      if (parsed.error) {
        setFindingsStatus('error')
        setFindingsError(parsed.error)
        return
      }
      setFindings(parsed.findings)
      setFindingsStatus('ready')
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunBusy(false)
    }
  }, [bridge, changeSet, owner, extras, modelKey, loadFindings])

  const makeAnnotationTask = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    setTaskBusy(true)
    setTaskError('')
    setTask(null)
    setTaskCopied(false)
    try {
      const result = await requestAnnotationTask(bridge, reviewQueryForSource(changeSet.source, owner, extras))
      if (!result.ok || !result.message) {
        setTaskError(result.error ?? text.taskNone)
        return
      }
      setTask({ message: result.message, count: result.count ?? annotations.length })
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error))
    } finally {
      setTaskBusy(false)
    }
  }, [bridge, changeSet, owner, extras, annotations.length, text])

  const copyText = useCallback((value: string): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(value).catch(() => undefined)
  }, [])

  const runGitAction = useCallback(
    async (work: () => Promise<ReviewGitOutcome>, okMessage: string): Promise<void> => {
      setGitBusy(true)
      setGitNotice(null)
      try {
        const outcome = await work()
        const kind = classifyGitOutcome(outcome)
        if (kind === 'ok') {
          setGitNotice({ ok: true, recoverable: false, message: outcome.message ?? okMessage })
        } else {
          setGitNotice({
            ok: false,
            recoverable: outcome.recoverable === true,
            message: outcome.message ?? outcome.hint ?? text.actionFailed('')
          })
        }
      } catch (error) {
        setGitNotice({ ok: false, recoverable: false, message: error instanceof Error ? error.message : String(error) })
      } finally {
        setGitBusy(false)
      }
    },
    [text]
  )

  const submitCommit = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    setCommitOpen(false)
    await runGitAction(() => commitChanges(bridge, changeSet.cwd, commitMessage.trim()), text.actionOk)
  }, [bridge, changeSet, commitMessage, runGitAction, text])

  const submitPush = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    setPushOpen(false)
    await runGitAction(
      () =>
        pushChanges(bridge, {
          cwd: changeSet.cwd,
          remote: pushRemote.trim() || null,
          branch: pushBranch.trim() || changeSet.branch || null,
          setUpstream: pushUpstream
        }),
      text.actionOk
    )
  }, [bridge, changeSet, pushRemote, pushBranch, pushUpstream, runGitAction, text])

  const openPrDialog = useCallback((): void => {
    if (!changeSet || !changeSet.ok) return
    setPrOpen(true)
    setPrRemote('')
    setPrBase(changeSet.base ?? '')
    setPrHead(changeSet.branch ?? '')
    setPrTitle(suggestedPullRequestTitle(changeSet))
    setPrBody('')
    setPrDraft(false)
    setGh(null)
    setGitNotice(null)
    if (!bridge) return
    setGhLoading(true)
    void fetchGhStatus(bridge, changeSet.cwd)
      .then((status) => setGh(status))
      .catch(() => setGh(null))
      .finally(() => setGhLoading(false))
  }, [bridge, changeSet])

  const submitPr = useCallback(async (): Promise<void> => {
    if (!bridge || !changeSet || !changeSet.ok) return
    setPrOpen(false)
    await runGitAction(
      () =>
        createPullRequest(bridge, {
          cwd: changeSet.cwd,
          base: prBase.trim(),
          head: prHead.trim() || null,
          title: prTitle.trim(),
          body: prBody,
          draft: prDraft,
          remote: prRemote.trim() || null
        }),
      text.actionOk
    )
  }, [bridge, changeSet, prBase, prHead, prTitle, prBody, prDraft, prRemote, runGitAction, text])

  const ghDegrade = ghStatusDegrade(gh)
  const prBlocked = ghDegrade !== 'ready' && ghDegrade !== 'unknown'
  const activeSource = options.find((option) => option.source === source)

  return (
    <section className="review-page" aria-label={text.title} data-testid="v3-review-page">
      <PageHeader
        className="review-head"
        title={
          <span className="review-title">
            <FileDiff size={18} aria-hidden /> {text.title}
          </span>
        }
        actions={
          <>
            <span className="review-owner" title={owner.cwd}>
              {owner.cwd || '—'}
            </span>
            <IconButton size="sm" aria-label={text.refresh} title={text.refresh} isDisabled={csStatus === 'loading'} onPress={refresh}>
              <RefreshCw size={14} aria-hidden />
            </IconButton>
          </>
        }
      />

      {owner.active === false ? <Notice tone="ask" compact>{text.activeHint}</Notice> : null}

      <div className="review-grid">
        <div className="review-col review-col--sources">
          <RadioGroup
            aria-label={text.sourceLabel}
            className="review-sources"
            value={source}
            onChange={(value) => setSource(value as ReviewChangeSource)}
          >
            {options.map((option) => (
              <Radio
                key={option.source}
                value={option.source}
                isDisabled={!option.available}
                data-testid={`review-source-${option.source}`}
                className={cx('review-source', option.available ? '' : 'review-source--off')}
              >
                {option.source === 'session'
                  ? text.sourceSession
                  : option.source === 'branch'
                    ? text.sourceBranch
                    : option.source === 'worktree'
                      ? text.sourceWorktree
                      : text.sourceUncommitted}
              </Radio>
            ))}
          </RadioGroup>

          {activeSource?.note === 'sessionShare' ? (
            <Notice tone="info" compact role="note" data-testid="review-session-note">
              {text.sessionShareNote}
            </Notice>
          ) : null}
          {source === 'branch' ? (
            <div className="review-source-extra">
              <TextField label={text.baseLabel} placeholder={text.basePlaceholder} value={base} onChange={setBase} />
              <TextField label={text.branchRefLabel} placeholder={text.branchRefPlaceholder} value={branch} onChange={setBranch} />
            </div>
          ) : null}
          {source === 'worktree' ? (
            <div className="review-source-extra">
              <TextField label={text.worktreePathLabel} value={worktreePath} onChange={setWorktreePath} />
            </div>
          ) : null}

          <div className="review-files" data-testid="review-files">
            <header className="review-col-head">
              <h3 className="review-col-title">{text.diffTitle}</h3>
              {changeSet ? <span className="review-col-count">{text.fileCount(changeSet.files.length)}</span> : null}
            </header>
            {csStatus === 'loading' ? (
              <p className="review-col-hint">{text.loading}</p>
            ) : csStatus === 'error' ? (
              <Notice tone="fail" compact>
                {text.loadFailed(csError)}
              </Notice>
            ) : !usable ? (
              <EmptyState size="sm" title={changeSet && changeSet.error === '这个目录不在 Git 仓库里' ? text.notGit : text.noChanges} />
            ) : changeSet && changeSet.files.length === 0 ? (
              <EmptyState size="sm" title={text.noChanges} />
            ) : changeSet ? (
              <>
                {changeSet.truncated ? <p className="review-col-hint">{text.truncatedList}</p> : null}
                <ListBox
                  aria-label={text.diffTitle}
                  selectionMode="single"
                  selectedKeys={selectedPath ? [selectedPath] : []}
                  onSelectionChange={(keys) => {
                    const first = [...keys][0]
                    setSelectedPath(first === undefined ? null : String(first))
                    setEditor(BLANK_EDITOR)
                    setEditorError('')
                  }}
                >
                  {changeSet.files.map((file) => (
                    <ListBoxItem key={file.path} id={file.path} textValue={file.path} data-path={file.path} className="review-file">
                      <span className="review-file-status" data-status={file.status}>{fileStatusLabel(file.status, lang)}</span>
                      <span className="review-file-path" title={file.path}>
                        {file.path}
                      </span>
                      {file.binary ? <Badge tone="neutral">bin</Badge> : null}
                      <span className="review-file-stat">
                        <span className="review-add">+{file.added}</span>
                        <span className="review-del">−{file.removed}</span>
                      </span>
                      {(counts.get(file.path)?.length ?? 0) > 0 ? <Badge tone="accent">{counts.get(file.path)!.length}</Badge> : null}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </>
            ) : null}
          </div>
        </div>

        <div className="review-col review-col--diff">
          <header className="review-col-head">
            <h3 className="review-col-title">{text.diffTitle}</h3>
            {selectedPath ? <span className="review-col-count" title={selectedPath}>{selectedPath}</span> : null}
          </header>
          {!selectedPath ? (
            <p className="review-col-hint">
              {text.selectFile}
              <br />
              {text.selectFileHint}
            </p>
          ) : patchStatus === 'loading' ? (
            <p className="review-col-hint">{text.loading}</p>
          ) : patchStatus === 'error' ? (
            <Notice tone="fail" compact>
              {text.diffUnavailable}：{patchError}
            </Notice>
          ) : patchMeta.binary ? (
            <p className="review-col-hint">{text.binary}</p>
          ) : (
            <>
              {patchMeta.truncated ? <p className="review-col-hint">{text.truncatedList}</p> : null}
              <div className="review-diff">
                <DiffView patch={patch} lang={lang} showFileHeader={false} />
              </div>
            </>
          )}

          {selectedPath && patchStatus === 'ready' && !patchMeta.binary ? (
            <AnnotationEditor
              text={text}
              editor={editor}
              error={editorError}
              busy={annBusy}
              anchors={anchors}
              onChange={(patchState) => setEditor((prev) => ({ ...prev, ...patchState }))}
              onSubmit={() => void submitAnnotation()}
              onCancel={() => {
                setEditor(BLANK_EDITOR)
                setEditorError('')
              }}
            />
          ) : null}

          {annNotice ? <p className="review-col-hint" role="status">{annNotice}</p> : null}
          {annStatus === 'error' ? (
            <Notice tone="fail" compact>
              {text.annotationError(annError)}
            </Notice>
          ) : null}
          <ReviewAnnotationList
            text={text}
            annotations={currentAnnotations}
            changeSetRevision={changeSet?.revision}
            busy={annBusy}
            onEdit={(annotation) =>
              setEditor({
                id: annotation.id,
                side: annotation.side,
                lineStart: String(annotation.lineStart),
                lineEnd: String(annotation.lineEnd),
                body: annotation.body
              })
            }
            onRemove={(annotation) => void removeAnnotationById(annotation)}
          />
          {currentAnnotations.length > 0 ? (
            <Button size="sm" variant="ghost" isDisabled={annBusy} onPress={() => void clearAllAnnotations()}>
              {text.annotationClear}
            </Button>
          ) : null}
        </div>

        <div className="review-col review-col--opinions">
          <section className="review-run" aria-label={text.startReview}>
            <header className="review-col-head">
              <h3 className="review-col-title">{text.startReview}</h3>
            </header>
            <p className="review-col-hint">{text.startReviewHint}</p>
            <Select
              aria-label={text.runModelLabel}
              label={text.runModelLabel}
              selectedKey={modelKey}
              onSelectionChange={(key) => setModelSel(String(key ?? ''))}
            >
              <ListBoxItem id="">{text.runModelDefault}</ListBoxItem>
              {models.map((model) => (
                <ListBoxItem key={`${model.provider}/${model.id}`} id={`${model.provider}/${model.id}`}>
                  {model.name || model.id}
                </ListBoxItem>
              ))}
            </Select>
            <Button
              variant="primary"
              isDisabled={!usable || runBusy}
              isPending={runBusy}
              onPress={() => void startReview()}
              data-testid="review-start"
            >
              {text.startReview}
            </Button>
            <Button
              variant="secondary"
              isDisabled={!usable || taskBusy || annotations.length === 0}
              isPending={taskBusy}
              onPress={() => void makeAnnotationTask()}
              data-testid="review-make-task"
            >
              {text.makeAnnotationTask}
            </Button>
            {taskError ? <Notice tone="fail" compact>{text.taskFailed(taskError)}</Notice> : null}
          </section>

          <ReviewFindingsPanel
            text={text}
            status={findingsStatus}
            findings={findings}
            error={findingsError}
            run={run}
            runError={runError}
          />
        </div>
      </div>

      <footer className="review-gitbar" aria-label={text.gitBarLabel}>
        <span className="review-gitbar-target" title={changeSet?.cwd ?? owner.cwd}>
          <GitCommitHorizontal size={14} aria-hidden /> {text.targetCwd}: {changeSet?.cwd ?? owner.cwd ?? '—'}
        </span>
        <div className="review-gitbar-actions">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!usable}
            title={usable ? undefined : text.gitNeedsRepo}
            onPress={() => {
              setCommitMessage(suggestedCommitMessage(changeSet!))
              setGitNotice(null)
              setCommitOpen(true)
            }}
          >
            {text.commit}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!usable}
            title={usable ? undefined : text.gitNeedsRepo}
            onPress={() => {
              setPushRemote('')
              setPushBranch(changeSet?.branch ?? '')
              setPushUpstream(true)
              setGitNotice(null)
              setPushOpen(true)
            }}
          >
            <Upload size={13} aria-hidden /> {text.push}
          </Button>
          <Button size="sm" variant="secondary" isDisabled={!usable} title={usable ? undefined : text.gitNeedsRepo} onPress={openPrDialog}>
            <GitPullRequest size={13} aria-hidden /> {text.createPr}
          </Button>
        </div>
        {gitNotice ? (
          <Notice
            tone={gitNotice.ok ? 'ok' : 'fail'}
            compact
            role="status"
            className="review-git-notice"
            data-testid="review-git-notice"
          >
            {gitNotice.ok ? text.actionOk : gitNotice.message}
            {!gitNotice.ok && gitNotice.recoverable ? ` · ${text.actionRecoverable}` : ''}
          </Notice>
        ) : null}
        {gitBusy ? <p className="review-col-hint">{text.actionRunning}</p> : null}
      </footer>

      <ModalOverlay isDismissable isOpen={commitOpen} onOpenChange={setCommitOpen}>
        <Modal>
          <Dialog title={text.commitConfirmTitle} closeLabel={text.cancel}>
            <p className="review-confirm-body">{text.commitConfirmBody}</p>
            <TextArea
              label={text.commitMessageLabel}
              placeholder={text.commitMessagePlaceholder}
              rows={4}
              value={commitMessage}
              onChange={setCommitMessage}
              data-testid="review-commit-message"
            />
            <div className="review-confirm-actions">
              <Button size="sm" variant="secondary" onPress={() => setCommitOpen(false)}>
                {text.cancel}
              </Button>
              <Button size="sm" variant="primary" isDisabled={!commitMessage.trim()} onPress={() => void submitCommit()}>
                {text.confirm}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay isDismissable isOpen={pushOpen} onOpenChange={setPushOpen}>
        <Modal>
          <Dialog title={text.pushConfirmTitle} closeLabel={text.cancel}>
            <p className="review-confirm-body">{text.pushConfirmBody}</p>
            <dl className="review-confirm-list">
              <div>
                <dt>{text.targetCwd}</dt>
                <dd>{changeSet?.cwd ?? '—'}</dd>
              </div>
              <div>
                <dt>{text.branchLabel}</dt>
                <dd>{pushBranch.trim() || changeSet?.branch || '—'}</dd>
              </div>
            </dl>
            <TextField label={text.remoteLabel} placeholder={text.remoteDefault} value={pushRemote} onChange={setPushRemote} />
            <TextField label={text.branchLabel} value={pushBranch} onChange={setPushBranch} />
            <Checkbox isSelected={pushUpstream} onChange={setPushUpstream}>
              {text.pushUpstream}
            </Checkbox>
            <div className="review-confirm-actions">
              <Button size="sm" variant="secondary" onPress={() => setPushOpen(false)}>
                {text.cancel}
              </Button>
              <Button size="sm" variant="primary" onPress={() => void submitPush()}>
                {text.confirm}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay isDismissable isOpen={prOpen} onOpenChange={setPrOpen}>
        <Modal>
          <Dialog title={text.prConfirmTitle} closeLabel={text.cancel}>
            <p className="review-confirm-body">{text.prConfirmBody}</p>
            {ghLoading ? (
              <p className="review-col-hint">{text.ghChecking}</p>
            ) : ghDegrade === 'missing' ? (
              <Notice tone="fail" compact data-testid="review-gh-missing">
                {text.ghMissing}
              </Notice>
            ) : ghDegrade === 'unauthenticated' ? (
              <Notice tone="fail" compact data-testid="review-gh-unauthenticated">
                {text.ghUnauthenticated}
              </Notice>
            ) : ghDegrade === 'unknown' && gh ? (
              <p className="review-col-hint">{text.ghUnknown}</p>
            ) : null}
            <TextField label={text.remoteLabel} placeholder={text.remoteDefault} value={prRemote} onChange={setPrRemote} />
            <TextField label={text.prBaseLabel} value={prBase} onChange={setPrBase} data-testid="review-pr-base" />
            <TextField label={text.prHeadLabel} value={prHead} onChange={setPrHead} />
            <TextField label={text.prTitleLabel} value={prTitle} onChange={setPrTitle} data-testid="review-pr-title" />
            <TextArea label={text.prBodyLabel} rows={5} value={prBody} onChange={setPrBody} />
            <Checkbox isSelected={prDraft} onChange={setPrDraft}>
              {text.prDraft}
            </Checkbox>
            <div className="review-confirm-actions">
              <Button size="sm" variant="secondary" onPress={() => setPrOpen(false)}>
                {text.cancel}
              </Button>
              <Button
                size="sm"
                variant="primary"
                isDisabled={prBlocked || !prTitle.trim() || !prBase.trim()}
                onPress={() => void submitPr()}
              >
                {text.confirm}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay isDismissable isOpen={!!task} onOpenChange={(open) => (open ? undefined : setTask(null))}>
        <Modal>
          <Dialog title={text.taskTitle} closeLabel={text.cancel}>
            <p className="review-col-hint">{text.taskHint}</p>
            {task ? (
              <>
                <p className="review-col-count">{text.taskCount(task.count)}</p>
                <pre className="review-task-message" data-testid="review-task-message">
                  {task.message}
                </pre>
                <div className="review-confirm-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      copyText(task.message)
                      setTaskCopied(true)
                    }}
                  >
                    <Send size={13} aria-hidden /> {taskCopied ? text.taskCopied : text.taskCopy}
                  </Button>
                  <Button size="sm" variant="primary" onPress={() => setTask(null)}>
                    {text.cancel}
                  </Button>
                </div>
              </>
            ) : null}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  )
}

interface AnnotationEditorProps {
  text: ReviewUiText
  editor: AnnotationEditorState
  error: string
  busy: boolean
  anchors: ReviewLineAnchors
  onChange(patch: Partial<AnnotationEditorState>): void
  onSubmit(): void
  onCancel(): void
}

function AnnotationEditor({ text, editor, error, busy, anchors, onChange, onSubmit, onCancel }: AnnotationEditorProps): ReactElement {
  return (
    <form
      className="review-editor"
      data-testid="review-annotation-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="review-editor-head">{editor.id ? text.editAnnotation : text.newAnnotation}</div>
      <div className="review-editor-row">
        <Select aria-label={text.sideLabel} label={text.sideLabel} selectedKey={editor.side} onSelectionChange={(key) => onChange({ side: String(key) as ReviewAnnotation['side'] })}>
          <ListBoxItem id="new">{text.sideNew}</ListBoxItem>
          <ListBoxItem id="old">{text.sideOld}</ListBoxItem>
          <ListBoxItem id="file">{text.sideFile}</ListBoxItem>
        </Select>
        <TextField
          label={text.lineStartLabel}
          value={editor.lineStart}
          isDisabled={editor.side === 'file'}
          onChange={(value) => onChange({ lineStart: value })}
          data-testid="review-line-start"
        />
        <TextField
          label={text.lineEndLabel}
          value={editor.lineEnd}
          isDisabled={editor.side === 'file'}
          onChange={(value) => onChange({ lineEnd: value })}
          data-testid="review-line-end"
        />
      </div>
      {editor.side !== 'file' ? (
        <p className="review-editor-anchors" data-testid="review-anchor-range">
          {editor.side === 'old' ? anchors.minOld : anchors.minNew}–{editor.side === 'old' ? anchors.maxOld : anchors.maxNew}
        </p>
      ) : null}
      <TextArea
        label={text.annotationBodyLabel}
        placeholder={text.annotationBodyPlaceholder}
        rows={3}
        value={editor.body}
        onChange={(value) => onChange({ body: value })}
        data-testid="review-annotation-body"
      />
      {error ? (
        <Notice tone="fail" compact>
          {error}
        </Notice>
      ) : null}
      <div className="review-editor-actions">
        {editor.id ? (
          <Button size="sm" variant="ghost" onPress={onCancel}>
            {text.annotationCancel}
          </Button>
        ) : null}
        <Button size="sm" variant="primary" type="submit" isPending={busy} data-testid="review-annotation-save">
          {editor.id ? text.annotationUpdate : text.annotationSave}
        </Button>
      </div>
    </form>
  )
}

export default ReviewPage
