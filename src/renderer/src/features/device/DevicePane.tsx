import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement, type WheelEvent } from 'react'
import { ArrowLeft, Circle, Power, RefreshCw, Square } from '../../ui/icons'
import { useT } from '../../i18n'
import { Button, CloseButton, EmptyState, IconButton, ListBoxItem, Notice, Select, Spinner, TextField } from '../../ui'
import type { AndroidControl, AndroidDevice } from '../../../../shared/android-sdk'
import { openSettingsDialog } from '../settings/root/deep-link'
import { PaneTitle, PaneTools, usePaneChrome } from '../workbench/pane-chrome'
import type { DevicePaneProps } from '../workbench/types'
import './device.css'

const POLL_MS = 3000
const BOOT_WAIT_MS = 60_000
const FRAME_WAIT_MS = 15_000

export function DevicePane({ visible = true }: DevicePaneProps): ReactElement {
  const t = useT()
  const [adbReady, setAdbReady] = useState<boolean | null>(null)
  const [avds, setAvds] = useState<string[]>([])
  const [devices, setDevices] = useState<AndroidDevice[]>([])
  const [serial, setSerial] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [bootingAt, setBootingAt] = useState<number | null>(null)
  const [bootTimedOut, setBootTimedOut] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState<{ text: string; settings: boolean } | null>(null)
  const [text, setText] = useState('')
  const [frameSlow, setFrameSlow] = useState(false)
  const [watchNonce, setWatchNonce] = useState(0)
  const press = useRef<{ pointer: number; frame: number; pending: { x: number; y: number } | null } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chrome = usePaneChrome()

  const refresh = useCallback(async () => {
    try {
      const status = await window.yan.android.status()
      const ready = status.components.some((component) => component.id === 'platformTools' && component.state === 'installed')
      setAdbReady(ready)
      setAvds(status.avds)
      if (!ready) return
      const list = await window.yan.android.devices()
      setDevices(list)
      if (list.some((device) => device.emulator && device.state === 'device')) setBootingAt(null)
      if (!list.some((device) => device.emulator && device.state !== 'device')) setBootTimedOut(false)
      setSerial((current) => (current && list.some((device) => device.serial === current && device.state === 'device') ? current : list.find((device) => device.state === 'device')?.serial ?? null))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    if (!visible) return undefined
    void refresh()
    const id = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(id)
  }, [visible, refresh])

  useEffect(() => {
    if (bootingAt === null) return undefined
    const id = window.setTimeout(() => {
      setBootingAt(null)
      setBootTimedOut(true)
      setActionError({ text: t('android.pane.bootTimeout', { s: Math.round(BOOT_WAIT_MS / 1000) }), settings: true })
    }, Math.max(0, bootingAt + BOOT_WAIT_MS - Date.now()))
    return () => window.clearTimeout(id)
  }, [bootingAt, t])

  useEffect(() => {
    if (!visible || !serial || live) {
      setFrameSlow(false)
      return undefined
    }
    const id = window.setTimeout(() => setFrameSlow(true), FRAME_WAIT_MS)
    return () => window.clearTimeout(id)
  }, [visible, serial, live, watchNonce])

  useEffect(() => {
    if (!visible || !serial) return undefined
    let decoder: VideoDecoder | null = null
    let codec = ''
    const close = (): void => {
      if (decoder && decoder.state !== 'closed') decoder.close()
      decoder = null
    }
    const draw = (image: VideoFrame): void => {
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (canvas && context) {
        if (canvas.width !== image.displayWidth) canvas.width = image.displayWidth
        if (canvas.height !== image.displayHeight) canvas.height = image.displayHeight
        context.drawImage(image, 0, 0)
        setLive(true)
      }
      image.close()
    }
    const off = window.yan.android.onFrame((frame) => {
      if (frame.serial !== serial) return
      if (frame.key && (!decoder || decoder.state === 'closed' || frame.codec !== codec)) {
        close()
        codec = frame.codec
        decoder = new VideoDecoder({ output: draw, error: close })
        decoder.configure({ codec, optimizeForLatency: true })
      }
      if (!decoder || decoder.state !== 'configured') return
      decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.sequence * 1000, data: frame.data }))
    })
    void window.yan.android.watch(serial)
    return () => {
      off()
      void window.yan.android.watch(null)
      close()
      setLive(false)
    }
  }, [visible, serial, watchNonce])

  useEffect(() => {
    setActionError(null)
  }, [serial])

  const deviceKey = devices.map((device) => `${device.serial}:${device.state}`).join(',')
  useEffect(() => {
    setActionError((current) => (current?.settings ? null : current))
  }, [deviceKey])

  const send = useCallback((action: AndroidControl): Promise<boolean> => {
    if (!serial) return Promise.resolve(false)
    setActionError(null)
    return window.yan.android.control(serial, action).then(
      () => true,
      (cause: unknown) => {
        setActionError({ text: cause instanceof Error ? cause.message : String(cause), settings: false })
        return false
      }
    )
  }, [serial])

  const boot = (avd: string): void => {
    setActionError(null)
    setBootingAt(Date.now())
    setBootTimedOut(false)
    void window.yan.android.boot(avd).then(refresh, (cause: unknown) => {
      setBootingAt(null)
      setActionError({ text: cause instanceof Error ? cause.message : String(cause), settings: true })
    })
  }

  const stateLabel = (state: string): string =>
    state === 'unauthorized' ? t('android.pane.state.unauthorized') : state === 'offline' ? t('android.pane.state.offline') : state

  const point = (event: PointerEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return null
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    const at = point(event)
    if (!at || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { pointer: event.pointerId, frame: 0, pending: null }
    void send({ kind: 'touch', phase: 'down', ...at })
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const touch = press.current
    const at = point(event)
    if (!touch || touch.pointer !== event.pointerId || !at) return
    touch.pending = at
    if (touch.frame) return
    touch.frame = requestAnimationFrame(() => {
      touch.frame = 0
      if (press.current !== touch || !touch.pending) return
      void send({ kind: 'touch', phase: 'move', ...touch.pending })
      touch.pending = null
    })
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const touch = press.current
    if (!touch || touch.pointer !== event.pointerId) return
    press.current = null
    if (touch.frame) cancelAnimationFrame(touch.frame)
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    void send({ kind: 'touch', phase: 'up', x, y })
  }

  const onWheel = (event: WheelEvent<HTMLCanvasElement>): void => {
    const at = point(event)
    if (!at) return
    const distance = event.deltaY > 0 ? -0.3 : 0.3
    void send({ kind: 'swipe', x: at.x, y: at.y, toX: at.x, toY: Math.max(0.02, Math.min(0.98, at.y + distance)), ms: 200 })
  }

  const online = devices.filter((device) => device.state === 'device')
  const pending = devices.filter((device) => device.state !== 'device' && !device.emulator)
  const stuck = bootTimedOut ? devices.filter((device) => device.state !== 'device' && device.emulator) : []
  const starting = bootingAt !== null || (!bootTimedOut && devices.some((device) => device.emulator && device.state !== 'device'))
  const emulatorUp = starting || online.some((device) => device.emulator)

  const actionNotice = actionError ? (
    <Notice
      tone="fail"
      compact
      className="device-pane__error"
      role="alert"
      data-testid="device-pane-action-error"
      action={
        <span className="device-pane__error-actions">
          {actionError.settings ? (
            <Button size="sm" variant="secondary" onPress={() => openSettingsDialog('android')}>{t('android.pane.openSettings')}</Button>
          ) : null}
          <CloseButton size="sm" aria-label={t('android.pane.dismiss')} onPress={() => setActionError(null)} />
        </span>
      }
    >
      {actionError.text}
    </Notice>
  ) : null

  const deviceSelect = online.length ? (
    <Select
      aria-label={t('android.pane.device')}
      className="device-pane__select"
      selectedKey={serial}
      onSelectionChange={(key) => setSerial(String(key))}
    >
      {online.map((device) => (
        <ListBoxItem key={device.serial} id={device.serial}>
          {device.model ? `${device.model} · ${device.serial}` : device.serial}
        </ListBoxItem>
      ))}
    </Select>
  ) : null

  const deviceActions = (
    <>
      <IconButton size="sm" aria-label={t('android.pane.refresh')} tooltip={t('android.pane.refresh')} onPress={() => void refresh()}><RefreshCw size={14} aria-hidden /></IconButton>
      <IconButton size="sm" aria-label={t('android.pane.wake')} tooltip={t('android.pane.wake')} isDisabled={!serial} onPress={() => void send({ kind: 'key', key: 'wake' })}><Power size={14} aria-hidden /></IconButton>
    </>
  )

  return (
    <div className="device-pane" data-testid="device-pane">
      {chrome ? (
        <>
          <PaneTitle>{deviceSelect}</PaneTitle>
          <PaneTools>{deviceActions}</PaneTools>
        </>
      ) : (
        <div className="device-pane__bar">
          {deviceSelect}
          <span className="device-pane__spacer" />
          {deviceActions}
        </div>
      )}

      {adbReady === false ? (
        <EmptyState
          className="device-pane__empty"
          data-testid="device-pane-no-adb"
          title={t('android.pane.noAdb')}
          description={t('android.pane.noAdbBody')}
          action={<Button onPress={() => openSettingsDialog('android')}>{t('android.pane.openSettings')}</Button>}
        />
      ) : null}

      {adbReady === false ? null : serial ? (
        <>
          <div className="device-pane__screen">
            <canvas
              ref={canvasRef}
              className="device-pane__frame"
              role="img"
              aria-label={t('android.pane.screen')}
              hidden={!live}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            />
            {live ? null : frameSlow ? (
              <div className="device-pane__slow" role="status" data-testid="device-pane-frame-slow">
                <p className="device-pane__hint">{t('android.pane.frameSlow')}</p>
                <Button size="sm" variant="secondary" icon={<RefreshCw size={14} aria-hidden />} onPress={() => setWatchNonce((value) => value + 1)}>{t('android.pane.retry')}</Button>
              </div>
            ) : (
              <p className="device-pane__hint" role="status"><Spinner size="sm" />{t('android.pane.connecting')}</p>
            )}
          </div>
          <div className="device-pane__bar device-pane__bar--bottom">
            <IconButton size="sm" aria-label={t('android.pane.back')} tooltip={t('android.pane.back')} onPress={() => void send({ kind: 'key', key: 'back' })}><ArrowLeft size={14} aria-hidden /></IconButton>
            <IconButton size="sm" aria-label={t('android.pane.home')} tooltip={t('android.pane.home')} onPress={() => void send({ kind: 'key', key: 'home' })}><Circle size={14} aria-hidden /></IconButton>
            <IconButton size="sm" aria-label={t('android.pane.recents')} tooltip={t('android.pane.recents')} onPress={() => void send({ kind: 'key', key: 'recents' })}><Square size={14} aria-hidden /></IconButton>
            <form
              className="device-pane__type"
              onSubmit={(event) => {
                event.preventDefault()
                if (!text) return
                const sent = text
                void send({ kind: 'text', text: sent }).then((ok) => {
                  if (ok) setText((current) => (current === sent ? '' : current))
                })
              }}
            >
              <TextField aria-label={t('android.pane.type')} placeholder={t('android.pane.type')} value={text} onChange={setText} />
            </form>
          </div>
        </>
      ) : null}
      {adbReady === false || serial ? null : (
        <EmptyState
          className="device-pane__empty"
          data-testid="device-pane-empty"
          icon={starting ? <Spinner size="sm" /> : undefined}
          title={starting ? t('android.pane.starting') : pending.length ? t('android.pane.waitAuth') : stuck.length ? t('android.pane.emulatorOffline') : t('android.pane.noDevice')}
          description={starting ? t('android.pane.startingBody') : !pending.length && stuck.length ? t('android.pane.emulatorOfflineBody', { list: stuck.map((device) => `${device.serial} · ${stateLabel(device.state)}`).join(', ') }) : pending.length ? t('android.pane.unauthorized', { list: pending.map((device) => (device.state === 'unauthorized' ? device.serial : `${device.serial}（${stateLabel(device.state)}）`)).join('、') }) : t('android.pane.noDeviceBody')}
          action={
            emulatorUp ? actionNotice : avds.length ? (
              <div className="device-pane__avds">
                {avds.map((avd) => (
                  <Button key={avd} variant="secondary" onPress={() => boot(avd)}>
                    {t('android.pane.boot', { name: avd })}
                  </Button>
                ))}
                {actionNotice}
              </div>
            ) : (
              <Button variant="secondary" onPress={() => openSettingsDialog('android')}>{t('android.pane.openSettings')}</Button>
            )
          }
        />
      )}
      {serial ? actionNotice : null}
      {error ? <Notice tone="fail" compact className="device-pane__error" data-testid="device-pane-error">{error}</Notice> : null}
    </div>
  )
}
