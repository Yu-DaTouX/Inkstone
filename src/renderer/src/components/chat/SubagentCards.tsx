import { useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import type { SubagentRun, UIMessage } from '../../../../shared/ipc'
import { formatDuration } from '../../../../shared/duration'
import { isDismissed, subagentOutcome, type SubagentOutcome } from '../../../../shared/subagent-outcome'
import { useStore } from '../../state/store'
import { Button } from '../ui'
import { useConfirm } from '../ui/confirm'
import { resolveSubagentModelDisplay } from './turn-model-display'

const DETAIL_LIMIT = 6

export const isLive = (run: SubagentRun): boolean => run.status === 'starting' || run.status === 'running'

function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

const MARK: Record<SubagentOutcome['tone'], string> = { live: '', ok: '✓', warn: '!', err: '✕', mute: '■' }

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const isQuiet = (outcome: SubagentOutcome): boolean => !outcome.live && !outcome.attention

export function SubagentGroup({ runs }: { runs: SubagentRun[] }) {
  const t = useT()
  const now = useNow(runs.some(isLive))
  const [showQuiet, setShowQuiet] = useState(false)
  if (!runs.length) return null
  const ranked = runs
    .map((run) => ({ run, outcome: subagentOutcome(run) }))
    .sort((a, b) => a.run.startedAt - b.run.startedAt)
  const grouped = ranked.length > 1
  const live = ranked.filter(({ outcome }) => outcome.live).length
  const attention = ranked.filter(({ outcome }) => outcome.attention).length
  const quiet = ranked.length - live - attention
  const shown = grouped && !showQuiet ? ranked.filter(({ outcome }) => !isQuiet(outcome)) : ranked
  return (
    <div className="sg-group" data-testid="subagent-group">
      {grouped ? (
        <div className="sg-head" data-testid="subagent-group-head">
          <span className="sg-head-text">
            {[
              t('sa.group.parallel', { n: ranked.length }),
              live ? t('sa.group.live', { n: live }) : '',
              attention ? t('sa.group.attention', { n: attention }) : '',
              quiet ? t('sa.group.quiet', { n: quiet }) : ''
            ].filter(Boolean).join(' · ')}
          </span>
          {quiet ? (
            <Button size="sm" variant="ghost" aria-expanded={showQuiet} onClick={() => setShowQuiet((v) => !v)} data-testid="subagent-group-toggle">
              {t(showQuiet ? 'sa.group.collapse' : 'sa.group.expand')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {shown.map(({ run, outcome }) => (
        <SubagentCard key={run.id} run={run} outcome={outcome} now={now} />
      ))}
    </div>
  )
}

function SubagentCard({ run, outcome, now }: { run: SubagentRun; outcome: SubagentOutcome; now: number }) {
  const t = useT()
  const stopSubagent = useStore((s) => s.stopSubagent)
  const mergeSubagent = useStore((s) => s.mergeSubagent)
  const discardSubagent = useStore((s) => s.discardSubagent)
  const models = useStore((s) => s.models)
  const favorites = useStore((s) => s.settings?.modelFavorites)
  const modelDisplay = run.model ? resolveSubagentModelDisplay(run.model, models, favorites ?? []) : null
  const confirm = useConfirm()
  const [expanded, setExpanded] = useState(false)
  const [dismissBusy, setDismissBusy] = useState(false)
  const [dismissFailed, setDismissFailed] = useState(false)
  const dismissInFlight = useRef(false)
  const { live, attention, tone } = outcome
  const readOnly = run.isolation === 'controlled-cwd'
  const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
  const calls = run.toolCalls ?? run.transcript.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0)
  const changed = run.diff && run.diff.files > 0 ? run.diff : null
  const reviewing = !live && (run.review === 'pending' || run.review === 'conflict')
  const canDismiss = run.status === 'error' && !isDismissed(run) && !reviewing

  const reason =
    outcome.partial && run.status === 'done'
      ? t(run.endReason === 'budget' ? 'sa.partialBudget' : 'sa.partialTimeout')
      : run.status === 'error'
        ? run.error
        : ''

  const context = run.contextUsage
  const contextText = context?.tokens != null
    ? `${compactTokens(context.tokens)}${context.contextWindow > 0 ? ` / ${compactTokens(context.contextWindow)}` : ''}${context.percent != null ? ` (${Math.round(context.percent)}%)` : ''}`
    : '—'
  const meta: { key: string; node: React.ReactNode }[] = [
    {
      key: 'mode',
      node: (
        <span className={readOnly ? 'ro' : 'rw'} data-testid={`subagent-note-mode-${run.id}`} title={readOnly ? t('sa.readOnlyHint') : t('sa.writesHint')}>
          {readOnly ? t('sa.readOnly') : t('sa.writes')}
        </span>
      )
    },
    {
      key: 'model',
      node: (
        <span className="sg-model" data-testid={`subagent-note-model-${run.id}`} title={run.model ?? ''}>
          {modelDisplay?.label ?? '—'}
        </span>
      )
    },
    {
      key: 'thinking',
      node: <span data-testid={`subagent-note-thinking-${run.id}`}>{t('sa.thinking', { level: run.thinkingLevel ?? '—' })}</span>
    },
    {
      key: 'context',
      node: <span data-testid={`subagent-note-context-${run.id}`} title={t('sa.contextHint')}>{t('sa.context', { usage: contextText })}</span>
    },
    {
      key: 'elapsed',
      node: <span className="sg-time" data-testid={`subagent-note-time-${run.id}`}>{elapsed}</span>
    }
  ]
  const openRun = () => window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${run.id}` }))
  const retry = async () => {
    const result = await window.yan.subagents.start(run.task, run.model, run.isolation)
    if (result.ok) { void useStore.getState().loadSubagents(); window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${result.run?.id}` })) }
  }

  const dismiss = async () => {
    if (dismissInFlight.current) return
    dismissInFlight.current = true
    setDismissBusy(true)
    setDismissFailed(false)
    try {
      const result = await window.yan.subagents.dismiss(run.id)
      if (!result.ok) { setDismissFailed(true); return }
      await useStore.getState().loadSubagents()
    } catch {
      setDismissFailed(true)
    } finally {
      dismissInFlight.current = false
      setDismissBusy(false)
    }
  }

  return (
    <div className={`sg-card tone-${tone}${attention ? ' is-attn' : ''}${live ? ' is-live' : ''}${expanded ? ' is-open' : ''}`} data-testid={`subagent-note-${run.id}`} data-outcome={outcome.key}>
      <div className="sg-main">
        <span className="sg-mark" aria-hidden="true">
          {MARK[tone]}
        </span>
        <button
          type="button"
          className="sg-task"
          title={run.task}
          onClick={openRun}
          data-testid={`subagent-note-toggle-${run.id}`}
        >
          {run.task.split('\n')[0].slice(0, 64)}
        </button>
        <span className="sg-state" data-testid={`subagent-note-state-${run.id}`}>
          {t(`sa.state.${outcome.key}` as MessageKey)}
        </span>
        <Button size="sm" variant="ghost" className="ui-disclosure-trigger" active={expanded} aria-expanded={expanded} trailingIcon="chevron-right" data-testid={`subagent-note-details-${run.id}`} onClick={() => setExpanded(v => !v)}>{t(expanded ? 'sa.noteHide' : 'sa.noteDetails')}</Button>
        {run.status === 'error' ? <Button size="sm" onClick={() => void retry()} data-testid={`subagent-note-retry-${run.id}`}>{t('sa.retry')}</Button> : null}
        {canDismiss ? <Button size="sm" variant="ghost" disabled={dismissBusy} title={t('sa.dismissHint')} onClick={() => void dismiss()} data-testid={`subagent-note-dismiss-${run.id}`}>{t('sa.dismiss')}</Button> : null}
        {live ?<Button variant="danger" size="sm" onClick={() => void stopSubagent(run.id)} data-testid={`subagent-note-stop-${run.id}`}>{t('sa.stop')}</Button> : null}
      </div>
      {!isQuiet(outcome) || expanded ? (
        <div className="sg-meta">
          {meta.map((item) => (
            <span key={item.key} className="sg-meta-item">
              {item.node}
            </span>
          ))}
        </div>
      ) : null}
      {live && (run.progressWarning || run.latestActivity) ? (
        <div className={`sg-line sg-activity${run.progressWarning ? ' sg-reason' : ''}`} title={run.progressWarning || run.latestActivity} data-testid={`subagent-note-activity-${run.id}`}>
          {run.progressWarning || run.latestActivity}
        </div>
      ) : null}
      {!live && reason ? (
        <div className={`sg-line sg-reason${expanded ? '' : ' sg-activity'}`} title={reason} data-testid={`subagent-note-reason-${run.id}`}>
          {reason}
        </div>
      ) : null}
      {dismissFailed ? (
        <div className="sg-line sg-reason" role="alert" data-testid={`subagent-note-dismiss-failed-${run.id}`}>
          {t('sa.dismissFailed')}
        </div>
      ) : null}
      {reviewing ? (
        <div className="sg-actions">
          {run.diff?.patchPath ? (
            <Button size="sm" onClick={() => void window.yan.openPath(run.diff!.patchPath!)} data-testid={`subagent-note-diff-${run.id}`}>
              {t('sa.openDiff')}
            </Button>
          ) : null}
          <>
            <Button size="sm" onClick={() => void mergeSubagent(run.id)} data-testid={`subagent-note-merge-${run.id}`}>
              {t('sa.merge')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void (async () => { if (await confirm({ title: t('sa.discardChanges'), body: t('sa.discardConfirm'), detail: run.id, confirmLabel: t('sa.discard'), tone: 'danger' })) void discardSubagent(run.id) })()} data-testid={`subagent-note-discard-${run.id}`}>
              {t('sa.discard')}
            </Button>
          </>
        </div>
      ) : null}
      {expanded ? <><div className="sg-line">{run.task}</div><div className="sg-meta">{run.model} · {t('sa.toolUses', { count: calls })}{run.usage?.output ? ` · ${t('sa.outputTokens', { count: compactTokens(run.usage.output) })}` : ''}{changed ? ` · ${t('sa.diffStats', { files: changed.files, additions: changed.additions, deletions: changed.deletions })}` : ''}</div><SubagentDetail run={run} /></> : null}
    </div>
  )
}

