import { launchAntigravity, type AntigravitySession } from '../antigravity'
import { antigravityQuota } from '../antigravity-quota'
import type { IpcRegistrar } from './registrar'
import type { AntigravityModels } from '../../shared/antigravity'

export function registerAntigravityIpc(ipc: IpcRegistrar, resolveCwd: (cwd: string) => Promise<string>): () => Promise<void> {
  ipc.handle('yan:antigravity:quota', (force) => antigravityQuota(force === true))
  const probes = new Map<string, Promise<AntigravityModels>>()
  const active = new Set<AntigravitySession>()
  ipc.handle('yan:antigravity:discover', async (cwd) => {
    const directory = await resolveCwd(cwd)
    const pending = probes.get(directory)
    if (pending) return pending
    const session = launchAntigravity(directory)
    active.add(session)
    const probe = session.start(directory, undefined, { discoverOnly: true }).finally(async () => {
      try { await session.close() } finally {
        active.delete(session)
        probes.delete(directory)
      }
    })
    probes.set(directory, probe)
    return probe
  })
  return async () => {
    await Promise.allSettled([...active].map((session) => session.close()))
  }
}
