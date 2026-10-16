import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useT } from '../../i18n'
import { Badge, Button, Disclosure, EmptyState, Segmented, SettingRow, Switch } from '../ui'
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  type RemoteAccessSettings,
  type RemoteAccessStatus
} from '../../../../shared/remote-protocol'
import { useStore } from '../../state/store'
import { RelaySection } from './RelaySection'
import { canReplaceDraft, isCurrentGeneration } from './review2-settings-guards'

type BindChoice = 'tailscale' | 'loopback' | 'custom'
const WINDOWS_TAILSCALE_URL = 'https://tailscale.com/download/windows'
const ANDROID_TAILSCALE_URL = 'https://tailscale.com/download/android'
const MOBILE_GUIDE_URL = 'https://github.com/Yu-DaTouX/Inkstone'

function openGuide(url: string): void {
  void window.yan.browser.openExternal(url)
}

function bindChoiceOf(bind: string): BindChoice {
  return bind === 'tailscale' || bind === 'loopback' ? bind : 'custom'
}

function formatTime(at: number | null, never: string): string {
  if (!at) return never
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at)
}

export function RemoteTab() {
  const t = useT()
  const saved = useStore((s) => s.settings?.remoteAccess) ?? DEFAULT_REMOTE_ACCESS_SETTINGS
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [draft, setDraft] = useState<RemoteAccessSettings>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(0)
  const savedRef = useRef(saved)
  const refreshGeneration = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshGeneration.current++ } }, [])
  const [linkCopied, setLinkCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    try {
      const next = await window.yan.remote.status()
      if (mounted.current && isCurrentGeneration(refreshGeneration.current, generation)) setStatus(next)
    } catch {
      if (mounted.current && isCurrentGeneration(refreshGeneration.current, generation)) setStatus(null)
    }
  }, [])

  useEffect(() => {
    const previous = savedRef.current
    savedRef.current = saved
    setDraft((current) => canReplaceDraft(current, previous) ? saved : current)
  }, [saved])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    return () => window.clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    if (!status?.pairing) return undefined
    const id = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
    }, 1000)
    return () => window.clearInterval(id)
  }, [status?.pairing])

  const run = async (action: () => Promise<RemoteAccessStatus | null>): Promise<void> => {
    pending.current++
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (mounted.current) setStatus(next)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current--
      if (mounted.current) setBusy(pending.current > 0)
    }
  }

  const configure = (next: RemoteAccessSettings): Promise<void> => {
    return run(async () => {
      const result = await window.yan.remote.configure(next)
      useStore.setState({ settings: await window.yan.getSettings() })
      savedRef.current = next
      setDraft(next)
      return result
    })
  }

  const choice = bindChoiceOf(draft.bind)
  const endpoint = status?.running ? `${status.host}:${status.port}` : null
  const pairingLink = status?.pairing && endpoint
    ? `inkstone://pair?address=${encodeURIComponent(`http://${endpoint}`)}&code=${status.pairing.code}`
    : null
  useEffect(() => setLinkCopied(false), [pairingLink])
  const secondsLeft = status?.pairing ? Math.max(0, Math.ceil((status.pairing.expiresAt - now) / 1000)) : 0
  const activeDevices = status?.devices.filter((device) => device.revokedAt === null) ?? []
  const revokedDevices = status?.devices.filter((device) => device.revokedAt !== null) ?? []

  return (
    <div className="ui-rows" data-testid="settings-remote">
      <SettingRow name={t('remote.enable')} desc={<>
        {t('remote.enableDesc')}
        <div className="remote-status-line" data-testid="remote-status">
          {status?.running ? (
            <>
              <Badge tone="ok">{t('remote.running')}</Badge> <span className="set-path">{endpoint}</span>
            </>
          ) : (
            <Badge>{t('remote.stopped')}</Badge>
          )}
          {status?.error ? <div className="set-warn">{status.error}</div> : null}
        </div>
      </>}>
          <Switch
            checked={draft.enabled}
            label={t('remote.enable')}
            disabled={busy}
            testId="remote-enable"
            onChange={(enabled) => void configure({ ...draft, enabled })}
          />
        </SettingRow>

      {error ? <div className="set-warn" role="alert">{error}</div> : null}
      <div className="ui-row col" data-testid="remote-pairing">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('remote.pairTitle')}</div>
          <div className="ui-row-desc">{t('remote.pairDesc')}</div>
        </div>
        {status?.pairing && secondsLeft > 0 ? (
          <div className="remote-pairing">
            <div className="remote-pairing-layout">
              {pairingLink ? (
                <div className="remote-pairing-qr" aria-label={t('remote.qrLabel')} data-testid="remote-pairing-qr">
                  <QRCodeSVG value={pairingLink} size={180} level="M" marginSize={2} />
                </div>
              ) : null}
              <div className="remote-pairing-detail">
                <div className="remote-pairing-code" data-testid="remote-pairing-code">{status.pairing.code}</div>
                <div className="ui-row-desc">
                  {t('remote.pairAddress', { address: endpoint ?? '—' })}
                  <br />
                  {t('remote.pairExpires', { seconds: secondsLeft })}
                </div>
                <div className="ui-row-desc">{t('remote.scanHint')} · Copied pairing links and codes remain in the system clipboard until replaced.</div>
                {status?.host === '127.0.0.1' ? <div className="set-warn">{t('remote.loopbackWarning')}</div> : null}
                {pairingLink ? <Button size="sm" data-testid="remote-pairing-link-copy" onClick={() => {
                  void navigator.clipboard.writeText(pairingLink).then(() => setLinkCopied(true)).catch(() => setLinkCopied(false))
                }}>{t(linkCopied ? 'remote.linkCopied' : 'remote.copyLink')}</Button> : null}
              </div>
            </div>
            <div className="btn-row">
              <Button size="sm" onClick={() => void run(() => window.yan.remote.cancelPairing())}>
                {t('remote.pairCancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="btn-row">
            <Button
              variant="primary"
              icon="phone"
              disabled={busy || !status?.running}
              data-testid="remote-pair-start"
              onClick={() => void run(() => window.yan.remote.pair())}
            >
              {t('remote.pairStart')}
            </Button>
            <Button size="sm" variant="ghost" data-testid="remote-guide" onClick={() => openGuide(MOBILE_GUIDE_URL)}>{t('remote.guide')}</Button>
            {!status?.running ? <span className="ui-row-desc">{t('remote.pairNeedsRunning')}</span> : null}
          </div>
        )}
      </div>

      <div className="ui-row col" data-testid="remote-devices">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('remote.devices')}</div>
          <div className="ui-row-desc">{t('remote.devicesDesc')}</div>
        </div>
        {activeDevices.length === 0 && revokedDevices.length === 0 ? (
          <EmptyState>{t('remote.noDevices')}</EmptyState>
        ) : (
          <ul className="remote-device-list">
            {activeDevices.map((device) => (
              <li key={device.id} className="remote-device" data-testid="remote-device">
                <div className="remote-device-main">
                  <span className="remote-device-name">{device.name}</span>
                  {device.kind === 'peer' ? <Badge tone="accent">{t('remote.kindPeer')}</Badge> : null}
                  {device.kind === 'agent' ? <Badge tone="accent">{t('remote.kindAgent')}</Badge> : null}
                  <span className="ui-row-desc">
                    {t('remote.pairedAt', { time: formatTime(device.createdAt, '—') })} ·{' '}
                    {t('remote.lastSeen', { time: formatTime(device.lastSeenAt, t('remote.never')) })}
                  </span>
                </div>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => window.yan.remote.revoke(device.id))}>
                  {t('remote.revoke')}
                </Button>
              </li>
            ))}
            {revokedDevices.map((device) => (
              <li key={device.id} className="remote-device revoked">
                <div className="remote-device-main">
                  <span className="remote-device-name">{device.name}</span>
                  <span className="ui-row-desc">{t('remote.revokedAt', { time: formatTime(device.revokedAt, '—') })}</span>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.yan.remote.forget(device.id))}>
                  {t('remote.forget')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Disclosure title={t('remote.networkSettings')}>
      <RelaySection draft={draft} status={status} busy={busy} configure={configure} run={run} />
      <SettingRow name={t('remote.bind')} desc={t('remote.bindDesc')}>
          <Segmented<BindChoice>
            value={choice}
            label={t('remote.bind')}
            testId="remote-bind"
            options={[
              { value: 'tailscale', label: 'Tailscale' },
              { value: 'loopback', label: t('remote.bindLoopback') },
              { value: 'custom', label: t('remote.bindCustom') }
            ]}
            onChange={(value) => {
              if (value === 'custom') {
                const lan = status?.addresses.find((entry) => entry.kind === 'lan')?.address ?? ''
                setDraft({ ...draft, bind: lan })
                if (lan) void configure({ ...draft, bind: lan })
                return
              }
              void configure({ ...draft, bind: value })
            }}
          />
        </SettingRow>

      {choice === 'custom' ? (
        <SettingRow name={t('remote.customAddress')} desc={t('remote.customAddressDesc')}>
            <input
              className="ui-input remote-address-input"
              value={draft.bind}
              placeholder="192.168.1.20"
              data-testid="remote-custom-address"
              onChange={(e) => setDraft({ ...draft, bind: e.target.value.trim() })}
              onBlur={() => void configure(draft)}
            />
          </SettingRow>
      ) : null}

      <SettingRow name={t('remote.port')} desc={t('remote.portDesc')}>
          <input
            className="ui-input num"
            inputMode="numeric"
            value={String(draft.port)}
            data-testid="remote-port"
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
            onBlur={() => void configure(draft)}
          />
        </SettingRow>

</Disclosure>
      <Disclosure title={t('remote.connectionHelp')}>      <div className="ui-row col">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('remote.setupTitle')}</div>
          <div className="ui-row-desc">{t('remote.setupDesc')}</div>
        </div>
        <div className="btn-row">
          <Button size="sm" onClick={() => openGuide(WINDOWS_TAILSCALE_URL)}>{t('remote.downloadWindows')}</Button>
          <Button size="sm" onClick={() => openGuide(ANDROID_TAILSCALE_URL)}>{t('remote.downloadAndroid')}</Button>
        </div>
      </div>
</Disclosure>
    </div>
  )
}
