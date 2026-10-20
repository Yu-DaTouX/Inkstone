import { useEffect, useState, type JSX, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3, phaseWord, runTone } from '../../state/runs-v3'
import { findSubagentSnapshot, subagentLineModel, type SubagentLineModel } from './turn-lines'
import { selectSubagentRuns, subagentRunsForTurnScope, type TurnSubagentScope } from '../../state/subagent-view'
import { sessionViewIdentity } from './view-state'
import { formatDuration } from '../../../../shared/duration'
import { subagentSummaryLine, type SubagentTaskRow } from '../../../../shared/subagent-task-rows'
import type { SubagentOutcomeKey } from '../../../../shared/subagent-outcome'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { AssistantTurn } from '../../../../shared/turns'
import { Icon } from './Icon'
import { SubagentBot } from './SubagentBot'
import { SubagentStateIcon } from './SubagentState'
import { useSessionText, type SessionTextKey } from './text'
import { openSubagentPane, rowLang, useFocusedSubagentRun, useSubagentPaneOpen, useSubagentRow } from './subagent-actions'
import {
  orderSubagentRuns,
  subagentListOpen,
  subagentListSlice,
  subagentListTotals,
  subagentRowFocusTarget,
  useSubagentGroups,
  type SubagentListTotals
} from './subagent-list'
import { useToolExpansion } from './use-tool-run'
import { turnModelLabel } from './turn-model-label'
import { Button, Card, ProgressBar, ShimmerText } from '../../ui'

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

const NO_RUNS: SubagentRun[] = []

type SessionText = (key: SessionTextKey, vars?: Record<string, string | number>) => string

function viewIdentityOf(s: ReturnType<typeof useStore.getState>): ReturnType<typeof sessionViewIdentity> {
  return sessionViewIdentity({ peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath, session: s.session })
}

export function subagentCountsText(totals: SubagentListTotals, tt: SessionText): string {
  return [
    tt('subagentCount', { n: totals.total }),
    totals.live ? tt('subagentLiveCount', { n: totals.live }) : null,
    totals.failed ? tt('subagentFailedCount', { n: totals.failed }) : null,
    totals.done ? tt('subagentDoneCount', { n: totals.done }) : null,
    totals.stopped ? tt('subagentStoppedCount', { n: totals.stopped }) : null
  ].filter(Boolean).join(' · ')
}

export function subagentCollapsedText(totals: SubagentListTotals, tt: SessionText, lang: string): string {
  if (!totals.ended) return subagentCountsText(totals, tt)
  const outcome = totals.failed || totals.stopped
    ? subagentCountsText(totals, tt)
    : `${tt('subagentCount', { n: totals.total })} · ${tt('subagentAllDone')}`
  const usage = subagentSummaryLine(
    { toolCalls: totals.toolCalls, tokens: totals.tokens || null, durationMs: totals.spanMs },
    rowLang(lang)
  )
  return `${outcome} · ${usage}`
}

export function subagentRowUsage(
  row: Pick<SubagentTaskRow, 'state' | 'latestActivity' | 'toolCalls' | 'tokens'>,
  error: string | null,
  failedWord: string,
  tt: SessionText,
  lang: string
): string {
  if (row.state === 'failed') return firstLine(error ?? '') || failedWord
  if (row.state === 'done' || row.state === 'stopped') {
    return subagentSummaryLine({ toolCalls: row.toolCalls, tokens: row.tokens, durationMs: null }, rowLang(lang))
  }
  return [row.state === 'starting' ? null : row.latestActivity, row.toolCalls > 0 ? tt('subagentCalls', { n: row.toolCalls }) : null].filter(Boolean).join(' · ')
}

function focusRow(list: HTMLElement, index: number): void {
  list.querySelectorAll<HTMLElement>('[data-testid="v3-subagent-row"]')[index]?.focus()
}

