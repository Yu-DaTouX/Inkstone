/**
 * 会话管理的 IPC 适配：派生 / 克隆、删除与撤销、移动、新建、切换、运行实例、标题与会话列表。
 *
 * 发送、中止与排队等「运行控制」仍在入口（与 pi 生命周期绑在一起）。
 */
import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import { shell } from 'electron'
import { cachedTitles, generateTitle, manualTitles, setManualTitle } from '../title'
import { getSettings } from '../settings'
import { listSessions, deleteSession, readTitleSamples, restoreSession } from '../sessions'
import { searchSessionText, warmSessionSearch } from '../session-search'
import { archiveSessionsBatch, moveSessionLayout, setSessionFlags } from '../session-layout'
import { selectAutoArchive } from '../../shared/session-archive'
import { filterChainRepresentatives } from '../remote-host'
import { planHistoryRead } from '../../shared/session-chain'

export function registerSessionIpc(ipc: IpcRegistrar, host: SessionHost): void {
  const { handle } = ipc
  /* ---- 会话管理 ---- */
  handle('yan:fork', async (entryId: string) => host.ac()?.fork(entryId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:clone', async () => host.ac()?.clone() ?? { ok: false, error: 'pi 未运行' })
  handle('yan:forkPoints', async () => host.ac()?.forkPoints() ?? [])
  handle('yan:exportHtml', async () => {
    const res = (await host.ac()?.exportHtml()) ?? { ok: false, error: 'pi 未运行' }
    if (res.ok && res.path) await shell.openPath(res.path)
    return res
  })
  handle('yan:deleteSession', async (path: string) => {
    try {
      await host.sessionChains.load()
      const chain = host.sessionChains.chainOf(path)
      /*
       * 删除按**链**整体处理（实施-05 S5b-4）：交接过的会话在磁盘上是两份 JSONL，
       * 只删其中一份会让历史拼接断成两截（看上去像内容丢了）。
       * 顺序仍是「先停实例、再删文件」，与单段删除同一条路。
       */
      const targets = chain && chain.segments.length > 1 ? planHistoryRead(chain) : [path]
      const current = host.ac()?.getState()?.sessionFile
      /* 当前正在用的会话在链上任何一段都算“在用”（防止把正在看的会话删掉） */
      for (const target of targets) await host.runners()?.stopBySessionFile(target)
      const tokens: string[] = []
      for (const target of targets) {
        tokens.push(await deleteSession(target, current))
      }
      /* 段都进回收站了，链记录再留着就会指向不存在的文件（侧栏会把另一段也藏起来） */
      await host.sessionChains.forget(path).catch(() => false)
      host.pushRunners()
      /* 多个 token 用 `|` 拼成一个（IPC 形状不变）：撤销时要整链一起恢复 */
      return { ok: true, undoToken: tokens.join('|') }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('yan:restoreSession', async (undoToken: string) => {
    try {
      /* 链删除返回的是多个 token（`|` 分隔）：整链一起恢复，否则历史又会断 */
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

  /**
   * 移动项目语义归属：只写 session-layout.json，不移动 JSONL，也不停止 runner。
   * null 表示 Yan 默认全局位置；目标项目必须是设置里的稳定 projectId。
   */
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

  /**
   * 切到某个会话（N12）。
   *
   * 命中已有实例 → 只改视图（后台会话继续跑）；
   * 空闲实例 → 复用；到并发上限 → 明确报错。
   */
  handle(
    'yan:selectSession',
    async (target: {
      sessionFile?: string
      sessionId?: string
      projectId?: string
      scope?: 'global' | 'project' | 'pending'
      cwd: string
      /** 只是看一眼：主进程不会为它建实例，也不会建隔离工作树 */
      preview?: boolean
    }) => {
      const cwdResult = await host.validateCwd(target.cwd)
      if (!cwdResult.ok) return cwdResult
      if (!host.runners()) {
        const r = await host.startAgent()
        if (!r.ok) return r
      }
      const settings = await getSettings()
      /* global 是显式产品归属，不能因为物理 cwd 恰好落在项目里就被重新吸回。 */
      const projectId = target.scope === 'global'
        ? undefined
        : (target.projectId ?? (target.scope === 'pending' ? undefined : host.projectIdForCwd(settings, cwdResult.cwd)))
      const res = await host.runners()!.select({
        ...target,
        cwd: cwdResult.cwd,
        projectId
      })
      /*
       * `deferred`：只是查看，实例没动 —— 不能把它记成「这条会话跑在哪个实例上」，
       * 否则后续按实例找会话会指向一个根本没载入这条会话的进程。
       */
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
  )

  /** 所有运行实例的状态（左栏状态槽；也用于补上错过的 runners 推送） */
  handle('yan:runnerStatuses', async () => host.runners()?.statuses() ?? [])

  /** 停掉某一个运行实例 —— 作用域只到它（单独停 B 不影响 A） */
  handle('yan:stopRunner', async (id: string) => {
    const done = (await host.runners()?.stopOne(id)) ?? false
    host.pushRunners()
    return done
  })

  /* 兼容旧调用：与 selectSession 同一套逻辑（cwd 取当前项目） */
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
  handle('yan:compact', async () => host.ac()?.compact() ?? { ok: false, error: 'pi 未运行' })

  handle('yan:cachedTitles', async () => cachedTitles())
  /*
   * 手动重命名。比“自动标题”更松一点：写一个独立的粘性名。
   * 两条通路：
   *   · 当前会话也调一次 pi 的 set_session_name（TUI / 其它客户端能看到）
   *   · 无论哪个会话都写 manual-titles.json（桌面端左栏立刻生效、且不被重生标题盖掉）
   */
  handle('yan:renameSession', async (name: string) => host.ac()?.renameSession(name) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:manualTitles', async () => manualTitles())
  handle('yan:setManualTitle', async (sessionId: string, name: string) =>
    setManualTitle(String(sessionId ?? ''), String(name ?? ''))
  )
  handle('yan:regenerateTitle', async (sessionId: string) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, error: '缺少目标会话' }

    /*
     * 运行中的目标交给它自己的 AgentController：不能切当前视图，也不能把
     * 标题请求塞进主对话。非运行会话则只读 JSONL 的首尾用户消息，起一个
     * --no-session 的独立归纳进程；两条路径都按稳定 sessionId 归属结果。
     */
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
  handle('yan:getCustomEntries', async () => host.ac()?.getCustomEntries() ?? [])
  handle('yan:refreshTodos', async () => host.ac()?.refreshTodos() ?? [])
  handle('yan:searchSessions', async (query: unknown, limit?: unknown) =>
    searchSessionText(typeof query === 'string' ? query.slice(0, 200) : '', typeof limit === 'number' ? limit : 30))
  handle('yan:listSessions', async () => {
    warmSessionSearch()
    const settings = await getSettings()
    /*
     * 生产端保持 200 条的桌面快照边界。隔离 live 回归会在一个批次里
     * 生成大量临时会话；它们只是测试夹具，不应把批次开始时种下的
     * 目标会话挤出列表，所以允许测试进程显式提高这一次 IPC 快照上限。
     */
    const requested = Number(process.env.YAN_TEST_SESSION_LIST_LIMIT)
    const limit = Number.isInteger(requested) && requested > 200 && requested <= 1000 ? requested : 200
    const list = await filterChainRepresentatives(await listSessions(limit, settings.projects))
    return sweepAutoArchive(list, settings.autoArchiveDays)
  })

  /**
   * 自动归档：闲置够久且没置顶、没有运行实例的会话打上归档标记。
   * 失败只跳过这一轮，不影响列表本身。
   */
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

  /** 归档 / 置顶共用：找到会话再写 session-layout 标记。 */
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

  /**
   * 快速预览一个会话的消息 —— **直接读文件，不问 pi**。
   *
   * 为什么需要（实测）：打开一个 17MB 的会话，
   *   pi 的 switch_session + get_messages = **2780ms**
   *   直接解析 JSONL               = **59ms**
   * 而且 pi 的 get_messages 不含压缩前历史（docs/rpc.md 写了），
   * 所以大会话在界面上只剩当前窗口 —— 用户感觉是「又卡又少内容」。
   *
   * 调用方应该：先拿这个把内容锦上（瞬间），再让 pi 在后台切过去。
   * 返回 null 表示读不出来（格式不认 / 文件不在）—— 调用方回退到等 pi。
   */
  handle('yan:peekSession', async (path: string) => {
    if (typeof path !== 'string' || !path) return null
    /* 链感知：切到交接过的会话时，锦上的历史也必须是完整的一条时间线 */
    return host.readHistoryWithArtifacts(path)
  })
}
