import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { formatTokens } from '../../state/compaction-view'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3, phaseWord, runTone } from '../../state/runs-v3'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { subagentTileRef } from '../../app/SideBySideLayout'
import { findSubagentSnapshot, subagentLineModel, type SubagentLineModel } from './turn-lines'
import { selectSubagentRuns, subagentTokens } from '../../state/subagent-view'
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

export const SUBAGENT_FOLD_AT = 3

const isLiveRun = (run: SubagentRun): boolean => run.status === 'running' || run.status === 'starting'

export function subagentStackOrder(runs: SubagentRun[]): SubagentRun[] {
  const recent = (run: SubagentRun): number => run.endedAt ?? run.startedAt
  const failed = runs.filter((run) => run.status === 'error').sort((a, b) => recent(b) - recent(a))
  const rest = runs.filter((run) => run.status !== 'error').sort((a, b) => b.startedAt - a.startedAt)
  return [...failed, ...rest]
}

export function subagentStackWindow(total: number, offset: number): { start: number; end: number; max: number } {
  const max = Math.max(0, total - SUBAGENT_FOLD_AT)
  const start = Math.min(Math.max(0, offset), max)
  return { start, end: Math.min(total, start + SUBAGENT_FOLD_AT), max }
}

const WHEEL_STEP = 40

function tickTone(run: SubagentRun): string {
  if (run.status === 'error') return 'err'
  if (isLiveRun(run)) return 'run'
  if (run.status === 'cancelled') return 'warn'
  return 'ok'
}

export function SubagentLine({ turn }: { turn: AssistantTurn }): JSX.Element | null {
  const tt = useSessionText()
  const subagents = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const runs = useRunsV3((s) => s.runs)
  const [expanded, setExpanded] = useState(false)

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const sessionIds = view.sessionId ? [view.sessionId] : []
  const ids = new Set([turn.id, ...turn.sourceIds])
  const mine = selectSubagentRuns(subagents, { sessionIds }).all.filter(
    (run) => run.parentMessageId && ids.has(run.parentMessageId) && run.review !== 'merged' && run.review !== 'discarded'
  )
  if (!mine.length) return null
  const ordered = [...mine].sort((a, b) => a.startedAt - b.startedAt)
  const live = ordered.filter(isLiveRun).length
  const foldable = ordered.length > SUBAGENT_FOLD_AT
  const rows = ordered.map((run) => <SubagentRow key={run.id} run={run} owner={view.key} snapshot={findSubagentSnapshot(runs, run.id)} />)

  if (!foldable) {
    return (
      <div className="v3-subagents" data-testid="v3-subagents">
        {ordered.length > 1 ? (
          <div className="v3-subagents-sum" data-testid="v3-subagents-sum">{tt('subagentGroup', { n: ordered.length, live })}</div>
        ) : null}
        {rows}
      </div>
    )
  }

  const failed = ordered.filter((run) => run.status === 'error').length
  const finished = ordered.length - live
  const counts = [
    tt('subagentCount', { n: ordered.length }),
    live ? tt('subagentLiveCount', { n: live }) : null,
    finished - failed ? tt('subagentDoneCount', { n: finished - failed }) : null,
    failed ? tt('subagentFailedCount', { n: failed }) : null
  ].filter(Boolean).join(' · ')
  const toggle = (): void => setExpanded((value) => !value)
  return (
    <div className="v3-subagents" data-testid="v3-subagents" data-folded={expanded ? undefined : '1'}>
      <Button
        variant="ghost"
        size="sm"
        className="v3-subagents-head"
        aria-expanded={expanded}
        onPress={toggle}
        trailingIcon={<Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />}
        data-testid="v3-subagents-sum"
      >
        {counts}
      </Button>
      <ProgressBar
        className="v3-subagents-progress"
        aria-label={counts}
        value={finished}
        maxValue={ordered.length}
        data-testid="v3-subagents-progress"
      />
      {expanded ? rows : <SubagentStack runs={ordered} owner={view.key} snapshots={runs} />}
      <Button variant="ghost" size="sm" className="v3-subagents-more" onPress={toggle} data-testid="v3-subagents-more">
        {expanded ? tt('subagentShowLess') : tt('subagentShowAll', { n: ordered.length })}
      </Button>
    </div>
  )
}

