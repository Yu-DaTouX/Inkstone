import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay, Notice } from '../../ui'
import { DiffView } from '../diff'
import { loadSubagentPatch, subagentReviewGate, type SubagentPatch } from './subagent-review'
import './subagent-review.css'

interface SubagentReviewProps {
  run: SubagentRun
  onMerge: (id: string) => Promise<void>
  onDiscard: (id: string) => Promise<void>
  loadPatch?: (patchPath: string) => Promise<SubagentPatch>
}

interface ReviewCopy {
  hideDiff: string
  mergeTitle: string
  mergeBody: string
  discardTitle: string
  loading: string
  truncated: string
  loadFailed: (error: string) => string
  applying: string
  discarding: string
  cancel: string
  confirmApply: string
  confirmDiscard: string
  noPatch: string
}

const ZH: ReviewCopy = {
  hideDiff: '收起差异',
  mergeTitle: '采纳这次改动？',
  mergeBody: '把隔离工作树里的补丁应用到当前项目目录。有冲突时不会写入半截结果，工作树保留待你处理。',
  discardTitle: '放弃这次改动？',
  loading: '正在读取差异…',
  truncated: '补丁较大，仅显示前一部分。',
  loadFailed: (error) => `差异读取失败：${error}`,
  applying: '正在采纳…',
  discarding: '正在丢弃…',
  cancel: '取消',
  confirmApply: '确认采纳',
  confirmDiscard: '确认丢弃',
  noPatch: '没有可读取的补丁，但仍可放弃这次隔离改动。'
}

const EN: ReviewCopy = {
  hideDiff: 'Hide diff',
  mergeTitle: 'Apply these changes?',
  mergeBody: 'Applies the isolated worktree patch to the project folder. A conflict writes no partial result and keeps the worktree for you to handle.',
  discardTitle: 'Discard these changes?',
  loading: 'Loading diff…',
  truncated: 'The patch is large; only the first part is shown.',
  loadFailed: (error) => `Could not read the diff: ${error}`,
  applying: 'Applying…',
  discarding: 'Discarding…',
  cancel: 'Cancel',
  confirmApply: 'Apply',
  confirmDiscard: 'Discard',
  noPatch: 'No readable patch, but the isolated change can still be discarded.'
}

function reviewCopy(lang: string): ReviewCopy {
  return lang === 'en-US' ? EN : ZH
}

const defaultLoadPatch = (patchPath: string): Promise<SubagentPatch> => loadSubagentPatch(patchPath)

