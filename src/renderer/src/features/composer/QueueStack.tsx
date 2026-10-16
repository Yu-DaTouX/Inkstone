import { History, CornerUpRight, Send, Undo2, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

export function QueueStack() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const pendingSends = useStore((s) => s.pendingSends)
  const releaseSend = useStore((s) => s.releaseSend)
  const restoreSend = useStore((s) => s.restoreSend)
  const steerQueued = useStore((s) => s.steerQueued)
  const removeQueued = useStore((s) => s.removeQueued)
  const roundRunning = useStore((s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running)

  const { steering, followUp } = queue
  if (steering.length + followUp.length + pendingSends.length === 0) return null

  return (
    <div className="composer-queue" data-testid="queue-stack">
      {pendingSends.map((item) => (
        <div className="cq-row cq-pending" key={item.id} title={item.text} data-testid="queue-pending">
          <Send className="cq-icon" size={12} aria-hidden />
          <span className="cq-text">{item.text}</span>
          {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
          <span className="cq-tag">{t('queue.hold')}</span>
          {roundRunning ? (
            <>
              <button type="button" className="cq-btn cq-primary" data-testid="pending-steer" title={t('queue.steerNowTip')} onClick={() => void releaseSend(item.id, 'steer')}>
                {t('queue.steerNow')}
              </button>
              <button type="button" className="cq-btn" data-testid="pending-follow" title={t('queue.queueItTip')} onClick={() => void releaseSend(item.id, 'followUp')}>
                {t('queue.queueIt')}
              </button>
            </>
          ) : (
            <button type="button" className="cq-btn cq-primary" data-testid="pending-send" title={t('queue.sendNowTip')} onClick={() => void releaseSend(item.id, 'followUp')}>
              {t('queue.sendNow')}
            </button>
          )}
          <button type="button" className="cq-icon-btn" data-testid="pending-restore" title={t('queue.restoreTip')} aria-label={t('queue.restore')} onClick={() => restoreSend(item.id)}>
            <Undo2 size={12} aria-hidden />
          </button>
        </div>
      ))}

      {steering.map((item) => (
        <div className="cq-row cq-steering" key={item.id} title={item.text} data-testid="queue-row">
          <CornerUpRight className="cq-icon" size={12} aria-hidden />
          <span className="cq-text">{item.text}</span>
          {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
          <span className="cq-tag cq-tag-run">{t('queue.inserting')}</span>
          <button type="button" className="cq-icon-btn" data-testid="queue-retract" title={t('queue.retractTip')} aria-label={t('queue.retract')} onClick={() => void removeQueued(item.id)}>
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}

      {followUp.map((item) => (
        <div className="cq-row" key={item.id} title={item.text} data-testid="queue-row">
          <History className="cq-icon" size={12} aria-hidden />
          <span className="cq-text">{item.text}</span>
          {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
          <button type="button" className="cq-btn" data-testid="queue-steer" title={t('queue.steerTip')} onClick={() => void steerQueued(item.id)}>
            {t('queue.steer')}
          </button>
          <button type="button" className="cq-icon-btn" data-testid="queue-retract" title={t('queue.retractTip')} aria-label={t('queue.retract')} onClick={() => void removeQueued(item.id)}>
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
