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
  MemoryItem,
  ModelInfo,
  PiInfo,
  QueueMode,
  QueueState,
  SessionState,
  SessionStats,
  SessionSummary,
  SessionTodo,
  SlashCommand,
  UIMessage
} from '../../../shared/ipc'

/* ==================================================================
   记忆分组 —— 把扁平的记忆条目映射到右栏的分区
   ================================================================== */

export interface MemoryGroup {
  topic: 'about' | 'people' | 'projects'
  facts: MemoryItem[]
  guesses: MemoryItem[]
}

function groupMemory(items: MemoryItem[]): {
  about: MemoryItem[]
  impressions: MemoryItem[]
  people: MemoryItem[]
  projects: MemoryItem[]
} {
  const about: MemoryItem[] = []
  const impressions: MemoryItem[] = []
  const people: MemoryItem[] = []
  const projects: MemoryItem[] = []

  for (const m of items) {
    // 未确认的一律进「我的印象」—— 这是认识论分区，不是分类分区
    if (m.kind === 'guess') {
      impressions.push(m)
      continue
    }
    if (m.topic === 'people') people.push(m)
    else if (m.topic === 'projects') projects.push(m)
    else about.push(m)
  }

  return { about, impressions, people, projects }
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

  /* 记忆 */
  memory: MemoryItem[]
  soul: { name: string; selfRef: string; tone: string }
  groups: ReturnType<typeof groupMemory>

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

  /* 动作 */
  bootstrap: () => Promise<void>
  applyPush: (m: MainPush) => void
  refreshSessions: () => Promise<void>
  refreshMemory: () => Promise<void>
  reloadModels: () => Promise<void>
  reloadCommands: () => Promise<void>

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

  confirmMemory: (id: string, ok: boolean) => Promise<void>
  removeMemory: (id: string) => Promise<void>
  editMemory: (id: string, patch: { text?: string; topic?: string; kind?: 'fact' | 'guess' }) => Promise<void>
  addMemory: (text: string, kind: 'fact' | 'guess', topic?: string) => Promise<void>

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

  memory: [],
  soul: { name: '砚', selfRef: '我', tone: '直说，不绕，不奉承' },
  groups: { about: [], impressions: [], people: [], projects: [] },

  models: [],
  thinkingLevels: [],
  commands: [],

  settings: null,
  settingsOpen: false,
  settingsTab: 'memory',
  railPinned: false,
  scrollProgress: 0,
  titles: {},
  maximized: false,
  alwaysOnTop: false,
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

  /* ------------------------------------------------------------- 初始化 */

  bootstrap: async () => {
    const api = window.yan
    const [settings, soul, memory, sessions, session, messages, stats, todos, status, titles, pi] =
      await Promise.all([
        api.getSettings(),
        api.readSoul(),
        api.memoryList(),
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
      soul,
      memory,
      groups: groupMemory(memory),
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
    void get().reloadCommands()
  },

  applyPush: (m) => {
    const s = get()

    switch (m.ch) {
      case 'sync':
        set({ messages: m.payload })
        break
      case 'todos':
        set({ todos: m.payload })
        break
      case 'win-state':
        set({ maximized: m.payload.maximized, alwaysOnTop: m.payload.alwaysOnTop })
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
      case 'memory-changed':
        set({ memory: m.payload, groups: groupMemory(m.payload) })
        break
      case 'proc':
        if (m.payload.state === 'ready') set({ conn: 'ready', connDetail: '' })
        else if (m.payload.state === 'starting') set({ conn: 'starting' })
        else if (m.payload.state === 'exited') {
          set({ conn: 'exited', connDetail: `pi 已退出（code=${m.payload.code ?? 'null'}）` })
        } else if (m.payload.state === 'error') {
          set({ conn: 'error', connDetail: m.payload.detail ?? '未知错误' })
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

  refreshMemory: async () => {
    const items = await window.yan.memoryList()
    set({ memory: items, groups: groupMemory(items) })
  },

  reloadModels: async () => {
    const [models, thinkingLevels] = await Promise.all([
      window.yan.listModels(),
      window.yan.listThinkingLevels()
    ])
    set({ models, thinkingLevels })
  },

  reloadCommands: async () => {
    set({ commands: await window.yan.listCommands() })
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

  switchSession: async (path) => {
    const res = await window.yan.switchSession(path)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '切换失败') })
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
    set({ messages: [], stats: null, conn: 'starting' })
    set({ settings: await window.yan.getSettings() })
    await get().refreshSessions()
  },

  /* --------------------------------------------------------------- 记忆 */

  confirmMemory: async (id, ok) => {
    const items = await window.yan.memoryConfirm(id, ok)
    set({ memory: items, groups: groupMemory(items) })
  },

  removeMemory: async (id) => {
    const items = await window.yan.memoryRemove(id)
    set({ memory: items, groups: groupMemory(items) })
  },

  editMemory: async (id, patch) => {
    const items = await window.yan.memoryUpdate(id, patch)
    set({ memory: items, groups: groupMemory(items) })
  },

  addMemory: async (text, kind, topic) => {
    const items = await window.yan.memoryAdd(text, kind, topic)
    set({ memory: items, groups: groupMemory(items) })
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
    set({ settingsOpen: true, settingsTab: tab ?? 'memory' })
  },
  closeSettings: () => set({ settingsOpen: false }),
  setRailPinned: (v) => set({ railPinned: v }),
  toggleAlwaysOnTop: async () => {
    // 乐观更新：窗口层级的切换必须立即反馈（否则按钮会“点一下没反应”再跳）
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

export { groupMemory }

/** 供组件使用的记忆分组便捷选择器 */
export function useMemoryGroups(): ReturnType<typeof groupMemory> {
  return useStore((s) => s.groups)
}
