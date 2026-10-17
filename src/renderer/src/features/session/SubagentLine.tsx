import { useEffect, useState, type JSX } from 'react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3, phaseWord, runTone } from '../../state/runs-v3'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { subagentTileRef } from '../../app/SideBySideLayout'
import { findSubagentSnapshot, subagentLineModel, type SubagentLineModel } from './turn-lines'
import { selectSubagentRuns } from '../../state/subagent-view'
import { sessionViewIdentity } from './view-state'
import { formatDuration } from '../../../../shared/duration'
import type { SubagentOutcomeKey } from '../../../../shared/subagent-outcome'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { AssistantTurn } from '../../../../shared/turns'
import { Icon } from './Icon'
import { SubagentBot } from './SubagentBot'
import { useSessionText } from './text'
import { useSubagentPanel } from './subagent-panel-state'

const OUTCOME_KEY: Record<SubagentOutcomeKey, MessageKey> = {
  starting: 'sa.state.starting',
  running: 'sa.state.running',
  dismissed: 'sa.state.dismissed',
  wrapUp: 'sa.state.wrapUp',
  done: 'sa.state.done',
  timeout: 'sa.state.timeout',
  budget: 'sa.state.budget',
  failed: 'sa.state.failed',
  stopped: 'sa.state.stopped',
  review: 'sa.state.review',
  conflict: 'sa.state.conflict'
}

export function useSubagentView(run: SubagentRun, snapshot?: RunSnapshot): {
  model: SubagentLineModel
  status: string
  dotClass: string
} {
  const t = useT()
  const { lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const model = subagentLineModel(run, snapshot, now)

  useEffect(() => {
    if (!model.live) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [model.live])

  const status = model.phase ? phaseWord(lang, model.phase) : t(OUTCOME_KEY[model.outcomeKey])
  const dotTone = model.phase ? runTone(model.phase) : model.outcomeTone
  const dotClass = dotTone === 'run' || dotTone === 'live' ? 'run'
    : dotTone === 'ok' || dotTone === 'done' ? 'ok'
      : dotTone === 'err' ? 'err'
        : dotTone === 'ask' || dotTone === 'stall' || dotTone === 'warn' ? 'warn'
          : ''
  return { model, status, dotClass }
}

export function openSubagentPane(runId: string): void {
  const state = useStore.getState()
  const current = displayedSessionOf({
    peekedSessionId: state.peekedSessionId,
    peekedPath: state.peekedPath,
    session: state.session ? { sessionId: state.session.sessionId, sessionFile: state.session.sessionFile } : null
  })
  useSplitView.getState().open(subagentTileRef(runId), current)
}

export function SubagentLine({ turn }: { turn: AssistantTurn }): JSX.Element | null {
  const tt = useSessionText()
  const subagents = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const runs = useRunsV3((s) => s.runs)

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const sessionIds = view.sessionId ? [view.sessionId] : []
  const ids = new Set([turn.id, ...turn.sourceIds])
  const mine = selectSubagentRuns(subagents, { sessionIds }).all.filter(
    (run) => run.parentMessageId && ids.has(run.parentMessageId) && run.review !== 'merged' && run.review !== 'discarded'
  )
  if (!mine.length) return null
  const ordered = [...mine].sort((a, b) => a.startedAt - b.startedAt)
  const live = ordered.filter((run) => run.status === 'running' || run.status === 'starting').length
  return (
    <div className="v3-subagents" data-testid="v3-subagents">
      {ordered.length > 1 ? (
        <div className="v3-subagents-sum" data-testid="v3-subagents-sum">{tt('subagentGroup', { n: ordered.length, live })}</div>
      ) : null}
      {ordered.map((run) => <SubagentRow key={run.id} run={run} owner={view.key} snapshot={findSubagentSnapshot(runs, run.id)} />)}
    </div>
  )
}

function SubagentRow({ run, owner, snapshot }: { run: SubagentRun; owner: string; snapshot?: RunSnapshot }): JSX.Element {
  const tt = useSessionText()
  const { model, status, dotClass } = useSubagentView(run, snapshot)
  const selected = useSubagentPanel((s) => s.runId === run.id && s.owner === owner)

  return (
    <div
      className="v3-subagent"
      data-testid="v3-subagent-line"
      data-state={model.outcomeKey}
      data-terminal={model.terminal ? '1' : '0'}
      data-selected={selected ? '1' : undefined}
      data-attention={model.attention || !!model.error ? '1' : undefined}
    >
      <button
        className="v3-subagent-toggle"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={selected}
        title={`${model.task}\n${tt('subagentDetailHint')}`}
        onClick={(event) => useSubagentPanel.getState().toggle(run.id, owner, event.currentTarget)}
        data-testid="v3-subagent-toggle"
      >
        <span className="v3-subagent-glyph" data-tone={dotClass}>
          <SubagentBot run={run} snapshot={snapshot} model={model} />
          <span className={`v3-dot ${dotClass}`} data-testid="v3-subagent-dot" />
        </span>
        <span className="v3-subagent-main">
          <span className="v3-subagent-task" data-testid="v3-subagent-task">{compactTaskPaths(firstLine(model.task))}</span>
          <span className="v3-subagent-meta">
            <span className="v3-subagent-kind">{tt('subagentKind')}</span>
            {model.code ? <span className="v3-subagent-code" data-testid="v3-subagent-code">{model.code}</span> : null}
            <span className="v3-subagent-status" data-testid="v3-subagent-status">{status}</span>
            <span className="v3-subagent-time" data-testid="v3-subagent-time">{formatDuration(model.elapsedMs, { minSeconds: 1 })}</span>
          </span>
        </span>
        <Icon name="chevron-right" size={13} className="v3-chev" />
      </button>
    </div>
  )
}

export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? text
}

const ABSOLUTE_PATH = /(?<![\w.:/\\])(?:[A-Za-z]:[\\/]|[\\/])[^\s"'`<>|*?()[\]{} -⁯　-〿＀-￯一-鿿]*/g
const SHORT_PATH = 32

export function compactTaskPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, (match) => {
    if (match.length <= SHORT_PATH) return match
    const trailingSlash = /[\\/]$/.test(match)
    const segments = match.split(/[\\/]+/).filter(Boolean)
    if (segments.length < 2) return match
    const last = segments[segments.length - 1]
    const isFile = !trailingSlash && /\.[A-Za-z0-9]{1,8}$/.test(last)
    const tail = isFile && segments.length >= 2 ? `${segments[segments.length - 2]}/${last}` : last
    return `…/${tail}`
  })
}
