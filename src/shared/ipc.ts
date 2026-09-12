/**
 * 主进程 ↔ 渲染进程的共享类型。
 *
 * 这一层刻意**不认识 pi 的内部类型** —— pi 的 message 结构在这里被归一化成
 * UIMessage。协议怎么变，只改 src/main/prompt.ts 一侧的适配（见 HANDOFF §9 原则 2）。
 */

/* ==================================================================
   RPC
   ================================================================== */

/** 带 id 的请求 → 响应关联 */
export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/* ==================================================================
   消息（渲染用）
   ================================================================== */

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0
}

/** 工具调用（来自 assistant 的 toolCall 内容块，或 tool_execution_* 事件） */
export interface UIToolCall {
  id: string
  name: string
  args: unknown
  /** 流式参数累积的原始 JSON 片段（未解析成功时用于显示） */
  argsRaw?: string
  status: 'pending' | 'running' | 'ok' | 'error'
  /** 已累积的输出文本 */
  output?: string
  /** 结构化详情（diff / 截断信息等） */
  details?: unknown
  startedAt?: number
  endedAt?: number
}

export interface UIMessage {
  id: string
  role: 'user' | 'assistant' | 'bash'
  /** 正文文本（assistant 可能持续增长） */
  text: string
  /** 用户随消息附的图片（base64，不含 data: 前缀） */
  images?: { mimeType: string; data: string }[]
  /** 思考文本 */
  thinking?: string
  thinkingMs?: number
  toolCalls?: UIToolCall[]
  usage?: Usage
  /**
   * 本轮的**输出速度**（token/秒）。
   *
   * 只在拿到真实 usage 时才有 —— 有的 provider 在流式期间不报 usage，
   * 那就宁可空着，也不用「字符数 ÷ 时间」去猜（猜出来的数字看着精确，其实是编的）。
   */
  speed?: number
  /** 本轮从开始生成到结束的墙钟耗时（ms），含工具往返 */
  elapsedMs?: number
  /** 该消息是否属于某次工具结果的容器（不渲染为独立消息） */
  model?: string
  timestamp?: number
  /** bash 直执行（RPC bash 命令，非 LLM 工具） */
  bash?: { command: string; exitCode: number | null; cancelled: boolean }
  error?: string
}

/**
 * 队列投递模式（pi 的 set_steering_mode / set_follow_up_mode）。
 *   all            当前回合的工具跑完后，一次把排队的全投进去
 *   one-at-a-time  每完成一个回合投一条（pi 的默认值）
 */
export type QueueMode = 'all' | 'one-at-a-time'

/** pi 进程 / 版本信息（右栏「环境」分区用） */
export interface PiInfo {
  /** 找到的 pi 入口 */
  bin: string
  version?: string
  /** pi 包所在目录（显示用） */
  home?: string
}

/** 会话状态快照（get_state 的归一化） */
export interface SessionState {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  model?: ModelInfo
  thinkingLevel: string
  availableThinkingLevels: string[]
  isStreaming: boolean
  isCompacting: boolean
  messageCount: number
  pendingMessageCount: number
  cwd: string
  autoCompactionEnabled?: boolean
  steeringMode?: QueueMode
  followUpMode?: QueueMode
}

/** 可 fork 的用户消息（get_fork_messages） */
export interface ForkPoint {
  entryId: string
  text: string
}

/** 斜杠命令（get_commands） */
export interface SlashCommand {
  name: string
  description?: string
  source: string
  location?: string
}

/** 待发送的图片附件 */
export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  /** 不带 data: 前缀的裸 base64 */
  data: string
  /** 预览用（与 data 相同，单独字段只是为了语义清楚） */
  preview: string
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  reasoning: boolean
  contextWindow: number
  maxTokens?: number
}

export interface SessionStats {
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
  toolCalls: number
  userMessages: number
  assistantMessages: number
}

/** 每个直执行 bash 任务的状态（RPC bash，不走 LLM） */
export interface BashRun {
  id: string
  command: string
  output: string
  running: boolean
  exitCode: number | null
  truncated?: boolean
  fullOutputPath?: string
}

/** 队列状态（queue_update） */
export interface QueueState {
  steering: string[]
  followUp: string[]
}

/**
 * 扩展写进会话的任务清单（
 * 例如用户自己的 `left-info-panel.ts` 用 `pi.appendEntry('left-panel-tasks', {todos})`）。
 *
 * 为什么要读它：`panel_todos` 工具是 agent 用来维护进度的手段，
 * 如果桌面端不显示，agent 调了也是白调 —— 用户看不到。
 */
