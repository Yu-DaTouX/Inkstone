import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  type RemoteAccessSettings,
  type RemoteAccessStatus,
  type RemoteDeviceRecord
} from '../../../../../shared/remote-protocol'
import type { PeerGrantView, PeerStatusView } from '../../../../../shared/peer-protocol'
import { useStore } from '../../../state/store'
import { Badge, Button, Switch } from '../../../ui'
import { generalText, type GeneralText } from './general-text'
import { formatWhen } from './general-model'
import { SettingsRow } from '../root/controls'

export interface DeviceListProps {
  devices: readonly RemoteDeviceRecord[]
  busy: boolean
  text: GeneralText
  lang: string
  onRevoke: (id: string) => void
  onForget: (id: string) => void
}

export function DeviceList({ devices, busy, text, lang, onRevoke, onForget }: DeviceListProps): ReactElement {
  const active = devices.filter((device) => device.revokedAt === null)
  const revoked = devices.filter((device) => device.revokedAt !== null)
  if (devices.length === 0) {
    return (
      <p className="settings-row__desc" data-testid="v3-devices-empty">
        {text.devicesNone}
      </p>
    )
  }
  return (
    <ul className="settings-devices" data-testid="v3-device-list">
      {active.map((device) => (
        <li className="settings-device" key={device.id} data-testid="v3-device">
          <div className="settings-device__main">
            <span className="settings-device__name">{device.name}</span>
            {device.kind === 'peer' ? <Badge tone="accent">peer</Badge> : null}
            <span className="settings-row__desc">
              {text.devicesPairedAt.replace('{time}', formatWhen(device.createdAt, text.devicesNever, lang))} ·{' '}
              {text.devicesLastSeen.replace('{time}', formatWhen(device.lastSeenAt, text.devicesNever, lang))}
            </span>
          </div>
          <Button size="sm" variant="danger" isDisabled={busy} onPress={() => onRevoke(device.id)}>
            {text.devicesRevoke}
          </Button>
        </li>
      ))}
      {revoked.map((device) => (
        <li className="settings-device" key={device.id} data-state="revoked">
          <div className="settings-device__main">
            <span className="settings-device__name">{device.name}</span>
            <span className="settings-row__desc">
              {text.devicesRevokedAt.replace('{time}', formatWhen(device.revokedAt, text.devicesNever, lang))}
            </span>
          </div>
          <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => onForget(device.id)}>
            {text.devicesForget}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function pairingLinkOf(status: RemoteAccessStatus | null): string | null {
  if (!status?.pairing) return null
  const endpoint = status.running ? `${status.host}:${status.port}` : null
  if (!endpoint) return null
  return `inkstone://pair?address=${encodeURIComponent(`http://${endpoint}`)}&code=${status.pairing.code}`
}

export function DevicesSettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const saved = useStore((s) => s.settings?.remoteAccess) ?? DEFAULT_REMOTE_ACCESS_SETTINGS
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [, setPeer] = useState<PeerStatusView | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const remote = await window.yan.remote.status()
      if (!alive.current) return
      setStatus(remote)
      setError('')
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
    try {
      const peers = await window.yan.peer.status()
      if (!alive.current) return
      setPeer(peers)
    } catch {
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh().finally(() => {
      if (alive.current) setBusy(false)
    })
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 5000)
    return () => {
      alive.current = false
      window.clearInterval(id)
    }
  }, [refresh])

  useEffect(() => {
    if (!status?.pairing) return undefined
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [status?.pairing])

  const configure = (patch: Partial<RemoteAccessSettings>): void => {
    const next: RemoteAccessSettings = { ...saved, ...patch }
    setBusy(true)
    void window.yan.remote
      .configure(next)
      .then((value) => {
        if (alive.current) setStatus(value)
      })
      .catch((cause) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (alive.current) setBusy(false)
      })
  }

  const run = (action: () => Promise<RemoteAccessStatus | null>): void => {
    setBusy(true)
    void action()
      .then((value) => {
        if (alive.current) setStatus(value)
      })
      .catch((cause) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (alive.current) setBusy(false)
      })
  }

  const link = pairingLinkOf(status)
  const secondsLeft = status?.pairing ? Math.max(0, Math.ceil((status.pairing.expiresAt - now) / 1000)) : 0
  const grants: readonly PeerGrantView[] = status?.grants ?? []

  return (
    <section className="settings-section" data-testid="v3-devices-settings">
      {error ? (
        <p className="settings-row__desc settings-row__desc--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="settings-rows">
        <SettingsRow
          label={text.devicesEnable}
          description={
            <>
              {text.devicesEnableDesc}
              <br />
              {status?.running ? (
                <Badge tone="run">
                  {text.devicesRunning} · {status.host}:{status.port}
                </Badge>
              ) : (
                <Badge tone="neutral">{text.devicesStopped}</Badge>
              )}
            </>
          }
        >
          <Switch
            aria-label={text.devicesEnable}
            isSelected={saved.enabled}
            isDisabled={busy}
            onChange={(on) => configure({ enabled: on })}
            data-testid="v3-devices-enable"
          />
        </SettingsRow>

        <SettingsRow block label={text.devicesPair} description={text.devicesPairDesc}>
          {status?.pairing && secondsLeft > 0 ? (
            <div className="settings-device" data-testid="v3-devices-pairing">
              <span className="settings-value" data-testid="v3-devices-pairing-code">
                {text.devicesPairCode}: <strong>{status.pairing.code}</strong>
              </span>
              <span className="settings-row__desc">
                {text.devicesPairExpires.replace('{seconds}', String(secondsLeft))}
              </span>
              {link ? (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="v3-devices-pairing-copy"
                  onPress={() => {
                    void navigator.clipboard.writeText(link).then(
                      () => setCopied(true),
                      () => setCopied(false)
                    )
                  }}
                >
                  {copied ? text.devicesPairCopied : text.devicesPairCopy}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => run(() => window.yan.remote.cancelPairing())}>
                {text.devicesPairCancel}
              </Button>
            </div>
          ) : (
            <div className="settings-actions">
              <Button
                size="sm"
                variant="primary"
                isDisabled={busy || !status?.running}
                data-testid="v3-devices-pair"
                onPress={() => run(() => window.yan.remote.pair())}
              >
                {text.devicesPairStart}
              </Button>
              {!status?.running ? <span className="settings-row__desc">{text.devicesPairNeedsRunning}</span> : null}
            </div>
          )}
        </SettingsRow>

        <SettingsRow block label={text.devicesList} description={text.devicesListDesc}>
          <DeviceList
            devices={status?.devices ?? []}
            busy={busy}
            text={text}
            lang={lang}
            onRevoke={(id) => run(() => window.yan.remote.revoke(id))}
            onForget={(id) => run(() => window.yan.remote.forget(id))}
          />
        </SettingsRow>

        <SettingsRow block label={text.devicesPeer} description={text.devicesPeerDesc}>
          {grants.length === 0 ? (
            <p className="settings-row__desc" data-testid="v3-devices-peer-empty">
              {text.devicesPeerNone}
            </p>
          ) : (
            <ul className="settings-devices" data-testid="v3-devices-peer">
              {grants.map((grant) => (
                <li className="settings-device" key={grant.connectionId}>
                  <div className="settings-device__main">
                    <span className="settings-device__name">{grant.deviceName}</span>
                    <span className="settings-row__desc">
                      {grant.projects.map((project) => project.name).join('、')} · {grant.operations.join(', ')}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    isDisabled={busy}
                    onPress={() =>
                      void window.yan.peer
                        .hostRevoke(grant.connectionId)
                        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                    }
                  >
                    {text.devicesPeerRevoke}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      </div>
    </section>
  )
}
