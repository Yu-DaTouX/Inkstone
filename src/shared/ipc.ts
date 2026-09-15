/**
 * 主进程 ↔ 渲染进程的共享类型。
 *
 * 不依赖 pi 内部类型；消息在 src/main/normalize.ts 中归一化为 UIMessage，
 * RPC 事件由 src/main/agent.ts 适配。
 *
 * ⚠️ 这是全仓被 import 最多的文件（40+ 处），改它一律是**跨进程**改动：
 *   `preload/index.ts`（暴露）→ `main/index.ts`（handler）→ `state/store.ts`（消费）。
 *   新增 IPC 的完整四处清单见 `src/preload/index.ts` 头部。
 *
 * 两边都要用的纯逻辑（回合分组、链接判定、模型能力归一化）放在本层，
 * 因为它们必须能在没有 DOM / Electron 的环境下被单测。
 */

/* RPC */

/** 带 id 的请求 → 响应关联 */
export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/* 消息（渲染用） */

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

/** 回复详细程度的实际采用值；旧历史没有记录时必须保留 unknown。 */
export type ResponseDetail = 'brief' | 'standard' | 'detailed' | 'unknown'

/** 工具调用（来自 assistant 的 toolCall 内容块，或 tool_execution_* 事件） */
export interface UIToolCall {
  id: string
  name: string
  args: unknown
  /** 流式参数累积的原始 JSON 片段（未解析成功时用于显示） */
  argsRaw?: string
  status: 'pending' | 'running' | 'ok' | 'error'
  /**
   * 被取消 / 中断（用户点了停止）。
   * 方案 4.1：取消要**单独显示**，不能和失败混为一谈 ——
   * 红字会让人以为工具自己坏了。
   */
  cancelled?: boolean
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
  /**
   * 思考是否**正在**流式输出。
   *
   * 为什么不能拿 `thinkingMs` 猜：一个回合里模型可能想好几次
   * （每次工具往返前都想一遍），`thinkingMs` 是累加的，
   * 第二段推理开始时它已经 > 0，猜不出「现在正在想」。
   */
  thinkingLive?: boolean
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
  /** 本轮实际采用的回复详细程度；旧历史缺失时为 unknown。 */
  responseDetail?: ResponseDetail
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

/**
 * pi 内核的来源。
 *
 * 用户需要知道「现在跑的是哪个 pi」，出问题时第一件事就是区分
 * 内置运行时 / 系统安装 / 自定义入口 —— 三者版本和依赖都可能不同。
 */
export type PiSource =
  /** 设置项 piBin 显式指定 */
  | 'override'
  /** 环境变量 YAN_PI_BIN */
  | 'env'
  /** 随应用分发的内置运行时 */
  | 'bundled'
  /** 系统里全局安装的 pi */
  | 'global'
  /** 从 PATH 上的 pi shim 反推到的安装 */
  | 'path'
  /** 都没找到，退回 PATH 上的 pi（需 shell） */
  | 'shell'

/** pi 进程 / 版本信息（设置「关于」页与引导页用） */
export interface PiInfo {
  /** 找到的 pi 入口（CLI JS 路径；shell 兜底时是 'pi'） */
  bin: string
  version?: string
  /** pi 包所在目录（显示用） */
  home?: string
  /** 实际来源 */
  source?: PiSource
  /** 是否为随应用分发的内置运行时（= source === 'bundled'） */
  bundled?: boolean
  /** 内置运行时目录当前是否可用（用于「缺件修复」提示） */
  bundledAvailable?: boolean
  /** 解析/探测过程中的警告（退回 shell、文件缺失等） */
  error?: string
}

/** 会话状态快照（get_state 的归一化） */
export interface SessionState {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  model?: ModelInfo
  thinkingLevel: string
  availableThinkingLevels: string[]
  /** 思考档位能力的权威来源状态：空数组不再等同于“查询失败”。 */
  thinkingLevelsStatus?: CapabilityStatus
  /** 与当前 model 一起推送的能力快照；缺失字段表示上游没有提供该能力。 */
  capabilities?: ModelCapabilitySnapshot
  isStreaming: boolean
  /**
   * 回合级「正在干活」：从 agent_start 到 agent_settled，**覆盖工具执行**。
   * `isStreaming` 在工具执行期间是 false（每条 assistant 消息结束就清），
   * 所以「回合是否还在继续」要看这个。
   */
  isAgentRunning?: boolean
  isCompacting: boolean
  messageCount: number
  pendingMessageCount: number
  cwd: string
  autoCompactionEnabled?: boolean
  steeringMode?: QueueMode
  followUpMode?: QueueMode
}

/**
 * 所有异步运行时事件的身份封套。
 *
 * sessionId 是稳定的会话身份，runId 是当前本地运行实例，generation
 * 用来丢弃切换会话/刷新能力之后迟到的响应。projectId 只表达产品归属，
 * 不等同于 cwd，也不要求会话文件物理落在项目目录里。
 */
export interface RuntimeEnvelope {
  sessionId: string
  runId: string
  projectId?: string
  generation: number
}

/**
 * 一个会话运行实例的状态（N12）。
 *
 * 「正在查看的会话」与「正在运行的会话」是两件事：
 * 切到别的会话时，后台会话的 pi 进程继续跑，左栏用它画状态槽。
 */
export interface RunnerStatus {
  /** 兼容旧 UI 的别名；新代码使用 runId。 */
  id: string
  runId: string
  sessionFile?: string
  sessionId?: string
  projectId?: string
  generation: number
  cwd: string
  /** 回合在跑（agent_start → agent_settled） */
  running: boolean
  /** 有扩展请求在等用户回答 */
  waiting: boolean
  /** 连接失败 / 进程退出 */
  failed: boolean
  conn: 'starting' | 'ready' | 'exited' | 'error'
  createdAt: number
  lastActiveAt: number
  /** 当前视图正在看的就是它 */
  isActive: boolean
}

/** 可 fork 的用户消息（get_fork_messages） */export interface ForkPoint {
  entryId: string
  text: string
}

/** 命令注册表中的来源。兼容项只用于说明，不应进入可执行候选。 */
export type CommandSource = 'pi' | 'extension' | 'skill' | 'prompt' | 'yan' | 'compatibility'

/** 统一斜杠命令描述（pi / 扩展 / 技能 / 提示词 / Yan 本地命令）。 */
export interface CommandDescriptor {
  name: string
  description?: string
  source: CommandSource
  location?: string
  /** 注册命令的模块或文件，供同名命令区分来源。 */
  module?: string
  /** 是否可以由桌面端补全并执行。 */
  executable: boolean
  usage?: string
  /** 能看见但当前桌面端不执行时，说明兼容边界。 */
  availability?: string
}

/** 旧名称保留给 renderer/preload 调用方，实际结构已是 CommandDescriptor。 */
export type SlashCommand = CommandDescriptor

/** 待发送的图片附件 */
export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  /** 图片：不带 `data:` 前缀的裸 base64；文件引用：空串 */
  data: string
  /** 预览用（图片与 data 相同；文件引用为空串） */
  preview: string
  /**
   * `image`（默认，向后兼容）或 `file`。
   * 文件引用**不携带内容** —— 只登记路径，模型按需 read，避免把大文件塞进上下文。
   */
  kind?: 'image' | 'file'
  /** 文件引用的绝对路径（仅 `kind === 'file'`） */
  path?: string
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  reasoning: boolean
  /** `reasoning: false` 与“上游没告诉我们”必须区分。 */
  reasoningStatus?: CapabilityStatus
  /** pi 的真实输入模态；缺失表示能力未知，不等同于不支持。 */
  input?: Array<'text' | 'image' | string>
  inputStatus?: CapabilityStatus
  contextWindow: number
  contextWindowStatus?: CapabilityStatus
  maxTokens?: number
  maxTokensStatus?: CapabilityStatus
}