export interface SessionTodo {
  text: string
  done: boolean
}

/** 会话里的一条 custom entry（扩展写的任意数据） */
export interface CustomEntry {
  id: string
  customType: string
  data: unknown
}

/* ==================================================================
   会话列表
   ================================================================== */

export interface SessionSummary {
  id: string
  path: string
  cwd: string
  /** 优先用 session_info 里的名字，没有才退回首条用户消息 */
  title: string
  /** 是否用的是用户起的名字（而不是首条消息） */
  named: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
  model?: string
}

/**
 * 会话预览的结果（不经过 pi 的直读）。
 *
 * `truncated > 0` 时界面应提示「有内容被省略」——
 * 因为大会话里 75% 的体积是超长 tool result / base64 图片，
 * 那些被**有损降级**了（见 main/session-reader.ts）。
 */
export interface PeekResult {
  messages: UIMessage[]
  /** 文件里一共多少条 message entry */
  total: number
  /** 被截断/丢弃的内容条数 */
  truncated: number
  /** 文件字节数 */
  bytes: number
}

/**
 * 会话预览的结果（不经过 pi 的直读）。
 *
 * `truncated > 0` 时界面应提示「有内容被省略」——
 * 因为大会话里 75% 的体积是超长 tool result / base64 图片，
 * 那些被**有损降级**了（见 main/session-reader.ts）。
 */
export interface PeekResult {
  messages: UIMessage[]
  /** 文件里一共多少条 message entry */
  total: number
  /** 被截断/丢弃的内容条数 */
  truncated: number
  /** 文件字节数 */
  bytes: number
}

/* ==================================================================
   模型接入（凭证）
   ================================================================== */

/** 能不能用：ready = 有可用凭证 */
export type AuthStatus = 'ready' | 'missing' | 'unknown'

/** 接入方式：订阅制（OAuth）还是 API key */
export type AuthKind = 'subscription' | 'api_key'

export interface AuthProviderInfo {
  id: string
  name: string
  kind: AuthKind
  /** 一句话说明（为什么选它 / 有什么坑） */
  hint: string
  /** 对应的环境变量名（空 = 该方式不走环境变量） */
  envVar: string
  /** 在 auth.json 里的键名（空 = 由 pi 的 OAuth 流程自己定） */
  authKey: string
  /** 订阅制需要跑的命令（目前统一是 `pi`，然后在里面 `/login`） */
  loginCmd?: string
  status: AuthStatus
  /**
   * 凭证从哪里来的（status='ready' 时才有意义）。
   *
   * 为什么要把这个告诉界面：用户用**环境变量**配的 key 与写在 auth.json 里的
   * 是两个不同的东西 —— 前者在设置里「移除」不了（要去改环境变量），
   * 不区分的话界面上会给出一个点了没用的「退出」按钮。
   */
  source?: 'auth.json' | 'env'
}

/* ==================================================================
   记忆 —— 砚的核心
   ================================================================== */

/**
 * fact  = 已确认（来源：你）
 * guess = 我的印象（来源：我，未确认）
 *
 * 这个区分是整个产品的认识论基础，不是视觉标签。
 * 只有 confirmed 过的记忆才会被注入系统提示词。
 */
export type MemoryKind = 'fact' | 'guess'
export type MemorySource = 'you' | 'me'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  text: string
  source: MemorySource
  /** 主题/分类，用于「人」「项目」等分组；缺省归入「关于你」 */
  topic: string
  createdAt: number
  updatedAt: number
  confirmedAt?: number
  /** 来自哪个会话（可追溯） */
  sessionId?: string
}

/* ==================================================================
   设置
   ================================================================== */

