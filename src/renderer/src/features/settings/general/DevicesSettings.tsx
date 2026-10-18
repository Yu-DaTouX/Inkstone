import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useI18n } from '../../../i18n'
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  type RemoteAccessSettings,
  type RemoteAccessStatus,
  type RemoteDeviceRecord,
  type RemoteRelayClient
} from '../../../../../shared/remote-protocol'
import type { PeerGrantView } from '../../../../../shared/peer-protocol'
import { pairInviteAddress, pairInviteLink } from '../../../../../shared/pair-invite'
import { useStore } from '../../../state/store'
import { Badge, Button, ListBoxItem, Select, Switch } from '../../../ui'
import { generalText, type GeneralText } from './general-text'
import { devicesDataText } from './devices-data-text'
import { formatWhen } from './general-model'
import { Segmented, SettingsGroup, SettingsMore, SettingsRow } from '../root/controls'
import { RelayPairingPanel, RelayRows, relaySettingsOf } from './RelaySettings'
import './devices-data.css'

type BindMode = 'tailscale' | 'radmin' | 'lan' | 'loopback'

function bindModeOf(bind: string): BindMode {
  return bind === 'tailscale' || bind === 'radmin' || bind === 'loopback' ? bind : 'lan'
}

function secondsUntil(expiresAt: number | undefined, now: number): number {
  return typeof expiresAt === 'number' ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0
}

interface PairedEntry {
  key: string
  name: string
  via: 'direct' | 'relay'
  peer: boolean
  online: boolean
  pairedAt: number
  lastSeenAt: number | null
  revokedAt: number | null
  revoke: () => void
  forget: () => void
}

export interface DeviceListProps {
  devices: readonly RemoteDeviceRecord[]
  relayClients?: readonly RemoteRelayClient[]
  busy: boolean
  text: GeneralText
  lang: string
  onRevoke: (id: string) => void
  onForget: (id: string) => void
  onRelayRevoke?: (id: string) => void
  onRelayForget?: (id: string) => void
}

