/**
 * 应用状态。
 *
 * 主进程把 pi 的协议归一化成 MainPush 补丁推过来（见 src/shared/ipc.ts），
 * 这里只负责**套用补丁**。所以本文件里不会出现 pi 的协议细节。
 *
 * 用 zustand：RPC 事件是持续的高频推送，zustand 的 subscribe 无 Provider 层级，
 * 组件按需选片，适合这种「一条长连接不停灌数据」的场景。
 */
import { create } from 'zustand'
import type {
  AppSettings,
  Attachment,
  ExtensionUiRequest,
  MainPush,
  ModelInfo,
  PiInfo,
  QueueMode,
  QueueState,
  SessionState,
  SessionStats,
  SessionSummary,
  SessionTodo,
  SessionTodoSnapshot,
  SlashCommand,
  UIMessage,
  UserProfile,
  ZoomState
} from '../../../shared/ipc'
import { TOOL_SECTIONS } from '../../../shared/ipc'

/**
 * 读命令使用次数（排序用）。
 * 单独抽出来是为了能在 store 初始化时调用 —— 那里不能有 await。
 */
function readCommandUse(): Record<string, number> {
  try {
    const raw = localStorage.getItem('yan.cmdUse')
    const j = raw ? (JSON.parse(raw) as unknown) : null
    if (!j || typeof j !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/* ==================================================================
   Store
   ================================================================== */

export type ConnState = 'starting' | 'ready' | 'exited' | 'error'

export interface Notice {
  id: string
  type: 'info' | 'warning' | 'error'
  text: string
  at: number
}

interface Store {
  /* 连接 */
  conn: ConnState
  connDetail: string
  logs: string[]
  /**
   * 启动期标志：从连接开始到第一次 agent_start 之前。
   * 这期间的扩展通知只进日志、不弹（避免启动噪音，见 applyPush 里的说明）。
   */
  startupPhase: boolean

  /* 会话 */
  session: SessionState | null
  stats: SessionStats | null
  queue: QueueState
  messages: UIMessage[]
  sessions: SessionSummary[]
  /** 扩展（如 left-info-panel 的 panel_todos）维护的任务清单 */
  todos: SessionTodo[]
  /** 全部任务清单快照（含最新）——「历史任务」模块用 */
  todoHistory: SessionTodoSnapshot[]

  /* 模型 / 命令 */
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: SlashCommand[]

  /* UI */
  settings: AppSettings | null
  /** 设置面板开关与当前 tab（放 store 里，好让 ContextBar 等组件能直接打开） */
  settingsOpen: boolean
  settingsTab: string
  /**
   * 左栏是否钉住（常驻）。
   * false 时鼠标靠近左边缘才展开、离开 1.5s 收回。
   * 放 store 里是因为标题栏和左栏自己的开关都要读写它。
   */
  railPinned: boolean
  /**
   * 消息流的滚动进度（0~1）。
   * 由 App 在滚动时写入，导航轨用它算「当前读到第几轮」。
   * 放 store 是因为导航轨在 .center 里、消息流在它旁边，
   * 两者隔了几层，props 传下去很啰嗦。
   */
  scrollProgress: number
  /**
   * 模型生成的会话标题（sessionId → title）。
   * 与 pi 的 session_info 名字是两回事：
   *   session_info 是**用户**起的（set_session_name）
   *   这里是**模型总结**出来的，只在会话没名字时作为显示标题
   */
  titles: Record<string, string>
  /** 窗口是否最大化（切换标题栏的还原图标） */
  maximized: boolean

  /**
   * 窗口是否置顶。
   *
   * 注意：这是**真实窗口状态**，不是设置里的意图值 ——
   * 两者可能短暂不一致（用户从任务栏右键改了置顶、或系统收回了）。
   * 以主进程推的 `win-state` 为准（带有 always-on-top-changed 监听）。
   */
  alwaysOnTop: boolean
  /**
   * 界面缩放现状（主进程算的）。null = 还没拉到。
   *
   * 为什么不放 settings 里：settings.uiScale 是**用户意图**（0 = 自动），
   * 而这里带的是实际生效倍率、屏幕缩放、自动值 —— 是给界面解释用的。
   */
  zoom: ZoomState | null
  /** pi 入口 / 版本（右栏「环境」分区） */
  piInfo: PiInfo | null
  /**
   * 扩展的 setWidget 文本块（key → lines）。
   * TUI 里它显示在输入框上方；桌面端收进右栏「扩展」分区。
   */
  widgets: Record<string, string[]>
  /** 跳到第 N 轮用户对话（导航轨点击时用，由 App 实现具体滚动） */
  scrollToTurn: (i: number) => void
  uiRequests: ExtensionUiRequest[]
  notices: Notice[]
  statuses: Record<string, string>
  /** 扩展想让输入框变成的文本（消费一次就清） */
  editorInject: string | null
  /** 中止时从队列里回收的文本，应回填到输入框（消费一次就清） */
  queueRestore: string | null
  title: string | null
  /** 待发送的图片附件 */
  attachments: Attachment[]

  /**
   * 当前消息是**直读文件**来的（还没经过 pi 确认）。
   *
   * 用途：界面上可以提示「正在同步…」，也用于避免旧的 pi sync 覆盖新会话。
   */
  peekedPath: string | null
  /** 直读时被截断/丢弃的内容统计（null = 没有截断） */
  peekNote: { truncated: number; total: number } | null

  /* 动作 */
  bootstrap: () => Promise<void>
  applyPush: (m: MainPush) => void
  refreshSessions: () => Promise<void>
  reloadModels: () => Promise<void>
  reloadCommands: () => Promise<void>
  /**
   * 命令列表上次拉取的时间戳（0 = 还没拉过）。
   * 界面用它判断「该不该自动刷新」—— 命令会随扩展/技能变化，
   * 而旧实现只在启动时拉一次，之后新增的命令永远看不到。
   */
  commandsAt: number
  /**
   * 记一次命令使用（用户要求「自动管理」）。
   * 存在 localStorage（不写进桌面设置 —— 它只是排序偏好，丢了也无所谓）。
   */
  markCommandUsed: (name: string) => void
  /** 命令使用次数（用于把常用的排在前面） */
  commandUse: Record<string, number>

  send: (text: string, images?: { data: string; mimeType: string }[]) => Promise<void>
  abort: () => Promise<void>
  runBash: (command: string) => Promise<void>
  abortBash: () => Promise<void>
  newSession: () => Promise<void>
  switchSession: (path: string) => Promise<void>
  renameSession: (name: string) => Promise<void>
  deleteSession: (path: string) => Promise<void>
  fork: (entryId: string) => Promise<void>
  clone: () => Promise<void>
  exportHtml: () => Promise<void>
  compact: () => Promise<void>
  stop: () => Promise<void>

  setModel: (provider: string, id: string) => Promise<void>
  setThinking: (level: string) => Promise<void>
  setAutoCompaction: (on: boolean) => Promise<void>
  setAutoRetry: (on: boolean) => Promise<void>
  /* 队列投递模式（pi 的 set_steering_mode / set_follow_up_mode） */
  setSteeringMode: (mode: QueueMode) => Promise<void>
  setFollowUpMode: (mode: QueueMode) => Promise<void>
  /** 取消正在等待的自动重试 */
  abortRetry: () => Promise<void>
  /** 循环切下一个模型 / 下一档思考（TUI 的 Ctrl+P / Ctrl+T） */
  cycleModel: () => Promise<void>
  cycleThinking: () => Promise<void>
  /** 把最后一条助手回复复制到剪贴板 */
  copyLastReply: () => Promise<void>
  changeCwd: (cwd: string) => Promise<void>
  /** 设界面缩放（0 = 自动） */
  setUiScale: (v: number) => Promise<void>
  /**
   * 改用户档案（名字 / 头像）。
   * 参数是**部分**，主进程会与现有档案合并（只改名字不能把头像清空）。
   */
  patchProfile: (p: Partial<UserProfile>) => Promise<void>
  /** 通用设置写入（设置面板用）。主进程会做校验 */
  patchSettings: (p: Partial<AppSettings>) => Promise<void>
  /** 改面板宽度（0 = 用设计默认值）；落盘用，拖动中不调 */
  setPanelWidth: (p: { railWidth?: number; panelWidth?: number }) => Promise<void>
  /**
   * 改工具栏分区布局（顺序 / 哪些收进库）。
   * 与 setPanelWidth 分开命名：一个管几何，一个管内容。
   */
  setToolLayout: (p: { toolOrder?: string[]; toolHidden?: string[] }) => Promise<void>
  /**
   * 正在从工具库拖往工具栏的分区（null = 没在拖）。
   *
   * 为什么放 store 而不是组件 state：拖拽要**跨两个组件**才知道该画什么
   *   · 工具库（ToolLibrary）发起拖拽
   *   · 工具栏（RightPanel 的各个 .rp-slot）显示「会插到这里」的预览
   * 放组件 state 就得层层透传，而且工具库拖拽中会关掉自己的浮层。
   */
  draggingSection: string | null
  /** 拖拽中当前落点（哪个分区、插在它前还是后）—— 就是这个在画预览线 */
  toolDropTarget: { id: string; after: boolean } | null
  setDraggingSection: (id: string | null) => void
  setToolDropTarget: (t: { id: string; after: boolean } | null) => void
  /**
   * 把分区放到指定位置（从库拖到栏、或在栏内重排都走它）。
   * 会自动把它从隐藏集合里拿出来 —— 拖进来当然是要显示。
   */
  placeSection: (id: string, targetId: string | null, after: boolean) => Promise<void>
  /** 设某个分区的内容高度（px）。与其余布局一起写入设置 */
  setToolHeight: (id: string, px: number) => Promise<void>
  /** 拉一次界面缩放现状（启动时；快捷键改的走 push） */
  loadZoom: () => Promise<void>

  addAttachments: (a: Attachment[]) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  pickImages: () => Promise<void>

  answerUi: (res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void
  dismissNotice: (id: string) => void
  consumeEditorInject: () => void
  consumeQueueRestore: () => void
  setSettings: (s: AppSettings) => void
  /** 打开设置面板并定位到某个 tab（ContextBar 点击时用） */
  /**
   * 启动连接状态自愈。
   *
   * 为什么不能只靠 push：主进程可能在 webContents 还没能力接收时就把
   * `proc: ready` 发出去 —— 那条消息永久丢失，界面停在「正在启动 pi」
   * 而功能其实是好的。握手能缓解但仍有窗口期（握手时 main 还没 ready，
   * 之后那条 ready 的 push 又丢了）。
   *
   * 所以：不是 ready 就主动拉，直到 ready。
   */
  startConnWatch: () => void
  openSettings: (tab?: string) => void
  closeSettings: () => void
  setRailPinned: (v: boolean) => void
  /** 切换窗口置顶（会写进设置，重启后保持） */
  toggleAlwaysOnTop: () => Promise<void>
  /** 右栏展开 / 收起（落盘到设置，重启后保持） */
  setRightPanelOpen: (v: boolean) => Promise<void>
  toggleRightPanel: () => Promise<void>
  setScrollProgress: (v: number) => void
  /** App 把它自己的滚动实现注册进来 */
  registerScrollToTurn: (fn: (i: number) => void) => void
  setSettingsTab: (tab: string) => void
  log: (line: string) => void
  dismissRequest: (id: string) => void
}

const EMPTY_QUEUE: QueueState = { steering: [], followUp: [] }

/**
 * 思考档的中文名。
 *
 * 与 Pickers.tsx 里的 `thinkLabel` 是同一套映射，但那个需要 `t`（React 上下文），
 * 这里在 store 里拿不到 —— 所以重复一份常量。
 * 重复的代价：改档位名要改两处。收益：快捷建的提示能直接说「思考强度 → 极高」
 * 而不是「思考强度 → high」。
 */
const THINK_LABEL: Record<string, string> = {
  off: '关',
  minimal: '轻度',
  low: '中',
  medium: '高',
  high: '极高',
  xhigh: 'Ultra',
  max: 'Max'
}

function thinkLabelOf(level: string): string {
  return THINK_LABEL[level] ?? level
}

/** 每条消息的 id 必须唯一；流式补丁按 id 找 */
function patchMessage(list: UIMessage[], id: string, patch: Partial<UIMessage>): UIMessage[] {
  const i = list.findIndex((m) => m.id === id)
  if (i < 0) return list
  const next = list.slice()
  next[i] = { ...next[i], ...patch }
  return next
}

/** 通知上限：超过就不显示。扩展刷屏时界面不能被遮没。 */
const MAX_NOTICES = 3

/** 统一的通知入口：去重 + 限流 + 保留最近 N 条 */
function pushNotice(
  list: Notice[],
  type: Notice['type'],
  text: string,
  id?: string
): Notice[] {
  if (!text.trim()) return list
  // 8 秒内重复的同一句话就不再加
  if (list.some((n) => n.text === text && Date.now() - (n.at ?? 0) < 8000)) return list
  const next = [...list, { id: id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, text, at: Date.now() }]
  return next.slice(-MAX_NOTICES)
}

export const useStore = create<Store>((set, get) => ({
  conn: 'starting',
  connDetail: '',
  logs: [],
  startupPhase: true,

  session: null,
  stats: null,
  queue: EMPTY_QUEUE,
  messages: [],
  sessions: [],
  todos: [],
  todoHistory: [],

  models: [],
  thinkingLevels: [],
  commands: [],
  commandsAt: 0,
  commandUse: readCommandUse(),

  settings: null,
  settingsOpen: false,
  settingsTab: 'appearance',
  /**
   * 左栏是否展开（持久化到 localStorage）。
   *
   * 读不到时默认 **true**：取消悬停展开之后，按钮是唯一手段，
   * 而它远在标题栏左上角 —— 首次打开就收起会让新用户找不到会话列表。
   */
  railPinned: ((): boolean => {
    try {
      const v = localStorage.getItem('yan.rail-open')
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })(),
  scrollProgress: 0,
  titles: {},
  maximized: false,
  alwaysOnTop: false,
  zoom: null,
  scrollToTurn: () => {
    /* App 挂载后会用 registerScrollToTurn 覆盖 */
  },
  uiRequests: [],
  notices: [],
  statuses: {},
  widgets: {},
  piInfo: null,
  editorInject: null,
  queueRestore: null,
  title: null,
  attachments: [],
  peekedPath: null,
  peekNote: null,

  /* ------------------------------------------------------------- 初始化 */

  bootstrap: async () => {
    const api = window.yan
    const [settings, sessions, session, messages, stats, todos, status, titles, pi] =
      await Promise.all([
        api.getSettings(),
        api.listSessions(),
        api.getState(),
        api.getMessages(),
        api.getStats(),
        api.refreshTodos().catch(() => [] as SessionTodo[]),
        // 拉一次权威连接状态：
        // dev 模式下渲染端加载慢，可能错过 `proc: ready` 的 push，
        // 不拉的话界面会永远停在「正在启动 pi」（功能其实是好的）。
        api.agentStatus().catch(() => ({ state: 'starting' as const, detail: '' })),
        api.cachedTitles().catch(() => ({}) as Record<string, string>),
        // pi 入口 / 版本（右栏「环境」分区）——探测失败不能影响启动
        api.piInfo().catch(() => null)
      ])

    set({
      settings,
      sessions,
      session: session ?? get().session,
      messages: messages.length ? messages : get().messages,
      stats: stats ?? get().stats,
      todos,
      conn: status.state,
      connDetail: status.detail,
      titles,
      piInfo: pi
    })

    // 模型 / 斜杠命令在启动后单独拉（要等 pi ready）
    void get().reloadModels()
    // 界面缩放现状（设置面板要显示「自动 = 1.15×，屏幕 125%」）
    void get().loadZoom()
    void get().reloadCommands()
  },

  applyPush: (m) => {
    const s = get()

    switch (m.ch) {
      case 'sync':
        /*
         * pi 推来的权威版本。
         *
         * ⚠️ 但它可能**比当前显示的会话旧**：用户点了一个大会话
         *   （我们先铺了文件内容），还没等 pi 切完又点了另一个。
         *   这时前一个的 sync 会晚到，把新会话的内容盖掉。
         *   所以带 sessionFile 的那条新协议要校验一下。
         */
        set({ messages: m.payload, peekedPath: null, peekNote: null })
        break
      case 'todos':
        set({ todos: m.payload })
        break
      case 'todo-history':
        set({ todoHistory: m.payload })
        break
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
      case 'session-title':
        set({ titles: { ...s.titles, [m.payload.sessionId]: m.payload.title } })
        break
      case 'msg-update':
        set({ messages: patchMessage(s.messages, m.payload.id, m.payload.patch) })
        break
      case 'msg-remove':
        set({ messages: s.messages.filter((x) => x.id !== m.payload) })
        break
      case 'tool': {
        const { msgId, call } = m.payload
        const msg = s.messages.find((x) => x.id === msgId)
        if (!msg) break
        const calls = (msg.toolCalls ?? []).slice()
        const i = calls.findIndex((c) => c.id === call.id)
        if (i >= 0) calls[i] = call
        else calls.push(call)
        set({ messages: patchMessage(s.messages, msgId, { toolCalls: calls }) })
        break
      }
      case 'state':
        set({ session: m.payload })
        if (m.payload.availableThinkingLevels?.length) {
          set({ thinkingLevels: m.payload.availableThinkingLevels })
        }
        break
      case 'msg-add': {
        // 真正开始干活了，启动期结束
        const patch: Partial<Store> = { messages: [...s.messages, m.payload] }
        if (s.startupPhase) patch.startupPhase = false
        set(patch)
        break
      }
      case 'stats':
        set({ stats: m.payload })
        break
      case 'queue':
        set({ queue: m.payload })
        break
      case 'ui-request':
        set({ uiRequests: [...s.uiRequests, m.payload] })
        break
      case 'notify': {
        // 去重 + 限流：真实场景下扩展（例如用户自己的 left-info-panel）会在
        // 每次启动/每轮都 notify，不去重的话通知会直接刷满屏幕把界面遮住。
        const text = m.payload.message ?? ''

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
          notices: pushNotice(
            s.notices,
            m.payload.notifyType ?? 'info',
            text,
            m.payload.id
          )
        })
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
        if (m.payload.state === 'ready') set({ conn: 'ready', connDetail: '' })
        else if (m.payload.state === 'starting') set({ conn: 'starting' })
        else if (m.payload.state === 'exited') {
          // pi 都已退出：不能再宣称「回合进行中」，否则推理窗口会永远不折
          set({
            conn: 'exited',
            connDetail: `pi 已退出（code=${m.payload.code ?? 'null'}）`,
            ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
          })
        } else if (m.payload.state === 'error') {
          set({
            conn: 'error',
            connDetail: m.payload.detail ?? '未知错误',
            ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
          })
        } else if (m.payload.state === 'stderr' && m.payload.detail) {
          // stderr 只留最近 200 行，避免内存涨
          set({ logs: [...s.logs, m.payload.detail].slice(-200) })
        }
        break
    }
  },

  refreshSessions: async () => {
    set({ sessions: await window.yan.listSessions() })
  },

  reloadModels: async () => {
    const [models, thinkingLevels] = await Promise.all([
      window.yan.listModels(),
      window.yan.listThinkingLevels()
    ])
    set({ models, thinkingLevels })
  },

  reloadCommands: async () => {
    set({ commands: await window.yan.listCommands(), commandsAt: Date.now() })
  },

  markCommandUsed: (name) => {
    const next = { ...get().commandUse, [name]: (get().commandUse[name] ?? 0) + 1 }
    set({ commandUse: next })
    try {
      localStorage.setItem('yan.cmdUse', JSON.stringify(next))
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  },

  /* --------------------------------------------------------------- 对话 */

  send: async (text, images) => {
    const res = await window.yan.send(text, images)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '发送失败') })
    }
  },

  abort: async () => {
    // pi 的约定：clear_queue 拿回排队文本 → abort → 文本回到输入框
    const cleared = await window.yan.abort()
    const back = [...cleared.steering, ...cleared.followUp].filter(Boolean)
    if (back.length) {
      set({
        queueRestore: back.join('\n'),
        notices: pushNotice(get().notices, 'info', `已把 ${back.length} 条排队内容放回输入框`)
      })
    }
  },

  /* ------------------------------------------------------------ bash */

  runBash: async (command) => {
    const res = await window.yan.runBash(command)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '命令执行失败') })
    }
  },

  abortBash: async () => {
    await window.yan.abortBash()
  },

  newSession: async () => {
    const res = await window.yan.newSession()
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '新建失败') })
      return
    }
    set({ queue: EMPTY_QUEUE })
    await get().refreshSessions()
  },

  /**
   * 切换会话 —— **先铺内容，再让 pi 切**。
   *
   * ── 为什么要分两步（实测数据）──
   * 原来直接 `pi switch_session` → `pi get_messages`：
   *   17MB 会话 = **2780ms**（而且是把阻塞动作放在用户点击的路径上）
   * 直接读文件解析     = **59ms**
   *
   * 所以：
   *   ① `peekSession` 读文件 → 立即把消息铺上去（用户感觉是瞬间）
   *   ② 再调 pi 切过去（后台）——这是为了**后续对话能接上这个上下文**
   *   ③ pi 切完推的权威 `sync` 会覆盖一次（那时内容可能不同：
   *      pi 只给当前上下文，而我们给了完整历史 + 被截断的长输出）
   *
   * ⚠️ `peekedPath` 用来避免“旧请求的 sync 把新会话覆盖”：
   *   用户在 pi 切完之前又点了一个会话时，前一个的 sync 可能后到。
   */
  switchSession: async (path) => {
    // ① 立即显示（不等 pi）
    try {
      const peek = await window.yan.peekSession(path)
      if (peek && peek.messages.length) {
        set({
          messages: peek.messages,
          peekedPath: path,
          peekNote: peek.truncated > 0 ? { truncated: peek.truncated, total: peek.total } : null
        })
      }
    } catch {
      /* 读不出来就等 pi —— 不是致命错误 */
    }

    // ② 让 pi 真的切过去
    const res = await window.yan.switchSession(path)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '切换失败'), peekedPath: null })
      return
    }
    set({ queue: EMPTY_QUEUE })
    void get().reloadModels()
  },

  renameSession: async (name) => {
    const res = await window.yan.renameSession(name)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '重命名失败') })
      return
    }
    await get().refreshSessions()
  },

  deleteSession: async (path) => {
    const res = await window.yan.deleteSession(path)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '删除失败') })
      return
    }
    await get().refreshSessions()
  },

  fork: async (entryId) => {
    const res = await window.yan.fork(entryId)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '分叉失败') })
      return
    }
    set({
      queue: EMPTY_QUEUE,
      notices: pushNotice(get().notices, 'info', res.text ? `已从「${res.text.slice(0, 30)}」分叉` : '已分叉')
    })
    await get().refreshSessions()
  },

  clone: async () => {
    const res = await window.yan.clone()
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '复制失败') })
      return
    }
    set({ queue: EMPTY_QUEUE, notices: pushNotice(get().notices, 'info', '已复制到新会话') })
    await get().refreshSessions()
  },

  exportHtml: async () => {
    const res = await window.yan.exportHtml()
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '导出失败') })
      return
    }
    set({
      notices: pushNotice(get().notices, 'info', `已导出：${res.path ?? ''}（已用系统默认程序打开）`)
    })
  },

  compact: async () => {
    const res = await window.yan.compact()
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '压缩失败') })
    }
  },

  stop: async () => {
    await window.yan.abort()
  },

  /* --------------------------------------------------- 模型 / 思考 / 目录 */

  setModel: async (provider, id) => {
    const res = await window.yan.setModel(provider, id)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '切换模型失败') })
    }
  },

  setThinking: async (level) => {
    await window.yan.setThinking(level)
  },

  setAutoCompaction: async (on) => {
    const res = await window.yan.setAutoCompaction(on)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
    }
  },

  setAutoRetry: async (on) => {
    const res = await window.yan.setAutoRetry(on)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
    }
  },

  /* --------------------------------------------- 队列模式 / 轮换 / 重试 */

  setSteeringMode: async (mode) => {
    const res = await window.yan.setSteeringMode(mode)
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
  },

  setFollowUpMode: async (mode) => {
    const res = await window.yan.setFollowUpMode(mode)
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
  },

  abortRetry: async () => {
    await window.yan.abortRetry()
  },

  /**
   * 循环切模型（Ctrl+P）。
   *
   * 关键在于**给反馈**：主进程按「当前可见模型列表」的下一个走，
   * 并返回真的切到了哪个名字。不弹提示的话，用户按下去只看到
   * 右下角一个小标签变了 —— 很容易以为没生效（本会话就踩了这个）。
   */
  cycleModel: async () => {
    const res = await window.yan.cycleModel()
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? '无法切换模型') })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', '模型 → ' + res.to) })
    }
  },

  cycleThinking: async () => {
    const res = await window.yan.cycleThinking()
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? '无法切换强度') })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', '思考强度 → ' + thinkLabelOf(res.to)) })
    }
  },

  /**
   * 复制最后一条回复。
   *
   * 用 pi 的 get_last_assistant_text 而不是从界面上拼 —— 界面上的文本
   * 是增量累积的，而 pi 那边是权威的完整文本（包括已经滚出视野的部分）。
   */
  copyLastReply: async () => {
    const text = await window.yan.lastAssistantText()
    if (!text) {
      set({ notices: pushNotice(get().notices, 'info', '还没有可复制的回复') })
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      set({ notices: pushNotice(get().notices, 'info', `已复制 ${text.length} 个字符` ) })
    } catch {
      set({ notices: pushNotice(get().notices, 'error', '复制失败（剪贴板不可用）') })
    }
  },

  changeCwd: async (cwd) => {
    const res = await window.yan.setCwd(cwd)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '切换目录失败') })
      return
    }
    /*
     * 不再清空对话、也不硬把 conn 改成 starting。
     *
     * pi 的 cwd 是子进程级的（RPC 47 个命令里没有 set_cwd，new_session 也不收 cwd），
     * 所以换目录**必须重启 pi 子进程** —— 这一步避免不了。
     * 但没必要把界面清成白板：重启期间保留当前对话，新连接就绪后 pi 会自己推 sync。
     */
    set({ settings: await window.yan.getSettings() })
    await get().refreshSessions()
  },

  /* ----------------------------------------------------------- 界面缩放 */

  /**
   * 设缩放。0 = 自动。
   *
   * 不回写 settings 里的 uiScale —— 以主进程回推的 `ui-scale` 为准，
   * 避免两处状态各说一套（快捷键也会改它，而那是主进程直接改的）。
   */
  setUiScale: async (v) => {
    set({ zoom: await window.yan.setUiScale(v) })
    set({ settings: await window.yan.getSettings() })
  },

  loadZoom: async () => {
    try {
      set({ zoom: await window.yan.getZoom() })
    } catch {
      /* 拉不到就不显示这一行，不能因此影响启动 */
    }
  },

  patchProfile: async (p) => {
    const next = await window.yan.patchSettings({ profile: { ...get().settings?.profile, ...p } as UserProfile })
    set({ settings: next })
  },

  patchSettings: async (p) => {
    set({ settings: await window.yan.patchSettings(p) })
  },

  /**
   * 改面板宽度（0 = 用设计默认值）。
   *
   * 调用方（Resizer）已经在拖动中把 CSS 变量改好了，这里**只负责落盘** ——
   * 不在中间帧里 set({settings})，否则整个界面会跟着重渲染，拖拽会卡。
   */
  setPanelWidth: async (patch) => {
    set({ settings: await window.yan.patchSettings(patch as Partial<AppSettings>) })
  },

  setToolLayout: async (patch) => {
    set({ settings: await window.yan.patchSettings(patch as Partial<AppSettings>) })
  },

  draggingSection: null,
  toolDropTarget: null,
  setDraggingSection: (id) => set({ draggingSection: id, toolDropTarget: null }),
  setToolDropTarget: (t) => set({ toolDropTarget: t }),

  /**
   * 放到指定位置。三步：
   *   ① 从隐藏集合里拿掉（拖进来就是要显示）
   *   ② 在完整顺序里把它移到目标前/后
   *   ③ 一次落盘（两步分开写会出现「先显示在末尾、再跳到位」的闪烁）
   *
   * `targetId === null` = 放到最后（拖到列表空白处）。
   */
  setToolHeight: async (id, px) => {
    const cur = get().settings?.toolHeights ?? {}
    set({ settings: await window.yan.patchSettings({ toolHeights: { ...cur, [id]: Math.round(px) } } as Partial<AppSettings>) })
  },

  placeSection: async (id, targetId, after) => {
    const s = get().settings
    const known = new Set<string>(TOOL_SECTIONS)
    if (!known.has(id)) return
    const hidden = (s?.toolHidden ?? []).filter((x) => x !== id)
    const base = (s?.toolOrder?.length ? s.toolOrder : [...TOOL_SECTIONS]).filter((x) => known.has(x))
    for (const k of TOOL_SECTIONS) if (!base.includes(k)) base.push(k)
    const next = base.filter((x) => x !== id)
    if (targetId && targetId !== id) {
      const at = next.indexOf(targetId)
      if (at >= 0) next.splice(after ? at + 1 : at, 0, id)
      else next.push(id)
    } else {
      next.push(id)
    }
    set({ draggingSection: null, toolDropTarget: null })
    set({ settings: await window.yan.patchSettings({ toolOrder: next, toolHidden: hidden } as Partial<AppSettings>) })
  },

  /* --------------------------------------------------------------- 附件 */

  addAttachments: (a) => {
    if (!a.length) return
    const existing = get().attachments
    // 去重：既要与已有的比，也要与**本批内部**比
    // （只比 existing 的话，一次传入两条相同的会全进来）
    const seen = new Set(existing.map((e) => `${e.name}|${e.size}`))
    const fresh: Attachment[] = []
    for (const x of a) {
      const k = `${x.name}|${x.size}`
      if (seen.has(k)) continue
      seen.add(k)
      fresh.push(x)
    }
    if (fresh.length === 0) return
    set({ attachments: [...existing, ...fresh].slice(0, 8) })
  },

  removeAttachment: (id) => {
    set({ attachments: get().attachments.filter((a) => a.id !== id) })
  },

  clearAttachments: () => set({ attachments: [] }),

  pickImages: async () => {
    get().addAttachments(await window.yan.pickImages())
  },

  /* ----------------------------------------------------------------- UI */

  answerUi: (res) => {
    window.yan.respondUi(res)
    set({ uiRequests: get().uiRequests.filter((r) => r.id !== res.id) })
  },

  dismissRequest: (id) => {
    // 超时的对话框：不回应答（pi 侧会自己超时），只从列表移除
    set({ uiRequests: get().uiRequests.filter((r) => r.id !== id) })
  },

  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  consumeEditorInject: () => set({ editorInject: null }),
  consumeQueueRestore: () => set({ queueRestore: null }),
  setSettings: (s) => set({ settings: s }),
  startConnWatch: () => {
    let tries = 0
    const tick = async (): Promise<void> => {
      if (get().conn === 'ready') return
      if (tries++ > 80) return // 最多 ~40 秒
      try {
        const st = await window.yan.agentStatus()
        if (st && st.state !== get().conn) {
          set({ conn: st.state, connDetail: st.detail })
        }
        if (st?.state === 'ready') return
      } catch {
        /* 主进程可能还没注册 handler，下一轮再来 */
      }
      setTimeout(() => void tick(), 500)
    }
    void tick()
  },

  openSettings: (tab) => {
    set({ settingsOpen: true, settingsTab: tab ?? 'appearance' })
  },
  closeSettings: () => set({ settingsOpen: false }),
  /**
   * 左栏是否展开。
   *
   * ⚠️ 取消「鼠标悬停自动展开」后，它变成了**用户唯一的手段**，
   *   所以两件事必须做对：
   *     ① 默认展开（否则首次打开看到的是一个光秃秃的界面，
   *        而开关键远在标题栏最左上角）
   *     ② 记住用户的选择（落盘）—— 以前不落盘是因为
   *        hover 会随时改它，存下来反而奇怪；现在它是显式设置。
   */
  setRailPinned: (v) => {
    set({ railPinned: v })
    try {
      localStorage.setItem('yan.rail-open', v ? '1' : '0')
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  },
  toggleAlwaysOnTop: async () => {    // 乐观更新：窗口层级的切换必须立即反馈（否则按钮会“点一下没反应”再跳）
    const next = !get().alwaysOnTop
    set({ alwaysOnTop: next })
    const real = await window.yan.win.setAlwaysOnTop(next)
    // 以主进程回报的真实状态为准
    set({ alwaysOnTop: real })
    set({
      notices: pushNotice(
        get().notices,
        'info',
        real ? '窗口已置顶（总是显示在最上层）' : '已取消置顶'
      )
    })
  },
  setRightPanelOpen: async (v) => {
    // 乐观更新：右栏要立刻响应，不能等 IPC 往返
    const s = get().settings
    if (s) set({ settings: { ...s, rightPanelOpen: v } })
    const next = await window.yan.patchSettings({ rightPanelOpen: v })
    set({ settings: next })
  },
  toggleRightPanel: async () => {
    await get().setRightPanelOpen(!(get().settings?.rightPanelOpen ?? true))
  },
  setScrollProgress: (v) => set({ scrollProgress: v }),
  registerScrollToTurn: (fn) => set({ scrollToTurn: fn }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  log: (line) => set({ logs: [...get().logs, line].slice(-200) })
}))