export interface AppSettings {
  cwd: string
  theme: 'dark' | 'light'
  lang: 'zh-CN' | 'en-US'
  memoryOrder: string[]
  /** 手动指定 pi 入口（自动探测失败时用） */
  piBin?: string
  /** 最近使用的目录 */
  recentCwds: string[]
  /** 右栏是否展开（默认展开，可用标题栏按钮或右栏的关闭按钮收起） */
  rightPanelOpen: boolean
  /**
   * 窗口是否置顶。
   *
   * 默认 **false** —— 置顶是个强干扰行为（挡住所有其它窗口），
   * 不能偷偷默认开。用户主动开了才记住。
   */
  alwaysOnTop: boolean
  /**
   * 界面缩放倍率。**0 = 自动**（按所在屏幕的缩放算，见 main/zoom.ts）。
   *
   * 为什么默认自动：Electron 会跟随系统 DPI，但设计基准 12.5px 在 125%
   * 下会落在 15.625 设备像素（非整数）→ 中文发虚、偏小。
   * 自动模式把它对齐到整数设备像素并放大到舒适尺寸。
   */
  uiScale: number
  /** 左栏底部的用户档案（名字 / 头像 / 登录预留） */
  profile: UserProfile
  /**
   * 左栏宽度（px）。
   *
   * **0 = 用设计默认值**（300），而不是把 300 写死进设置文件 ——
   * 这样以后调默认值时，没手动改过宽度的用户会跟着变，
   * 改过的人保留自己的值。右栏同理。
   */
  railWidth: number
  /** 工具栏宽度（px）。0 = 用设计默认值 */
  panelWidth: number
  /**
   * 工具栏分区的显示顺序（存 id）。
   *
   * **空数组 = 用设计默认顺序** —— 与 railWidth 同一个思路：
   * 以后调整默认顺序时，没手动改过的人会跟着变。
   * 数组中出现的未知 id 会被忽略（版本升级后旧 id 可能有变动）。
   */
  toolOrder: string[]
  /**
   * 被收进「工具库」的分区 id（即不在工具栏里显示的）。
   * 在这里面的分区不是删除，随时可以从库里拿回来。
   */
  toolHidden: string[]
}

/**
 * 工具栏分区的 id。
 *
 * 为什么放 shared：主进程要拿它**校验**设置文件里的顺序/隐藏集合
 * （未知 id 直接丢掉，否则版本升级后旧 id 会一直占位），
 * 渲染端要按它排默认顺序。两处必须用同一份定义。
 */
export const TOOL_SECTIONS = ['context', 'todo', 'queue', 'files', 'ext', 'log', 'actions'] as const
export type ToolSectionId = (typeof TOOL_SECTIONS)[number]

/** 把设置里读到的顺序规范化：只留合法 id、去重、并补上缺的（按默认相对位置放后面） */
export function normalizeToolOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const known = new Set<string>(TOOL_SECTIONS)
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || !known.has(x) || seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  // 缺的按默认顺序补在后面（新版本新增分区时，老用户的顺序不会把新分区弄丢）
  for (const id of TOOL_SECTIONS) if (!seen.has(id)) out.push(id)
  return out
}

/** 隐藏集合：只留合法 id、去重 */
export function normalizeToolHidden(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const known = new Set<string>(TOOL_SECTIONS)
  const seen = new Set<string>()
  for (const x of v) {
    if (typeof x === 'string' && known.has(x)) seen.add(x)
  }
  return [...seen]
}

/**
 * 面板宽度的允许区间。
 *
 * ⚠️ 放在 shared 是因为**两边都要夹**：
 *   主进程在落盘时夹（防设置文件被手改成脏值），
 *   渲染端在拖动时也要夹 —— 不夹的话拖过头会产生 `-9439px` 这种非法值，
 *   而非法值会让 `grid-template-columns` 整条声明失效（那一拖就完全没反应）。
 */
export const RAIL_MIN = 220
export const RAIL_MAX = 560
export const PANEL_MIN = 220
export const PANEL_MAX = 560

/** 夹一个合法的面板宽度；0 / 非数字都当「用默认」 */
export function clampPanelWidth(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(max, Math.max(min, n)))
}

/**
 * 用户档案（左栏底部那个块）。
 *
 * ── 为什么全部本地存储 ──
 * 登录功能**尚未接入**（本地模式）。这里刻意不做一个假的「已登录」状态 ——
 * 本项目的约定是「界面上出现的每个值都必须真的来自某个地方」。
 * 所以 `signedIn` 恒为 false，界面上显示的是「本地模式」，
 * 点登录会明确告知未接入。字段先留着，接入时不用改数据结构。
 */
export interface UserProfile {
  /** 显示名。空 = 回落到系统用户名（见 main/settings.ts 的 DEFAULTS 推导） */
  name: string
  /** 头像形式：首字（letter）或内置图标（icon） */
  avatarKind: 'letter' | 'icon'
  /** letter 时用名字首字（空则用默认）；icon 时是图标名 */
  avatarValue: string
  /** 头像底色色相（0–360）。-1 = 用默认中性色 */
  avatarHue: number
  /**
   * 是否已登录。
   * ⚠️ **本地模式恒为 false** —— 登录尚未接入，不做假状态。
   */
  signedIn: boolean
}

