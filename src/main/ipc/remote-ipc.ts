/**
 * 设置 · 手机接入 的 IPC 适配（`yan:remote:*`）。
 *
 * 开关、监听地址与端口写进设置后立即生效；配对码与设备撤销只在内存 / 设备表里处理，
 * 不经过设置文件（令牌哈希不应出现在普通设置里）。
 */
import type { AppSettings } from '../../shared/ipc'
import type { RemoteAccessSettings, RemoteAccessStatus } from '../../shared/remote-protocol'
import type { RemoteAccess } from '../remote-access'
import type { IpcRegistrar } from './registrar'

export interface RemoteIpcDeps {
  access(): RemoteAccess | null
  /** 远程访问对象还没建时先建好（首次打开设置页时可能还没启动过） */
  ensureStarted(): Promise<void>
  saveSettings(remote: RemoteAccessSettings): Promise<AppSettings>
}

export function registerRemoteIpc(ipc: IpcRegistrar, deps: RemoteIpcDeps): void {
  const { handle } = ipc
  const status = async (): Promise<RemoteAccessStatus | null> => {
    if (!deps.access()) await deps.ensureStarted()
    return (await deps.access()?.status()) ?? null
  }

  handle('yan:remote:status', status)

  handle('yan:remote:configure', async (remote: RemoteAccessSettings) => {
    const saved = await deps.saveSettings(remote)
    if (!deps.access()) await deps.ensureStarted()
    else await deps.access()?.apply(saved.remoteAccess)
    return status()
  })

  handle('yan:remote:pair', async () => {
    if (!deps.access()) await deps.ensureStarted()
    const access = deps.access()
    if (!access) return null
    const current = await access.status()
    /* 服务没在监听时生成配对码没有意义：手机连不上，码只会白白过期 */
    if (!current.running) return current
    access.startPairing()
    return access.status()
  })

  handle('yan:remote:cancelPairing', async () => {
    deps.access()?.cancelPairing()
    return status()
  })

  handle('yan:remote:revoke', async (deviceId: string) => {
    await deps.access()?.revoke(String(deviceId ?? ''))
    return status()
  })

  handle('yan:remote:forget', async (deviceId: string) => {
    await deps.access()?.forget(String(deviceId ?? ''))
    return status()
  })
}
