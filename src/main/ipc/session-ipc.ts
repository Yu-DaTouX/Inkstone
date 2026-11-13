import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import { requiredSessionActionAgent, sessionActionChanged } from './session-action-target'
import { shell } from 'electron'
import { rememberSyncBaseline, takeSyncBaseline } from '../sync-baseline'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { YAN_DIR } from '../paths'
import { listArtifactLibrary } from '../artifact-library'
import { INLINE_ARTIFACT_MAX_BYTES, inlineArtifactFilename, type SaveInlineArtifactInput } from '../../shared/artifact-library'
import { cachedTitles, generateTitle, manualTitles, setManualTitle } from '../title'
import { getSettings } from '../settings'
import { compactionInfo } from '../compaction'
import { DEFAULT_AUTO_COMPACT_TOKENS } from '../../shared/context-limits'
import { listSessions, readTitleSamples, restoreSession, isSessionFileInSessionsDir } from '../sessions'
import { searchSessionText, warmSessionSearch } from '../session-search'
import { archiveSessionsBatch, getSessionLayout, moveSessionLayout, setSessionFlags } from '../session-layout'
import { resolveSessionOpenTarget } from '../session-open-target'
import { beginSessionMove, restoreSessionHeaderCwd, rewriteSessionCwd, sessionMoveInProgress } from '../session-move'
import { AUTO_ARCHIVE_SWEEP_INTERVAL_MS, runAutoArchiveSweep } from '../session-auto-archive'
import { filterChainRepresentatives } from '../remote-host'
import { effectiveAutoArchiveDays } from '../../shared/session-archive'
import { translateText } from '../translate'
import { archivedCompressionStatus, compressArchivedSessions, COMPRESS_SWEEP_INTERVAL_MS } from '../session-compress'
import { readUsageStatsOffThread } from '../usage-stats-host'
import { deleteSessionChain } from '../session-delete'
import { closeBrowserForSessions } from '../session-browser-cleanup'
import { isolationCwdKey } from '../session-isolation'
import { pick } from '../../shared/ui-lang'

export interface SelectedSessionTarget {
  sessionFile?: string
  projectId?: string
  scope?: 'global' | 'project' | 'pending'
  cwd: string
  preview?: boolean
}

function moveStageError(stage: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return pick(`移动工作目录失败（${stage}）：${detail}`, `Moving the folder failed (${stage}): ${detail}`)
}