/** 探测 pi 的结果，用于诊断 */
export interface PiProbe {
  ok: boolean
  cmd: string
  args: string[]
  version?: string
  error?: string
  tried: string[]
}

/* ==================================================================
   扩展 UI 桥
   ================================================================== */

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text'

export interface ExtensionUiRequest {
  id: string
  method: ExtensionUiMethod
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  notifyType?: 'info' | 'warning' | 'error'
  statusKey?: string
  statusText?: string
  widgetKey?: string
  widgetLines?: string[]
  widgetPlacement?: 'aboveEditor' | 'belowEditor'
  text?: string
  timeout?: number
}

/* ==================================================================
   主进程 → 渲染进程 的推送
   —— 全部是**已归一化**的 UI 补丁。渲染端不认识 pi 的协议细节，
      协议知识只存在于 src/main/agent.ts 一处。
   ================================================================== */

export interface ToolPatch {
  /** 工具调用属于哪条消息 */
  msgId: string
  call: UIToolCall
}

export type MainPush =
  /** 全量替换消息列表（启动 / 切会话 / compact 之后） */
  | { ch: 'sync'; payload: UIMessage[] }
  /** 新增一条消息 */
  | { ch: 'msg-add'; payload: UIMessage }
  /** 增量更新一条消息（流式文本会高频触发） */
  | { ch: 'msg-update'; payload: { id: string; patch: Partial<UIMessage> } }
  /** 删掉一条消息 */
  | { ch: 'msg-remove'; payload: string }
  /** 工具调用状态变化 */
  | { ch: 'tool'; payload: ToolPatch }
  /** 会话状态变化 */
  | { ch: 'state'; payload: SessionState }
  | { ch: 'stats'; payload: SessionStats }
  | { ch: 'queue'; payload: QueueState }
  /** 会话里的任务清单变了（扩展通过 panel_todos 维护） */
  | { ch: 'todos'; payload: SessionTodo[] }
  /** 扩展要弹窗，需要应答 */
  | { ch: 'ui-request'; payload: ExtensionUiRequest }
  /** 扩展的 fire-and-forget 通知 */
  | { ch: 'notify'; payload: ExtensionUiRequest }
  /** 状态栏条目（setStatus） */
  | { ch: 'status'; payload: { key: string; text?: string } }
  /** 窗口标题（setTitle） */
  | { ch: 'title'; payload: string }
  /**
   * 会话标题生成好了（用模型总结用户第一句话）。
   * ⚠️ 与上面的 'title'（扩展 setTitle，改的是窗口标题）不是一回事，别混。
   */
  /** 窗口最大化状态（用于切换「最大化 / 还原」图标） */
  | { ch: 'win-state'; payload: { maximized: boolean; alwaysOnTop: boolean } }
  | { ch: 'session-title'; payload: { sessionId: string; title: string } }
  /** 扩展想把文本塞进输入框（set_editor_text） */
  | { ch: 'editor-text'; payload: string }
  /**
   * 扩展的 setWidget。
   *
   * TUI 里它是「输入框上方的一小块文本」，桌面端把它收进右栏「扩展」分区 ——
   * 扩展写的东西（MCP/LSP 状态之类）对用户是有意义的，直接丢掉等于骗扩展。
   */
  | { ch: 'widget'; payload: { key: string; lines?: string[] } }
  /** pi 版本 / 入口（启动时探测一次） */
  | { ch: 'pi-info'; payload: PiInfo }
  /** 记忆数据变了（扩展写入了新记忆） */
  | { ch: 'memory-changed'; payload: MemoryItem[] }
  /** pi 进程状态 / stderr / 错误 */
  | { ch: 'proc'; payload: { state: 'starting' | 'ready' | 'exited' | 'stderr' | 'error'; detail?: string; code?: number | null } }
  /**
   * 界面缩放变了（快捷键改的也走这条路）。
   * 为什么要推：Ctrl+= 是主进程拦的，渲染端不知道设置变了，
   * 设置面板里的选中态会与真实值不同步。
   */
  | { ch: 'ui-scale'; payload: { uiScale: number; effective: number; scaleFactor: number; autoScale: number } }

