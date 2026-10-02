import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useT } from '../../i18n'
import { Badge, Button, EmptyState, Input, SettingRow, Switch } from '../ui'
import type { RemoteAccessSettings, RemoteAccessStatus, RemoteRelaySettings } from '../../../../shared/remote-protocol'

/**
 * 设置 · 手机接入 · 中继接入：砚主动连中继，手机端与礁石经端到端加密隧道连进来（不用 Tailscale、不开端口）。
 * 开关与地址写进 remoteAccess.relay；配对链接与设备撤销只在主进程内存 / 中继设备表里处理。
 */
export function RelaySection({ draft, status, busy, configure, run }: {
  draft: RemoteAccessSettings
  status: RemoteAccessStatus | null
  busy: boolean
  configure(next: RemoteAccessSettings): Promise<void>
  run(action: () => Promise<RemoteAccessStatus | null>): Promise<void>
}) {
  const t = useT()
  const relay: RemoteRelaySettings = draft.relay ?? { enabled: false, url: '' }
  const [url, setUrl] = useState(relay.url)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const state = status?.relay
  const pairing = state?.pairing ?? null
  useEffect(() => setUrl(relay.url), [relay.url])
  useEffect(() => setCopied(false), [pairing?.link])
  useEffect(() => {
    if (!pairing) return undefined
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pairing])

  const save = (next: RemoteRelaySettings): Promise<void> => configure({ ...draft, relay: next })
  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  const clients = state?.clients ?? []
  const active = clients.filter((c) => c.revokedAt === null)
  const revoked = clients.filter((c) => c.revokedAt !== null)

  return (
    <>
      <SettingRow name={t('remote.relay')} desc={t('remote.relayDesc')}>
        <Switch
          checked={relay.enabled}
          label={t('remote.relay')}
          disabled={busy || (!relay.enabled && !url.trim())}
          testId="remote-relay-enable"
          onChange={(enabled) => void save({ enabled, url: url.trim() })}
        />
      </SettingRow>
      <SettingRow name={t('remote.relayUrl')} desc={t('remote.relayUrlDesc')}>
        <Input
          className="remote-address-input"
          value={url}
          placeholder="https://reef-relay.example.workers.dev"
          data-testid="remote-relay-url"
          onChange={(e) => setUrl(e.target.value.trim())}
          onBlur={() => { if (url !== relay.url) void save({ enabled: relay.enabled && !!url, url }) }}
        />
      </SettingRow>
      {relay.enabled ? (
        <div className="ui-row col" data-testid="remote-relay">
          <div className="ui-row-label">
            <div className="ui-row-name">{t('remote.relayStatus')}</div>
            <div className="ui-row-desc">
              {state?.connected ? <Badge tone="ok">{t('remote.relayConnected')}</Badge> : <Badge tone="warn">{state?.detail ?? t('remote.relayConnecting')}</Badge>}
            </div>
          </div>
          {pairing ? (
            <div className="remote-pairing">
              <div className="remote-pairing-layout">
                {pairing.kind === 'phone' ? (
                  <div className="remote-pairing-qr" aria-label={t('remote.relayQr')} data-testid="remote-relay-qr">
                    <QRCodeSVG value={pairing.link} size={180} level="M" marginSize={2} />
                  </div>
                ) : null}
                <div className="remote-pairing-detail">
                  <div className="ui-row-desc">{pairing.kind === 'agent' ? t('remote.relayAgentHint') : t('remote.relayPhoneHint')}</div>
                  <div className="ui-row-desc">{t('remote.relayExpires', { seconds: secondsLeft })}</div>
                  <Button size="sm" data-testid="remote-relay-copy" onClick={() => { void navigator.clipboard.writeText(pairing.link).then(() => setCopied(true)).catch(() => setCopied(false)) }}>
                    {copied ? t('remote.relayCopied') : t('remote.relayCopy')}
                  </Button>
                </div>
              </div>
              <div className="btn-row">
                <Button size="sm" disabled={busy} onClick={() => void run(() => window.yan.remote.relayCancel())}>{t('remote.pairCancel')}</Button>
              </div>
            </div>
          ) : (
            <div className="btn-row">
              <Button size="sm" disabled={busy || !state?.connected} data-testid="remote-relay-pair-phone" onClick={() => void run(() => window.yan.remote.relayPair('phone'))}>{t('remote.relayPairPhone')}</Button>
              <Button size="sm" disabled={busy || !state?.connected} data-testid="remote-relay-pair-agent" onClick={() => void run(() => window.yan.remote.relayPair('agent'))}>{t('remote.relayPairAgent')}</Button>
            </div>
          )}
          {active.length === 0 && revoked.length === 0 ? (
            <EmptyState>{t('remote.relayNoClients')}</EmptyState>
          ) : (
            <ul className="remote-device-list">
              {active.map((c) => (
                <li key={c.id} className="remote-device" data-testid="remote-relay-client">
                  <div className="remote-device-main">
                    <span className="remote-device-name">{c.name}</span>
                    <Badge tone={c.kind === 'agent' ? 'accent' : 'neutral'}>{c.kind === 'agent' ? t('remote.kindAgent') : t('remote.kindPhone')}</Badge>
                    {c.online ? <Badge tone="ok">{t('remote.relayOnline')}</Badge> : null}
                  </div>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => window.yan.remote.relayRevoke(c.id))}>{t('remote.revoke')}</Button>
                </li>
              ))}
              {revoked.map((c) => (
                <li key={c.id} className="remote-device revoked">
                  <div className="remote-device-main"><span className="remote-device-name">{c.name}</span></div>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.yan.remote.relayForget(c.id))}>{t('remote.forget')}</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  )
}