export function SubagentReview({ run, onMerge, onDiscard, loadPatch }: SubagentReviewProps): JSX.Element | null {
  const t = useT()
  const { lang } = useI18n()
  const text = useMemo(() => reviewCopy(lang), [lang])
  const gate = useMemo(() => subagentReviewGate(run), [run])

  const [showDiff, setShowDiff] = useState(false)
  const [patch, setPatch] = useState<SubagentPatch | null>(null)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState('')
  const [confirming, setConfirming] = useState<'merge' | 'discard' | null>(null)
  const [busy, setBusy] = useState<'merge' | 'discard' | null>(null)
  const [actionError, setActionError] = useState('')

  const mountedRef = useRef(true)
  const actionSeqRef = useRef(0)
  const liveRunIdRef = useRef(run.id)
  liveRunIdRef.current = run.id
  const busyRef = useRef<'merge' | 'discard' | null>(null)

  useEffect(() => {
    actionSeqRef.current += 1
    busyRef.current = null
    setShowDiff(false)
    setPatch(null)
    setPatchError('')
    setConfirming(null)
    setActionError('')
    setBusy(null)
  }, [run.id])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      actionSeqRef.current += 1
    }
  }, [])

  const loaderRef = useRef(loadPatch ?? defaultLoadPatch)
  loaderRef.current = loadPatch ?? defaultLoadPatch
  const patchPath = run.diff?.patchPath

  useEffect(() => {
    if (!showDiff || !patchPath) return undefined
    let alive = true
    setPatchLoading(true)
    setPatchError('')
    setPatch(null)
    void loaderRef.current(patchPath)
      .then((value) => { if (alive) setPatch(value) })
      .catch((error: unknown) => { if (alive) setPatchError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (alive) setPatchLoading(false) })
    return () => { alive = false }
  }, [showDiff, patchPath])

  if (!gate.canReview) return null

  const toggleDiff = (): void => setShowDiff((value) => !value)

  const runAction = async (action: 'merge' | 'discard'): Promise<void> => {
    if (busyRef.current) return
    const seq = ++actionSeqRef.current
    const targetId = run.id
    const stale = (): boolean =>
      !mountedRef.current || actionSeqRef.current !== seq || liveRunIdRef.current !== targetId
    busyRef.current = action
    setBusy(action)
    setActionError('')
    try {
      await (action === 'merge' ? onMerge(targetId) : onDiscard(targetId))
      if (stale()) return
      setConfirming(null)
    } catch (error) {
      if (stale()) return
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!stale()) {
        busyRef.current = null
        setBusy(null)
      }
    }
  }

  return (
    <section className="v3-subagent-review" data-testid="v3-subagent-review" data-review={run.review}>
      <div className="v3-subagent-review-actions">
        <span className="v3-subagent-review-state" data-testid="v3-subagent-review-state">
          {run.review === 'conflict' ? t('sa.reviewConflict') : t('sa.reviewPending')}
        </span>
        {gate.canPatch ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={toggleDiff}
            data-testid="v3-subagent-review-view"
          >
            {showDiff ? text.hideDiff : t('sa.viewPatch')}
          </Button>
        ) : null}
        {gate.canPatch ? (
          <Button
            size="sm"
            onPress={() => setConfirming('merge')}
            data-testid="v3-subagent-review-merge"
          >
            {t('sa.adopt')}
          </Button>
        ) : null}
        {gate.canDiscard ? (
          <Button
            size="sm"
            variant="danger"
            onPress={() => setConfirming('discard')}
            data-testid="v3-subagent-review-discard"
          >
            {t('sa.discardChanges')}
          </Button>
        ) : null}
        {!gate.canPatch ? <span className="v3-subagent-review-note">{text.noPatch}</span> : null}
      </div>

      {showDiff ? (
        <div className="v3-subagent-review-diff" data-testid="v3-subagent-review-diff">
          {patchLoading ? (
            <p className="v3-subagent-review-note">{text.loading}</p>
          ) : patchError ? (
            <Notice tone="fail" compact data-testid="v3-subagent-review-diff-error">
              {text.loadFailed(patchError)}
            </Notice>
          ) : patch ? (
            <>
              {patch.truncated ? <p className="v3-subagent-review-note">{text.truncated}</p> : null}
              <DiffView patch={patch.patch} lang={lang} showFileHeader />
            </>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <ModalOverlay
          className="v3-subagent-review-overlay"
          isOpen
          isDismissable={!busy}
          onOpenChange={(open) => { if (!open && !busy) { setConfirming(null); setActionError('') } }}
        >
          <Modal className="v3-subagent-review-modal">
            <Dialog
              title={confirming === 'merge' ? text.mergeTitle : text.discardTitle}
              closeLabel={text.cancel}
              showClose={!busy}
              data-testid="v3-subagent-review-dialog"
            >
              <p className="v3-subagent-review-body">
                {confirming === 'merge' ? text.mergeBody : t('sa.discardConfirm')}
              </p>
              {actionError ? (
                <Notice tone="fail" compact data-testid="v3-subagent-review-action-error">
                  {actionError}
                </Notice>
              ) : null}
              <DialogFooter>
                <Button
                  variant="ghost"
                  isDisabled={!!busy}
                  onPress={() => { setConfirming(null); setActionError('') }}
                  data-testid="v3-subagent-review-cancel"
                >
                  {text.cancel}
                </Button>
                <Button
                  variant={confirming === 'discard' ? 'destructive' : 'primary'}
                  isDisabled={!!busy}
                  onPress={() => { if (confirming) void runAction(confirming) }}
                  data-testid="v3-subagent-review-confirm"
                >
                  {busy
                    ? confirming === 'merge' ? text.applying : text.discarding
                    : confirming === 'merge' ? text.confirmApply : text.confirmDiscard}
                </Button>
              </DialogFooter>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </section>
  )
}
