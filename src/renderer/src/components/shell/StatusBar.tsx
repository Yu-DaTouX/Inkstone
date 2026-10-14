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
import { QuotaSection } from '../toolbar/QuotaSection'
import type { ReactNode } from 'react'
import type { RemoteAccessStatus } from '../../../../shared/remote-protocol'

/**
 * 窗口底部的状态栏（设计规范 §4）。
 *
 * 左段是全局状态：模式状态词（运行中 / 等待批准 / 空闲）· 分支与改动 · 内核连接（不写 pi）· 手机配对；
 * 右段是与会话数字有关的一段：会话统计与用量（单会话时从输入框下方移到这里）· 额度 · 本会话花费。
 * 本轮速度、缓存与输入输出在点开任一段的详情里（缺报用量时标 ≥）；分屏时统计回到焦点磁贴的
 * 输入框下方，这里不重复。
 * 不重复别处已有的信息：模型与思考档位在输入框里，上下文占用在输入框右下的圆环。
 *
 * 状态都从已有的 store 快照推导，不自己计时（「同一时钟」原则）。
 * 窄窗时由容器查询从右往左隐藏低优先级段：先花费，再手机与内核连接。
 */
type Mode = 'run' | 'wait' | 'idle'

const MODES: Mode[] = ['run', 'wait', 'idle']

/** 手机配对状态：只在打开了手机接入时显示；不常变，聚焦窗口或每分钟刷新一次 */
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

/** 浮层里的键值列表：左列标签、右列数值（等宽右对齐），长值换行不撑宽 */
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
  /* 直读截断 → 累计 Token 只能是下限；views 先认 peekedSessionId，切会话才能立即关掉菜单 */
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekNote = useStore((s) => s.peekNote)
  const historyPartial = (peekNote?.truncated ?? 0) > 0
  /* 会话级用量与花费同源（session-metrics）；不再拿当前回合的值冒充本会话值 */
  const metrics = useMemo(
    () => projectSessionMetrics(messages, stats, { historyPartial }),
    [messages, stats, historyPartial]
  )
  const viewKey = peekedSessionId ?? session?.sessionId ?? session?.conversationId ?? null
  const waiting = useStore((s) => s.uiRequests.length > 0 || s.approvals.length > 0)
  const running = !!session?.isAgentRunning || !!session?.isStreaming
  const project = session?.cwd ?? settings?.cwd
  /* 运行结束时重新拉一次仓库状态：刚跑完的回合往往改了文件 */
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
  /* 其中按公开 API 价估算的部分（这些模型 pi 没有报价，订阅制或自写服务） */
  const costEstimated = metrics.costEstimated
  const [detail, setDetail] = useState<string | null>(null)
  /* 浮层贴着被点的那一段弹出：段落在窗口右半边就右对齐，免得点右侧用量却在左下角出现 */
  const [anchor, setAnchor] = useState<{ left?: number; right?: number }>({})
  /* 点开菜单后切会话：立即收起，免得停留在上一条会话的花费结论上 */
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
    /* The quota segment opens its own details popover. */
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
          [t('sb.kSessionCost'), cost == null ? '—' : `${costEstimated > 0 ? '≈' : ''}${cost.toFixed(3)}`],
          ...(costEstimated > 0 ? [[t('sb.kCostEstimated'), `${costEstimated.toFixed(3)}`] as [string, ReactNode]] : [])
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

      {/* 会话统计与用量：单会话时在这里（分屏时回到焦点磁贴的输入框下方，组件自己判断）；
          点开是它自己的浮层，所以这一段不参与状态栏的详情浮层。 */}
      <ComposerUsage placement="statusbar" />

      {/* 额度常驻状态栏（账号明细在右栏「账号额度」）；速度、缓存与输入输出明细在花费的详情里 */}
      <QuotaSection variant="status" />

      <span className="sb-seg sb-cost" tabIndex={0} role="button" aria-haspopup="dialog" aria-expanded={detail === 'sb-cost'} title={costEstimated > 0 ? t('sb.costEstimatedTip') : t('sb.costTip')} data-testid="sb-cost">
        {cost == null ? '—' : t('sb.cost', { cost: (costEstimated > 0 ? '≈' : '') + cost.toFixed(3) })}
      </span>
    </footer>
  )
}
