import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { handoffNoticeOf, handoffReasonText } from '../../../../shared/handoff-notice'

const POLL_MS = 4_000

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
  const tx = handoff?.transaction
  const receipts = tx?.receipts
  const [detailOpen, setDetailOpen] = useState(false)
  const lastStep = tx?.steps?.length ? tx.steps[tx.steps.length - 1] : null
  const awaitingDelivery = typeof receipts?.sentAt === 'number' && typeof receipts?.persistedAt !== 'number'
  const deliveredUnconfirmed =
    typeof receipts?.persistedAt === 'number' && typeof receipts?.startedAt !== 'number'
  const uncertain =
    tx?.stage === 'resumed' &&
    typeof receipts?.persistedAt === 'number' &&
    typeof receipts.startedAt !== 'number' &&
    now - receipts.persistedAt > 30_000
  if (!notice && !uncertain && !awaitingDelivery) return null
  const tone =
    awaitingDelivery && !notice
      ? 'warn'
      : uncertain && !notice
        ? 'warn'
        : (notice?.tone ?? 'warn')
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
