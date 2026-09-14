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
  BrowserState,
  ChromeSyncReport,
  ExtensionUiRequest,
  FilePreview,
  MainPush,
  MessagePatch,
  ModelInfo,
  PiInfo,
  QueueMode,
  QueueState,
  RunnerStatus,
  SessionState,
  SessionStats,
  SessionSummary,
  SessionTodo,
  SessionTodoSnapshot,
  SlashCommand,
  SoundEvent,
  SubagentRun,
  UIMessage,
  UIToolCall,
  UserProfile,
  ZoomState
} from '../../../shared/ipc'
import { TOOL_SECTIONS } from '../../../shared/ipc'
import { playSound } from '../lib/sound'

/**
 * 提醒的标题（系统通知用）。按界面语言分。
 *
 * 不把 i18n 的 t() 引进来：store 不在 React 树里，且这几个词很短，
 * 直接用 i18n 会写过的 documentElement.lang（它由 i18n Provider 维护）。
 */
function attentionTitle(event: SoundEvent): string {
  const en = typeof document !== 'undefined' && document.documentElement.lang === 'en-US'
  switch (event) {
    case 'done':
      return en ? 'Turn finished' : '回合完成'
    case 'question':
      return en ? 'Waiting for your answer' : '需要你的回答'
    case 'error':
      return en ? 'Error' : '出错'
  }
}

/**
 * 按设置决定发声 / 发通知。
 *
 * 声音总是按事件播（与窗口焦点无关）；系统通知只在**窗口不在前台**时发 ——
 * 用户正看着窗口时再弹一个通知是打扰，对齐 opencode 的 attention。
 */
function alertAttention(settings: AppSettings | null, event: SoundEvent, body?: string): void {
  const sound = settings?.sound
  if (!sound?.enabled || !sound.events?.[event]) return
  playSound(event, sound.volume)
  if (sound.notifications && typeof document !== 'undefined' && !document.hasFocus()) {
    void window.yan
      .notifyAttention({ kind: event, title: attentionTitle(event), body })
      .catch(() => {
        /* 通知失败不影响主流程 */
      })
  }
}

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

