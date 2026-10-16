/**
 * 各领域状态分别认领自己的推送频道。
 *
 * store.applyPush 先做身份与归属判定（push-routing.ts），再依次交给这里的消费者；
 * 没被认领的频道（会话、消息、工具调用、运行实例等核心投影）留在 store 里处理。
 * 消费者拿到的 `s` 是这条推送到达时的状态快照，与原先 applyPush 内的口径一致。
 */
import type { AppSettings, MainPush, SoundEvent, SubagentRun } from '../../../shared/ipc'
import type { Notice, Store } from './store'
import { releaseResource } from './resource-owners'
import { isNativeMcpStatus } from '../lib/native-mcp-status'

export interface PushContext {
  get(): Store
  set(patch: Partial<Store>): void
  alertAttention(settings: AppSettings | null, event: SoundEvent, body?: string): void
  pushNotice(list: Notice[], type: Notice['type'], text: string, id?: string): Notice[]
  applyBrowserVisibility(): void
}

/** 窗口、缩放、内置浏览器、终端、日志、pi 连接与环境信息。认领的频道返回 true。 */
export function consumeShellPush(m: MainPush, s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'session-moved': {
      /* 宿主负责恢复及单次续接；界面仅刷新正在查看的原会话，不代发“继续”。 */
      const p = m.payload
      if (!p.ok) {
        set({ notices: ctx.pushNotice(s.notices, 'error', `会话没有移动：${p.error ?? '未知原因'}`) })
        break
      }
      const view = ctx.get()
      const showing = (state: Store) => state.peekedPath === p.sessionFile || state.session?.sessionFile === p.sessionFile || state.session?.sessionId === p.sessionId
      const wasShowing = showing(view)
      const note = p.continued ? '，正在继续原任务' : p.continuationError ? `；${p.continuationError}` : ''
      set({ notices: ctx.pushNotice(view.notices, 'info', `会话已移到 ${p.cwd}${note}`) })
      void view.refreshSessions().then(() => {
        // 刷新等待期间用户可能已切走，不能用过期 showing 抢回前台。
        if (wasShowing && showing(ctx.get())) void ctx.get().switchSession(p.sessionFile)
      })
      break
    }
    case 'win-state':
      set({ maximized: m.payload.maximized, alwaysOnTop: m.payload.alwaysOnTop })
      break
    case 'ui-scale':
      /*
       * 同时把 settings.uiScale 补上。
       *
       * 为什么不能只更新 zoom：Ctrl+= / Ctrl+- 是**主进程**拦的，
       * 它改完只推这一条。不补 settings 的话，用快捷键调完缩放，
       * 设置面板里的选中态还是旧的（两处状态各说一套）。
       */
      set({
        zoom: m.payload,
        ...(s.settings ? { settings: { ...s.settings, uiScale: m.payload.uiScale } } : {})
      })
      break
    case 'browser-state':
      if (!m.payload.open) releaseResource('browser')
      set({ browserState: m.payload })
      ctx.applyBrowserVisibility()
      break
    case 'terminal':
      /* 输出正文直连 xterm，不进 store；低频程序状态只投影到同 id 的标签。 */
      if (m.payload.kind === 'exit') {
        set({
          terminals: s.terminals.map((term) =>
            term.id === m.payload.id ? {
              ...term, alive: false, exitCode: m.payload.exitCode ?? null,
              status: term.status?.state === 'working' || term.status?.state === 'blocked' ? undefined : term.status
            } : term
          )
        })
      }
      else if (m.payload.kind === 'status') {
        const report = m.payload
        set({ terminals: s.terminals.map(term => term.id === report.id ? { ...term, status: report.status } : term) })
      }
      break
    case 'log':
      // 主进程未捕获异常 / 未处理 Promise：与 pi stderr 共用同一条日志抽屉，
      // 不再走 Electron 的原生错误弹框。
      set({ logs: [...s.logs, m.payload.text].slice(-200) })
      break
    case 'search-api-hint':
      /* 固定 id：重复到达只刷新一条，不叠加 */
      set({
        notices: [
          ...s.notices.filter((n) => n.id !== 'search-api-hint'),
          { id: 'search-api-hint', type: 'info', text: 'search-api-hint', at: Date.now(), action: 'search-api-hint' }
        ]
      })
      break
    case 'pi-info':
      set({ piInfo: m.payload })
      break
    case 'title':
      set({ title: m.payload })
      break
    case 'editor-text':
      set({ editorInject: m.payload })
      break
    case 'proc':
      if (m.payload.state === 'ready') {
        const becameReady = ctx.get().conn !== 'ready'
        set({ conn: 'ready', connDetail: '' })
        if (becameReady) {
          const current = ctx.get()
          void current.reloadModels()
          void current.reloadCommands()
          void current.refreshSessions()
        }
      }
      else if (m.payload.state === 'starting') set({ conn: 'starting' })
      else if (m.payload.state === 'exited') {
        // pi 都已退出：不能再宣称「回合进行中」，否则推理窗口会永远不折
        set({
          conn: 'exited',
          connDetail: `Agent 内核已退出（code=${m.payload.code ?? 'null'}）`,
          ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
        })
      } else if (m.payload.state === 'error') {
        const detail = m.payload.detail ?? '未知错误'
        set({
          conn: 'error',
          connDetail: detail,
          // pi 进程级错误也要进日志（用户要求「所有报错进日志」）
          logs: [...s.logs, `[错误] pi 进程：${detail}`].slice(-200),
          ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
        })
        ctx.alertAttention(s.settings, 'error', detail)
      } else if (m.payload.state === 'stderr' && m.payload.detail) {
        // stderr 只留最近 200 行，避免内存涨
        set({ logs: [...s.logs, m.payload.detail].slice(-200) })
      }
      break
    case 'hub-open':
      window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: m.payload }))
      break
    default:
      return false
  }
  return true
}

