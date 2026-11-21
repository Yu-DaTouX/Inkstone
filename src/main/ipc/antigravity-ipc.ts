import { resolve } from 'node:path'
import { launchAntigravity } from '../antigravity'
import { antigravityQuota } from '../antigravity-quota'
import type { IpcRegistrar } from './registrar'
import type { AntigravityModels } from '../../shared/antigravity'
import { pick } from '../../shared/ui-lang'

export function createAntigravityDiscoveryProbes(resolveCwd: (cwd: string) => Promise<string>, launch: typeof launchAntigravity = launchAntigravity) {
  const probes = new Map<string, { result: Promise<AntigravityModels>; session: ReturnType<typeof launchAntigravity> }>()
  const closedError = () => new Error(pick('Antigravity 模型检测已关闭。', 'Antigravity model discovery is closed.'))
  let disposed = false
  return {
    async discover(cwd: string): Promise<AntigravityModels> {
      if (disposed) throw closedError()
      const directory = await resolveCwd(cwd)
      if (disposed) throw closedError()
      const path = resolve(directory)
      const key = process.platform === 'win32' ? path.toLowerCase() : path
      const pending = probes.get(key)
      if (pending) return pending.result
      if (probes.size >= 4) throw new Error(pick('正在检测其他项目的 Antigravity 模型，请稍后重试。', 'Antigravity is checking other projects. Try again shortly.'))
      const session = launch(directory)
      const result = session.start(directory, undefined, { discoverOnly: true }).finally(async () => {
        try { await session.close() } finally { probes.delete(key) }
      }).then((models) => {
        if (disposed) throw closedError()
        return models
      })
      probes.set(key, { result, session })
      return result
    },
    async dispose(): Promise<void> {
      disposed = true
      await Promise.allSettled([...probes.values()].map(async ({ session }) => { await session.close() }))
    }
  }
}

export function registerAntigravityIpc(ipc: IpcRegistrar, resolveCwd: (cwd: string) => Promise<string>): () => Promise<void> {
  const probes = createAntigravityDiscoveryProbes(resolveCwd)
  ipc.handle('yan:antigravity:quota', (force) => antigravityQuota(force === true))
  ipc.handle('yan:antigravity:discover', probes.discover)
  return probes.dispose
}
