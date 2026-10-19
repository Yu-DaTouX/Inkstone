import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { RotateCcw, Square } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { Button, EmptyState, Notice } from '../../ui'
import { groupIntoTurns, type Turn } from '../../../../shared/turns'
import { briefPrompt } from '../../../../shared/subagent-brief'
import { subagentRowLabel } from '../../../../shared/subagent-task-rows'
import type { SubagentRun } from '../../../../shared/ipc'
import type { TurnSubagentScope } from '../../state/subagent-view'
import { PaneTitle, PaneTools } from '../workbench/pane-chrome'
import { isNearBottom } from '../workbench/background-tasks'
import { findSubagentSnapshot } from './turn-lines'
import { SubagentBot } from './SubagentBot'
import { SubagentStateIcon } from './SubagentState'
import { SubagentReview } from './SubagentReview'
import { discardSubagentResult, mergeSubagentResult } from './subagent-review'
import { SUBAGENT_CARD_BOT, compactTaskPaths, subagentTitle, useSubagentView } from './SubagentLine'
import { retrySubagent, rowLang, stopSubagentChecked, useSubagentRow } from './subagent-actions'
import { turnModelLabel } from './turn-model-label'
import { TurnView } from './TurnView'
import { useSessionText } from './text'
import './subagent-pane.css'

const RETRYABLE = new Set(['failed', 'timeout', 'budget', 'stopped'])
const PATHS_SHOWN = 12

export function subagentBriefText(run: Pick<SubagentRun, 'task' | 'brief'>): string {
  return run.brief ? briefPrompt(run.brief, run.task) : run.task
}

export function subagentTranscriptTurns(run: Pick<SubagentRun, 'task' | 'brief' | 'transcript' | 'cwd'>): Turn[] {
  const brief = subagentBriefText(run).trim()
  const task = run.task.trim()
  return groupIntoTurns(
    run.transcript
      .filter((item) => item.role !== 'user' || (item.text.trim() !== brief && item.text.trim() !== task))
      .map((item) => ({ ...item, sourceCwd: item.sourceCwd ?? run.cwd }))
  )
}

export function subagentPaneName(run: Pick<SubagentRun, 'task' | 'brief'>): string {
  return run.brief?.title || compactTaskPaths(subagentTitle(run.task))
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
  const role = model.isolation === 'controlled-cwd'
    ? tt('subagentScopeReadOnly')
    : model.isolation === 'shared-cwd'
      ? tt('subagentScopeShared')
      : tt('subagentScopeWorktree')
  const statusWord = subagentRowLabel(row.state, '', rowLang(lang))
  const canRetry = model.terminal && RETRYABLE.has(model.outcomeKey) && !!currentSessionId && run.parentSessionId === currentSessionId
  const brief = subagentBriefText(run)
  const turns = useMemo(() => subagentTranscriptTurns(run), [run])
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
      </footer>
    </div>
  )
}

function PathList({ label, items }: { label: string; items: readonly string[] }): JSX.Element | null {
  if (!items.length) return null
  return (
    <details className="sa-pane-paths">
      <summary>{`${label} ${items.length}`}</summary>
      <ul>
        {items.slice(0, PATHS_SHOWN).map((item) => (
          <li key={item} title={item}>{item}</li>
        ))}
        {items.length > PATHS_SHOWN ? <li className="dim">+{items.length - PATHS_SHOWN}</li> : null}
      </ul>
    </details>
  )
}
