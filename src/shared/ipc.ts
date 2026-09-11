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
   * 订阅主进程拦下的全局快捷键（Ctrl+P / Shift+Tab）。
   * 主进程用 before-input-event 先拦（输入法、焦点问题都拦得住），
   * 再把动作名发过来；「下一档」怎么算由渲染端决定。
   */
  onHotkey(cb: (action: 'cycleModel' | 'cycleThinking') => void): () => void
}