/** 提问面板、问答记录、通知与扩展状态 / 小部件。认领的频道返回 true。 */
export function consumeQuestionPush(m: MainPush, s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'question-log':
      /*
       * 整表覆盖：主机只在「记录变了 / 切了会话」时推，
       * 所以这里不需要合并 —— 合并只会把上一个会话的记录留在画面上。
       */
      set({ questionLog: m.payload.entries, questionLogSession: m.payload.sessionId })
      break
    case 'ui-request': {
      const duplicate = s.uiRequests.some((request) => request.id === m.payload.id)
      /* 宿主重放/同步可重复到达：同 ID 更新内容，不重复追加或打提示音。 */
      set({
        uiRequests: duplicate
          ? s.uiRequests.map((request) => request.id === m.payload.id ? m.payload : request)
          : [...s.uiRequests, m.payload],
        ...(!duplicate ? { uiCollapsed: false } : {})
      })
      if (!duplicate) ctx.alertAttention(s.settings, 'question', m.payload.message ?? m.payload.title)
      break
    }
    case 'ui-resolved':
      /* 答复或超时：只移除对应请求。 */
      set({ uiRequests: s.uiRequests.filter((r) => r.id !== m.payload.id) })
      break
    case 'ui-deadline':
      /*
       * 同一个请求的等待被延长：**只**改截止时间。
       * 不追加、不提示音、不展开 —— 那都是「新问题」的行为，而这里只是时间变了。
       */
      set({
        uiRequests: s.uiRequests.map((r) =>
          r.id === m.payload.id ? { ...r, timeout: m.payload.timeout, deadline: m.payload.deadline } : r
        )
      })
      break
    case 'notify': {
      // 去重 + 限流：真实场景下扩展（例如用户自己的 left-info-panel）会在
      // 每次启动/每轮都 notify，不去重的话通知会直接刷满屏幕把界面遮住。
      const text = m.payload.message ?? ''
      const query = s.nativeMcpStatus
      if (query?.pending && m.runtime?.sessionId === query.sessionId && isNativeMcpStatus(text)) {
        set({ nativeMcpStatus: { ...query, pending: false, text } })
        break
      }

      // 启动期的通知降级为日志。
      //
      // 为什么：这类通知多半是扩展的「我加载好了」自检（典型例子：
      // left-info-panel 的「信息面板已启用（overlay 44 列）· /panel …」）——
      // 它描述的是 TUI 的 overlay 与命令用法，在桌面端根本不适用，
      // 开机就弹出来只会让人困惑。但也不能直接咽掉（用户可能要看），
      // 所以进日志抽屉，底部状态条会显示有几条。
      if (s.startupPhase && (m.payload.notifyType ?? 'info') !== 'error') {
        set({ logs: [...s.logs, `[扩展] ${text}`].slice(-200) })
        break
      }

      set({
        notices: ctx.pushNotice(
          s.notices,
          m.payload.notifyType ?? 'info',
          text,
          m.payload.id
        )
      })
      // 报错才出声：info/告警不打断
      if ((m.payload.notifyType ?? 'info') === 'error') ctx.alertAttention(s.settings, 'error', text)
      break
    }
    case 'status': {
      const next = { ...s.statuses }
      if (m.payload.text === undefined) delete next[m.payload.key]
      else next[m.payload.key] = m.payload.text
      set({ statuses: next })
      break
    }
    case 'widget': {
      const next = { ...s.widgets }
      if (!m.payload.lines?.length) delete next[m.payload.key]
      else next[m.payload.key] = m.payload.lines
      set({ widgets: next })
      break
    }
    default:
      return false
  }
  return true
}

