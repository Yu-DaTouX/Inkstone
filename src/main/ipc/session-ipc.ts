import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { cachedTitles, generateTitle, manualTitles, setManualTitle } from '../title'
import { getSettings } from '../settings'
import { compactionInfo } from '../compaction'
import { DEFAULT_AUTO_COMPACT_TOKENS } from '../../shared/context-limits'
import { listSessions, deleteSession, readTitleSamples, restoreSession } from '../sessions'
import { searchSessionText, warmSessionSearch } from '../session-search'
import { archiveSessionsBatch, moveSessionLayout, setSessionFlags } from '../session-layout'
import { selectAutoArchive } from '../../shared/session-archive'
import { filterChainRepresentatives } from '../remote-host'
import { planHistoryRead } from '../../shared/session-chain'
import { readUsageStats } from '../usage-stats'

export interface SelectedSessionTarget {
  sessionFile: string
  projectId?: string
  scope?: 'global' | 'project' | 'pending'
  cwd: string
  preview?: boolean
}

export async function selectSessionWithHost(host: SessionHost, target: SelectedSessionTarget) {
  const cwdResult = await host.validateCwd(target.cwd)
  if (!cwdResult.ok) return cwdResult
  if (!host.runners()) {
    const r = await host.startAgent()
    if (!r.ok) return r
  }
  const settings = await getSettings()
  const projectId = target.scope === 'global'
    ? undefined
    : (target.projectId ?? (target.scope === 'pending' ? undefined : host.projectIdForCwd(settings, cwdResult.cwd)))
  const res = await host.runners()!.select({
    ...target,
    cwd: cwdResult.cwd,
    projectId
  })
  if (!res.deferred) {
    await host.rememberRunnerSession(res, {
      ...target,
      cwd: cwdResult.cwd,
      projectId,
      scope: target.scope ?? (projectId ? 'project' : 'global')
    })
  }
  if (res.ok && res.id) void host.pushRunnerSnapshot(res.id)
  host.pushRunners()
  return res
}

