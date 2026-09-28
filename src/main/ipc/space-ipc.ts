/**
 * 活动档案与主题空间的 IPC 适配（`yan:getAgentProfile` / `yan:setAgentProfile`、`yan:*Space*`）。
 *
 * 档案按会话存，只对当前活跃实例读写；空间归属只写 session-layout，不移动会话文件、不改项目归属。
 */
import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { listSessions } from '../sessions'
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
  /*
   * ---- 活动档案（实施-25 P01）----
   *
   * 与工作模式同一条链：按**当前会话**读写，写盘后同时更新薄层快照与界面推送。
   * 不提供全局入口 —— 改档案只影响这条会话（改别的会话是切过去再改）。
   */
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
    /* 失败也要写 + 推：非法提交被挡下时，界面仍要看到真实生效的那一份 */
    await pushAgentProfile(id)
    return res
  })

  /*
   * ---- 主题空间（实施-25 P02）----
   *
   * 空间是**全局组织维度**（不属于某个会话）；会话通过 session-layout 的
   * `spaceId` 指向它。这里只做：列 / 建 / 改（含归档）/ 关联项目 / 把会话放进空间。
   *
   * ⚠️ 没有删除入口，**归档即移除**：资料库（P03）的引用按 identity + version
   *    绑定，物理删空间会造孤儿引用；真正的移除语义留给 P03。
   */
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

  /**
   * 把会话放进空间（或移出：`spaceId = null`）。
   *
   * 与 `yan:moveSession` 同一个边界：只写 session-layout，不移动 JSONL、不停 runner。
   * 空间归属与项目归属是两个独立维度，这里**不动 projectId**。
   */
  handle('yan:setSessionSpace', async (sessionId: string, spaceId: string | null) => {
    await spaces.load()
    if (spaceId !== null && !spaces.find(spaceId)) return { ok: false, error: '目标空间不存在' }
    const settings = await getSettings()
    const summaries = await listSessions(500, settings.projects)
    const summary = summaries.find((item) => item.id === sessionId)
    if (!summary) return { ok: false, error: '找不到要归属的会话' }
    try {
      const entry = await setSessionSpace(
        { sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd },
        spaceId
      )
      /*
       * 回填 AgentProfile.spaceId（实施-25 T02-4）。
       *
       * 只对**当前活跃实例**推：档案按会话存，后台会话等它被切过去时自己再读；
       * 在这里顺手改别的实例，就成了「操作后台会话却改了当前会话的档案」。
       */
      const active = registry()?.activeRunner()
      const activeFile = registry()?.agentOf(active?.id ?? '')?.getState()?.sessionFile
      /* 比较用共享归一化：工作模式键大小写敏感，不能兼作「是不是同一条会话」 */
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
