import { useEffect, useState, type ReactElement } from 'react'
import { pairInviteAddress, pairInviteLink } from '../../../../shared/pair-invite'
import type { RemoteAccessStatus } from '../../../../shared/remote-protocol'
import { useStore } from '../../state/store'
import { Button, Card, CardHead, CardTitle, Notice, QrCode } from '../../ui'
import { fill, type CollabText } from './collab-text'
import { errorText, type RemoteStatusState } from './remote-status'

interface InviteCardProps {
  text: CollabText
  remoteState: RemoteStatusState
}

export function InviteCard({ text, remoteState }: InviteCardProps): ReactElement | null {
  const { remote, status, loaded, error, setError, apply } = remoteState
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const pairing = status?.pairing ?? null

  useEffect(() => {
    if (!pairing) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pairing])

  useEffect(() => {
    setCopied(false)
  }, [pairing?.code])

  if (!remote) return null

  const run = (action: () => Promise<RemoteAccessStatus | null>): void => {
    setBusy(true)
    setError('')
    void action()
      .then(apply)
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setBusy(false))
  }

  const openDevices = (): void => {
    useStore.getState().openSettings('devices')
  }

  const target = pairInviteAddress(status)
  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  const active = pairing && secondsLeft > 0 && target.ok ? pairing : null
  const link = active && target.ok ? pairInviteLink({ address: target.address, code: active.code }) : ''

  return (
    <Card className="collab-card" data-testid="v3-collab-invite">
      <CardHead>
        <CardTitle>{text.inviteTitle}</CardTitle>
      </CardHead>
      <p className="collab-hint">{text.inviteHint}</p>
      {error ? (
        <Notice tone="fail" compact>
          {error}
        </Notice>
      ) : null}
      {loaded && !target.ok ? (
        <Notice
          tone="ask"
          compact
          role="note"
          data-testid="v3-collab-invite-unavailable"
          action={
            <Button size="sm" variant="secondary" onPress={openDevices}>
              {text.inviteOpenDevices}
            </Button>
          }
        >
          {target.reason === 'stopped' ? text.inviteStopped : text.inviteLoopback}
        </Notice>
      ) : null}
      {active ? (
        <div className="collab-invite" data-testid="v3-collab-invite-active">
          <QrCode value={link} size={144} title={text.inviteQrLabel} />
          <div className="collab-invite__detail">
            <span className="collab-invite__code">
              {text.inviteCode}: <strong data-testid="v3-collab-invite-code">{active.code}</strong>
            </span>
            <span className="collab-hint">{fill(text.inviteExpires, { seconds: secondsLeft })}</span>
            <code className="collab-invite__link collab-code" data-testid="v3-collab-invite-link">
              {link}
            </code>
            <div className="collab-actions">
              <Button
                size="sm"
                variant="primary"
                data-testid="v3-collab-invite-copy"
                onPress={() => {
                  void navigator.clipboard.writeText(link).then(
                    () => setCopied(true),
                    () => setCopied(false)
                  )
                }}
              >
                {copied ? text.inviteCopied : text.inviteCopy}
              </Button>
              <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => run(() => remote.cancelPairing())}>
                {text.inviteCancel}
              </Button>
            </div>
          </div>
        </div>
      ) : target.ok ? (
        <div className="collab-actions">
          <Button size="sm" variant="secondary" isPending={busy} data-testid="v3-collab-invite-start" onPress={() => run(() => remote.pair())}>
            {text.inviteStart}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
