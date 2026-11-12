import { useEffect, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { useWorkflows, workflowsForTurn } from '../../state/workflows'
import type { TurnSubagentScope } from '../../state/subagent-view'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { AssistantTurn } from '../../../../shared/turns'
import {
  isLargeWorkflow,
  isLiveWorkflow,
  workflowAnchor,
  workflowPhaseStats,
  workflowTotals,
  type WorkflowRunView,
  type WorkflowStatus
} from '../../../../shared/workflows'
import { Badge, Button, ProgressBar } from '../../ui'
import { Card, CardStatus, CardSummary, CardTitle, type CardStatusTone } from '../../ui/Card'
import { Icon } from './Icon'
import { findSubagentSnapshot } from './turn-lines'
import { sessionViewIdentity } from './view-state'
import { subagentAnchorIds, useSubagentGroups } from './subagent-list'
import { SubagentTile } from './SubagentLine'
import { useToolExpansion } from './use-tool-run'
import './workflows.css'

const STATUS_KEY: Record<WorkflowStatus, MessageKey> = {
  running: 'wf.status.running',
  paused: 'wf.status.paused',
  done: 'wf.status.done',
  failed: 'wf.status.failed',
  stopped: 'wf.status.stopped',
  interrupted: 'wf.status.interrupted'
}

const STATUS_TONE: Record<WorkflowStatus, CardStatusTone> = {
  running: 'run',
  paused: 'ask',
  done: 'ok',
  failed: 'fail',
  stopped: 'muted',
  interrupted: 'ask'
}

const TILES_SHOWN = 12
const NO_RUNS: WorkflowRunView[] = []
let anchorCache: { messages: unknown; runs: Record<string, WorkflowRunView>; anchors: Map<string, string> } | null = null

function workflowAnchors(messages: Parameters<typeof subagentAnchorIds>[0], runs: Record<string, WorkflowRunView>): Map<string, string> {
  if (anchorCache?.messages === messages && anchorCache.runs === runs) return anchorCache.anchors
  const pseudo = Object.values(runs).map((run) => ({ id: run.id, parentMessageId: run.parentMessageId, startedAt: run.startedAt }))
  const anchors = subagentAnchorIds(messages, pseudo)
  anchorCache = { messages, runs, anchors }
  return anchors
}

export function WorkflowCards({ turn, scope }: { turn: AssistantTurn; scope?: TurnSubagentScope }): JSX.Element | null {
  useEffect(() => {
    void useWorkflows.getState().load()
  }, [])
  const identity = useStore(useShallow((s) => {
    const view = sessionViewIdentity({ peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath, session: s.session })
    return { sessionId: view.sessionId, messages: s.messages }
  }))
  const allRuns = useWorkflows((s) => s.runs)
  const runs = useMemo(() => {
    if (!Object.keys(allRuns).length) return NO_RUNS
    const anchors = workflowAnchors(identity.messages, allRuns)
    const ids = new Set([turn.id, ...turn.sourceIds])
    const sessionIds = scope ? scope.sessionIds : identity.sessionId ? [identity.sessionId] : []
    const remapped: Record<string, WorkflowRunView> = {}
    for (const run of Object.values(allRuns)) remapped[run.id] = { ...run, parentMessageId: anchors.get(run.id) ?? run.parentMessageId }
    const found = workflowsForTurn(remapped, ids, sessionIds, scope?.parentRunIds ?? [])
    return found.length ? found.map((run) => allRuns[run.id]) : NO_RUNS
  }, [allRuns, identity.messages, identity.sessionId, scope, turn.id, turn.sourceIds])
  if (!runs.length) return null
  return (
    <>
      {runs.map((run) => <WorkflowCard key={run.id} run={run} />)}
    </>
  )
}

function WorkflowCard({ run }: { run: WorkflowRunView }): JSX.Element {
  const t = useT()
  const [storedOpen, setStoredOpen] = useToolExpansion(`workflow:${run.id}`)
  const [storedAll, setStoredAll] = useToolExpansion(`workflow-all:${run.id}`)
  const [busy, setBusy] = useState<'pause' | 'resume' | 'stop' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const anchor = workflowAnchor(run.id)
  const ids = useMemo(() => new Set(run.agents.map((agent) => agent.subagentId).filter((id): id is string => !!id)), [run.agents])
  const subagents = useStore(useShallow((s): SubagentRun[] => s.subagents.filter((item) => item.parentMessageId === anchor || ids.has(item.id))))
  const snapshots = useRunsV3(useShallow((s): Record<string, RunSnapshot | undefined> => {
    const found: Record<string, RunSnapshot | undefined> = {}
    for (const item of subagents) found[item.id] = findSubagentSnapshot(s.runs, item.id)
    return found
  }))
  const publish = useSubagentGroups((s) => s.publish)
  const byId = useMemo(() => new Map(subagents.map((item) => [item.id, item])), [subagents])
  const ordered = useMemo(() => run.agents.map((agent) => agent.subagentId).filter((id): id is string => !!id && byId.has(id)), [run.agents, byId])
  const signature = [...new Set(ordered)].join('\n')
  useEffect(() => {
    if (signature) publish(signature.split('\n'))
  }, [publish, signature])

  const live = isLiveWorkflow(run.status)
  const totals = workflowTotals(run)
  const phases = workflowPhaseStats(run)
  const large = isLargeWorkflow(run)
  const open = storedOpen === true
  const showAll = storedAll === true
  const latestLog = run.logs.length ? run.logs[run.logs.length - 1] : ''
  const statusText = t(STATUS_KEY[run.status])
  const tone = STATUS_TONE[run.status]
  const counts = [
    t('wf.counts', { done: totals.done, total: totals.total }),
    totals.failed ? t('wf.failedCount', { n: totals.failed }) : null,
    totals.queued && live ? t('wf.queuedCount', { n: totals.queued }) : null
  ].filter(Boolean).join(' · ')

  const act = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    setBusy(action)
    setActionError(null)
    try {
      const result = await window.yan.workflows[action](run.id)
      if (!result.ok) setActionError(t('wf.actionFailed', { error: result.error ?? '' }))
    } catch (error) {
      setActionError(t('wf.actionFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(null)
    }
  }

  let tileIndex = 0
  return (
    <div className="v3-subagents v3-wf" data-testid="v3-workflow" data-run-id={run.id} data-status={run.status} data-large={large ? '' : undefined}>
      <Card padding="none" receipt={!live} className="v3-sa-card">
        <CardSummary
          className="v3-wf-head"
          expanded={open}
          onPress={() => setStoredOpen(!open)}
          title={run.description}
          data-testid="v3-workflow-head"
        >
          <CardStatus tone={tone} icon={tone === 'fail' ? <Icon name="warn" size={14} /> : tone === 'ok' ? <Icon name="check" size={14} /> : undefined}>
            {statusText}
          </CardStatus>
          <CardTitle clamp>{`${t('wf.label')} · ${run.name} · ${counts}`}</CardTitle>
          {large ? <Badge tone="ask" className="v3-wf-large" title={t('wf.largeHint')} data-testid="v3-workflow-large">{t('wf.large')}</Badge> : null}
        </CardSummary>
        <div className="v3-wf-body">
          {phases.length ? (
            <ol className="v3-wf-phases" aria-label={t('wf.phases')} data-testid="v3-workflow-phases">
              {phases.map((phase) => {
                const title = phase.title || t('wf.phaseUnnamed')
                const state = phase.total === 0 ? 'idle' : phase.done + phase.failed >= phase.total ? (phase.failed ? 'partial' : 'done') : phase.running ? 'running' : 'waiting'
                return (
                  <li key={phase.title || '-'} className="v3-wf-phase" data-state={state} data-testid="v3-workflow-phase">
                    <span className="v3-wf-phase-head">
                      <span className="v3-wf-phase-name">{title}</span>
                      <span className="v3-wf-phase-count">{`${phase.done}/${phase.total}`}</span>
                    </span>
                    <ProgressBar
                      aria-label={t('wf.phaseProgress', { title, done: phase.done, total: phase.total })}
                      value={phase.done}
                      maxValue={Math.max(1, phase.total)}
                      tone={phase.failed > phase.stopped ? 'fail' : phase.stopped ? 'muted' : state === 'done' ? 'ink' : 'run'}
                    />
                  </li>
                )
              })}
            </ol>
          ) : null}
          {latestLog || run.error || actionError ? (
            <p className="v3-wf-note" data-tone={run.error || actionError ? 'fail' : undefined} data-testid="v3-workflow-note">{actionError ?? run.error ?? latestLog}</p>
          ) : null}
          {live ? (
            <div className="v3-wf-actions">
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy !== null}
                onPress={() => void act(run.status === 'paused' ? 'resume' : 'pause')}
                data-testid="v3-workflow-pause"
              >
                {run.status === 'paused' ? t('wf.resume') : t('wf.pause')}
              </Button>
              <Button size="sm" variant="ghost" isDisabled={busy !== null} onPress={() => void act('stop')} data-testid="v3-workflow-stop">
                {t('wf.stop')}
              </Button>
            </div>
          ) : null}
        </div>
        {open ? (
          <div className="v3-wf-groups" data-testid="v3-workflow-grid">
            {phases.map((phase) => {
              const agents = run.agents.filter((agent) => (agent.phase ?? '') === phase.title)
              const tiles = agents.map((agent) => (agent.subagentId ? byId.get(agent.subagentId) : undefined)).filter((item): item is SubagentRun => !!item)
              const unique = [...new Map(tiles.map((item) => [item.id, item])).values()]
              const shown = showAll ? unique : unique.slice(0, TILES_SHOWN)
              const waiting = agents.filter((agent) => !agent.subagentId).length
              if (!unique.length && !waiting) return null
              return (
                <section key={phase.title || '-'} className="v3-wf-group" aria-label={phase.title || t('wf.phaseUnnamed')}>
                  <h4 className="v3-wf-group-title">{`${phase.title || t('wf.phaseUnnamed')} · ${phase.done}/${phase.total}`}</h4>
                  {shown.length ? (
                    <div className="v3-sa-list" data-layout="grid" role="group">
                      {shown.map((item) => <SubagentTile key={item.id} run={item} snapshot={snapshots[item.id]} index={tileIndex++} />)}
                    </div>
                  ) : null}
                  {waiting ? <p className="v3-wf-waiting">{t('wf.queuedCount', { n: waiting })}</p> : null}
                  {unique.length > shown.length ? (
                    <Button variant="ghost" size="sm" className="v3-wf-more" onPress={() => setStoredAll(true)} data-testid="v3-workflow-more">
                      {t('wf.showMore', { n: unique.length - shown.length })}
                    </Button>
                  ) : null}
                </section>
              )
            })}
          </div>
        ) : null}
      </Card>
    </div>
  )
}