export async function selectSessionWithHost(host: SessionHost, target: SelectedSessionTarget) {
  if (target.sessionFile && sessionMoveInProgress(target.sessionFile)) {
    return { ok: false, error: pick('这条会话正在移动工作目录，稍后再打开', 'This session is moving folders; open it again shortly') }
  }
  let cwdResult = await host.validateCwd(target.cwd)
  if (!cwdResult.ok && !target.preview && host.relocateMissingCwd && typeof target.sessionFile === 'string' && target.sessionFile.trim() && existsSync(target.sessionFile) && typeof target.cwd === 'string' && target.cwd.trim() && !existsSync(resolve(target.cwd))) {
    const picked = await host.relocateMissingCwd(target.cwd)
    if (!picked) return { ok: false, error: pick(`这个会话的项目文件夹不在了：${target.cwd}`, `The project folder for this session no longer exists: ${target.cwd}`) }
    cwdResult = await host.validateCwd(picked)
  }
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
  handle('yan:usageStats', async (range: 'all' | '30d' | '7d') => readUsageStatsOffThread(range))
  handle('yan:fork', async (entryId: string, expected: ExpectedRuntimeOwner) => requiredSessionActionAgent(host, expected)?.fork(entryId) ?? { ok: false, error: sessionActionChanged() })
  handle('yan:clone', async (expected: ExpectedRuntimeOwner) => requiredSessionActionAgent(host, expected)?.clone() ?? { ok: false, error: sessionActionChanged() })
  handle('yan:forkPoints', async () => host.ac()?.forkPoints() ?? [])
  handle('yan:exportHtml', async (outputPath: string | undefined, expected: ExpectedRuntimeOwner) => {
    if (outputPath !== undefined && (typeof outputPath !== 'string' || !outputPath.trim())) return { ok: false, error: pick('导出路径无效', 'Invalid export path') }
    const agent = requiredSessionActionAgent(host, expected)
    if (!agent) return { ok: false, error: sessionActionChanged() }
    const path = outputPath === undefined ? undefined : resolve(agent.workingDirectory, outputPath)
    const sessionId = agent.getState()?.sessionId
    if (path && path === agent.getState()?.sessionFile) return { ok: false, error: pick('不能覆盖原始会话文件', 'Cannot overwrite the original session file') }
    if (path && existsSync(path)) {
      const confirmed = await agent.confirmNativeOperation({ title: pick('覆盖 HTML 导出文件？', 'Overwrite HTML export file?'), message: pick(`将覆盖 ${path}。`, `${path} will be overwritten.`), acceptLabel: pick('覆盖', 'Overwrite') })
      if (!confirmed) return { ok: false, cancelled: true }
      if (requiredSessionActionAgent(host, expected) !== agent || agent.getState()?.sessionId !== sessionId) return { ok: false, error: pick('会话已切换，导出已取消', 'Session changed; export cancelled') }
    }
    const res = await agent.exportHtml(path)
    if (res.ok && res.path) await shell.openPath(res.path)
    return res
  })
  handle('yan:listArtifactLibrary', async () => {
    const settings = await getSettings()
    return { items: await listArtifactLibrary(join(YAN_DIR, 'artifacts'), await listSessions(Number.MAX_SAFE_INTEGER, settings.projects)) }
  })
  handle('yan:saveInlineArtifact', async (raw: SaveInlineArtifactInput) => {
    const input = raw && typeof raw === 'object' ? raw : ({} as SaveInlineArtifactInput)
    const filename = typeof input.filename === 'string' ? inlineArtifactFilename(input.filename) : null
    if (!filename) return { ok: false as const, error: 'filename' }
    if (typeof input.content !== 'string' || !input.content || Buffer.byteLength(input.content, 'utf8') > INLINE_ARTIFACT_MAX_BYTES) return { ok: false as const, error: 'size' }
    if (typeof input.sessionId !== 'string' || typeof input.messageId !== 'string' || typeof input.sourceKey !== 'string') return { ok: false as const, error: 'identity' }
    const agent = host.ac()
    if (!agent) return { ok: false as const, error: 'session_mismatch' }
    try {
      const artifact = await agent.saveInlineArtifact({
        sessionId: input.sessionId,
        messageId: input.messageId,
        filename,
        content: input.content,
        sourceId: `inline:${input.messageId.split('#')[0]}:${input.sourceKey.slice(0, 120)}`
      })
      return { ok: true as const, artifact }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('yan:deleteSession', async (path: string) => deleteSessionChain(host, path))
  handle('yan:restoreSession', async (undoToken: string) => {
    try {
      const tokens = String(undoToken ?? '')
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)
      if (!tokens.length) return { ok: false, error: pick('没有可撤销的删除', 'Nothing to undo') }
      for (const token of tokens) await restoreSession(token)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('yan:moveSession', async (sessionId: string, projectId: string | null, cwd?: string) => {
    const settings = await getSettings()
    if (projectId !== null && !settings.projects.some((project) => project.id === projectId)) {
      return { ok: false, error: pick('目标项目不存在或已被移除', 'Target project does not exist or was removed') }
    }
    const target = await locateSession(sessionId)
    if (!target) return { ok: false, error: pick('找不到要移动的会话', 'Session to move not found') }
    const lease = beginSessionMove(target.path)
    if (!lease) return { ok: false, error: pick('这条会话正在移动，请稍后再试', 'This session is being moved; try again shortly') }
    try {
      let nextCwd = target.cwd
      let cwdChanged = false
      let previousCwd: string | undefined
      if (typeof cwd === 'string' && cwd) {
        const checked = await host.validateCwd(cwd)
        if (!checked.ok) return checked
        if (resolve(checked.cwd).toLowerCase() !== resolve(target.cwd || '.').toLowerCase()) {
          const sessionFile = resolve(target.path).toLowerCase()
          const live = host.runners()?.statuses().find((status) => !!status.sessionFile && resolve(status.sessionFile).toLowerCase() === sessionFile)
          if (live && (live.running || live.waiting)) return { ok: false, error: pick('会话正在运行，等这一轮结束再移动工作目录', 'Session is running; move the working folder after this turn ends') }
          if (live) await host.runners()?.stopBySessionFile(target.path)
          try {
            const rewritten = await rewriteSessionCwd(target.path, checked.cwd, lease)
            previousCwd = rewritten.previousCwd
          } catch (error) {
            return { ok: false, error: moveStageError(pick('改写会话文件', 'rewriting the session file'), error) }
          }
          nextCwd = checked.cwd
          cwdChanged = true
        }
      }
      let entry
      try {
        entry = await moveSessionLayout({ sessionId, sessionFile: target.path, cwd: nextCwd }, projectId)
      } catch (error) {
        if (!cwdChanged || !previousCwd) return { ok: false, error: moveStageError(pick('保存会话位置', 'saving the session position'), error) }
        const restored = await restoreSessionHeaderCwd(target.path, previousCwd, lease)
        host.pushRunners()
        return {
          ok: false,
          error: restored
            ? moveStageError(pick('保存会话位置', 'saving the session position'), error)
            : pick('保存会话位置失败，工作目录也没能改回去；请重新指定这个会话的文件夹', 'Saving the session position failed and the folder could not be restored; set this session\'s folder again')
        }
      }
      if (cwdChanged) host.pushRunners()
      return { ok: true, entry, cwdChanged }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      lease.release()
    }
  })

  handle('yan:newSession', async (target?: { cwd?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; worktree?: boolean }) => {
    const settings = await getSettings()
    const cwdResult = await host.validateCwd(target?.cwd ?? settings.cwd)
    if (!cwdResult.ok) return cwdResult
    if (!host.runners()) {
      const r = await host.startAgent()
      if (!r.ok) return r
    }
    if (target?.projectId && !settings.projects.some((project) => project.id === target.projectId)) {
      return { ok: false, error: pick('目标项目不存在或已被移除', 'Target project does not exist or was removed') }
    }
    const projectId = target?.scope === 'global'
      ? undefined
      : (target?.projectId ?? (target?.scope === 'pending' ? undefined : host.projectIdForCwd(settings, cwdResult.cwd)))
    const scope = target?.scope ?? (projectId ? 'project' : 'global')
    let cwd = cwdResult.cwd
    if (target?.worktree === true) {
      const opened = await host.openSessionWorktree(cwd)
      if (!opened.ok) return opened
      cwd = opened.cwd
    }
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
    if (!registry) return { ok: false, error: pick('pi 未运行', 'pi is not running') }
    if (sessionMoveInProgress(path)) return { ok: false, error: pick('这条会话正在移动工作目录，稍后再打开', 'This session is moving folders; open it again shortly') }
    const settings = await getSettings()
    const fallback = await host.validateCwd(settings.cwd)
    if (!fallback.ok) return fallback
    const target = await resolveSessionOpenTarget({
      sessionFile: path,
      fallbackCwd: fallback.cwd,
      usable: (cwd) => host.validateCwd(cwd),
      projectIdForCwd: (cwd) => host.projectIdForCwd(settings, cwd)
    })
    if (target.missingCwd && host.relocateMissingCwd) {
      const picked = await host.relocateMissingCwd(target.missingCwd)
      const checked = picked ? await host.validateCwd(picked) : null
      if (!checked) return { ok: false, error: pick(`这个会话的项目文件夹不在了：${target.missingCwd}`, `The project folder for this session no longer exists: ${target.missingCwd}`) }
      if (!checked.ok) return checked
      target.cwd = checked.cwd
    }
    const res = await registry.select({ sessionFile: path, cwd: target.cwd, ...(target.projectId ? { projectId: target.projectId } : {}), scope: target.scope })
    await host.rememberRunnerSession(res, {
      sessionFile: path,
      cwd: target.cwd,
      projectId: target.projectId,
      scope: target.scope
    })
    if (res.ok && res.id) void host.pushRunnerSnapshot(res.id)
    host.pushRunners()
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  handle('yan:compact', async (customInstructions: string | undefined, expected: ExpectedRuntimeOwner) => {
    if (customInstructions !== undefined && typeof customInstructions !== 'string') return { ok: false, error: pick('压缩要求必须是文本', 'Compaction instructions must be text') }
    return requiredSessionActionAgent(host, expected)?.compact(customInstructions) ?? { ok: false, error: sessionActionChanged() }
  })

  handle('yan:compactionInfo', async (cwd: unknown, contextWindow: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim() || typeof contextWindow !== 'number') return null
    const cap = (await getSettings()).autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
    return compactionInfo(resolve(cwd), contextWindow, cap)
  })

  handle('yan:translateText', async (text: unknown) => {
    const settings = await getSettings()
    return translateText(text, { service: settings.translateService ?? 'bing', target: settings.translateTarget, model: settings.translateModel, piBin: settings.piBin })
  })
  handle('yan:cachedTitles', async () => cachedTitles())
  handle('yan:renameSession', async (name: string, expected: ExpectedRuntimeOwner) => requiredSessionActionAgent(host, expected)?.renameSession(name, expected.sessionId) ?? { ok: false, error: sessionActionChanged() })
  handle('yan:manualTitles', async () => manualTitles())
  handle('yan:setManualTitle', async (sessionId: string, name: string) =>
    setManualTitle(String(sessionId ?? ''), String(name ?? ''))
  )
  handle('yan:regenerateTitle', async (sessionId: string) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, error: pick('缺少目标会话', 'Missing target session') }

    const live = host.runners()?.agentForSession(sid)
    if (live) return live.regenerateTitle()

    const session = await locateSession(sid)
    if (!session) return { ok: false, error: pick('找不到目标会话，可能已被删除', 'Target session not found; it may have been deleted') }

    const samples = await readTitleSamples(session.path)
    if (!samples.length) return { ok: false, error: pick('该会话没有可用的用户文字，已保留原标题', 'No usable user text in this session; kept the original title') }

    const manual = (await manualTitles())[sid]
    const settings = await getSettings()
    const result = await generateTitle({
      sessionId: sid,
      samples,
      cwd: session.cwd || process.cwd(),
      piBin: settings.piBin,
      force: true,
      allowManual: !!manual,
      persist: !manual
    })
    if (!result?.title) return { ok: false, error: pick('标题生成失败，已保留原标题', 'Title generation failed; kept the original title') }
    if (!manual) host.push({ ch: 'session-title', payload: { sessionId: sid, title: result.title } })
    return { ok: true, title: result.title }
  })
  handle('yan:refreshTodos', async () => host.ac()?.refreshTodos() ?? [])
  ipc.rawHandle('yan:searchSessions', async (event, query: unknown, limit?: unknown) =>
    searchSessionText(typeof query === 'string' ? query.slice(0, 200) : '', typeof limit === 'number' ? limit : 30, `sender:${event.sender.id}`))
  handle('yan:listSessions', async () => {
    warmSessionSearch()
    const settings = await getSettings()
    const requested = Number(process.env.YAN_TEST_SESSION_LIST_LIMIT)
    const limit = Number.isInteger(requested) && requested > 200 && requested <= 1000 ? requested : 200
    const [sessions, worktrees] = await Promise.all([
      filterChainRepresentatives(await listSessions(limit, settings.projects)),
      host.sessionWorktrees?.().catch(() => []) ?? []
    ])
    if (!worktrees.length) return sessions
    const branches = new Map(worktrees.map((item) => [isolationCwdKey(item.cwd), item.branch]))
    return sessions.map((session) => {
      const worktreeBranch = branches.get(isolationCwdKey(session.cwd))
      return worktreeBranch ? { ...session, worktreeBranch } : session
    })
  })

  async function locateSession(sessionId: string): Promise<{ path: string; cwd: string } | undefined> {
    const layout = await getSessionLayout()
    const entry = layout.entries.find((item) => item.sessionId === sessionId)
    if (entry?.sessionFile && existsSync(entry.sessionFile)) return { path: entry.sessionFile, cwd: entry.cwd }
    const settings = await getSettings()
    const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
    return summary ? { path: summary.path, cwd: summary.cwd } : undefined
  }

  const sessionBusy = (sessionId: string): boolean => host.runners()?.sessionHasPendingWork(sessionId) ?? false

  function scheduleAutoArchiveSweep(): void {
    const sweep = async (): Promise<void> => {
      try {
        const settings = await getSettings()
        const days = effectiveAutoArchiveDays(settings)
        if (!days) return
        await runAutoArchiveSweep({
          sessions: await filterChainRepresentatives(await listSessions(Number.MAX_SAFE_INTEGER, settings.projects)),
          days,
          busyFiles: (host.runners()?.statuses() ?? []).map((runner) => runner.sessionFile),
          archive: async (ids) => {
            const changed = await archiveSessionsBatch(ids)
            await closeBrowserForSessions(ids, { skip: sessionBusy })
            return changed
          }
        })
      } catch {
        return
      }
    }
    void sweep()
    const timer = setInterval(() => void sweep(), AUTO_ARCHIVE_SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  scheduleAutoArchiveSweep()

  const busySessionFiles = (): (string | undefined)[] => (host.runners()?.statuses() ?? []).map((runner) => runner.sessionFile)
  function scheduleCompressionSweep(): void {
    const sweep = async (): Promise<void> => {
      try {
        if ((await getSettings()).compressArchivedSessions !== true) return
        await compressArchivedSessions({ busyFiles: busySessionFiles() })
      } catch {
        return
      }
    }
    const first = setTimeout(() => void sweep(), 2 * 60 * 1000)
    first.unref?.()
    const timer = setInterval(() => void sweep(), COMPRESS_SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  scheduleCompressionSweep()
  handle('yan:archivedCompression', async (run: boolean) => (run === true ? compressArchivedSessions({ busyFiles: busySessionFiles() }) : archivedCompressionStatus()))

  async function setFlags(sessionId: string, flags: { archived?: boolean; pinned?: boolean; snoozedUntil?: number | null; markedUnread?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const target = await locateSession(sessionId)
    if (!target) return { ok: false, error: pick('找不到这条会话', 'Session not found') }
    try {
      await setSessionFlags({ sessionId, sessionFile: target.path, cwd: target.cwd }, flags)
      if (flags.archived === true) await closeBrowserForSessions([sessionId], { skip: sessionBusy })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  handle('yan:setSessionArchived', async (sessionId: string, archived: boolean) => setFlags(String(sessionId), { archived: archived === true }))
  handle('yan:setSessionPinned', async (sessionId: string, pinned: boolean) => setFlags(String(sessionId), { pinned: pinned === true }))
  handle('yan:setSessionSnoozed', async (sessionId: string, until: number | null) =>
    setFlags(String(sessionId), { snoozedUntil: typeof until === 'number' && Number.isFinite(until) && until > 0 ? until : null })
  )
  handle('yan:setSessionMarkedUnread', async (sessionId: string, marked: boolean) => setFlags(String(sessionId), { markedUnread: marked === true }))

  handle('yan:peekSession', async (path: string, opts?: { trackSync?: boolean }) => {
    if (typeof path !== 'string' || !path) return null
    if (!(await isSessionFileInSessionsDir(path))) return null
    const result = await host.readHistoryWithArtifacts(path)
    if (result && opts?.trackSync === true) rememberSyncBaseline(path, result.messages)
    else takeSyncBaseline(path)
    return result
  })
}
