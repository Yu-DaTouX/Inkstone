import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { findSessionById } from '../sessions'
import { setSessionSpace } from '../session-layout'
import { agentDefaultProfile, agentProfileKeyFor, resolveAgentProfile, pushAgentProfile } from '../goal-coordinator'
import type { AgentProfilePatch } from '../../shared/agent-profile'
import { samePath } from '../../shared/session-path'
import type { RunnerRegistry } from '../runners'
import type { AgentProfileStore } from '../agent-profile-store'
import type { SpaceStore } from '../space-store'

export interface SpaceIpcDeps {
  registry(): RunnerRegistry | null
  agentProfiles: AgentProfileStore
  spaces: SpaceStore
}

export function registerSpaceIpc(ipc: IpcRegistrar, deps: SpaceIpcDeps): void {
  const { handle } = ipc
  const { registry, agentProfiles, spaces } = deps
  handle('yan:getAgentProfile', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return agentProfiles.state('', agentDefaultProfile)
    return resolveAgentProfile(id)
  })

  handle('yan:setAgentProfile', async (patch: unknown, expectedRevision?: number) => {
    const id = registry()?.activeRunner()?.id
    if (!id) {
      return { ok: false, state: agentProfiles.state('', agentDefaultProfile), error: 'pi 未运行' }
    }
    const clean = patch && typeof patch === 'object' ? (patch as AgentProfilePatch) : {}
    const res = await agentProfiles.set(agentProfileKeyFor(id), clean, expectedRevision)
    await pushAgentProfile(id)
    return res
  })

  handle('yan:getSpaces', async () => {
    await spaces.load()
    return { spaces: spaces.list(), links: spaces.links() }
  })

  handle('yan:createSpace', async (input: unknown) => {
    const res = await spaces.create(input)
    if (!res.ok) return { ok: false, error: 'error' in res && res.detail ? res.detail : '无法创建空间' }
    return { ok: true, space: res.space, spaces: spaces.list(), links: spaces.links() }
  })

  handle('yan:updateSpace', async (id: string, patch: unknown) => {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, error: '缺少空间 id' }
    const clean = (patch && typeof patch === 'object' ? patch : {}) as {
      name?: string
      description?: string | null
      archived?: boolean
    }
    const res = await spaces.update(id, clean)
    if (!res.ok) {
      if (res.error === 'not-found') return { ok: false, error: '空间不存在' }
      return { ok: false, error: 'detail' in res && res.detail ? res.detail : '无法更新空间' }
    }
    return { ok: true, space: res.space, spaces: spaces.list(), links: spaces.links() }
  })

  handle('yan:linkSpaceProject', async (spaceId: string, projectId: string) => {
    await spaces.load()
    if (typeof spaceId !== 'string' || !spaceId.trim() || typeof projectId !== 'string' || !projectId.trim()) {
      return { ok: false, error: '缺少空间或项目 id' }
    }
    const settings = await getSettings()
    if (!settings.projects.some((project) => project.id === projectId)) {
      return { ok: false, error: '目标项目不存在或已被移除' }
    }
    const res = await spaces.linkProject(spaceId, projectId)
    return res.ok ? { ok: true, links: res.links } : { ok: false, error: '空间不存在' }
  })

  handle('yan:unlinkSpaceProject', async (spaceId: string, projectId: string) => {
    await spaces.load()
    const res = await spaces.unlinkProject(spaceId, projectId)
    return res.ok ? { ok: true, links: res.links } : { ok: false, error: res.error ?? '解除关联失败' }
  })

  handle('yan:setSessionSpace', async (sessionId: string, spaceId: string | null) => {
    await spaces.load()
    if (spaceId !== null && !spaces.find(spaceId)) return { ok: false, error: '目标空间不存在' }
    const settings = await getSettings()
    const summary = await findSessionById(sessionId, settings.projects)
    if (!summary) return { ok: false, error: '找不到要归属的会话' }
    try {
      const entry = await setSessionSpace(
        { sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd },
        spaceId
      )
      const active = registry()?.activeRunner()
      const activeFile = registry()?.agentOf(active?.id ?? '')?.getState()?.sessionFile
      if (active && samePath(activeFile, summary.path)) {
        await agentProfiles.set(agentProfileKeyFor(active.id), { spaceId })
        await pushAgentProfile(active.id)
      }
      return { ok: true, entry }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