export function DeviceList({
  devices,
  relayClients = [],
  busy,
  text,
  lang,
  onRevoke,
  onForget,
  onRelayRevoke,
  onRelayForget
}: DeviceListProps): ReactElement {
  const local = devicesDataText(lang === 'en-US' ? 'en-US' : 'zh-CN')
  const entries: PairedEntry[] = [
    ...devices.map((device) => ({
      key: `direct:${device.id}`,
      name: device.name,
      via: 'direct' as const,
      peer: device.kind === 'peer',
      online: false,
      pairedAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
      revoke: () => onRevoke(device.id),
      forget: () => onForget(device.id)
    })),
    ...relayClients.map((client) => ({
      key: `relay:${client.id}`,
      name: client.name,
      via: 'relay' as const,
      peer: client.kind === 'agent',
      online: client.online,
      pairedAt: client.addedAt,
      lastSeenAt: client.lastSeenAt,
      revokedAt: client.revokedAt,
      revoke: () => onRelayRevoke?.(client.id),
      forget: () => onRelayForget?.(client.id)
    }))
  ]
  if (entries.length === 0) {
    return (
      <p className="settings-row__desc" data-testid="v3-devices-empty">
        {text.devicesNone}
      </p>
    )
  }
  const active = entries.filter((entry) => entry.revokedAt === null)
  const revoked = entries.filter((entry) => entry.revokedAt !== null)
  const viaBadge = (entry: PairedEntry): ReactElement => (
    <Badge tone="neutral">{entry.via === 'relay' ? local.viaRelay : local.viaDirect}</Badge>
  )
  return (
    <ul className="settings-devices" data-testid="v3-device-list">
      {active.map((entry) => (
        <li className="settings-device" key={entry.key} data-testid="v3-device" data-via={entry.via}>
          <div className="settings-device__main">
            <span className="settings-device__name">
              {entry.name} {viaBadge(entry)}
              {entry.peer ? <> <Badge tone="accent">peer</Badge></> : null}
              {entry.online ? <> <Badge tone="run">{local.online}</Badge></> : null}
            </span>
            <span className="settings-row__desc">
              {text.devicesPairedAt.replace('{time}', formatWhen(entry.pairedAt, text.devicesNever, lang))} ·{' '}
              {text.devicesLastSeen.replace('{time}', formatWhen(entry.lastSeenAt, text.devicesNever, lang))}
            </span>
          </div>
          <Button size="sm" variant="danger" isDisabled={busy} onPress={entry.revoke}>
            {text.devicesRevoke}
          </Button>
        </li>
      ))}
      {revoked.map((entry) => (
        <li className="settings-device" key={entry.key} data-state="revoked" data-via={entry.via}>
          <div className="settings-device__main">
            <span className="settings-device__name">
              {entry.name} {viaBadge(entry)}
            </span>
            <span className="settings-row__desc">
              {text.devicesRevokedAt.replace('{time}', formatWhen(entry.revokedAt, text.devicesNever, lang))}
            </span>
          </div>
          <Button size="sm" variant="danger" isDisabled={busy} onPress={entry.forget}>
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
  const local = devicesDataText(lang)
  const saved = useStore((s) => s.settings?.remoteAccess) ?? DEFAULT_REMOTE_ACCESS_SETTINGS
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
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

  const relayPairing = status?.relay?.pairing ?? null
  const ticking = Boolean(status?.pairing || relayPairing)
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [ticking, status?.pairing, relayPairing])

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
  const relay = relaySettingsOf(saved)
  const relayConnected = Boolean(status?.relay?.connected)
  const startError = saved.enabled && status && !status.running && status.error ? status.error : ''
  const loopbackOnly = !!status?.running && !pairInviteAddress(status).ok
  const link = pairingLinkOf(status)
  const directSeconds = secondsUntil(status?.pairing?.expiresAt, now)
  const relaySeconds = secondsUntil(relayPairing?.expiresAt, now)
  const directPairing = status?.pairing && directSeconds > 0 ? status.pairing : null
  const activeRelayPairing = relayPairing && relaySeconds > 0 ? relayPairing : null
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
          settingId="devices-enable"
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

        <SettingsRow block settingId="devices-pair" label={text.devicesPair} description={text.devicesPairDesc}>
          {directPairing ? (
            <div className="settings-device dd-pairing" data-testid="v3-devices-pairing">
              {link ? (
                <div className="settings-pair-qr" role="img" aria-label={text.devicesPairQr} data-testid="v3-devices-pairing-qr">
                  <QRCodeSVG value={link} size={144} marginSize={2} bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : null}
              <div className="settings-device__main">
                <span className="settings-value" data-testid="v3-devices-pairing-code">
                  {text.devicesPairCode}: <strong>{directPairing.code}</strong>
                </span>
                <span className="settings-row__desc">
                  {text.devicesPairExpires.replace('{seconds}', String(directSeconds))}
                </span>
                <div className="settings-actions">
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
                  <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => run(() => window.yan.remote.cancelPairing())}>
                    {text.devicesPairCancel}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {activeRelayPairing ? (
            <RelayPairingPanel
              pairing={activeRelayPairing}
              secondsLeft={relaySeconds}
              busy={busy}
              onCancel={() => run(() => window.yan.remote.relayCancel())}
            />
          ) : null}
          {!directPairing && !activeRelayPairing ? (
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
              {relay.enabled ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || !relayConnected}
                  data-testid="v3-relay-pair"
                  onPress={() => run(() => window.yan.remote.relayPair('phone'))}
                >
                  {local.pairViaRelay}
                </Button>
              ) : null}
              {!status?.running && !saved.enabled ? <span className="settings-row__desc">{text.devicesPairNeedsRunning}</span> : null}
              {loopbackOnly ? <span className="settings-row__desc">{text.devicesPairLoopback}</span> : null}
              {relay.enabled && !relayConnected ? <span className="settings-row__desc">{local.pairRelayWaiting}</span> : null}
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow block settingId="devices-list" label={text.devicesList} description={text.devicesListDesc}>
          <DeviceList
            devices={status?.devices ?? []}
            relayClients={status?.relay?.clients ?? []}
            busy={busy}
            text={text}
            lang={lang}
            onRevoke={(id) => run(() => window.yan.remote.revoke(id))}
            onForget={(id) => run(() => window.yan.remote.forget(id))}
            onRelayRevoke={(id) => run(() => window.yan.remote.relayRevoke(id))}
            onRelayForget={(id) => run(() => window.yan.remote.relayForget(id))}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsMore>
        <SettingsGroup label={local.network}>
          <SettingsRow block settingId="devices-bind" label={text.devicesBind} description={text.devicesBindDesc}>
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

          <RelayRows saved={saved} status={status} busy={busy} configure={configure} />
        </SettingsGroup>

        <SettingsGroup label={text.devicesPeer}>
          <SettingsRow block settingId="devices-peer" label={text.devicesPeer} description={text.devicesPeerDesc}>
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
      </SettingsMore>
    </section>
  )
}