/* Store */

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
  /**
   * ⚠️ 这里曾有 `scrollProgress: number`（滚动百分比），已删。
   *
   * 导航轨一度用 `round(scrollProgress * (n-1))` **线性**估算「当前读到第几轮」，
   * 但它已经改成按 DOM 几何测量（ConversationOutline 的 activeFromGeometry）——
   * 后者在长聊天里才准（回合高度差很大，百分比换算出来的轮次是错的）。
   * 于是这个状态没了消费者，却还在**每次滚动时**写一次 store（流式输出时
   * 每秒几十次）。删掉它既能减少无效更新，也避免后来的人以为导航靠它。
   */
  /**
   * 模型生成的会话标题（sessionId → title）。
   * 与 pi 的 session_info 名字是两回事：
   *   session_info 是**用户**起的（set_session_name）
   *   这里是**模型总结**出来的，只在会话没名字时作为显示标题
   */
  titles: Record<string, string>
  /** 用户手动重命名的会话名（sessionId → name）—— 优先于 titles，且不会被自动标题覆盖 */
  manualTitles: Record<string, string>
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
  /** 内置浏览器状态；页面本体由主进程 WebContentsView 承载 */
  browserState: BrowserState
  /** 右侧的只读文件预览（消息里的文件链接 / 拖入的文件） */
  filePreview: FilePreviewState | null
  /** 子代理运行列表（方案第 8 节） */
  subagents: SubagentRun[]
  /** 右侧正在看的子代理（null = 没开） */
  subagentPreviewId: string | null
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
  /**
   * 问题面板是否收起（方案第 6 节）。
   * 收起**不是**取消，也不会替你选默认值 —— 草稿与队列都还在。
   */
  uiCollapsed: boolean
  /** 问题草稿：按 request id 保存（切面板/收起后仍在） */
  uiDrafts: Record<string, string>
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

  /**
   * 当前视图对应的运行实例 id（N12）。
   *
   * null = 还没和主进程对齐（刚加载那一瞬）。主进程推的会话事件都带
   * `sessionKey`，与本字段不一致的就是**后台会话**的输出 —— 不得写进
   * 当前视图（否则后台任务的流会串到眼前这个会话里）。
   */
  activeRunnerId: string | null
  /**
   * 所有运行实例的状态快照（N12）。
   * 左栏用它画每行的运行 / 等待输入 / 失败状态。
   */
  runners: RunnerStatus[]

  /* 动作 */
  bootstrap: () => Promise<void>
  /** 重新对齐运行实例状态（N12）：拉一次快照 + 同步当前视图 id */
  syncRunners: () => Promise<void>
  applyPush: (m: MainPush) => void
  refreshSessions: () => Promise<void>
  reloadModels: () => Promise<void>
  reloadCommands: () => Promise<void>
  /** 重新探测 pi 内核（版本 / 来源），pi 之前没找到时会顺便重新拉起 */
  redetectPi: () => Promise<void>
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
  /** 把队列里某条消息插队（提升为 steering，在当前这轮就听） */
  steerQueued: (text: string) => Promise<void>
  abort: () => Promise<void>
  runBash: (command: string) => Promise<void>
  abortBash: () => Promise<void>
  newSession: () => Promise<void>
  switchSession: (path: string) => Promise<void>
  renameSession: (name: string) => Promise<void>
  /** 给**任意**会话（含非当前会话）起一个手动名，粘性、不被自动标题覆盖 */
  setManualTitle: (sessionId: string, name: string) => Promise<void>
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
  cycleModelBack: () => Promise<void>
  cycleThinking: () => Promise<void>
  /** 把最后一条助手回复复制到剪贴板 */
  copyLastReply: () => Promise<void>
  changeCwd: (cwd: string) => Promise<void>
  /** 设界面缩放（0 = 自动） */
  setUiScale: (v: number) => Promise<void>
  openBrowser: (url?: string) => Promise<void>
  closeBrowser: () => Promise<void>
  /** 打开只读文件预览（相对路径由主进程按会话 cwd 解析） */
  previewFile: (path: string, line?: number) => Promise<void>
  closePreview: () => void
  /* ---- 子代理 ---- */
  loadSubagents: () => Promise<void>
  startSubagent: (task: string, model?: string) => Promise<void>
  stopSubagent: (id: string) => Promise<void>
  clearSubagents: () => Promise<void>
  openSubagent: (id: string | null) => void
  /** 接入本机已安装的 Chrome（独立 profile + CDP） */
  openExternalChrome: (url?: string) => Promise<void>
  /** 断开本机 Chrome（会关掉我们拉起的进程） */
  closeExternalChrome: () => Promise<void>
  /**
   * 重新同步本机 Chrome 的登录态与历史。
   * 返回逐项报告 —— 界面要如实说「哪几项没同步、为什么」。
   */
  syncLocalProfile: () => Promise<ChromeSyncReport>
  syncPageStorage: () => Promise<ChromeSyncReport>
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
  /** 拖入的普通文件：主进程校验 + 登记，然后作为「文件引用」附件入列 */
  addFileRefs: (files: File[]) => Promise<void>
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  pickImages: () => Promise<void>

  answerUi: (res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void
  /** 收起 / 展开问题面板（不取消请求） */
  setUiCollapsed: (v: boolean) => void
  /** 保存某个问题的草稿 */
  setUiDraft: (id: string, value: string) => void
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
  /** App 把它自己的滚动实现注册进来 */
  registerScrollToTurn: (fn: (i: number) => void) => void
  setSettingsTab: (tab: string) => void
  log: (line: string) => void
  dismissRequest: (id: string) => void
}

const EMPTY_QUEUE: QueueState = { steering: [], followUp: [] }

/** 右侧只读文件预览的界面状态 */
export interface FilePreviewState {
  /** 请求的原路径（展示 + 竞态比对用） */
  path: string
  line?: number
  loading: boolean
  data: FilePreview | null
}

/** 附件上限（方案 5.1：最多 20 个附件，图片合计 20MB） */
const MAX_ATTACHMENTS = 20
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 连接状态心跳是否已在跑（startConnWatch 单例，避免重复挂载开出多条） */
let connWatchActive = false

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
function patchMessage(list: UIMessage[], id: string, patch: MessagePatch): UIMessage[] {
  const i = list.findIndex((m) => m.id === id)
  if (i < 0) return list

  /*
   * 增量路径（流式文本走这里）。
   *
   * 为什么单独一支：`patch.textDelta` 是**追加**语义，不能跟
   * 「用 patch 覆盖」的写法混在一起 —— 若 patch 里既没有全量 text 又没有
   * delta，就只是普通字段更新。
   *
   * ⚠️ 这里**不改数组元素以外的东西**：找不到 id 时（例如渲染端刚 reload、
   *    错过了 msg-add）直接返回，不伪造消息 —— 主进程在 message_end / sync
   *    时会发全量快照，那时会补齐。
   */
  if (patch.textDelta === undefined && patch.thinkingDelta === undefined) {
    const next = list.slice()
    next[i] = { ...next[i], ...patch }
    return next
  }

  const cur = list[i]
  const { textDelta, thinkingDelta, ...rest } = patch
  const next = list.slice()
  next[i] = {
    ...cur,
    ...rest,
    ...(textDelta ? { text: (cur.text ?? '') + textDelta } : null),
    ...(thinkingDelta ? { thinking: (cur.thinking ?? '') + thinkingDelta } : null)
  }
  return next
}

