import { useState } from 'react'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { Section } from './ToolSection'
import { Button, Switch } from '../ui'
import { useStore } from '../../state/store'
import { type QueueMode } from '../../../../shared/ipc'

export function LogCount() {
  const n = useStore((s) => s.logs.length)
  return (
    <span className="rp-count" data-testid="log-count">
      {n}
    </span>
  )
}

export function QueueSection() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const session = useStore((s) => s.session)
  const setSteeringMode = useStore((s) => s.setSteeringMode)
  const setFollowUpMode = useStore((s) => s.setFollowUpMode)
  const [modesOpen, setModesOpen] = useState(false)

  const steering = session?.steeringMode ?? 'one-at-a-time'
  const followUp = session?.followUpMode ?? 'one-at-a-time'
  const pending = queue.steering.length + queue.followUp.length
  const showModes = pending > 0 || modesOpen

  return (
    <Section titleKey="rp.queue" testId="rp-queue" extra={pending > 0 ? <span className="rp-count">{pending}</span> : null}>
      {pending > 0 ? (
        <div className="rp-queued">
          {[...queue.steering, ...queue.followUp].map((q) => (
            <div key={q.id} className="rp-queued-row" title={q.text}>
              <span className="rp-queued-dot" />
              <span className="rp-text">{q.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rp-kv">
          <span className="rp-dim">{t('rp.noQueue')}</span>
          <span className="spacer" />
          <button className="rp-link" onClick={() => setModesOpen((v) => !v)} aria-expanded={modesOpen} data-testid="queue-modes-toggle">
            {t('rp.queueModes')}
          </button>
        </div>
      )}

      {showModes ? (
        <>
          <ModeRow
            labelKey="rp.steering"
            value={steering}
            onChange={(m) => void setSteeringMode(m)}
            testId="steering-mode"
          />
          <ModeRow
            labelKey="rp.followUp"
            value={followUp}
            onChange={(m) => void setFollowUpMode(m)}
            testId="followup-mode"
          />
        </>
      ) : null}
    </Section>
  )
}

function ModeRow({
  labelKey,
  value,
  onChange,
  testId
}: {
  labelKey: MessageKey
  value: QueueMode
  onChange: (m: QueueMode) => void
  testId: string
}) {
  const t = useT()
  const label = (m: QueueMode): string =>
    m === 'all' ? t('rp.modeAll') : t('rp.modeOne')

  return (
    <div className="rp-kv rp-mode">
      <span className="rp-k">{t(labelKey)}</span>
      <span className="spacer" />
      <button
        className="rp-switch"
        data-testid={testId}
        data-value={value}
        title={t('rp.queueTip')}
        onClick={() => onChange(value === 'all' ? 'one-at-a-time' : 'all')}
      >
        <span className={value === 'one-at-a-time' ? 'on' : ''}>{t('rp.modeOne')}</span>
        <span className={value === 'all' ? 'on' : ''}>{t('rp.modeAll')}</span>
        <span className="rp-switch-tip">{label(value)}</span>
      </button>
    </div>
  )
}

export function ExtSection() {
  const t = useT()
  const statuses = useStore((s) => s.statuses)

  const statusEntries = Object.entries(statuses)
  if (statusEntries.length === 0) return null

  return (
    <Section titleKey="rp.ext" testId="rp-ext">
      {statusEntries.map(([k, v]) => (
        <div key={k} className="rp-kv">
          <span className="rp-k">{k}</span>
          <span className="spacer" />
          <span className="rp-v">{v}</span>
        </div>
      ))}
      <div className="rp-dim">{t('rp.extHint')}</div>
    </Section>
  )
}

export function LogSection() {
  const t = useT()
  const logs = useStore((s) => s.logs)

  if (logs.length === 0) return null

  return (
    <Section
      titleKey="rp.log"
      testId="rp-log"
      defaultOpen={false}
      extra={
        <span className="rp-count" data-testid="log-count">
          {logs.length}
        </span>
      }
    >
      <pre className="rp-log" data-testid="log-body">
        {logs.slice(-200).join('\n')}
      </pre>
      <div className="rp-dim">{t('rp.logHint')}</div>
    </Section>
  )
}

export function ActionsSection() {
  const t = useT()
  const copyLastReply = useStore((s) => s.copyLastReply)
  const abortRetry = useStore((s) => s.abortRetry)
  const autoRetry = useStore((s) => s.autoRetryEnabled)
  const setAutoRetry = useStore((s) => s.setAutoRetry)
  const exportHtml = useStore((s) => s.exportHtml)
  const clone = useStore((s) => s.clone)
  const session = useStore((s) => s.session)
  const streaming = !!session?.isStreaming

  return (
    <Section titleKey="rp.actions" testId="rp-actions" defaultOpen={false}>
      <div className="rp-acts">
        <Act onClick={() => void copyLastReply()} labelKey="rp.actCopy" testId="act-copy" />
        <Act onClick={() => void abortRetry()} labelKey="rp.actRetry" testId="act-abort-retry" />
        <Act onClick={() => void exportHtml()} labelKey="rp.actExport" testId="act-export" />
        <Act onClick={() => void clone()} disabled={streaming} labelKey="rp.actClone" testId="act-clone" />
        {session?.sessionFile ? (
          <Act
            onClick={() => void window.yan.revealPath(session.sessionFile!)}
            labelKey="rp.actReveal"
            testId="act-reveal"
          />
        ) : null}
      </div>
      <div className="rp-kv rp-action-setting" data-testid="rp-auto-retry">
        <span className="rp-k">{t('status.autoRetry')}</span>
        <span className="spacer" />
        <span title={t('status.autoRetryHint')}>
          <Switch checked={autoRetry} label={t('status.autoRetry')} onChange={(next) => void setAutoRetry(next)} />
        </span>
      </div>
    </Section>
  )
}

function Act({
  onClick,
  labelKey,
  testId,
  disabled
}: {
  onClick: () => void
  labelKey: MessageKey
  testId: string
  disabled?: boolean
}) {
  const t = useT()
  return (
    <Button
      size="sm"
      className="rp-act"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={disabled ? t('picker.busy') : t(labelKey)}
    >
      {t(labelKey)}
    </Button>
  )
}