/** 子代理列表。认领的频道返回 true。 */
export function consumeSubagentPush(m: MainPush, s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'subagent': {
      /* 整条快照覆盖 / 追加（主进程已把转录限制在 200 条以内）。
       * 模型启动的 run 会由回合内联卡片展示；不再抢占右侧详情面板，
       * 否则模型一调用子代理，用户正在看的浏览器 / 文件 / 审查就会被强行盖住。 */
      const run = m.payload
      const idx = s.subagents.findIndex((r) => r.id === run.id)
      set({
        subagents:
          idx >= 0
            ? s.subagents.map((r) => (r.id === run.id ? run : r))
            : [...s.subagents, run]
      })
      break
    }
    case 'subagent-patch': {
      /*
       * 流式增量：只替换自 `transcriptFrom` 起的转录。
       * 没有基线（刚重载、还没拉到这条）时忽略 —— 下一次整条推送会把它补上。
       */
      const { id, run, transcriptFrom } = m.payload
      const previous = s.subagents.find((r) => r.id === id)
      if (!previous) break
      const merged: SubagentRun = {
        ...run,
        transcript: [...previous.transcript.slice(0, transcriptFrom), ...run.transcript]
      }
      set({ subagents: s.subagents.map((r) => (r.id === id ? merged : r)) })
      break
    }
    case 'subagent-remove':
      set({
        subagents: s.subagents.filter((r) => r.id !== m.payload),
        subagentPreviewId: s.subagentPreviewId === m.payload ? null : s.subagentPreviewId
      })
      break
    default:
      return false
  }
  return true
}

/** 当前会话的任务清单、工作模式、活动档案与目标。认领的频道返回 true。 */
export function consumeTaskStatePush(m: MainPush, _s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'todos':
      set({ todos: m.payload })
      break
    case 'todo-history':
      set({ todoHistory: m.payload })
      break
    case 'work-mode':
      /* 当前会话的模式：后台会话的已经写进 sessionRuntimes，上面已 return */
      set({ workMode: m.payload })
      break
    case 'approval':
      /* 批准请求属于宿主而不是某个会话视图：任何会话的请求都要让用户看到，不能被静默吞掉 */
      if (!_s.approvals.some((item) => item.id === m.payload.id)) set({ approvals: [..._s.approvals, m.payload] })
      break
    case 'git-install':
      set({ gitInstall: m.payload })
      /* 装好了：把「缺 Git」的那条通知收掉 */
      if (m.payload.phase === 'done') set({ notices: _s.notices.filter((n) => n.id !== 'git-install') })
      break
    case 'approval-close':
      set({ approvals: _s.approvals.filter((item) => item.id !== m.payload.id) })
      break
    case 'agent-profile':
      /* 当前会话的活动档案：后台会话的已归并到 sessionRuntimes，上面已 return */
      set({ agentProfile: m.payload })
      break
    case 'goal':
      /* 当前会话的目标：后台会话已经归并到 sessionRuntimes，上面已 return。 */
      set({ goal: m.payload })
      break
    default:
      return false
  }
  return true
}