/** 通知上限：超过就不显示。扩展刷屏时界面不能被遮没。 */
const MAX_NOTICES = 3

/** 统一的通知入口：去重 + 限流 + 保留最近 N 条 */
/**
 * 调一条 pi 命令，把「主进程抛错」归一成 `{ ok: false, error }`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须有这一层
 * ══════════════════════════════════════════════════════════════════
 * pi 没连接时，主进程的 handler 会 **throw**（`Error: pi 未运行`），
 * 于是 IPC invoke 直接 reject。而渲染端这些 action 原来都只判断
 * `if (!res.ok)`，**没有 try/catch** —— 结果是：
 *   · 未捕获的 promise rejection（控制台报错，用户什么都看不到）
 *   · **不进日志**，违背「所有报错都进日志」这条已确认的设计
 * 实测是 logs 探针抓到的（它故意触发一次必败操作，整个探针直接崩了）。
 *
 * 已经把「失败」当成返回值而不是异常的部分（如 setManualTitle）
 * 用的是 `.catch(() => ({ ok: false }))`，这里把它收成一个入口，
 * 免得同一个约定在几十处各写一遍。
 */
async function piCall<T extends { ok: boolean; error?: string }>(
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    /*
     * Electron 会把 IPC 异常的消息包成
     *   `Error invoking remote method 'yan:xxx': Error: pi 未运行`
     * 用户只需要后半句。把这层壳剥掉 —— 否则提示条和日志里全是这个前缀。
     */
    const raw = e instanceof Error ? e.message : String(e)
    const error = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
    /*
     * 断言成 T：失败时只保证 ok/error 这两个字段（调用方判断 `!res.ok`
     * 之后就不会再读别的）。用 any 或联合类型会让每一处调用都要
     * 额外窄化，几十处全是噪声。
     */
    return { ok: false, error } as T
  }
}

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