function SubagentDetail({ run }: { run: SubagentRun }) {
  const t = useT()
  const calls = run.transcript.flatMap((m: UIMessage) => m.toolCalls ?? [])
  const shown = calls.slice(-DETAIL_LIMIT)
  const lastText = [...run.transcript].reverse().find((m) => m.role === 'assistant' && m.text.trim())?.text.trim()
  return (
    <div className="sg-detail" data-testid={`subagent-detail-${run.id}`}>
      {shown.length ? (
        <div className="sg-d-tools">
          {calls.length > shown.length ? <div className="sg-d-dim">{t('sa.stepsMore', { n: calls.length - shown.length })}</div> : null}
          {shown.map((c) => (
            <div className={`sg-d-tool ${c.status}`} key={c.id}>
              <span className="sg-d-tool-name">{c.name}</span>
              <span className="sg-d-tool-args">{toolArgSummary(c.args)}</span>
              <span className="sg-d-tool-status">{c.status === 'ok' ? '✓' : c.status === 'error' ? '✗' : '…'}</span>
            </div>
          ))}
        </div>
      ) : null}
      {lastText ? <div className="sg-d-text">{lastText}</div> : <div className="sg-d-dim">{t('sa.emptyTranscript')}</div>}
    </div>
  )
}

function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const first = Object.values(args as Record<string, unknown>).find((v) => typeof v === 'string') as string | undefined
  return first ? first.replace(/\s+/g, ' ').slice(0, 100) : ''
}
