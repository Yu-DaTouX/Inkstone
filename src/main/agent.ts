/**
 * AgentController —— 一回话一个 pi 子进程，外加**协议 → UI 的归一化**。
 *
 * 这是整个应用唯一认识 pi 协议的地方（HANDOFF §9 原则 2）。
 * 它对外只吐 MainPush（已在 src/shared/ipc.ts 定义），
 * 渲染端完全不认识 `assistantMessageEvent` 之类的东西。
 *
 * 为什么要维护一份消息副本：
 *   message_update 是**增量**（delta），没有累积快照；
 *   tool_execution_* 用 toolCallId 关联，但UI 上要挂到"哪条助手消息"下面。
 *   所以要在这里组装出完整的 UIMessage[]，再以补丁形式推给渲染端。
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { PiRpc } from './protocol'
import type { CapabilityCommandResult, CapabilityHandlers, YanCliEnv } from './capability-server'
import { CapabilityCommandError, CapabilityServer } from './capability-server'
import { ContextRecallError, recallArchivedContext } from './context-recall'
import { ensureYanLauncher } from './yan-cli'
import {
  normalizeHistory,
  normalizeMessage,
  imagesOf,
  toUsage,
  type PiContentBlock,
  type PiMessage
} from './normalize'
import { SESSIONS_DIR, SESSIONS_DIR_IS_OVERRIDE } from './sessions'
import { consumeQueuedItem } from './queue-items'
import { clearStaleRunning, EMPTY_COMPACTION_STATE, projectTrustedFrom, reduceCompaction, type CompactionState } from './compaction'
import { activeContextPolicy, contextPolicySettings } from './context-policy'
import {
  contextBudget,
  contextPolicyStep,
  INITIAL_POLICY_STATE,
  rearmAfterCompaction,
  type ContextPolicyState,
  type ContextTrigger,
  type ResolvedContextPolicy
} from '../shared/context-policy'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { projectPackageDirs } from './packages'
import { turnTiming } from '../shared/turn-timing'
import { toolWaitSpans } from '../shared/turns'
import {
  appendTurnTiming,
  applyTurnTimings,
  readTurnTimings,
  timingKey,
  TURN_TIMING_VERSION
} from './turn-timing-store'
import { mergeCommandDescriptors } from './command-registry'
import { generateTitle, manualTitleOf } from './title'
import { readSessionMessages, type ReadResult } from './session-reader'
import { localizeImage } from './image-store'
import { todoSnapshotsFromEntries } from './todo-snapshots'
import { applyTaskPlanOperation, currentTaskPlan, readTaskPlanLog, TaskPlanStoreError } from './task-plan-store'
import { isSafeSessionId } from './context-state-store'
import { prepareProjectKnowledgeInjection, readProjectKnowledgeEnabled } from './project-knowledge'
import { commitKnowledge, listKnowledge, readKnowledge } from './project-memory-store'
import { isSafeKnowledgeId, isSafeRelativeRef } from '../shared/project-memory'
import { searchProjectKnowledge } from '../shared/project-memory-search'
import { searchCapabilities } from '../shared/capabilities'
import { buildCatalog, type McpCatalogEntry } from './capabilities/catalog'
import { webSearchAvailability, type WebSearchAvailability } from '../shared/web-search'
import { AcquisitionService, operationIdOf, stagingDirOf } from './capabilities/acquisition-service'
import { PackageAuthorizationService } from './capabilities/package-authorization-service'
import { readRepoState } from './git-service'
import { fetchNpmPackageMetadata } from './capabilities/npm-artifact'
import { stageNpmAcquisition } from './capabilities/npm-acquisition'
import { resolveMcpPackage, smokeMcpPackage } from './capabilities/mcp-package'
import { McpRegistrationService, type McpRegistrationOutcome } from './capabilities/registration-service'
import { draftRemoteMcpRegistration, type AcquireAuthorization } from '../shared/mcp-registration'
import { discoverCapabilities, planForCandidate } from './capabilities/discovery/discover'
import type { AcquisitionPlan, CapabilityCandidate } from '../shared/discovery'
import { readSkillById, skillsFromCommands, type RawSkillCommand } from './capabilities/skill-service'
import { activeSkillArgs, declaredSkillFile, SkillSecurityError, stageSkillFiles } from './capabilities/skill-files'
import { fetchSkillFiles } from './capabilities/skill-source'
import { formatSkillSecurityReview } from '../shared/skill-security'
import { McpConnectionManager } from './mcp/connection-manager'
import { loadMcpServers, mcpServersForProject } from './mcp/config'
import { callMcpTool, describeMcpTool, McpToolError } from './mcp/tool-service'
import { schemaRevisionOf } from '../shared/mcp'
import { taskPlanLogEntry, type TaskAction, type TaskPlanRequest } from '../shared/task-plan'
import { titleSampleImages, titleSamples } from '../shared/title-samples'
import { beginTreeSnapshot, endTreeSnapshot, isShellTool, isWriteTool, snapshotAfter, snapshotBefore, writePathOf } from './snapshots'
import { ArtifactStore } from './artifacts'
import { codexAuthAvailable, generateImage, resolveImageProvider, type ImageGenerationRequest } from './image-generation'
import {
  capabilitySnapshot,
  modelKeyOf,
  normalizeModelInfo,
  normalizeThinkingLevels,
  resolveThinkingLevels
} from '../shared/model-capabilities'
import type {
  BashRun,
  BrowserObservation,
  BrowserState,
  ContextBudget,
  ContextPolicy,
  ContextPolicyView,
  CustomEntry,
  ForkPoint,
  MainPush,
  AssistantArtifact,
  ImageGenerationProgress,
  ModelInfo,
  QueueItem,
  QueueMode,
  QueueState,
  SessionState,
  SessionStats,
  SessionTodo,
  SlashCommand,
  ResponseDetail,
  UIMessage,
  UIToolCall,
  Usage
} from '../shared/ipc'
import type { CapabilityStrategy, TurnTerminalReason, WorkMode } from '../shared/ipc'

/** 流式文本的推送节流：60 帧够了，再多是给 IPC 白干活 */
const FLUSH_MS = 16
/**
 * 节流间隔的上限。
 *
 * 文本/输出越长，一帧要序列化、要 diff 的字节越多 —— 这时把间隔拉开比
 * 「硬撑 60fps」更划算：每次推送都是**值得的**，而不是把主线程压在
 * 全量重传上。实测（见 MessageParts.tsx 顶部）一帧的渲染预算会被
 * 几十万字的累积文本吃穿，所以让它自然降频到 10~20fps 比卡顿好。
 */
const MAX_FLUSH_MS = 120

/**
 * `compact` 命令的超时（默认 30s 不够用）。
 *
 * 为什么不能沿用 `REQUEST_TIMEOUT`：`compact` 不是元数据查询，它要**调一次模型
 * 生成摘要** —— 长会话上跑几分钟很正常。用 30s 的结果是：压缩还在进行、
 * 砚已经当它失败（实测报错「命令 compact 超时（30000ms）」），
 * 而且策略路径当时是 `void` 出去的，直接把错误变成了未捕获的 rejection。
 *
 * 超时仍留一个上限：压不动时得让用户看到失败，而不是无限等。
 */
const COMPACT_REQUEST_TIMEOUT_MS = 300_000


/** 推送补丁到渲染端（主进程注入） */
type Push = (msg: MainPush) => void

type HostUiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean }

