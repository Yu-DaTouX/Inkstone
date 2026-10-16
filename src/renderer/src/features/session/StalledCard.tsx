/**
 * 停滞说明卡（v3 WP-23b，方案 02 §4.5）。
 *
 * 当前视图会话的运行进入 `stalled` 时，在对话底部出现一张卡：原因（等待模型 /
 * 工具无输出 / 自动重试 / 限流 / 重复输出）、已停滞时长或重试倒计时，以及一个
 * **停止**动作。停止复用正式 store 的 `abort()`（与输入框停止按钮同一入口），
 * 不新增授权、不自动续跑、不复制停止语义。
 *
 * 归属：只显示属于**当前激活视图**的运行。`abort()` 作用于运行实例当前投影的
 * 会话，若允许在只读打开的历史会话上点停止，会停到别的会话；所以 `viewActive`
 * 为假时宁可不出这张卡。
 */
import { useEffect, useState, type JSX } from 'react'
import type { RunSnapshot } from '../../../../shared/runs'
import { useI18n } from '../../i18n'
import { Button } from '../../ui'
import { Icon } from './Icon'
import { railText, stallReason } from './rail-text'
import { sameViewPath, type SessionViewIdentity } from './view-state'
import './rail.css'

/**
 * 纯函数：当前视图要显示的停滞运行。
 *
 *   · 未激活视图一律返回 null（停止动作会落到别的会话）；
 *   · 只认 `stalled` 阶段，同一会话有多条时取最新开始的那条；
 *   · 归属按会话 id，或按归一化后的路径（大小写 / 分隔符不敏感）匹配。
 */
export function currentStalledRun(
  runs: readonly RunSnapshot[],
  view: SessionViewIdentity,
  viewActive: boolean
): RunSnapshot | null {
  if (!viewActive) return null
  let found: RunSnapshot | null = null
  for (const run of runs) {
    if (run.phase.kind !== 'stalled') continue
    const matched =
      (!!view.sessionId && run.sessionId === view.sessionId) ||
      (!!view.sessionFile && !!run.sessionPath && sameViewPath(run.sessionPath, view.sessionFile))
    if (!matched) continue
    if (!found || run.startedAt > found.startedAt) found = run
  }
  return found
}

export interface StalledCardProps {
  /** 当前视图的停滞运行；由调用方完成归属判定。 */
  run: RunSnapshot | null
  /** 停止：调用正式 store 动作，不在这里复制停止语义。 */
  onStop: () => void
}

export function StalledCard({ run, onStop }: StalledCardProps): JSX.Element | null {
  const { lang } = useI18n()
  const text = railText(lang)
  const [now, setNow] = useState(() => Date.now())
  const stalled = !!run && run.phase.kind === 'stalled'

  /* 只有卡真的显示时才走秒；换运行 / 阶段离开停滞都会重建订阅。 */
  useEffect(() => {
    if (!stalled) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [stalled, run?.runId, run?.phase.kind])

  if (!run || run.phase.kind !== 'stalled') return null
  const reason = stallReason(lang, run.phase, now)
  if (!reason) return null

  return (
    <div className="v3-stall" data-testid="v3-stall" role="status" aria-live="polite">
      <div className="v3-stall-head">
        <Icon name="warn" size={16} />
        <span className="v3-stall-title">{text.stalledTitle}</span>
        <span className="v3-stall-word">{reason.word}</span>
        <span className="v3-stall-timing">{reason.timing}</span>
      </div>
      {reason.detail ? <p className="v3-stall-detail">{reason.detail}</p> : null}
      <p className="v3-stall-note">{text.autoNote}</p>
      <div className="v3-stall-foot">
        <Button variant="danger" size="sm" onPress={onStop}>
          {text.stop}
        </Button>
      </div>
    </div>
  )
}
