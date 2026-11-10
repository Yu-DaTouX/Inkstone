import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Check, RotateCcw, Square } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { Button, EmptyState, IconButton, Notice, Spinner } from '../../ui'
import { groupIntoTurns, type Turn } from '../../../../shared/turns'
import { mergeApprovalLog } from '../../../../shared/approval-log'
import type { ApprovalReceipt } from '../../../../shared/approval'
import { briefDisplay, briefPrompt } from '../../../../shared/subagent-brief'
import { subagentRowLabel } from '../../../../shared/subagent-task-rows'
import { isDismissed } from '../../../../shared/subagent-outcome'
import type { SubagentRun } from '../../../../shared/ipc'
import type { TurnSubagentScope } from '../../state/subagent-view'
import { PaneTitle, PaneTools } from '../workbench/pane-chrome'
import { isNearBottom } from '../workbench/background-tasks'
import { findSubagentSnapshot } from './turn-lines'
import { SubagentBot } from './SubagentBot'
import { Icon } from './Icon'
import { SubagentStateIcon } from './SubagentState'
import { SubagentReview } from './SubagentReview'
import { SubagentComposer } from './SubagentComposer'
import { forwardedText } from './subagent-composer'
import { SUBAGENT_CARD_BOT, compactTaskPaths, subagentTitle, useSubagentView } from './SubagentLine'
import { retrySubagent, rowLang, stopSubagentChecked, switchSubagentPane, useSubagentRow } from './subagent-actions'
import { subagentNeighbor, subagentSessionPeers } from './subagent-list'
import { turnModelLabel } from './turn-model-label'
import { TurnView } from './TurnView'
import { useSessionText } from './text'
import './subagent-pane.css'

const RETRYABLE = new Set(['failed', 'timeout', 'budget', 'stopped'])

function subagentBriefText(run: Pick<SubagentRun, 'task' | 'brief'>): string {
  return run.brief ? briefDisplay(run.brief, run.task) : run.task
}

const NO_APPROVAL_RECEIPTS: ApprovalReceipt[] = []

function subagentTranscriptTurns(run: Pick<SubagentRun, 'id' | 'task' | 'brief' | 'transcript' | 'cwd'>, approvals: readonly ApprovalReceipt[]): Turn[] {
  const brief = subagentBriefText(run).trim()
  const prompt = run.brief ? briefPrompt(run.brief, run.task).trim() : brief
  const task = run.task.trim()
  return groupIntoTurns(
    mergeApprovalLog(run.transcript, approvals, run.id)
      .filter((item) => item.role !== 'user' || (item.text.trim() !== brief && item.text.trim() !== prompt && item.text.trim() !== task))
      .map((item) => ({ ...item, ...(item.role === 'user' ? { text: forwardedText(item.text).text } : {}), sourceCwd: item.sourceCwd ?? run.cwd }))
  )
}

function useFullTranscript(run: SubagentRun): SubagentRun {
  const [loaded, setLoaded] = useState<SubagentRun['transcript'] | null>(null)
  useEffect(() => {
    if (!run.transcriptOmitted) return
    let alive = true
    window.yan.subagents.get(run.id).then((full) => { if (alive && full) setLoaded(full.transcript) }, () => undefined)
    return () => { alive = false }
  }, [run.id, run.transcriptOmitted])
  return useMemo(() => (run.transcriptOmitted && loaded ? { ...run, transcript: loaded } : run), [run, loaded])
}

export function subagentPaneName(run: Pick<SubagentRun, 'task' | 'brief'>): string {
  return run.brief?.title || compactTaskPaths(subagentTitle(run.task))
}

const FOCUS_TRIES = 12

type PaneStep = 'prev' | 'next'

function useSubagentGroupIds(run: SubagentRun): readonly string[] {
  return useStore(useShallow((s): string[] => subagentSessionPeers(s.subagents, run).map((item) => item.id)))
}

function focusPaneStep(runId: string, step: PaneStep, tries = FOCUS_TRIES): void {
  const pick = (): HTMLElement | null => {
    const wanted = document.querySelector<HTMLButtonElement>(`[data-subagent-step="${step}"][data-run-id="${runId}"]`)
    if (wanted && !wanted.disabled) return wanted
    return document.querySelector<HTMLButtonElement>(`[data-subagent-step="${step === 'prev' ? 'next' : 'prev'}"][data-run-id="${runId}"]`)
  }
  const found = pick()
  if (found) {
    found.focus()
    return
  }
  if (tries > 0) window.requestAnimationFrame(() => focusPaneStep(runId, step, tries - 1))
}

