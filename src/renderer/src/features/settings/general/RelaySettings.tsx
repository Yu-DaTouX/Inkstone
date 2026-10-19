import { useEffect, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useI18n, useT } from '../../../i18n'
import type { RemoteAccessSettings, RemoteAccessStatus, RemoteRelaySettings } from '../../../../../shared/remote-protocol'
import { Badge, Button, Switch, TextField } from '../../../ui'
import { SettingsRow } from '../root/controls'
import { devicesDataText } from './devices-data-text'

const RELAY_PLACEHOLDER = 'https://relay.example.com'

export type RelayPairing = NonNullable<NonNullable<RemoteAccessStatus['relay']>['pairing']>

export function relaySettingsOf(saved: RemoteAccessSettings): RemoteRelaySettings {
  return saved.relay ?? { enabled: false, url: '' }
}

interface RelayRowsProps {
  saved: RemoteAccessSettings
  status: RemoteAccessStatus | null
  busy: boolean
  configure: (patch: Partial<RemoteAccessSettings>) => void
}

export function RelayRows({ saved, status, busy, configure }: RelayRowsProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = devicesDataText(lang)
  const relay = relaySettingsOf(saved)
  const [url, setUrl] = useState(relay.url)
  const state = status?.relay

  useEffect(() => setUrl(relay.url), [relay.url])

  const save = (next: RemoteRelaySettings): void => configure({ relay: next })
  const commitUrl = (): void => {
    const next = url.trim()
    if (next !== url) setUrl(next)
    if (next !== relay.url) save({ enabled: relay.enabled && !!next, url: next })
  }
  const needsUrl = !relay.enabled && !url.trim()

  return (
    <>
      <SettingsRow
        settingId="devices-relay"
        label={t('remote.relay')}
        description={
          <>
            {t('remote.relayDesc')}
            {needsUrl ? (
              <>
                <br />
                {text.relayNeedsUrl}
              </>
            ) : null}
            {relay.enabled ? (
              <>
                <br />
                {state?.connected ? (
                  <Badge tone="ok">{t('remote.relayConnected')}</Badge>
                ) : (
                  <Badge tone="stall">{state?.detail ?? t('remote.relayConnecting')}</Badge>
                )}
              </>
            ) : null}
          </>
        }
      >
        <Switch
          aria-label={t('remote.relay')}
          isSelected={relay.enabled}
          isDisabled={busy || needsUrl}
          onChange={(enabled) => save({ enabled, url: url.trim() })}
          data-testid="v3-relay-enable"
        />
      </SettingsRow>

      <SettingsRow nested block settingId="devices-relay-url" label={t('remote.relayUrl')} description={text.relayUrlDesc}>
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
    </>
  )
}

interface RelayPairingPanelProps {
  pairing: RelayPairing
  secondsLeft: number
  busy: boolean
  onCancel: () => void
}

export function RelayPairingPanel({ pairing, secondsLeft, busy, onCancel }: RelayPairingPanelProps): ReactElement {
  const t = useT()
  const [copied, setCopied] = useState(false)

  useEffect(() => setCopied(false), [pairing.link])

  return (
    <div className="settings-device dd-pairing" data-testid="v3-relay-pairing">
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
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={onCancel}>
            {t('remote.pairCancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