function SubagentStack({ runs, owner, snapshots }: { runs: SubagentRun[]; owner: string; snapshots: RunSnapshot[] }): JSX.Element {
  const tt = useSessionText()
  const sequence = subagentStackOrder(runs)
  const [offset, setOffset] = useState(0)
  const [direction, setDirection] = useState<'up' | 'down'>('up')
  const selectedId = useSubagentPanel((s) => (s.owner === owner ? s.runId : null))
  const stackRef = useRef<HTMLDivElement>(null)
  const wheelRef = useRef(0)
  const { start, end, max } = subagentStackWindow(sequence.length, offset)
  const maxRef = useRef(max)
  const offsetRef = useRef(start)
  maxRef.current = max
  offsetRef.current = start

  const moveTo = useCallback((next: number) => {
    const current = offsetRef.current
    const clamped = Math.min(Math.max(0, next), maxRef.current)
    if (clamped === current) return
    offsetRef.current = clamped
    setDirection(clamped > current ? 'up' : 'down')
    setOffset(clamped)
  }, [])

  const selectedIndex = selectedId ? sequence.findIndex((run) => run.id === selectedId) : -1
  useEffect(() => {
    if (selectedIndex < 0) return
    const current = offsetRef.current
    if (selectedIndex >= current && selectedIndex < current + SUBAGENT_FOLD_AT) return
    moveTo(selectedIndex - 1)
  }, [selectedIndex, moveTo])

  useEffect(() => {
    const node = stackRef.current
    if (!node) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      const goingUp = event.deltaY < 0
      const current = offsetRef.current
      if ((goingUp && current >= maxRef.current) || (!goingUp && current <= 0)) {
        wheelRef.current = 0
        return
      }
      event.preventDefault()
      if (Math.sign(wheelRef.current) !== Math.sign(event.deltaY)) wheelRef.current = 0
      wheelRef.current += event.deltaY
      if (Math.abs(wheelRef.current) < WHEEL_STEP) return
      wheelRef.current = 0
      moveTo(current + (goingUp ? 1 : -1))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [moveTo])

  const older = sequence.length - end
  const visible = sequence.slice(start, end).reverse()
  const ticks = [...sequence].reverse()
  const tabStop = sequence.length - 1 - start
  const position = tt('subagentStackPosition', { from: start + 1, to: end, n: sequence.length })

  return (
    <div
      ref={stackRef}
      className="v3-sa-stack"
      data-testid="v3-subagent-stack"
      data-direction={direction}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        moveTo(offsetRef.current + (event.key === 'ArrowUp' ? 1 : -1))
      }}
    >
      <nav className="v3-sa-ticks" aria-label={position} data-testid="v3-subagent-ticks">
        {ticks.map((run, index) => {
          const seqIndex = sequence.length - 1 - index
          const inView = seqIndex >= start && seqIndex < end
          return (
            <button
              key={run.id}
              type="button"
              className="v3-sa-tick"
              data-testid="v3-subagent-tick"
              data-tone={tickTone(run)}
              data-view={inView ? '1' : undefined}
              aria-current={inView ? 'true' : undefined}
              aria-label={compactTaskPaths(subagentTitle(run.task))}
              title={compactTaskPaths(subagentTitle(run.task))}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => moveTo(seqIndex - 1)}
            >
              <span className="v3-sa-bar" />
            </button>
          )
        })}
      </nav>
      <div className="v3-sa-cards">
        {older > 0 ? (
          <div className="v3-sa-pile" data-side="above" data-testid="v3-subagent-pile" title={tt('subagentStackOlder', { n: older })} aria-hidden>
            {older > 1 ? <span className="v3-sa-sliver" data-depth="2" /> : null}
            <span className="v3-sa-sliver" data-depth="1" />
          </div>
        ) : null}
        {visible.map((run) => (
          <SubagentRow key={run.id} run={run} owner={owner} snapshot={findSubagentSnapshot(snapshots, run.id)} />
        ))}
        {start > 0 ? (
          <div className="v3-sa-pile" data-side="below" data-testid="v3-subagent-pile-below" title={tt('subagentStackNewer', { n: start })} aria-hidden>
            <span className="v3-sa-sliver" data-depth="1" />
            {start > 1 ? <span className="v3-sa-sliver" data-depth="2" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SubagentRow({ run, owner, snapshot }: { run: SubagentRun; owner: string; snapshot?: RunSnapshot }): JSX.Element {
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
