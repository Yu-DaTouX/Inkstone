import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useI18n } from '../../../i18n'
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  type RemoteAccessSettings,
  type RemoteAccessStatus,
  type RemoteDeviceRecord
} from '../../../../../shared/remote-protocol'
import type { PeerGrantView, PeerStatusView } from '../../../../../shared/peer-protocol'
import { pairInviteAddress, pairInviteLink } from '../../../../../shared/pair-invite'
import { useStore } from '../../../state/store'
import { Badge, Button, ListBoxItem, Select, Switch } from '../../../ui'
import { generalText, type GeneralText } from './general-text'
import { formatWhen } from './general-model'
import { Segmented, SettingsGroup, SettingsRow } from '../root/controls'
import { RelaySettings } from './RelaySettings'

type BindMode = 'tailscale' | 'radmin' | 'lan' | 'loopback'

function bindModeOf(bind: string): BindMode {
  return bind === 'tailscale' || bind === 'radmin' || bind === 'loopback' ? bind : 'lan'
}

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
  const target = pairInviteAddress(status)
  return target.ok ? pairInviteLink({ address: target.address, code: status.pairing.code }) : null
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
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [status?.pairing])

  const configure = (patch: Partial<RemoteAccessSettings>): void => {
    const next: RemoteAccessSettings = { ...saved, ...patch }
    setBusy(true)
    setError('')
    void window.yan.remote
      .configure(next)
      .then((value) => {
        const store = useStore.getState()
        if (store.settings) store.setSettings({ ...store.settings, remoteAccess: next })
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

  const lanAddresses = (status?.addresses ?? []).filter((entry) => entry.kind === 'lan').map((entry) => entry.address)
  const bindMode = bindModeOf(saved.bind)
  const lanChoices = bindMode === 'lan' && !lanAddresses.includes(saved.bind) ? [saved.bind, ...lanAddresses] : lanAddresses
  const radminMissing = bindMode === 'radmin' && !!status && !status.addresses.some((entry) => entry.kind === 'radmin')
  const chooseBind = (mode: BindMode): void => {
    if (mode === bindMode) return
    if (mode !== 'lan') {
      configure({ bind: mode })
      return
    }
    const first = lanAddresses[0]
    if (!first) {
      setError(text.devicesBindLanNone)
      return
    }
    configure({ bind: first })
  }
  const startError = saved.enabled && status && !status.running && status.error ? status.error : ''
  const loopbackOnly = !!status?.running && !pairInviteAddress(status).ok
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

      <SettingsGroup label={text.devicesEnable}>
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
              {startError ? (
                <span className="settings-row__desc settings-row__desc--error" role="alert" data-testid="v3-devices-start-error">
                  <br />
                  {text.devicesStartFailed.replace('{error}', startError)}
                </span>
              ) : null}
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

        <SettingsRow block label={text.devicesBind} description={text.devicesBindDesc}>
          <div className="settings-bind" data-testid="v3-devices-bind">
            <Segmented<BindMode>
              label={text.devicesBind}
              value={bindMode}
              disabled={busy}
              onChange={chooseBind}
              options={[
                { value: 'tailscale', label: text.devicesBindTailscale, testId: 'v3-devices-bind-tailscale' },
                { value: 'radmin', label: text.devicesBindRadmin, testId: 'v3-devices-bind-radmin' },
                { value: 'lan', label: text.devicesBindLan, testId: 'v3-devices-bind-lan' },
                { value: 'loopback', label: text.devicesBindLoopback, testId: 'v3-devices-bind-loopback' }
              ]}
            />
            {bindMode === 'lan' && lanChoices.length > 1 ? (
              <Select
                aria-label={text.devicesBindLanAddress}
                selectedKey={saved.bind}
                isDisabled={busy}
                onSelectionChange={(key) => {
                  if (key != null && String(key) !== saved.bind) configure({ bind: String(key) })
                }}
              >
                {lanChoices.map((address) => (
                  <ListBoxItem key={address} id={address}>
                    {address}
                  </ListBoxItem>
                ))}
              </Select>
            ) : bindMode === 'lan' ? (
              <span className="settings-value">{saved.bind}</span>
            ) : null}
            {radminMissing ? <span className="settings-row__desc">{text.devicesBindRadminNone}</span> : null}
          </div>
        </SettingsRow>

        <SettingsRow block label={text.devicesPair} description={text.devicesPairDesc}>
          {status?.pairing && secondsLeft > 0 ? (
            <div className="settings-device" data-testid="v3-devices-pairing">
              {link ? (
                <div className="settings-pair-qr" role="img" aria-label={text.devicesPairQr} data-testid="v3-devices-pairing-qr">
                  <QRCodeSVG value={link} size={144} marginSize={2} bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : null}
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
              {!status?.running && !saved.enabled ? <span className="settings-row__desc">{text.devicesPairNeedsRunning}</span> : null}
              {loopbackOnly ? <span className="settings-row__desc">{text.devicesPairLoopback}</span> : null}
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={text.devicesList}>
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
      </SettingsGroup>

      <RelaySettings saved={saved} status={status} busy={busy} text={text} lang={lang} configure={configure} run={run} />

      <SettingsGroup label={text.devicesPeer}>
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
      </SettingsGroup>
    </section>
  )
}
