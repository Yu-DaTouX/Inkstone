import { useEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3, phaseWord, runTone } from '../../state/runs-v3'
import { findSubagentSnapshot, subagentLineModel, type SubagentLineModel } from './turn-lines'
import { selectSubagentRuns, subagentRunsForTurnScope, type TurnSubagentScope } from '../../state/subagent-view'
import { sessionViewIdentity } from './view-state'
import { formatDuration } from '../../../../shared/duration'
import { isLiveSubagentRun } from '../../../../shared/subagent-task-rows'
import type { SubagentOutcomeKey } from '../../../../shared/subagent-outcome'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { AssistantTurn } from '../../../../shared/turns'
import { Icon } from './Icon'
import { SubagentBot } from './SubagentBot'
import { SubagentStateIcon } from './SubagentState'
import { useSessionText } from './text'
import { openSubagentPane, useFocusedSubagentRun, useSubagentPaneOpen, useSubagentRow } from './subagent-actions'
import {
  DECK_DOTS_MAX,
  DECK_EDGES_MAX,
  DECK_ROWS_MAX,
  createDeckWheelState,
  deckKeyTarget,
  deckSlot,
  deckStripDepth,
  deckTouchStep,
  deckVisible,
  deckWheelDelta,
  deckWheelStep
} from './subagent-deck'
import { turnModelLabel } from './turn-model-label'
import { Button, ProgressBar, StatusDot } from '../../ui'

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

export const SUBAGENT_STRIP_BOT = 16
export const SUBAGENT_CARD_BOT = 20

export function useSubagentView(run: SubagentRun, snapshot?: RunSnapshot): {
  model: SubagentLineModel
  status: string
  tone: string
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
  const tone = dotTone === 'run' || dotTone === 'live' ? 'run'
    : dotTone === 'ok' || dotTone === 'done' ? 'ok'
      : dotTone === 'err' || dotTone === 'fail' ? 'fail'
        : dotTone === 'ask' || dotTone === 'stall' || dotTone === 'warn' ? 'ask'
          : ''
  return { model, status, tone }
}

export function subagentDeckOrder(runs: SubagentRun[]): SubagentRun[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt)
}

export function subagentDefaultFront(runs: SubagentRun[], selectedId: string | null): string | null {
  if (!runs.length) return null
  if (selectedId && runs.some((run) => run.id === selectedId)) return selectedId
  const newest = (list: SubagentRun[]): SubagentRun => list.reduce((best, run) => (run.startedAt >= best.startedAt ? run : best))
  const live = runs.filter(isLiveSubagentRun)
  return newest(live.length ? live : runs).id
}

type DeckRefocus = 'deck' | 'card' | null

const NO_RUNS: SubagentRun[] = []

function viewIdentityOf(s: ReturnType<typeof useStore.getState>): ReturnType<typeof sessionViewIdentity> {
  return sessionViewIdentity({ peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath, session: s.session })
}

