import type { IpcRegistrar } from './registrar'
import { defaultWorkMode, workModeKeyFor, resolveWorkMode } from '../work-mode-coordinator'
import { normalizeSessionFileKey, sameWorkModeIdentity, writeWorkModeSnapshot } from '../work-mode-service'
import { normalizeWorkMode } from '../../shared/work-mode'
import type { WorkMode, WorkModeState } from '../../shared/work-mode'
import type { RunnerRegistry } from '../runners'
import type { WorkModeStore } from '../work-mode-service'
import type { MainPush } from '../../shared/ipc'

export interface WorkModeIpcDeps {
  registry(): RunnerRegistry | null
  workModes: WorkModeStore
  pushFrom(runnerId: string, msg: MainPush): void
}

export function registerWorkModeIpc(ipc: IpcRegistrar, deps: WorkModeIpcDeps): void {
  const { handle } = ipc
  const { registry, workModes, pushFrom } = deps
  handle('yan:getWorkMode', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { mode: defaultWorkMode(), revision: 0 } satisfies WorkModeState
    return resolveWorkMode(id)
  })
  handle('yan:setWorkMode', async (mode: WorkMode, expectedRevision?: number) => {
    const id = registry()?.activeRunner()?.id
    if (!id) {
      return { ok: false, state: { mode: normalizeWorkMode(mode), revision: 0 }, error: 'pi 未运行' }
    }
    const captureIdentity = () => {
      const session = registry()?.agentOf(id)?.getState()
      const runtime = registry()?.runtimeOf(id)
      return {
        id,
        generation: runtime?.generation,
        sessionId: session?.sessionId,
        sessionFile: session?.sessionFile
      }
    }
    await workModes.load()
    const identity = captureIdentity()
    const key = workModeKeyFor(id)
    const guard = () => sameWorkModeIdentity(identity, captureIdentity()) && workModeKeyFor(id) === key
    const res = await workModes.set(key, mode, expectedRevision)
    const sessionFile = normalizeSessionFileKey(identity.sessionFile) ?? undefined
    await writeWorkModeSnapshot(id, res.state, undefined, {
      guard,
      owner: {
        ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
        ...(sessionFile ? { sessionFile } : {})
      }
    }).catch(() => false)
    if (guard()) pushFrom(id, { ch: 'work-mode', payload: res.state })
    return res
  })
}
