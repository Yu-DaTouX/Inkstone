import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { RotateCcw, Square } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { Button, EmptyState, IconButton, Notice } from '../../ui'
import { groupIntoTurns, type Turn } from '../../../../shared/turns'
import { briefPrompt } from '../../../../shared/subagent-brief'
import { subagentRowLabel } from '../../../../shared/subagent-task-rows'
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
import { discardSubagentResult, mergeSubagentResult } from './subagent-review'
import { SUBAGENT_CARD_BOT, compactTaskPaths, subagentTitle, useSubagentView } from './SubagentLine'
import { retrySubagent, rowLang, stopSubagentChecked, switchSubagentPane, useSubagentRow } from './subagent-actions'
import { subagentNeighbor, subagentSessionPeers } from './subagent-list'
import { turnModelLabel } from './turn-model-label'
import { TurnView } from './TurnView'
import { useSessionText } from './text'
import './subagent-pane.css'

const RETRYABLE = new Set(['failed', 'timeout', 'budget', 'stopped'])
const PATHS_SHOWN = 12

function subagentBriefText(run: Pick<SubagentRun, 'task' | 'brief'>): string {
  return run.brief ? briefPrompt(run.brief, run.task) : run.task
}

function subagentTranscriptTurns(run: Pick<SubagentRun, 'task' | 'brief' | 'transcript' | 'cwd'>): Turn[] {
  const brief = subagentBriefText(run).trim()
  const task = run.task.trim()
  return groupIntoTurns(
    run.transcript
      .filter((item) => item.role !== 'user' || (item.text.trim() !== brief && item.text.trim() !== task))
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
  const [retrying, setRetrying] = useState(false)
  const [gone, setGone] = useState(false)

  const modelName = run.model ? turnModelLabel(run.model, models).label : null
  const role = run.fork
    ? tt('subagentScopeFork')
    : model.isolation === 'controlled-cwd'
    ? tt('subagentScopeReadOnly')
    : model.isolation === 'shared-cwd'
      ? tt('subagentScopeShared')
      : tt('subagentScopeWorktree')
  const statusWord = subagentRowLabel(row.state, '', rowLang(lang))
  const canRetry = model.terminal && RETRYABLE.has(model.outcomeKey) && !!currentSessionId && run.parentSessionId === currentSessionId
  const brief = subagentBriefText(run)
  const shown = useFullTranscript(run)
  const turns = useMemo(() => subagentTranscriptTurns(shown), [shown])
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
          <span className="sa-pane-state" data-testid="v3-subagent-pane-status">
            <SubagentStateIcon state={row.state} />
            {statusWord}
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
              <TurnView turn={turn} subagentScope={scope} streaming={turn.kind === 'assistant' && model.live && turn === turns[turns.length - 1]} readOnly />
            </div>
          ))}
          {turns.length === 0 && model.live ? <p className="sa-pane-wait">{t('sa.waitingMessages')}</p> : null}
          {model.error ? (
            <Notice tone="fail" compact data-testid="v3-subagent-error">
              {model.recovery ? `${tt(model.recovery.key, 'n' in model.recovery ? { n: model.recovery.n } : undefined)} · ` : ''}
              {model.error}
            </Notice>
          ) : null}
          {gone ? <Notice tone="info" compact data-testid="v3-subagent-gone">{tt('subagentGone')}</Notice> : null}
        </div>
      </div>
      <footer className="sa-pane-foot" data-testid="v3-subagent-pane-foot">
        {row.summaryLine ? <p className="sa-pane-summary" data-testid="v3-subagent-summary-line">{row.summaryLine}</p> : null}
        <PathList label={tt('subagentSources')} items={model.sources} />
        <PathList label={tt('subagentArtifacts')} items={model.artifacts} />
        <SubagentReview run={run} onMerge={mergeSubagentResult} onDiscard={discardSubagentResult} />
        <SubagentComposer key={run.id} run={run} />
      </footer>
    </div>
  )
}

function PathList({ label, items }: { label: string; items: readonly string[] }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return (
    <div className="sa-pane-paths">
      <button type="button" className="sa-pane-paths-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{`${label} ${items.length}`}</span>
        <Icon name="chevron-right" size={13} className="v3-chev" />
      </button>
      {open ? (
        <ul>
          {items.slice(0, PATHS_SHOWN).map((item) => (
            <li key={item} title={item}>{item}</li>
          ))}
          {items.length > PATHS_SHOWN ? <li className="dim">+{items.length - PATHS_SHOWN}</li> : null}
        </ul>
      ) : null}
    </div>
  )
}