function PaneSteps({ run }: { run: SubagentRun }): JSX.Element | null {
  const tt = useSessionText()
  const ids = useSubagentGroupIds(run)
  const index = ids.indexOf(run.id)
  if (ids.length < 2 || index < 0) return null
  const prev = subagentNeighbor(ids, run.id, -1)
  const next = subagentNeighbor(ids, run.id, 1)
  const go = (target: string | null, step: PaneStep): void => {
    if (!target) return
    switchSubagentPane(run.id, target)
    focusPaneStep(target, step)
  }
  return (
    <span className="sa-pane-steps" data-testid="v3-subagent-pane-steps">
      <IconButton
        size="sm"
        aria-label={tt('subagentPrev')}
        tooltip={tt('subagentPrev')}
        isDisabled={!prev}
        onPress={() => go(prev, 'prev')}
        data-subagent-step="prev"
        data-run-id={run.id}
        data-testid="v3-subagent-pane-prev"
      >
        <Icon name="chevron-up" size={13} />
      </IconButton>
      <span className="sa-pane-pos" aria-live="polite" data-testid="v3-subagent-pane-pos">{`${index + 1} / ${ids.length}`}</span>
      <IconButton
        size="sm"
        aria-label={tt('subagentNext')}
        tooltip={tt('subagentNext')}
        isDisabled={!next}
        onPress={() => go(next, 'next')}
        data-subagent-step="next"
        data-run-id={run.id}
        data-testid="v3-subagent-pane-next"
      >
        <Icon name="chevron-down" size={13} />
      </IconButton>
    </span>
  )
}

export function SubagentTranscriptPane({ runId }: { runId: string }): JSX.Element {
  const t = useT()
  const run = useStore((s) => s.subagents.find((item) => item.id === runId))
  if (!run) return <EmptyState className="sa-pane-missing" data-testid="v3-subagent-pane-missing" title={t('delegate.missing')} />
  return <PaneBody key={run.id} run={run} />
}

