import { useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { formatDuration } from '../../../../shared/duration'
import { isDismissed, subagentOutcome, type SubagentOutcome } from '../../../../shared/subagent-outcome'
import type { SubagentRun } from '../../../../shared/ipc'
import { useStore } from '../../state/store'
import { Button } from '../ui'
import { useConfirm } from '../ui/confirm'
import { resolveSubagentModelDisplay } from '../chat/turn-model-display'

const MARK: Record<SubagentOutcome['tone'], string> = { live: '', ok: '✓', warn: '!', err: '✕', mute: '■' }

type Zone = 'live' | 'attention' | 'done'
const ZONES: Zone[] = ['live', 'attention', 'done']
const ZONE_LABEL: Record<Zone, MessageKey> = { live: 'sa.plan.live', attention: 'sa.plan.attention', done: 'sa.plan.done' }

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * 子代理平面图：主 Agent 是中心节点，它派出的子代理按状态分成「运行中 / 需处理 / 已完成」三个区，
 * 每个子代理是一间「房间」（磁贴）。只显示当前会话的子代理；已完成的默认收起。
 */
export function SubagentPlan({ runs, mainModel, onOpen }: { runs: SubagentRun[]; mainModel?: string; onOpen(run: SubagentRun): void }) {
  const t = useT()
  const [showDone, setShowDone] = useState(false)
  const models = useStore(s => s.models)
  const favorites = useStore(s => s.settings?.modelFavorites)
  const ranked = runs.map(run => ({ run, outcome: subagentOutcome(run) })).sort((a, b) => b.run.startedAt - a.run.startedAt)
  const now = useNow(ranked.some(({ outcome }) => outcome.live))
  const zoneOf = (outcome: SubagentOutcome): Zone => outcome.live ? 'live' : outcome.attention ? 'attention' : 'done'
  const zones = ZONES.map(zone => ({ zone, items: ranked.filter(({ outcome }) => zoneOf(outcome) === zone) }))
  const live = zones[0].items.length
  return <div className="sa-plan" data-testid="subagent-plan">
    <div className="sa-core" data-live={live > 0 ? '1' : '0'}>
      <span className="sa-core-dot" aria-hidden />
      <span className="sa-core-name">{t('sa.plan.main')}</span>
      {mainModel ? <span className="sa-core-model" title={mainModel}>{resolveSubagentModelDisplay(mainModel, models, favorites ?? []).label}</span> : null}
      <span className="sa-core-count">{t('sa.plan.total', { n: ranked.length })}</span>
    </div>
    {ranked.length === 0 ? <p className="sa-empty ui-row-desc" data-testid="subagent-plan-empty">{t('sa.plan.empty')}</p> : null}
    {zones.map(({ zone, items }) => {
      if (!items.length) return null
      const folded = zone === 'done' && !showDone
      return <section key={zone} className="sa-zone" data-zone={zone} data-testid={`subagent-zone-${zone}`}>
        <header className="sa-zone-head">
          <span className="sa-zone-name">{t(ZONE_LABEL[zone])}</span>
          <span className="sa-zone-n">{items.length}</span>
          {zone === 'done' ? <Button size="sm" variant="ghost" className="ui-disclosure-trigger" active={showDone} aria-expanded={showDone} trailingIcon="chevron-right" data-testid="subagent-group-toggle" onClick={() => setShowDone(v => !v)}>{t(showDone ? 'sa.group.collapse' : 'sa.group.expand')}</Button> : null}
        </header>
        {folded ? null : <div className="sa-rooms">
          {items.map(({ run, outcome }, index) => <Room key={run.id} index={index} run={run} outcome={outcome} now={now} onOpen={() => onOpen(run)} />)}
        </div>}
      </section>
    })}
  </div>
}

function Room({ index, run, outcome, now, onOpen }: { index: number; run: SubagentRun; outcome: SubagentOutcome; now: number; onOpen(): void }) {
  const t = useT()
  const stop = useStore(s => s.stopSubagent), merge = useStore(s => s.mergeSubagent), discard = useStore(s => s.discardSubagent)
  const confirm = useConfirm()
  const models = useStore(s => s.models)
  const favorites = useStore(s => s.settings?.modelFavorites)
  const { live, tone } = outcome
  const [dismissBusy, setDismissBusy] = useState(false)
  const [dismissFailed, setDismissFailed] = useState(false)
  const dismissInFlight = useRef(false)
  const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
  const reviewing = !live && (run.review === 'pending' || run.review === 'conflict')
  const canDismiss = run.status === 'error' && !isDismissed(run) && !reviewing
  const percent = run.contextUsage?.percent
  const line = live ? run.progressWarning || run.latestActivity : run.status === 'error' ? run.error : ''
  const retry = async () => {
    const result = await window.yan.subagents.start(run.task, run.model, run.isolation)
    if (result.ok && result.run) { void useStore.getState().loadSubagents(); window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${result.run.id}` })) }
  }
  /* 不再处理：同一宿主持久标记；成功后重读快照，失败就地提示，仍留在需处理区。 */
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
  return <article className={`sa-room tone-${tone}${live ? ' is-live' : ''}`} style={{ "--i": index } as React.CSSProperties} data-testid={`sa-room-${run.id}`} data-outcome={outcome.key}>
    <button type="button" className="sa-room-open" title={run.task} onClick={onOpen} data-testid={`sa-room-open-${run.id}`}>
      <span className="sa-room-mark" aria-hidden>{MARK[tone]}</span>
      <span className="sa-room-task">{run.task.split('\n')[0].slice(0, 80)}</span>
    </button>
    <div className="sa-room-meta">
      <span className="sa-room-state">{t(`sa.state.${outcome.key}` as MessageKey)}</span>
      <span title={run.model ?? ''}>{run.model ? resolveSubagentModelDisplay(run.model, models, favorites ?? []).label : '—'}</span>
      <span>{run.isolation === 'controlled-cwd' ? t('sa.readOnly') : t('sa.writes')}</span>
      {percent != null ? <span title={t('sa.contextHint')}>{Math.round(percent)}%</span> : null}
      <span className="sa-room-time">{elapsed}</span>
    </div>
    {line ? <p className="sa-room-line" title={line}>{line}</p> : null}
    {dismissFailed ? <p className="sa-room-line" role="alert" data-testid={`sa-room-dismiss-failed-${run.id}`}>{t('sa.dismissFailed')}</p> : null}
    <div className="sa-room-actions">
      {live ? <Button size="sm" variant="danger" onClick={() => void stop(run.id)} data-testid={`sa-room-stop-${run.id}`}>{t('sa.stop')}</Button> : null}
      {run.status === 'error' ? <Button size="sm" onClick={() => void retry()} data-testid={`sa-room-retry-${run.id}`}>{t('sa.retry')}</Button> : null}
      {canDismiss ? <Button size="sm" variant="ghost" disabled={dismissBusy} title={t('sa.dismissHint')} onClick={() => void dismiss()} data-testid={`sa-room-dismiss-${run.id}`}>{t('sa.dismiss')}</Button> : null}
      {reviewing ? <>
        <Button size="sm" onClick={() => void merge(run.id)}>{t('sa.merge')}</Button>
        <Button size="sm" variant="danger" onClick={() => void (async () => { if (await confirm({ title: t('sa.discardChanges'), body: t('sa.discardConfirm'), detail: run.id, confirmLabel: t('sa.discard'), tone: 'danger' })) void discard(run.id) })()}>{t('sa.discard')}</Button>
      </> : null}
      <Button size="sm" variant="ghost" onClick={onOpen}>{t('sa.noteDetails')}</Button>
    </div>
  </article>
}