/** 渲染进程 → 主进程 的调用（全都返回 Promise） */
export interface YanBridge {
  /* 会话控制 */
  start(cwd?: string): Promise<{ ok: boolean; error?: string; state?: SessionState }>
  send(text: string, images?: { data: string; mimeType: string }[]): Promise<{ ok: boolean; error?: string }>
  steer(text: string): Promise<{ ok: boolean; error?: string }>
  followUp(text: string): Promise<{ ok: boolean; error?: string }>
  /**
   * 中止。按 pi 的约定先 clear_queue 再 abort，把清出来的队列文本返回，
   * 客户端应把它放回输入框（否则用户排的话就白打了）。
   */
  abort(): Promise<{ steering: string[]; followUp: string[] }>
  newSession(): Promise<{ ok: boolean; error?: string }>
  switchSession(path: string): Promise<{ ok: boolean; error?: string }>
  compact(): Promise<{ ok: boolean; error?: string }>
  /**
   * 给会话起名（写进 JSONL，TUI 的 /resume 也看得到）。
   *
   * ⚠️ `name` 不能为空 —— pi 的 `set_session_name` 对空串返回 `success:false`，
   * 也就是说名字一旦设了就**清不掉**。调用方（renameSession）会拦空值。
   */
  renameSession(name: string): Promise<{ ok: boolean; error?: string }>

  /** 从某条用户消息处分叉 */
  fork(entryId: string): Promise<{ ok: boolean; error?: string; text?: string }>
  /** 复制当前分支到新会话 */
  clone(): Promise<{ ok: boolean; error?: string }>
  forkPoints(): Promise<ForkPoint[]>
  /** 导出当前会话为 HTML */
  exportHtml(): Promise<{ ok: boolean; path?: string; error?: string }>
  /** 删除一份会话文件（不可逆，UI 要先确认） */
  deleteSession(path: string): Promise<{ ok: boolean; error?: string }>

  /* 直执行 bash（不进 LLM 的工具调用） */
  runBash(command: string): Promise<{ ok: boolean; error?: string }>
  abortBash(): Promise<void>