/**
 * 能力字段的三态值。
 *
 * `unsupported` 只能来自上游明确返回空/false；`unknown` 表示这次协议
 * 没有提供该字段。UI 不得把 unknown 画成“明确不支持”。
 */
export type CapabilityStatus = 'known' | 'unsupported' | 'unknown'

export interface ModelCapabilitySnapshot {
  modelKey: string
  reasoning: CapabilityStatus
  input: {
    status: CapabilityStatus
    modalities: Array<'text' | 'image' | string>
  }
  contextWindow: {
    status: CapabilityStatus
    value?: number
  }
  maxTokens: {
    status: CapabilityStatus
    value?: number
  }
  thinkingLevels: {
    status: CapabilityStatus
    values: string[]
  }
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
    /** 主进程标记这份统计对应的模型，旧/跨模型快照不能冒充当前值。 */
    modelKey?: string
    availability?: CapabilityStatus
    estimated?: boolean
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

/** 队列中的一条尚未投递消息；id 由 Yan 维护，不用文本或数组下标识别。 */
export interface QueueItem {
  id: string
  text: string
}

/** 队列状态（queue_update） */
export interface QueueState {
  steering: QueueItem[]
  followUp: QueueItem[]
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
  /**
   * 显式状态（**可选**，来自 pi 侧写清单的那个扩展）。
   *
   * 为什么是可选的：写清单的是扩展（`panel_todos`，不在这个仓库里），
   * 现有数据只有 `{text, done}`。桌面端不能假定它在 —— **有就用、
   * 没有就退回推断**（见 RightPanel 里 `activeIdx` 的两步判定）。
   */
  status?: TodoStatus
}

/**
 * 任务状态。
 *
 * 为什么需要：只有 `done` 时，「哪一条正在做」只能猜（第一个未完成的），
 * 于是只要还有没做完的任务，界面上就**永远**有一条在转 —— agent 早就
 * 停了也照转。那是猜测，不是状态（方案 4.5）。
 */
export type TodoStatus = 'pending' | 'running' | 'done' | 'blocked'

/**
 * 一份任务清单快照（会话里每轮都会写一份）。
 *
 * 为什么要保留历史：agent 重新规划任务时会写一份**新的**清单，
 * 旧的那份仍在会话文件里 —— 用户要能回头看「上一轮列了哪些任务」，
 * 并**跳回**当时那轮对话。所以快照要带上轮次号。
 */
export interface SessionTodoSnapshot {
  /** custom entry 的 id */
  id: string
  todos: SessionTodo[]
  /** 写这份清单时已经过了几轮用户消息（跳转用；从 1 开始） */
  round: number
}

/** 会话里的一条 custom entry（扩展写的任意数据） */
export interface CustomEntry {
  id: string
  customType: string
  data: unknown
}

/* 会话列表 */

export interface SessionSummary {
  id: string
  path: string
  cwd: string
  /** 优先用 session_info 里的名字，没有才退回首条用户消息 */
  title: string
  /** 是否用的是用户起的名字（而不是首条消息） */
  named: boolean
  /**
   * 分叉自哪个会话文件（pi 的 `session` 头里的 `parentSession`）。
   * 没有就是根会话；左栏据此显示「分支数 / 分支编号 / 分叉自哪句话」。
   */
  parentSession?: string
  /** 分叉自父会话的那句话（截断；读不到就没有） */
  branchOrigin?: string
  /**
   * 会话的**真实最近活动**：最后一条 message 的时间戳。
   *
   * ⚠️ 不能用文件 mtime（打开会话会写 session_info/标题 → mtime 变新 → 那一行跳到顶部），
   * 也不能用 createdAt（那是**分叉时刻**，会让刚分叉出来的子会话全挤到最上面）。
   * 只认 message 的时间戳，列表才能“新→旧”且打开不重排。
   */
  lastActivityAt?: number
  createdAt: number
  updatedAt: number
  messageCount: number
  model?: string
  /** Yan 的产品语义归属；不代表 JSONL 物理存储位置。 */
  projectId?: string
  /** 迁移中的旧会话可能暂时需要用户确认归属。 */
  scope?: SessionScope
  /** 最近一次在 Yan 中打开的时间。 */
  lastOpenedAt?: number
  /** cwd 对应多个项目时保留候选，不静默选择。 */
  projectCandidates?: string[]
}

/** 会话在 Yan 产品模型中的归属范围。 */
export type SessionScope = 'global' | 'project' | 'pending'

export interface SessionMoveRecord {
  at: number
  fromProjectId?: string
  toProjectId?: string
  fromScope: SessionScope
  toScope: SessionScope
}

/** `session-layout.json` 中的一条会话归属记录。 */
export interface SessionLayoutEntry {
  sessionId: string
  sessionFile?: string
  cwd: string
  scope: SessionScope
  projectId?: string
  projectCandidates?: string[]
  createdAt: number
  updatedAt: number
  lastOpenedAt?: number
  moveHistory: SessionMoveRecord[]
}

export interface SessionLayoutDocument {
  version: 1
  entries: SessionLayoutEntry[]
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

/* 模型接入（凭证） */

/** 能不能用：ready = 有可用凭证 */
export type AuthStatus = 'ready' | 'missing' | 'unknown'

/**
 * 应用内 OAuth 登录的结果。
 *
 * 失败时 `error` 是**给用户看的中文句子**（不是错误码）—— 流程里的每一种
 * 失败（端口被占、state 不匹配、换 token 被拒、超时、取消）都拼好人话再返回，
 * 因为它会直接显示在设置页上。
 */
export interface CodexLoginResult {
  ok: boolean
  /** 成功时的 ChatGPT 账号 id（从 access token 的 claim 里取）。 */
  accountId?: string
  error?: string
}

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
  /**
   * 能不能**在应用内直接登录**（不用回终端）。
   *
   * 目前只有 ChatGPT 订阅（`openai-codex`）为 true —— 它的 OAuth 参数
   * 可以从内置 pi 里逐字对齐抄出来（见 src/main/oauth.ts）。
   * 其余订阅制（Claude Pro、Copilot、xAI、OpenRouter）仍只能跑 `pi → /login`：
   * 要么是各自协议不同，要么是 pi 没提供可拷贝的客户端参数。
   */
  inAppLogin?: boolean
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

/* 设置 */

/** 可独立归档、分组和迁移路径的项目实体。 */
export interface ProjectRecord {
  id: string
  cwd: string
  name: string
  groupId?: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface ProjectGroup {
  id: string
  name: string
  createdAt: number
}

export interface AppSettings {
  cwd: string
  theme: 'dark' | 'light'
  lang: 'zh-CN' | 'en-US'
  /** 手动指定 pi 入口（自动探测失败时用） */
  piBin?: string
  /** 最近使用的目录 */
  recentCwds: string[]
  /** 工作目录绝对路径 → 用户自定义项目名 */
  projectNames: Record<string, string>
  /** 持久化项目实体；projectNames 是旧版本兼容映射。 */
  projects: ProjectRecord[]
  /** 项目分组（空 groupId 表示未分组）。 */
  projectGroups: ProjectGroup[]
  /** 供应商月度预算（用于没有余额概念但提供费用 API 的平台） */
  providerBudgets: Record<string, number>
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
   * 浏览器区域高度（px）。**0 = 用设计默认值**（55% 的右栏高度）。
   * 只在浏览器与工具栏同时显示时可拖 —— 工具栏收起时浏览器独占整列，
   * 这个值就不参与了。与 railWidth / panelWidth 同一个约定。
   */
  browserHeight: number
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
  /**
   * 运行中的工具调用是否**自动展开成详情**（N03）。
   *
   * 语义：它只决定「自动展开」，**不再决定历史能不能查看**。
   * 所有已记录的调用随时可以点击查看详情；失败调用始终保留行内状态与入口。
   *
   * 默认 **false** —— 工具调用只留一行，开始 / 增量输出 / 结束都不自动展开，
   * 避免一次跑十几条命令把回答顶出屏幕。这是显式偏好：
   * 只有用户在设置里主动打开（同时写入 `toolDetailExplicit`）才会自动展开。
   */
  toolDetail: boolean
  /**
   * 「用户在设置里显式切换过 toolDetail」的标记。
   *
   * 为什么需要它：`toolDetail` 的默认值改过两次，靠值本身无法区分
   * 「用户选的」和「旧版本迁移写的默认值」。
   *   · 旧语义 v1：已结束的能不能点开（旧配置里的 false 只是默认值）；
   *   · v2：运行中是否自动展开，迁移时把老配置一律升为 true；
   *   · v3（N03）：默认改为收起，**没有这个标记就归到 false**。
   * 有标记的配置不会被迁移覆盖 —— 用户手动选过的偏好一直保留。
   */
  toolDetailExplicit?: boolean
  /**
   * 分区内容高度（px），按分区 id 存。
   * 只给「内容会滚动」的分区用（文件树 / 日志）—— 其余几行高的分区
   * 调高度没意义，界面上也不给把手。
   */
  toolHeights: Record<string, number>
  /**
   * 对话内容列的宽度（px）。**0 = 用设计默认值**（--w-stream，当前 900）。
   *
   * 与 railWidth / panelWidth 同一个约定：只在用户手动调过之后才落盘一个数字，
   * 以后改默认值时没调过的人会跟着变。对话正文、输入框、用量条、导航轨
   * 全都从同一个 --w-stream 变量取值，所以调它一处就整体对齐。
   */
  streamWidth: number
  /**
   * 自主模式。
   *
   * 开启后模型**不再向用户提问**（内置提问扩展会跳过弹窗并自行决策，
   * 系统提示也会明确要求不要问）。默认 false —— 提问是更有帮助的默认行为，
   * 自主模式是用户为了“别打断我”主动打开的。
   */
  autonomous: boolean
  /**
   * 发送键。
   *
   * - `auto`（**默认**）：短输入框里 Enter 发送；进入长文模式后 Enter 换行、
   *   Ctrl/Cmd+Enter 发送。这是用户明确要求过的行为（写长文时不想误发）。
   * - `enter`：任何时候 Enter 发送（Shift+Enter 换行）。
   * - `ctrlEnter`：任何时候 Ctrl/Cmd+Enter 发送（Enter 换行）。
   *
   * 为什么要把它变成设置：`auto` 让「输入框高度」隐式决定了 Enter 的语义 ——
   * 按下去之前无法确定会发生什么。显式之后，当前规则还会常显在输入区里
   * （见 Composer 的 sendRule），不必靠试。
   */
  sendKey: 'auto' | 'enter' | 'ctrlEnter'
  /**
   * 回复详细程度（方案 3.1）。
   *
   * 与推理强度（`thinkingLevel`）是**两件事**：
   *   · 推理强度 = 让它想多深；
   *   · 回复详细程度 = 它把结果讲多细。
   * 三档都不得省略必要错误提示或改变任务完成范围，也不调低推理强度。
   *
   * 默认 `standard`：与改动前的行为一致（不注入任何额外提示）。
   * 落地方式：内置扩展 `response-detail.js` 在 before_agent_start 里注入，
   * 每轮开始时读一次有效设置，不逐 token 改提示。
   */
  responseDetail: 'brief' | 'standard' | 'detailed'
  /**
   * 界面密度（方案 A1）：只改间距与行高，**不缩放字体**。
   *
   * 默认 `standard` = 改动前的观感（不能改老用户的界面）。
   * 实现走 CSS 变量（`--d-row-gap` / `--d-section-gap` / `--d-message-gap`），
   * 由 `html[data-density]` 覆盖 —— 而不是给所有尺寸统一乘倍数，
   * 那样会把中文字体的像素对齐弄坏。
   */
  density: 'compact' | 'standard' | 'comfortable'
  /**
   * 声音提示（对齐 opencode 的 attention / sounds）。
   *
   * 默认**关**：突然出声比突然动画更吓人，想用的人自己开。
   */
  sound: SoundSettings
}

/**
 * 会发出提示音的事件。
 *
 * 对齐 opencode 的 done / question / error 三类：
 *   · done      —— 一个回合跑完了（agent_settled）
 *   · question  —— 扩展/模型要用户做选择，需要人介入
 *   · error     —— 出错（扩展报错 / pi 进程错误）
 */
export type SoundEvent = 'done' | 'question' | 'error'

export interface SoundSettings {
  /** 总开关 */
  enabled: boolean
  /** 音量 0~1（opencode 默认 0.4） */
  volume: number
  /**
   * 窗口不在前台时是否发**系统通知**（Windows 通知中心）。
   *
   * 与声音独立：可以只要声音不要通知，或反之。默认 true（对齐 opencode）。
   */
  notifications: boolean
  /** 各事件单独开关（控制声音，也控制通知） */
  events: Record<SoundEvent, boolean>
}

/**
 * 渲染端请求一次系统通知。
 *
 * 为什么不在渲染端直接 new Notification：
 *   · 主进程能拿到窗口状态，点击通知后能把窗口拉回前台（restore + focus）；
 *   · Windows 上需要 AppUserModelID 才能显示 toast，那只能在主进程设；
 *   · 渲染端的 Web Notification 在打包后行为不一致，主进程一条路径更好控。
 */
export interface AttentionNotify {
  kind: SoundEvent
  title: string
  body?: string
}

/** 音量的合法区间（主进程与渲染端共用，避免两边各写一份） */
export const SOUND_VOLUME_MIN = 0
export const SOUND_VOLUME_MAX = 1

/**
 * 工具栏分区的 id。
 *
 * 为什么放 shared：主进程要拿它**校验**设置文件里的顺序/隐藏集合
 * （未知 id 直接丢掉，否则版本升级后旧 id 会一直占位），
 * 渲染端要按它排默认顺序。两处必须用同一份定义。
 */
/**
 * 右栏工具分区的**默认顺序**，也是合法 id 的白名单。
 *
 * ⚠️ 顺序改过（2026-09 评审）：原来是 `context, quota, todo, …`，
 *    现在把 **任务** 提到最前 —— 它回答的是“现在该我做什么”，
 *    是唯一“越早看到越好”的分区；上下文与文件是查资料的。
 *    额度 / 队列 / 日志 / 扩展 / 操作都归到后面按需展开。
 *
 *    这只影响 `toolOrder` 为空（从未自定义过）的用户 —— 设置里存过顺序的
 *    人仍按自己的来（见 RightPanel 的 fullOrder），不会被默默重排。
 */
export const TOOL_SECTIONS = ['todo', 'context', 'files', 'quota', 'queue', 'ext', 'log', 'actions'] as const
export type ToolSectionId = (typeof TOOL_SECTIONS)[number]

export interface ProviderQuota {
  provider: string
  supported: boolean
  remaining?: number
  total?: number
  used?: number
  currency?: string
  label?: string
  error?: string
  /**
   * 分窗口的额度（订阅制常见：5 小时 + 每周）。
   * 有它时右栏会在总额度下面逐条画进度条，而不是只给一个数字。
   */
  windows?: QuotaWindow[]
  checkedAt: number
}

export interface QuotaWindow {
  /** 稳定 id，仅用于 React key 与测试 */
  id: string
  /** 展示名（由主进程按供应商语言给出） */
  label: string
  used: number
  total: number
  /** 重置时间（毫秒时间戳），没有就不显示 */
  resetAt?: number
  exceeded?: boolean
  /**
   * 这个窗口的额度是**推算**出来的（不是接口给的官方字段）。
   * 方案 7.2：界面必须标明来源，不能把推算值伪装成精确额度。
   */
  estimated?: boolean
}

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
export const RAIL_MIN = 210
export const RAIL_MAX = 420
export const PANEL_MIN = 220
export const PANEL_MAX = 560

/** 夹一个合法的面板宽度；0 / 非数字都当「用默认」 */
export function clampPanelWidth(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(max, Math.max(min, n)))
}

/**
 * 对话内容列宽度的允许区间（px）。
 *
 * 下限 560：再窄中文一行放不下几个字，代码块会疯狂折行；
 * 上限 1600：再宽就接近全屏，阅读行长会失控（这是当初设 --w-stream 的原因）。
 * 与面板宽度一样放在 shared —— 主进程落盘前夹、渲染端拖动时也夹。
 */
export const STREAM_MIN = 560
export const STREAM_MAX = 1600

/** 夹一个合法的对话宽度；0 / 非数字都当「用默认」 */
export function clampStreamWidth(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(STREAM_MAX, Math.max(STREAM_MIN, n)))
}

/**
 * 自动压缩的生效设置与触发点（读 pi 的 settings.json，只读）。
 * 界面用它说明「什么时候会自动压缩」—— 这个数字必须与 pi 实际行为一致。
 */
export interface CompactionInfo {
  /** 自动压缩开关（pi 的 compaction.enabled） */
  enabled: boolean
  /** 为模型回答预留的 tokens（默认 16384） */
  reserveTokens: number
  /** 压缩时保留的最近 tokens（默认 20000） */
  keepRecentTokens: number
  /** 当前模型的上下文窗口 */
  contextWindow: number
  /** 触发线 = contextWindow - reserveTokens */
  threshold: number
  /** 是否被用户改过（false = 全是 pi 的默认值） */
  custom: boolean
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
  /** 命中的来源（见 PiSource） */
  source: PiSource
  /** pi 包所在目录（显示用） */
  home?: string
  error?: string
  tried: string[]
}

/* 内置浏览器 */

/** 应用内浏览器的可观察状态。 */
export interface BrowserState {
  open: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  activeTabId?: string
  tabs?: BrowserTabState[]
  userControl?: boolean
  lastDownload?: { path: string; filename: string; size?: number; source?: string }
  /**
   * 网页权限记录（方案 9.2）。默认全部拒绝；允许只在本次应用运行期、
   * 对精确 origin + permission 生效，不落盘，也不把 Cookie/页面存储值带进记录。
   */
  permissions?: BrowserPermissionRecord[]
  nativeBounds?: BrowserBounds
  /** 统一标签栏当前激活的是内嵌 WebContentsView 还是外部 Chrome 代理标签 */
  mode?: 'embedded' | 'external'
  /** 外部 Chrome 连接状态；连接存在时保留，与当前是否激活无关 */
  external?: BrowserExternalState
}

export interface BrowserPermissionRecord {
  permission: string
  /** 只保留 scheme + host + port，不保存路径、查询参数或页面正文。 */
  origin: string
  status: 'allowed' | 'blocked'
  at: number
}

/** 外部 Chrome（本机已安装的浏览器）的接入状态 */
export interface BrowserExternalState {
  url: string
  title: string
  loading: boolean
  /** 独立 profile 目录（用户需要在这里登录一次目标站点） */
  profileDir?: string
  /** DevTools 调试端口 */
  debuggingPort?: number
  /** 接入时从真实 Chrome 同步数据的结果（哪几项成功/失败） */
  sync?: ChromeSyncReport
}

/**
 * 本机 Chrome 数据同步报告。
 *
 * 为什么逐项报告而不是一个布尔值：历史随时能同步、Cookie 在 Chrome
 * 开着时拿不到 —— 「一半成功」是常态。只有一个布尔值的话，界面就只能
 * 笼统地说「同步失败」，用户不知道该做什么。
 */
export interface ChromeSyncReport {
  /** 找到本机 Chrome 的用户数据了吗 */
  found: boolean
  /** 源（真实 Chrome 用户数据根目录） */
  source?: string
  /** 目标（托管 profile） */
  target?: string
  /** 成功同步的条目 */
  copied: string[]
  /** 失败/跳过及原因 */
  failed: { item: string; reason: string }[]
  /** 探测时 Chrome 是否在运行 */
  chromeRunning: boolean
  /** Cookie 是否真的同步过来了（决定提示不提示「请先退出 Chrome」） */
  cookiesSynced: boolean
}

export interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserObservation {
  generationId: string
  url: string
  title: string
  text: string
  elements: Array<{
    ref: string
    role: string
    name: string
    box: [number, number, number, number]
    disabled?: boolean
    value?: string
  }>
  accessibilityNodeCount: number
  domSnapshotCaptured: boolean
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/* 扩展 UI 桥 */

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text'

export interface ExtensionUiRequest {
  id: string
  method: ExtensionUiMethod
  /**
   * 安全敏感的确认（删除、支付、授权……）。
   *
   * 方案第 6 节：分类必须由**请求方声明**，不根据问题措辞推断。
   * 标记为 true 时走模态框（焦点圈定 + 遮罩）；未标记的普通提问
   * 走输入区上方的非模态面板。
   */
  sensitive?: boolean
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

/* 主进程 → 渲染进程 的推送
   —— 全部是**已归一化**的 UI 补丁。渲染端不认识 pi 的协议细节，
   协议知识只存在于 src/main/agent.ts 一处。 */

export interface ToolPatch {
  /** 工具调用属于哪条消息 */
  msgId: string
  call: UIToolCall
  /**
   * 输出的**增量**（append 语义）。
   *
   * 为什么需要它：工具输出是**最高频**的推送路径（一条 bash 命令的
   * stdout 一秒几十上百个 chunk），而每个 chunk 都带完整累积输出。
   * 那样每帧传输的是 O(已输出总量)，一次命令下来就是 O(N²) 字节，
   * 长输出（例如一次 `npm run build`）会把 IPC 和渲染线程一起拖住。
   * 有这个字段时渲染端只追加，不再被 `call.output` 覆盖。
   */
  outputDelta?: string
}

/**
 * 消息补丁。
 *
 * `textDelta` / `thinkingDelta` 是**追加**语义：主进程只发新增的那一段，
 * 渲染端自己接到已显示的文本后面。
 *
 * 为什么不用全量 `text`：流式期间主进程每 16~120ms 推一次，
 * 每次都带整篇累积文本 —— 一篇 50KB 的回答推 300 帧就是 15MB 的
 * 结构化克隆 + React 状态复制。长回答越长，每帧越贵（O(N²)）。
 * 全量仍然保留：`message_end` / 中止 / 切换会话时用它做权威对齐。
 */
export type MessagePatch = Partial<UIMessage> & {
  textDelta?: string
  thinkingDelta?: string
}

/** 子代理的一次运行（方案第 8 节 / L03）。 */
export type SubagentReviewState = 'none' | 'pending' | 'conflict' | 'merged' | 'discarded' | 'archived'

export interface SubagentDiffSummary {
  files: number
  additions: number
  deletions: number
  /** 相对父项目根的路径；只传摘要，不把补丁正文塞进 IPC。 */
  paths: string[]
  truncated: boolean
  /** 补丁归档位置；用户明确查看/合并/放弃后仍可追溯。 */
  patchPath?: string
}

export interface SubagentRun {
  id: string
  /** 派给它的任务描述 */
  task: string
  /** 它跑在哪个工作目录 */
  cwd: string
  /** 启动时的父会话 / 运行实例；查看对象切换不改变这两个归属。 */
  parentSessionId?: string
  parentRunId?: string
  projectId?: string
  /** worktree = 默认写入隔离；controlled-cwd = 显式只读受控目录。 */
  isolation: 'worktree' | 'controlled-cwd'
  /** 审阅结束后为空；待审阅时指向 worktree，退出归档后指向补丁。 */
  resultPath?: string
  model?: string
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  /** 最新一行活动（紧凑列表里显示） */
  latestActivity?: string
  /** 转录（有界：主进程只保留最后若干条，避免 IPC 越推越大） */
  transcript: UIMessage[]
  diff?: SubagentDiffSummary
  review: SubagentReviewState
  error?: string
}

/** 子代理控制器对外暴露的能力 */
export interface SubagentBridge {
  list(): Promise<SubagentRun[]>
  start(
    task: string,
    model?: string,
    isolation?: 'worktree' | 'controlled-cwd'
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }>
  stop(id: string): Promise<{ ok: boolean; error?: string }>
  stopAll(): Promise<void>
  /** 清掉**已结束**的记录（运行中的不会被清） */
  clearFinished(): Promise<void>
  /** 预览摘要已经随 list/push 返回；合并前仍会重新读取并检查补丁。 */
  merge(id: string): Promise<{ ok: boolean; error?: string }>
  /** 明确放弃隔离 worktree；补丁归档仍保留，便于必要时找回。 */
  discard(id: string): Promise<{ ok: boolean; error?: string }>
}

/**
 * 主进程 → 渲染进程 的推送**内容**。
 *
 * ⚠️ 与 `MainPush` 分开：每条会话相关的推送都带 `runtime` 身份封套，
 * 渲染端才能把「后台会话的输出」与「当前正在看的会话」分开。全局推送
 *（设置 / 缩放 / 浏览器）不带它。
 */
export type MainPushBody =
  /** 全量替换消息列表（启动 / 切会话 / compact 之后） */
  | { ch: 'sync'; payload: UIMessage[] }
  /** 新增一条消息 */
  | { ch: 'msg-add'; payload: UIMessage }
  /** 增量更新一条消息（流式文本会高频触发，见 MessagePatch 的 delta 说明） */
  | { ch: 'msg-update'; payload: { id: string; patch: MessagePatch } }
  /** 删掉一条消息 */
  | { ch: 'msg-remove'; payload: string }
  /** 工具调用状态变化 */
  | { ch: 'tool'; payload: ToolPatch }
  /** 子代理运行状态变化（整条快照，转录有界） */
  | { ch: 'subagent'; payload: SubagentRun }
  /** 子代理被移除（用户清掉记录时） */
  | { ch: 'subagent-remove'; payload: string }
  /** 会话状态变化 */
  | { ch: 'state'; payload: SessionState }
  | { ch: 'stats'; payload: SessionStats }
  | { ch: 'queue'; payload: QueueState }
  /** 会话里的任务清单变了（扩展通过 panel_todos 维护） */
  | { ch: 'todos'; payload: SessionTodo[] }
  /** 全部任务清单快照（含最新）。界面用它做「历史任务」模块 */
  | { ch: 'todo-history'; payload: SessionTodoSnapshot[] }
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
  /** pi 进程状态 / stderr / 错误 */
  | { ch: 'proc'; payload: { state: 'starting' | 'ready' | 'exited' | 'stderr' | 'error'; detail?: string; code?: number | null } }
  /**
   * 界面缩放变了（快捷键改的也走这条路）。
   * 为什么要推：Ctrl+= 是主进程拦的，渲染端不知道设置变了，
   * 设置面板里的选中态会与真实值不同步。
   */
  | { ch: 'ui-scale'; payload: { uiScale: number; effective: number; scaleFactor: number; autoScale: number } }
  /** 内置浏览器状态（WebContentsView 与 pi browser extension 共用） */
  | { ch: 'browser-state'; payload: BrowserState }
  /**
   * 主进程自己产生的日志（未捕获异常 / 未处理 Promise）。
   * 为什么要走 UI：Electron 默认会为 uncaughtException 弹一个原生
   * “A JavaScript error occurred in the main process”对话框，既打断
   * 用户、又只在屏幕上存在几秒。这些信息应该和 pi 的 stderr 一样进
   * 右栏日志抽屉，可回看、不弹框。
   */
  | { ch: 'log'; payload: { text: string; level?: 'info' | 'error' } }
  /**
   * 运行实例状态快照（N12）。
   * 它是**全局**推送（不属于某个会话）—— 左栏需要一次拿到所有实例的画法。
   */
  | { ch: 'runners'; payload: RunnerStatus[] }
  /** 托盘菜单要求渲染端新建一个全局会话。 */
  | { ch: 'tray-new-session'; payload: null }
  /** 托盘菜单要求切到指定运行实例；没有 sessionFile 时用稳定 sessionId。 */
  | {
      ch: 'tray-select-session'
      payload: {
        sessionFile?: string
        sessionId?: string
        projectId?: string
        scope?: SessionScope
        cwd: string
      }
    }

/**
 * 主进程 → 渲染进程 的推送。
 *
 * 带 `runtime` 的表示「这条消息属于哪个会话/运行实例/代次」；渲染端对
 * **不是当前正在查看的实例**的事件不得写进当前视图（否则后台任务
 * 的输出会串到眼前这个会话里）。`sessionKey` 暂时保留给旧探针和旧构建。
 */
export type MainPush = MainPushBody & {
  runtime?: RuntimeEnvelope
  /** @deprecated use runtime.runId */
  sessionKey?: string
}

/** 渲染进程 → 主进程 的调用（全都返回 Promise） */
export interface YanBridge {
  /* 会话控制 */
  /**
   * 切到某个会话（N12）：命中已有实例就只改视图，**不发停止命令**；
   * 空闲实例会被复用；到并发上限时明确报错，而不是停掉正在跑的旧会话。
   */
  selectSession(target: { sessionFile?: string; sessionId?: string; projectId?: string; scope?: SessionScope; cwd: string }): Promise<{
    ok: boolean
    id?: string
    runId?: string
    sessionId?: string
    generation?: number
    via?: 'hit' | 'reuse' | 'new'
    error?: string
  }>
  /** 所有运行实例的状态（左栏状态槽用；也可用来补上错过的推送） */
  runnerStatuses(): Promise<RunnerStatus[]>
  /** 停掉**某一个**运行实例（只影响它，不涉及别的会话） */
  stopRunner(id: string): Promise<boolean>
  start(cwd?: string): Promise<{ ok: boolean; error?: string; state?: SessionState }>
  send(text: string, images?: { data: string; mimeType: string }[]): Promise<{ ok: boolean; error?: string }>
  steer(text: string): Promise<{ ok: boolean; error?: string }>
  followUp(text: string): Promise<{ ok: boolean; error?: string }>
  /** 把一条排队的消息插队（提升为 steering，在当前这轮就听） */
  steerQueued(queueId: string): Promise<{ ok: boolean; error?: string }>
  /** 撤回一条仍在 Yan 队列快照中的消息，并把文本交回草稿。 */
  removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; error?: string }>
  /**
   * 中止。按 pi 的约定先 clear_queue 再 abort，把清出来的队列文本返回，
   * 客户端应把它放回输入框（否则用户排的话就白打了）。
   */
  abort(): Promise<{ steering: string[]; followUp: string[] }>
  newSession(target?: { cwd?: string; projectId?: string; scope?: SessionScope }): Promise<{
    ok: boolean
    error?: string
    id?: string
    runId?: string
    sessionId?: string
    generation?: number
  }>
  switchSession(path: string): Promise<{ ok: boolean; error?: string }>
  /** 移动产品归属；null = Yan 默认全局位置，不移动物理 JSONL 文件。 */
  moveSession(sessionId: string, projectId: string | null): Promise<{
    ok: boolean
    error?: string
    entry?: SessionLayoutEntry
  }>
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
  /**
   * 将一份会话移到砚的回收站。返回的 token 只在本次应用运行期间可用于撤销。
   * UI 必须先完成自己的明确确认，主进程仍会拒绝当前会话。
   */
  deleteSession(path: string): Promise<{ ok: boolean; undoToken?: string; error?: string }>
  /** 撤销本次运行内刚刚执行的会话删除。 */
  restoreSession(undoToken: string): Promise<{ ok: boolean; error?: string }>

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
  /** 反向切到上一个模型（Ctrl+Shift+P；pi 的 RPC 只有向前） */
  cycleModelBack(): Promise<{ ok: boolean; error?: string; to?: string }>
  cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }>
  /** 取最后一条助手消息的纯文本（复制用） */
  lastAssistantText(): Promise<string | null>

  /* pi 环境信息 */
  piInfo(): Promise<PiInfo>
  /**
   * 重新探测 pi（清掉版本缓存，强制重跑 --version）。
   *
   * 为什么需要：用户可能在应用运行期间 `npm i -g` 装了 pi、或补好了
   * 内置运行时 —— 不重测的话界面一直停在启动时那个快照上。
   */
  redetectPi(): Promise<PiInfo>

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
  /** 用户手动重命名的会话名（sessionId → name），优先于自动标题 */
  manualTitles(): Promise<Record<string, string>>
  /** 写一个手动会话名（空串 = 清除，恢复自动标题） */
  setManualTitle(sessionId: string, name: string): Promise<{ ok: boolean }>
  /** 按稳定 sessionId 重生成短标题；不切换会话、不打断后台运行实例。 */
  regenerateTitle(sessionId: string): Promise<{ ok: boolean; title?: string; error?: string }>
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
  /**
   * 在应用内登录 ChatGPT 订阅（Codex）：开系统浏览器走 OAuth，回调落在
   * 本机 1455 端口，成功后凭证合并写入 pi 的 auth.json。
   *
   * 这个 Promise 在流程**结束时** resolve（成功/失败/取消/超时都是），
   * 所以界面可以一直 await 它来显示「等待浏览器授权…」。
   */
  codexLogin(): Promise<CodexLoginResult>
  /** 取消正在进行的 ChatGPT 登录（关掉本地回调、释放 1455 端口）。 */
  codexLoginCancel(): Promise<void>
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
  /**
   * 以当前查看实例的 cwd 做补全根；cwd 可显式传入，避免后台切换/迟到响应
   * 把旧项目的候选路径串到新项目输入框里。
   */
  completePath(prefix: string, cwd?: string, context?: FileRequestContext): Promise<PathCompletionResult>
  /** 取消一个仍在主进程扫描中的全项目文件名搜索。 */
  cancelFileSearch(requestId: string): Promise<void>
  /** 全项目文件名搜索：有界、可取消，并跳过大型依赖目录。 */
  searchFiles(request: FileSearchRequest): Promise<FileSearchResult>

  /* 附件 */
  /** 弹系统文件选择框，读成 base64（图片） */
  pickImages(): Promise<Attachment[]>

  /* 设置 */
  getSettings(): Promise<AppSettings>
  patchSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickCwd(): Promise<string | null>
  setCwd(cwd: string): Promise<{ ok: boolean; cwd?: string; error?: string }>

  /* 扩展 UI 应答 */
  respondUi(res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void

  /**
   * 发一条系统通知（仅当用户开了通知开关时由 store 调用）。
   * 返回 shown=false 表示系统不支持/被拦，调用方不需要重试。
   */
  notifyAttention(n: AttentionNotify): Promise<{ shown: boolean; simulated?: boolean; error?: string }>

  /* 诊断 */
  probePi(): Promise<PiProbe>
  openPath(p: string): Promise<void>
  /** 在系统文件管理器里定位一个文件 */
  revealPath(p: string): Promise<void>

  /**
   * 是不是跑在验收探针里（主进程带了 `YAN_PROBE`）。
   *
   * 目前只用于**首次引导**：探针环境没有凭证，引导层会无条件自动弹出，
   * 而它是一层模态（按设计会让出 Shift+Tab 这类快捷键），
   * 会把 hotkeys 那类场景的按键全吃掉。真实用户路径不受影响。
   */
  readonly isProbe: boolean

  /* 窗口 */
  win: {
    minimize(): void
    maximize(): void
    close(): void
    /** 切换置顶（会被记住到设置里） */
    setAlwaysOnTop(v: boolean): Promise<boolean>
    /** 请求真正退出；关闭按钮本身只隐藏到托盘。 */
    requestExit(): Promise<{
      action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting'
    }>
    lifecycle(): Promise<{ tray: boolean; visible: boolean; quitting: boolean }>
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
  onHotkey(cb: (action: 'cycleModel' | 'cycleModelBack' | 'cycleThinking') => void): () => void
  /**
   * 告诉主进程「现在有模态层打开」，让它**暂停** cycleModel / cycleThinking 的
   * 全局拦截（缩放不受影响）。
   *
   * 为什么必需：Shift+Tab / Ctrl+P 是在 `before-input-event` 里**先于渲染端**
   * 被 preventDefault 的，渲染端再怎么判断都来不及 —— 设置面板里的表单
   * 因此永远做不了反向焦点导航。守卫状态必须由渲染端上报。
   */
  setHotkeyGuard(paused: boolean): void
  /** 读界面缩放现状（含自动模式下算出的倍率与屏幕缩放） */
  getZoom(): Promise<ZoomState>
  /** 设界面缩放（0 = 自动），返回生效后的状态 */
  setUiScale(v: number): Promise<ZoomState>
  /** 列一层目录（文件树；相对 cwd，一层一次 —— 有意不递归） */
  listDir(rel: string, showHidden?: boolean, context?: FileRequestContext): Promise<DirListing>
  /**
   * 把拖入的 `File` 换成绝对路径（Electron 的 `webUtils`，不经主进程）。
   * 只转换；校验与授权在 `describeFiles` 里做。
   */
  pathForFile(file: File): string
  /** 校验并登记一组文件引用（工作区外也允许，仅本次运行有效） */
  describeFiles(paths: string[]): Promise<FileRefInfo[]>
  /** 读已登记文件的文本（只读预览）；未登记 / 二进制 / 超限会返回错误 */
  readFileText(path: string): Promise<FileTextResult>
  /**
   * 只读预览一个链接指向的文件。
   * 相对路径按会话 cwd 解析，绝对路径也允许（但一律 realpath 校验）。
   * `line` 来自 `path:42` 形式，界面用它滚到目标行。
   */
  readPreview(path: string, line?: number, cwd?: string): Promise<FilePreview>
  /** 自动压缩的生效设置与触发点（只读 pi 的 settings.json） */
  compactionInfo(contextWindow: number): Promise<CompactionInfo>
  providerQuota(provider: string, monthlyBudget?: number): Promise<ProviderQuota>

  /* 子代理（方案第 8 节） */
  subagents: SubagentBridge

  /* 内置浏览器 */
  browser: {
    getState(): Promise<BrowserState>
    open(url?: string): Promise<BrowserState>
    observe(): Promise<BrowserObservation>
    newTab(url?: string): Promise<BrowserState>
    switchTab(id: string): Promise<BrowserState>
    closeTab(id?: string): Promise<BrowserState>
    close(): Promise<BrowserState>
    navigate(url: string): Promise<{ ok: boolean; error?: string }>
    back(): Promise<{ ok: boolean; error?: string }>
    forward(): Promise<{ ok: boolean; error?: string }>
    reload(): Promise<{ ok: boolean; error?: string }>
    /** 用系统默认浏览器打开地址（不传用当前标签页） */
    openExternal(url?: string): Promise<{ ok: boolean; error?: string }>
    /**
     * 接入本机 Chrome：独立 profile + 调试端口 + CDP。
     * 之后所有 browser_* 工具都指向这个真实浏览器（含它的登录态）。
     */
    openExternalChrome(url?: string): Promise<{ ok: boolean; error?: string }>
    /** 断开本机 Chrome，并关掉我们拉起的那个进程 */
    closeExternalChrome(): Promise<BrowserState>
    /** 重新同步本机 Chrome 的登录态与历史（退出 Chrome 后调用才拿得到 cookie） */
    syncLocalProfile(): Promise<ChromeSyncReport>
    syncPageStorage(): Promise<ChromeSyncReport>
    /** 逐站临时权限；false 为撤销，进程退出后自动清空。 */
    setPermission(permission: string, origin: string, allowed: boolean): Promise<{ ok: boolean; error?: string }>
    setUserControl(value: boolean): Promise<BrowserState>
    setBounds(bounds: BrowserBounds): Promise<void>
    /** 临时隐藏/恢复原生网页视图（文件预览占用同一区域时必须调） */
    setVisible(visible: boolean): Promise<void>
  }
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
export interface DirEntry {  name: string
  dir: boolean
  /** 文件字节数（目录没有） */
  size?: number
}

/** 文件树 / @ 补全 / 全项目搜索共用的请求身份。 */
export interface FileRequestContext {
  cwd: string
  projectId?: string
  /** 切项目或重新打开实例时递增；迟到响应不得覆盖新视图。 */
  generation: number
}

export type FileListingStatus = 'ok' | 'empty' | 'missing' | 'permission' | 'invalid' | 'error'

/** `@` 补全的有界结果；paths 仍然保持相对 cwd 的路径格式。 */
export interface PathCompletionResult {
  paths: string[]
  truncated: boolean
  status: FileListingStatus
  request?: FileRequestContext
}

export interface FileSearchRequest extends FileRequestContext {
  requestId: string
  query: string
  /** 主进程仍会夹到安全上限；调用方不应依赖更大的值。 */
  limit?: number
}

export interface FileSearchEntry {
  path: string
  name: string
  dir: boolean
}

export interface FileSearchResult {
  request: FileSearchRequest
  entries: FileSearchEntry[]
  status: FileListingStatus | 'partial' | 'cancelled'
  truncated: boolean
  scannedDirs: number
  skippedDirs: number
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
  /** 读取状态；旧的 mock / 旧构建缺失时按兼容路径处理。 */
  status?: FileListingStatus
  /** 失败时给局部提示，不把系统错误原文直接暴露到界面。 */
  error?: string
  /** 过滤后实际可见的条目总数（用于解释截断）。 */
  totalEntries?: number
  /** 请求身份回显；用于 renderer 的最后一道迟到响应闸门。 */
  request?: FileRequestContext
  /** 只有根层带：项目名（cwd 的 basename） */
  rootName?: string
}

/* ---- 拖入 / 加入上下文的普通文件 ---- */
/** 文件引用大致分类：决定「能不能在预览里看内容」 */
export type FileRefKind = 'text' | 'image' | 'pdf' | 'binary' | 'other'

/** 主进程校验并登记之后的文件引用 */
export interface FileRefInfo {
  ok: boolean
  /** 渲染端传来的原始路径（失败时用于回显） */
  input: string
  /** 校验后的**真实**绝对路径（realpath）；失败时为空串 */
  path: string
  name: string
  size: number
  mimeType: string
  kind: FileRefKind
  /** 失败原因（可直接显示） */
  error?: string
}

/** 读已登记文件的文本结果 */export interface FileTextResult {
  ok: boolean
  text?: string
  /** 是否因为超过 2MB 而截断 */
  truncated?: boolean
  size?: number
  error?: string
}

/**
 * 写入类工具的执行前后快照（方案 5.3 的「可靠差异」阶段）。
 * 内容全文不传给渲染端（可能几 MB、可能是密钥类内容）。
 */
export interface FileSnapshotSide {
  exists: boolean
  size: number
  /** 内容哈希（前 16 位），只用于判断是否真变了 */
  hash?: string
  /** 超过 2MB 没有读内容 */
  tooLarge?: boolean
}

/** 一次写入调用的真实差异 */
export interface FileDiff {
  path: string
  before: FileSnapshotSide
  after: FileSnapshotSide
  /** 新增 / 删除行数；-1 = 未知（拿不到内容） */
  added: number
  removed: number
  /** unified 风格逐行差异；规模超限时为空串 */
  patch: string
  status: 'created' | 'deleted' | 'modified' | 'unchanged' | 'unknown'
}

/** 只读文件预览的结果（消息里的文件链接 / 附件按需查看） */
export interface FilePreview {
  ok: boolean
  /** 链接里写的原路径（展示用，保持用户看到的样子） */
  path: string
  /** realpath 后的绝对路径（失败时为空） */
  abs: string
  name: string
  size: number
  kind: FileRefKind
  /** 只对文本文件有值（前 2MB） */
  text?: string
  truncated?: boolean
  /** 从 `path:42` 解析出的行号（1 起） */
  line?: number
  error?: string
}
