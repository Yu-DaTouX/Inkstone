import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement, type WheelEvent } from 'react'
import { ArrowLeft, Circle, Power, RefreshCw, Square } from 'lucide-react'
import { useT } from '../../i18n'
import { Button, EmptyState, IconButton, ListBoxItem, Select, TextField } from '../../ui'
import type { AndroidControl, AndroidDevice } from '../../../../shared/android-sdk'
import { openSettingsDialog } from '../settings/root/deep-link'
import type { DevicePaneProps } from '../workbench/types'
import './device.css'

const POLL_MS = 3000
const TAP_DISTANCE = 0.015

export function DevicePane({ visible = true }: DevicePaneProps): ReactElement {
  const t = useT()
  const [adbReady, setAdbReady] = useState<boolean | null>(null)
  const [avds, setAvds] = useState<string[]>([])
  const [devices, setDevices] = useState<AndroidDevice[]>([])
  const [serial, setSerial] = useState<string | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const press = useRef<{ x: number; y: number; at: number } | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const status = await window.yan.android.status()
      const ready = status.components.some((component) => component.id === 'platformTools' && component.state === 'installed')
      setAdbReady(ready)
      setAvds(status.avds)
      if (!ready) return
      const list = await window.yan.android.devices()
      setDevices(list)
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
    if (!visible || !serial) return undefined
    let url: string | null = null
    const off = window.yan.android.onFrame((frame) => {
      if (frame.serial !== serial) return
      const next = URL.createObjectURL(new Blob([frame.png as BlobPart], { type: 'image/png' }))
      setFrameUrl(next)
      if (url) URL.revokeObjectURL(url)
      url = next
    })
    void window.yan.android.watch(serial)
    return () => {
      off()
      void window.yan.android.watch(null)
      if (url) URL.revokeObjectURL(url)
      setFrameUrl(null)
    }
  }, [visible, serial])

  const send = useCallback((action: AndroidControl) => {
    if (!serial) return
    window.yan.android.control(serial, action).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [serial])

  const point = (event: PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>): { x: number; y: number } | null => {
    const rect = imageRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return null
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  const onPointerDown = (event: PointerEvent<HTMLImageElement>): void => {
    const at = point(event)
    if (!at) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { ...at, at: performance.now() }
  }

  const onPointerUp = (event: PointerEvent<HTMLImageElement>): void => {
    const start = press.current
    press.current = null
    const end = point(event)
    if (!start || !end) return
    if (Math.hypot(end.x - start.x, end.y - start.y) < TAP_DISTANCE) send({ kind: 'tap', x: start.x, y: start.y })
    else send({ kind: 'swipe', x: start.x, y: start.y, toX: end.x, toY: end.y, ms: Math.min(1500, Math.max(120, performance.now() - start.at)) })
  }

  const onWheel = (event: WheelEvent<HTMLImageElement>): void => {
    const at = point(event)
    if (!at) return
    const distance = event.deltaY > 0 ? -0.3 : 0.3
    send({ kind: 'swipe', x: at.x, y: at.y, toX: at.x, toY: Math.max(0.02, Math.min(0.98, at.y + distance)), ms: 200 })
  }

  if (adbReady === false) {
    return (
      <EmptyState
        className="device-pane__empty"
        data-testid="device-pane-no-adb"
        title={t('android.pane.noAdb')}
        description={t('android.pane.noAdbBody')}
        action={<Button onPress={() => openSettingsDialog('android')}>{t('android.pane.openSettings')}</Button>}
      />
    )
  }

  const online = devices.filter((device) => device.state === 'device')
  const pending = devices.filter((device) => device.state !== 'device')
  const running = new Set(online.filter((device) => device.emulator).map((device) => device.serial))

  return (
    <div className="device-pane" data-testid="device-pane">
      <div className="device-pane__bar">
        {online.length ? (
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
        ) : null}
        <span className="device-pane__spacer" />
        <IconButton aria-label={t('android.pane.refresh')} onPress={() => void refresh()}><RefreshCw size={15} aria-hidden /></IconButton>
        <IconButton aria-label={t('android.pane.wake')} isDisabled={!serial} onPress={() => send({ kind: 'key', key: 'wake' })}><Power size={15} aria-hidden /></IconButton>
      </div>

      {serial ? (
        <>
          <div className="device-pane__screen">
            {frameUrl ? (
              <img
                ref={imageRef}
                className="device-pane__frame"
                src={frameUrl}
                alt={t('android.pane.screen')}
                draggable={false}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onWheel={onWheel}
              />
            ) : (
              <p className="device-pane__hint">{t('android.pane.connecting')}</p>
            )}
          </div>
          <div className="device-pane__bar device-pane__bar--bottom">
            <IconButton aria-label={t('android.pane.back')} onPress={() => send({ kind: 'key', key: 'back' })}><ArrowLeft size={15} aria-hidden /></IconButton>
            <IconButton aria-label={t('android.pane.home')} onPress={() => send({ kind: 'key', key: 'home' })}><Circle size={15} aria-hidden /></IconButton>
            <IconButton aria-label={t('android.pane.recents')} onPress={() => send({ kind: 'key', key: 'recents' })}><Square size={15} aria-hidden /></IconButton>
            <form
              className="device-pane__type"
              onSubmit={(event) => {
                event.preventDefault()
                if (!text) return
                send({ kind: 'text', text })
                setText('')
              }}
            >
              <TextField aria-label={t('android.pane.type')} placeholder={t('android.pane.type')} value={text} onChange={setText} />
            </form>
          </div>
        </>
      ) : (
        <EmptyState
          className="device-pane__empty"
          data-testid="device-pane-empty"
          title={t('android.pane.noDevice')}
          description={pending.length ? t('android.pane.unauthorized', { list: pending.map((device) => `${device.serial}（${device.state}）`).join('、') }) : t('android.pane.noDeviceBody')}
          action={
            avds.filter((avd) => !running.has(avd)).length ? (
              <div className="device-pane__avds">
                {avds.map((avd) => (
                  <Button key={avd} variant="secondary" onPress={() => void window.yan.android.boot(avd).then(refresh, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>
                    {t('android.pane.boot', { name: avd })}
                  </Button>
                ))}
              </div>
            ) : (
              <Button variant="secondary" onPress={() => openSettingsDialog('android')}>{t('android.pane.openSettings')}</Button>
            )
          }
        />
      )}
      {error ? <p className="device-pane__error" role="alert">{error}</p> : null}
    </div>
  )
}