export function SubagentLine({ turn, scope }: { turn: AssistantTurn; scope?: TurnSubagentScope }): JSX.Element | null {
  const tt = useSessionText()
  const mine = useStore(useShallow((s): SubagentRun[] => {
    if (!s.subagents.length) return NO_RUNS
    const ids = new Set([turn.id, ...turn.sourceIds])
    const identity = viewIdentityOf(s)
    const sessionIds = identity.sessionId ? [identity.sessionId] : []
    return (scope ? subagentRunsForTurnScope(s.subagents, scope) : selectSubagentRuns(s.subagents, { sessionIds }).all).filter(
      (run) => run.parentMessageId && ids.has(run.parentMessageId) && run.review !== 'merged' && run.review !== 'discarded'
    )
  }))
  const snapshots = useRunsV3(useShallow((s): Record<string, RunSnapshot | undefined> => {
    const found: Record<string, RunSnapshot | undefined> = {}
    for (const run of mine) found[run.id] = findSubagentSnapshot(s.runs, run.id)
    return found
  }))
  const [flat, setFlat] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const deckRef = useRef<HTMLDivElement | null>(null)
  const refocus = useRef<DeckRefocus>(null)
  const latest = useRef<{ index: number; ids: string[] }>({ index: 0, ids: [] })

  const selectedRunId = useFocusedSubagentRun()
  const ordered = subagentDeckOrder(mine)
  const pickedValid = picked !== null && ordered.some((run) => run.id === picked)
  const frontId = pickedValid ? picked : subagentDefaultFront(ordered, selectedRunId)
  const selectedInGroup = selectedRunId !== null && ordered.some((run) => run.id === selectedRunId)
  const current = Math.max(0, ordered.findIndex((run) => run.id === frontId))
  const deckOn = ordered.length > 1 && !flat
  latest.current = { index: current, ids: ordered.map((run) => run.id) }

  useEffect(() => {
    if (selectedInGroup) setPicked(selectedRunId)
  }, [selectedInGroup, selectedRunId])

  useEffect(() => {
    const node = deckRef.current
    if (!node) return undefined
    const wheel = createDeckWheelState()
    let touchY: number | null = null
    const go = (target: number | null): void => {
      const id = target === null ? undefined : latest.current.ids[target]
      if (id) setPicked(id)
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return
      const step = deckWheelStep(wheel, deckWheelDelta(event, node.clientHeight), performance.now(), latest.current.index, latest.current.ids.length)
      if (step.prevent) event.preventDefault()
      go(step.target)
    }
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent): void => {
      const y = event.touches[0]?.clientY
      if (touchY === null || y === undefined) return
      const step = deckTouchStep(touchY, y, latest.current.index, latest.current.ids.length)
      if (step.prevent && event.cancelable) event.preventDefault()
      touchY = step.startY
      go(step.target)
    }
    const onTouchEnd = (): void => {
      touchY = null
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: false })
    node.addEventListener('touchend', onTouchEnd)
    node.addEventListener('touchcancel', onTouchEnd)
    return () => {
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('touchstart', onTouchStart)
      node.removeEventListener('touchmove', onTouchMove)
      node.removeEventListener('touchend', onTouchEnd)
      node.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [deckOn])

  useEffect(() => {
    const mode = refocus.current
    if (!mode) return
    refocus.current = null
    const node = deckRef.current
    if (!node) return
    if (mode === 'deck') node.focus({ preventScroll: true })
    else node.querySelector<HTMLElement>('[data-slot="0"] .v3-subagent-toggle')?.focus({ preventScroll: true })
  }, [frontId])

  if (!ordered.length) return null
  const live = ordered.filter(isLiveSubagentRun).length
  const renderRow = (run: SubagentRun, extra?: { front?: boolean; inert?: boolean }): JSX.Element => (
    <SubagentRow key={run.id} run={run} snapshot={snapshots[run.id]} front={extra?.front} inert={extra?.inert} />
  )
  const liveLine = live > 0 ? (
    <p className="v3-subagents-live" data-testid="v3-subagents-live">
      <StatusDot kind="running" />
      <span>{tt('subagentRunningTasks', { n: live })}</span>
    </p>
  ) : null

  if (ordered.length === 1) {
    return (
      <div className="v3-subagents" data-testid="v3-subagents" data-layout="single">
        {renderRow(ordered[0])}
        {liveLine}
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
  const toggle = (): void => setFlat((value) => !value)
  const flip = (index: number, mode: DeckRefocus): void => {
    const run = ordered[index]
    if (!run || run.id === frontId) return
    refocus.current = mode
    setPicked(run.id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const target = deckKeyTarget(event.key, current, ordered.length)
    if (target === null) return
    event.preventDefault()
    flip(target, event.target === event.currentTarget ? null : 'card')
  }
  const rows = Math.min(ordered.length, DECK_ROWS_MAX)
  const edges = Math.min(Math.max(ordered.length - DECK_ROWS_MAX, 0), DECK_EDGES_MAX)

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
      </div>
      {flat ? (
        <>
          <div className="v3-subagents-list">{ordered.map((run) => renderRow(run))}</div>
          <Button variant="ghost" size="sm" className="v3-subagents-less" onPress={toggle} data-testid="v3-subagents-less">
            {tt('subagentShowLess')}
          </Button>
        </>
      ) : (
        <div
          className="v3-sa-deck"
          role="group"
          aria-label={tt('subagentDeckLabel')}
          tabIndex={0}
          ref={deckRef}
          onKeyDown={onKeyDown}
          data-testid="v3-subagent-deck"
        >
          <div className="v3-sa-window" style={{ '--sa-rows': rows, '--sa-edges': edges } as CSSProperties}>
            {ordered.map((run, index) => {
              const slot = deckSlot(index, current)
              if (!deckVisible(slot)) return null
              return (
                <div
                  key={run.id}
                  className="v3-sa-slot"
                  data-slot={slot}
                  data-testid="v3-subagent-slot"
                  aria-hidden={slot < -1 || slot > 2 ? true : undefined}
                >
                  {Math.abs(slot) <= 1 ? renderRow(run, { front: slot === 0, inert: slot !== 0 }) : null}
                  <SubagentStrip run={run} snapshot={snapshots[run.id]} slot={slot} onPick={() => flip(index, 'deck')} />
                </div>
              )
            })}
          </div>
          <div className="v3-sa-nav" data-testid="v3-subagent-nav">
            <span className="v3-sa-hint">{tt('subagentDeckHint')}</span>
            <span className="v3-sa-where">
              {ordered.length <= DECK_DOTS_MAX ? (
                <span className="v3-sa-dots" data-testid="v3-subagent-dots">
                  {ordered.map((run, index) => (
                    <button
                      key={run.id}
                      type="button"
                      className="v3-sa-dot"
                      data-on={index === current ? '1' : undefined}
                      tabIndex={-1}
                      aria-label={tt('subagentDeckGo', { n: index + 1 })}
                      onClick={() => flip(index, 'deck')}
                    />
                  ))}
                </span>
              ) : null}
              <span className="v3-sa-pos" aria-live="polite" data-testid="v3-subagent-pos">{`${current + 1} / ${ordered.length}`}</span>
            </span>
          </div>
        </div>
      )}
      {liveLine}
    </div>
  )
}

function SubagentStrip({ run, snapshot, slot, onPick }: {
  run: SubagentRun
  snapshot?: RunSnapshot
  slot: number
  onPick: () => void
}): JSX.Element {
  const tt = useSessionText()
  const { model, tone } = useSubagentView(run, snapshot)
  const row = useSubagentRow(run)
  const selected = useSubagentPaneOpen(run.id)
  const label = compactTaskPaths(row.label)
  const time = row.durationMs === null ? '' : formatDuration(row.durationMs, { minSeconds: 1 })
  return (
    <button
      type="button"
      className="v3-sa-strip"
      data-testid="v3-subagent-strip"
      data-run-id={run.id}
      data-depth={deckStripDepth(slot)}
      data-edge={slot < 0 ? 'top' : 'bottom'}
      data-state={row.state}
      data-tone={tone || undefined}
      data-selected={selected ? '1' : undefined}
      data-attention={model.attention || !!model.error ? '1' : undefined}
      inert={slot === 0}
      tabIndex={-1}
      aria-label={`${label} · ${time} · ${tt('subagentDeckJump')}`}
      title={`${model.task}\n${tt('subagentDeckJump')}`}
      onClick={onPick}
    >
      <span className="v3-sa-strip-mark" aria-hidden="true">
        <SubagentBot run={run} snapshot={snapshot} model={model} size={SUBAGENT_STRIP_BOT} />
      </span>
      <SubagentStateIcon state={row.state} />
      <span className="v3-sa-strip-task" data-testid="v3-subagent-task">{label}</span>
      <span className="v3-sa-strip-time" data-testid="v3-subagent-time">{time}</span>
    </button>
  )
}

function SubagentRow({ run, snapshot, front, inert }: { run: SubagentRun; snapshot?: RunSnapshot; front?: boolean; inert?: boolean }): JSX.Element {
  const tt = useSessionText()
  const { model, tone } = useSubagentView(run, snapshot)
  const row = useSubagentRow(run)
  const selected = useSubagentPaneOpen(run.id)
  const models = useStore((s) => s.models)
  const modelName = run.model ? turnModelLabel(run.model, models).label : null
  const label = compactTaskPaths(row.label)
  const time = row.durationMs === null ? '' : formatDuration(row.durationMs, { minSeconds: 1 })
  const meta = row.summaryLine ?? time

  return (
    <div
      className="v3-subagent"
      data-testid="v3-subagent-line"
      data-state={row.state}
      data-tone={tone || undefined}
      data-terminal={model.terminal ? '1' : '0'}
      data-selected={selected ? '1' : undefined}
      data-attention={model.attention || !!model.error ? '1' : undefined}
      data-front={front ? '1' : undefined}
      inert={inert || undefined}
    >
      <button
        className="v3-subagent-toggle"
        type="button"
        aria-pressed={selected}
        title={`${model.task}\n${tt('subagentOpenPane')}`}
        onClick={() => openSubagentPane(run.id)}
        data-testid="v3-subagent-toggle"
      >
        <span className="v3-subagent-glyph" aria-hidden="true">
          <SubagentBot run={run} snapshot={snapshot} model={model} size={SUBAGENT_CARD_BOT} />
        </span>
        <SubagentStateIcon state={row.state} />
        <span className="v3-subagent-task" data-testid="v3-subagent-task">{label}</span>
        {modelName ? <span className="v3-subagent-model" data-testid="v3-subagent-model" title={run.model}>{modelName}</span> : null}
        {meta ? <span className="v3-subagent-time" data-testid="v3-subagent-time">{meta}</span> : null}
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
