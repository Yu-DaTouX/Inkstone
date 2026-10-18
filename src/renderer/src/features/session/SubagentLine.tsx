import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { formatTokens } from '../../state/compaction-view'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3, phaseWord, runTone } from '../../state/runs-v3'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { subagentTileRef } from '../../app/SideBySideLayout'
import { findSubagentSnapshot, subagentLineModel, type SubagentLineModel } from './turn-lines'
import { selectSubagentRuns, subagentRunsForTurnScope, subagentTokens, type TurnSubagentScope } from '../../state/subagent-view'
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
import { turnModelLabel } from './turn-model-label'
import { contextUsageSummary } from '../workbench/context-pane-view'
import { ThinkingBadge } from '../../patterns/ThinkingBadge'
import { ContextGauge } from '../../patterns/ContextGauge'
import { Button, ProgressBar } from '../../ui'

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

export const SUBAGENT_STRIP_MAX = 6
const SUBAGENT_STRIP_BOT = 22

const isLiveRun = (run: SubagentRun): boolean => run.status === 'running' || run.status === 'starting'

export function subagentStackOrder(runs: SubagentRun[]): SubagentRun[] {
  const recent = (run: SubagentRun): number => run.endedAt ?? run.startedAt
  const failed = runs.filter((run) => run.status === 'error').sort((a, b) => recent(b) - recent(a))
  const rest = runs.filter((run) => run.status !== 'error').sort((a, b) => b.startedAt - a.startedAt)
  return [...failed, ...rest]
}

export function subagentDefaultFront(runs: SubagentRun[], selectedId: string | null): string | null {
  if (!runs.length) return null
  if (selectedId && runs.some((run) => run.id === selectedId)) return selectedId
  const newest = (list: SubagentRun[]): SubagentRun => list.reduce((best, run) => (run.startedAt >= best.startedAt ? run : best))
  const live = runs.filter(isLiveRun)
  return newest(live.length ? live : runs).id
}

export function subagentDeck(runs: SubagentRun[], frontId: string | null): { front: SubagentRun | null; strips: SubagentRun[]; hidden: number } {
  const front = runs.find((run) => run.id === frontId) ?? null
  const others = subagentStackOrder(runs.filter((run) => run.id !== front?.id))
  const strips = others.slice(0, SUBAGENT_STRIP_MAX)
  return { front, strips, hidden: others.length - strips.length }
}

const SUBAGENT_DEPTH_MAX = 3