export function registerSessionIpc(ipc: IpcRegistrar, host: SessionHost): void {
  const { handle } = ipc
  handle('yan:usageStats', async (range: 'all' | '30d' | '7d') => readUsageStats(range))
  handle('yan:fork', async (entryId: string) => host.ac()?.fork(entryId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:clone', async () => host.ac()?.clone() ?? { ok: false, error: 'pi 未运行' })
  handle('yan:forkPoints', async () => host.ac()?.forkPoints() ?? [])
  handle('yan:exportHtml', async (outputPath?: string) => {
    if (outputPath !== undefined && (typeof outputPath !== 'string' || !outputPath.trim())) return { ok: false, error: '导出路径无效' }
    const agent = host.ac()
    if (!agent) return { ok: false, error: 'pi 未运行' }
    const path = outputPath === undefined ? undefined : resolve(agent.workingDirectory, outputPath)
    const sessionId = agent.getState()?.sessionId
    if (path && path === agent.getState()?.sessionFile) return { ok: false, error: '不能覆盖原始会话文件' }
    if (path && existsSync(path)) {
      const confirmed = await agent.confirmNativeOperation({ title: '覆盖 HTML 导出文件？', message: `将覆盖 ${path}。`, acceptLabel: '覆盖' })
      if (!confirmed) return { ok: false, cancelled: true }
      if (host.ac() !== agent || agent.getState()?.sessionId !== sessionId) return { ok: false, error: '会话已切换，导出已取消' }
    }
    const res = await agent.exportHtml(path)
    if (res.ok && res.path) await shell.openPath(res.path)
    return res
  })
  handle('yan:deleteSession', async (path: string) => {
    try {
      await host.sessionChains.load()
      const chain = host.sessionChains.chainOf(path)
      const targets = chain && chain.segments.length > 1 ? planHistoryRead(chain) : [path]
      const current = host.ac()?.getState()?.sessionFile
      for (const target of targets) await host.runners()?.stopBySessionFile(target)
      const tokens: string[] = []
      for (const target of targets) {
        tokens.push(await deleteSession(target, current))
      }
      await host.sessionChains.forget(path).catch(() => false)
      host.pushRunners()
      return { ok: true, undoToken: tokens.join('|') }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('yan:restoreSession', async (undoToken: string) => {
    try {
      const tokens = String(undoToken ?? '')
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)
      if (!tokens.length) return { ok: false, error: '没有可撤销的删除' }
      for (const token of tokens) await restoreSession(token)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('yan:moveSession', async (sessionId: string, projectId: string | null) => {
    const settings = await getSettings()
    if (projectId !== null && !settings.projects.some((project) => project.id === projectId)) {
      return { ok: false, error: '目标项目不存在或已被移除' }
    }
    const summaries = await listSessions(500, settings.projects)
    const summary = summaries.find((item) => item.id === sessionId)
    if (!summary) return { ok: false, error: '找不到要移动的会话' }
    try {
      const entry = await moveSessionLayout(
        { sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd },
        projectId
      )
      return { ok: true, entry }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:newSession', async (target?: { cwd?: string; projectId?: string; scope?: 'global' | 'project' | 'pending' }) => {
    const settings = await getSettings()
    const cwdResult = await host.validateCwd(target?.cwd ?? settings.cwd)
    if (!cwdResult.ok) return cwdResult
    if (!host.runners()) {
      const r = await host.startAgent()
      if (!r.ok) return r
    }
    if (target?.projectId && !settings.projects.some((project) => project.id === target.projectId)) {
      return { ok: false, error: '目标项目不存在或已被移除' }
    }
    const cwd = cwdResult.cwd
    const projectId = target?.scope === 'global'
      ? undefined
      : (target?.projectId ?? (target?.scope === 'pending' ? undefined : host.projectIdForCwd(settings, cwd)))
    const scope = target?.scope ?? (projectId ? 'project' : 'global')
    const res = await host.runners()!.select({ cwd, projectId, scope })
    await host.rememberRunnerSession(res, { cwd, projectId, scope })
    if (res.ok && res.id) void host.pushRunnerSnapshot(res.id)
    host.pushRunners()
    return res.ok
      ? {
          ok: true,
          id: res.id,
          runId: res.runId,
          sessionId: res.sessionId,
          generation: res.generation
        }
      : { ok: false, error: res.error }
  })

  handle('yan:selectSession', async (target: SelectedSessionTarget) => selectSessionWithHost(host, target))

  handle('yan:runnerStatuses', async () => host.runners()?.statuses() ?? [])

  handle('yan:stopRunner', async (id: string) => {
    const done = (await host.runners()?.stopOne(id)) ?? false
    host.pushRunners()
    return done
  })

  handle('yan:switchSession', async (path: string) => {
    const registry = host.runners()
    if (!registry) return { ok: false, error: 'pi 未运行' }
    const settings = await getSettings()
    const cwdResult = await host.validateCwd(settings.cwd)
    if (!cwdResult.ok) return cwdResult
    const res = await registry.select({ sessionFile: path, cwd: cwdResult.cwd })
    await host.rememberRunnerSession(res, {
      sessionFile: path,
      cwd: cwdResult.cwd,
      projectId: host.projectIdForCwd(settings, cwdResult.cwd),
      scope: 'project'
    })
    if (res.ok && res.id) void host.pushRunnerSnapshot(res.id)
    host.pushRunners()
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  handle('yan:compact', async (customInstructions?: string) => {
    if (customInstructions !== undefined && typeof customInstructions !== 'string') return { ok: false, error: '压缩要求必须是文本' }
    return host.ac()?.compact(customInstructions) ?? { ok: false, error: 'pi 未运行' }
  })

  handle('yan:compactionInfo', async (cwd: unknown, contextWindow: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim() || typeof contextWindow !== 'number') return null
    const cap = (await getSettings()).autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
    return compactionInfo(resolve(cwd), contextWindow, cap)
  })

  handle('yan:cachedTitles', async () => cachedTitles())
  handle('yan:renameSession', async (name: string) => host.ac()?.renameSession(name) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:manualTitles', async () => manualTitles())
  handle('yan:setManualTitle', async (sessionId: string, name: string) =>
    setManualTitle(String(sessionId ?? ''), String(name ?? ''))
  )
  handle('yan:regenerateTitle', async (sessionId: string) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, error: '缺少目标会话' }

    const live = host.runners()?.agentForSession(sid)
    if (live) return live.regenerateTitle()

    const settings = await getSettings()
    const session = (await listSessions(500, settings.projects)).find((item) => item.id === sid)
    if (!session) return { ok: false, error: '找不到目标会话，可能已被删除' }

    const samples = await readTitleSamples(session.path)
    if (!samples.length) return { ok: false, error: '该会话没有可用的用户文字，已保留原标题' }

    const manual = (await manualTitles())[sid]
    const result = await generateTitle({
      sessionId: sid,
      samples,
      cwd: session.cwd || process.cwd(),
      piBin: settings.piBin,
      force: true,
      allowManual: !!manual,
      persist: !manual
    })
    if (!result?.title) return { ok: false, error: '标题生成失败，已保留原标题' }
    if (!manual) host.push({ ch: 'session-title', payload: { sessionId: sid, title: result.title } })
    return { ok: true, title: result.title }
  })
  handle('yan:refreshTodos', async () => host.ac()?.refreshTodos() ?? [])
  handle('yan:searchSessions', async (query: unknown, limit?: unknown) =>
    searchSessionText(typeof query === 'string' ? query.slice(0, 200) : '', typeof limit === 'number' ? limit : 30))
  handle('yan:listSessions', async () => {
    warmSessionSearch()
    const settings = await getSettings()
    const requested = Number(process.env.YAN_TEST_SESSION_LIST_LIMIT)
    const limit = Number.isInteger(requested) && requested > 200 && requested <= 1000 ? requested : 200
    const list = await filterChainRepresentatives(await listSessions(limit, settings.projects))
    return sweepAutoArchive(list, settings.autoArchiveDays)
  })

  async function sweepAutoArchive<T extends Parameters<typeof selectAutoArchive>[0][number]>(list: T[], days: unknown): Promise<T[]> {
    const busyFiles = (host.runners()?.statuses() ?? []).map((r) => r.sessionFile)
    const ids = selectAutoArchive(list, { days: Number(days), now: Date.now(), busyFiles })
    if (!ids.length) return list
    try {
      await archiveSessionsBatch(ids)
    } catch {
      return list
    }
    const at = Date.now()
    const done = new Set(ids)
    return list.map((s) => (done.has(s.id) ? { ...s, archivedAt: at } : s))
  }

  async function setFlags(sessionId: string, flags: { archived?: boolean; pinned?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const settings = await getSettings()
    const summaries = await listSessions(500, settings.projects)
    const summary = summaries.find((item) => item.id === sessionId)
    if (!summary) return { ok: false, error: '找不到这条会话' }
    try {
      await setSessionFlags({ sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd }, flags)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  handle('yan:setSessionArchived', async (sessionId: string, archived: boolean) => setFlags(String(sessionId), { archived: archived === true }))
  handle('yan:setSessionPinned', async (sessionId: string, pinned: boolean) => setFlags(String(sessionId), { pinned: pinned === true }))

  handle('yan:peekSession', async (path: string) => {
    if (typeof path !== 'string' || !path) return null
    return host.readHistoryWithArtifacts(path)
  })
}
