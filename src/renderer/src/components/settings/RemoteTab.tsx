import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useT } from '../../i18n'
import { Badge, Button, EmptyState, Segmented, Switch } from '../ui'
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  type RemoteAccessSettings,
  type RemoteAccessStatus
} from '../../../../shared/remote-protocol'
import { useStore } from '../../state/store'

type BindChoice = 'tailscale' | 'loopback' | 'custom'
const WINDOWS_TAILSCALE_URL = 'https://tailscale.com/download/windows'
const ANDROID_TAILSCALE_URL = 'https://tailscale.com/download/android'
const MOBILE_GUIDE_URL = 'https://github.com/Yu-DaTouX/Inkstone/blob/main/docs/MOBILE_ACCESS.md'

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

/**
 * 设置 · 手机接入。
 *
 * 需求稿第 3 步：手机查看电脑上的任务、回复问题、发送文字；任务仍在这台电脑执行。
 * 这一页只管「谁能连、从哪连」：开关与监听地址、配对新手机、已配对设备与撤销。
 * 令牌只在手机配对那一刻交给手机，这一页永远看不到令牌本身。
 */
export function RemoteTab() {
  const t = useT()
  const saved = useStore((s) => s.settings?.remoteAccess) ?? DEFAULT_REMOTE_ACCESS_SETTINGS
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [draft, setDraft] = useState<RemoteAccessSettings>(saved)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.yan.remote.status())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    return () => window.clearInterval(interval)
  }, [refresh])

  /* 配对码倒计时；到期后刷新一次状态（码已作废） */
  useEffect(() => {
    if (!status?.pairing) return undefined
    const id = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (status.pairing && current >= status.pairing.expiresAt) void refresh()
    }, 1000)
    return () => window.clearInterval(id)
  }, [status?.pairing, refresh])

  const run = async (action: () => Promise<RemoteAccessStatus | null>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await action())
    } finally {
      setBusy(false)
    }
  }

  const configure = (next: RemoteAccessSettings): Promise<void> => {
    setDraft(next)
    return run(async () => {
      const result = await window.yan.remote.configure(next)
      /* 设置已由主进程落盘；让 store 里的副本跟上，避免下次打开这一页读到旧值 */
      useStore.setState({ settings: await window.yan.getSettings() })
      return result
    })
  }

  const choice = bindChoiceOf(draft.bind)
  const endpoint = status?.running ? `${status.host}:${status.port}` : null
  const pairingLink = status?.pairing && endpoint
    ? `inkstone://pair?address=${encodeURIComponent(`http://${endpoint}`)}&code=${status.pairing.code}`
    : null
  const secondsLeft = status?.pairing ? Math.max(0, Math.ceil((status.pairing.expiresAt - now) / 1000)) : 0
  const activeDevices = status?.devices.filter((device) => device.revokedAt === null) ?? []
  const revokedDevices = status?.devices.filter((device) => device.revokedAt !== null) ?? []

  return (
    <div className="set-group" data-testid="settings-remote">
      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('remote.setupTitle')}</div>
          <div className="set-desc">{t('remote.setupDesc')}</div>
        </div>
        <div className="btn-row">
          <Button size="sm" onClick={() => openGuide(WINDOWS_TAILSCALE_URL)}>{t('remote.downloadWindows')}</Button>
          <Button size="sm" onClick={() => openGuide(ANDROID_TAILSCALE_URL)}>{t('remote.downloadAndroid')}</Button>
        </div>
      </div>
      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('remote.enable')}</div>
          <div className="set-desc">{t('remote.enableDesc')}</div>
        </div>
        <div className="set-ctl">
          <Switch
            checked={draft.enabled}
            label={t('remote.enable')}
            disabled={busy}
            testId="remote-enable"
            onChange={(enabled) => void configure({ ...draft, enabled })}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('remote.bind')}</div>
          <div className="set-desc">{t('remote.bindDesc')}</div>
        </div>
        <div className="set-ctl">
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
        </div>
      </div>

      {choice === 'custom' ? (
        <div className="set-row">
          <div className="set-label">
            <div className="set-name">{t('remote.customAddress')}</div>
            <div className="set-desc">{t('remote.customAddressDesc')}</div>
          </div>
          <div className="set-ctl">
            <input
              className="set-input remote-address-input"
              value={draft.bind}
              placeholder="192.168.1.20"
              data-testid="remote-custom-address"
              onChange={(e) => setDraft({ ...draft, bind: e.target.value.trim() })}
              onBlur={() => void configure(draft)}
            />
          </div>
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('remote.port')}</div>
          <div className="set-desc">{t('remote.portDesc')}</div>
        </div>
        <div className="set-ctl">
          <input
            className="set-input"
            inputMode="numeric"
            value={String(draft.port)}
            data-testid="remote-port"
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
            onBlur={() => void configure(draft)}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('remote.status')}</div>
          <div className="set-desc" data-testid="remote-status">
            {status?.running ? (
              <>
                <Badge tone="ok">{t('remote.running')}</Badge> <span className="set-path">{endpoint}</span>
              </>
            ) : (
              <Badge>{t('remote.stopped')}</Badge>
            )}
            {status?.error ? <div className="set-warn">{status.error}</div> : null}
          </div>
        </div>
      </div>

      <div className="set-row col" data-testid="remote-pairing">
        <div className="set-label">
          <div className="set-name">{t('remote.pairTitle')}</div>
          <div className="set-desc">{t('remote.pairDesc')}</div>
        </div>
        <div className="btn-row">
          <Button size="sm" data-testid="remote-guide" onClick={() => openGuide(MOBILE_GUIDE_URL)}>{t('remote.guide')}</Button>
        </div>
        {status?.pairing && secondsLeft > 0 ? (
          <div className="remote-pairing">
            <div className="remote-pairing-layout">
              {pairingLink ? (
                <div className="remote-pairing-qr" aria-label="手机配对二维码">
                  <QRCodeSVG value={pairingLink} size={180} level="M" marginSize={2} />
                </div>
              ) : null}
              <div className="remote-pairing-detail">
                <div className="remote-pairing-code" data-testid="remote-pairing-code">{status.pairing.code}</div>
                <div className="set-desc">
                  {t('remote.pairAddress', { address: endpoint ?? '—' })}
                  <br />
                  {t('remote.pairExpires', { seconds: secondsLeft })}
                </div>
                <div className="set-desc">{t('remote.scanHint')}</div>
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
            {!status?.running ? <span className="set-desc">{t('remote.pairNeedsRunning')}</span> : null}
          </div>
        )}
      </div>

      <div className="set-row col" data-testid="remote-devices">
        <div className="set-label">
          <div className="set-name">{t('remote.devices')}</div>
          <div className="set-desc">{t('remote.devicesDesc')}</div>
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
                  <span className="set-desc">
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
                  <span className="set-desc">{t('remote.revokedAt', { time: formatTime(device.revokedAt, '—') })}</span>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.yan.remote.forget(device.id))}>
                  {t('remote.forget')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