export function SubagentLine({ turn, scope }: { turn: AssistantTurn; scope?: TurnSubagentScope }): JSX.Element | null {
  const tt = useSessionText()
  const subagents = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const runs = useRunsV3((s) => s.runs)
  const [flat, setFlat] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const deckRef = useRef<HTMLDivElement | null>(null)
  const refocus = useRef(false)

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const selectedRunId = useSubagentPanel((s) => (s.owner === view.key ? s.runId : null))
  const sessionIds = view.sessionId ? [view.sessionId] : []
  const ids = new Set([turn.id, ...turn.sourceIds])
  const mine = (scope ? subagentRunsForTurnScope(subagents, scope) : selectSubagentRuns(subagents, { sessionIds }).all).filter(
    (run) => run.parentMessageId && ids.has(run.parentMessageId) && run.review !== 'merged' && run.review !== 'discarded'
  )
  const ordered = [...mine].sort((a, b) => a.startedAt - b.startedAt)
  const pickedValid = picked !== null && ordered.some((run) => run.id === picked)
  const frontId = pickedValid ? picked : subagentDefaultFront(ordered, selectedRunId)
  const selectedInGroup = selectedRunId !== null && ordered.some((run) => run.id === selectedRunId)

  useEffect(() => {
    if (selectedInGroup) setPicked(null)
  }, [selectedInGroup, selectedRunId])

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    deckRef.current?.querySelector<HTMLElement>('[data-front="1"] .v3-subagent-toggle')?.focus()
  }, [frontId])

  if (!ordered.length) return null
  const live = ordered.filter(isLiveRun).length
  const renderRow = (run: SubagentRun, extra?: { front?: boolean; lift?: boolean }): JSX.Element => (
    <SubagentRow key={run.id} run={run} owner={view.key} snapshot={findSubagentSnapshot(runs, run.id)} front={extra?.front} lift={extra?.lift} />
  )

  if (ordered.length === 1) {
    return (
      <div className="v3-subagents" data-testid="v3-subagents" data-layout="single">
        {renderRow(ordered[0])}
      </div>
    )
  }

  const failed = ordered.filter((run) => run.status === 'error').length
  const finished = ordered.length - live
  const legend = [
    live ? { tone: 'run', label: tt('subagentLiveCount', { n: live }) } : null,
    failed ? { tone: 'err', label: tt('subagentFailedCount', { n: failed }) } : null
  ].filter((item): item is { tone: string; label: string } => item !== null)
  const counts = [
    tt('subagentCount', { n: ordered.length }),
    live ? tt('subagentLiveCount', { n: live }) : null,
    finished - failed ? tt('subagentDoneCount', { n: finished - failed }) : null,
    failed ? tt('subagentFailedCount', { n: failed }) : null
  ].filter(Boolean).join(' · ')
  const toggle = (): void => setFlat((value) => !value)
  const deck = subagentDeck(ordered, frontId)
  const pick = (id: string): void => {
    refocus.current = true
    setPicked(id)
  }
  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-nav="1"]'))
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const next = items[at + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="v3-subagents" data-testid="v3-subagents" data-layout={flat ? 'flat' : 'stack'}>
      <div className="v3-subagents-top">
        <Button
          variant="ghost"
          size="sm"
          className="v3-subagents-head"
          aria-expanded={flat}
          onPress={toggle}
          aria-label={counts}
          trailingIcon={<Icon name={flat ? 'chevron-up' : 'chevron-down'} size={13} />}
          data-testid="v3-subagents-sum"
        >
          {tt('subagentCount', { n: ordered.length })}
        </Button>
        <ProgressBar
          className="v3-subagents-progress"
          aria-label={counts}
          value={finished}
          maxValue={ordered.length}
          data-testid="v3-subagents-progress"
        />
        {legend.length ? (
          <span className="v3-subagents-legend" aria-hidden="true" data-testid="v3-subagents-legend">
            {legend.map((item) => (
              <span key={item.tone} className="v3-subagents-legend-item">
                <span className={`v3-dot ${item.tone}`} />
                {item.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {flat ? (
        <>
          {ordered.map((run) => renderRow(run))}
          <Button variant="ghost" size="sm" className="v3-subagents-more" onPress={toggle} data-testid="v3-subagents-more">
            {tt('subagentShowLess')}
          </Button>
        </>
      ) : (
        <div className="v3-sa-deck" role="group" aria-label={counts} ref={deckRef} onKeyDown={navigate} data-testid="v3-subagent-deck">
          {deck.front ? renderRow(deck.front, { front: true, lift: pickedValid }) : null}
          {deck.strips.map((run, index) => (
            <SubagentStrip
              key={run.id}
              run={run}
              owner={view.key}
              snapshot={findSubagentSnapshot(runs, run.id)}
              depth={Math.min(index + 1, SUBAGENT_DEPTH_MAX)}
              layer={deck.strips.length - index + 1}
              onPick={() => pick(run.id)}
            />
          ))}
          {deck.hidden > 0 ? (
            <button
              type="button"
              className="v3-sa-strip v3-sa-more"
              data-depth={SUBAGENT_DEPTH_MAX}
              data-nav="1"
              style={{ zIndex: 1 }}
              onClick={() => setFlat(true)}
              data-testid="v3-subagents-more"
            >
              <span className="v3-sa-strip-task">{tt('subagentMoreRuns', { n: deck.hidden })}</span>
              <Icon name="chevron-down" size={13} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function SubagentStrip({ run, owner, snapshot, depth, layer, onPick }: {
  run: SubagentRun
  owner: string
  snapshot?: RunSnapshot
  depth: number
  layer: number
  onPick: () => void
}): JSX.Element {
  const tt = useSessionText()
  const { model, status, dotClass } = useSubagentView(run, snapshot)
  const selected = useSubagentPanel((s) => s.runId === run.id && s.owner === owner)
  const title = compactTaskPaths(subagentTitle(model.task))
  const time = formatDuration(model.elapsedMs, { minSeconds: 1 })
  return (
    <button
      type="button"
      className="v3-sa-strip"
      data-testid="v3-subagent-strip"
      data-run-id={run.id}
      data-depth={depth}
      data-state={model.outcomeKey}
      data-tone={dotClass || undefined}
      data-selected={selected ? '1' : undefined}
      data-attention={model.attention || !!model.error ? '1' : undefined}
      data-nav="1"
      style={{ zIndex: layer }}
      aria-label={`${title} · ${status} · ${time} · ${tt('subagentBringFront')}`}
      title={`${model.task}\n${tt('subagentBringFront')}`}
      onClick={onPick}
    >
      <span className="v3-sa-strip-mark" aria-hidden="true">
        <SubagentBot run={run} snapshot={snapshot} model={model} size={SUBAGENT_STRIP_BOT} />
        <span className={`v3-dot ${dotClass}`} data-testid="v3-subagent-dot" />
      </span>
      <span className="v3-sa-strip-task" data-testid="v3-subagent-task">{title}</span>
      <span className="v3-sa-strip-status" data-testid="v3-subagent-status">{status}</span>
      <span className="v3-sa-strip-time" data-testid="v3-subagent-time">{time}</span>
    </button>
  )
}

function SubagentRow({ run, owner, snapshot, front, lift }: { run: SubagentRun; owner: string; snapshot?: RunSnapshot; front?: boolean; lift?: boolean }): JSX.Element {
  const tt = useSessionText()
  const t = useT()
  const { model, status, dotClass } = useSubagentView(run, snapshot)
  const selected = useSubagentPanel((s) => s.runId === run.id && s.owner === owner)
  const tokens = subagentTokens([run])
  const models = useStore((s) => s.models)
  const modelName = run.model ? turnModelLabel(run.model, models).label : null
  const thinking = run.thinkingLevel && run.thinkingLevel !== 'off' ? run.thinkingLevel : null
  const context = contextUsageSummary(null, { contextUsage: run.contextUsage })

  return (
    <div
      className="v3-subagent"
      data-testid="v3-subagent-line"
      data-state={model.outcomeKey}
      data-terminal={model.terminal ? '1' : '0'}
      data-selected={selected ? '1' : undefined}
      data-attention={model.attention || !!model.error ? '1' : undefined}
      data-front={front ? '1' : undefined}
      data-lift={lift ? '1' : undefined}
    >
      <button
        className="v3-subagent-toggle"
        data-nav={front ? '1' : undefined}
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
          <span className="v3-subagent-task" data-testid="v3-subagent-task">{compactTaskPaths(subagentTitle(model.task))}</span>
          <span className="v3-subagent-meta">
            {modelName ? (
              <span className="v3-subagent-model" data-testid="v3-subagent-model" title={run.model}>{modelName}</span>
            ) : (
              <span className="v3-subagent-kind">{tt('subagentKind')}</span>
            )}
            {thinking ? <ThinkingBadge level={thinking} className="v3-subagent-think" data-testid="v3-subagent-thinking" /> : null}
            {model.code ? <span className="v3-subagent-code" data-testid="v3-subagent-code">{model.code}</span> : null}
            <span className="v3-subagent-status" data-testid="v3-subagent-status">{status}</span>
            <span className="v3-subagent-time" data-testid="v3-subagent-time">{formatDuration(model.elapsedMs, { minSeconds: 1 })}</span>
            {tokens > 0 ? (
              <span className="v3-subagent-tokens" data-testid="v3-subagent-tokens">{`${formatTokens(tokens)} ${t('tok.unit')}`}</span>
            ) : null}
            {context.known ? <ContextGauge usage={context} className="v3-subagent-ctx" data-testid="v3-subagent-context" /> : null}
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

const TITLE_BREAK = /[：。；！？]|[:;.!?](?=\s)/
const TITLE_MIN = 4

export function subagentTitle(task: string): string {
  const line = firstLine(task)
  const at = line.search(TITLE_BREAK)
  return at >= TITLE_MIN ? line.slice(0, at).trim() : line
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
