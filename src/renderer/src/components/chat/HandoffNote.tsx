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
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { handoffNoticeOf, handoffReasonText } from '../../../../shared/handoff-notice'

/** 前端观察交接状态的间隔：它只在回合收尾 / 生成 / 提交这些低频时刻变化。 */
const POLL_MS = 4_000

/** 事务阶段的中文说明（恢复视图里的「最后确认步骤」用） */
const STAGE_LABEL: Record<string, MessageKey> = {
  pending: 'handoff.stagePending',
  snapshot: 'handoff.stageSnapshot',
  validated: 'handoff.stageValidated',
  'destination-created': 'handoff.stageDestination',
  committed: 'handoff.stageCommitted',
  resumed: 'handoff.stageResumed',
  failed: 'handoff.stageFailed'
}

export function HandoffNote(): React.ReactElement | null {
  const t = useT()
  const handoff = useStore((s) => s.handoff)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const refreshHandoff = useStore((s) => s.refreshHandoff)
  const retryHandoff = useStore((s) => s.retryHandoff)
  const abort = useStore((s) => s.abort)
  const confirmHandoff = useStore((s) => s.confirmHandoff)
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
  /*
   * 「已投递但尚未确认运行」（实施-15 A-3 / R6）：
   * `stage==='resumed'` 只说明标记写进了目的会话（那是本地拼的文本），
   * 不等于模型真的开始跑了。等 30s 还没有助手输出就把这个不确定状态说出来，
   * 而不是让用户以为“已经在继续了”。
   */
  const tx = handoff?.transaction
  const receipts = tx?.receipts
  const [detailOpen, setDetailOpen] = useState(false)
  const lastStep = tx?.steps?.length ? tx.steps[tx.steps.length - 1] : null
  /*
   * 已发出但还没在目的会话看到标记 —— 「待核实」，不会自动重发（resumeAttempts 到 2 就停）。
   * 这也是一种需要**主动告诉用户**的状态：没有它，用户只能看到一个没头没尾的旧状态。
   */
  const awaitingDelivery = typeof receipts?.sentAt === 'number' && typeof receipts?.persistedAt !== 'number'
  /* 已投递但看不到模型输出 —— 「不确定它到底跑没跑」 */
  const deliveredUnconfirmed =
    typeof receipts?.persistedAt === 'number' && typeof receipts?.startedAt !== 'number'
  const uncertain =
    tx?.stage === 'resumed' &&
    typeof receipts?.persistedAt === 'number' &&
    typeof receipts.startedAt !== 'number' &&
    now - receipts.persistedAt > 30_000
  if (!notice && !uncertain && !awaitingDelivery) return null
  /** 回执行、待核实与 notice 三选一显示，都走同一个壳 */
  const tone =
    awaitingDelivery && !notice
      ? 'warn'
      : uncertain && !notice
        ? 'warn'
        : (notice?.tone ?? 'warn')
  /* 模板字符串推不出 MessageKey，显式映射一次 */
  const toneKey: MessageKey =
    awaitingDelivery && !notice
      ? 'handoff.awaitingShort'
      : uncertain && !notice
        ? 'handoff.receiptDelivered'
        : tone === 'done'
          ? 'handoff.done'
          : tone === 'failed'
            ? 'handoff.failed'
            : tone === 'warn'
              ? 'handoff.receiptDelivered'
              : 'handoff.working'
  const reason = handoffReasonText(notice?.reason ?? null)
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
    <div
      className={`handoff-note tone-${tone}`}
      data-testid="handoff-note"
      data-tone={tone}
      data-receipt={uncertain ? 'delivered-unconfirmed' : (receipts?.startedAt ? 'started' : 'none')}
    >
      <span className="handoff-note-text">
        {t(toneKey)}
      </span>
      {reason ? (
        <span className="handoff-note-reason" title={notice?.reason ?? undefined}>
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
      {notice?.canRetry || tx ? (
        <span className="handoff-note-actions">
          {notice?.canRetry ? (
            <button className="handoff-note-action" data-testid="handoff-retry" onClick={() => void retryHandoff()}>
              {t('handoff.retry')}
            </button>
          ) : null}
          {/* 已发出、但磁盘上看不到证据：给一个「我看过了，它确实在跑」的出口（A-3） */}
          {awaitingDelivery ? (
            <button
              className="handoff-note-action"
              data-testid="handoff-confirm"
              onClick={() => tx && void confirmHandoff(tx.handoffId)}
            >
              {t('handoff.confirm')}
            </button>
          ) : null}
          {tx ? (
            <button
              className="handoff-note-action"
              data-testid="handoff-detail-toggle"
              aria-expanded={detailOpen}
              onClick={() => setDetailOpen((v) => !v)}
            >
              {t('handoff.detail')}
            </button>
          ) : null}
          <button className="handoff-note-action" data-testid="handoff-stop" onClick={() => void abort()}>
            {t('handoff.stop')}
          </button>
        </span>
      ) : null}
      {detailOpen && tx ? (
        <div className="handoff-detail" data-testid="handoff-detail">
          {/* 最后**确认**到哪一步：只看 stage 区分不出「已提交未发」与「已发无证据」 */}
          <div className="handoff-detail-row" data-testid="handoff-last-step">
            {t('handoff.lastStep', {
              stage: t(STAGE_LABEL[tx.stage]),
              time: lastStep ? new Date(lastStep.at).toLocaleTimeString() : '—'
            })}
          </div>
          {awaitingDelivery ? (
            <div className="handoff-detail-row tone-await" data-testid="handoff-awaiting">
              {t('handoff.awaitingDelivery', { n: tx.resumeAttempts })}
            </div>
          ) : null}
          {deliveredUnconfirmed ? (
            <div className="handoff-detail-row tone-await" data-testid="handoff-unconfirmed">
              {t('handoff.unconfirmedRun')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
