import { useEffect, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useT } from '../../../i18n'
import type { RemoteAccessSettings, RemoteAccessStatus, RemoteRelaySettings } from '../../../../../shared/remote-protocol'
import { Badge, Button, Switch, TextField } from '../../../ui'
import { formatWhen } from './general-model'
import type { GeneralText } from './general-text'
import { SettingsGroup, SettingsRow } from '../root/controls'

const RELAY_PLACEHOLDER = 'https://reef-relay.example.workers.dev'

interface Props {
  saved: RemoteAccessSettings
  status: RemoteAccessStatus | null
  busy: boolean
  text: GeneralText
  lang: string
  configure: (patch: Partial<RemoteAccessSettings>) => void
  run: (action: () => Promise<RemoteAccessStatus | null>) => void
}

export function RelaySettings({ saved, status, busy, text, lang, configure, run }: Props): ReactElement {
  const t = useT()
  const relay: RemoteRelaySettings = saved.relay ?? { enabled: false, url: '' }
  const [url, setUrl] = useState(relay.url)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const state = status?.relay
  const pairing = state?.pairing ?? null

  useEffect(() => setUrl(relay.url), [relay.url])
  useEffect(() => setCopied(false), [pairing?.link])
  useEffect(() => {
    if (!pairing) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pairing])

  const save = (next: RemoteRelaySettings): void => configure({ relay: next })
  const commitUrl = (): void => {
    const next = url.trim()
    if (next !== url) setUrl(next)
    if (next !== relay.url) save({ enabled: relay.enabled && !!next, url: next })
  }
  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  const clients = state?.clients ?? []
  const active = clients.filter((client) => client.revokedAt === null)
  const revoked = clients.filter((client) => client.revokedAt !== null)

  return (
    <SettingsGroup label={t('remote.relay')}>
      <SettingsRow label={t('remote.relay')} description={t('remote.relayDesc')}>
        <Switch
          aria-label={t('remote.relay')}
          isSelected={relay.enabled}
          isDisabled={busy || (!relay.enabled && !url.trim())}
          onChange={(enabled) => save({ enabled, url: url.trim() })}
          data-testid="v3-relay-enable"
        />
      </SettingsRow>

      <SettingsRow block label={t('remote.relayUrl')} description={t('remote.relayUrlDesc')}>
        <TextField
          aria-label={t('remote.relayUrl')}
          className="settings-relay-url"
          value={url}
          placeholder={RELAY_PLACEHOLDER}
          isDisabled={busy}
          onChange={setUrl}
          onBlur={commitUrl}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitUrl()
          }}
          data-testid="v3-relay-url"
        />
      </SettingsRow>

      {relay.enabled ? (
        <>
          <SettingsRow
            block
            label={t('remote.relayStatus')}
            description={
              state?.connected ? (
                <Badge tone="run">{t('remote.relayConnected')}</Badge>
              ) : (
                <Badge tone="stall">{state?.detail ?? t('remote.relayConnecting')}</Badge>
              )
            }
          >
            {pairing && secondsLeft > 0 ? (
              <div className="settings-device" data-testid="v3-relay-pairing">
                <div className="settings-pair-qr" role="img" aria-label={t('remote.relayQr')} data-testid="v3-relay-qr">
                  <QRCodeSVG value={pairing.link} size={144} level="M" marginSize={2} bgColor="#ffffff" fgColor="#111111" />
                </div>
                <div className="settings-device__main">
                  <span className="settings-row__desc">{t('remote.relayPhoneHint')}</span>
                  <span className="settings-row__desc">{t('remote.relayExpires', { seconds: secondsLeft })}</span>
                  <div className="settings-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="v3-relay-copy"
                      onPress={() => {
                        void navigator.clipboard.writeText(pairing.link).then(
                          () => setCopied(true),
                          () => setCopied(false)
                        )
                      }}
                    >
                      {copied ? t('remote.relayCopied') : t('remote.relayCopy')}
                    </Button>
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => run(() => window.yan.remote.relayCancel())}>
                      {t('remote.pairCancel')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="settings-actions">
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={busy || !state?.connected}
                  data-testid="v3-relay-pair"
                  onPress={() => run(() => window.yan.remote.relayPair('phone'))}
                >
                  {t('remote.relayPairPhone')}
                </Button>
              </div>
            )}
          </SettingsRow>

          <SettingsRow block label={text.devicesList}>
            {clients.length === 0 ? (
              <p className="settings-row__desc" data-testid="v3-relay-empty">
                {t('remote.relayNoClients')}
              </p>
            ) : (
              <ul className="settings-devices" data-testid="v3-relay-clients">
                {active.map((client) => (
                  <li className="settings-device" key={client.id} data-testid="v3-relay-client">
                    <div className="settings-device__main">
                      <span className="settings-device__name">
                        {client.name}
                        {client.online ? (
                          <>
                            {' '}
                            <Badge tone="run">{t('remote.relayOnline')}</Badge>
                          </>
                        ) : null}
                      </span>
                      <span className="settings-row__desc">
                        {text.devicesPairedAt.replace('{time}', formatWhen(client.addedAt, text.devicesNever, lang))} ·{' '}
                        {text.devicesLastSeen.replace('{time}', formatWhen(client.lastSeenAt, text.devicesNever, lang))}
                      </span>
                    </div>
                    <Button size="sm" variant="danger" isDisabled={busy} onPress={() => run(() => window.yan.remote.relayRevoke(client.id))}>
                      {text.devicesRevoke}
                    </Button>
                  </li>
                ))}
                {revoked.map((client) => (
                  <li className="settings-device" key={client.id} data-state="revoked">
                    <div className="settings-device__main">
                      <span className="settings-device__name">{client.name}</span>
                      <span className="settings-row__desc">
                        {text.devicesRevokedAt.replace('{time}', formatWhen(client.revokedAt, text.devicesNever, lang))}
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => run(() => window.yan.remote.relayForget(client.id))}>
                      {text.devicesForget}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SettingsRow>
        </>
      ) : null}
    </SettingsGroup>
  )
}
