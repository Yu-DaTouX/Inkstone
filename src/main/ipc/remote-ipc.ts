import type { AppSettings } from '../../shared/ipc'
import type { RemoteAccessSettings, RemoteAccessStatus } from '../../shared/remote-protocol'
import type { RemoteAccess } from '../remote-access'
import type { IpcRegistrar } from './registrar'

export interface RemoteIpcDeps {
  access(): RemoteAccess | null
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

  handle('yan:remote:relayPair', async (kind: unknown) => {
    if (!deps.access()) await deps.ensureStarted()
    await deps.access()?.relayPair(kind === 'agent' ? 'agent' : 'phone')
    return status()
  })

  handle('yan:remote:relayCancel', async () => {
    deps.access()?.cancelRelayPairing()
    return status()
  })

  handle('yan:remote:relayRevoke', async (id: string) => {
    await deps.access()?.relayRevoke(String(id ?? ''))
    return status()
  })

  handle('yan:remote:relayForget', async (id: string) => {
    await deps.access()?.relayForget(String(id ?? ''))
    return status()
  })

  handle('yan:remote:forget', async (deviceId: string) => {
    await deps.access()?.forget(String(deviceId ?? ''))
    return status()
  })
}