export function SubagentLine({ turn, scope }: { turn: AssistantTurn; scope?: TurnSubagentScope }): JSX.Element | null {
  const tt = useSessionText()
  const { lang } = useI18n()
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
  const [storedOpen, setStoredOpen] = useToolExpansion(`subagents:${turn.id}`)
  const [storedAll, setStoredAll] = useToolExpansion(`subagents-all:${turn.id}`)
  const publish = useSubagentGroups((s) => s.publish)
  const selectedRunId = useFocusedSubagentRun()

  const phases: Record<string, RunSnapshot['phase']['kind'] | undefined> = {}
  for (const run of mine) phases[run.id] = snapshots[run.id]?.phase.kind
  const ordered = orderSubagentRuns(mine, phases)
  const signature = ordered.map((run) => run.id).join('\n')

  useEffect(() => {
    if (signature) publish(signature.split('\n'))
  }, [publish, signature])

  if (!ordered.length) return null
  const totals = subagentListTotals(ordered)
  const many = ordered.length > 1
  const open = !many || subagentListOpen(storedOpen, totals)
  const { shown, hidden } = subagentListSlice(ordered, storedAll === true, selectedRunId)
  const canFold = ordered.length > shown.length || storedAll === true

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-testid="v3-subagent-row"]')]
    const index = rows.findIndex((row) => row === document.activeElement)
    if (index < 0) return
    const target = subagentRowFocusTarget(event.key, index, rows.length)
    if (target === null) return
    event.preventDefault()
    focusRow(event.currentTarget, target)
  }

  const head = many ? (
    <div className="v3-subagents-top">
      <Button
        variant="ghost"
        size="sm"
        className="v3-subagents-head"
        aria-expanded={open}
        onPress={() => setStoredOpen(!open)}
        icon={<Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
        trailingIcon={totals.failed ? <SubagentStateIcon state="failed" /> : undefined}
        data-failed={totals.failed ? '1' : undefined}
        data-testid="v3-subagents-sum"
      >
        {subagentCollapsedText(totals, tt, lang)}
      </Button>
      {totals.live ? (
        <ProgressBar
          className="v3-subagents-progress"
          aria-label={subagentCountsText(totals, tt)}
          value={totals.total - totals.live}
          maxValue={totals.total}
          data-testid="v3-subagents-progress"
        />
      ) : null}
    </div>
  ) : null

  return (
    <div className="v3-subagents" data-testid="v3-subagents" data-layout={many ? (open ? 'list' : 'summary') : 'single'}>
      {head}
      {open ? (
        <Card padding="none" className="v3-sa-card">
          <div className="v3-sa-list" role="group" aria-label={tt('subagentListLabel')} onKeyDown={onKeyDown} data-testid="v3-subagent-list">
            {shown.map((run) => (
              <SubagentRow key={run.id} run={run} snapshot={snapshots[run.id]} />
            ))}
            {canFold ? (
              <Button
                variant="ghost"
                size="sm"
                className="v3-sa-more"
                onPress={() => setStoredAll(!(storedAll === true))}
                data-testid="v3-subagents-more"
              >
                {hidden ? tt('subagentShowMore', { n: hidden }) : tt('subagentShowLess')}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

function SubagentRow({ run, snapshot }: { run: SubagentRun; snapshot?: RunSnapshot }): JSX.Element {
  const tt = useSessionText()
  const t = useT()
  const { lang } = useI18n()
  const { model, status } = useSubagentView(run, snapshot)
  const row = useSubagentRow(run)
  const selected = useSubagentPaneOpen(run.id)
  const models = useStore((s) => s.models)
  const modelName = run.model ? turnModelLabel(run.model, models).label : null
  const label = compactTaskPaths(row.label)
  const time = row.durationMs === null ? '' : formatDuration(row.durationMs, { minSeconds: 1 })
  const usage = subagentRowUsage(row, model.error, t(OUTCOME_KEY[model.outcomeKey]), tt, lang)
  const live = row.state === 'starting' || row.state === 'running'

  return (
    <button
      type="button"
      className="ui-row v3-sa-row"
      data-testid="v3-subagent-row"
      data-run-id={run.id}
      data-state={row.state}
      data-selected={selected ? '' : undefined}
      aria-current={selected ? 'true' : undefined}
      title={`${model.task}\n${tt('subagentOpenPane')}`}
      onClick={() => openSubagentPane(run.id)}
    >
      <span className="v3-sa-bot" aria-hidden="true">
        <SubagentBot run={run} snapshot={snapshot} model={model} size={SUBAGENT_CARD_BOT} />
      </span>
      <span className="v3-sa-state">
        <SubagentStateIcon state={row.state} label={status} />
      </span>
      <span className="v3-sa-title" data-testid="v3-subagent-task">
        {live ? <ShimmerText>{label}</ShimmerText> : label}
      </span>
      {modelName ? <span className="v3-sa-model" data-testid="v3-subagent-model" title={run.model}>{modelName}</span> : null}
      {usage ? (
        <span className="v3-sa-usage" data-testid="v3-subagent-usage" title={row.state === 'failed' ? model.error ?? undefined : undefined}>{usage}</span>
      ) : null}
      {time ? <span className="v3-sa-time" data-testid="v3-subagent-time">{time}</span> : null}
      <Icon name="chevron-right" size={13} className="v3-chev" />
    </button>
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
