import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { useRepoState } from '../review/useGitReview'
import { UsageBar } from '../chat/UsageBar'
import type { RemoteAccessStatus } from '../../../../shared/remote-protocol'

/**
 * 窗口底部的状态栏（设计规范 §4）。
 *
 * 左段是全局状态：模式色块（RUN / WAIT / IDLE）· 分支与改动 · pi 连接 · 手机配对；
 * 右段是本轮用量（沿用 UsageBar 的口径：流式期间不编造速度，缺报用量时标 ≥）与本会话花费。
 * 不重复别处已有的信息：模型与思考档位在输入框里，上下文占用在右栏检查器。
 *
 * 状态都从已有的 store 快照推导，不自己计时（「同一时钟」原则）。
 * 窄窗时由容器查询从右往左隐藏低优先级段：先花费，再手机与 pi。
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

export function StatusBar() {
  const t = useT()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const conn = useStore((s) => s.conn)
  const stats = useStore((s) => s.stats)
  const waiting = useStore((s) => s.uiRequests.length > 0)
  const running = !!session?.isAgentRunning || !!session?.isStreaming
  const project = session?.cwd ?? settings?.cwd
  /* 运行结束时重新拉一次仓库状态：刚跑完的回合往往改了文件 */
  const { repo } = useRepoState(project, [running])
  const remote = useRemoteStatus()

  const mode: Mode = waiting ? 'wait' : running ? 'run' : 'idle'
  const modeLabel = { run: 'RUN', wait: 'WAIT', idle: 'IDLE' } as const
  const modeTip = { run: t('sb.runTip'), wait: t('sb.waitTip'), idle: t('sb.idleTip') }[mode]

  const branch = repo ? (repo.detached ? t('env.detached') : repo.unborn ? t('env.noCommit') : repo.branch ?? t('env.detached')) : null
  const changed = repo?.changedCount ?? 0
  const connText = conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')
  const devices = remote?.enabled ? remote.devices.length : null
  const cost = stats?.cost ?? 0

  return (
    <footer className="statusbar" data-testid="statusbar" aria-label={t('sb.label')}>
      <span className="sb-mode" data-mode={mode} title={modeTip} tabIndex={0} role="status" aria-live="polite">
        {MODES.map((m) => (
          <span key={m} className={`sb-mode-label ${m === mode ? 'on' : ''}`} aria-hidden={m !== mode}>
            {modeLabel[m]}
          </span>
        ))}
      </span>

      {branch !== null ? (
        <span className="sb-seg sb-branch" tabIndex={0} title={t('sb.branchTip', { branch, n: changed })} data-testid="sb-branch">
          <Icon name="branch" size={12} />
          <span className="sb-text">{branch}</span>
          {changed > 0 ? <span className="sb-changed">~{changed}</span> : null}
        </span>
      ) : null}

      <span className="sb-seg sb-pi" tabIndex={0} title={t('sb.piTip')} data-state={conn} data-testid="sb-pi">
        <span className="sb-dot" aria-hidden />
        <span className="sb-text">pi · {connText}</span>
      </span>

      {devices !== null ? (
        <span className="sb-seg sb-phone" tabIndex={0} title={t('sb.phoneTip')} data-testid="sb-phone">
          <Icon name="phone" size={12} />
          <span className="sb-text">{t('sb.phone', { n: devices })}</span>
        </span>
      ) : null}

      <span className="sb-grow" />

      <UsageBar />

      <span className="sb-seg sb-cost" tabIndex={0} title={t('sb.costTip')} data-testid="sb-cost">
        {t('sb.cost', { cost: cost.toFixed(3) })}
      </span>
    </footer>
  )
}
