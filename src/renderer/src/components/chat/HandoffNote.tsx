/**
 * 交接 / 上下文整理的**一行非阻塞状态**（实施-14 F5 / H5）。
 *
 * 为什么不是 toast：toast 会消失，而用户需要的是「这一刻还在整理，任务没停」
 * 与「整理没成、但进度还在」这种**持续可读**的状态（实施-14 §1.1）。
 * 也不是模态：用户要在整理期间继续看历史、继续打字。
 *
 * 判定逻辑全在 `shared/handoff-notice.ts`（纯函数、可单测）；这里只做三件事：
 *   ① 定时拉一次 `getHandoff()`（交接是**别的进程/别的时机**在推进的，
 *      前端没有对应的推送通道，轮询是最直接的观察方式）；
 *   ② 把 tone 渲染成一行文案 + 失败时的重试 / 停止；
 *   ③ 没有任何可报的事就**不占地方**（返回 null）。
 */

import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { handoffNoticeOf, handoffReasonText } from '../../../../shared/handoff-notice'

/** 前端观察交接状态的间隔：它只在回合收尾 / 生成 / 提交这些低频时刻变化。 */
const POLL_MS = 4_000

export function HandoffNote(): React.ReactElement | null {
  const t = useT()
  const handoff = useStore((s) => s.handoff)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const refreshHandoff = useStore((s) => s.refreshHandoff)
  const retryHandoff = useStore((s) => s.retryHandoff)
  const abort = useStore((s) => s.abort)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void refreshHandoff()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void refreshHandoff()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshHandoff, activeRunnerId])

  const notice = handoffNoticeOf(handoff, now)
  if (!notice) return null
  const reason = handoffReasonText(notice.reason)
  /*
   * 两个计数必须分开说（H5）：`segmentTally` 是**当前片段**又压了几次
   *（交接阈值看的就是它），`chainSegments` 是整条会话一共几段。
   * 拿其中一个冒充另一个，用户就会看到「压了 2 次却迟迟不交接」这种困惑。
   * 只在两个数都拿得到时显示 —— 宁可少一行，不编数字。
   */
  const tally = handoff?.segmentTally?.count
  const threshold = handoff?.threshold
  const segments = handoff?.chainSegments
  const showTally =
    typeof tally === 'number' && typeof threshold === 'number' && threshold > 0 && typeof segments === 'number'

  return (
    <div className={`handoff-note tone-${notice.tone}`} data-testid="handoff-note" data-tone={notice.tone}>
      <span className="handoff-note-text">{t(`handoff.${notice.tone}`)}</span>
      {reason ? (
        <span className="handoff-note-reason" title={notice.reason ?? undefined}>
          {reason}
        </span>
      ) : null}
      {showTally ? (
        <span
          className="handoff-note-tally"
          data-testid="handoff-tally"
          data-done={tally}
          data-threshold={threshold}
          data-segments={segments}
        >
          {t('handoff.tally', { done: tally, threshold, segments })}
        </span>
      ) : null}
      {notice.canRetry ? (
        <span className="handoff-note-actions">
          <button className="handoff-note-action" data-testid="handoff-retry" onClick={() => void retryHandoff()}>
            {t('handoff.retry')}
          </button>
          <button className="handoff-note-action" data-testid="handoff-stop" onClick={() => void abort()}>
            {t('handoff.stop')}
          </button>
        </span>
      ) : null}
    </div>
  )
}