export const useStore = create<Store>((rawSet, get) => {
  /*
   * 包装 set：凡是新增的 **error 通知**，同时写一份进日志抽屉
   * （用户要求「所有报错都要显示到日志模块内」）。
   * 这样各处 `set({ notices: pushNotice(..., 'error', ...) })` 不用逐处改，
   * 以后新加的报错也自动进日志。
   */
  const set = (partial: Partial<Store>): void => {
    rawSet((state) => {
      const notices = partial.notices
      if (notices && notices !== state.notices) {
        const added = notices.filter(
          (n) => n.type === 'error' && !state.notices.some((o) => o.id === n.id)
        )
        if (added.length) {
          return {
            ...partial,
            logs: [...(partial.logs ?? state.logs), ...added.map((n) => `[错误] ${n.text}`)].slice(-200)
          }
        }
      }
      return partial
    })
  }
  return {
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
  activeRunnerId: null,
  runners: [],

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
  titles: {},
  manualTitles: {},
  maximized: false,
  alwaysOnTop: false,
  browserState: { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
  filePreview: null,
  subagents: [],
  subagentPreviewId: null,
  zoom: null,
  scrollToTurn: () => {
    /* App 挂载后会用 registerScrollToTurn 覆盖 */
  },
  uiRequests: [],
  uiCollapsed: false,
  uiDrafts: {},
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
    /*
     * ⚠️ 连接状态（conn）**不在这里拉、也不在这里写**。
     *
     * 曾经的写法是把 api.agentStatus() 混在这批 Promise.all 里，再
     * `set({ conn: status.state })`。看起来没问题，实际上是个隐蔽的竞态：
     * 这一批里的 listSessions / piInfo / getMessages 都很慢（要扫会话文件、
     * 起 `pi --version`、解析大会话），agentStatus 的返回值是**发起时**的快照
     * （往往是 'starting'），而 set 要等所有慢调用都回来才执行。
     * 与此同时 startConnWatch 可能早就拉到 'ready' 并停止轮询了 ——
     * 于是这次迟到的 set 把 ready **降级回 starting**，且再没人纠正，
     * 界面就永远停在「正在启动 pi」。
     *
     * 连接状态交给 startConnWatch 独占（它轮询到 ready 为止），
     * 接口少了这个字段、也就没有降级的可能。
     */
    const [settings, sessions, session, messages, stats, todos, titles, manualTitles, pi, browserState] =
      await Promise.all([
        api.getSettings(),
        api.listSessions(),
        api.getState(),
        api.getMessages(),
        api.getStats(),
        api.refreshTodos().catch(() => [] as SessionTodo[]),
        api.cachedTitles().catch(() => ({}) as Record<string, string>),
        api.manualTitles().catch(() => ({}) as Record<string, string>),
        // pi 入口 / 版本（右栏「环境」分区）——探测失败不能影响启动
        api.piInfo().catch(() => null),
        api.browser.getState().catch(() => ({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false } as BrowserState))
      ])

    set({
      settings,
      sessions,
      session: session ?? get().session,
      messages: messages.length ? messages : get().messages,
      stats: stats ?? get().stats,
      todos,
      titles,
      manualTitles,
      piInfo: pi,
      browserState
    })

    // 模型 / 斜杠命令在启动后单独拉（要等 pi ready）
    void get().reloadModels()
    // 界面缩放现状（设置面板要显示「自动 = 1.15×，屏幕 125%」）
    void get().loadZoom()
    void get().reloadCommands()
    /* 运行实例身份与状态（N12）：bootstrap 后对齐一次 */
    void get().syncRunners()
  },

  /**
   * 对齐运行实例状态（N12）。
   *
   * 两件事：拉一次完整状态（补上可能错过的 `runners` 推送），
   * 并把当前视图的实例 id 对齐到主进程认为的 active。
   */
  syncRunners: async () => {
    try {
      const list = await window.yan.runnerStatuses()
      const active = list.find((r) => r.isActive)
      set({ runners: list, ...(active ? { activeRunnerId: active.id } : {}) })
    } catch {
      /* 主进程还没起来 —— 下一帧会有推送 */
    }
  },

  applyPush: (m) => {
    const s = get()

    /*
     * 实例身份过滤（N12）。
     *
     * 带 `sessionKey` 的消息只属于某一个运行实例：
     *   · 还没对齐身份（初始化第一帧）→ 以第一条为当前视图；
     *   · 与当前视图不一致 → **丢弃**（后台会话的输出不进当前界面）。
     *     切回去时主进程会给完整快照，所以丢弃不会丢内容。
     * 全局推送（设置 / 缩放 / 浏览器 / runners）不带 key，不受影响。
     */
    if (m.sessionKey) {
      if (!s.activeRunnerId) set({ activeRunnerId: m.sessionKey })
      else if (s.activeRunnerId !== m.sessionKey) return
    }

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
      case 'runners':
        /* 全局快照（N12）：左栏状态槽用。不参与上面的实例身份过滤 */
        set({ runners: m.payload })
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
      case 'browser-state':
        set({ browserState: m.payload })
        break
      case 'log':
        // 主进程未捕获异常 / 未处理 Promise：与 pi stderr 共用同一条日志抽屉，
        // 不再走 Electron 的原生错误弹框。
        set({ logs: [...s.logs, m.payload.text].slice(-200) })
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
        const { msgId, call, outputDelta } = m.payload
        const msg = s.messages.find((x) => x.id === msgId)
        if (!msg) break
        const calls = (msg.toolCalls ?? []).slice()
        const i = calls.findIndex((c) => c.id === call.id)
        /*
         * 增量输出（append）与「整条替换」两条路。
         *
         * ⚠️ 增量时**必须**基于本地已有的 output 拼接，而不是信任 call.output：
         *    主进程发增量时不会再传那份越来越长的全量输出（那正是要避免的开销）。
         */
        if (i >= 0) {
          const base = calls[i]
          const merged: UIToolCall = { ...base, ...call }
          if (outputDelta) merged.output = (base.output ?? '') + outputDelta
          calls[i] = merged
        } else {
          calls.push(outputDelta ? { ...call, output: outputDelta } : call)
        }
        set({ messages: patchMessage(s.messages, msgId, { toolCalls: calls }) })
        break
      }
      case 'state': {
        /*
         * 完成提示音：agent 从「在跑」变成「停了」。
         *
         * 为什么比对前后两个 isAgentRunning 而不是直接听 agent_settled：
         * 渲染端本来就收不到 pi 的原始事件（协议知识只在主进程），
         * 而 agent_settled 在主进程已经归一到这次 state 推送里了。
         *
         * 加 sessionId 判断：切会话时也可能从「在跑」变「没跑」，
         * 那不是「完成」，不能响。
         */
        const finished =
          s.session?.sessionId === m.payload.sessionId &&
          s.session?.isAgentRunning === true &&
          m.payload.isAgentRunning !== true
        set({ session: m.payload })
        if (finished) {
          const sid = s.session?.sessionId
          const label = (sid && (s.manualTitles[sid] || s.titles[sid])) || s.session?.sessionName || ''
          alertAttention(s.settings, 'done', label || undefined)
        }
        if (m.payload.availableThinkingLevels?.length) {
          set({ thinkingLevels: m.payload.availableThinkingLevels })
        }
        break
      }
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
      case 'subagent': {
        /* 整条快照覆盖 / 追加（主进程已把转录限制在 200 条以内） */
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
      case 'subagent-remove':
        set({
          subagents: s.subagents.filter((r) => r.id !== m.payload),
          subagentPreviewId: s.subagentPreviewId === m.payload ? null : s.subagentPreviewId
        })
        break
      case 'ui-request':
        /* 新问题到达 → 自动展开面板（用户收起了也不该把新问题藏起来） */
        set({ uiRequests: [...s.uiRequests, m.payload], uiCollapsed: false })
        // 需要用户介入（模型提问 / 扩展要选择）—— 提示音 + 通知
        alertAttention(s.settings, 'question', m.payload.message ?? m.payload.title)
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
        // 报错才出声：info/告警不打断
        if ((m.payload.notifyType ?? 'info') === 'error') alertAttention(s.settings, 'error', text)
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
          const detail = m.payload.detail ?? '未知错误'
          set({
            conn: 'error',
            connDetail: detail,
            // pi 进程级错误也要进日志（用户要求「所有报错进日志」）
            logs: [...s.logs, `[错误] pi 进程：${detail}`].slice(-200),
            ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
          })
          alertAttention(s.settings, 'error', detail)
        } else if (m.payload.state === 'stderr' && m.payload.detail) {
          // stderr 只留最近 200 行，避免内存涨
          set({ logs: [...s.logs, m.payload.detail].slice(-200) })
        }
        break
    }
  },

  refreshSessions: async () => {
    /*
     * ⚠️ 「拉取类」动作全部包 try/catch。
     *
     * pi 没起来时主进程的 handler 会 throw，IPC 因此 reject —— 这些动作
     * 原来直接 await，于是变成未捕获的 promise rejection：控制台报错、
     * 界面什么都不更新、用户看不出原因（logs / slashcmd 探针各抓到一处）。
     * 拿不到就保持原状，等连接恢复后 startConnWatch 会再拉一次。
     */
    try {
      set({ sessions: await window.yan.listSessions() })
    } catch {
      /* 保持原状 */
    }
  },

  reloadModels: async () => {
    try {
      const [models, thinkingLevels] = await Promise.all([
        window.yan.listModels(),
        window.yan.listThinkingLevels()
      ])
      set({ models, thinkingLevels })
    } catch {
      /* pi 未就绪：保持上一次的列表（可能是空的） */
    }
  },

  reloadCommands: async () => {
    try {
      set({ commands: await window.yan.listCommands(), commandsAt: Date.now() })
    } catch {
      /* 同上 */
    }
  },

  redetectPi: async () => {
    const info = await window.yan.redetectPi().catch(() => null)
    if (info) set({ piInfo: info })
    // pi 刚被拉起来时，连接状态与模型列表都要重新拉
    const status = await window.yan.agentStatus().catch(() => null)
    if (status) set({ conn: status.state, connDetail: status.detail })
    void get().reloadModels()
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
    const res = await piCall(() => window.yan.send(text, images))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '发送失败') })
    }
  },

  steerQueued: async (text) => {
    const res = await piCall(() => window.yan.steerQueued(text))
    if (!res.ok) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? '插队失败')
      })
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
    const res = await piCall(() => window.yan.runBash(command))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '命令执行失败') })
    }
  },

  abortBash: async () => {
    await window.yan.abortBash()
  },

  newSession: async () => {
    const res = await piCall(() => window.yan.newSession())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '新建失败') })
      return
    }
    /*
     * N12：新会话可能落在**新实例**上（当前实例忙着的时候）。
     * 不先对齐 id，新实例的 sync/state 会被身份过滤当成「后台会话」丢掉。
     */
    if (res.id) set({ queue: EMPTY_QUEUE, activeRunnerId: res.id, messages: [] })
    else set({ queue: EMPTY_QUEUE })
    void get().syncRunners()
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

    // ② 切视图（N12：命中运行实例就只是切换订阅，**不停任何**会话）
    const sum = get().sessions.find((x) => x.path === path)
    const cwd = sum?.cwd || get().session?.cwd || get().settings?.cwd || ''
    const res = await piCall(() => window.yan.selectSession({ sessionFile: path, cwd }))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '切换失败'), peekedPath: null })
      return
    }
    set({ queue: EMPTY_QUEUE, ...(res.id ? { activeRunnerId: res.id } : {}) })
    void get().syncRunners()
    void get().reloadModels()
  },

  renameSession: async (name) => {
    const res = await piCall(() => window.yan.renameSession(name))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '重命名失败') })
      return
    }
    await get().refreshSessions()
  },

  /**
   * 给会话起手动名（任意会话）。
   *
   * 为什么要单独一条（而不是都走 renameSession）：
   *   · pi 的 set_session_name 只能改**当前**会话；
   *   · 而且“自动标题”每轮都会重生 —— 不锁住的话手动名立刻被盖掉。
   * @param sessionId 会话 id（空 = 当前会话）
   * @param name      新名字
   */
  setManualTitle: async (sessionId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const state = get()
    const sid = sessionId || state.session?.sessionId || ''
    if (sid) {
      const next = { ...state.manualTitles, [sid]: trimmed }
      set({ manualTitles: next })
      // 同步给 pi（仅当前会话），失败不影响本地名生效
      if (sid === state.session?.sessionId) {
        await piCall(() => window.yan.renameSession(trimmed))
      }
      await window.yan.setManualTitle(sid, trimmed).catch(() => ({ ok: false }))
    }
    await get().refreshSessions()
  },

  deleteSession: async (path) => {
    const res = await piCall(() => window.yan.deleteSession(path))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '删除失败') })
      return
    }
    await get().refreshSessions()
  },

  fork: async (entryId) => {
    const res = await piCall(() => window.yan.fork(entryId))
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
    const res = await piCall(() => window.yan.clone())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '复制失败') })
      return
    }
    set({ queue: EMPTY_QUEUE, notices: pushNotice(get().notices, 'info', '已复制到新会话') })
    await get().refreshSessions()
  },

  exportHtml: async () => {
    const res = await piCall(() => window.yan.exportHtml())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '导出失败') })
      return
    }
    set({
      notices: pushNotice(get().notices, 'info', `已导出：${res.path ?? ''}（已用系统默认程序打开）`)
    })
  },

  compact: async () => {
    const res = await piCall(() => window.yan.compact())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '压缩失败') })
    }
  },

  stop: async () => {
    await window.yan.abort()
  },

  /* --------------------------------------------------- 模型 / 思考 / 目录 */

  setModel: async (provider, id) => {
    const res = await piCall(() => window.yan.setModel(provider, id))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '切换模型失败') })
    }
  },

  setThinking: async (level) => {
    await window.yan.setThinking(level)
  },

  setAutoCompaction: async (on) => {
    const res = await piCall(() => window.yan.setAutoCompaction(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
    }
  },

  setAutoRetry: async (on) => {
    const res = await piCall(() => window.yan.setAutoRetry(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
    }
  },

  /* --------------------------------------------- 队列模式 / 轮换 / 重试 */

  setSteeringMode: async (mode) => {
    const res = await piCall(() => window.yan.setSteeringMode(mode))
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? '设置失败') })
  },

  setFollowUpMode: async (mode) => {
    const res = await piCall(() => window.yan.setFollowUpMode(mode))
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
    const res = await piCall(() => window.yan.cycleModel())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? '无法切换模型') })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', '模型 → ' + res.to) })
    }
  },

  /** 反向切模型（Ctrl+Shift+P） */
  cycleModelBack: async () => {
    const res = await piCall(() => window.yan.cycleModelBack())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? '无法切换模型') })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', '模型 → ' + res.to) })
    }
  },

  cycleThinking: async () => {
    const res = await piCall(() => window.yan.cycleThinking())
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
    let text: string | null = null
    try {
      text = await window.yan.lastAssistantText()
    } catch {
      /* pi 未就绪：下面按「没有可复制的回复」处理，比抛未捕获异常好 */
    }
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
    const res = await piCall(() => window.yan.setCwd(cwd))
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

  openBrowser: async (url) => {
    /*
     * 浏览器与文件预览占同一块区域，而且原生网页视图永远盖在 DOM 之上 ——
     * 打开浏览器时先把预览收掉，否则会看到「预览在下面、网页在上面」的叠影。
     */
    if (get().filePreview) set({ filePreview: null })
    try {
      set({ browserState: await window.yan.browser.open(url) })
    } catch (error) {
      set({ notices: pushNotice(get().notices, 'error', error instanceof Error ? error.message : '打开浏览器失败') })
    }
  },

  closeBrowser: async () => {
    set({ browserState: await window.yan.browser.close() })
  },

  /*
   * 只读文件预览（方案 5.2）。
   *
   * ⚠️ 原生 `WebContentsView` 永远盖在 DOM 之上：浏览器开着的时候，
   *    光在 DOM 里画一个预览面板是**看不见**的，必须让主进程
   *    把原生视图 setVisible(false)；关预览时再恢复。
   */
  previewFile: async (path, line) => {
    set({ filePreview: { path, line, loading: true, data: null } })
    if (get().browserState.open) void window.yan.browser.setVisible(false)
    const data = await window.yan.readPreview(path, line)
    /* 期间用户可能已经换了别的文件 / 关掉了预览：只认最后一次请求 */
    const cur = get().filePreview
    if (!cur || cur.path !== path || cur.line !== line) return
    set({ filePreview: { path, line, loading: false, data } })
  },

  closePreview: () => {
    set({ filePreview: null })
    /* 浏览器还开着 → 把原生视图恢复出来 */
    if (get().browserState.open) void window.yan.browser.setVisible(true)
  },

  /* ---- 子代理（方案第 8 节）---- */
  loadSubagents: async () => {
    try {
      set({ subagents: await window.yan.subagents.list() })
    } catch {
      /* 拿不到就当没有 —— 不该因为子代理把界面弄崩 */
    }
  },

  startSubagent: async (task, model) => {
    const res = await window.yan.subagents.start(task, model)
    if (!res.ok) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? '子代理启动失败')
      })
      return
    }
    /* 新跑起来的那条默认打开详情，用户不用再点一下 */
    if (res.run) {
      const run = res.run
      const idx = get().subagents.findIndex((r) => r.id === run.id)
      set({
        subagents: idx >= 0 ? get().subagents.map((r) => (r.id === run.id ? run : r)) : [...get().subagents, run],
        subagentPreviewId: run.id
      })
    }
  },

  stopSubagent: async (id) => {
    const res = await window.yan.subagents.stop(id)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '停止子代理失败') })
    }
  },

  clearSubagents: async () => {
    await window.yan.subagents.clearFinished()
  },

  openSubagent: (id) => set({ subagentPreviewId: id }),

  openExternalChrome: async (url) => {
    const res = await window.yan.browser.openExternalChrome(url)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? '接入本机 Chrome 失败') })
      return
    }
    // 接入后主进程会把 state.open 置 true，面板会切到浏览器模式
    set({ browserState: await window.yan.browser.getState() })
  },

  closeExternalChrome: async () => {
    set({ browserState: await window.yan.browser.closeExternalChrome() })
  },

  syncLocalProfile: async () => {
    const report = await window.yan.browser.syncLocalProfile()
    /*
     * 同步后主进程可能重启了外部 Chrome（为让 cookie 生效），
     * 所以重新拉一次状态，而不是假定旧状态还成立。
     */
    set({ browserState: await window.yan.browser.getState() })
    return report
  },
  syncPageStorage: async () => {
    const report = await window.yan.browser.syncPageStorage()
    set({ browserState: await window.yan.browser.getState() })
    return report
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
    // 文件引用带上 path —— 同名同大小的两个不同文件是两个附件
    const seen = new Set(existing.map((e) => `${e.name}|${e.size}|${e.path ?? ''}`))
    const fresh: Attachment[] = []
    for (const x of a) {
      const k = `${x.name}|${x.size}|${x.path ?? ''}`
      if (seen.has(k)) continue
      seen.add(k)
      fresh.push(x)
    }
    if (fresh.length === 0) return

    /* 首期上限：最多 20 个附件（方案 5.1） */
    let next = [...existing, ...fresh].slice(0, MAX_ATTACHMENTS)

    /*
     * 图片合计上限 20MB（方案 5.1）。
     * 超出的**新图**不收（已经有的一样不删），并明确告知 ——
     * 不能默默丢掉用户刚拖进来的东西。
     */
    const imgBytes = next.filter((x) => x.kind !== 'file').reduce((n, x) => n + x.size, 0)
    if (imgBytes > MAX_IMAGE_BYTES) {
      const kept: Attachment[] = []
      let acc = 0
      for (const x of next) {
        if (x.kind === 'file') {
          kept.push(x)
          continue
        }
        if (acc + x.size > MAX_IMAGE_BYTES) continue
        acc += x.size
        kept.push(x)
      }
      next = kept
      set({ notices: pushNotice(get().notices, 'error', '图片合计超过 20MB，已跳过放不下的那些') })
    }

    set({ attachments: next })
  },

  addFileRefs: async (files) => {
    if (!files.length) return
    /*
     * Electron 里 `File` 拿不到 path，必须走 preload 的 webUtils
     * （见 preload/index.ts 的说明）。
     */
    const paths: string[] = []
    for (const f of files) {
      try {
        const p = window.yan.pathForFile(f)
        if (p) paths.push(p)
      } catch {
        /* 拿不到路径的单个文件跳过，下面统一提示 */
      }
    }
    if (!paths.length) {
      set({ notices: pushNotice(get().notices, 'error', '拿不到文件路径，无法加入上下文') })
      return
    }

    /* 校验 + 登记在主进程（工作区外也允许，但只在本进程内有效） */
    const infos = await window.yan.describeFiles(paths)
    const refs: Attachment[] = []
    const errors: string[] = []
    for (const info of infos) {
      if (!info.ok) {
        errors.push(`${info.name}：${info.error ?? '无法引用'}`)
        continue
      }
      refs.push({
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: info.name,
        mimeType: info.mimeType,
        size: info.size,
        data: '',
        preview: '',
        kind: 'file',
        path: info.path
      })
    }
    if (refs.length) get().addAttachments(refs)
    if (errors.length) set({ notices: pushNotice(get().notices, 'error', errors.join('；')) })
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
    const drafts = { ...get().uiDrafts }
    delete drafts[res.id]
    set({ uiRequests: get().uiRequests.filter((r) => r.id !== res.id), uiDrafts: drafts })
  },

  setUiCollapsed: (v) => set({ uiCollapsed: v }),

  setUiDraft: (id, value) => set({ uiDrafts: { ...get().uiDrafts, [id]: value } }),

  dismissRequest: (id) => {
    // 超时的对话框：不回应答（pi 侧会自己超时），只从列表移除
    const drafts = { ...get().uiDrafts }
    delete drafts[id]
    set({ uiRequests: get().uiRequests.filter((r) => r.id !== id), uiDrafts: drafts })
  },

  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  consumeEditorInject: () => set({ editorInject: null }),
  consumeQueueRestore: () => set({ queueRestore: null }),
  setSettings: (s) => set({ settings: s }),
  startConnWatch: () => {
    /*
     * 连接状态自愈（单例心跳）。
     *
     * 为什么不能「拉到 ready 就彻底退出」也不「拉一会儿就放弃」：
     *   `proc: ready` / `proc: starting` 都是**一次性 push**，渲染端一旦
     *   错过（加载慢、窗口重载、主进程在 webContents 就绪前就发了），
     *   就再也收不到。之前这里 80 次（~40s）就 return ——
     *   一旦这 40s 里的拉取恰好都落在主进程 ready 之前，界面就**永久**
     *   停在「正在启动 pi」，而 pi 其实早就好了。
     *   拉取成本极低（一个同步取值 + 一次 IPC），所以常驻：
     *     · 未 ready：前 10s 每 500ms，之后每 3s
     *     · 已 ready：每 5s 核对一次（防某次重启的 ready push 丢了）
     */
    if (connWatchActive) return
    connWatchActive = true
    let tries = 0
    const tick = async (): Promise<void> => {
      const cur = get().conn
      try {
        const st = await window.yan.agentStatus()
        if (st && st.state !== get().conn) set({ conn: st.state, connDetail: st.detail })
      } catch {
        /* 主进程可能还没注册 handler，下一轮再来 */
      }
      const delay = cur === 'ready' ? 5000 : tries++ < 20 ? 500 : 3000
      setTimeout(() => void tick(), delay)
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
  registerScrollToTurn: (fn) => set({ scrollToTurn: fn }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  log: (line) => set({ logs: [...get().logs, line].slice(-200) })
  }
})