function PaneBody({ run }: { run: SubagentRun }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const tt = useSessionText()
  const snapshot = useRunsV3((s) => findSubagentSnapshot(s.runs, run.id))
  const { model } = useSubagentView(run, snapshot)
  const row = useSubagentRow(run)
  const models = useStore((s) => s.models)
  const currentSessionId = useStore((s) => s.session?.sessionId ?? null)
  const approvalLog = useStore((s) => (run.parentSessionId ? s.approvalLogs[run.parentSessionId] : undefined) ?? NO_APPROVAL_RECEIPTS)
  const [retrying, setRetrying] = useState(false)
  const [gone, setGone] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [dismissError, setDismissError] = useState('')

  const modelName = run.model ? turnModelLabel(run.model, models).label : null
  const role = run.fork
    ? tt('subagentScopeFork')
    : model.isolation === 'controlled-cwd'
    ? tt('subagentScopeReadOnly')
    : model.isolation === 'shared-cwd'
      ? tt('subagentScopeShared')
      : tt('subagentScopeWorktree')
  const statusWord = subagentRowLabel(row.state, '', rowLang(lang))
  const canRetry = model.terminal && RETRYABLE.has(model.outcomeKey) && !!currentSessionId && run.parentSessionId === currentSessionId && !run.fork && !run.brief
  const canDismiss = run.status === 'error' && !isDismissed(run) && run.review !== 'pending' && run.review !== 'conflict'
  const brief = subagentBriefText(run)
  const shown = useFullTranscript(run)
  const turns = useMemo(() => subagentTranscriptTurns(shown, approvalLog), [shown, approvalLog])
  const errorInTranscript = turns.some((turn) => turn.kind === 'assistant' && !!turn.error && !turn.errorRecovered)
  const scope = useMemo<TurnSubagentScope>(() => ({ sessionIds: [], parentRunIds: [run.id] }), [run.id])

  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [turns])

  const stop = async (): Promise<void> => {
    setGone(false)
    if ((await stopSubagentChecked(run.id)) === 'gone') setGone(true)
  }
  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await retrySubagent(run)
    } finally {
      setRetrying(false)
    }
  }

  const dismiss = async (): Promise<void> => {
    setDismissing(true)
    setDismissError('')
    try {
      const result = await window.yan.subagents.dismiss(run.id)
      if (result.ok) await useStore.getState().loadSubagents()
      else setDismissError(result.error || t('sa.dismissFailed'))
    } catch (failure) {
      setDismissError(failure instanceof Error ? failure.message : t('sa.dismissFailed'))
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div className="sa-pane" data-state={row.state} data-testid="v3-subagent-pane">
      <PaneTitle>
        <span className="sa-pane-head" data-state={row.state} data-testid="v3-subagent-pane-head">
          <span className="sa-pane-bot" aria-hidden="true">
            <SubagentBot run={run} snapshot={snapshot} model={model} size={SUBAGENT_CARD_BOT} />
          </span>
          <span className="sa-pane-name" title={model.task}>{subagentPaneName(run)}</span>
          <span className="sa-pane-role">{`· ${role}`}</span>
          {modelName ? <span className="sa-pane-model" title={run.model}>{modelName}</span> : null}
          <span className="sa-pane-state" aria-label={statusWord} title={statusWord} data-testid="v3-subagent-pane-status">
            <SubagentStateIcon state={row.state} />
            <span className="sa-pane-state-label">{statusWord}</span>
            {isDismissed(run) ? <span className="sa-pane-state-label" data-testid="v3-subagent-pane-dismissed">{`· ${t('sa.state.dismissed')}`}</span> : null}
          </span>
        </span>
      </PaneTitle>
      <PaneTools>
        <PaneSteps run={run} />
        {row.canStop || row.state === 'stopping' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Square size={12} aria-hidden />}
            isPending={row.state === 'stopping'}
            onPress={() => void stop()}
            data-testid="v3-subagent-stop"
          >
            {t('sa.stop')}
          </Button>
        ) : null}
        {canRetry ? (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} aria-hidden />} isPending={retrying} onPress={() => void retry()} data-testid="v3-subagent-retry">
            {t('sa.retry')}
          </Button>
        ) : null}
        {canDismiss ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Check size={12} aria-hidden />}
            tooltip={t('sa.dismissHint')}
            isPending={dismissing}
            onPress={() => void dismiss()}
            data-testid="v3-subagent-dismiss"
          >
            {t('sa.dismiss')}
          </Button>
        ) : null}
      </PaneTools>
      <div
        className="sa-pane-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          followRef.current = isNearBottom(event.currentTarget)
        }}
      >
        <div className="sa-pane-stream">
          <article className="v3-msg user sa-pane-brief" aria-label={tt('subagentBrief')} data-testid="v3-subagent-brief">
            <div className="v3-user-body">
              <div className="v3-bubble">
                <span className="v3-bubble-text">{brief}</span>
              </div>
            </div>
          </article>
          {turns.map((turn) => (
            <div key={turn.id} className="v3-stream-row">
              <TurnView turn={turn} subagentScope={scope} streaming={turn.kind === 'assistant' && model.live && turn === turns[turns.length - 1]} tail={turn === turns[turns.length - 1]} readOnly />
            </div>
          ))}
          {turns.length === 0 && model.live ? <p className="sa-pane-wait" role="status"><Spinner size="sm" />{t('sa.waitingMessages')}</p> : null}
          {model.error && !errorInTranscript ? (
            <Notice tone="fail" compact data-testid="v3-subagent-error">
              {model.recovery ? `${tt(model.recovery.key, 'n' in model.recovery ? { n: model.recovery.n } : undefined)} · ` : ''}
              {model.error}
            </Notice>
          ) : model.error && model.recovery ? (
            <p className="sa-pane-wait" data-testid="v3-subagent-error">{tt(model.recovery.key, 'n' in model.recovery ? { n: model.recovery.n } : undefined)}</p>
          ) : null}
          {gone ? <Notice tone="info" compact data-testid="v3-subagent-gone">{tt('subagentGone')}</Notice> : null}
          {dismissError ? <Notice tone="fail" compact data-testid="v3-subagent-dismiss-error">{dismissError}</Notice> : null}
        </div>
      </div>
      <footer className="sa-pane-foot" data-testid="v3-subagent-pane-foot">
        <SubagentReview run={run} />
        <SubagentComposer key={run.id} run={run} />
      </footer>
    </div>
  )
}
