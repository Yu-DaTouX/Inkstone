import { ChoiceSelect } from '../ui/ChoiceSelect'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PERMISSION_MODES, normalizePermissionMode } from '../../../../shared/approval'

export function QueueStack() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const steerQueued = useStore((s) => s.steerQueued)
  const removeQueued = useStore((s) => s.removeQueued)
  const pendingSends = useStore((s) => s.pendingSends)
  const releaseSend = useStore((s) => s.releaseSend)
  const restoreSend = useStore((s) => s.restoreSend)
  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running
  )
  const steering = queue.steering
  const followUp = queue.followUp
  if (steering.length + followUp.length + pendingSends.length === 0) return null

  return (
    <div className="queue-stack" data-testid="queue-stack">
      {pendingSends.map((item) => (
        <div className="qrow pending" key={item.id} title={item.text} data-testid="queue-pending">
          <Icon name="send" size={12} />
          <span className="qrow-text">{item.text}</span>
          {!!item.images?.length && <span className="qrow-tag">{t('queue.images', { n: item.images.length })}</span>}
          <span className="qrow-tag">{t('queue.hold')}</span>
          {roundRunning ? (
            <>
              <button
                className="qrow-jump primary"
                data-testid="pending-steer"
                title={t('queue.steerNowTip')}
                onClick={() => void releaseSend(item.id, 'steer')}
              >
                {t('queue.steerNow')}
              </button>
              <button
                className="qrow-jump"
                data-testid="pending-follow"
                title={t('queue.queueItTip')}
                onClick={() => void releaseSend(item.id, 'followUp')}
              >
                {t('queue.queueIt')}
              </button>
            </>
          ) : (
            <button
              className="qrow-jump primary"
              data-testid="pending-send"
              title={t('queue.sendNowTip')}
              onClick={() => void releaseSend(item.id, 'followUp')}
            >
              {t('queue.sendNow')}
            </button>
          )}
          <button
            className="qrow-jump"
            data-testid="pending-restore"
            title={t('queue.restoreTip')}
            onClick={() => restoreSend(item.id)}
          >
            {t('queue.restore')}
          </button>
        </div>
      ))}
      {steering.map((item) => (
        <div className="qrow steering" key={item.id} title={item.text} data-testid="queue-row">
          <Icon name="queue" size={12} />
          <span className="qrow-text">{item.text}</span>
          {!!item.images?.length && <span className="qrow-tag">{t('queue.images', { n: item.images.length })}</span>}
          <span className="qrow-tag">{t('queue.inserting')}</span>
          <button
            className="qrow-jump"
            data-testid="queue-retract"
            title={t('queue.retractTip')}
            onClick={() => void removeQueued(item.id)}
          >
            {t('queue.retract')}
          </button>
        </div>
      ))}
      {followUp.map((item) => (
        <div className="qrow" key={item.id} title={item.text} data-testid="queue-row">
          <Icon name="history" size={12} />
          <span className="qrow-text">{item.text}</span>
          {!!item.images?.length && <span className="qrow-tag">{t('queue.images', { n: item.images.length })}</span>}
          <button
            className="qrow-jump"
            data-testid="queue-steer"
            title={t('queue.steerTip')}
            onClick={() => void steerQueued(item.id)}
          >
            {t('queue.steer')}
          </button>
          <button
            className="qrow-jump"
            data-testid="queue-retract"
            title={t('queue.retractTip')}
            onClick={() => void removeQueued(item.id)}
          >
            {t('queue.retract')}
          </button>
        </div>
      ))}
    </div>
  )
}

export function PermissionPicker() {
  const t = useT()
  const permission = normalizePermissionMode(useStore(s => s.settings?.permissionMode))
  const patchSettings = useStore(s => s.patchSettings)
  return <ChoiceSelect className="composer-permission" testId="permission-picker" label={t('permission.global')} menuWidth={340} align="left" icon="shield-check"
    value={permission} onChange={value => {
      void patchSettings({ permissionMode: normalizePermissionMode(value) })
        .catch(error => useStore.getState().notify('error', String(error)))
    }} options={PERMISSION_MODES.map(level => ({ value: level, label: t(`permission.label.${level}`), description: t(`permission.desc.${level}`) }))} />
}
