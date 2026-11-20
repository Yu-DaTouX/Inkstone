import { launchAntigravity } from '../antigravity'
import { antigravityQuota } from '../antigravity-quota'
import type { IpcRegistrar } from './registrar'
import type { AntigravityModels } from '../../shared/antigravity'

export function registerAntigravityIpc(ipc: IpcRegistrar, resolveCwd: (cwd: string) => Promise<string>): void {
  ipc.handle('yan:antigravity:quota', (force) => antigravityQuota(force === true))
  const probes = new Map<string, Promise<AntigravityModels>>()
  ipc.handle('yan:antigravity:discover', async (cwd) => {
    const directory = await resolveCwd(cwd)
    const pending = probes.get(directory)
    if (pending) return pending
    const session = launchAntigravity(directory)
    const probe = session.start(directory, undefined, { discoverOnly: true }).finally(async () => {
      try { await session.close() } finally { probes.delete(directory) }
    })
    probes.set(directory, probe)
    return probe
  })
}
