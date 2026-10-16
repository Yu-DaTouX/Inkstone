/**
 * 子 Agent worktree 结果的审阅控件（WP-27b）。
 *
 * 只在**真正可处置**时出现：隔离 worktree、运行已到终态、`review` 为
 * `pending` / `conflict`。受控只读目录与共享目录没有隔离结果，不画按钮；
 * 归档（退出时工作树已清理）也不凭空提供一个假入口。
 *
 * 「查看差异」经正式只读文件接口读取这条运行自己归档的补丁，交给 v3
 * `DiffView`；「采纳」/「放弃」都先明确确认，动作进行中禁用重复点击。
 * 动作失败由既有 store 动作就地提示（并保留运行与工作树），本组件不吞掉。
 *
 * 归属边界：补丁路径与动作参数都来自 `run`，不读当前前台会话，也不按会话重指向。
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { Button, Dialog, Modal, ModalOverlay } from '../../ui'
import { DiffView } from '../diff'
import { loadSubagentPatch, subagentReviewGate, type SubagentPatch } from './subagent-review'
import './subagent-review.css'

export interface SubagentReviewProps {
  run: SubagentRun
  /** 采纳：经正式窄结果适配器 `mergeSubagentResult` 走 `window.yan.subagents.merge`。 */
  onMerge: (id: string) => Promise<void>
  /** 放弃：经正式窄结果适配器 `discardSubagentResult` 走 `window.yan.subagents.discard`。 */
  onDiscard: (id: string) => Promise<void>
  /** 读取归档补丁；缺省走正式只读文件接口。测试可注入。 */
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

/** 正式只读接口的默认补丁读取；测试用 `loadPatch` 注入替身。 */
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

  /*
   * 动作身份：发起时捕获 run.id 与自增序号。props 换 run、组件卸载或有更新动作
   * 开始时，旧结果一律不再改状态，避免迟到结果关掉新确认框或污染新 run。
   * busyRef 做同步防连点：state 闭包在同一帧里看不到刚 set 的 busy。
   */
  const mountedRef = useRef(true)
  const actionSeqRef = useRef(0)
  const liveRunIdRef = useRef(run.id)
  liveRunIdRef.current = run.id
  const busyRef = useRef<'merge' | 'discard' | null>(null)

  /* 换 run 时收掉上一个 run 的差异 / 确认 / 错误，不串到新 run。 */
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

  /* 注入的读取器只经 ref 取用，避免调用方每次渲染换函数就反复读取。 */
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

  /* 补丁读不出来时收起差异查看，避免留一个空的 DiffView 容器。 */
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
      /* 保留对话框与运行状态，就地给出原因；工作树仍归用户处置。 */
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
            <p className="v3-subagent-review-error" role="alert" data-testid="v3-subagent-review-diff-error">
              {text.loadFailed(patchError)}
            </p>
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
                <p className="v3-subagent-review-error" role="alert" data-testid="v3-subagent-review-action-error">
                  {actionError}
                </p>
              ) : null}
              <div className="v3-subagent-review-foot">
                <Button
                  variant="ghost"
                  isDisabled={!!busy}
                  onPress={() => { setConfirming(null); setActionError('') }}
                  data-testid="v3-subagent-review-cancel"
                >
                  {text.cancel}
                </Button>
                <Button
                  variant={confirming === 'discard' ? 'danger' : 'primary'}
                  isDisabled={!!busy}
                  onPress={() => { if (confirming) void runAction(confirming) }}
                  data-testid="v3-subagent-review-confirm"
                >
                  {busy
                    ? confirming === 'merge' ? text.applying : text.discarding
                    : confirming === 'merge' ? text.confirmApply : text.confirmDiscard}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </section>
  )
}
