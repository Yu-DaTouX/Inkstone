import { shell, type BrowserWindow } from 'electron'
import { ANDROID_COMPONENTS, type AndroidComponentId, type AndroidControl } from '../../shared/android-sdk'
import { AndroidDeviceService } from '../android/android-devices'
import { AndroidSdkService } from '../android/android-sdk'
import { resolveSdkRoot } from '../android/android-paths'
import type { IpcRegistrar } from './registrar'

function isComponent(value: unknown): value is AndroidComponentId {
  return typeof value === 'string' && (ANDROID_COMPONENTS as string[]).includes(value)
}

function isControl(value: unknown): value is AndroidControl {
  const raw = value as { kind?: unknown } | null
  return !!raw && ['touch', 'tap', 'swipe', 'key', 'text'].includes(String(raw.kind))
}

export function registerAndroidIpc(ipc: IpcRegistrar, window: () => BrowserWindow | null): void {
  const { handle } = ipc
  const sdk = new AndroidSdkService()
  const devices = new AndroidDeviceService((frame) => {
    const win = window()
    if (win && !win.isDestroyed()) win.webContents.send('yan:android-frame', frame)
  })
  handle('yan:android:status', () => sdk.status())
  handle('yan:android:install', (ids: unknown) => sdk.install(Array.isArray(ids) ? ids.filter(isComponent) : []))
  handle('yan:android:cancel', () => sdk.cancel())
  handle('yan:android:openSdkDir', () => shell.openPath(resolveSdkRoot().root))
  handle('yan:android:devices', () => devices.devices())
  handle('yan:android:boot', (avd: unknown) => devices.boot(String(avd ?? '')))
  handle('yan:android:watch', (serial: unknown) => (typeof serial === 'string' && serial ? devices.watch(serial) : devices.unwatch()))
  handle('yan:android:control', (serial: unknown, action: unknown) => {
    if (typeof serial !== 'string' || !isControl(action)) throw new Error('设备操作无效')
    return devices.control(serial, action)
  })
}
