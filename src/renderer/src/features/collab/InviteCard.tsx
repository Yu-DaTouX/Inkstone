import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { pairInviteAddress, pairInviteLink } from '../../../../shared/pair-invite'
import type { RemoteAccessStatus } from '../../../../shared/remote-protocol'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { Button, Card, Notice } from '../../ui'
import { fill, type CollabText } from './collab-text'

interface InviteCardProps {
  text: CollabText
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function InviteCard({ text }: InviteCardProps): ReactElement | null {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)
  const remote = typeof window !== 'undefined' ? window.yan?.remote : undefined

  const refresh = useCallback(async (): Promise<void> => {
    if (!remote) return
    try {
      const next = await remote.status()
      if (alive.current) setStatus(next)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setLoaded(true)
    }
  }, [remote])

  useEffect(() => {
    alive.current = true
    void refresh()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 5000)
    return () => {
      alive.current = false
      window.clearInterval(id)
    }
  }, [refresh])

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
      .then((next) => {
        if (alive.current) setStatus(next)
      })
      .catch((cause) => {
        if (alive.current) setError(errorText(cause))
      })
      .finally(() => {
        if (alive.current) setBusy(false)
      })
  }

  const openDevices = (): void => {
    useUiV3.getState().navigate({ name: 'settings' })
    useStore.getState().openSettings('devices')
  }

  const target = pairInviteAddress(status)
  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  const active = pairing && secondsLeft > 0 && target.ok ? pairing : null
  const link = active && target.ok ? pairInviteLink({ address: target.address, code: active.code }) : ''

  return (
    <Card className="collab-invite" data-testid="v3-collab-invite">
      <p className="collab-label">{text.inviteTitle}</p>
      <p className="collab-hint">{text.inviteHint}</p>
      {error ? (
        <Notice tone="fail" compact>
          {error}
        </Notice>
      ) : null}
      {loaded && !target.ok ? (
        <div className="collab-invite__row">
          <Notice tone="ask" compact role="note" data-testid="v3-collab-invite-unavailable">
            {target.reason === 'stopped' ? text.inviteStopped : text.inviteLoopback}
          </Notice>
          <Button size="sm" variant="secondary" onPress={openDevices}>
            {text.inviteOpenDevices}
          </Button>
        </div>
      ) : null}
      {active ? (
        <div className="collab-invite__body" data-testid="v3-collab-invite-active">
          <div className="collab-invite__qr" role="img" aria-label={text.inviteQrLabel}>
            <QRCodeSVG value={link} size={144} marginSize={2} bgColor="#ffffff" fgColor="#111111" />
          </div>
          <div className="collab-invite__detail">
            <span className="collab-invite__code">
              {text.inviteCode}: <strong data-testid="v3-collab-invite-code">{active.code}</strong>
            </span>
            <span className="collab-hint">{fill(text.inviteExpires, { seconds: secondsLeft })}</span>
            <code className="collab-invite__link" data-testid="v3-collab-invite-link">
              {link}
            </code>
            <div className="collab-invite__row">
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
        <div className="collab-invite__row">
          <Button size="sm" variant="secondary" isPending={busy} data-testid="v3-collab-invite-start" onPress={() => run(() => remote.pair())}>
            {text.inviteStart}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