type PendingHostUi = {
  resolve: (response: HostUiResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/* -------------------------------------------------- 浏览器（宿主能力服务） */

/** 浏览器动作的结果形状（`BrowserController` 的 `BrowserActionResult`）。 */
type BrowserCommandResult = { ok: boolean; error?: string; code?: string }

/** 会带回一份新观察的动作（click / type / press / scroll）。 */
type BrowserObservationResult = BrowserCommandResult & { observation?: BrowserObservation }

/**
 * 浏览器命令能看到的宿主服务面。
 *
 * ── 为什么不直接 `import type { BrowserController } from './browser'` ──
 *   ① agent.ts 只负责接线，没必要把 Electron 视图那一层拖进类型依赖；
 *   ② 这份接口同时是**命令行面的清单**：想给模型多加一个浏览器动作，
 *      必须在这里加一个方法 —— 扩面要显式过一遍，而不是“顺手”多注册一个工具
 *      （薄层准入五条见 docs/plan/实施-01-默认pi架构迁移.md §1）。
 *
 * 宿主侧 `BrowserController` 结构化满足它（见 src/main/index.ts 的注入点）。
 */
export interface BrowserCommandHost {
  getState(): BrowserState
  navigate(url: string): Promise<BrowserCommandResult>
  back(): Promise<BrowserCommandResult>
  forward(): Promise<BrowserCommandResult>
  reload(): Promise<BrowserCommandResult>
  newTab(url?: string): Promise<BrowserState>
  switchTab(id: string): Promise<BrowserState>
  closeTab(id?: string): Promise<BrowserState>
  openExternalChrome(url?: string): Promise<BrowserCommandResult>
  closeExternalChrome(): Promise<BrowserState>
  observe(): Promise<BrowserObservation>
  click(ref: string): Promise<BrowserObservationResult>
  type(ref: string, text: string): Promise<BrowserObservationResult>
  press(key: string): Promise<BrowserObservationResult>
  scroll(deltaX: number, deltaY: number): Promise<BrowserObservationResult>
  requestUserControl(): BrowserState
  screenshot(): Promise<{ mimeType: string; data: Buffer }>
}

/**
 * 宿主给当前 pi 实例暴露的子代理入口。
 *
 * 这不是 pi 扩展工具：模型仍然只看到原生 bash/read 等工具，
 * 通过随包 `yan` CLI 进入这里。这样子代理能力仍由砚控制生命周期，
 * 同时模型能发现并调用它。
 */
export interface SubagentCommandContext {
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentMessageId?: string
  projectId?: string
}

export interface SubagentCommandHost {
  run(
    command: string,
    params: Record<string, unknown>,
    context: SubagentCommandContext
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }>
}

/**
 * `yan goal …` 的宿主实现入口（实施-05 S3）。
 *
 * 为什么不在这里实现：会话文件键、模式 store 都在 `index.ts` 一侧；
 * agent 实例只负责把命令转过去（与 `subagentHost` 同一个理由）。
 */
export interface GoalCommandHost {
  run(
    command: string,
    params: Record<string, unknown>,
    context: { sessionId: string; projectId: string }
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }>
}

export interface ExternalApiConfirmationRequest {
  provider: 'openai' | 'compatible'
  endpoint: string
  model: string
  prompt: string
  cwd: string
}

export type CapabilityAuthorizationChoice = 'deny' | 'allow' | 'allow-with-lifecycle-scripts'
export type CapabilityAuthorizationPrompt = {
  kind: 'remote-mcp' | 'local-package'
  title: string
  source: string
  projectId: string
  cwd: string
  digest: string
  endpoint?: string
}

/* ------------------------------------------------------------ 任务清单 */
/**
 * pi 的队列模式字段是自由字符串（协议文档只保证这两个值）。
 * 认不出就当成 undefined —— 宁可界面不显示，也不能因为一个认知外的值而崩。
 */
function normalizeQueueMode(v: unknown): QueueMode | undefined {
  return v === 'all' || v === 'one-at-a-time' ? v : undefined
}

function imageFailureDetail(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? 'image_generation_failed')
    : error instanceof Error
      ? error.message
      : 'image_generation_failed'
  const labels: Record<string, string> = {
    external_api_denied: '已取消外部图像 API 请求',
    image_provider_unavailable: '没有可用的图像模型',
    image_result_empty: '图像服务返回了空文件',
    artifact_empty: '生成结果为空文件',
    codex_image_result_missing: '图像服务没有返回图片数据',
    image_api_result_missing: '图像 API 没有返回图片数据'
  }
  return labels[code] ?? `生成失败：${code}`
}

/* AgentController */

/**
 * 项目 `.pi/settings.json` 里登记的 pi 包 → 显式 `--extension` 参数。
 *
 * 砚默认 runner 带 `--no-extensions`（01-S5），pi 会关闭「发现 + 配置」的扩展加载，
 * 项目 settings 的 `packages` 也在其中；显式 `--extension` 是唯一仍会加载的通道。
 * 显式传入绕过了 pi 自己的项目信任闸门，所以这里必须自己补上：只有项目已被
 * 持久信任（`trust.json` 标记 true）才加载，范围与 pi 一致（整个项目 `.pi` 资源）。
 */
async function projectPiPackageArgs(cwd: string): Promise<string[]> {
  let trusted = false
  try {
    const raw = JSON.parse(await readFile(join(PI_AGENT_DIR, 'trust.json'), 'utf8')) as unknown
    trusted = projectTrustedFrom(raw, cwd)
  } catch {
    /* 读不到 trust.json 一律当「未信任」：fail closed，不擅自加载项目资源。 */
    trusted = false
  }
  if (!trusted) return []
  return projectPackageDirs(cwd, PI_AGENT_DIR).flatMap((dir) => ['--extension', dir])
}

export class AgentController extends EventEmitter {
  private rpc: PiRpc | null = null
  private push: Push
  private cwd: string
  private piBin?: string
  private questionExtension?: string
  /** 工作模式的工具策略执行（实施-05 S3）：计划档收紧工具表 + 兜底阻断。 */
  private workModeExtension?: string
  /** 就绪转移之后的内部门续行（实施-05 S3b）：custom 消息 + 触发一次回合。 */
  private goalResumeExtension?: string
  /** 交接包生成（实施-05 S5b-2）：它只做「调一次 completion」那件 RPC 做不到的事。 */
  private handoffsExtension?: string
  private responseDetailExtension?: string
  /**
   * 系统提示开场白扩展：把 pi 内置的英文 preamble 换成砚的中文开场白
   * （只动这一句，见 resources/pi-extensions/preamble.js）。
   */
  private preambleExtension?: string
  /** 界面语言扩展（每轮注入一句语言要求，见 resources/pi-extensions/language.js） */
  private languageExtension?: string
  /** 能力入口说明扩展（每轮静态追加，不随设置变化）。 */
  private capabilityGuideExtension?: string
  /**
   * 上下文状态化压缩扩展（N21-4）：Tool Sweep / Task State 注入 / Recall /
   * 结构化压缩闸门，见 resources/pi-extensions/context.js。
   * 默认接管 `tool-sweep` + `recall` + `compaction`（清理默认开，但保留可召回引用）；
   * `episode-fold` 要等状态生成器。阶段启用由主进程策略决定。
   */
  private contextExtension?: string
  /**
   * 项目知识注入扩展（实施-03 S3）：只做「读宿主写的注入文件 + 放一条消息」。
   * 检索与预算全在宿主（`main/project-knowledge.ts`）。
   */
  private projectKnowledgeExtension?: string
  /**
   * 单轮重复动作兜底（2026-09-22）：`tool_call` 看参数、连续相同就提醒或拦下。
   * 被拦下的计数由宿主在回合收尾时计入目标失败签名（`shared/repeat-guard.ts`）。
   */
  private repeatGuardExtension?: string
  /** 读界面历史（实施-05 S5b-4）；缺省用 `readSessionMessages` 读单文件。 */
  private readHistory?: (sessionFile: string) => Promise<ReadResult | null>
  /** 当前设置的回复档位；在 agent_start 时快照，不随回合中途改设置漂移。 */
  private getResponseDetail?: () => ResponseDetail
  /**
   * 浏览器服务取用口（宿主能力服务用）。
   *
   * 为什么是 getter 而不是实例：`browser` 在 index.ts 里是模块级单例，
   * 而 agent 实例会在切会话 / 重建 pi 时反复创建 —— 传 getter 才能拿到
   * **当前**那个控制器，不会抓住一个已 dispose 的旧实例。
   */
  private getBrowserHost?: () => BrowserCommandHost | null
  /** `yan subagent …` 的宿主实现；不把它注册为 pi 工具。 */
  private subagentHost?: SubagentCommandHost
  /** `yan goal …` 的宿主实现（实施-05 S3）；同样不是 pi 工具。 */
  private goalHost?: GoalCommandHost
  /** CLI 只能请求授权；最终选择由主进程的可见确认 UI 返回。 */
  private confirmCapabilityAuthorization?: (
    request: CapabilityAuthorizationPrompt
  ) => Promise<CapabilityAuthorizationChoice>
  private confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
  /**
   * 宿主能力服务注入给 pi 子进程的身份与地址（见 capability-server.ts / yan-cli.ts）。
   *
   * 为什么存在 agent 实例上、而不是全局：端点与 token 是**按实例**签发并与
   * (sessionId, projectId) 绑定的 —— 实例重建（切会话 / 重启 pi）就换一份，
   * 旧 token 立即作废。
   */
  private yanCliEnv?: YanCliEnv
  /**
   * 宿主能力服务。与 agent 实例同生命周期：stop() 时关掉，token 随之作废。
   *
   * 为什么不全局共享：端点绑定 (sessionId, projectId)，而多个 runner 可能
   * 跑在不同项目上 —— 共享一个端点就等于把身份校验变成形式。
   */
  private capabilityServer?: CapabilityServer
  /** 能力服务参数（由 RunnerRegistry 工厂传入）。 */
  private capabilityOpts?: {
    sessionId: string
    runnerGeneration: number
    projectId: string
    opsDir: string
    binDir: string
    artifactDir: string
    /** 开发态 resources 目录（打包态用 process.resourcesPath）。 */
    devResourcesDir?: string
    getWorkMode?: () => Promise<WorkMode>
    getCapabilityStrategy?: () => Promise<CapabilityStrategy>
    /** 直执行 bash 收尾后给受管能力调度器一个安全边界机会。 */
    onBashSettled?: () => void
  }
  /** 模型/思考能力变更串行化，避免快速点击时旧响应覆盖新状态。 */
  private capabilityChangeTail: Promise<void> = Promise.resolve()
  /**
   * MCP 连接管理器（实施-04 S3）。懒创建：没配 MCP 服务的机器上不付任何代价，
   * 也不起多余进程。与 agent 同生命周期 —— `stop()` 时关掉，不留孤儿子进程。
   */
  private mcpManager?: McpConnectionManager
  /** 配置本身的毛病（坏条目 / 重复 id）；调用时如实带回，不静默。 */
  private mcpConfigError?: string

  /** 权威消息列表 */
  private messages: UIMessage[] = []
  /** switch_session / new_session 的 RPC 过渡期不向 UI 泄漏旧会话事件。 */
  private suppressPush = false
  /** 正在流式的那条助手消息 */
  private streaming: {
    id: string
    text: string
    thinking: string
    thinkingMs?: number
    thinkingStartedAt?: number
    /** 正在流式思考（thinking_start 置位、thinking_end 清掉） */
    thinkingLive?: boolean
    /** 整轮固定的回复详细程度；中途改设置不能影响同一轮。 */
    responseDetail: ResponseDetail
    tools: UIToolCall[]
    /** 本轮助手消息开始生成的时间 */
    startedAt?: number
    /** 首个 token 到达的时间（用于更准的速率：排除排队/首包延迟） */
    firstTokenAt?: number
    /** 累积 usage（message_update 里带的就是累积值） */
    usage?: Usage
    /**
     * 已经推给渲染端的文本长度（增量推送的游标）。
     *
     * 为什么不用「每次重发全量文本」：流式期间每帧都带整篇累积文本，
     * 一篇 50KB 的回答推 300 帧就是 15MB 的结构化克隆 + React 状态复制，
     * 越长越贵（O(N²)）。存个游标只需发新的那一段。
     * 权威对齐由 message_end / sync 的全量快照负责。
     */
    pushedText: number
    /** 同上，思考文本的游标 */
    pushedThinking: number
  } | null = null
  /** 回合级「正在干活」（含工具执行），见 setAgentRunning */
  private agentRunning = false
  /** 当前 agent 回合的宿主起点；与单条 assistant 消息的首 token 时间分开。 */
  private turnStartedAt?: number
  /**
   * 当前回合的**单调**起点（`performance.now()`）。
   *
   * 为什么不用 `Date.now()`：墙钟会被系统对时 / 手动调整改掉，算出负数或
   * 凭空的几十秒。整轮用时只用于展示与落盘，用单调差值才稳定（H-6）。
   */
  private turnStartedMono?: number
  /** 这一轮归属的 assistant 消息 id，按出现顺序；终止时写进元数据日志。 */
  private turnMessageIds: string[] = []
  /** 本轮终止原因；默认完成，abort / 模型错误各自覆盖。 */
  private turnTerminal: TurnTerminalReason = 'completed'
  /** 本轮最后一次算出的用时（单调口径），落盘时用。 */
  private turnElapsedMs?: number
  /**
   * 本轮模型报出的**输出** token 数（A-2 预算要用）。
   *
   * 取各次消息的最大值而不是相加：provider 报的是**累积值**
   *（同一条流里后到的覆盖面更大），相加会算重。
   * 一个逻辑回合下多个 run（自动继续）各落一条记录，读回时相加（见 mergeTurnRecords）。
   */
  private turnOutputTokens?: number
  /** 本轮是否已经写过至少一条元数据记录（中间写一次、终止时再更新一次）。 */
  private turnPersisted = false
  /** 同一 runner 的中途快照与终止快照按事件顺序追加，避免慢写的中途记录盖过收尾。 */
  private turnTimingWriteTail: Promise<void> = Promise.resolve()
  /**
   * 当前 **run** 的标识（实施-11 H-6b）。
   *
   * 为什么需要与 `logicalTurnId` 分开：一个逻辑回合（= 一次用户请求 + 自动继续）
   * 会跑多次 pi 的 agent 回合。同一个 run 内的中途快照与终止快照**是同一段工作**
   * （后者覆盖前者），而不同 run 是串起来的另一段工作（用时**相加**）。
   * 读回时靠这个字段区分「覆盖」与「累加」，不能只看 logicalTurnId。
   */
  private turnRunSeq = 0
  private turnRunId?: string
  private turnResponseDetail: ResponseDetail = 'unknown'
  /** 文本脏（有新的流式文本待推） */
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 工具输出的**增量**待推集合（callId）。
   *
   * 工具输出是最高频的路径（一条命令的 stdout 一秒几十上百 chunk），
   * 以前每个 chunk 都直接推一份完整累积输出 —— 一次长命令就是 O(N²) 字节。
   * 现在只标记脏，由共用的定时器批量取增量。
   */
  private dirtyTools = new Set<string>()
  /**
   * toolCallId → 工具对象 / 它属于哪条消息。
   *
   * 为什么要建索引：`findCall` 以前是**线性扫全部消息的 toolCalls**，
   * 而它会被每一个工具事件调用（高频）。一个 2000 条消息、上千次工具调用的
   * 会话下，这就是 O(n) × 每秒上百次。
   */
  private callIndex = new Map<string, UIToolCall>()
  private callOwner = new Map<string, string>()
  /** toolCallId → 已经推给渲染端的 output 长度（与 streaming.pushedText 同理） */
  private pushedOut = new Map<string, number>()

  private state: SessionState | null = null
  /**
   * 压缩的可观测状态（N21-2）。
   *
   * 为什么与 `state` 分开存：`setStateFrom` 每次都用 pi 的 get_state **整份重建**
   * `this.state`（这条路上已经踩过 D11 —— 档位被每条推送清空），所以压缩记录
   * 必须活在这之外，否则一收到 state 推送就归零。
   */
  private compactionState: CompactionState = EMPTY_COMPACTION_STATE
  /**
   * 上下文策略状态（N21-3）：上膛标记 + 上次策略压缩的时间（冷却）。
   * 与 compactionState 一样活在 `state` 重建之外，否则每条 state 推送都会把它冲掉。
   */
  private policyState: ContextPolicyState = INITIAL_POLICY_STATE
  /**
   * 砚刚刚为哪条线发起了压缩。
   *
   * 为什么需要：pi 对砚发起的 `compact()` 一律报 `reason: 'manual'`，
   * 界面上会写成「手动」——用户明明没点那个按钮。发起方只有砚自己知道，
   * 所以在这里记一笔，等压缩事件到达时盖到那条记录上（见 setCompaction）。
   *
   * 为什么要带 `baseline`：`compaction_start` / `compaction_end` 的到达顺序、
   * 以及 `get_state` 的自愈都可能让“正在压缩”那条临时记录消失（实测：成功的
   * 那次压缩没有可用的开始记录，只有结束记录）。所以不能只靠开始事件盖章，
   * 而要能认出**哪条结束记录是本次调用产生的** —— 用“上一条记录的 endedAt”
   * 当基准就够了。
   */
  private policyOrigin: { stage: ContextTrigger; baseline: number | null } | null = null
  /** 正在走策略触发流程（防止两次 stats 刷新同时判定过线） */
  private policyTriggering = false
  private uiSeen = new Set<string>()
  /**
   * 正在等用户回答的扩展请求（N12）。
   *
   * 与上面的 uiSeen 不同：uiSeen 是「这个请求见过了」的去重集合，
   * 应答后仍然留在里面；这个集合只装**还没答复**的，
   * 用来给「后台会话正在等输入」这个状态提供依据。
   */
  private pendingUi = new Set<string>()
  /** `yan question ask` 走同一套 UI 请求通道，但不经过 pi 的 extension_ui_request。 */
  private pendingHostUi = new Map<string, PendingHostUi>()

  /**
   * 读界面历史：有注入就用注入的（交接过的会话要按段拼接），否则读单文件。
   *
   * 失败一律回 `null`，调用方回退到 pi 的 `get_messages` —— 历史读不出来
   * 不应该比「只看到当前上下文」更糟。
   */
  private async readHistoryOf(sessionFile: string): Promise<ReadResult | null> {
    /*
     * 图片在这里**落盘**，消息里只留文件地址（见 image-store.ts）：
     * 历史重读是唯一会把 base64 带进消息的路径，而它每次打开会话都会跑。
     */
    const read =
      this.readHistory ??
      ((file: string) =>
        readSessionMessages(file, {
          localizeImage: (mimeType, data) => localizeImage(join(YAN_DIR, 'attachments'), mimeType, data)
        }))
    return read(sessionFile).catch(() => null)
  }

  /** 当前直执行的 bash（RPC bash 命令，不走 LLM）。流式输出靠它累积。 */
  private bash: {
    reqId: string
    msgId: string
    command: string
    output: string
  } | null = null

  constructor(opts: {
    push: Push
    cwd: string
    piBin?: string
    questionExtension?: string
    workModeExtension?: string
    goalResumeExtension?: string
    handoffsExtension?: string
    /** 回复详细程度扩展（方案 3.1）：按档位注入系统提示 */
    responseDetailExtension?: string
    /**
     * 系统提示开场白扩展：把 pi 内置的英文 preamble 换成砚的中文开场白。
     *
     * 只做一处定点替换 —— 不用 `--system-prompt`（那是整段替换，
     * 会丢掉 pi 自己维护的 tools / rules / docs 段落）。
     */
    preambleExtension?: string
    /**
     * 界面语言扩展：在 before_agent_start 里读 desktop.json，每轮注入
     * 一句「推理与回复用什么语言」。
     *
     * 为什么不做成 `--append-system-prompt`：那是**进程启动时**固定的，
     * 切语言就必须重建 pi 实例（会掐掉后台会话、界面还会短暂失去当前会话
     * 的历史）。扩展注入是每轮读设置，切语言下一轮生效。
     */
    languageExtension?: string
    /**
     * 能力入口说明扩展：把「怎么用 `yan`、输出怎么读」追加到系统提示。
     *
     * 不这么做的话，能力虽然通了，模型也不知道要去用（见
     * resources/pi-extensions/capability-guide.js）。
     */
    capabilityGuideExtension?: string
    /** 上下文状态化压缩扩展（N21-4）：Tool Sweep / Task State / Recall / 压缩闸门 */
    contextExtension?: string
    /** 项目知识注入扩展（实施-03 S3）：读宿主写的注入文件并放到用户消息之前 */
    projectKnowledgeExtension?: string
    /** 单轮重复动作兜底（2026-09-22）：连续相同调用 → 提醒 / 拦下 */
    repeatGuardExtension?: string
    /**
     * 读界面历史（实施-05 S5b-4）。
     *
     * 默认是 `readSessionMessages`（单文件）；交接过的会话在链上，
     * 宿主注入链感知版本后会按段拼成一条时间线。agent 不认识「链」——
     * 那是宿主的关系，这里只留一个口子。
     */
    readHistory?: (sessionFile: string) => Promise<ReadResult | null>
    /** 读取当前有效档位；每个 agent_start 只调用一次。 */
    getResponseDetail?: () => ResponseDetail
    /**
     * 浏览器服务取用口（`yan browser …` 的实现要调它）。
     *
     * 没注入时 `yan browser` 会回 `browser_unavailable` —— 能力服务
     * 本身照常启动（任务清单等不受影响）。
     */
    browserHost?: () => BrowserCommandHost | null
    /** 子代理宿主入口，由 index.ts 注入，按当前 runner 绑定父会话。 */
    subagentHost?: SubagentCommandHost
    /** 目标状态入口（`yan goal …`），由 index.ts 注入（模式与目标在同一侧）。 */
    goalHost?: GoalCommandHost
    confirmCapabilityAuthorization?: (
      request: CapabilityAuthorizationPrompt
    ) => Promise<CapabilityAuthorizationChoice>
    confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
    /** 宿主能力服务环境（`yan` CLI 用）；未提供时不注入，CLI 会报「宿主不可用」。 */
    yanCliEnv?: YanCliEnv
    /** 宿主能力服务参数；提供时由本实例自己启动端点与启动器。 */
    capability?: {
      sessionId: string
      projectId: string
      opsDir: string
      binDir: string
      artifactDir: string
      runnerGeneration?: number
      devResourcesDir?: string
      getWorkMode?: () => Promise<WorkMode>
      getCapabilityStrategy?: () => Promise<CapabilityStrategy>
      /** 直执行 bash 收尾后给受管能力调度器一个安全边界机会。 */
      onBashSettled?: () => void
    }
  }) {
    super()
    const emit = opts.push
    this.push = (msg) => {
      if (!this.suppressPush) emit(msg)
    }
    this.cwd = opts.cwd
    this.piBin = opts.piBin
    this.questionExtension = opts.questionExtension
    this.workModeExtension = opts.workModeExtension
    this.goalResumeExtension = opts.goalResumeExtension
    this.handoffsExtension = opts.handoffsExtension
    this.responseDetailExtension = opts.responseDetailExtension
    this.languageExtension = opts.languageExtension
    this.capabilityGuideExtension = opts.capabilityGuideExtension
    this.contextExtension = opts.contextExtension
    this.projectKnowledgeExtension = opts.projectKnowledgeExtension
    this.repeatGuardExtension = opts.repeatGuardExtension
    this.readHistory = opts.readHistory
    this.getResponseDetail = opts.getResponseDetail
    this.getBrowserHost = opts.browserHost
    this.subagentHost = opts.subagentHost
    this.goalHost = opts.goalHost
    this.confirmCapabilityAuthorization = opts.confirmCapabilityAuthorization
    this.confirmExternalApi = opts.confirmExternalApi
    this.yanCliEnv = opts.yanCliEnv
    this.capabilityOpts = opts.capability
      ? { ...opts.capability, runnerGeneration: opts.capability.runnerGeneration ?? 1 }
      : undefined
  }

  /**
   * 启动宿主能力服务并生成 `yan` 启动器。
   *
   * 失败**不阻塞** pi 启动：能力入口不可用时会话要照常能用，
   * 只是模型敲 `yan` 会拿到「宿主不可用」（见 resources/yan-cli/yan.mjs），
   * 而不是整个应用起不来。失败原因写进 proc stderr，诊断页看得到。
   */
  private async ensureCapability(): Promise<void> {
    const opts = this.capabilityOpts
    if (!opts || this.capabilityServer || this.yanCliEnv) return
    try {
      /*
       * 业务命令的实现点在这里。用箭头函数闭包住 `this`：
       * handler 需要读**当前 pi 会话**（任务日志按会话归属）与当前轮次，
       * 这两样只有 agent 实例知道。
       */
      const handlers: CapabilityHandlers = {
        run: (command, params) => this.runCapabilityCommand(command, params)
      }
      const server = new CapabilityServer({
        opsDir: opts.opsDir,
        handlers
      })
      const { url, token } = await server.start({
        sessionId: opts.sessionId,
        projectId: opts.projectId
      })
      const launcher = ensureYanLauncher({
        packagedResourcesDir: process.resourcesPath,
        devResourcesDir: opts.devResourcesDir,
        execPath: process.execPath,
        binDir: opts.binDir
      })
      if (!launcher) {
        server.stop()
        this.noteCapabilityProblem('找不到随包的 yan CLI（检查打包是否包含 resources/yan-cli）')
        return
      }
      this.capabilityServer = server
      this.yanCliEnv = {
        url,
        token,
        sessionId: opts.sessionId,
        projectId: opts.projectId,
        binDir: launcher.binDir
      }
    } catch (err) {
      this.noteCapabilityProblem(`能力服务启动失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private noteCapabilityProblem(detail: string): void {
    this.push({ ch: 'proc', payload: { state: 'stderr', detail: `[能力服务] ${detail}` } })
  }

  get running(): boolean {
    return this.rpc?.running ?? false
  }

  private currentResponseDetail(): ResponseDetail {
    const value = this.getResponseDetail?.()
    return value === 'brief' || value === 'standard' || value === 'detailed' ? value : 'unknown'
  }

  /**
   * 连接状态。
   *
   * ⚠️ 这里要**缓存**，不能只靠 push。
   * 主进程启动 pi 只需几秒，而 dev 模式下渲染进程从 vite dev server
   * 逐个模块加载更慢 —— `proc: ready` 发出时渲染端可能还没订阅，
   * 这个事件就**永久丢失**了（界面永远停在「正在启动 pi」，但功能其实是好的）。
   * 所以渲染端 bootstrap 时会来拉一次（getConn），主进程必须答得上。
   */
  private conn: 'starting' | 'ready' | 'exited' | 'error' = 'starting'
  private connDetail = ''

  /**
   * 正在生成标题的会话（防并发）。
   *
   * 用户要求每轮都重算，所以它只做「同一会话不要同时跑两个标题进程」，
   * 而不是「一个会话只生成一次」。
   */
  private titleTried = new Set<string>()

  /** 上一次真的写进 pi 的标题（去重，避免每轮都改会话文件） */
  private lastTitle: string | undefined

  /**
   * pi 的 queue_update 只有文本数组。Yan 在主进程补稳定 id，渲染端的
   * 撤回/插队都只携带这个 id，重复文本也不会因为数组位置变化而误删。
   */
  private queueState: QueueState = { steering: [], followUp: [] }
  private queueSequence = 0
  /** clear_queue + 重排必须串行，避免两次撤回互相覆盖恢复结果。 */
  private queueOperations: Promise<void> = Promise.resolve()

  /** 供渲染端拉取（补上可能错过的 push） */
  getConn(): { state: 'starting' | 'ready' | 'exited' | 'error'; detail: string } {
    return { state: this.conn, detail: this.connDetail }
  }

  /** 统一的连接状态出口：缓存 + 推送 */
  private setConn(state: 'starting' | 'ready' | 'exited' | 'error', detail = ''): void {
    this.conn = state
    this.connDetail = detail
    this.push({ ch: 'proc', payload: { state, detail } })
  }

  /* ---------------------------------------------------------------- 启动 */

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.rpc?.running) return { ok: true }

    this.resetQueue()
    this.setConn('starting')

    /* 先起能力服务：pi 的环境变量里要有它的地址与令牌。 */
    await this.ensureCapability()

    const managedSkillArgs = this.capabilityOpts?.projectId
      ? await activeSkillArgs(YAN_DIR, this.capabilityOpts.projectId)
      : []
    /* 项目 settings 登记的 pi 包：`--no-extensions` 会关掉它们，这里显式补回。 */
    const projectPackageArgs = await projectPiPackageArgs(this.cwd)
    const rpc = new PiRpc({
      cwd: this.cwd,
      piBin: this.piBin,
      args: [
        /*
         * 01-S5：砚默认启动不接管用户的 pi 扩展 / Skill 自动发现。
         * 下面的 --extension / --skill 仍是砚自己明确传入的受管资源，
         * 因此不会把允许的薄层或当前项目 active Skill 一并关掉。
         */
        '--no-extensions',
        '--no-skills',
         // 工作模式的提问指引薄层（真正入口是宿主 yan question ask）
        ...(this.questionExtension ? ['--extension', this.questionExtension] : []),
        /*
         * 工作模式的工具策略（实施-05 S3）：计划档把非只读工具从表里拿掉。
         * 放最后加载：它要在其它扩展注册完工具之后再收紧工具表。
         */
        ...(this.workModeExtension ? ['--extension', this.workModeExtension] : []),
        /* 续行（实施-05 S3b）：就绪转移后由它发一条 custom 控制消息并触发回合 */
        ...(this.goalResumeExtension ? ['--extension', this.goalResumeExtension] : []),
        /* 交接包生成（实施-05 S5b-2）：宿主写请求，它调一次 completion 写结果 */
        ...(this.handoffsExtension ? ['--extension', this.handoffsExtension] : []),
        // 回复详细程度（简洁 / 标准 / 详细）：standard 档不注入任何东西
        ...(this.responseDetailExtension ? ['--extension', this.responseDetailExtension] : []),
        // 系统提示开场白：把 pi 内置英文 preamble 换成砚的中文开场白
        ...(this.preambleExtension ? ['--extension', this.preambleExtension] : []),
        // 界面语言 → 推理/回复语言：每轮读设置注入一句（不再用启动参数）
        ...(this.languageExtension ? ['--extension', this.languageExtension] : []),
        // 能力入口说明：告诉模型有 `yan` 这个入口、输出怎么读（静态文本，不破缓存）
        ...(this.capabilityGuideExtension
          ? ['--extension', this.capabilityGuideExtension]
          : []),
        // 上下文状态化压缩（N21-4）：默认清扫 + 可召回墓碑，阶段启用由 ContextPolicy.kinds 决定
        ...(this.contextExtension ? ['--extension', this.contextExtension] : []),
        /*
         * 项目知识注入（实施-03 S3）：宿主本轮先检索并写好注入文件，
         * 扩展在 `before_provider_request` 把它放到最后一条用户消息之前。
         * 与其它薄层成员一样：只做「钩子能做、CLI / RPC 做不到」的那一步。
         */
        ...(this.projectKnowledgeExtension ? ['--extension', this.projectKnowledgeExtension] : []),
        /*
         * 单轮重复动作兜底（2026-09-22）：连续 3 次相同调用提醒、5 次拦下。
         * 放最后：它要在其它扩展都不拦的时候才生效（不抢模式门禁的判断）。
         */
        ...(this.repeatGuardExtension ? ['--extension', this.repeatGuardExtension] : []),
        /* 受管 skill-files 只按当前项目 active 记录显式传入；不扫描全盘。 */
        ...managedSkillArgs,
        /* 项目已授权登记的 pi 包：显式路径不受 `--no-extensions` 影响（见函数注释）。 */
        ...projectPackageArgs,
        /*
         * 测试通道：`YAN_PROBE_SKILL` 指定一个 SKILL.md 时，像受管技能那样
         * 用显式 `--skill` 传进去。产品自 01-S5 起带 `--no-skills`，
         * 不再自动发现 `piDir/skills` —— 旧夹具把技能摆在 piDir 下，
         * 在生产行为下永远不会被报告（capcli 曾因此变红）。
         */
        ...(process.env.YAN_PROBE && process.env.YAN_PROBE_SKILL
          ? ['--skill', process.env.YAN_PROBE_SKILL]
          : []),
        /*
         * 测试/CI 用固定模型（YAN_TEST_MODEL = "provider/modelId"）。
         * 由 scripts/test-live.mjs 统一注入为 commandcode 的免费模型，
         * 避免每次跑真实场景都需要选定/付费；个别场景（如发图）可在 CASES 里覆盖。
         */
        ...(process.env.YAN_TEST_MODEL ? ['--model', process.env.YAN_TEST_MODEL] : []),
        // 只在测试隔离时接管会话目录。
        // 平时不传 —— 传了 pi 就不再按 cwd 建项目子目录，
        // 会把新会话平铺到根目录，与用户已有会话分居两处。
        ...(SESSIONS_DIR_IS_OVERRIDE ? ['--session-dir', SESSIONS_DIR] : [])
        // 注意：**不传 --name**。
        // 曾经传 `--name 砚` 希望“好辨认”，结果每个新会话标题都是「砚」，
        // 在左栏里长得一模一样，等于没标题。
        // 让 pi 用首条用户消息当标题，才真正可辨认。
      ],
      env: {
        // 让内置扩展能读到桌面端设置（工作模式快照存在 desktop.json 旁边）。
        // 测试时 YAN_DATA_DIR 指向隔离目录，扩展会读到那份设置。
        YAN_DATA_DIR: YAN_DIR,
        // 便携版必须让 pi 也使用 EXE 同级的私有目录；否则它会回退到 ~/.pi。
        PI_CODING_AGENT_DIR: PI_AGENT_DIR,
        /*
         * 实例身份：薄层扩展靠它找到**自己那份**文件（工作模式快照、
         * 项目知识注入）。
         *
         * ⚠️ 必须与能力服务是否启动**解耦**：以前它只跟着 yanCliEnv 注入，
         * 一旦能力服务没起来（端口失败 / 测试里没给 capability），扩展就
         * 不知道自己是哪个实例 —— 模式快照读不到，自主档反而会弹窗
         *（ask 场景第 6 节实测抽到）。同一个值由两处保证：这里无条件注入，
         * 下面 yanCliEnv 再给一份（`yan` CLI 用）。
         */
        ...(this.capabilityOpts?.sessionId
          ? { YAN_SESSION_ID: this.capabilityOpts.sessionId }
          : {}),
        ...(this.capabilityOpts?.projectId
          ? { YAN_PROJECT_ID: this.capabilityOpts.projectId }
          : {}),
        /*
         * 宿主能力服务的地址（`yan` CLI 用）。
         *
         * 只在 pi 子进程里出现：不落盘、不进日志、不进渲染端。
         * PATH 前置启动器目录而**不改用户系统 PATH** —— pi 的 bash 工具
         * 继承的是这份环境，所以模型敲 `yan …` 一定命中随包那份。
         */
        ...(this.yanCliEnv
          ? {
              YAN_CLI_URL: this.yanCliEnv.url,
              YAN_CLI_TOKEN: this.yanCliEnv.token,
              PATH: `${this.yanCliEnv.binDir}${delimiter}${process.env.PATH ?? ''}`
            }
          : {})
      }
    })
    this.rpc = rpc

    rpc.on('stderr', (line) => {
      this.push({ ch: 'proc', payload: { state: 'stderr', detail: line } })
    })

    rpc.on('exit', (code) => {
      this.streaming = null
      this.setConn('exited', `pi 已退出（code=${code ?? 'null'}）`)
    })

    rpc.on('ui', (req) => this.handleUi(req))
    rpc.on('event', (evt) => this.handleEvent(evt))

    rpc.spawn()

    // 等 pi 起来（它要先加载扩展，可能几百 ms）
    const ok = await this.waitReady(20_000)
    if (!ok) {
      const msg = 'pi 启动超时（20s）。点「详情」看 stderr，或跑 npm run probe-pi。'
      this.setConn('error', msg)
      return { ok: false, error: msg }
    }

    this.setConn('ready')

    /*
     * 首次连接时主动问一次档位：pi 的 get_state 不提供它，而 store.reloadModels
     * 只会在渲染端某些时机跑；少了这一步，界面上档位会停在 unknown
     * （“上游未提供思考档位信息”）直到用户手动切一次模型。
     */
    void this.listThinkingLevels().catch(() => undefined)

    await this.hydrate()
    return { ok: true }
  }

  /** 等第一次 get_state 成功 */
  private async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await this.rpc!.command('get_state')
        if (res.success) return true
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  /** 拉一次全量：消息 + 状态 + 统计 + 任务 */
  private async hydrate(): Promise<void> {
    /*
     * 先要 `get_state`：下面读文件需要知道当前会话文件（也先把运行时身份
     * 对齐，再推消息快照）。
     */
    const state = await this.rpc!.command('get_state').catch(() => null)
    if (state?.success) this.setStateFrom(state.data as Record<string, unknown>)
    const sessionFile = this.state?.sessionFile

    /*
     * 历史来源：**磁盘上的完整历史优先**。
     *
     * pi 的 `get_messages` 只给「当前上下文」—— 压缩过的会话在界面上就只剩
     * 压缩后那一段（实测：磁盘 858 条 → 界面 86 条，首条用户消息也不在了）。
     * 界面上的「会话历史」应当与用户能看到的会话文件一致，所以这里直接用它；
     * `get_messages` 只在读不到文件时兜底（刚建、还没落盘的新会话）。
     * 这也是切换会话时 peek（同样走文件）与 sync 一致的原因 —— 不再先铺全量、
     * 再被权威快照压短（用户报的「切换会话历史丢失」）。
     */
    const fromFile = sessionFile ? await this.readHistoryOf(sessionFile) : null
    if (fromFile?.messages.length) {
      this.messages = fromFile.messages
    } else {
      const msgs = await this.rpc!.command('get_messages').catch(() => null)
      const raw = (msgs?.data as { messages?: unknown[] } | undefined)?.messages
      /*
       * 兜底路径同样把图片落盘：`get_messages` 是 pi 的**当前上下文**，
       * 里面带的 base64 与会话文件里的是同一份 → sha1 相同，不会重复写。
       */
      this.messages = Array.isArray(raw)
        ? normalizeHistory(raw, (mimeType, data) => localizeImage(join(YAN_DIR, 'attachments'), mimeType, data))
        : []
    }
    if (sessionFile) {
      this.messages = await new ArtifactStore(this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts'))
        .hydrateMessages(sessionFile, this.messages)
    }

    /*
     * 回合计时元数据（H-6）：pi 的 JSONL 不存 `elapsedMs`，所以这里把宿主
     * 自己记的那份挂回消息。挂不上（分叉裁掉、会话文件换过）的记录会被丢弃，
     * 宁可不显示用时，也不把它挂到别的回合上。
     */
    const timingBucket = timingKey(this.state?.sessionFile)
    if (timingBucket) {
      const records = await readTurnTimings(YAN_DIR, timingBucket).catch(() => [])
      if (records.length) this.messages = applyTurnTimings(this.messages, records)
    }

    /*
     * 全量替换了消息列表 → 工具索引必须跟着重建。
     *
     * ⚠️ 不能只 clear()：此刻可能还有一条正在流的助手消息（compaction_end
     *    会调 hydrate），它的 tools 不在 messages 里而在 streaming 上 ——
     *    漏登记的话，后续 tool_execution_* 全部找不到 call，工具行就再也不更新。
     */
    this.callIndex.clear()
    this.callOwner.clear()
    this.pushedOut.clear()
    for (const msg of this.messages) this.indexCalls(msg)
    for (const call of this.streaming?.tools ?? []) {
      this.registerCall(call, this.streaming?.id)
    }

    this.push({ ch: 'sync', payload: this.messages })
    const stats = await this.rpc!.command('get_session_stats').catch(() => null)
    if (stats?.success) this.push({ ch: 'stats', payload: this.statsForCurrentModel(stats.data as SessionStats) })

    // 任务清单（扩展写的 custom entry）
    void this.refreshTodos()

    // 历史会话的标题补生成：
    // 只对「还没有缓存的会话」做（force 默认 false，命中缓存就直接返回），
    // 所以切到一个看过的会话不会反复烧钱。
    this.titleTried.clear()
    this.lastTitle = undefined
    void this.maybeGenerateTitle()
  }

  /* ------------------------------------------------------------ 任务清单 */

  async getCustomEntries(): Promise<CustomEntry[]> {
    try {
      const res = await this.rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
      if (!res?.success) return []
      return (res.data?.entries ?? [])
        .filter((e) => e.type === 'custom')
        .map((e) => ({
          id: String(e.id ?? ''),
          customType: String(e.customType ?? ''),
          data: e.data
        }))
    } catch {
      return []
    }
  }

  /**
   * 重读任务清单并推给渲染端。
   *
   * 触发时机：hydrate、切会话、agent_settled 兜底，
   * **监听到任务工具执行完**（旧扩展写的 `panel_todos` 与宿主 `yan tasks apply` 的写入
   * 在同一次刷新里汇合，见下面两个来源），
   * 以及**宿主自己写完 `yan tasks apply` 之后**（S3）。
   *
   * 两个来源在此汇合：会话文件里的旧条目（`left-panel-tasks`）与
   * 宿主任务日志（`YAN_DIR/task-plans/<sessionId>.jsonl`）。合并规则
   * （同轮宿主优先、相邻轮合并）在 [todoSnapshotsFromEntries] 里，只有一份 ——
   * 同一份会话在「有宿主日志」与「只有旧条目」两种状态下必须显示同一套历史。
   */
  async refreshTodos(): Promise<SessionTodo[]> {
    try {
      const res = await this.rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
      if (!res?.success) return []
      const hostEntries = await this.taskPlanEntries()
      const snaps = todoSnapshotsFromEntries([...(res.data?.entries ?? []), ...hostEntries])
      /*
       * 推两条：
       *   · todos —— 最新那份（旧行为不变，界面主体的任务清单就是它）
       *   · todo-history —— 全部快照（含最新），供「历史任务」模块用
       * 兼容性：单独加一条 push 而不是改 todos 的形状 ——
       * 已有探针与界面都按「todos = 当前清单」写的。
       */
      const latest = snaps.length ? snaps[snaps.length - 1].todos : []
      this.push({ ch: 'todos', payload: latest })
      this.push({ ch: 'todo-history', payload: snaps })
      return latest
    } catch {
      return []
    }
  }

  /**
   * 宿主任务日志 → 与会话条目同形的条目（喂给历史归并）。
   *
   * 读不了（权限 / 磁盘 / 会话还没就绪）时**退回旧条目**而不是把整块清空：
   * 旧条目是会话文件里的真话，不能因为宿主日志读不到就一起看不见。
   * 但也不假装它存在 —— 清单会退回旧来源，与「本会话从未写过宿主日志」同形。
   */
  private async taskPlanEntries(): Promise<Record<string, unknown>[]> {
    const sessionId = this.state?.sessionId
    if (!sessionId || !isSafeSessionId(sessionId)) return []
    try {
      return (await readTaskPlanLog(sessionId)).map(taskPlanLogEntry)
    } catch {
      return []
    }
  }

  /* ------------------------------------------------------- 宿主能力命令 */

  /**
   * `yan` CLI 的业务命令实现点（S3 起有 `tasks.apply`，01-S4b 加 `browser.*`）。
   *
   * 未实现的命令**明确报错**，不静默成功 —— 能力入口先接通、
   * 具体能力按 02 / 03 / 04 各自落地（01-S2 的约定）。
   */
  private async runCapabilityCommand(
    command: string,
    params: Record<string, unknown>
  ): Promise<CapabilityCommandResult> {
    if (command.startsWith('browser.')) {
      return this.runBrowserCommand(command.slice('browser.'.length), params)
    }
    if (command.startsWith('subagent.')) {
      if (!this.subagentHost) {
        throw new CapabilityCommandError('subagent_unavailable', '子代理宿主入口当前不可用')
      }
      return this.subagentHost.run(command, params, {
        cwd: this.cwd,
        /* state.sessionId 是真正的父会话；新会话尚未落盘时退回 runner id。 */
        parentSessionId: this.state?.sessionId ?? this.capabilityOpts?.sessionId,
        parentRunId: this.capabilityOpts?.sessionId,
        parentMessageId: this.latestAssistantMessageId(),
        projectId: this.capabilityOpts?.projectId
      })
    }
    if (command === 'capabilities.search') {
      return this.runCapabilitiesSearch(params)
    }
    if (command === 'capabilities.discover') {
      return this.runCapabilitiesDiscover(params)
    }
    if (command === 'capabilities.prepare') {
      return this.runCapabilitiesPrepare(params)
    }
    if (command === 'capabilities.acquire') {
      return this.runCapabilitiesAcquire(params)
    }
    if (command === 'skill.read') {
      return this.runSkillRead(params)
    }
    if (command.startsWith('mcp.')) {
      return this.runMcpCommand(command.slice('mcp.'.length), params)
    }
    if (command.startsWith('knowledge.')) {
      return this.runKnowledgeCommand(command.slice('knowledge.'.length), params)
    }
    /*
     * 目标状态（实施-05 S3）：`goal.ready` 是「计划档就绪 → 切标准」的唯一入口。
     * 实现落在 index.ts —— 会话文件键与模式 store 都在那边，
     * 在这里再拼一份就会有两套「这是哪个会话」的真相。
     */
    if (command.startsWith('goal.')) {
      if (!this.goalHost) {
        throw new CapabilityCommandError('goal_unavailable', '目标状态入口当前不可用（宿主未注入）')
      }
      return this.goalHost.run(command, params, {
        sessionId: this.capabilityOpts?.sessionId ?? 'primary',
        projectId: this.capabilityOpts?.projectId ?? ''
      })
    }
    if (command === 'image.generate') return this.runImageCommand(params)
    if (command === 'artifact.attach') return this.runArtifactAttachCommand(params)
    if (command === 'question.ask') return this.runQuestionCommand(params)
    if (command === 'context.recall') return this.runContextRecallCommand(params)
    switch (command) {
      case 'tasks.apply':
        return this.applyTaskPlan(params)
      default:
        throw new CapabilityCommandError('not_implemented', `命令已接通但尚未实现：${command}`)
    }
  }

  /** 取当前工具所属的真实 assistant 消息，避免产物变成游离 UI 卡片。 */
  private latestAssistantMessageId(): string {
    if (this.streaming?.id) return this.streaming.id
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].role === 'assistant') return this.messages[i].id
    }
    return `artifact-${Date.now().toString(36)}`
  }

  /**
   * `yan question ask` 的宿主实现。
   *
   * 这是一个普通能力命令，不是 pi 模型工具：模型通过原生 `bash` 调 CLI，
   * 主进程把请求推给现有问题面板，答案再由 renderer IPC 回到这里。这样既
   * 保留同一请求 id 的等待 / 取消语义，也不让薄层注册第二个业务工具。
   */
  private async runQuestionCommand(
    params: Record<string, unknown>
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const question = typeof params.question === 'string' ? params.question.trim() : ''
    if (!question) throw new CapabilityCommandError('question_missing', 'question ask 需要 question')
    if (question.length > 4000) throw new CapabilityCommandError('question_too_long', '问题不能超过 4000 个字符')

    const rawOptions = params.options
    const options = Array.isArray(rawOptions)
      ? rawOptions.map((item) => {
          if (typeof item === 'string') return item.trim()
          if (item && typeof item === 'object' && 'label' in item && typeof item.label === 'string') {
            return item.label.trim()
          }
          return ''
        }).filter(Boolean)
      : []
    if (options.length > 8) throw new CapabilityCommandError('question_options_too_many', '问题最多提供 8 个选项')
    if (options.some((option) => option.length > 500)) {
      throw new CapabilityCommandError('question_option_too_long', '问题选项不能超过 500 个字符')
    }

    const mode = await this.capabilityOpts?.getWorkMode?.()
    if (mode === 'autonomous') {
      return {
        data: { question, options, answer: null, autonomous: true, cancelled: false },
        summary: { kind: 'question', action: 'ask', mode, answered: false, autonomous: true }
      }
    }

    const rawTimeout = Number(params.timeout)
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.max(Math.floor(rawTimeout), 5_000), 10 * 60_000)
      : 120_000
    const customLabel = '其他（自行输入） / Other (type your own)'
    let response: HostUiResponse
    if (options.length === 0) {
      response = await this.requestHostUi({
        method: 'input',
        title: '需要你的回答',
        message: question,
        timeout
      })
    } else {
      response = await this.requestHostUi({
        method: 'select',
        title: '需要你的选择',
        message: question,
        options: [...options, customLabel],
        timeout
      })
      if (!response.cancelled && response.value === customLabel) {
        response = await this.requestHostUi({
          method: 'input',
          title: '请输入自定义回答',
          message: question,
          timeout
        })
      }
    }

    const answer = typeof response.value === 'string' && response.value.trim()
      ? response.value.trim()
      : null
    const cancelled = response.cancelled === true || (answer === null && response.confirmed !== true)
    return {
      data: { question, options, answer, cancelled, autonomous: false },
      summary: { kind: 'question', action: 'ask', mode: mode ?? 'standard', answered: answer !== null, cancelled }
    }
  }

  /**
   * `yan context recall` 的宿主实现。
   *
   * 归档正文只从当前 AgentController 已绑定的原始会话读出；CLI 参数只能选
   * `ctx://` 引用，不能改会话、JSONL 路径、归档目录或结果文件。成功后交给
   * CapabilityServer 写为逐字保留的受管 `.txt`，native read 读到的前缀仍能
   * 被 context 薄层的 TTL 钩子识别。
   */
  private async runContextRecallCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const sessionId = this.state?.sessionId
    const sessionFile = this.state?.sessionFile
    if (!isSafeSessionId(sessionId) || !sessionFile) {
      throw new CapabilityCommandError('context_session_unavailable', '当前还没有可安全回读的会话')
    }
    try {
      return await recallArchivedContext({
        sessionId,
        sessionFile,
        ref: params.ref,
        reason: params.reason
      })
    } catch (error) {
      if (error instanceof ContextRecallError) {
        throw new CapabilityCommandError(error.code, error.message)
      }
      throw new CapabilityCommandError('context_recall_unavailable', '归档回读暂时不可用；未返回正文')
    }
  }

  /** 通过现有 `ui-request` / `yan:respondUi` 桥等待一次宿主问题。 */
  private requestHostUi(request: {
    method: 'select' | 'input'
    title: string
    message: string
    options?: string[]
    timeout: number
  }): Promise<HostUiResponse> {
    const id = `yan-question-${randomUUID()}`
    return new Promise<HostUiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHostUi.delete(id)
        this.pendingUi.delete(id)
        reject(new CapabilityCommandError('question_timeout', '问题等待超时，未猜测用户答案'))
      }, request.timeout)
      this.pendingHostUi.set(id, { resolve, reject, timer })
      this.uiSeen.add(id)
      this.pendingUi.add(id)
      this.push({
        ch: 'ui-request',
        payload: { id, method: request.method, title: request.title, message: request.message, timeout: request.timeout, ...(request.options ? { options: request.options } : {}) } as never
      })
    })
  }

  private async attachArtifact(artifact: AssistantArtifact, messageId = this.latestAssistantMessageId()): Promise<void> {
    const message = this.messages.find((item) => item.id === messageId)
    if (message) message.artifacts = [...(message.artifacts ?? []), artifact]
    this.push({ ch: 'artifact', payload: { messageId, artifact } })
  }

  private async runArtifactAttachCommand(params: Record<string, unknown>): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const sourcePath = typeof params.path === 'string' ? params.path.trim() : ''
    if (!sourcePath) throw new CapabilityCommandError('artifact_path_missing', 'artifact.attach 需要 path')
    const sessionFile = this.state?.sessionFile ?? join(YAN_DIR, 'artifact-sessions', this.capabilityOpts?.sessionId ?? 'primary')
    const artifact = await new ArtifactStore(this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts')).attach({
      sessionFile,
      messageId: this.latestAssistantMessageId(),
      cwd: this.cwd,
      sourcePath,
      description: typeof params.description === 'string' ? params.description : undefined
    })
    await this.attachArtifact(artifact)
    return {
      data: { artifact },
      summary: { artifactId: artifact.id, filename: artifact.filename, kind: artifact.kind, bytes: artifact.bytes }
    }
  }

  private async runImageCommand(params: Record<string, unknown>): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const request = params as unknown as ImageGenerationRequest
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw new CapabilityCommandError('image_prompt_missing', 'image.generate 需要 prompt')
    const requestedProvider = request.provider
    const resolved = resolveImageProvider(
      requestedProvider,
      await codexAuthAvailable(),
      !!process.env.OPENAI_API_KEY?.trim()
    )
    const messageId = this.latestAssistantMessageId()
    const progressId = `image-${randomUUID()}`
    const startedAt = Date.now()
    const provider = resolved === 'unavailable' ? undefined : resolved
    const model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : 'gpt-image-2'
    const publishProgress = (stage: ImageGenerationProgress['stage'], detail?: string): void => {
      const terminal = stage === 'done' || stage === 'error'
      const progress: ImageGenerationProgress = {
        id: progressId,
        stage,
        startedAt,
        updatedAt: Date.now(),
        ...(terminal ? { endedAt: Date.now() } : {}),
        ...(provider ? { provider } : {}),
        model,
        ...(detail ? { detail } : {})
      }
      const message = this.messages.find((item) => item.id === messageId)
      if (message) {
        message.imageProgress = [
          ...(message.imageProgress ?? []).filter((item) => item.id !== progressId),
          progress
        ]
      }
      this.push({ ch: 'msg-update', payload: { id: messageId, patch: { imageProgress: [progress] } } })
    }

    publishProgress('queued', '已加入当前回合')
    try {
      if (resolved === 'openai' || resolved === 'compatible') {
        publishProgress('confirming', '等待确认外部图像 API 请求')
        const allowed = await this.confirmExternalApi?.({
          provider: resolved,
          endpoint: resolved === 'compatible' ? (process.env.YAN_IMAGE_API_BASE ?? '') : 'https://api.openai.com/v1',
          model,
          prompt,
          cwd: this.cwd
        })
        if (!allowed) throw new CapabilityCommandError('external_api_denied', '已取消：未获得 OpenAI-compatible API 请求确认')
      }
    const sessionFile = this.state?.sessionFile ?? join(YAN_DIR, 'artifact-sessions', this.capabilityOpts?.sessionId ?? 'primary')
    const result = await generateImage({ ...request, prompt }, {
      sessionFile,
      messageId,
      artifactDir: this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts'),
      onProgress: publishProgress
    })
    await this.attachArtifact(result.artifact)
    publishProgress('done', `${result.artifact.filename} · ${result.artifact.bytes} bytes`)
    return {
      data: { artifact: result.artifact, provider: result.provider, model: result.model, revisedPrompt: result.revisedPrompt },
      summary: { provider: result.provider, model: result.model, artifactId: result.artifact.id, filename: result.artifact.filename, bytes: result.artifact.bytes }
    }
    } catch (error) {
      publishProgress('error', imageFailureDetail(error))
      throw error
    }
  }

  /* ------------------------------------------------ 能力目录与技能（实施-04 S2） */

  /**
   * 来源搜索入口的可用性（实施-07 S4）。
   *
   * 方案对「网页搜索」的硬条件是「只在已发现兼容搜索能力时启用」——
   * 所以这个方法的职责是**判断**，不是实现搜索：把当前目录（内置 + 已装 Skill +
   * 已接 MCP 工具）交给纯函数的判定，命中就返回那条能力，否则 `available: false`。
   * 目录取不到时也当「没有」：入口是增益，不该因为能力服务抖动而弹错。
   */
  async webSearchAvailability(): Promise<WebSearchAvailability> {
    try {
      const commands = await this.rawCommands()
      const mcp = await this.collectMcpCatalog()
      const catalog = buildCatalog(commands, mcp.tools)
      return webSearchAvailability(catalog.capabilities)
    } catch {
      return { available: false }
    }
  }

  /**
   * `yan capabilities search`：把「这个会话现在能用什么」变成模型可读的候选列表。
   *
   * 只覆盖**已装 / 已加载**范围（S2）；联网发现是 S5 的 `capabilities.discover`。
   * 目录里出现**不代表授权**：调用仍走各自命令的身份与边界校验（实施-04 §6）。
   */
  /**
   * 把已配置 MCP 服务的工具接进能力目录（实施-04 S4）。
   *
   * 为什么必须连一次服务：MCP 工具名对 pi **完全不可见**（S1 预检四条证据），
   * 模型唯一能“自己发现”它们的入口就是这份目录 —— 所以 `capabilities search`
   * 必须能列出工具，而不是只列内置命令与技能。这正是 S4 的出口：
   * 「工具不直接出现在初始 prompt 也能用」。
   *
   * 两个刻意的取舍：
   * 1. **连不上的服务不冒充可用**：单列一条 `mcpServers` 状态，
   *    带 `disconnected` / `needs-auth` 与真实原因，模型据此知道“有这个服务但连不上”，
   *    而不是去猜自己命令写错了。
   * 2. **总超时有界**：不能因为一个服务挂着就把整次 search 拖死；
   *    超时的服务与连不上同样处理。
   */
  private async collectMcpCatalog(): Promise<{
    tools: McpCatalogEntry[]
    servers: Array<Record<string, unknown>>
  }> {
    const manager = this.mcpConnectionManager()
    const tools: McpCatalogEntry[] = []
    const servers: Array<Record<string, unknown>> = []
    const serverIds = manager.listServerIds()
    const projectScopeById = new Map(manager.list().map((server) => [server.id, server.projectScope]))
    if (serverIds.length === 0) {
      return {
        tools,
        servers: this.mcpConfigError ? [{ serverId: null, status: 'config-error', error: this.mcpConfigError }] : []
      }
    }

    await Promise.all(
      serverIds.map(async (serverId) => {
        try {
          const listed = await this.withCatalogTimeout(manager.listToolsCached(serverId), serverId)
          for (const tool of listed) {
            tools.push({
              serverId,
              toolName: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              schemaRevision: schemaRevisionOf(tool.inputSchema),
              /* 服务自报 readOnlyHint 不当权限（§4）：目录里一律标 unknown。 */
              effect: 'unknown',
              ...(projectScopeById.get(serverId) ? { projectScope: projectScopeById.get(serverId) } : {})
            })
          }
          const status = manager.statusOf(serverId)
          servers.push({
            serverId,
            status: status.status === 'disconnected' && listed.length > 0 ? 'ready' : status.status,
            toolCount: listed.length,
            ...(status.error ? { error: status.error } : {})
          })
        } catch (error) {
          const status = manager.statusOf(serverId)
          servers.push({
            serverId,
            status: status.status,
            toolCount: 0,
            error: status.error ?? (error instanceof Error ? error.message : String(error))
          })
        }
      })
    )

    if (this.mcpConfigError) servers.push({ serverId: null, status: 'config-error', error: this.mcpConfigError })
    tools.sort((a, b) => a.serverId.localeCompare(b.serverId) || a.toolName.localeCompare(b.toolName))
    servers.sort((a, b) => String(a.serverId).localeCompare(String(b.serverId)))
    return { tools, servers }
  }

  /** 目录收集的硬超时：比单次调用短得多，因为它在**每次 search** 都要跑。 */
  private async withCatalogTimeout<T>(work: Promise<T>, serverId: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`列出 ${serverId} 的工具超时（3000ms）`)), 3000)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 本轮发现到的候选（仅宿主持有）。
   *
   * 为什么不让模型把候选原样传回 `prepare`：那等于让模型自己决定「要装什么」，
   * 而 §8 明确要求**主进程负责结构校验与来源一致性**。模型只能回传 ID，
   * 候选内容从这条缓存里取 —— 缓存过期（10 分钟）就要求重新检索。
   */
  private readonly discoveryCandidates = new Map<string, { candidate: CapabilityCandidate; at: number }>()

  /**
   * 最近生成过的接入计划（仅宿主持有）。
   *
   * `prepare` 只把 `planId` 交给模型，`acquire` 拿回同一个 ID 时要从这里取回
   * 完整计划与候选 —— 否则模型可以把任意字符串当计划传回来（§8：主进程负责
   * 结构校验与来源一致性）。TTL 与候选一致（10 分钟）。
   */
  private readonly acquisitionPlans = new Map<
    string,
    { plan: AcquisitionPlan; candidate: CapabilityCandidate; digest: string; at: number }
  >()

  /** `yan capabilities discover`：联网检索缺失能力（实施-04 §7）。 */
  private async runCapabilitiesDiscover(params: Record<string, unknown>) {
    const strategy = await this.capabilityOpts?.getCapabilityStrategy?.()
    if (strategy === 'existing-only') {
      throw new CapabilityCommandError(
        'capability_policy_existing_only',
        '当前能力策略为「仅已有能力」，不会联网搜索。可在设置 → 能力中更改策略。'
      )
    }
    const queryText = this.knowledgeString(params, ['queryText', 'query-text', 'query', 'text']) ?? ''
    const goalText = this.knowledgeString(params, ['goal', 'goalText', 'goal-text'])
    const timeoutMs = this.knowledgeNumber(params, 'timeoutMs')
    const outcome = await discoverCapabilities({
      queryText,
      ...(goalText ? { goalText } : {}),
      ...(timeoutMs ? { timeoutMs } : {})
    })

    const now = Date.now()
    for (const { candidate } of outcome.candidates) {
      this.discoveryCandidates.set(candidate.candidateId, { candidate, at: now })
    }
    for (const [id, entry] of this.discoveryCandidates) {
      if (now - entry.at > 10 * 60_000) this.discoveryCandidates.delete(id)
    }

    return {
      data: {
        query: outcome.query,
        reason: outcome.reason,
        sources: outcome.sources,
        candidates: outcome.candidates.map(({ candidate, score, reasons }) => ({
          ...candidate,
          score,
          scoreReasons: reasons
        })),
        /*
         * 说清这一层能做到什么：目录元数据**只证明发布来源存在**，
         * 不等于已审计、也不等于能在这台机器上跑（§8）。
         */
        notice:
          '候选来自公开目录的元数据（verification=metadata-only）：只证明发布来源存在，不等于代码已审计，也不等于已验证可用。' +
          '下一步用 yan capabilities prepare --candidate <候选ID> 生成接入计划（S5 只生成，不执行）。'
      },
      summary: {
        kind: 'capabilities',
        action: 'discover',
        query: outcome.query,
        count: outcome.candidates.length,
        sourceOk: outcome.sources.filter((s) => s.ok).length,
        sourceFailed: outcome.sources.filter((s) => !s.ok).map((s) => s.sourceId),
        reason: outcome.reason,
        candidateIds: outcome.candidates.map((c) => c.candidate.candidateId)
      }
    }
  }

  /** `yan capabilities prepare`：把已检索到的候选变成接入计划（**不执行**）。 */
  private async runCapabilitiesPrepare(params: Record<string, unknown>) {
    const candidateId = this.knowledgeString(params, ['candidateId', 'candidate', 'candidate-id', 'id'])
    if (!candidateId) {
      throw new CapabilityCommandError(
        'candidate_required',
        '需要 --candidate <候选ID>（先跑 yan capabilities discover 拿候选）'
      )
    }
    const entry = this.discoveryCandidates.get(candidateId)
    if (!entry) {
      throw new CapabilityCommandError(
        'candidate_unknown',
        `没有这个候选：${candidateId}。候选只由宿主在 discover 后短暂保留（10 分钟），请重新检索。`
      )
    }
    let candidate = entry.candidate
    if (candidate.localPackage?.registryType === 'npm') {
      try {
        const metadata = await fetchNpmPackageMetadata({
          name: candidate.localPackage.identifier,
          version: candidate.localPackage.version ?? '',
          ...(candidate.integrity ? { expectedIntegrity: candidate.integrity } : {})
        })
        candidate = { ...candidate, integrity: metadata.integrity }
        /* prepare 之后候选指纹含精确 tarball SRI；后续不能被同版本 registry 漂移替换。 */
        this.discoveryCandidates.set(candidateId, { candidate, at: entry.at })
      } catch (error) {
        throw new CapabilityCommandError(
          'package_metadata_failed',
          `无法为固定 npm 候选取到可校验的 exact-version manifest：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    const { plan, digest } = planForCandidate({
      candidate,
      goalId: this.capabilityOpts?.sessionId ?? 'unknown-goal',
      projectId: this.capabilityOpts?.projectId ?? 'unknown-project'
    })
    const now = Date.now()
    this.acquisitionPlans.set(plan.planId, { plan, candidate, digest, at: now })
    for (const [id, cached] of this.acquisitionPlans) {
      if (now - cached.at > 10 * 60_000) this.acquisitionPlans.delete(id)
    }
    return {
      data: {
        plan,
        artifactDigest: digest,
        candidate,
        executable: false,
        notice:
          'S5 到这里为止：计划已生成但**不会执行**（下载 / 安装 / 登记是 S6）。' +
          'policyResult=needs-authorization 表示需要用户或策略授权才能继续。'
      },
      summary: {
        kind: 'capabilities',
        action: 'prepare',
        candidateId,
        planId: plan.planId,
        policyResult: plan.policyResult,
        pinnedSource: plan.pinnedSource
      }
    }
  }

  /**
   * `yan capabilities acquire`：执行接入计划（实施-04 §10）。
   *
   * 分三档如实处理，**不把「建了事务」当「装好了」**：
   *   · `needs-auth` / `unsupported` —— 候选自身缺条件，直接停住（`--authorize` 也绕不过去）；
   *   · `remote` MCP —— **真的登记**：核验端点 → 写受管配置 → 复核 → `resumed`（S6b-1）；
   *   · npm `pi-package` —— 获精确项目级代码授权后下载 / 校验并落受管 staging，安装仍等安全边界；
   *   · 其它本地 installKind —— 未获精确授权时停住；相应下载 / 安装器未接通时保持 `pending-boundary`。
   */
  private async runCapabilitiesAcquire(params: Record<string, unknown>) {
    const planId = this.knowledgeString(params, ['plan', 'planId', 'plan-id', 'id'])
    if (!planId) {
      throw new CapabilityCommandError(
        'plan_required',
        '需要 --plan <计划ID>（先跑 yan capabilities prepare --candidate <候选ID>）'
      )
    }
    const entry = this.acquisitionPlans.get(planId)
    if (!entry) {
      throw new CapabilityCommandError(
        'plan_unknown',
        `没有这个计划：${planId}。计划只由宿主在 prepare 后短暂保留（10 分钟），请重新 prepare。`
      )
    }
    const { plan, candidate, digest } = entry
    const workMode = await this.capabilityOpts?.getWorkMode?.()
    if (workMode === 'clarify') {
      throw new CapabilityCommandError(
        'capability_mode_clarify',
        '计划模式允许搜索与查看候选，但不允许接入能力；切换到标准或自主模式后再继续。'
      )
    }
    const strategy = await this.capabilityOpts?.getCapabilityStrategy?.()
    if (strategy === 'existing-only') {
      return {
        data: {
          plan,
          candidate,
          executable: false,
          state: 'policy-blocked',
          notice: '当前能力策略为「仅已有能力」，接入被宿主阻止；可在设置 → 能力中更改策略。'
        },
        summary: { kind: 'capabilities', action: 'acquire', planId: plan.planId, state: 'policy-blocked', executed: false }
      }
    }
    if (strategy === 'search-and-recommend') {
      return {
        data: {
          plan,
          candidate,
          executable: false,
          state: 'recommendation-only',
          notice: '当前策略只搜索并推荐，不会连接、下载或安装候选；请在设置 → 能力中改用授权范围内自动接入。'
        },
        summary: { kind: 'capabilities', action: 'acquire', planId: plan.planId, state: 'recommendation-only', executed: false }
      }
    }
    const operationId = operationIdOf({ planId: plan.planId, planRevision: plan.revision })
    const explicitAuthorize = params.authorize === true || params.authorize === 'true'

    if (plan.policyResult === 'needs-auth' || plan.policyResult === 'unsupported') {
      const notice =
        plan.policyResult === 'needs-auth'
          ? '这个候选需要认证：先按其发布方说明配置凭证（砚不代填、也不把凭证写进提示词）。'
          : '当前环境不支持这个候选（缺运行时 / 平台不符），未执行任何安装。'
      return {
        data: { plan, candidate, operationId, executable: false, state: plan.policyResult, notice },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: plan.policyResult,
          executed: false
        }
      }
    }

    /* §10：远程 MCP 不下载 —— 直接「核验端点 → 登记配置 → 连接 → 枚举工具」。 */
    if (candidate.installKind === 'remote') {
      return this.acquireRemoteMcp({ plan, candidate, digest, operationId, explicitAuthorize })
    }

    let packageGrant = await new PackageAuthorizationService(YAN_DIR).find({
      candidateId: candidate.candidateId,
      digest,
      projectId: plan.projectId
    })
    if (!packageGrant && explicitAuthorize) {
      const choice = await this.confirmCapabilityAuthorization?.({
        kind: 'local-package',
        title: candidate.title,
        source: candidate.candidateId,
        projectId: plan.projectId,
        cwd: this.cwd,
        digest
      }) ?? 'deny'
      if (choice !== 'deny') {
        packageGrant = await new PackageAuthorizationService(YAN_DIR).grant({
          candidateId: candidate.candidateId,
          digest,
          projectId: plan.projectId,
          allowLifecycleScripts: choice === 'allow-with-lifecycle-scripts'
        })
      }
    }
    if (!packageGrant) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: !packageGrant ? 'needs-authorization' : plan.policyResult,
          notice:
            '本地包 / Skill 可能执行代码或改变模型后续行为。模型不能自行授权；用 `--authorize` 发起砚的确认对话框并由你选择后，才会保存精确候选 + 指纹 + 项目级授权。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'needs-authorization',
          executed: false
        }
      }
    }

    const service = new AcquisitionService({ root: YAN_DIR })
    /* begin 是幂等的：同一个计划第二次进来拿回同一条事务，不会又装一遍（§10）。 */
    const created = await service.begin({
      planId: plan.planId,
      planRevision: plan.revision,
      candidateId: candidate.candidateId,
      digest,
      projectId: plan.projectId
    })
    let tx = created
    const explicitRetry = params.retry === true || params.retry === 'true'
    if (tx.state === 'failed' && explicitRetry) tx = await service.retry(tx.operationId)

    /* skill-files：固定声明的本地文件先 staging；active 与 runner 重载交给安全边界调度器。 */
    if (candidate.installKind === 'skill-files') {
      const declared = candidate.skillFiles ?? []
      try {
        if (tx.state === 'prepared') {
          const remoteFileUrls = candidate.skillFileUrls
          const files = remoteFileUrls
            ? (await fetchSkillFiles({
                fileUrls: remoteFileUrls,
                expectedHashes: candidate.skillFileHashes ?? {},
                allowedOrigins: candidate.sourceUrls,
                timeoutMs: 15_000
              })).map(({ path, content }) => ({ path, content }))
            : await Promise.all(declared.map(async (path) => {
                const source = declaredSkillFile(this.cwd, path)
                return { path: source.path, content: await readFile(source.absolute) }
              }))
          const staged = await stageSkillFiles({
            root: YAN_DIR,
            operationId: tx.operationId,
            candidateId: candidate.candidateId,
            projectId: plan.projectId,
            files,
            ...(candidate.skillFileHashes ? { expectedHashes: candidate.skillFileHashes } : {})
          })
          const securityNotice = staged.securityReview.findings.length > 0
            ? `${formatSkillSecurityReview(staged.securityReview)}；即使候选由用户指定，仍保留这份风险提醒。`
            : undefined
          if (securityNotice) {
            this.push({
              ch: 'log',
              payload: { text: `[能力接入] ${securityNotice}` }
            })
          }
          tx = await service.markBoundary(
            tx.operationId,
            'Skill 文件已完成 staging、hash 复核与内容安全审查；等待下一次 runner 安全启动',
            new Date().toISOString(),
            staged.securityReview
          )
        }
        const sessionFile = this.getState()?.sessionFile
        const runnerId = this.capabilityOpts?.sessionId
        const projectId = this.capabilityOpts?.projectId
        if (tx.state === 'pending-boundary' && !tx.skillFilesTarget && sessionFile && runnerId && projectId) {
          const goalStatus = this.goalHost
            ? await this.goalHost.run('goal.status', {}, { sessionId: runnerId, projectId })
            : null
          const goal = (goalStatus?.data as { goal?: { goalId?: unknown; revision?: unknown } } | undefined)?.goal
          if (this.goalHost && (!goal || !Number.isSafeInteger(goal.revision) || (goal.revision as number) < 0)) {
            throw new CapabilityCommandError('goal_snapshot_unavailable', '无法固定当前目标修订，事务保持待处理且不会自动激活')
          }
          const goalIdFromStatus = typeof goal?.goalId === 'string' && goal.goalId ? goal.goalId : undefined
          const goalRevisionFromStatus = Number.isSafeInteger(goal?.revision) && (goal?.revision as number) >= 0
            ? (goal?.revision as number)
            : undefined
          const goalId = goalIdFromStatus ?? plan.goalId
          const goalRevision = goalRevisionFromStatus ?? 0
          const sourceHead = (await readRepoState(this.cwd, { withRefs: false }))?.head ?? null
          tx = await service.bindSkillFilesTarget(tx.operationId, {
            runnerId,
            runnerGeneration: this.capabilityOpts?.runnerGeneration ?? 1,
            cwd: this.cwd,
            sessionFile,
            projectId,
            goalId,
            goalRevision,
            sourceHead,
            continueId: tx.operationId
          })
        }
        return {
          data: {
            plan,
            candidate,
            operationId,
            transaction: tx,
            securityReview: tx.securityReview,
            executable: false,
            state: tx.state,
            skills: declared,
            ...(tx.securityReview?.findings.length
              ? { notice: `${formatSkillSecurityReview(tx.securityReview)}；即使候选由用户指定，仍保留这份风险提醒。` }
              : {})
          },
          summary: {
            kind: 'capabilities',
            action: 'acquire',
            planId: plan.planId,
            operationId,
            state: tx.state,
            executed: tx.state === 'pending-boundary'
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const securityReview = error instanceof SkillSecurityError ? error.review : undefined
        if (securityReview) {
          this.push({ ch: 'log', payload: { text: `[能力接入] ${formatSkillSecurityReview(securityReview)}；已阻止激活。` } })
        }
        tx = securityReview
          ? await service.fail(tx.operationId, detail, new Date().toISOString(), securityReview)
          : await service.fail(tx.operationId, detail)
        return {
          data: { plan, candidate, operationId, state: 'failed', securityReview: tx.securityReview, notice: detail },
          summary: {
            kind: 'capabilities',
            action: 'acquire',
            planId: plan.planId,
            operationId,
            state: 'failed',
            executed: false
          }
        }
      }
    }

    let npmStaged = false
    let npmFailure: string | undefined
    const localPackage = candidate.localPackage
    const canStageNpmPackage =
      (candidate.installKind === 'pi-package' || candidate.installKind === 'mcp-package') &&
      localPackage?.registryType === 'npm' &&
      typeof localPackage.identifier === 'string' &&
      typeof (localPackage.version ?? candidate.version) === 'string' &&
      typeof candidate.integrity === 'string'

    if (tx.state === 'prepared' && canStageNpmPackage) {
      try {
        const staged = await stageNpmAcquisition({
          root: YAN_DIR,
          operationId: tx.operationId,
          candidateId: candidate.candidateId,
          digest,
          projectId: plan.projectId,
          name: localPackage.identifier,
          version: localPackage.version ?? candidate.version!,
          integrity: candidate.integrity!,
          ...(localPackage.fileSha256 ? { expectedSha256: localPackage.fileSha256 } : {})
        })
        tx = await service.get(tx.operationId) ?? tx
        if (tx.state === 'verifying') {
          const verified = await service.verifyStaged(tx.operationId)
          if (!verified.ok) throw new Error(`staging 复核失败：${verified.problems.join('；')}`)
          tx = await service.markBoundary(
            tx.operationId,
            `固定 npm 制品已校验并落入受管 staging（${staged.manifest.files.length} 个文件）；等待项目 runner 空闲后再安装`
          )
        }
        npmStaged = tx.state === 'pending-boundary'
      } catch (error) {
        npmFailure = error instanceof Error ? error.message : String(error)
        const latest = await service.get(tx.operationId)
        if (latest && latest.state !== 'failed' && latest.state !== 'cancelled' && latest.state !== 'resumed') {
          tx = await service.fail(tx.operationId, npmFailure)
        } else if (latest) {
          tx = latest
        }
      }
    } else if (tx.state === 'verifying') {
      /* 崩溃若发生在 stage 落盘后、pending-boundary 写入前，重放时补齐边界状态。 */
      const verified = await service.verifyStaged(tx.operationId)
      if (verified.ok) {
        tx = await service.markBoundary(tx.operationId, '受管 npm staging 已复核；等待项目 runner 空闲后再安装')
      } else {
        npmFailure = `staging 复核失败：${verified.problems.join('；')}`
        tx = await service.fail(tx.operationId, npmFailure)
      }
    } else if (tx.state === 'prepared') {
      tx = await service.markBoundary(
        tx.operationId,
        `等待对应下载 / 安装器（installKind=${candidate.installKind}${localPackage?.registryType ? `, registryType=${localPackage.registryType}` : ''}；当前不执行不支持的来源）`
      )
    }

    if (candidate.installKind === 'mcp-package' && tx.state === 'pending-boundary' && !npmStaged && !npmFailure) {
      const checked = await service.verifyStaged(tx.operationId)
      if (checked.ok) npmStaged = true
      else npmFailure = `受管 MCP staging 复核失败：${checked.problems.join('；')}`
    }

    /*
     * MCP npm 包由砚直接管理，不经过 pi install，也不要求重建当前 runner：
     * 受管 stdio 配置登记后，当前 AgentController 下一次调用会懒加载新服务。
     * 这里仍然保留 acquiring → verifying → activated → resumed 的证据链，
     * 以免「包在 staging」被误报成「服务可用」。
     */
    if (candidate.installKind === 'mcp-package') {
      return this.finishMcpPackageAcquire({
        service,
        tx,
        plan,
        candidate,
        digest,
        operationId,
        npmStaged,
        npmFailure,
        localPackage
      })
    }

    if (npmStaged && localPackage?.identifier && (localPackage.version ?? candidate.version)) {
      const sessionFile = this.getState()?.sessionFile
      const runnerId = this.capabilityOpts?.sessionId
      const projectId = this.capabilityOpts?.projectId
      if (sessionFile && runnerId && projectId) {
        const goalStatus = this.goalHost
          ? await this.goalHost.run('goal.status', {}, { sessionId: runnerId, projectId })
          : null
        const goal = (goalStatus?.data as { goal?: { goalId?: unknown; revision?: unknown } } | undefined)?.goal
        if (this.goalHost && (!goal || !Number.isSafeInteger(goal.revision) || (goal.revision as number) < 0)) {
          throw new CapabilityCommandError('goal_snapshot_unavailable', '无法固定当前目标修订，事务保持待处理且不会自动激活')
        }
        const goalId = typeof goal?.goalId === 'string' && goal.goalId ? goal.goalId : plan.goalId
        const goalRevision = Number.isSafeInteger(goal?.revision) && (goal?.revision as number) >= 0
          ? (goal?.revision as number)
          : 0
        const sourceHead = (await readRepoState(this.cwd, { withRefs: false }))?.head ?? null
        tx = await service.bindPiPackageTarget(tx.operationId, {
          runnerId,
          runnerGeneration: this.capabilityOpts?.runnerGeneration ?? 1,
          cwd: this.cwd,
          sessionFile,
          projectId,
          goalId,
          goalRevision,
          sourceHead,
          continueId: tx.operationId,
          packageName: localPackage.identifier,
          packageVersion: localPackage.version ?? candidate.version!
        })
      }
    }

    const stateNotice = npmFailure
      ? `npm 下载 / staging 失败：${npmFailure}。同一计划可显式使用 --retry 重试（最多一次）。`
      : npmStaged
        ? tx.piPackageTarget
          ? 'npm tarball 已按 prepare 固定的 SHA-512 校验并落入受管 staging；已持久绑定原项目 / runner / 会话，未运行 npm lifecycle、pi install 或包代码，等待目标项目 runner 安全边界调度。'
          : 'npm tarball 已按 prepare 固定的 SHA-512 校验并落入受管 staging；未运行 npm lifecycle、pi install 或包代码。当前会话尚无可持久恢复的目标绑定，需等会话保存后重试 acquire。'
        : tx.state === 'failed'
          ? `这个接入事务已失败：${tx.failure?.detail ?? '无更多错误细节'}。如尚有重试次数，可对同一计划使用 --retry。`
        : tx.state === 'pending-boundary'
          ? '事务正在等待安全边界；本次未执行安装、运行包代码或重启 runner。'
          : `这个候选的 installKind 是 ${candidate.installKind}，对应下载 / 安装 / 隔离验证仍待实施。`
    return {
      data: {
        plan,
        candidate,
        operationId: tx.operationId,
        transaction: tx,
        executable: false,
        state: tx.state,
        downloaded: npmStaged,
        installed: false,
        notice: stateNotice
      },
      summary: {
        kind: 'capabilities',
        action: 'acquire',
        planId: plan.planId,
        operationId: tx.operationId,
        state: tx.state,
        executed: false,
        downloaded: npmStaged,
        installed: false
      }
    }
  }

  private async finishMcpPackageAcquire(input: {
    service: AcquisitionService
    tx: Awaited<ReturnType<AcquisitionService['get']>>
    plan: AcquisitionPlan
    candidate: CapabilityCandidate
    digest: string
    operationId: string
    npmStaged: boolean
    npmFailure?: string
    localPackage?: CapabilityCandidate['localPackage']
  }) {
    const { service, plan, candidate, digest, operationId, localPackage } = input
    let tx = input.tx
    if (!tx) throw new CapabilityCommandError('acquire_failed', '接入事务已经不存在')
    if (input.npmFailure || !input.npmStaged || !localPackage?.identifier || !(localPackage.version ?? candidate.version)) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          transaction: tx,
          executable: false,
          state: tx.state,
          downloaded: input.npmStaged,
          installed: false,
          notice: input.npmFailure
            ? `MCP npm 包下载 / staging 失败：${input.npmFailure}。同一计划可显式使用 --retry 重试（最多一次）。`
            : 'MCP npm 包已登记接入事务，但固定制品尚未完成 staging；没有运行包代码。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: tx.state,
          executed: false
        }
      }
    }

    const packageRoot = join(stagingDirOf(YAN_DIR, operationId), 'payload', 'package')
    let resolved: Awaited<ReturnType<typeof resolveMcpPackage>>
    try {
      resolved = await resolveMcpPackage({
        packageRoot,
        candidateId: candidate.candidateId,
        title: candidate.title,
        expectedName: localPackage.identifier,
        expectedVersion: localPackage.version ?? candidate.version!
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await service.fail(operationId, `MCP 包入口解析失败：${detail}`).catch(() => undefined)
      throw new CapabilityCommandError('acquire_failed', detail)
    }

    const registration = new McpRegistrationService({ root: YAN_DIR })
    /* 幂等重放：已登记的本地 MCP 只重新核验，不重新写配置或启动多余副本。 */
    if (tx.state === 'activated' || tx.state === 'resumed') {
      const managed = (await registration.listManaged()).find((record) => record.serverId === resolved.config.id)
      const check = managed
        ? await registration.reverify(managed)
        : { ok: false, reasons: ['受管记录里没有这个本地 MCP 服务'] }
      if (!check.ok) {
        return {
          data: {
            plan,
            candidate,
            operationId,
            serverId: resolved.config.id,
            executable: false,
            state: tx.state,
            replayed: true,
            warnings: check.reasons,
            notice: `本地 MCP 服务 ${resolved.config.id} 的幂等复核未通过：${check.reasons.join('；')}`
          },
          summary: {
            kind: 'capabilities',
            action: 'acquire',
            planId: plan.planId,
            operationId,
            serverId: resolved.config.id,
            state: tx.state,
            executed: false,
            replayed: true
          }
        }
      }
      if (tx.state === 'activated') tx = await service.markResumed(operationId, '同一计划的本地 MCP 连接复核通过')
      this.mcpManager = undefined
      return {
        data: {
          plan,
          candidate,
          operationId,
          serverId: resolved.config.id,
          executable: true,
          state: tx.state,
          replayed: true,
          tools: managed?.tools ?? [],
          notice: `这个计划已经登记过本地 MCP 服务 ${resolved.config.id}，本次只做连接复核。`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          serverId: resolved.config.id,
          state: tx.state,
          executed: false,
          replayed: true
        }
      }
    }

    if (tx.state !== 'pending-boundary') {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: tx.state,
          transaction: tx,
          notice: `本地 MCP 事务当前处于 ${tx.state}，没有执行包代码。`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: tx.state,
          executed: false
        }
      }
    }

    try {
      tx = await service.markAcquiring(operationId, '受管 staging 已复核，开始本地 MCP 无副作用协议冒烟')
      const smoke = await smokeMcpPackage({ config: resolved.config })
      if (!smoke.ok) {
        await service.fail(operationId, `本地 MCP 冒烟失败：${smoke.problems.join('；')}`)
        throw new CapabilityCommandError('acquire_failed', smoke.problems.join('；'))
      }
      tx = await service.markVerifying(operationId, `MCP tools/list 冒烟通过，列到 ${smoke.tools.length} 个工具`)
      const outcome = await registration.registerStdio({
        config: resolved.config,
        projectId: plan.projectId,
        operationId,
        /* smoke 已经用同一份 command + args 真连并列出工具；把这份
         * receipt 交给登记层，避免在写配置前无意义地再启动一次第三方进程。 */
        probe: async (config) => {
          if (
            config.command !== resolved.config.command ||
            JSON.stringify(config.args ?? []) !== JSON.stringify(resolved.config.args ?? [])
          ) {
            throw new Error('本地 MCP 登记配置与刚通过 smoke 的入口不一致')
          }
          return { tools: smoke.tools.map((tool) => tool.name) }
        }
      })
      tx = await service.activate({
        operationId,
        receipt: {
          planId: plan.planId,
          planRevision: plan.revision,
          candidateId: candidate.candidateId,
          digest,
          scope: 'project-managed',
          projectId: plan.projectId,
          installedPaths: [outcome.configPath, resolved.packageRoot],
          verification: 'protocol-reachable'
        },
        verify: async () => ({ ok: true, problems: [] })
      })
      const managed = (await registration.listManaged()).find((record) => record.serverId === outcome.serverId)
      const check = managed
        ? await service.resumeCheck({
            operationId,
            expected: { planId: plan.planId, planRevision: plan.revision, digest },
            verify: async () => {
              const reverified = await registration.reverify(managed)
              return { ok: reverified.ok, problems: reverified.reasons }
            }
          })
        : { ok: false, reasons: ['受管登记记录缺失（本地 MCP 登记没完成）'] }
      tx = check.ok
        ? await service.markResumed(operationId, '本地 MCP 冒烟、登记与连接复核通过，可继续原目标')
        : await service.fail(operationId, `本地 MCP 激活后复核没通过：${check.reasons.join('；')}`)
      this.mcpManager = undefined
      return {
        data: {
          plan,
          candidate,
          operationId,
          serverId: outcome.serverId,
          tools: outcome.tools,
          configPath: outcome.configPath,
          executable: check.ok,
          state: tx.state,
          installed: check.ok,
          resume: { goalId: plan.goalId, continueHint: '本地 MCP 已登记；原目标可以继续' },
          ...(check.ok ? {} : { problems: check.reasons }),
          notice: check.ok
            ? `已接入本地 MCP 服务 ${outcome.serverId}（工具 ${outcome.tools.length} 个）：固定 npm 制品、无副作用冒烟与项目隔离登记均通过。`
            : `本地 MCP 服务 ${outcome.serverId} 已处理，但激活后复核没通过：${check.reasons.join('；')}`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          serverId: outcome.serverId,
          state: tx.state,
          executed: check.ok
        }
      }
    } catch (error) {
      if (error instanceof CapabilityCommandError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      await service.fail(operationId, detail).catch(() => undefined)
      throw new CapabilityCommandError('acquire_failed', detail)
    }
  }

  /**
   * 远程 MCP 的**自动登记**（实施-04 S6b-1）。
   *
   * 授权是这一片的关键分界（§9）：目录元数据（`metadata-only`）不足以自动接入，
   * `--authorize` 只请求 Electron 确认对话框；用户点允许后，同一 host + project
   * 才成为持久策略 —— 不每次都问一遍，也不把目录内容或模型参数当用户授权。
   */
  private async acquireRemoteMcp(input: {
    plan: AcquisitionPlan
    candidate: CapabilityCandidate
    digest: string
    operationId: string
    explicitAuthorize: boolean
  }) {
    const { plan, candidate, digest, operationId, explicitAuthorize } = input
    const draftResult = draftRemoteMcpRegistration(candidate)
    if (!draftResult.ok) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          executable: false,
          state: 'unsupported',
          notice: draftResult.detail
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'unsupported',
          executed: false
        }
      }
    }
    const { draft } = draftResult
    const registration = new McpRegistrationService({ root: YAN_DIR })
    let authorization: AcquireAuthorization | null = null
    let authorized =
      plan.policyResult === 'automatic' || (await registration.isAuthorized(draft.endpoint, plan.projectId))
    if (!authorized && explicitAuthorize) {
      const choice = await this.confirmCapabilityAuthorization?.({
        kind: 'remote-mcp',
        title: candidate.title,
        source: candidate.candidateId,
        projectId: plan.projectId,
        cwd: this.cwd,
        digest,
        endpoint: draft.endpoint
      }) ?? 'deny'
      if (choice === 'allow') {
        authorization = await registration.authorize({
          url: draft.endpoint,
          via: 'user-confirmed-dialog',
          projectId: plan.projectId
        })
        authorized = true
      }
    }
    if (!authorized) {
      return {
        data: {
          plan,
          candidate,
          operationId,
          endpoint: draft.endpoint,
          serverId: draft.serverId,
          executable: false,
          state: 'needs-authorization',
          warnings: draft.warnings,
          notice:
            '候选来自公开目录（metadata-only），不足以自动登记。可以用 ' +
            '`yan capabilities acquire --plan <计划ID> --authorize` 请求砚显示确认对话框；只有你在对话框里允许后才会持久授权这个 host（只记 host，不记凭证）。'
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId,
          state: 'needs-authorization',
          executed: false,
          endpoint: draft.endpoint
        }
      }
    }

    const service = new AcquisitionService({ root: YAN_DIR })
    const created = await service.begin({
      planId: plan.planId,
      planRevision: plan.revision,
      candidateId: candidate.candidateId,
      digest,
      projectId: plan.projectId
    })
    /* 幂等重放：已经登记过的计划不重复写配置，只复核一次（§10「不能装两次」）。 */
    if (created.state === 'activated' || created.state === 'resumed') {
      const managed = (await registration.listManaged()).find((record) => record.serverId === draft.serverId)
      const check = managed ? await registration.reverify(managed) : { ok: false, reasons: ['受管记录里没有这个服务'] }
      const tx =
        check.ok && created.state === 'activated'
          ? await service.markResumed(created.operationId, '复核通过（同一计划的幂等重放）')
          : created
      return {
        data: {
          plan,
          candidate,
          operationId: tx.operationId,
          serverId: draft.serverId,
          executable: true,
          state: tx.state,
          replayed: true,
          ...(check.ok ? {} : { warnings: check.reasons }),
          notice: check.ok
            ? `这个计划已经登记过 ${draft.serverId}，本次只做复核，没有重复写入配置。`
            : `这个计划登记过 ${draft.serverId}，但复核没通过：${check.reasons.join('；')}`
        },
        summary: {
          kind: 'capabilities',
          action: 'acquire',
          planId: plan.planId,
          operationId: tx.operationId,
          state: tx.state,
          executed: false,
          replayed: true
        }
      }
    }

    await service.markAcquiring(operationId, `登记远程 MCP（核验 ${draft.endpoint} 后写入受管配置）`)
    let outcome: McpRegistrationOutcome
    try {
      outcome = await registration.registerRemote({
        draft,
        projectId: plan.projectId,
        operationId
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await service.fail(operationId, message).catch(() => undefined)
      throw new CapabilityCommandError('acquire_failed', message)
    }

    await service.markVerifying(operationId, `端点核验通过，列到 ${outcome.tools.length} 个工具`)
    await service.activate({
      operationId,
      receipt: {
        planId: plan.planId,
        planRevision: plan.revision,
        candidateId: candidate.candidateId,
        digest,
        scope: 'project-managed',
        projectId: plan.projectId,
        installedPaths: [outcome.configPath],
        /* 真的连上并枚举过工具 —— 不是「文件在」那种弱验证（§10 第 5 条）。 */
        verification: 'protocol-reachable'
      },
      /* 核验已由 registerRemote 的真实 probe 完成；这里不重复连一次。 */
      verify: async () => ({ ok: true, problems: [] })
    })
    /* `resumed` 必须由**真正的连接证据**置位（§10.2）：这里再复核一次。 */
    const managed = (await registration.listManaged()).find((record) => record.serverId === outcome.serverId)
    const check = managed
      ? await service.resumeCheck({
          operationId,
          expected: { planId: plan.planId, digest, planRevision: plan.revision },
          verify: async () => {
            const reverified = await registration.reverify(managed)
            return { ok: reverified.ok, problems: reverified.reasons }
          }
        })
      : { ok: false, reasons: ['受管登记记录缺失（登记没完成）'] }
    const tx = check.ok
      ? await service.markResumed(operationId, '登记 + 连接复核通过，可继续原目标')
      : await service.fail(operationId, `激活后复核没通过：${check.reasons.join('；')}`)

    /* 让下一次能力目录 / mcp 调用重新读配置：新服务**当场可见**，不需要重启（§10.1）。 */
    this.mcpManager = undefined

    return {
      data: {
        plan,
        candidate,
        operationId,
        serverId: outcome.serverId,
        endpoint: draft.endpoint,
        tools: outcome.tools,
        configPath: outcome.configPath,
        executable: true,
        state: tx.state,
        ...(authorization ? { authorization } : {}),
        warnings: outcome.warnings,
        resume: { goalId: plan.goalId, continueHint: '登记完成；原目标可以继续（能力目录里已经能看到它）' },
        ...(check.ok ? {} : { problems: check.reasons }),
        notice: check.ok
          ? `已登记远程 MCP 服务 ${outcome.serverId}（工具 ${outcome.tools.length} 个）：一次真连核验通过后才写配置，写的是受管配置。`
          : `服务 ${outcome.serverId} 已写入配置，但激活后复核没通过：${check.reasons.join('；')}`
      },
      summary: {
        kind: 'capabilities',
        action: 'acquire',
        planId: plan.planId,
        operationId,
        serverId: outcome.serverId,
        state: tx.state,
        executed: check.ok,
        toolCount: outcome.tools.length
      }
    }
  }

  private async runCapabilitiesSearch(params: Record<string, unknown>) {
    const queryText = this.knowledgeString(params, ['queryText', 'query-text', 'query', 'text']) ?? ''
    const limit = this.knowledgeNumber(params, 'limit')
    const scope = this.knowledgeString(params, ['scope'])
    if (scope && scope !== 'available') {
      throw new CapabilityCommandError(
        'capability_scope_unsupported',
        `capabilities search 目前只支持 scope=available（收到 ${scope}）；联网发现是 capabilities.discover`
      )
    }
    const commands = await this.rawCommands()
    const mcp = await this.collectMcpCatalog()
    const catalog = buildCatalog(commands, mcp.tools)
    const result = searchCapabilities(catalog.capabilities, {
      queryText,
      limit,
      projectId: this.capabilityOpts?.projectId
    })
    return {
      data: {
        query: queryText,
        considered: result.considered,
        reason: result.reason,
        conflicts: catalog.conflicts,
        /* 已登记的 MCP 服务状态：连不上时也要让模型看到原因（不是沉默地少列几条）。 */
        mcpServers: mcp.servers,
        hits: result.hits.map((hit) => ({
          id: hit.capability.id,
          kind: hit.capability.kind,
          title: hit.capability.title,
          description: hit.capability.description,
          location: hit.capability.source.location,
          owner: hit.capability.source.owner,
          availability: hit.capability.availability,
          effect: hit.capability.effect,
          ...(hit.capability.schemaRevision ? { schemaRevision: hit.capability.schemaRevision } : {}),
          score: hit.score,
          matched: hit.matched
        }))
      },
      summary: {
        kind: 'capabilities',
        action: 'search',
        count: result.hits.length,
        considered: result.considered,
        mcpToolCount: mcp.tools.length,
        ids: result.hits.map((hit) => hit.capability.id)
      }
    }
  }

  /** `yan skill read`：按需读技能正文（记录内容 hash，正文变了要重读）。 */
  private async runSkillRead(params: Record<string, unknown>) {
    const id = this.knowledgeString(params, ['id', 'skillId', 'skill-id'])
    if (!id) {
      throw new CapabilityCommandError('skill_id_required', 'skill read 需要 --id <技能ID>（形如 skill:<名称>）')
    }
    const commands = await this.rawCommands()
    try {
      const skill = await readSkillById(commands, id)
      return {
        data: skill,
        summary: {
          kind: 'skill',
          action: 'read',
          id: skill.id,
          name: skill.name,
          contentHash: skill.contentHash,
          bytes: Buffer.byteLength(skill.body, 'utf8')
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CapabilityCommandError('skill_unavailable', message)
    }
  }

  /* ------------------------------------------------ MCP（实施-04 S3） */

  /** 懒创建连接管理器；配置坏掉时把原因留着，调用时一并回报。 */
  private mcpConnectionManager(): McpConnectionManager {
    if (!this.mcpManager) {
      const loaded = loadMcpServers()
      this.mcpConfigError = loaded.error
      this.mcpManager = new McpConnectionManager(
        mcpServersForProject(loaded.servers, this.capabilityOpts?.projectId)
      )
    }
    return this.mcpManager
  }

  /** 安全投影给设置页：不回传命令参数、环境变量、认证引用或完整端点 URL。 */
  async capabilitySettingsSnapshot() {
    const skills = skillsFromCommands(await this.rawCommands()).map(({ capability }) => ({
      id: capability.id,
      title: capability.title,
      description: capability.description
    }))
    const manager = this.mcpConnectionManager()
    const servers = manager.list().map((server) => {
      let endpointOrigin: string | undefined
      if (server.transport === 'http' && server.url) {
        try {
          endpointOrigin = new URL(server.url).origin
        } catch {
          /* 配置校验已报错；UI 不需要拿到可能含凭证的原始字符串。 */
        }
      }
      return {
        id: server.id,
        title: server.title ?? server.id,
        transport: server.transport,
        enabled: server.enabled !== false,
        effect: server.effect ?? 'unknown',
        projectScoped: Boolean(server.projectScope),
        ...(endpointOrigin && endpointOrigin !== 'null' ? { endpointOrigin } : {}),
        status: manager.statusOf(server.id).status,
        toolCount: manager.toolCountOf(server.id)
      }
    })
    return { skills, servers, configWarning: Boolean(this.mcpConfigError) }
  }

  /** 只在用户明确点击「检查」时连接并刷新 MCP 工具表。 */
  async verifyCapabilityMcp(serverId: string) {
    const manager = this.mcpConnectionManager()
    if (!manager.listServerIds().includes(serverId)) throw new Error('当前 runner 没有这个 MCP 服务')
    const tools = await manager.listToolsCached(serverId, { refresh: true })
    return { status: manager.statusOf(serverId).status, toolCount: tools.length }
  }

  /** 只断开该 runner 的一个已登记服务；可用于中止握手或工具表刷新。 */
  async disconnectCapabilityMcp(serverId: string): Promise<boolean> {
    return this.mcpConnectionManager().disconnect(serverId)
  }

  /** 设置页的手动目录搜索；继续复用模型 CLI 的脱敏、限额与候选缓存规则。 */
  async discoverCapabilitiesForSettings(queryText: string) {
    const result = await this.runCapabilitiesDiscover({ queryText })
    const data = result.data as {
      query: string
      reason: string | null
      sources: Array<{ sourceId: string; ok: boolean; pages: number; candidateCount: number }>
      candidates: Array<{
        candidateId: string
        kind: 'skill' | 'mcp-server'
        title: string
        summary: string
        publisher?: string
        version?: string
        requirements: string[]
        verification: 'metadata-only' | 'source-checked' | 'smoke-passed'
        installKind: 'skill-files' | 'pi-package' | 'mcp-package' | 'remote'
        score: number
        scoreReasons: string[]
      }>
    }
    const sourceIds = new Set(['npm-registry', 'mcp-registry', 'skill-directory'])
    return {
      query: data.query,
      reason: data.reason
        ? (data.sources.length > 0 && data.sources.every((source) => !source.ok) ? 'unavailable' : 'no-candidates')
        : null,
      sources: data.sources
        .filter((source) => sourceIds.has(source.sourceId))
        .map(({ sourceId, ok, pages, candidateCount }) => ({ sourceId, ok, pages, candidateCount })),
      candidates: data.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        ...(candidate.publisher ? { publisher: candidate.publisher } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
        requirements: candidate.requirements,
        verification: candidate.verification,
        installKind: candidate.installKind,
        score: candidate.score,
        scoreReasons: candidate.scoreReasons
      }))
    }
  }

  /**
   * `yan mcp describe` / `yan mcp call`。
   *
   * 配置只在宿主文件里（`YAN_DIR/mcp-servers.json`）—— 模型只能**用**已登记的服务，
   * 不能新增一个（新增等于给模型一个任意命令执行入口）。
   */
  private async runMcpCommand(action: string, params: Record<string, unknown>) {
    if (action !== 'describe' && action !== 'call') {
      throw new CapabilityCommandError('not_implemented', `命令已接通但尚未实现：mcp.${action}`)
    }
    const serverId = this.knowledgeString(params, ['serverId', 'server', 'server-id'])
    const toolName = this.knowledgeString(params, ['toolName', 'tool', 'name', 'tool-name'])
    if (!serverId) {
      throw new CapabilityCommandError(
        'mcp_server_required',
        this.mcpConfigError
          ? `需要 --server <服务ID>；另外 MCP 配置有问题：${this.mcpConfigError}`
          : '需要 --server <服务ID>（服务在 YAN_DIR/mcp-servers.json 里登记）'
      )
    }
    if (!toolName) {
      throw new CapabilityCommandError('mcp_tool_required', '需要 --tool <工具名>（先用 yan mcp describe 拿 schema）')
    }

    const manager = this.mcpConnectionManager()
    if (action === 'call' && (await this.capabilityOpts?.getWorkMode?.()) === 'clarify') {
      const server = manager.list().find((entry) => entry.id === serverId)
      if (server?.effect !== 'read') {
        throw new CapabilityCommandError(
          'capability_mode_clarify',
          '计划模式只允许调用配置明确标记为 read 的 MCP 工具；当前服务的副作用未被确认为只读。'
        )
      }
    }
    try {
      if (action === 'describe') {
        const described = await describeMcpTool(manager, serverId, toolName)
        return {
          data: described,
          summary: {
            kind: 'mcp',
            action: 'describe',
            serverId,
            toolName,
            schemaRevision: described.schemaRevision,
            /* 如实透传服务自报值，并明确标注它**不是**权限。 */
            selfReportedReadOnly: described.selfReportedReadOnly,
            ...(this.mcpConfigError ? { configWarning: this.mcpConfigError } : {})
          }
        }
      }

      const rawArgs = params.arguments ?? params.args
      const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
      const expectedRevision = this.knowledgeString(params, [
        'schemaRevision',
        'schema-revision',
        'expectedRevision',
        'expected-revision'
      ])
      const outcome = await callMcpTool(manager, serverId, toolName, args, {
        resultsDir: join(YAN_DIR, 'mcp-results'),
        ...(expectedRevision ? { expectedRevision } : {})
      })
      return {
        data: outcome,
        summary: {
          kind: 'mcp',
          action: 'call',
          serverId,
          toolName,
          /* 工具级失败是**结果**，不是崩溃 —— 两个字段让模型能分开处理。 */
          toolError: outcome.toolError,
          bytes: outcome.bytes,
          ...(outcome.resultFile ? { resultFile: outcome.resultFile } : {}),
          ...(this.mcpConfigError ? { configWarning: this.mcpConfigError } : {})
        }
      }
    } catch (error) {
      if (error instanceof McpToolError) {
        throw new CapabilityCommandError(error.code, error.message, error.data)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new CapabilityCommandError('mcp_unavailable', `MCP 调用失败：${message}`)
    }
  }

  /* ------------------------------------------------ 项目知识命令（实施-03 S4） */

  /** 取一个字符串参数（CLI 的连字符写法与请求文件里的 camelCase 都认）。 */
  private knowledgeString(params: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = params[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }

  private knowledgeNumber(params: Record<string, unknown>, key: string): number | undefined {
    const value = params[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
    return undefined
  }

  /**
   * `yan knowledge <动作>` 的实现点（实施-03 §6）。
   *
   * 三条硬规则（实施-03 §3/§6）：
   *   ① **身份不由请求给**：一律用宿主绑定的 `capabilityOpts.projectId`；
   *      请求里带 `projectId` 时只有两种结果 —— 与宿主一致（忽略）或不一致（拒），
   *      后者把「越权尝试」变成可观测的错误，而不是静默当成没传；
   *   ② `propose` **不传 hostCheck** —— 模型自报 `user-confirmed` / `verified` 会被
   *      存储层拒掉（新条目只会落 `candidate`，等用户确认才进注入）；
   *   ③ 证据里的文件引用只接受**项目内相对路径**（绝对路径与 `..` 被拒）——
   *      「文本引用不授予读取权限」是 §4 写死的边界。
   */
  private async runKnowledgeCommand(action: string, params: Record<string, unknown>) {
    const projectId = this.capabilityOpts?.projectId
    if (!projectId) {
      throw new CapabilityCommandError('knowledge_no_project', '当前会话没有绑定项目身份，项目知识不可用')
    }
    const claimed = typeof params.projectId === 'string' ? params.projectId.trim() : ''
    if (claimed && claimed !== projectId) {
      throw new CapabilityCommandError(
        'knowledge_project_mismatch',
        '项目知识只认宿主绑定的身份，不接受请求里的 projectId'
      )
    }
    const identity = { projectId, cwd: this.cwd }

    if (action === 'search') {
      const queryText = this.knowledgeString(params, ['queryText', 'query-text', 'query', 'text'])
      if (!queryText) {
        throw new CapabilityCommandError('knowledge_query_required', 'knowledge search 需要 queryText（或 --query-file）')
      }
      const entries = await listKnowledge(identity)
      const result = searchProjectKnowledge(entries, {
        queryText,
        limit: this.knowledgeNumber(params, 'limit'),
        tokenBudget: this.knowledgeNumber(params, 'tokenBudget')
      })
      return {
        data: { hits: result.hits, considered: result.considered, dropped: result.dropped, tokens: result.tokens, reason: result.reason ?? null },
        summary: {
          kind: 'knowledge',
          action: 'search',
          projectId,
          count: result.hits.length,
          tokens: result.tokens,
          ids: result.hits.map((hit) => hit.id)
        }
      }
    }

    if (action === 'read') {
      const id = this.knowledgeString(params, ['id'])
      if (!id || !isSafeKnowledgeId(id)) {
        throw new CapabilityCommandError('knowledge_id_required', 'knowledge read 需要合法的 id')
      }
      const entry = await readKnowledge(identity, id)
      if (!entry) {
        throw new CapabilityCommandError('knowledge_not_found', `找不到这条项目知识：${id}`)
      }
      return {
        data: entry,
        summary: {
          kind: 'knowledge',
          action: 'read',
          projectId,
          id: entry.id,
          status: entry.status,
          revision: entry.revision
        }
      }
    }

    if (action === 'propose') {
      const raw = params.draft && typeof params.draft === 'object' ? (params.draft as Record<string, unknown>) : params
      const kind = this.knowledgeString(raw, ['kind'])
      const text = this.knowledgeString(raw, ['text'])
      if (!kind || !text) {
        throw new CapabilityCommandError('knowledge_draft_invalid', 'knowledge propose 需要 kind 与 text')
      }
      const evidence = Array.isArray(raw.evidence) ? raw.evidence : []
      for (const item of evidence) {
        const file = (item as { file?: unknown })?.file
        if (file !== undefined && !isSafeRelativeRef(file)) {
          throw new CapabilityCommandError(
            'knowledge_evidence_out_of_scope',
            '证据里的 file 只能是项目内相对路径（不接受绝对路径 / .. / 空值）'
          )
        }
      }
      const sessionId = typeof raw.sessionId === 'string' && isSafeSessionId(raw.sessionId) ? raw.sessionId : this.capabilityOpts?.sessionId
      const outcome = await commitKnowledge({
        identity,
        request: {
          id: raw.id,
          kind,
          text,
          tags: raw.tags,
          evidence: evidence.length > 0 ? evidence : sessionId ? [{ sessionId }] : [],
          confidenceClass: raw.confidenceClass,
          validFor: raw.validFor,
          supersedes: raw.supersedes,
          expectedRevision: raw.expectedRevision ?? 0
        }
        /* 刻意不传 hostCheck：模型不能自证「用户确认」与「证据已核实」 */
      })
      if (!outcome.ok) {
        throw new CapabilityCommandError(`knowledge_${outcome.code}`, outcome.message)
      }
      return {
        data: outcome.entry,
        summary: {
          kind: 'knowledge',
          action: 'propose',
          projectId,
          id: outcome.entry.id,
          status: outcome.entry.status,
          revision: outcome.entry.revision
        }
      }
    }

    throw new CapabilityCommandError('unknown_command', `未知的 knowledge 动作：${action}`)
  }

  /* ------------------------------------------------ 浏览器命令（01-S4b） */

  /**
   * `yan browser <动作>` 的实现点。
   *
   * ── 为什么直接调宿主服务，而不是复用旧的 loopback bridge ──
   *   浏览器控制器归宿主独占（01-S5d 已删掉只服务于旧 `browser.js` 扩展的
   *   HTTP bridge）。再绕一层网络调用只会多一个失败点与一次序列化，
   *   安全上不多一分。
   *
   * ── 失败分两类（见 capability-server.ts 的注释）──
   *   · 「浏览器没开 / 地址不是 http(s) / 正在由用户接管」= **业务失败**，
   *     模型能改参数重试 → `CapabilityCommandError`（带 code，可分支）；
   *   · 协议版本 / token / 身份不匹配 = **端点级错误**，在进到这里之前就被
   *     能力服务拦掉了，不会落到本方法里。
   *
   * ── 结果形状 ──
   *   大对象（观察 / 状态 / 截图路径）走 `data` → 由能力服务落文件；
   *   `summary` 只放能一眼读完的几个字段（它才是进模型上下文的那段）。
   */
  private async runBrowserCommand(
    action: string,
    params: Record<string, unknown>
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const host = this.browserHost()
    switch (action) {
      /* 打开 / 导航：`open` 是历史别名（旧 browser_open 与 browser_navigate 等价） */
      case 'navigate':
      case 'open': {
        const url = this.browserText(params, 'url')
        if (!url) {
          throw new CapabilityCommandError(
            'missing_url',
            `${action} 需要一个 http(s) 地址（about:blank 也可以）：yan browser ${action} --url <地址>`
          )
        }
        const res = await host.navigate(url)
        if (!res.ok) this.browserFailure(action, res)
        const state = host.getState()
        return { data: state, summary: this.browserSummary(action, state) }
      }

      /* 当前状态：标签 id 的唯一来源（旧工具链里 switch_tab 要的 id 无处可得） */
      case 'state': {
        const state = host.getState()
        return {
          data: state,
          summary: this.browserSummary(action, state, {
            tabs: (state.tabs ?? []).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
          })
        }
      }

      /* 观察当前页面：URL / 标题 / 可交互元素 ref / 可见文本 */
      case 'observe': {
        const observation = await this.browserObserve(action)
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
      }

      /* 会带回新观察的四个动作 */
      case 'click':
      case 'type':
      case 'press':
      case 'scroll': {
        const res = await this.browserActionCommand(host, action, params)
        if (!res.ok) this.browserFailure(action, res)
        const observation = res.observation ?? (await this.browserObserve(action))
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
      }

      case 'back':
      case 'forward':
      case 'reload': {
        const res = await (action === 'back'
          ? host.back()
          : action === 'forward'
            ? host.forward()
            : host.reload())
        if (!res.ok) this.browserFailure(action, res)
        const state = host.getState()
        return { data: state, summary: this.browserSummary(action, state) }
      }

      case 'new-tab':
      case 'switch-tab':
      case 'close-tab': {
        const id = this.browserText(params, 'id')
        if (action === 'switch-tab' && !id) {
          throw new CapabilityCommandError(
            'missing_tab_id',
            'switch-tab 需要标签 id：yan browser switch-tab --id <标签id>（id 从 yan browser state 里取）'
          )
        }
        const state =
          action === 'new-tab'
            ? await host.newTab(this.browserText(params, 'url'))
            : action === 'switch-tab'
              ? await host.switchTab(id as string)
              : await host.closeTab(id)
        return { data: state, summary: this.browserSummary(action, state) }
      }

      /*
       * 截图：PNG **落盘**，摘要里只给路径与字节数。
       *
       * 为什么不把 base64 塞进结果文件：一张 1080p 截图的 base64 是几 MB，
       * 写进 JSON 后模型还得把整个 JSON 读一遍才能拿到它；落成 .png 后
       * pi 的原生 read 能直接看图，路径也不占上下文。
       */
      case 'screenshot': {
        const shot = await this.browserScreenshot()
        return {
          data: { mimeType: shot.mimeType, path: shot.path, bytes: shot.bytes },
          summary: {
            kind: 'browser',
            action,
            ok: true,
            mimeType: shot.mimeType,
            savedTo: shot.path,
            bytes: shot.bytes
          }
        }
      }

      /* 最近一次完成的下载（旧 browser_download 的等价物，数据来自宿主 state） */
      case 'download': {
        const state = host.getState()
        const download = state.lastDownload ?? null
        return {
          data: { download },
          summary: {
            kind: 'browser',
            action,
            ok: true,
            has: Boolean(download),
            ...(download ? { filename: download.filename, path: download.path } : {})
          }
        }
      }

      /* 把页面交给用户：后续 click / type / press / scroll 一律被拒 */
      case 'request-user-control': {
        const state = host.requestUserControl()
        const reason = this.browserText(params, 'reason')
        return {
          data: state,
          summary: this.browserSummary(action, state, {
            userControl: state.userControl === true,
            ...(reason ? { reason } : {})
          })
        }
      }

      /* 接入 / 断开本机已安装的 Chrome（需要登录态的站点） */
      case 'connect-chrome':
      case 'disconnect-chrome': {
        if (action === 'connect-chrome') {
          const res = await host.openExternalChrome(this.browserText(params, 'url'))
          if (!res.ok) this.browserFailure(action, res)
        } else {
          await host.closeExternalChrome()
        }
        const state = host.getState()
        return {
          data: state,
          summary: this.browserSummary(action, state, { mode: state.mode ?? 'embedded' })
        }
      }

      /*
       * 兜底：命令名已过 KNOWN_COMMANDS，能到这里只可能是「登记了但没实现」。
       * 不静默成功（01-S2 的约定）。
       *
       * 注：bridge 的 `/evaluate`（任意页面 JavaScript）**有意不登记**，
       * 它返回 403；这里也不给出口。
       */
      default:
        throw new CapabilityCommandError(
          'browser_action_not_implemented',
          `浏览器动作已登记但尚未实现：${action}`
        )
    }
  }

  /** 取浏览器宿主服务；没注入（或宿主还没起来）时给可读的失败。 */
  private browserHost(): BrowserCommandHost {
    const host = this.getBrowserHost?.() ?? null
    if (!host) {
      throw new CapabilityCommandError(
        'browser_unavailable',
        '内置浏览器服务不可用（宿主还在启动或未初始化）；请稍后在会话里重试'
      )
    }
    return host
  }

  /**
   * 参数取值。
   *
   * `yan` 走 flag 时所有值都是**字符串**（`--delta-y 300`），走
   * `--request-file` 时才是 JSON 原生类型 —— 两种都接受，不猜默认值。
   * 空串按「没给」处理，避免 `--ref ''` 变成一次无意义调用。
   */
  private browserText(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key]
    if (typeof value === 'string') return value.trim() ? value.trim() : undefined
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return undefined
  }

  /** 数值参数（`--delta-y` / `--delta-x`）：认不出数字就报可读错误，不传 NaN 给 CDP。 */
  private browserNumber(params: Record<string, unknown>, key: string): number | undefined {
    const raw = params[key]
    if (raw === undefined || raw === '' || raw === true) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      throw new CapabilityCommandError(
        'invalid_number',
        `${key} 需要数字，收到的是 ${JSON.stringify(raw)}`
      )
    }
    return value
  }

  /** click / type / press / scroll 的参数读取与调用（四个动作的参数面各不相同）。 */
  private async browserActionCommand(
    host: BrowserCommandHost,
    action: 'click' | 'type' | 'press' | 'scroll',
    params: Record<string, unknown>
  ): Promise<BrowserObservationResult> {
    if (action === 'scroll') {
      const deltaY = this.browserNumber(params, 'deltaY') ?? this.browserNumber(params, 'delta-y')
      if (deltaY === undefined) {
        throw new CapabilityCommandError(
          'missing_delta',
          'scroll 需要滚动像素：yan browser scroll --delta-y <像素> [--delta-x <像素>]'
        )
      }
      const deltaX = this.browserNumber(params, 'deltaX') ?? this.browserNumber(params, 'delta-x') ?? 0
      return host.scroll(deltaX, deltaY)
    }

    if (action === 'press') {
      const key = this.browserText(params, 'key')
      if (!key) {
        throw new CapabilityCommandError('missing_key', 'press 需要按键名：yan browser press --key Enter')
      }
      return host.press(key)
    }

    const ref = this.browserText(params, 'ref')
    if (!ref) {
      throw new CapabilityCommandError(
        'missing_ref',
        `${action} 需要元素 ref：yan browser ${action} --ref <ref>（ref 来自 yan browser observe）`
      )
    }
    if (action === 'click') return host.click(ref)

    const text = typeof params.text === 'string' ? params.text : undefined
    if (text === undefined) {
      throw new CapabilityCommandError(
        'missing_text',
        'type 需要文本：yan browser type --ref <ref> --text <文本>'
      )
    }
    return host.type(ref, text)
  }

  /** observe：把「还没打开」单独归一个 code，其余如实带原话。 */
  private async browserObserve(action: string): Promise<BrowserObservation> {
    try {
      return await this.browserHost().observe()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('浏览器尚未打开')) {
        throw new CapabilityCommandError(
          'browser_not_open',
          '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面'
        )
      }
      throw new CapabilityCommandError('browser_observe_failed', `${action} 失败：${this.cliHint(message)}`)
    }
  }

  /** 截图落盘（宿主能力服务的结果目录），只回路径与字节数。 */
  private async browserScreenshot(): Promise<{ mimeType: string; path: string; bytes: number }> {
    let shot: { mimeType: string; data: Buffer }
    try {
      shot = await this.browserHost().screenshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('浏览器尚未打开')) {
        throw new CapabilityCommandError(
          'browser_not_open',
          '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面'
        )
      }
      throw new CapabilityCommandError('browser_screenshot_failed', `截图失败：${message}`)
    }
    const dir = this.capabilityOpts?.opsDir ?? join(YAN_DIR, 'ops')
    const path = join(dir, `screenshot-${randomUUID()}.png`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, shot.data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new CapabilityCommandError('browser_screenshot_failed', `截图写盘失败：${message}`)
    }
    return { mimeType: shot.mimeType, path, bytes: shot.data.byteLength }
  }

  /**
   * 兜底：把文案里残留的旧工具名换成现在真的能用的 CLI 写法。
   *
   * 浏览器服务内部文案已在 01-S5d 收尾时统一成 `yan browser …` 写法
   * （见 `browser.ts` / `browser/ElementRegistry.ts`）；这里保留一道改写，
   * 防止以后新增的错误提示又写出 `browser_observe` 这种不存在的工具名。
   */
  private cliHint(message: string): string {
    return message.replace(/\bbrowser_([a-z_]+)\b/g, (_all, action: string) => {
      return `yan browser ${action.replace(/_/g, '-')}`
    })
  }

  /**
   * 动作失败 → 业务错误。
   *
   * 「浏览器尚未打开」单独归 `browser_not_open`：它是最常见的一种，模型
   * 看到这个 code 就知道该先 navigate，而不用去读中文。其余错误沿用宿主给的
   * `code`（如权限策略的 `USER_CONTROL_ACTIVE`），没有就用 `browser_<动作>_failed`。
   */
  private browserFailure(action: string, res: { error?: string; code?: string }): never {
    const message = this.cliHint(res.error ?? '浏览器操作失败')
    const code =
      res.code ?? (message.includes('浏览器尚未打开') ? 'browser_not_open' : `browser_${action.replace(/-/g, '_')}_failed`)
    throw new CapabilityCommandError(code, message)
  }

  /** 动作后的状态摘要（进上下文的那一小段）。 */
  private browserSummary(
    action: string,
    state: BrowserState,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      kind: 'browser',
      action,
      ok: true,
      open: state.open,
      url: state.url,
      title: state.title,
      mode: state.mode ?? 'embedded',
      tabs: (state.tabs ?? []).length,
      ...(state.userControl ? { userControl: true } : {}),
      ...extra
    }
  }

  /** 观察摘要：元素/文本的**全文**在结果文件里，这里只给规模与定位。 */
  private browserObservationSummary(
    action: string,
    observation: BrowserObservation
  ): Record<string, unknown> {
    return {
      kind: 'browser',
      action,
      ok: true,
      url: observation.url,
      title: observation.title,
      generationId: observation.generationId,
      elements: observation.elements.length,
      accessibilityNodes: observation.accessibilityNodeCount,
      textChars: observation.text.length
    }
  }

  /**
   * 当前会话「第几轮用户消息」（从 1 开始）。
   *
   * 与界面历史分组（[todoSnapshotsFromEntries]）同一口径：数会话文件里的 user 消息。
   * 任务日志把轮次**记在行里**（不靠条目位置反推），历史快照才能按轮归并、
   * 「跳回当时那轮对话」才指得准。
   */
  private async currentUserRound(): Promise<number> {
    try {
      const res = await this.rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
      if (!res?.success) return 1
      let userMsgs = 0
      for (const e of res.data?.entries ?? []) {
        if (e.type !== 'message') continue
        const m = e.message as { role?: unknown } | undefined
        if (m?.role === 'user') userMsgs++
      }
      return Math.max(1, userMsgs)
    } catch {
      return 1
    }
  }

  /**
   * `yan tasks apply`：一次任务清单写入。
   *
   * ── 身份与幂等 ──
   * 会话身份由宿主自己取（`this.state.sessionId`，**不由模型自报**）；
   * `operationId` 默认由宿主生成。调用方（模型）显式传了一个时以它为准 ——
   * 那是「重试同一次提交」的唯一表达方式（把上一次回执里的 id 放回请求文件），
   * 落盘层的幂等靠它，**不用**它做身份判定（身份永远来自端点绑定）。
   *
   * ── 为什么失败要带上「当前清单」──
   * `index` 越界这类错误只有配上当前清单，模型才能自己改正并重试；
   * 只给它一句中文，它只能猜。
   */
  private async applyTaskPlan(
    params: Record<string, unknown>
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const sessionId = this.state?.sessionId
    if (!sessionId || !isSafeSessionId(sessionId)) {
      throw new CapabilityCommandError(
        'session_not_ready',
        '当前还没有可写入的会话（任务清单按会话归属，请等会话就绪后再试）'
      )
    }

    const rawOperationId = typeof params.operationId === 'string' ? params.operationId.trim() : ''
    const request: TaskPlanRequest = {
      action: params.action as TaskAction,
      items: params.items,
      index: params.index,
      operationId: rawOperationId || randomUUID()
    }

    const round = await this.currentUserRound()
    const outcome = await applyTaskPlanOperation({ sessionId, round, request }).catch(
      (err: unknown): never => {
        /* 存储层错误（写不进去 / 读不了）原样带码返回，不包装成「参数错」 */
        if (err instanceof TaskPlanStoreError) {
          throw new CapabilityCommandError(err.code, err.message)
        }
        throw err
      }
    )

    if (!outcome.ok) {
      /* 参数不合法：附件是「当前清单」，让模型能自己修正后重试 */
      const current = await currentTaskPlan(sessionId).catch(() => null)
      throw new CapabilityCommandError(outcome.code, outcome.message, {
        revision: current?.state.revision ?? 0,
        todos: current?.state.todos ?? []
      })
    }

    /* 推送与持久层同源：写成功之后重新读一次（而不是在内存里拼一份） */
    await this.refreshTodos()
    const state = outcome.state
    return {
      data: {
        ok: true,
        action: request.action,
        operationId: state.operationId,
        revision: state.revision,
        replayed: outcome.replayed,
        changed: outcome.changed,
        todos: state.todos
      },
      summary: {
        kind: 'task-plan',
        action: request.action,
        revision: state.revision,
        /* 重放要让模型看得见：它重试了一次，而状态**没有**再变 */
        replayed: outcome.replayed,
        items: state.todos.length,
        done: state.todos.filter((t) => t.done).length,
        changed: outcome.changed.length
      }
    }
  }

  /**
   * 当前有效的上下文策略与工作集预算（N21-3，**唯一来源**）。
   *
   * 为什么把「界面用的数」与「做决定用的数」算在一处：它们必须是同一个数。
   * 这一块已经出过两次「界面数字 ≠ 实际生效值」的错（D21 项目级设置被忽略、
   * D22 用户级设置读错文件），不能再让渲染端自己再算一遍。
   *
   * 总开关就是那个已有的「自动压缩」开关（pi 的 `compaction.enabled`）：
   * 它关掉时砚也不自作主张地压 —— 用户关的就是“别自动动我的上下文”。
   * 注意 pi 自己那条自动压缩线仍然在（砚不写 pi 的设置文件），
   * 所以这个开关的语义仍然是“pi 要不要自动压缩”，只是多了一个更早的砚决策点。
   */
  private effectivePolicy(): {
    resolved: ResolvedContextPolicy
    policy: ContextPolicy
    budget: ContextBudget | null
  } {
    /*
     * 模型级覆盖按**当前会话模型**查表（N21-7）：同一台机器上切到不同模型
     * 会得到不同工作集，而 `source` 让界面能说出“这个数是模型级定的”。
     */
    const resolved = activeContextPolicy(process.env, modelKeyOf(this.state?.model))
    const policy: ContextPolicy =
      resolved.policy.enabled && this.state?.autoCompactionEnabled !== false
        ? resolved.policy
        : { ...resolved.policy, enabled: false }
    return { resolved, policy, budget: contextBudget(this.state?.model?.contextWindow ?? 0, policy) }
  }

  /** 推给界面的策略视图（窗口未知或策略关时为 undefined —— 界面退回物理窗口视角） */
  private contextPolicyView(): ContextPolicyView | undefined {
    const { resolved, policy, budget } = this.effectivePolicy()
    if (!policy.enabled || !budget) return undefined
    /*
     * 精确模型层的原文（C-5 尾）：右栏据此说「现在用的是均衡 600K 档」。
     * 只看 `source === 'model'` 不够 —— 模型级也可能是用户手填的自定义数。
     */
    const modelKey = modelKeyOf(this.state?.model)
    const modelOverrides = modelKey ? contextPolicySettings().byModel?.[modelKey] : undefined
    return {
      enabled: true,
      kinds: policy.kinds,
      budget,
      source: resolved.source,
      ...(resolved.sourceKey ? { sourceKey: resolved.sourceKey } : {}),
      overridden: resolved.overridden,
      ...(modelOverrides ? { modelOverrides } : {})
    }
  }

  /**
   * 设置改动后重推一帧上下文策略（N21-7）。
   *
   * 设置面板改完阈值后，界面上的工作集与“下一步”必须当场跟上 ——
   * 否则用户会看到自己刚改的数没生效，以为是写了没存（D21/D22 同类）。
   * 只重算这一帧，不读盘、不发 RPC。
   */
  refreshPolicyView(): void {
    if (!this.state) return
    const view = this.contextPolicyView()
    const next: SessionState = { ...this.state }
    if (view) next.contextPolicy = view
    else delete next.contextPolicy
    this.state = next
    this.push({ ch: 'state', payload: next })
  }

  private setStateFrom(data: Record<string, unknown>): void {
    const model = normalizeModelInfo(data.model)
    /*
     * 压缩记录的自愈（见 clearStaleRunning）：pi 说「没在压缩」时，
     * 残留的 running 记录必须清掉 —— 否则 `compaction_end` 一旦没到，
     * 界面就永久显示“正在压缩”（与 D19 同一类 bug）。
     * 注意在构造 this.state **之前**做，否则这一帧推出去的还是旧记录。
     */
    this.compactionState = clearStaleRunning(this.compactionState, !!data.isCompacting)
    /*
     * 档位不能只看本条快照：pi 的 get_state 不含 availableThinkingLevels，
     * 权威结果由 listThinkingLevels() 写入（详见 resolveThinkingLevels 注释）。
     */
    const previous = this.state
    const levels = resolveThinkingLevels(
      data,
      previous
        ? {
            levels: previous.availableThinkingLevels,
            status: previous.thinkingLevelsStatus ?? 'unknown',
            modelKey: modelKeyOf(previous.model)
          }
        : undefined,
      modelKeyOf(model)
    )
    const availableThinkingLevels = levels.values
    this.state = {
      sessionId: String(data.sessionId ?? ''),
      sessionFile: data.sessionFile ? String(data.sessionFile) : undefined,
      sessionName: data.sessionName ? String(data.sessionName) : undefined,
      model: model ?? undefined,
      thinkingLevel: String(data.thinkingLevel ?? 'off'),
      availableThinkingLevels,
      thinkingLevelsStatus: levels.status,
      capabilities: capabilitySnapshot(model, availableThinkingLevels, levels.status),
      isStreaming: !!data.isStreaming,
      /*
       * 回合级「正在干活」：从 agent_start 到 agent_settled，
       * **覆盖工具执行**。
       *
       * 为什么不能只用 isStreaming：它是「此刻有一条 assistant 消息在流」——
       * 第一段 assistant（带 toolcall）message_end 就把它清了，而工具还在跑、
       * 模型马上还要接着想/t回答。推理窗口的展开/折叠要用这个宽信号，
       * 否则「思考→执行工具」时推理会被折叠（用户报的）。
       */
      isAgentRunning: this.agentRunning,
      isCompacting: !!data.isCompacting,
      compaction: this.compactionState.running ?? undefined,
      lastCompaction: this.compactionState.last ?? undefined,
      messageCount: Number(data.messageCount ?? 0),
      pendingMessageCount: Number(data.pendingMessageCount ?? 0),
      cwd: this.cwd,
      autoCompactionEnabled:
        data.autoCompactionEnabled === undefined ? undefined : !!data.autoCompactionEnabled,
      steeringMode: normalizeQueueMode(data.steeringMode),
      followUpMode: normalizeQueueMode(data.followUpMode)
    }
    /*
     * 工作集视图要在 `this.state` 落定**之后**算：它依赖本帧刚到的
     * `autoCompactionEnabled` 与模型窗口。
     */
    const policyView = this.contextPolicyView()
    if (policyView) this.state = { ...this.state, contextPolicy: policyView }
    this.push({ ch: 'state', payload: this.state })
  }

  /**
   * 一次上下文策略判定（N21-3）。
   *
   * 触发时机只有一处：**回合结束**（`agent_settled` → `refreshStats({ allowPolicyTrigger: true })`）。
   * 两个理由：① 不在流式输出或工具执行的中途动上下文 —— 那会把正在写的回合从中间截断；
   * ② 也不能跟着“任何一次用量刷新”跑 —— 切到一个很大的旧会话也会刷新用量，
   * 那会变成“用户只是想看一眼，却被按头压了一次”（实测踩过，见 refreshStats 的注释）。
   *
   * 命中的两条线都是砚自己的：工作集上限（`compact`）与物理兜底（`emergency`，
   * 取 `min(90% 窗口, 窗口 − 输出预留)` —— 兜底不能吃掉留给回答的空间，见方案 §12.1）。
   * pi 原生那条 `窗口 − reserveTokens` 自动压缩**保持不动**，两者都失灵时由它兜底。
   */
  private async evaluateContextPolicy(tokens: number | null): Promise<void> {
    const { policy, budget } = this.effectivePolicy()
    const busy =
      !!this.state?.isStreaming || !!this.state?.isCompacting || !!this.state?.isAgentRunning
    const decided = contextPolicyStep({ state: this.policyState, tokens, budget, policy, busy })
    this.policyState = decided.state
    if (!decided.trigger || this.policyTriggering) return

    this.policyTriggering = true
    /* 基准＝调用之前已有的最后一条记录：用来认出“这次调用产生的那条” */
    this.policyOrigin = { stage: decided.trigger, baseline: this.compactionState.last?.endedAt ?? null }
    try {
      const res = await this.compact({ fromPolicy: decided.trigger })
      if (!res.ok) {
        /* 连请求都没发出去（RPC 挂了）：清掉来源标记，别把下一次压缩误标成策略发起 */
        this.policyOrigin = null
        console.error('[agent] 工作集压缩失败：', res.error)
      }
    } catch (err) {
      /*
       * 兜底：这条链是 `void` 出去的（见 refreshStats 的调用点），
       * 异常没人接就会变成主进程的 unhandledRejection —— 2026-09-22 实测到过。
       */
      this.policyOrigin = null
      console.error('[agent] 工作集压缩异常：', err instanceof Error ? err.message : err)
    } finally {
      this.policyTriggering = false
    }
  }

  /* ---------------------------------------------------------------- 事件 */

  private handleEvent(evt: Record<string, unknown>): void {
    const type = String(evt.type ?? '')

    switch (type) {
      /* ---- 助手消息：开始 ---- */
      case 'message_start': {
        const m = evt.message as PiMessage | undefined
        if (m?.role === 'user') {
          const norm = normalizeMessage(m, this.messages.length)
          if (norm) {
            this.messages.push(norm)
            this.indexCalls(norm)
            this.push({ ch: 'msg-add', payload: norm })
            /*
             * 插话真的被消费了（D9）。
             *
             * pi 只在队列**变化**时推 `queue_update`；它把排队项变成一条真正的
             * user 消息时不一定再推一次，于是界面会一直挂着「排队中」。
             * 这里以**消息真的出现**为准：按原文从快照里摘掉一条。
             */
            this.consumeQueued(norm.text)
          }
        } else if (m?.role === 'assistant') {
          const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
          this.streaming = {
            id,
            text: '',
            thinking: '',
            responseDetail: this.turnResponseDetail,
            tools: [],
            startedAt: Date.now(),
            // 增量游标从 0 开始（渲染端拿到的 msg-add 里 text 也是空）
            pushedText: 0,
            pushedThinking: 0
          }
          this.push({
            ch: 'msg-add',
            payload: { id, role: 'assistant', text: '', responseDetail: this.turnResponseDetail, timestamp: Date.now() }
          })
          this.markStreaming(true)
        }
        break
      }

      /* ---- 助手消息：流式增量 ---- */
      case 'message_update': {
        const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
        if (!ev || !this.streaming) break
        const kind = String(ev.type ?? '')

        // 顶层的 usage 是**累积值**（有的 provider 流式期间不报，保持 0）
        const u = toUsage(evt.usage as PiMessage['usage'])
        if (u) this.streaming.usage = u

        // 首个内容 delta 到达 → 记下首包时间（算速率时排除排队与首包延迟）
        if (
          !this.streaming.firstTokenAt &&
          (kind === 'text_delta' || kind === 'thinking_delta' || kind === 'toolcall_start')
        ) {
          this.streaming.firstTokenAt = Date.now()
        }

        if (kind === 'thinking_start') {
          this.streaming.thinkingStartedAt = Date.now()
          this.streaming.thinkingLive = true
        } else if (kind === 'thinking_delta') {
          this.streaming.thinking += String(ev.delta ?? '')
          this.markDirty()
        } else if (kind === 'thinking_end') {
          const started = this.streaming.thinkingStartedAt
          if (started) this.streaming.thinkingMs = Date.now() - started
          this.streaming.thinkingLive = false
          this.markDirty()
        } else if (kind === 'text_delta') {
          this.streaming.text += String(ev.delta ?? '')
          this.markDirty()
        } else if (kind === 'toolcall_start') {
          const call: UIToolCall = {
            id: String(ev.id ?? `call-${this.streaming.tools.length}`),
            name: String(ev.toolName ?? 'tool'),
            args: undefined,
            argsRaw: '',
            status: 'running',
            startedAt: Date.now()
          }
          this.streaming.tools.push(call)
          this.registerCall(call, this.streaming.id)
          this.flushNow()
          this.pushTool(call)
        } else if (kind === 'toolcall_delta') {
          const last = this.streaming.tools[this.streaming.tools.length - 1]
          if (last) {
            last.argsRaw = (last.argsRaw ?? '') + String(ev.delta ?? '')
            // 参数流完之前就顺手解析一下，让卡片早点显示命令
            try {
              last.args = JSON.parse(last.argsRaw)
            } catch {
              /* 还没流完，正常 */
            }
          }
        } else if (kind === 'toolcall_end') {
          const tc = ev.toolCall as PiContentBlock | undefined
          const last = this.streaming.tools[this.streaming.tools.length - 1]
          if (last && tc) {
            if (tc.id) last.id = tc.id
            if (tc.name) last.name = tc.name
            if (tc.arguments !== undefined) last.args = tc.arguments
          }
          this.flushNow()
          if (last) this.pushTool(last)
        }
        break
      }

      /* ---- 助手消息：结束（权威快照） ---- */
      case 'message_end': {
        const m = evt.message as PiMessage | undefined
        if (m?.role !== 'assistant' || !this.streaming) break

        const s = this.streaming
        const id = s.id
        this.streaming = null
        // 这一条消息的工具从此属于历史消息 —— 索引要落到 id 上（渲染端也会收到全量快照）
        for (const c of s.tools) this.registerCall(c, id)

        // 以 message_end 的 usage 为准（流式期间的可能是 0 或旧值）
        const finalUsage = toUsage(m.usage) ?? s.usage
        if (typeof finalUsage?.output === 'number' && finalUsage.output > 0) {
          /* 累积值：取最大，不相加（相加会把同一轮的中间快照重复计入） */
          this.turnOutputTokens = Math.max(this.turnOutputTokens ?? 0, finalUsage.output)
        }
        const sp = this.speedOf({ ...s, usage: finalUsage }, Date.now(), this.turnStartedAt)
        const msg: UIMessage = {
          id,
          role: 'assistant',
          text: s.text,
          thinking: s.thinking || undefined,
          thinkingMs: s.thinkingMs,
          // 收尾了就不再是「正在思考」（即使是中途 abort 的）
          thinkingLive: false,
          toolCalls: s.tools.length ? s.tools : undefined,
          usage: finalUsage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs,
          responseDetail: s.responseDetail,
          model: m.model,
          timestamp: m.timestamp ?? Date.now(),
          error: m.stopReason === 'error' ? '模型返回错误' : undefined
        }
        this.messages.push(msg)
        /* 这一轮归属的消息 id（H-6）：终止时写成元数据日志的 `sourceIds`。 */
        this.turnMessageIds.push(id)
        if (this.turnStartedMono !== undefined) {
          this.turnElapsedMs = Math.max(1, Math.round(performance.now() - this.turnStartedMono))
        } else if (sp.elapsedMs !== undefined) {
          this.turnElapsedMs = sp.elapsedMs
        }
        /* 推送值用单调口径覆盖：墙钟被调整时不至于让用时变负数或凭空变长。 */
        if (this.turnElapsedMs !== undefined) msg.elapsedMs = this.turnElapsedMs
        /*
         * 每条消息收尾就先落一次（final=false，只在还没写过时写）。
         * 为什么不全押在 agent_settled：失败 / 中断的回合不一定走到那里，
         * 而“用时丢了”正是 H-6 要修的原始问题；同一 logicalTurnId 重写时
         * 读回取后者，所以不会多出回合。
         */
        void this.persistTurnTiming(false)
        this.push({
          ch: 'msg-update',
          payload: { id, patch: msg }
        })
        if (m.stopReason === 'error') {
          /*
           * 模型侧错误（实施-05 S5c）：宿主据此决定要不要自动继续。
           * 这个事件不带错误文本（只有 `stopReason`），所以 `text` 允许为空 ——
           * 分类器把空文本当「未知但可重试」，并与 `auto_retry_end` 的同一错误去重。
           */
          this.push({
            ch: 'agent-error',
            payload: { message: '模型返回错误', text: '', source: 'stop-reason' }
          })
          /* 失败也是终止原因：不能落盘成「正常完成」（H-6）。 */
          this.turnTerminal = 'failed'
        }
        this.markStreaming(false)
        break
      }

      /* ---- 工具执行 ---- */
      case 'tool_execution_start': {
        const call = this.findOrCreateCall(
          String(evt.toolCallId ?? ''),
          String(evt.toolName ?? 'tool'),
          evt.args
        )
        call.status = 'running'
        call.startedAt = Date.now()
        /*
         * 写入类工具：**在文件被改之前**留一份执行前快照（方案 5.3）。
         * 同步读（限 2MB）：异步会有「工具已写完、before 才读到新内容」的竞态。
         */
        if (isWriteTool(call.name)) {
          const path = writePathOf(call.args)
          if (path) snapshotBefore(call.id, path)
        } else if (isShellTool(call.name)) {
          /*
           * shell / 第三方工具（L05）：参数里没有“要改哪个文件”，
           * 所以对整个工作目录拍一份前后快照，事后算目录级差异。
           * 同一目录并发时快照会标 concurrent —— 那种情况宁可显示“无法归属”。
           */
          beginTreeSnapshot(call.id, this.cwd, this.state?.sessionId)
        }
        this.pushTool(call)
        break
      }

      case 'tool_execution_update': {
        const call = this.findCall(String(evt.toolCallId ?? ''))
        if (!call) break
        const partial = evt.partialResult as { content?: PiContentBlock[]; details?: unknown } | undefined
        call.output = (partial?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        call.details = partial?.details
        /*
         * ⚠️ 这里**不能**直接 pushTool：这是最高频的事件（一条命令的 stdout
         *    一秒几十上百个 chunk），而每个 chunk 都带完整累积输出，
         *    推给渲染端就是 O(N²) 字节。只标脏，由共用定时器批量取增量。
         */
        this.markToolOutput(call.id)
        break
      }

      case 'tool_execution_end': {
        const call = this.findCall(String(evt.toolCallId ?? ''))
        if (!call) break
        const result = evt.result as { content?: PiContentBlock[]; details?: unknown } | undefined
        /* 被取消不算失败（方案 4.1）：单独标记，界面不染红 */
        const cancelled = (evt as { cancelled?: boolean }).cancelled === true
        call.cancelled = cancelled || undefined
        call.status = evt.isError && !cancelled ? 'error' : 'ok'
        call.output = (result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        /* 截图之类的图片结果：实时也要能看到，不只等重启读历史（与 normalize 同一套形状） */
        call.images = imagesOf(result?.content)
        call.details = result?.details
        call.endedAt = Date.now()
        /* 写入类工具：执行后快照 → 真实的行级差异与增删行数 */
        if (isWriteTool(call.name)) {
          const diff = snapshotAfter(call.id)
          if (diff) {
            const base =
              call.details && typeof call.details === 'object' && !Array.isArray(call.details)
                ? (call.details as Record<string, unknown>)
                : {}
            call.details = { ...base, fileDiff: diff }
          }
        } else if (isShellTool(call.name)) {
          /* 目录级差异只有在**真的有变化**或**归属存疑**时才挂上去：
             一条 `ls` 不该在界面上多出一张“0 个改动”的卡片。 */
          const changes = endTreeSnapshot(call.id)
          if (changes && (changes.files.length > 0 || changes.unknown)) {
            const base =
              call.details && typeof call.details === 'object' && !Array.isArray(call.details)
                ? (call.details as Record<string, unknown>)
                : {}
            call.details = { ...base, workspaceChanges: changes }
          }
        }
        this.pushTool(call)

        // panel_todos 改了会话里的 custom entry → 任务清单要重读
        if (call.name === 'panel_todos') {
          void this.refreshTodos()
        }
        break
      }

      /* ---- 会话级 ---- */
      case 'agent_start':
        this.turnResponseDetail = this.currentResponseDetail()
        this.turnStartedAt = Date.now()
        this.turnStartedMono = performance.now()
        this.turnMessageIds = []
        this.turnTerminal = 'completed'
        this.turnElapsedMs = undefined
        this.turnPersisted = false
        /* 每个 pi 回合一个 run id（H-6b）：自动继续会开新 run、归同一个逻辑回合。 */
        this.turnRunSeq += 1
        this.turnRunId = `run-${this.turnRunSeq}-${Date.now().toString(36)}`
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled':
        this.markStreaming(false)
        this.setAgentRunning(false)
        this.turnStartedAt = undefined
        this.turnStartedMono = undefined
        /* 回合结束才写元数据日志：中途写会得到一堆半截记录（H-6）。 */
        void this.persistTurnTiming()
        void this.refreshState()
        /* 回合结束是唯一允许按工作集动手的时机（这次刷新顺带做判定） */
        void this.refreshStats({ allowPolicyTrigger: true })
        // 兑底：扩展也可能通过 /panel task 命令改任务（不经过工具调用）
        void this.refreshTodos()
        // 每轮结束都重算标题（用户要求每次都是新生成的）
        void this.maybeGenerateTitle({ force: true })
        break

      case 'turn_end':
        /*
         * `turn_end` 结束的是一条 assistant 回复，不一定是整轮：工具调用的
         * 回复结束后，Pi 还会执行工具并发起下一次模型请求。只能等
         * `agent_settled` 写最终计时；否则会把中途工具消息误记成 final:true。
         */
        void this.refreshStats()
        break

      case 'agent_end':
        /*
         * 兜底写一次：失败 / 被中断的回合不一定走到 `agent_settled`。
         * Pi 可能在自动重试前先发 `agent_end`，此时 `willRetry` 为 true，
         * 不能把仍会继续的逻辑回合提前冻结成终态。
         */
        if (evt.willRetry !== true) void this.persistTurnTiming()
        void this.refreshStats()
        break

      case 'queue_update':
        this.publishQueue(
          Array.isArray(evt.steering) ? (evt.steering as string[]) : [],
          Array.isArray(evt.followUp) ? (evt.followUp as string[]) : []
        )
        break

      /* ---- 直执行 bash 的流式输出 ---- */
      case 'bash_execution_update': {
        if (!this.bash) break
        // 只接属于当前那次 bash 的 chunk
        const evtId = String(evt.id ?? '')
        if (evtId && evtId !== this.bash.reqId) break

        this.bash.output += String(evt.delta ?? '')
        /*
         * 与工具输出走**同一条增量通道**（同一套节流）。
         *
         * 以前这里每帧重发 command + toolCalls 数组（含完整累积输出），
         * 一条跑十几分钟的命令（构建/测试）会把它推成 O(N²) 字节 ——
         * 而命令文本与 bash 状态在 msg-add 时已经发过了，
         * 最终结果由 finishBash 发全量快照对齐。
         */
        const call = this.findCall(this.bash.msgId)
        if (call) call.output = this.bash.output
        this.markToolOutput(this.bash.msgId)
        break
      }

      case 'compaction_start':
        this.setCompaction(this.compactionState, evt)
        /*
         * 顺序很重要：先落状态再 refreshState。
         * 只要 pi 的 `isCompacting` 为 true，`clearStaleRunning` 就不会把
         * 刚写进去的 running 记录当成残留清掉（自愈见 setStateFrom）。
         */
        this.markStreaming(true)
        void this.refreshState()
        break

      case 'compaction_end':
        this.setCompaction(this.compactionState, evt)
        this.markStreaming(false)
        void this.refreshState()
        void this.refreshStats()
        void this.hydrate()
        break

      case 'thinking_level_changed':
        void this.refreshState()
        break

      case 'model_change':
        void this.refreshState()
        /* pi 自己换了模型（非用户点击）时档位必须重新问一次 —— get_state 里没有它。 */
        void this.listThinkingLevels()
        break

      case 'auto_retry_start':
        this.push({
          ch: 'notify',
          payload: {
            id: `retry-${Date.now()}`,
            method: 'notify',
            notifyType: 'warning',
            message: `上游出错，第 ${Number(evt.attempt ?? 1)} 次重试…`
          }
        })
        break

      case 'auto_retry_end':
        if (evt.success === false) {
          const finalError = typeof evt.finalError === 'string' ? evt.finalError : ''
          this.push({
            ch: 'notify',
            payload: {
              id: `retry-fail-${Date.now()}`,
              method: 'notify',
              notifyType: 'error',
              message: '重试失败，本轮结束。'
            }
          })
          /* pi 的重试已用尽；把错误文本交给宿主（自动继续要靠它做分类，S5c） */
          this.push({
            ch: 'agent-error',
            payload: { message: '模型返回错误', text: finalError, source: 'auto-retry' }
          })
        }
        break

      case 'extension_error':
        this.push({
          ch: 'notify',
          payload: {
            id: `ext-${Date.now()}`,
            method: 'notify',
            notifyType: 'error',
            message: `扩展出错：${String(evt.error ?? evt.message ?? '未知')}`
          }
        })
        break

      default:
        break
    }
  }

  /* ------------------------------------------------------- 消息组装辅助 */

  /**
   * 登记一个工具（连同它的宿主消息）—— callIndex / callOwner 的**唯一**写入口。
   *
   * 不登记的话 `findCall` 就找不到它 → 工具行永远停在「正在运行」。
   */
  private registerCall(call: UIToolCall, msgId?: string): void {
    this.callIndex.set(call.id, call)
    const owner = msgId ?? this.callOwner.get(call.id)
    if (owner) this.callOwner.set(call.id, owner)
  }

  /** 一条消息里的全部工具都登记（hydrate / 历史消息） */
  private indexCalls(msg: UIMessage): void {
    for (const c of msg.toolCalls ?? []) this.registerCall(c, msg.id)
  }

  private findCall(id: string): UIToolCall | undefined {
    if (!id) return undefined
    return this.callIndex.get(id)
  }

  /** 这个工具属于哪条消息 */
  private ownerOf(call: UIToolCall): string | undefined {
    return this.callOwner.get(call.id) ?? this.streaming?.id
  }

  private findOrCreateCall(id: string, name: string, args: unknown): UIToolCall {
    const existing = this.findCall(id)
    if (existing) return existing

    const call: UIToolCall = { id, name, args, status: 'running', startedAt: Date.now() }
    if (this.streaming) {
      this.streaming.tools.push(call)
      this.registerCall(call, this.streaming.id)
    } else {
      // 没有对应的助手消息（例如扩展直接调工具）—— 补一条
      const msg: UIMessage = {
        id: `t${Date.now().toString(36)}`,
        role: 'assistant',
        text: '',
        toolCalls: [call],
        timestamp: Date.now()
      }
      this.messages.push(msg)
      this.push({ ch: 'msg-add', payload: msg })
      this.registerCall(call, msg.id)
    }
    return call
  }

  /** 工具补丁：**全量**推一个工具（状态 / 参数 / 最终结果变化时用） */
  private pushTool(call: UIToolCall): void {
    const msgId = this.ownerOf(call)
    if (!msgId) return
    /* 游标必须跟上：否则下一次增量会把已经发过的内容再发一遍 */
    this.pushedOut.set(call.id, call.output?.length ?? 0)
    /* 全量已经是最新的了 —— 待推的增量作废，否则会重复追加一遍 */
    this.dirtyTools.delete(call.id)
    this.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
  }

  /**
   * 工具输出变了 —— 只标脏，由共用定时器批量取增量。
   *
   * 这是工具输出的**高频路径**（每个 chunk 一次）。
   */
  private markToolOutput(callId: string): void {
    if (!callId) return
    this.dirtyTools.add(callId)
    this.scheduleFlush()
  }

  /** 把标脏的工具输出**增量**推出去 */
  private flushTools(): void {
    if (!this.dirtyTools.size) return
    const ids = [...this.dirtyTools]
    this.dirtyTools.clear()

    for (const id of ids) {
      const call = this.callIndex.get(id)
      if (!call) {
        this.pushedOut.delete(id)
        continue
      }
      const pushed = this.pushedOut.get(id) ?? 0
      const out = call.output ?? ''
      if (out.length <= pushed) continue
      const msgId = this.ownerOf(call)
      if (!msgId) continue
      this.pushedOut.set(id, out.length)
      /*
       * ⚠️ 故意**不带全量 output**：那正是要避免的开销。
       *    渲染端按 `outputDelta` 追加（见 store 的 `'tool'` 分支）。
       *    这里把 output 显式置为 undefined，语义是「这一帧没有全量快照」；
       *    渲染端拼接时用的是**它自己的**旧 output + delta。
       */
      this.push({
        ch: 'tool',
        payload: {
          msgId,
          call: { ...call, output: undefined },
          outputDelta: out.slice(pushed)
        }
      })
    }
  }

  /** 流式文本节流：累积到下一帧再推，避免每个 delta 一次 IPC */
  private markDirty(): void {
    this.dirty = true
    this.scheduleFlush()
  }

  /**
   * 共用定时器：文本 / 工具输出 / bash 输出都走它。
   *
   * 为什么不各用一个定时器：三类更新常常同时到来（模型一边说话一边跑工具），
   * 分开就会在同一帧里推三次 IPC、触发三次 React 更新（另两次是白干）。
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
      this.flushTools()
    }, this.flushDelay())
  }

  /**
   * 节流间隔：随着累积文本/输出变长而拉大（上限 MAX_FLUSH_MS）。
   *
   * 理由见 MAX_FLUSH_MS：一帧的成本与已累积的文本量成正比，
   * 长回答/长输出时降频比卡顿好。
   */
  private flushDelay(): number {
    const len = (this.streaming?.text.length ?? 0) + (this.bash?.output.length ?? 0)
    return Math.min(MAX_FLUSH_MS, Math.max(FLUSH_MS, Math.round(len / 2000)))
  }

  /**
   * 把流式文本推给渲染端 —— **只发增量**（textDelta / thinkingDelta）。
   *
   * 全量版本的推送仍然存在（`message_end` / 中止 / sync），那是权威对齐。
   * 这里只负责「又长了几个字」。
   */
  private flushNow(): void {
    if (!this.dirty || !this.streaming) return
    this.dirty = false
    const s = this.streaming

    const textDelta = s.text.length > s.pushedText ? s.text.slice(s.pushedText) : ''
    const thinkingDelta =
      s.thinking.length > s.pushedThinking ? s.thinking.slice(s.pushedThinking) : ''
    s.pushedText = s.text.length
    s.pushedThinking = s.thinking.length

    const sp = this.speedOf(s, Date.now(), this.turnStartedAt)
    this.push({
      ch: 'msg-update',
      payload: {
        id: s.id,
        patch: {
          ...(textDelta ? { textDelta } : null),
          ...(thinkingDelta ? { thinkingDelta } : null),
          thinkingMs: s.thinkingMs,
          thinkingLive: s.thinkingLive,
          /*
           * ⚠️ 工具数组**不在这里重发**：它有自己的增量通道（`ch:'tool'`）。
           *    以前每帧都带着全部工具的完整 output，工具多/输出长的回合里
           *    每帧就是几百 KB 的结构化克隆。
           */
          usage: s.usage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs
        }
      }
    })
  }

  /**
   * 算输出速率（token/秒）与整轮用时。
   *
   * 口径本身在 `shared/turn-timing.ts`（纯函数、有单测）：速度用
   * 「首个内容 token 到达」，整轮用时用 agent 回合起点，所以工具往返与重试
   * 只进后者。这里只是把流式对象里的字段喂进去，不重复实现算法。
   */
  /**
   * 把这一轮的整轮用时写进元数据日志（H-6）。
   *
   * 三个前提缺一不写：有会话身份、有用时、有归属消息 —— 否则读回来也不知道
   * 该挂给谁（挂不上的记录比没有记录更坏）。写失败只吞掉，不打断会话。
   *
   * `logicalTurnId` 取本轮第一条 assistant 消息 id：同一回合重写时 id 不变，
   * 读回时后者胜，所以不会因为重试 / 多写一次就多出一个回合。
   */
  private async persistTurnTiming(final = true): Promise<void> {
    /*
     * 分桶 key 用会话**文件名**，不用 `this.state.sessionId` —— pi 的 get_state
     * 在部分版本里不给 sessionId，用它会让记录静默写不出来（实测踩过）。
     */
    const bucket = timingKey(this.state?.sessionFile)
    const elapsedMs = this.turnElapsedMs
    const sourceIds = [...this.turnMessageIds]
    const terminalReason = this.turnTerminal
    if (final) {
      this.turnMessageIds = []
      this.turnElapsedMs = undefined
      this.turnOutputTokens = undefined
      this.turnTerminal = 'completed'
    }
    if (!bucket || elapsedMs === undefined || sourceIds.length === 0) return
    if (!final && this.turnPersisted) return
    /*
     * 锚定用户消息：两侧的用户消息 id 都是 `normalizeMessage` 生成的 `m<idx>`。
     * 临时 assistant id 在重读历史时对不上，不能拿它当锤。
     */
    const anchorId = [...this.messages]
      .reverse()
      .find((m) => m.role === 'user' && /^m\d+$/.test(m.id))?.id
    /*
     * 逻辑回合身份（H-6b）：优先用**用户消息 id**。
     * 同一次请求触发的自动继续会开新的 pi agent 回合（新 runId），
     * 但用户消息没变 —— 用 anchorId 才能把它们归成同一个逻辑回合，
     * 而不是每次 agent_end 就冻结出一个新回合。分叉 / 压缩换过历史
     * 导致锚对不上时，回退到首条 assistant id（旧行为，仍然自洽）。
     */
    const logicalTurnId = anchorId ?? sourceIds[0]
    /* 工具等待分段（H-6b）：从本轮消息的工具调用派生，并行分支不重复计。 */
    const waitSpans = toolWaitSpans(
      this.messages
        .filter((m) => sourceIds.includes(m.id))
        .flatMap((m) => m.toolCalls ?? [])
    )
    const endedAt = Date.now()
    const record = {
      v: TURN_TIMING_VERSION,
      logicalTurnId,
      /* run id 让读回时能区分「同一段工作的两次快照」与「自动继续的另一段」。 */
      ...(this.turnRunId ? { runId: this.turnRunId } : {}),
      /* 墙钟起点是反推的（用时本身是单调口径），只用于展示这一轮什么时候开始 */
      startedAt: endedAt - elapsedMs,
      endedAt,
      elapsedMs,
      terminalReason,
      /*
       * H-6b：中途快照带 `final: false`。应用在飞行中被拿掉时盘上只剩它，
       * 读回就能把这一轮认成「被中断」而不是「正常完成」。
       */
      final,
      ...(anchorId ? { anchorId } : {}),
      sourceIds,
      ...(waitSpans.length ? { waitSpans } : {}),
      ...(this.turnOutputTokens ? { outputTokens: this.turnOutputTokens } : {}),
      monotonicMs: elapsedMs
    }
    const write = this.turnTimingWriteTail.then(() => appendTurnTiming(YAN_DIR, bucket, record))
    this.turnTimingWriteTail = write.then(
      () => undefined,
      () => undefined
    )
    if (await write) this.turnPersisted = true
  }

  private speedOf(
    s: {
      usage?: Usage
      firstTokenAt?: number
      startedAt?: number
    },
    endedAt = Date.now(),
    turnStartedAt?: number
  ): { speed?: number; elapsedMs?: number } {
    return turnTiming({
      usage: s.usage,
      firstTokenAt: s.firstTokenAt,
      startedAt: s.startedAt,
      turnStartedAt,
      endedAt
    })
  }

  /*
   * 这里曾经有一个 `flushBash()`：每帧把 command + toolCalls（含完整累积输出）
   * 重新推一遍。直执行 bash 的输出现在是工具增量通道的一部分
   * （见 `bash_execution_update` → `markToolOutput`），所以它被删掉了 ——
   * 留着会多出一条与增量协议并行的全量路径，两边迟早说不到一块去。
   */

  /**
   * 回合级「正在干活」。与 markStreaming 的区别：
   *   · isStreaming  = 此刻**有一条 assistant 消息在流**（工具执行期间为 false）；
   *   · agentRunning = 整个 agent 回合在跑（agent_start → agent_settled），
   *                    **覆盖工具执行**与中途的再思考。
   * 推理窗口的展开/折叠跟宽的那个走。
   */
  private setAgentRunning(v: boolean): void {
    if (this.agentRunning === v) return
    this.agentRunning = v
    if (!this.state) return
    this.state = { ...this.state, isAgentRunning: v }
    this.push({ ch: 'state', payload: this.state })
  }

  private markStreaming(v: boolean): void {
    if (!this.state) return
    if (this.state.isStreaming === v) return
    this.state = { ...this.state, isStreaming: v }
    this.push({ ch: 'state', payload: this.state })
  }

  /**
   * 压缩事件 → 状态 → 渲染端（N21-2）。
   *
   * 归一化（含“结束了但没有 status 字段”的兼容）全在 `main/compaction.ts`，
   * 这里只负责落盘与推送 —— 事件不是压缩类时 `reduceCompaction` 返回 null，
   * 这时**不要**推状态（state 推送很贵，而且没必要让界面重画）。
   */
  private setCompaction(cur: CompactionState, evt: Record<string, unknown>): void {
    let next = reduceCompaction(cur, evt)
    if (!next) return
    /*
     * 补上真正的发起方（N21-3）。两个判据都要，这是关键：
     *   · `running` 新出现 → 本次调用开的那一次，盖它；
     *   · `last` 是新对象且 `endedAt` 不同于基准 → 本次调用产生的结束记录，盖它。
     * 第二条不能省：实测成功的压缩只有结束记录（“正在压缩”已被
     * `isCompacting=false` 的自愈清掉），只盖 running 会丢章。
     * 也不能只看 last：开始事件到达时 last 还是**上一次**的结果，盖它就是撒谎。
     */
    const origin = this.policyOrigin
    if (origin) {
      const stamp = { triggeredBy: 'policy' as const, policyStage: origin.stage }
      const started = !!next.running && next.running !== cur.running
      const ended = !!next.last && next.last !== cur.last && next.last.endedAt !== origin.baseline
      if (started) next = { ...next, running: { ...next.running!, ...stamp } }
      else if (ended) next = { ...next, last: { ...next.last!, ...stamp } }
      /* 本次调用已经落定（成功或失败都算）：来源标记不再属于下一笔 */
      if (ended && !next.running) {
        this.policyOrigin = null
        /*
         * 压缩**成功** → 重新上膛（N21-4 尾，压力测试发现）。
         * 不能只靠「用量回落到线下」：当基线开销（系统提示 + 工具定义）本身就
         * 压在工作集线上时，那条路永远不会成立，策略会退化成 5 分钟一次。
         */
        if (next.last?.status === 'completed') {
          this.policyState = rearmAfterCompaction(this.policyState, next.last?.afterTokens ?? null)
        }
      }
    }
    this.compactionState = next
    if (!this.state) return
    this.state = {
      ...this.state,
      compaction: next.running ?? undefined,
      lastCompaction: next.last ?? undefined
    }
    this.push({ ch: 'state', payload: this.state })
  }

  /* -------------------------------------------------------------- 扩展 UI */

  private handleUi(req: Record<string, unknown>): void {
    const id = String(req.id ?? '')
    const method = String(req.method ?? '')

    // fire-and-forget 的几种
    if (method === 'notify') {
      this.push({ ch: 'notify', payload: { id, method: 'notify', ...req } as never })
      return
    }
    if (method === 'setStatus') {
      this.push({
        ch: 'status',
        payload: {
          key: String(req.statusKey ?? 'ext'),
          text: req.statusText === undefined ? undefined : String(req.statusText)
        }
      })
      return
    }
    if (method === 'setTitle') {
      this.push({ ch: 'title', payload: String(req.title ?? '砚') })
      return
    }
    if (method === 'set_editor_text') {
      this.push({ ch: 'editor-text', payload: String(req.text ?? '') })
      return
    }
    if (method === 'setWidget') {
      // TUI 里它显示在输入框上方。桌面端把它收进右栏「扩展」分区 ——
      // 扩展写的东西（MCP/LSP 状态之类）对用户有意义，直接丢等于骗扩展。
      const lines = Array.isArray(req.widgetLines) ? req.widgetLines.map((x) => String(x)) : undefined
      this.push({ ch: 'widget', payload: { key: String(req.widgetKey ?? 'ext'), lines } })
      return
    }

    // 需要应答的对话框
    if (id && this.uiSeen.has(id)) return
    if (id) this.uiSeen.add(id)
    if (id) this.pendingUi.add(id)
    /*
     * `sensitive` 是**请求方声明**的安全分类（方案第 6 节）：
     * 只有它为 true 时才走模态确认（焦点圈定），其余都走非模态问题面板。
     * 不从问题措辞里推断 —— 那既不可靠也容易被绕过。
     */
    this.push({
      ch: 'ui-request',
      payload: { id, method, sensitive: req.sensitive === true, ...req } as never
    })
  }

  /** 渲染端回答案（由 IPC 调） */
  respondUi(res: HostUiResponse & { id: string }): void {
    const hostPending = this.pendingHostUi.get(res.id)
    if (hostPending) {
      clearTimeout(hostPending.timer)
      this.pendingHostUi.delete(res.id)
      this.pendingUi.delete(res.id)
      hostPending.resolve(res)
      return
    }
    if (res.id) this.pendingUi.delete(res.id)
    this.rpc?.respondUi(res as Record<string, unknown>)
  }

  private rejectPendingHostUi(reason: string): void {
    const error = new Error(reason)
    for (const [id, pending] of this.pendingHostUi) {
      clearTimeout(pending.timer)
      this.pendingHostUi.delete(id)
      this.pendingUi.delete(id)
      pending.reject(error)
    }
  }

  /* ------------------------------------------------------------- 队列身份 */

  /**
   * 把 pi 的字符串数组与上一次快照按“同文本、原顺序”匹配，尽量保留 id；
   * 新出现的文本才分配新 id。重复文本因此仍然有两个不同的可操作对象。
   */
  private queueItems(raw: string[], previous: QueueItem[]): QueueItem[] {
    const buckets = new Map<string, QueueItem[]>()
    for (const item of previous) {
      const bucket = buckets.get(item.text) ?? []
      bucket.push(item)
      buckets.set(item.text, bucket)
    }
    return raw.map((text) => {
      const bucket = buckets.get(text)
      const kept = bucket?.shift()
      if (kept) return kept
      this.queueSequence += 1
      return { id: `q-${this.queueSequence.toString(36)}`, text }
    })
  }

  /** 更新本地队列身份并推给渲染端。 */
  private publishQueue(steering: string[], followUp: string[]): QueueState {
    const next: QueueState = {
      steering: this.queueItems(steering, this.queueState.steering),
      followUp: this.queueItems(followUp, this.queueState.followUp)
    }
    return this.publishQueueItems(next)
  }

  private publishQueueItems(next: QueueState): QueueState {
    this.queueState = next
    this.push({ ch: 'queue', payload: next })
    return next
  }

  /**
   * 从队列快照里摘掉一条“已经被消费”的项（D9）。
   *
   * 先 steering 后 followUp：同一个回合里 steering 会先被插进当前对话，
   * followUp 要等回合结束。两边都可能出现相同文本（用户反复发同一句），
   * 所以只摘**第一条**匹配（FIFO），剩下的等后续消息再到。
   */
  private consumeQueued(text: string): void {
    /* 判定规则在 queue-items.ts（纯函数，有单测）；这里只管把结果推出去 */
    const next = consumeQueuedItem(this.queueState, text)
    if (next) this.publishQueueItems(next)
  }

  private resetQueue(emit = false): void {
    this.queueState = { steering: [], followUp: [] }
    if (emit) this.push({ ch: 'queue', payload: this.queueState })
  }

  private queueItemOf(id: string): { kind: 'steering' | 'followUp'; item: QueueItem } | undefined {
    if (!id) return undefined
    const steering = this.queueState.steering.find((item) => item.id === id)
    if (steering) return { kind: 'steering', item: steering }
    const followUp = this.queueState.followUp.find((item) => item.id === id)
    return followUp ? { kind: 'followUp', item: followUp } : undefined
  }

  /** 所有基于 clear_queue 的操作共享一个串行闸门。 */
  private queueRun<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queueOperations
    const current = previous.then(work, work)
    this.queueOperations = current.then(() => undefined, () => undefined)
    return current
  }

  private async refillQueue(steering: string[], followUp: string[]): Promise<void> {
    for (const text of steering) {
      const res = await this.rpc!.command('steer', { message: text })
      if (!res.success) throw new Error(res.error || '恢复插话队列失败')
    }
    for (const text of followUp) {
      const res = await this.rpc!.command('follow_up', { message: text })
      if (!res.success) throw new Error(res.error || '恢复排队队列失败')
    }
  }

  /**
   * 清空后重排失败时尽力恢复原始队列。调用方会把恢复失败明确带给用户，
   * 不把“命令发出去了”伪装成成功。
   */
  private async restoreQueue(raw: { steering: string[]; followUp: string[] }): Promise<string | undefined> {
    try {
      const cleared = await this.rpc!.command('clear_queue')
      if (!cleared.success) return cleared.error || '清空队列失败，无法恢复原顺序'
      await this.refillQueue(raw.steering, raw.followUp)
      this.publishQueue(raw.steering, raw.followUp)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /* ---------------------------------------------------------------- 命令 */

  /**
   * 把这一轮的用户输入交给宿主检索，并把结果写成扩展要读的注入文件（实施-03 S3）。
   *
   * 为什么在这一层做：检索（打分 / 预算 / 状态过滤）是业务逻辑，只能在宿主跑 ——
   * 薄层扩展只允许「读文件 + 放一段消息」。这里 `await` 的意义是保证
   * **请求发出前**文件已就绪，不然会看到「第一轮没注入、第二轮才注入」的假象。
   *
   * 失败一律吞掉：查知识不该拦住用户发消息。宿主那侧失败时也会写一条
   * `read-failed` 记录（而不是留着上一轮的内容）—— 宁可这轮不注入，
   * 也不能让模型看到已经过期的材料。
   */
  private async prepareKnowledge(text: string): Promise<void> {
    /*
     * 会话键取 `capabilityOpts.sessionId`，**不**用 `state.sessionId`：
     * 扩展只能从环境变量（`YAN_SESSION_ID`）知道自己的会话键，而那个值
     * 正是 capabilityOpts.sessionId（宿主注入 `yan` CLI 的同一份身份）。
     * 用 state.sessionId 会让两边写到不同文件 —— 实测踩过：宿主写
     * `<稳定 sessionId>.json`，扩展去读 `r1.json`，于是「开启了也永远不注入」。
     */
    const sessionId = this.capabilityOpts?.sessionId
    if (!sessionId || !text.trim()) return
    try {
      const enabled = await readProjectKnowledgeEnabled()
      const projectId = this.capabilityOpts?.projectId
      await prepareProjectKnowledgeInjection({
        sessionId,
        /* 身份只来自宿主绑定的 capabilityOpts（不接受调用方自报的 cwd / projectId） */
        identity: projectId ? { projectId, cwd: this.cwd } : undefined,
        queryText: text,
        enabled
      })
    } catch {
      /* 检索失败静默放行 */
    }
  }

  async send(
    text: string,
    images?: { data: string; mimeType: string }[],
    /**
     * 生成中投递时的行为：`steer` = 插话（当前这轮就看到）、
     * `followUp` = 排队（等这轮跑完再投）。
     *
     * 渲染端在生成中总会显式传值 —— 它先把消息悬在输入框上方让用户
     * 选「插话 / 排队」，选完才发。这里只是防止别的调用路径漏传时
     * pi 直接报「Specify streamingBehavior」的兜底。
     */
    mode?: 'steer' | 'followUp'
  ): Promise<{ ok: boolean; error?: string }> {
    const payload: Record<string, unknown> = { message: text }
    if (images?.length) {
      payload.images = images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
    }
    // 智能体正在处理时必须指定投递行为，否则 pi 直接报错。
    // 具体用哪个由**渲染端**决定：消息先悬在输入框上方，用户点「插话」
    // 或「排队」之后才发到这里（`mode`）。以前是主进程单方面默认 steer，
    // 用户没有选择权，也没有机会在投递前改主意。
    // 不传 `mode` 时兜底 steer：宁可插话，也不能让 pi 抛
    // 「Agent is already processing. Specify streamingBehavior...」（用户报过的错）。
    // （pi：'steer' | 'followUp'）
    //
    // ⚠️ 判据必须是**回合级**的 `agentRunning`，不能只看 `isStreaming`。
    //    `isStreaming` 只在「有一条 assistant 消息正在流」时为真：
    //    工具执行期间它是 false（每条 assistant 消息 message_end 就清掉了），
    //    但 pi 内部的 isStreaming 仍是 true —— 于是用户在工具执行时发消息，
    //    我们没带 streamingBehavior，pi 直接抛
    //    「Agent is already processing. Specify streamingBehavior...」（用户报的错）。
    //
    // ⚠️ `isCompacting` 同理（用户 2026-09-19：「自动压缩的时候仍要允许用户
    //    发送消息」）。pi 在**回合之间**自动压缩时 `agentRunning` 已经是 false，
    //    而它忙着压缩 —— 漏了这一项就会发出裸 prompt 被 pi 拒掉（渲染端丢了草稿）。
    //    这里只做兜底：正常路径下渲染端会把消息先悬到待定区。
    if (this.agentRunning || this.state?.isStreaming || this.state?.isCompacting) {
      payload.streamingBehavior = mode ?? 'steer'
    }

    await this.prepareKnowledge(text)
    const res = await this.rpc!.command('prompt', payload)
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async steer(text: string): Promise<{ ok: boolean; error?: string }> {
    await this.prepareKnowledge(text)
    const res = await this.rpc!.command('steer', { message: text })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async followUp(text: string): Promise<{ ok: boolean; error?: string }> {
    await this.prepareKnowledge(text)
    const res = await this.rpc!.command('follow_up', { message: text })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /**
   * 运行时重载前的队列快照。会话 JSONL 不包含尚未投递的 steering / follow-up，
   * 因此资源更新后重建 pi 时必须单独保存并恢复它们。
   */
  queueSnapshot(): { steering: string[]; followUp: string[] } {
    return {
      steering: this.queueState.steering.map((item) => item.text),
      followUp: this.queueState.followUp.map((item) => item.text)
    }
  }

  /**
   * 在空闲的新实例里恢复重载前的队列；调用方须先确保目标会话已经载入。
   * 队列变化由 pi 的 `queue_update` 事件回传，本地也同步一份以覆盖无事件的版本。
   */
  async restoreQueueSnapshot(snapshot: { steering: string[]; followUp: string[] }): Promise<{ ok: boolean; error?: string }> {
    const steering = snapshot.steering.map((text) => String(text)).filter((text) => text.length > 0)
    const followUp = snapshot.followUp.map((text) => String(text)).filter((text) => text.length > 0)
    if (steering.length === 0 && followUp.length === 0) return { ok: true }
    if (!this.rpc?.running) return { ok: false, error: 'pi 尚未就绪，无法恢复排队消息' }
    if (this.queueState.steering.length > 0 || this.queueState.followUp.length > 0) {
      const existing = {
        steering: this.queueState.steering.map((item) => item.text),
        followUp: this.queueState.followUp.map((item) => item.text)
      }
      if (JSON.stringify(existing) === JSON.stringify({ steering, followUp })) return { ok: true }
      return { ok: false, error: '新实例已有不同的排队消息；为避免丢失或重复，拒绝覆盖' }
    }
    try {
      await this.refillQueue(steering, followUp)
      this.publishQueue(steering, followUp)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 把一条排队的消息「插队」提升为 steering（在当前这轮就听它的）。
   *
   * pi 没有「移除队列里某一条」的 RPC，只有 `clear_queue`（一次清空）。
   * 所以只能：先取出全部排队 → 把目标之外的内容按原类型重排 → 再把目标 steer。
   * 这里有固有的竞态（清空与重建之间 pi 可能已经投递了某条），
   * 所以失败不能吞：返回错误，由界面写进日志（用户要求「所有报错进日志」）。
   */
  async steerQueued(queueId: string): Promise<{ ok: boolean; error?: string }> {
    return this.queueRun(async () => {
      const target = this.queueItemOf(queueId)
      if (!target) return { ok: false, error: '这条排队消息已被接收或撤回，无法插队' }

      try {
        const res = await this.rpc!.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        if (!res.success) return { ok: false, error: res.error }
        const raw = { steering: res.data?.steering ?? [], followUp: res.data?.followUp ?? [] }
        const current = this.publishQueue(raw.steering, raw.followUp)
        const liveTarget = current[target.kind].find((item) => item.id === queueId)
        if (!liveTarget) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `消息已被接收；恢复队列失败：${recovery}`
              : '消息已被 pi 接收，无法再插队'
          }
        }

        const restSteer = current.steering.filter((item) => item.id !== queueId).map((item) => item.text)
        const restFollow = current.followUp.filter((item) => item.id !== queueId).map((item) => item.text)
        try {
          await this.refillQueue(restSteer, restFollow)
          const promoted = await this.rpc!.command('steer', { message: liveTarget.text })
          if (!promoted.success) throw new Error(promoted.error || '插队失败')
          this.publishQueueItems({
            steering: [...current.steering.filter((item) => item.id !== queueId), liveTarget],
            followUp: current.followUp.filter((item) => item.id !== queueId)
          })
          return { ok: true }
        } catch (error) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `插队失败，且恢复原队列失败：${recovery}`
              : `插队失败，已恢复原队列：${error instanceof Error ? error.message : String(error)}`
          }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /**
   * 撤回一条尚未被 pi 接收的消息。撤回成功返回原文，渲染端把它交回草稿；
   * 目标在 clear_queue 的瞬间已经消失时先恢复其它条目，再明确报告不可撤回。
   */
  async removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    return this.queueRun(async () => {
      const target = this.queueItemOf(queueId)
      if (!target) return { ok: false, error: '这条排队消息已被接收或撤回，无法撤回' }

      try {
        const res = await this.rpc!.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        if (!res.success) return { ok: false, error: res.error }
        const raw = { steering: res.data?.steering ?? [], followUp: res.data?.followUp ?? [] }
        const current = this.publishQueue(raw.steering, raw.followUp)
        const liveTarget = current[target.kind].find((item) => item.id === queueId)
        if (!liveTarget) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `消息已被接收；恢复队列失败：${recovery}`
              : '消息已被 pi 接收，无法撤回'
          }
        }

        const restSteer = current.steering.filter((item) => item.id !== queueId).map((item) => item.text)
        const restFollow = current.followUp.filter((item) => item.id !== queueId).map((item) => item.text)
        try {
          await this.refillQueue(restSteer, restFollow)
          this.publishQueueItems({
            steering: current.steering.filter((item) => item.id !== queueId),
            followUp: current.followUp.filter((item) => item.id !== queueId)
          })
          return { ok: true, text: liveTarget.text }
        } catch (error) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `撤回失败，且恢复原队列失败：${recovery}`
              : `撤回失败，已恢复原队列：${error instanceof Error ? error.message : String(error)}`
          }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  async abort(): Promise<{ steering: string[]; followUp: string[] }> {
    /* 用户主动停止：用时冻结在当下，并标明这不是正常完成（H-6）。 */
    this.turnTerminal = 'stopped'
    // 按 pi 的约定：先 clear_queue 再 abort，把排队的文本拿回来。
    // 否则用户打了一半又改主意的话，那几句话就白打了（rpc.md §clear_queue）。
    let cleared: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] }
    try {
      const res = await this.rpc?.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
      if (res?.success && res.data) {
        cleared = { steering: res.data.steering ?? [], followUp: res.data.followUp ?? [] }
      }
      /*
       * 不管 clear_queue 有没有带回文本，本地快照都得跟着清（D9）。
       *
       * 为什么：pi 只在队列变化时推 `queue_update`，而它把排队项拿去当普通
       * 消息消费时不一定推 —— 于是中止之后左栏/输入框上方还会挂着“排队中”，
       * 用户会以为自己那几句话还在排队。到底有没有被消费，`cleared` 是权威；
       * 快照只是展示，中止后应与 pi 对齐。
       */
      this.resetQueue(true)
    } catch {
      /* clear_queue 失败不阻碍中止；快照留给下一条 queue_update 自己对齐 */
    }

    // 本地先把流式收尾，UI 立刻有反馈
    if (this.streaming) {
      const s = this.streaming
      this.streaming = null
      const msg: UIMessage = {
        id: s.id,
        role: 'assistant',
        text: s.text,
        thinking: s.thinking || undefined,
        thinkingLive: false,
        toolCalls: s.tools.length ? s.tools : undefined,
        timestamp: Date.now()
      }
      this.messages.push(msg)
      for (const c of s.tools) this.registerCall(c, s.id)
      this.push({ ch: 'msg-update', payload: { id: s.id, patch: msg } })
    }

    // 直执行的 bash 也要收尾
    if (this.bash) {
      const b = this.bash
      this.bash = null
      this.push({
        ch: 'msg-update',
        payload: {
          id: b.msgId,
          patch: {
            bash: { command: b.command, exitCode: null, cancelled: true },
            toolCalls: [
              {
                id: b.msgId,
                name: 'bash',
                args: { command: b.command },
                status: 'error',
                output: b.output,
                endedAt: Date.now()
              }
            ]
          }
        }
      })
      await this.rpc?.command('abort_bash').catch(() => null)
    }

    this.markStreaming(false)
    this.setAgentRunning(false)
    await this.rpc?.command('abort').catch(() => null)
    this.publishQueue([], [])
    void this.refreshState()

    return cleared
  }

  /* ------------------------------------------------------ 直执行 bash */

  /**
   * 跑一个 shell 命令，不走 LLM。
   * pi 会把它当成 BashExecutionMessage 存进会话，**下一次 prompt 时会进上下文**。
   * 所以这是「我先看一眼，再让它基于这个结果干活」的逃生口。
   */
  async runBash(command: string): Promise<{ ok: boolean; error?: string }> {
    const cmd = command.trim()
    if (!cmd) return { ok: false, error: '命令为空' }
    if (this.bash) return { ok: false, error: '已有一条命令在跑' }

    const reqId = `yan-bash-${Date.now().toString(36)}`
    const msgId = `bash-${reqId}`
    this.bash = { reqId, msgId, command: cmd, output: '' }
    /* 直执行 shell 同样算“变更归属”（L05）：它与模型调的 bash 走的都是
       同一颗 pi，改的是同一个工作目录 —— 没有理由只有模型跑的命令能审阅。 */
    beginTreeSnapshot(msgId, this.cwd, this.state?.sessionId)

    const msg: UIMessage = {
      id: msgId,
      role: 'bash',
      text: cmd,
      bash: { command: cmd, exitCode: null, cancelled: false },
      toolCalls: [
        { id: msgId, name: 'bash', args: { command: cmd }, status: 'running', output: '', startedAt: Date.now() }
      ],
      timestamp: Date.now()
    }
    this.messages.push(msg)
    this.indexCalls(msg)
    this.push({ ch: 'msg-add', payload: msg })

    try {
      // bash 可能跑很久（编译/测试），给足超时
      const res = await this.rpc!.command<{
        output?: string
        exitCode?: number
        cancelled?: boolean
        truncated?: boolean
        fullOutputPath?: string
      }>('bash', { command: cmd }, { id: reqId, timeoutMs: 0 + 30 * 60_000 })

      const b = this.bash
      this.bash = null

      if (!res.success) {
        this.finishBash(msgId, cmd, b?.output ?? '', null, true, res.error)
        return { ok: false, error: res.error }
      }

      const d = res.data ?? {}
      // 流式可能不完整（某些命令一次性吐完），用响应的 output 兼底
      const output = d.output && d.output.length > (b?.output.length ?? 0) ? d.output : (b?.output ?? '')
      this.finishBash(msgId, cmd, output, d.exitCode ?? null, !!d.cancelled, undefined, d.truncated, d.fullOutputPath)
      return { ok: true }
    } catch (e) {
      const b = this.bash
      this.bash = null
      const err = e instanceof Error ? e.message : String(e)
      this.finishBash(msgId, cmd, b?.output ?? '', null, true, err)
      return { ok: false, error: err }
    }
  }

  private finishBash(
    msgId: string,
    command: string,
    output: string,
    exitCode: number | null,
    cancelled: boolean,
    error?: string,
    truncated?: boolean,
    fullOutputPath?: string
  ): void {
    const failed = cancelled || exitCode === null || exitCode !== 0
    /*
     * 先取目录差异：`endTreeSnapshot` 顺带把这次快照注销掉，
     * 不管后面提前返回还是抛错，都不能把活跃快照留成泄漏。
     */
    const changes = endTreeSnapshot(msgId)
    const details: Record<string, unknown> = {}
    if (truncated) {
      details.truncated = truncated
      details.fullOutputPath = fullOutputPath
    }
    if (changes && (changes.files.length > 0 || changes.unknown)) details.workspaceChanges = changes
    /*
     * 这里要**主动清掉该工具的增量游标与待推标记**：
     * 下面推的是全量快照，若还留着一个待推增量，定时器到点后会再追加一次
     * —— 而那份增量是基于旧长度算的，结果就是输出里多一段重复的尾巴。
     */
    this.pushedOut.set(msgId, output.length)
    this.dirtyTools.delete(msgId)
    this.push({
      ch: 'msg-update',
      payload: {
        id: msgId,
        patch: {
          text: command,
          bash: { command, exitCode, cancelled },
          error,
          toolCalls: [
            {
              id: msgId,
              name: 'bash',
              args: { command },
              status: failed ? 'error' : 'ok',
              output,
              details: Object.keys(details).length ? details : undefined,
              endedAt: Date.now()
            }
          ]
        }
      }
    })
    /*
     * 直执行 bash 也可能完成 `yan capabilities acquire`，把事务推进到
     * pending-boundary。它不会像模型回合那样稳定地产生 state/proc 事件，
     * 所以在 bash 自己收尾后主动给能力调度器一次安全边界机会；调度器仍
     * 会重新检查 trust / authorization / goal / runner 空闲条件。
     */
    this.capabilityOpts?.onBashSettled?.()
  }

  async abortBash(): Promise<void> {
    await this.rpc?.command('abort_bash').catch(() => null)
  }

  /**
   * 有**直执行** shell 在跑（L05 发现）。
   *
   * 为什么单拉一个方法：`getState()` 里的 isAgentRunning / isStreaming 都不
   * 包括直执行 bash（它不经过模型）。但这条命令正在改工作目录 ——
   * 复用/顶掉这个实例会出现两个问题：用户在新会话里发不出命令
   *（“已有一条命令在跑”），而且两个实例同 cwd 并行改文件正是 L03 要防的事。
   */
  hasRunningBash(): boolean {
    return this.bash !== null
  }

  /* ---------------------------------------------------------- 会话管理 */

  async newSession(): Promise<{ ok: boolean; error?: string }> {
    this.suppressPush = true
    try {
      const res = await this.rpc!.command('new_session')
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.uiSeen.clear()
      this.pendingUi.clear()
      this.setAgentRunning(false)
      this.resetQueue()
      /*
       * 压缩记录是**本次运行**的事实，换会话就作废：留着会把它挂到另一个会话
       * 头上（A 的「阈值触发 · 已完成」出现在 B 的详情里）。
       */
      this.compactionState = EMPTY_COMPACTION_STATE
      /* 上膛/冷却同样是本次运行的状态：换会话后按新会话的用量重新判定 */
      this.policyState = INITIAL_POLICY_STATE
      this.policyOrigin = null
      this.suppressPush = false
      await this.hydrate()
      return { ok: true }
    } finally {
      this.suppressPush = false
    }
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    this.suppressPush = true
    try {
      const res = await this.rpc!.command('switch_session', { sessionPath: path })
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.uiSeen.clear()
      this.pendingUi.clear()
      this.setAgentRunning(false)
      this.resetQueue()
      /* 同上：压缩记录不跨会话 */
      this.compactionState = EMPTY_COMPACTION_STATE
      this.policyState = INITIAL_POLICY_STATE
      this.policyOrigin = null
      this.suppressPush = false
      await this.hydrate()
      return { ok: true }
    } finally {
      this.suppressPush = false
    }
  }

  /**
   * 给会话起名。
   *
   * ⚠️ 空名字会被 pi 拒绝（`set_session_name` 返回 success:false）。
   * 所以这里直接拦住，并把错误信息说清楚 —— 否则用户看到的是“重命名失败”
   * 但不知道因为什么。
   */
  async renameSession(name: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, error: '名字不能为空（pi 不支持清除会话名）' }
    }
    const res = await this.rpc!.command('set_session_name', { name: trimmed })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /** 只重生成标题，不切换会话、不发送一条可见对话消息。 */
  async regenerateTitle(): Promise<{ ok: boolean; title?: string; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: '当前还没有可重生成标题的会话' }
    if (this.titleTried.has(sessionId)) return { ok: false, error: '标题正在生成，请稍候' }
    /*
     * **同步**占位，不能等到 maybeGenerateTitle 里再加：下面查手动名是异步的，
     * 两个并发调用会在那个 await 窗口里**同时**通过上面的 has 检查，各自跑一次
     * 归纳请求。实测第二次通常拿到空结果 → 用户看到「标题生成失败，已保留原标题」，
     * 而第一次的候选其实已经出来了（N11 探针第 3 节就是守这个）。
     * 这里占位、finally 释放；maybeGenerateTitle 用 lockHeld 跳过它自己的加锁。
     */
    this.titleTried.add(sessionId)
    try {
      const manual = await manualTitleOf(sessionId)
      const title = await this.maybeGenerateTitle({ force: true, candidate: !!manual, lockHeld: true })
      return title ? { ok: true, title } : { ok: false, error: '标题生成失败，已保留原标题' }
    } finally {
      this.titleTried.delete(sessionId)
    }
  }

  async fork(entryId: string): Promise<{ ok: boolean; error?: string; text?: string }> {
    const res = await this.rpc!.command<{ text?: string; cancelled?: boolean }>('fork', { entryId })
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '分叉被扩展取消' }
    this.uiSeen.clear()
    this.pendingUi.clear()
    await this.hydrate()
    return { ok: true, text: res.data?.text }
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command<{ cancelled?: boolean }>('clone')
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '复制被扩展取消' }
    this.uiSeen.clear()
    this.pendingUi.clear()
    await this.hydrate()
    return { ok: true }
  }

  async forkPoints(): Promise<ForkPoint[]> {
    const res = await this.rpc!.command<{ messages?: ForkPoint[] }>('get_fork_messages')
    return res.success ? (res.data?.messages ?? []) : []
  }

  async exportHtml(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const res = await this.rpc!.command<{ path?: string }>('export_html')
    if (!res.success) return { ok: false, error: res.error }
    return { ok: true, path: res.data?.path }
  }

  async compact(opts: { fromPolicy?: ContextTrigger } = {}): Promise<{ ok: boolean; error?: string }> {
    /*
     * 用户手动压缩要把来源标记清掉 —— 否则上一次策略触发留下的标记
     * 会把他自己点的那次标成「工作集」。
     */
    if (!opts.fromPolicy) this.policyOrigin = null
    /*
     * 契约是「不抛」：调用方有两类 —— 用户点的 `/compact`（会把它当提示弹出来）
     * 和策略触发的自动压缩（在 `void` 出去的异步链上）。后者没人接异常，
     * 一抛就是一条 `unhandledRejection` 控制台报错，所以超时/进程没了都归成 `{ ok: false }`。
     */
    let res: Awaited<ReturnType<PiRpc['command']>>
    try {
      res = await this.rpc!.command('compact', {}, { timeoutMs: COMPACT_REQUEST_TIMEOUT_MS })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /* ---------------------------------------------------------- 模型 / 开关 */

  private enqueueCapabilityChange<T>(work: () => Promise<T>): Promise<T> {
    const next = this.capabilityChangeTail.then(work, work)
    this.capabilityChangeTail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async applyModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_model', { provider, modelId })
    if (!res.success) return { ok: false, error: res.error }
    await this.refreshState()
    /* 模型可能没有任何思考档位；空数组也是权威结果，不能保留旧值。 */
    await this.listThinkingLevels()
    /* 新模型的上下文窗口与 token 统计必须一起刷新。 */
    await this.refreshStats()
    return { ok: true }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.rpc!.command<{ models?: ModelInfo[] }>('get_available_models')
    if (!res.success) return []
    return (res.data?.models ?? [])
      .map((model) => normalizeModelInfo(model))
      .filter((model): model is ModelInfo => model !== undefined)
  }

  async setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueCapabilityChange(() => this.applyModel(provider, modelId))
  }

  async setThinking(level: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueCapabilityChange(async () => {
      const res = await this.rpc!.command('set_thinking_level', { level })
      if (res.success) await this.refreshState()
      return res.success ? { ok: true } : { ok: false, error: res.error }
    })
  }

  async listThinkingLevels(): Promise<string[]> {
    const res = await this.rpc!.command<{ levels?: string[] }>('get_available_thinking_levels')
    const normalized = normalizeThinkingLevels(res.data?.levels, res.success)
    const levels = normalized.values
    if (this.state) {
      this.state = {
        ...this.state,
        availableThinkingLevels: levels,
        thinkingLevelsStatus: normalized.status,
        capabilities: capabilitySnapshot(this.state.model, levels, normalized.status)
      }
      this.push({ ch: 'state', payload: this.state })
    }
    return levels
  }

  async setAutoCompaction(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_auto_compaction', { enabled })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setAutoRetry(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_auto_retry', { enabled })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /* -------------------------------------------------- 队列模式 / 轮换 */

  /**
   * 排队消息的投递方式。
   *
   * 为什么值得做：用户在生成中插话（steer）时，“什么时候听我的”有两种真实选择 ——
   *   一次说完（all）：当前工具跑完就全部投进去
   *   一次一条（one-at-a-time）：每完成一个回合投一条，节奏更可控
   * 这是 pi 的正式能力，藏着一个没法用的选项等于少了半个功能。
   */
  async setSteeringMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_steering_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setFollowUpMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_follow_up_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /** 取消正在等待的重试（自动重试计时器还开着的时候特别有用） */
  async abortRetry(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('abort_retry')
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /**
   * 循环切下一个模型（TUI 的 Ctrl+P）。
   *
   * ⚠️ 这里**不用** pi 的 `cycle_model`。
   *   pi 的 cycle 只在它自己的 “scoped models” 列表里转（默认是从配置推出来的
   *   一小撮），而界面上的选择器列出的是 `get_available_models` 的全部。
   *   两者不一致时，用户按 Ctrl+P 看到的行为就是「模型跳到了一个我没见过的」。
   *   所以按**界面所示的顺序**走：拿当前模型在完整列表里的下一个。
   *
   * 按 provider 分组、组内保持原顺序 —— 与选择器渲染的一致，
   * 否则“下一个”与面板里看到的“下一行”不是一个东西。
   */
  async cycleModel(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.cycleModelBy(1)
  }

  /**
   * 反向循环模型（桌面端 Ctrl+Shift+P，对齐 pi TUI 的“上一个模型”）。
   *
   * 为什么自己算而不用 pi 的命令：pi 0.87.1 的 RPC 有 `cycle_model`
   * （固定向前）和 `set_model`，没有反向循环命令。这里复用 `get_available_models` +
   * `set_model` 手动走上一项，语义与界面显示的列表一致。
   */
  async cycleModelBack(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.cycleModelBy(-1)
  }

  /** `dir = 1` 下一个，`dir = -1` 上一个 */
  private async cycleModelBy(dir: 1 | -1): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.enqueueCapabilityChange(() => this.cycleModelNow(dir))
  }

  private async cycleModelNow(dir: 1 | -1): Promise<{ ok: boolean; error?: string; to?: string }> {
    const models = await this.listModels()
    if (models.length < 2) return { ok: false, error: '只有一个可用模型' }

    const cur = this.state?.model
    const i = models.findIndex((m) => m.provider === cur?.provider && m.id === cur?.id)
    // 当前模型不在列表里（刚切过来 / 列表变了）→ 从第一个开始
    const next = models[i < 0 ? 0 : (i + dir + models.length) % models.length]

    const changed = await this.applyModel(next.provider, next.id)
    return changed.ok ? { ok: true, to: next.name } : changed
  }

  /** 循环切下一档思考强度（TUI 的 Shift+Tab）。同样按界面所示档位走。 */
  async cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.enqueueCapabilityChange(async () => {
      const levels = await this.listThinkingLevels()
      if (levels.length < 2) return { ok: false, error: '当前模型不支持思考' }

      const cur = this.state?.thinkingLevel ?? 'off'
      const i = levels.indexOf(cur)
      const next = levels[i < 0 ? 0 : (i + 1) % levels.length]

      const res = await this.rpc!.command('set_thinking_level', { level: next })
      if (!res.success) return { ok: false, error: res.error }

      await this.refreshState()
      return { ok: true, to: next }
    })
  }

  /** 最后一条助手消息的纯文本（复制用） */
  async lastAssistantText(): Promise<string | null> {
    const res = await this.rpc!.command<{ text?: string | null }>('get_last_assistant_text')
    if (!res.success) return null
    return res.data?.text ?? null
  }

  async listCommands(): Promise<SlashCommand[]> {
    if (!this.rpc) return mergeCommandDescriptors([])
    try {
      const res = await this.rpc.command<{ commands?: unknown[] }>('get_commands')
      return mergeCommandDescriptors(res.success ? res.data?.commands : [])
    } catch {
      /* pi 退出或尚未握手时，Yan 本地命令仍应可发现。 */
      return mergeCommandDescriptors([])
    }
  }

  /**
   * pi 的**原始**命令面（含 `sourceInfo.path`）。
   *
   * 能力目录必须看这个，而不是 `listCommands()`：后者经 `command-registry`
   * 归一化成渲染端斜杠命令的形状，只看顶层 `location`；而 pi 把技能路径放在
   * `sourceInfo.path` 里 —— 用归一化结果会把技能全部丢掉（04-S2 实测踩过：
   * 目录只剩内置能力，`considered` 恒等于内置条数）。
   */
  private async rawCommands(): Promise<RawSkillCommand[]> {
    if (!this.rpc) return []
    try {
      const res = await this.rpc.command<{ commands?: unknown[] }>('get_commands')
      return res.success ? ((res.data?.commands ?? []) as RawSkillCommand[]) : []
    } catch {
      return []
    }
  }

  /** Runtime project identity used by durable capability activation bindings. */
  get capabilityProjectId(): string | null {
    return this.capabilityOpts?.projectId ?? null
  }

  /** Runtime-reported paths for loaded extension commands and skills. */
  async runtimeCommandPaths(): Promise<string[]> {
    const paths = new Set<string>()
    for (const command of await this.rawCommands()) {
      if (typeof command.path === 'string' && command.path.trim()) paths.add(command.path.trim())
      if (typeof command.location === 'string' && command.location.trim()) paths.add(command.location.trim())
      if (command.sourceInfo && typeof command.sourceInfo === 'object') {
        const path = (command.sourceInfo as { path?: unknown }).path
        if (typeof path === 'string' && path.trim()) paths.add(path.trim())
      }
    }
    return [...paths]
  }

  /* ------------------------------------------------------------ 查询 */

  async getMessages(): Promise<UIMessage[]> {
    return this.messages
  }

  async refreshState(): Promise<SessionState | null> {
    try {
      const res = await this.rpc?.command('get_state')
      if (res?.success) this.setStateFrom(res.data as Record<string, unknown>)
    } catch {
      /* 进程没了 */
    }
    return this.state
  }

  async refreshStats(opts: { allowPolicyTrigger?: boolean } = {}): Promise<SessionStats | null> {
    try {
      const res = await this.rpc?.command<SessionStats>('get_session_stats')
      if (res?.success && res.data) {
        const stats = this.statsForCurrentModel(res.data)
        this.push({ ch: 'stats', payload: stats })
        /*
         * 工作集判定**只允许在回合结束那条路上跑**（见 evaluateContextPolicy）。
         *
         * 为什么不能用“每次刷新用量”当触发点：切到（或只是读一下）一个很大的旧会话
         * 也会刷新用量 —— 实测那个会话已经 276k tokens（超过 262k 窗口），
         * 于是切过去的瞬间就发起压缩、实例变“忙”，紧接着「新对话」被拒
         * （同一 cwd 已有运行中的会话）。用户只是想看一眼那个会话，不该被动刀。
         */
        if (opts.allowPolicyTrigger) {
          const tokens = stats.contextUsage?.tokens
          void this.evaluateContextPolicy(typeof tokens === 'number' ? tokens : null)
        }
        return stats
      }
    } catch {
      /* ignore */
    }
    return null
  }

  /* ---------------------------------------------------------- 标题生成 */

  /**
   * 用模型给会话起一个短标题（≤ 8 字）。
   *
   * 触发条件：
   *   ① 这个会话至少有一条用户消息（没东西可总结）
   *   ② 该会话现在没有正在跑的标题任务（避免并发多个 pi 进程）
   *
   * ⚠️ 用户要求「每次对话标题需要 agent 生成一个新的」—— 所以**每轮**都会重算
   * （ `force: true` 绕过缓存）。代价是每轮多一个 `--no-session --no-extensions`
   * 的短进程；这是用户明确要的行为，不是疏忽。
   *
   * 为什么用独立进程：见 src/main/title.ts —— 复用主会话会污染对话、
   * 还会让 prompt cache 全部失效（那个代价比一次请求贵得多）。
   */
  private async maybeGenerateTitle(
    opts: { force?: boolean; candidate?: boolean; lockHeld?: boolean } = {}
  ): Promise<string | null> {
    const st = this.state
    if (!st) return null
    /* lockHeld：调用方（regenerateTitle）已经在 await 之前占好位，别再判一次 */
    if (!opts.lockHeld && this.titleTried.has(st.sessionId)) return null

    const users = this.messages.filter(
      (m) => m.role === 'user' && (m.text.trim() || m.images?.length)
    )
    if (users.length === 0) return null

    /*
     * 样本 = 第一句 + 最近一句（纯逻辑在 shared/title-samples.ts，
     * 与「从 JSONL 里读」的那条路径共用同一套规则）。
     * 纯图片消息用占位符，否则 samples 为空 → 标题永远生成不出来
     *（用户报的「首条消息带图就没标题」）。
     */
    const samples = titleSamples(users)
    /* 首条消息的图片一并交给归纳进程 —— 模型能看着图起标题（最多一张：短请求别塞太多图） */
    const titleImages = titleSampleImages(users)

    if (!opts.lockHeld) this.titleTried.add(st.sessionId)
    const sessionId = st.sessionId

    try {
      const res = await generateTitle({
        sessionId,
        samples,
        images: titleImages,
        cwd: this.cwd,
        piBin: this.piBin,
        force: opts.force,
        allowManual: opts.candidate,
        persist: !opts.candidate
      })
      if (!res?.title) return null

      if (opts.candidate) return res.title

      // 写回 pi（TUI 的 /resume 也能看到）。
      // ⚠️ 只有在标题真的变了才写 —— set_session_name 会改会话文件，
      // 每轮都写一下是没意义的磁盘写入。
      if (this.lastTitle !== res.title) {
        this.lastTitle = res.title
        const ok = await this.rpc?.command('set_session_name', { name: res.title })
        if (ok?.success) await this.refreshState()
      }
      // 不管写没写进 pi，都推给界面 —— 标题是给用户看的
      this.push({ ch: 'session-title', payload: { sessionId, title: res.title } })
      return res.title
    } catch (e) {
      // 标题失败不该影响任何事
      console.error('[agent] 标题生成失败：', e)
      return null
    } finally {
      if (!opts.lockHeld) this.titleTried.delete(sessionId)
    }
  }

  getState(): SessionState | null {
    return this.state
  }

  /** RunnerRegistry increments this when an in-process runner changes sessions. */
  setRunnerGeneration(generation: number): void {
    if (this.capabilityOpts && Number.isSafeInteger(generation) && generation > 0) {
      this.capabilityOpts.runnerGeneration = generation
    }
  }

  /**
   * 给 token 统计加上模型身份。
   *
   * pi 的旧版本只返回数字，不返回“这组数字属于哪个模型”。在模型切换
   * 或快速切会话时，renderer 不能安全地把旧 contextWindow 当成新能力；
   * 主进程在拿到当前 state 后补上身份，未知 token 则保持 null。
   */
  private statsForCurrentModel(stats: SessionStats): SessionStats {
    const modelKey = modelKeyOf(this.state?.model)
    if (!stats.contextUsage) return stats
    return {
      ...stats,
      contextUsage: {
        ...stats.contextUsage,
        ...(modelKey ? { modelKey } : {}),
        availability: typeof stats.contextUsage.tokens === 'number' ? 'known' : 'unknown',
        estimated: false
      }
    }
  }

  /** 还在等用户回答的请求数（N12：后台会话的状态槽用它） */  getPendingUiCount(): number {
    return this.pendingUi.size
  }

  async stop(): Promise<void> {
    /* 端点随实例一起停：token 作废，旧 CLI 环境变量从此无效。 */
    this.capabilityServer?.stop()
    this.capabilityServer = undefined
    this.yanCliEnv = undefined
    /* MCP 会起子进程；不停掉就会留下孤儿（Windows 上不会自己收）。 */
    await this.mcpManager?.close().catch(() => undefined)
    this.mcpManager = undefined
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.streaming = null
    this.bash = null
    this.dirty = false
    this.dirtyTools.clear()
    this.callIndex.clear()
    this.callOwner.clear()
    this.pushedOut.clear()
    this.rejectPendingHostUi('会话已关闭，问题请求已取消')
    this.pendingUi.clear()
    await this.rpc?.close()
    this.rpc = null
    this.messages = []
    this.resetQueue()
  }
}

export type { BashRun, ForkPoint, SlashCommand }
