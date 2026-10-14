import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatDuration } from '../../../../shared/duration'
import { subagentOutcome } from '../../../../shared/subagent-outcome'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { selectSubagentRuns } from '../../state/subagent-view'
import { Button, Tip } from '../ui'
import { menuAnchor, type MenuAnchor } from '../workbench/Workspace'

/** 顶栏里的子代理入口：本会话有子代理在跑（或有需处理的）才出现；点开列出它们，可直接停止或进面板。 */
export function SubagentIndicator() {
  const t = useT()
  const session = useStore(s => s.session)
  const runs = useStore(s => s.subagents)
  const stop = useStore(s => s.stopSubagent)
  const sessionIds = [session?.sessionId, session?.conversationId].filter((v): v is string => !!v)
  const mine = selectSubagentRuns(runs, { sessionIds }).all.map(run => ({ run, outcome: subagentOutcome(run) }))
  const live = mine.filter(({ outcome }) => outcome.live)
  const attention = mine.filter(({ outcome }) => outcome.attention)
  const [at, setAt] = useState<MenuAnchor | null>(null)
  const popover = useRef<HTMLElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const visible = live.length > 0 || attention.length > 0
  useEffect(() => { if (!visible) setAt(null) }, [visible])
  useEffect(() => {
    if (!at || !live.length) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [at, live.length])
  useEffect(() => {
    if (!at) return
    const release = useStore.getState().acquireOverlayBlocker('subagent-indicator')
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }
    const outside = (e: PointerEvent) => { if (!(e.target as Element).closest('.sa-pop, .sa-indicator')) setAt(null) }
    window.addEventListener('keydown', escape); window.addEventListener('pointerdown', outside)
    return () => { release(); window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside) }
  }, [at])
  if (!visible) return null
  const list = [...live, ...attention].slice(0, 6)
  const openPanel = () => { window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'agents' })); setAt(null) }
  return <>
    <Tip label={t('sb.agentsTip')}>
      <button className={`tb-icon sa-indicator${at ? ' on' : ''}`} data-live={live.length ? '1' : '0'} data-testid="sb-agents" aria-haspopup="dialog" aria-expanded={!!at}
        aria-label={t('sb.agents', { n: live.length || attention.length })} onClick={e => setAt(old => old ? null : menuAnchor(e.currentTarget))}>
        <Icon name="agent" size={14} />
        <span className="sa-indicator-n">{live.length || attention.length}</span>
        {live.length && attention.length ? <span className="sa-indicator-flag" aria-hidden /> : null}
      </button>
    </Tip>
    {at ? createPortal(<section ref={popover} className="ui-detail-popover sa-pop" role="dialog" aria-label={t('sa.pop.title')} data-testid="status-details" style={{ top: at.top, right: at.right }}>
      <header className="sa-pop-head">
        <strong>{t('sa.pop.title')}</strong>
        <span className="sa-pop-sum">{[live.length ? t('sa.group.live', { n: live.length }) : '', attention.length ? t('sa.group.attention', { n: attention.length }) : ''].filter(Boolean).join(' · ')}</span>
      </header>
      <ul className="sa-pop-list">
        {list.map(({ run, outcome }, index) => <li key={run.id} className={`sa-pop-row tone-${outcome.tone}`} style={{ "--i": index } as React.CSSProperties}>
          <span className="sa-pop-dot" aria-hidden />
          <button type="button" className="sa-pop-task" title={run.task} onClick={() => { window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${run.id}` })); setAt(null) }}>
            <span className="sa-pop-name">{run.task.split('\n')[0].slice(0, 60)}</span>
            <span className="sa-pop-sub">{outcome.live ? run.latestActivity || t('sa.state.running') : run.error || t(`sa.state.${outcome.key}` as never)}</span>
          </button>
          <span className="sa-pop-time">{formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })}</span>
          {outcome.live ? <Button size="sm" variant="danger" onClick={() => void stop(run.id)}>{t('sa.stop')}</Button> : null}
        </li>)}
      </ul>
      <footer className="sa-pop-foot"><Button size="sm" variant="primary" onClick={openPanel}>{t('sa.pop.open')}</Button></footer>
    </section>, document.body) : null}
  </>
}