  /* 模型 / 思考 */
  listModels(): Promise<ModelInfo[]>
  setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }>
  setThinking(level: string): Promise<{ ok: boolean; error?: string }>
  listThinkingLevels(): Promise<string[]>

  /* 开关 */
  setAutoCompaction(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  setAutoRetry(enabled: boolean): Promise<{ ok: boolean; error?: string }>

  /* 队列模式 */
  setSteeringMode(mode: QueueMode): Promise<{ ok: boolean; error?: string }>
  setFollowUpMode(mode: QueueMode): Promise<{ ok: boolean; error?: string }>

  /* 重试 / 轮换（TUI 的快捷键在桌面端也要有对应入口） */
  abortRetry(): Promise<{ ok: boolean; error?: string }>
  cycleModel(): Promise<{ ok: boolean; error?: string; to?: string }>
  cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }>
  /** 取最后一条助手消息的纯文本（复制用） */
  lastAssistantText(): Promise<string | null>

  /* pi 环境信息 */
  piInfo(): Promise<PiInfo>

  /* 命令 */
  listCommands(): Promise<SlashCommand[]>

  /* 状态查询 */
  getState(): Promise<SessionState | null>
  /**
   * 拉当前连接状态。
   *
   * 为什么需要：`proc: ready` 是 push，而渲染端在 dev 模式下加载很慢，
   * 可能错过这次推送 —— 界面就永远停在「正在启动 pi」。
   * 所以启动时必顶拉一次权威状态。
   */
  agentStatus(): Promise<{ state: 'starting' | 'ready' | 'exited' | 'error'; detail: string }>
  getMessages(): Promise<UIMessage[]>
  getStats(): Promise<SessionStats | null>
  /** 已生成过的会话标题缓存（sessionId → title），启动时一次性拉走 */
  cachedTitles(): Promise<Record<string, string>>
  /** 读会话里的 extension custom entries（任务清单的来源） */
  getCustomEntries(): Promise<CustomEntry[]>
  /** 手动刷新任务清单 */
  refreshTodos(): Promise<SessionTodo[]>

  /* 会话列表 */
  listSessions(): Promise<SessionSummary[]>

  /**
   * 快速预览会话消息（**直接读文件，不问 pi**）。
   *
   * 实测：打开 17MB 会话，pi 要 2780ms，直接解析只需 59ms。
   * 而且 jsonl 里包含**压缩前的历史**，pi 的 get_messages 不含。
   *
   * `null` = 读不出来（调用方应回退到等 pi）。
   */
  peekSession(path: string): Promise<PeekResult | null>

  /* 模型接入（凭证） */
  /** 列出接入方式与状态。deep=true 时逐个问 pi（慢，几百 ms × N） */
  authProviders(deep?: boolean): Promise<AuthProviderInfo[]>
  /** 写入一个 provider 的 API key（**合并**写入 auth.json） */
  setApiKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }>
  /** 移除某个 provider 的凭证（界面上的「退出」） */
  clearAuth(provider: string): Promise<{ ok: boolean; error?: string }>
  /** auth.json 的路径与条目数（界面上告知凭证存在哪） */
  authFileInfo(): Promise<{ path: string; exists: boolean; count: number }>

  /**
   *  文件引用补全 —— 只读**一层**目录（不递归扫项目）。
   * 返回相对 cwd 的路径，目录带尾斜杠。
   */
  completePath(prefix: string): Promise<string[]>

  /* 记忆 */
  memoryList(): Promise<MemoryItem[]>
  memoryAdd(text: string, kind: MemoryKind, topic?: string): Promise<MemoryItem[]>
  memoryUpdate(id: string, patch: Partial<Pick<MemoryItem, 'text' | 'topic' | 'kind'>>): Promise<MemoryItem[]>
  memoryRemove(id: string): Promise<MemoryItem[]>
  memoryConfirm(id: string, ok: boolean): Promise<MemoryItem[]>

  /** 只读身份（soul.md） */
  readSoul(): Promise<{ name: string; selfRef: string; tone: string }>

  /* 附件 */
  /** 弹系统文件选择框，读成 base64（图片） */
  pickImages(): Promise<Attachment[]>

  /* 设置 */
  getSettings(): Promise<AppSettings>
  patchSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickCwd(): Promise<string | null>
  setCwd(cwd: string): Promise<{ ok: boolean; error?: string }>

  /* 扩展 UI 应答 */
  respondUi(res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void

  /* 诊断 */
  probePi(): Promise<PiProbe>
  openPath(p: string): Promise<void>
  /** 在系统文件管理器里定位一个文件 */
  revealPath(p: string): Promise<void>

  /* 窗口 */
  win: {
    minimize(): void
    maximize(): void
    close(): void
    /** 切换置顶（会被记住到设置里） */
    setAlwaysOnTop(v: boolean): Promise<boolean>
  }

  /* 订阅（返回退订函数） */
  onPush(cb: (msg: MainPush) => void): () => void
  /**
   * 订阅主进程拦下的全局快捷键（Ctrl+P / Shift+Tab / Ctrl+±0）。
   * 主进程用 before-input-event 先拦（输入法、焦点问题都拦得住），
   * 再把动作名发过来；「下一档」怎么算由渲染端决定。
   *
   * 例外：缩放（Ctrl+= / Ctrl+- / Ctrl+0）由主进程自己直接改并回推
   * `ui-scale` —— 它不需要渲染端参与决策。
   */
  onHotkey(cb: (action: 'cycleModel' | 'cycleThinking') => void): () => void
  /** 读界面缩放现状（含自动模式下算出的倍率与屏幕缩放） */
  getZoom(): Promise<ZoomState>
  /** 设界面缩放（0 = 自动），返回生效后的状态 */
  setUiScale(v: number): Promise<ZoomState>
  /** 列一层目录（文件树；相对 cwd，一层一次 —— 有意不递归） */
  listDir(rel: string): Promise<DirListing>
}

/** 界面缩放状态（主进程算出，渲染端只显示） */
export interface ZoomState {
  /** 0 = 自动 */
  uiScale: number
  /** 实际应用的 zoom */
  effective: number
  /** 窗口所在屏的系统缩放（1.25 = 125%） */
  scaleFactor: number
  /** 自动模式下会用的倍率 */
  autoScale: number
}

/** 文件树的一个条目 */
export interface DirEntry {
  name: string
  dir: boolean
  /** 文件字节数（目录没有） */
  size?: number
}

/** 列一层目录的结果 */
export interface DirListing {
  /** 相对 cwd 的路径（根 = ''） */
  path: string
  /** 展示用绝对路径（`~` 缩写）。越界或读不到时是空串 */
  abs: string
  entries: DirEntry[]
  /**
   * 被故意跳过的目录（node_modules / .git …）。
   * 为什么要报出来：不报的话用户会以为文件树列不全。
   */
  skipped: string[]
  /** 是否因为条目太多而截断 */
  truncated: boolean
  /** 只有根层带：项目名（cwd 的 basename） */
  rootName?: string
}
