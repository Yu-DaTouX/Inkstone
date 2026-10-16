import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui'
import { formatHitRate } from '../../../../shared/turns'
import { projectSessionMetrics } from '../../../../shared/session-metrics'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { useRepoState } from '../review/useGitReview'
import { ComposerUsage } from '../chat/ComposerUsage'
import { useMoney } from '../chat/UsageOverview'
import { QuotaSection } from '../toolbar/QuotaSection'
import type { ReactNode } from 'react'
import type { RemoteAccessStatus } from '../../../../shared/remote-protocol'

type Mode = 'run' | 'wait' | 'idle'

const MODES: Mode[] = ['run', 'wait', 'idle']

function useRemoteStatus(): RemoteAccessStatus | null {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.yan.remote
        .status()
        .then((next) => {
          if (alive) setStatus(next)
        })
        .catch(() => undefined)
    }
    load()
    const id = window.setInterval(load, 60_000)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.clearInterval(id)
      window.removeEventListener('focus', load)
    }
  }, [])
  return status
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="sb-kv">{rows.map(([k, v], i) => <div key={i} className="sb-kv-row"><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>
}

const num = (n: number | null | undefined, partial: boolean): string => n == null ? '—' : `${partial ? '≥' : ''}${n.toLocaleString()} tok`

export function StatusBar() {
  const t = useT()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const conn = useStore((s) => s.conn)
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekNote = useStore((s) => s.peekNote)
  const historyPartial = (peekNote?.truncated ?? 0) > 0
  const metrics = useMemo(
    () => projectSessionMetrics(messages, stats, { historyPartial }),
    [messages, stats, historyPartial]
  )
  const viewKey = peekedSessionId ?? session?.sessionId ?? session?.conversationId ?? null
  const waiting = useStore((s) => s.uiRequests.length > 0 || s.approvals.length > 0)
  const running = !!session?.isAgentRunning || !!session?.isStreaming
  const project = session?.cwd ?? settings?.cwd
  const { repo } = useRepoState(project, [running])
  const remote = useRemoteStatus()

  const mode: Mode = waiting ? 'wait' : running ? 'run' : 'idle'
  const modeLabel = { run: t('sb.mode.run'), wait: t('sb.mode.wait'), idle: t('sb.mode.idle') } as const
  const modeTip = { run: t('sb.runTip'), wait: t('sb.waitTip'), idle: t('sb.idleTip') }[mode]

  const branch = repo ? (repo.detached ? t('env.detached') : repo.unborn ? t('env.noCommit') : repo.branch ?? t('env.detached')) : null
  const changed = repo?.changedCount ?? 0
  const connText = conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')
  const devices = remote?.enabled ? remote.devices.length : null
  const cost = metrics.cost
  const costEstimated = metrics.costEstimated
  const money = useMoney()
  const [detail, setDetail] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ left?: number; right?: number }>({})
  const boundView = useRef(viewKey)
  useEffect(() => {
    if (boundView.current === viewKey) return
    boundView.current = viewKey
    setDetail(null)
  }, [viewKey])
  useEffect(() => {
    if (!detail) return
    const release = useStore.getState().acquireOverlayBlocker('status-details')
    const close = (e: KeyboardEvent): void => { if (e.key === 'Escape') setDetail(null) }
    const outside = (e: PointerEvent): void => {
      if (!(e.target as Element).closest('.sb-details, .statusbar')) setDetail(null)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', outside)
    return () => { release(); window.removeEventListener('keydown', close); window.removeEventListener('pointerdown', outside) }
  }, [detail])
  const titleOf = (key: string): string => ({ mode: t('sb.dMode'), 'sb-branch': t('sb.dBranch'), 'sb-pi': t('sb.dPi'), 'sb-phone': t('sb.dPhone') } as Record<string, string>)[key] ?? t('sb.dUsage')
  const toggleDetail = (target: Element): void => {
    const item = target.closest('.sb-mode, .sb-seg, .usagebar')
    if (!item || item.classList.contains('sb-quota')) return
    const key = item.getAttribute('data-testid') ?? (item.classList.contains('sb-mode') ? 'mode' : 'usagebar')
    const r = item.getBoundingClientRect()
    const vw = window.innerWidth
    setAnchor(r.left + r.width / 2 > vw / 2 ? { right: Math.max(8, vw - r.right) } : { left: Math.max(8, r.left) })
    setDetail((old) => old === key ? null : key)
  }

  return (
    <footer className="statusbar" data-testid="statusbar" aria-label={t('sb.label')} onClick={(e) => { if ((e.target as Element).closest('.statusbar')) toggleDetail(e.target as Element) }} onKeyDown={(e) => { if ((e.target as Element).closest('.statusbar') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleDetail(e.target as Element) } }}>
      {detail ? createPortal(<section className="ui-detail-popover sb-details" role="dialog" aria-label={titleOf(detail)} data-testid="status-details" style={anchor}>
        <div className="sb-details-head"><strong>{titleOf(detail)}</strong><Button size="sm" onClick={() => setDetail(null)}>{t('q.close')}</Button></div>
        {detail === 'mode' ? <p className="sb-details-note">{modeTip}</p> : null}
        {detail === 'sb-branch' ? <><KV rows={[[t('sb.kBranch'), branch], [t('sb.kChanged'), `${changed} ${t('sb.changedFiles')}`], [t('sb.kPath'), <span className="sb-details-path" title={project}>{project}</span>]]} /></> : null}
        {detail === 'sb-pi' ? <><KV rows={[[t('sb.kState'), connText]]} /><p className="sb-details-note">{t('sb.engineDetail')}</p><div className="sb-details-actions"><Button size="sm" onClick={() => { useStore.getState().openSettings('status'); setDetail(null) }}>{t('sb.diagnostics')}</Button></div></> : null}
        {detail === 'sb-phone' ? <><KV rows={[[t('sb.kDevices'), String(devices ?? 0)], ...(remote?.devices.map((d): [string, ReactNode] => ['', d.name]) ?? [])]} /><div className="sb-details-actions"><Button size="sm" onClick={() => { useStore.getState().openSettings('remote'); setDetail(null) }}>{t('sb.deviceSettings')}</Button></div></> : null}
        {detail === 'usagebar' || detail === 'sb-cost' ? <><KV rows={[
          [t('tok.in'), num(metrics.input, metrics.partial)],
          [t('tok.out'), num(metrics.output, metrics.partial)],
          [t('sb.kCacheRead'), num(metrics.cacheRead, metrics.partial)],
          [t('sb.kCacheWrite'), num(metrics.cacheWrite, metrics.partial)],
          [t('sb.kHitRate'), formatHitRate(metrics.hitRate) ?? '—'],
          [t('sb.kSessionCost'), cost == null ? '—' : `${costEstimated > 0 ? '≈' : ''}${money(cost)}`],
          ...(costEstimated > 0 ? [[t('sb.kCostEstimated'), money(costEstimated)] as [string, ReactNode]] : [])
        ]} /><p className="sb-details-note">{metrics.partial ? t('sm.partialTip') : costEstimated > 0 ? t('sb.costEstimatedTip') : t('sb.costTip')}</p>{metrics.costZero ? <p className="sb-details-note">{t('sb.costZeroTip')}</p> : null}</> : null}
      </section>, document.body) : null}
      <span className="sb-mode" data-mode={mode} title={modeTip} tabIndex={0} role="status" aria-live="polite">
        <span className="sb-mode-dot" aria-hidden />
        {MODES.map((m) => (
          <span key={m} className={`sb-mode-label ${m === mode ? 'on' : ''}`} aria-hidden={m !== mode}>
            {modeLabel[m]}
          </span>
        ))}
      </span>

      {branch !== null ? (
        <span className="sb-seg sb-branch" tabIndex={0} role="button" aria-haspopup="dialog" aria-expanded={detail === 'sb-branch'} title={t('sb.branchTip', { branch, n: changed })} data-testid="sb-branch">
          <Icon name="branch" size={12} />
          <span className="sb-text">{branch}</span>
          {changed > 0 ? <span className="sb-changed">~{changed}</span> : null}
        </span>
      ) : null}

      <span className="sb-seg sb-pi" tabIndex={0} role="button" aria-haspopup="dialog" aria-expanded={detail === 'sb-pi'} title={t('sb.piTip')} data-state={conn} data-testid="sb-pi">
        <span className="sb-dot" aria-hidden />
        <span className="sb-text">{connText}</span>
      </span>

      {devices !== null ? (
        <span className="sb-seg sb-phone" tabIndex={0} role="button" aria-haspopup="dialog" aria-expanded={detail === 'sb-phone'} title={t('sb.phoneTip')} data-testid="sb-phone">
          <Icon name="phone" size={12} />
          <span className="sb-text">{t('sb.phone', { n: devices })}</span>
        </span>
      ) : null}

      <span className="sb-grow" />

      <ComposerUsage placement="statusbar" />

      <QuotaSection variant="status" />

      <span className="sb-seg sb-cost" tabIndex={0} role="button" aria-haspopup="dialog" aria-expanded={detail === 'sb-cost'} title={costEstimated > 0 ? t('sb.costEstimatedTip') : t('sb.costTip')} data-testid="sb-cost">
        {cost == null ? '—' : t('sb.cost', { cost: (costEstimated > 0 ? '≈' : '') + money(cost) })}
      </span>
    </footer>
  )
}
