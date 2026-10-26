import { useEffect, useState, type CSSProperties, type JSX, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { THINK_LABEL } from '../../state/think-label'
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
import './subagents.css'
import { turnModelLabel } from './turn-model-label'
import { Button, ProgressBar, ShimmerText } from '../../ui'
import { Card, CardStatus, CardSummary, CardTitle, type CardStatusTone } from '../../ui/Card'
import { ContextGauge } from '../../patterns/ContextGauge'

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

function subagentCountsText(totals: SubagentListTotals, tt: SessionText): string {
  return [
    tt('subagentCount', { n: totals.total }),
    totals.live ? tt('subagentLiveCount', { n: totals.live }) : null,
    totals.failed ? tt('subagentFailedCount', { n: totals.failed }) : null,
    totals.done ? tt('subagentDoneCount', { n: totals.done }) : null,
    totals.stopped ? tt('subagentStoppedCount', { n: totals.stopped }) : null
  ].filter(Boolean).join(' · ')
}

type SubagentCount = 'live' | 'failed' | 'done' | 'stopped'

const COUNT_KEY: Record<SubagentCount, SessionTextKey> = {
  live: 'subagentLiveCount',
  failed: 'subagentFailedCount',
  done: 'subagentDoneCount',
  stopped: 'subagentStoppedCount'
}

const COUNT_ORDER: readonly SubagentCount[] = ['live', 'failed', 'done', 'stopped']

const LEAD_TONE: Record<SubagentCount, CardStatusTone> = { failed: 'fail', live: 'run', stopped: 'muted', done: 'ok' }

function subagentSummary(totals: SubagentListTotals, tt: SessionText, lang: string): {
  tone: CardStatusTone
  status: string
  title: string
  usage: string | null
} {
  const lead: SubagentCount | null = totals.failed ? 'failed' : totals.live ? 'live' : totals.stopped ? 'stopped' : null
  const rest = lead ? COUNT_ORDER.filter((key) => key !== lead && totals[key] > 0).map((key) => tt(COUNT_KEY[key], { n: totals[key] })) : []
  const usage = totals.ended
    ? subagentSummaryLine({ toolCalls: totals.toolCalls, tokens: totals.tokens || null, durationMs: totals.spanMs }, rowLang(lang))
    : null
  return {
    tone: lead ? LEAD_TONE[lead] : 'ok',
    status: lead ? tt(COUNT_KEY[lead], { n: totals[lead] }) : tt('subagentAllDone'),
    title: [tt('subagentCount', { n: totals.total }), ...rest].join(' · '),
    usage
  }
}

function subagentRowUsage(
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

function subagentContextUsage(
  usage: SubagentRun['contextUsage']
): { tokens: number; windowSize: number; percent: number; tone: 'ok' | 'ask' | 'fail' } | null {
  if (!usage || typeof usage.tokens !== 'number' || !(usage.contextWindow > 0)) return null
  const percent = Math.max(0, Math.min(100, (usage.tokens / usage.contextWindow) * 100))
  const tone = percent >= 95 ? 'fail' : percent >= 80 ? 'ask' : 'ok'
  return { tokens: usage.tokens, windowSize: usage.contextWindow, percent, tone }
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

  const summary = subagentSummary(totals, tt, lang)
  const head = many ? (
    <>
      <CardSummary
        className="v3-subagents-head"
        expanded={open}
        onPress={() => setStoredOpen(!open)}
        title={open ? undefined : summary.usage ?? undefined}
        data-failed={totals.failed ? '1' : undefined}
        data-testid="v3-subagents-sum"
      >
        <CardStatus tone={summary.tone} icon={summary.tone === 'fail' ? <Icon name="warn" size={14} /> : summary.tone === 'ok' ? <Icon name="check" size={14} /> : undefined}>
          {summary.status}
        </CardStatus>
        <CardTitle clamp>{summary.title}</CardTitle>
      </CardSummary>
      {totals.live ? (
        <ProgressBar
          className="v3-subagents-progress"
          aria-label={subagentCountsText(totals, tt)}
          value={totals.total - totals.live}
          maxValue={totals.total}
          data-testid="v3-subagents-progress"
        />
      ) : null}
    </>
  ) : null

  return (
    <div className="v3-subagents" data-testid="v3-subagents" data-layout={many ? (open ? 'list' : 'summary') : 'single'}>
      <Card padding="none" receipt={totals.ended} className="v3-sa-card">
        {head}
        {open ? (
          <div className="v3-sa-list" role="group" aria-label={tt('subagentListLabel')} onKeyDown={onKeyDown} data-testid="v3-subagent-list">
            {shown.map((run, index) => (
              <SubagentRow key={run.id} run={run} snapshot={snapshots[run.id]} index={index} />
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
            {many && summary.usage ? <p className="v3-sa-totals" data-testid="v3-subagents-usage">{summary.usage}</p> : null}
          </div>
        ) : null}
      </Card>
    </div>
  )
}

function SubagentRow({ run, snapshot, index = 0 }: { run: SubagentRun; snapshot?: RunSnapshot; index?: number }): JSX.Element {
  const tt = useSessionText()
  const t = useT()
  const { lang } = useI18n()
  const { model, status } = useSubagentView(run, snapshot)
  const row = useSubagentRow(run)
  const selected = useSubagentPaneOpen(run.id)
  const models = useStore((s) => s.models)
  const modelName = run.model ? turnModelLabel(run.model, models).label : null
  const thinking = run.thinkingLevel && run.thinkingLevel !== 'off' ? run.thinkingLevel : null
  const thinkText = thinking ? (THINK_LABEL[thinking] ? t(THINK_LABEL[thinking]) : thinking) : null
  const modelTail = [thinkText, run.fork ? 'fork' : null].filter(Boolean).join(' · ')
  const live = row.state === 'starting' || row.state === 'running'
  const label = compactTaskPaths(live && row.description ? row.description : row.label)
  const time = row.durationMs === null ? '' : formatDuration(row.durationMs, { minSeconds: 1 })
  const summary = live ? '' : subagentRowUsage(row, model.error, t(OUTCOME_KEY[model.outcomeKey]), tt, lang)
  const context = row.state === 'failed' ? null : subagentContextUsage(run.contextUsage)
  const usage = context ? '' : summary
  const rowTitle = [model.task, context && summary ? summary : null, tt('subagentOpenPane')].filter(Boolean).join('\n')

  return (
    <button
      type="button"
      className="ui-row v3-sa-row"
      data-testid="v3-subagent-row"
      data-run-id={run.id}
      data-state={row.state}
      data-selected={selected ? '' : undefined}
      aria-current={selected ? 'true' : undefined}
      title={rowTitle}
      style={{ '--sa-index': index } as CSSProperties}
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
      {modelName ? (
        <span className="v3-sa-model" data-testid="v3-subagent-model" title={run.model}>
          <span className="v3-sa-model-name">{modelName}</span>
          {modelTail ? <span className="v3-sa-model-tail">{` · ${modelTail}`}</span> : null}
        </span>
      ) : null}
      {context ? <ContextGauge usage={context} className="v3-sa-usage" data-testid="v3-subagent-context" /> : null}
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
