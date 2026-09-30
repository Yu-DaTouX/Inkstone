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
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { saveUserSkill } from './user-skills'
import { PiRpc } from './protocol'
import type { CapabilityCommandResult, CapabilityHandlers, YanCliEnv } from './capability-server'
import { CapabilityCommandError, CapabilityServer } from './capability-server'
import { ContextRecallError, findArchivedContext, recallArchivedContext } from './context-recall'
import { previewOffice } from './office/office-service'
import { localDeviceId, markConsentAuto, readConsentLedger, recordConsentAnswer } from './consent-store'
import {
  consentKeyOf,
  consentVerdict,
  normalizeConsentParts,
  type ConsentDecision,
  type ConsentKeyParts,
  type ConsentVerdict
} from '../shared/tool-consent'
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
  hasExplicitLegacyOverride,
  INITIAL_POLICY_STATE,
  rearmAfterCompaction,
  type ContextPolicyState,
  type ContextTrigger,
  type ResolvedContextPolicy
} from '../shared/context-policy'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { projectPackageDirs } from './packages'
import { turnTiming } from '../shared/turn-timing'
import { applyTurnTimings, readTurnTimings, timingKey } from './turn-timing-store'
import { mergeCommandDescriptors } from './command-registry'
import { generateTitle, manualTitleOf } from './title'
import { readSessionMessages, type ReadResult } from './session-reader'
import { SessionEntriesLite } from './session-entries-lite'
import { localizeImage } from './image-store'
import { todoSnapshotsFromEntries } from './todo-snapshots'
import { applyTaskPlanOperation, currentTaskPlan, readTaskPlanLog, TaskPlanStoreError } from './task-plan-store'
import { agentProfileSnapshotPath } from './agent-profile-store'
import { decideTaskCreation, taskCreationRefusal } from '../shared/activity-flow'
import { isAgentActivity, isAgentProfileKind, type AgentActivity, type AgentProfileKind } from '../shared/agent-profile'
import { isSafeSessionId } from './context-state-store'
import { readSessionEntryIndex } from './context-watermark'
import { contextBudgetStoreV1 } from './context-budget-store'
import type { ContextMaintenanceOperationV1 } from '../shared/context-maintenance'
import { questionLog } from './question-log'
import { prepareProjectKnowledgeInjection, readProjectKnowledgeEnabled } from './project-knowledge'
import { requestedTimeout } from '../shared/ui-timeout'
import { buildCatalog } from './capabilities/catalog'
import { webSearchAvailability, type WebSearchAvailability } from '../shared/web-search'
import { readSkillById, skillsFromCommands, type RawSkillCommand } from './capabilities/skill-service'
import { CapabilityAcquisition } from './capabilities/acquisition-commands'
import { ContextBudgetCommands } from './context-budget-commands'
import { BrowserCommands } from './browser-commands'
import { LookupCommands } from './lookup-commands'
import { TurnTimingTracker } from './turn-timing-tracker'
import { UiRequests, type HostUiResponse } from './ui-requests'
import { paramString } from './command-params'
import { activeSkillArgs } from './capabilities/skill-files'
import { McpConnectionManager } from './mcp/connection-manager'
import { loadMcpServers, mcpServersForProject } from './mcp/config'
import { callMcpTool, describeMcpTool, McpToolError } from './mcp/tool-service'
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
  BrowserNetworkSnapshot,
  BrowserState,
  ContextBudget,
  ContextPolicy,
  ContextPolicyView,
  CustomEntry,
  ExtensionUiRequest,
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
import type { CapabilityStrategy, WorkMode } from '../shared/ipc'

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

/* -------------------------------------------------- 浏览器（宿主能力服务） */

/** 浏览器动作的结果形状（`BrowserController` 的 `BrowserActionResult`）。 */
type BrowserCommandResult = { ok: boolean; error?: string; code?: string }

/** 会带回一份新观察的动作（click / type / press / scroll）。 */
export type BrowserObservationResult = BrowserCommandResult & { observation?: BrowserObservation }

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
  network(): Promise<BrowserNetworkSnapshot>
  click(ref: string): Promise<BrowserObservationResult>
  type(ref: string, text: string): Promise<BrowserObservationResult>
  select(ref: string, value: string): Promise<BrowserObservationResult>
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
/** 普通工具使用前的询问（需求稿 4.3）：宿主显示确认框，返回用户的真实答复；没有答复为 null */
/** 高危操作确认框的入参（由 danger-guard 薄层发起） */
export interface DangerConfirmPrompt {
  tool: string
  detail: string
  reasons: string[]
  cwd: string
}

export interface ToolConsentPrompt {
  parts: ConsentKeyParts
  purpose: string
  verdict: ConsentVerdict
  cwd: string
}
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

/** 能力服务参数（由 RunnerRegistry 工厂传入）。 */
export interface CapabilityRunOptions {
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
  /** 活动档案（实施-25 P01）：按会话注角色与受限工具。 */
  private agentProfileExtension?: string
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
  /** 随包技能（resources/skills/<名称>/SKILL.md）：显式 --skill 传入，不开启自动发现 */
  private bundledSkills: string[] = []
  /** 用户技能（YAN_DIR/skills）：每次启动时重新列出，新保存的技能在下一次启动生效。 */
  private userSkills?: () => Promise<string[]>
  /** 最终 provider payload 观察器，排在受管与项目扩展之后。 */
  private contextBudgetObserverExtension?: string
  /** Budget V1 的受控摘要事务与活跃投影应用。 */
  private contextBudgetMaintenanceExtension?: string
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
  /** 资料引用：按版本读片段与引用状态。 */
  private researchHost?: GoalCommandHost
  /** 持续关注（P16）：到点提醒与结果记录，没有后台调度器。 */
  private followHost?: GoalCommandHost
  /** CLI 只能请求授权；最终选择由主进程的可见确认 UI 返回。 */
  private confirmCapabilityAuthorization?: (
    request: CapabilityAuthorizationPrompt
  ) => Promise<CapabilityAuthorizationChoice>
  private confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
  private confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentDecision | null>
  private confirmDanger?: (request: DangerConfirmPrompt) => Promise<ConsentDecision | null>
  private dangerGuardExtension?: string
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
  private capabilityOpts?: CapabilityRunOptions

  /** 模型/思考能力变更串行化，避免快速点击时旧响应覆盖新状态。 */
  private capabilityChangeTail: Promise<void> = Promise.resolve()
  /**
   * MCP 连接管理器（实施-04 S3）。懒创建：没配 MCP 服务的机器上不付任何代价，
   * 也不起多余进程。与 agent 同生命周期 —— `stop()` 时关掉，不留孤儿子进程。
   */
  private mcpManager?: McpConnectionManager
  /** 配置本身的毛病（坏条目 / 重复 id）；调用时如实带回，不静默。 */
  private mcpConfigError?: string
  /** `yan capabilities search / discover / prepare / acquire` 的实现（见 capabilities/acquisition-commands.ts） */
  /** `yan search …` 与 `yan knowledge …` 的实现（见 lookup-commands.ts） */
  private readonly lookup = new LookupCommands({
    capabilityOpts: () => this.capabilityOpts,
    cwd: () => this.cwd
  })
  /** `yan browser …` 的实现（见 browser-commands.ts） */
  private readonly browserCommands = new BrowserCommands({
    browserHostOrNull: () => this.getBrowserHost?.() ?? null,
    capabilityOpts: () => this.capabilityOpts
  })
  /** 上下文预算命令与回合边界记账（见 context-budget-commands.ts） */
  private readonly contextBudget = new ContextBudgetCommands({
    state: () => this.state,
    messages: () => this.messages,
    cwd: () => this.cwd
  })
  private readonly acquisition = new CapabilityAcquisition({
    capabilityOpts: () => this.capabilityOpts,
    cwd: () => this.cwd,
    mcpManager: () => this.mcpManager,
    resetMcpManager: () => {
      this.mcpManager = undefined
    },
    mcpConfigError: () => this.mcpConfigError,
    mcpConnectionManager: () => this.mcpConnectionManager(),
    goalHost: () => this.goalHost,
    rawCommands: () => this.rawCommands(),
    push: (msg) => this.push(msg),
    getState: () => this.getState(),
    confirmCapabilityAuthorization: () => this.confirmCapabilityAuthorization,
    bundledSkills: () => this.bundledSkills
  })

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
  private contextMaintenanceInProgress = false
  /** 当前回合的计时与元数据（见 turn-timing-tracker.ts） */
  private readonly turn = new TurnTimingTracker()
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
  /** 扩展与宿主发起的界面请求（见 ui-requests.ts） */
  /** 会话文件的轻量条目索引（任务清单 / 自定义条目 / 用户轮次），见 session-entries-lite.ts */
  private readonly entriesLite = new SessionEntriesLite()

  /**
   * 任务清单这类读者要的条目：优先读会话文件（只读新增部分、不带消息内容），
   * 文件还不存在（新会话尚未落盘）时退回 pi 的 `get_entries`。
   */
  private async sessionEntries(): Promise<Record<string, unknown>[] | null> {
    const lite = await this.entriesLite.entries(this.state?.sessionFile).catch(() => null)
    if (lite) return lite
    const res = await this.rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
    return res?.success ? (res.data?.entries ?? []) : null
  }

  private readonly ui = new UiRequests({
    push: (msg) => this.push(msg),
    respondToPi: (res) => this.rpc?.respondUi(res)
  })

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
    agentProfileExtension?: string
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
    bundledSkills?: string[]
    userSkills?: () => Promise<string[]>
    /** 上下文预算 V1：最终 payload 观察器，需排在受管与项目扩展之后。 */
    contextBudgetObserverExtension?: string
    /** 上下文预算 V1：受控摘要命令与已提交投影应用。 */
    contextBudgetMaintenanceExtension?: string
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
    /** 资料引用：按版本读片段与引用状态；对照做法在 research 技能。 */
  researchHost?: GoalCommandHost
  /** 持续关注（实施-25 P16）：只能提议与回报，不能启用 / 删除 / 让宿主自己去查。 */
  followHost?: GoalCommandHost
    confirmCapabilityAuthorization?: (
      request: CapabilityAuthorizationPrompt
    ) => Promise<CapabilityAuthorizationChoice>
    confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
    confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentDecision | null>
    confirmDanger?: (request: DangerConfirmPrompt) => Promise<ConsentDecision | null>
    dangerGuardExtension?: string
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
    this.agentProfileExtension = opts.agentProfileExtension
    this.goalResumeExtension = opts.goalResumeExtension
    this.handoffsExtension = opts.handoffsExtension
    this.responseDetailExtension = opts.responseDetailExtension
    this.languageExtension = opts.languageExtension
    this.capabilityGuideExtension = opts.capabilityGuideExtension
    this.contextExtension = opts.contextExtension
    this.projectKnowledgeExtension = opts.projectKnowledgeExtension
    this.repeatGuardExtension = opts.repeatGuardExtension
    this.bundledSkills = opts.bundledSkills ?? []
    this.userSkills = opts.userSkills
    this.contextBudgetObserverExtension = opts.contextBudgetObserverExtension
    this.contextBudgetMaintenanceExtension = opts.contextBudgetMaintenanceExtension
    this.readHistory = opts.readHistory
    this.getResponseDetail = opts.getResponseDetail
    this.getBrowserHost = opts.browserHost
    this.subagentHost = opts.subagentHost
    this.goalHost = opts.goalHost
    this.researchHost = opts.researchHost
    this.followHost = opts.followHost
    this.confirmCapabilityAuthorization = opts.confirmCapabilityAuthorization
    this.confirmExternalApi = opts.confirmExternalApi
    this.confirmToolConsent = opts.confirmToolConsent
    this.confirmDanger = opts.confirmDanger
    this.dangerGuardExtension = opts.dangerGuardExtension
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
  /** 每个会话上一次生成标题用的样本（第一句 + 最近一句用户消息） */
  private titledSamples = new Map<string, string>()

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
    const userSkillArgs = this.userSkills ? await this.userSkills().catch(() => [] as string[]) : []
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
        /*
         * 活动档案（实施-25 P01）：紧跟在 work-mode 之后加载。
         * 两边各自收紧工具、互不恢复对方，所以顺序不影响「更严的那个生效」。
         */
        ...(this.agentProfileExtension ? ['--extension', this.agentProfileExtension] : []),
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
        ...(this.dangerGuardExtension ? ['--extension', this.dangerGuardExtension] : []),
        /* 受管 skill-files 只按当前项目 active 记录显式传入；不扫描全盘。 */
        ...managedSkillArgs,
        /* 随包技能：领域做法（例如办公文件）放在技能里按需加载，不写进宿主 */
        ...this.bundledSkills.flatMap((skill) => ['--skill', skill]),
        /* 用户技能：用户自己保存的做法（含旧办事模板的导出） */
        ...userSkillArgs.flatMap((skill) => ['--skill', skill]),
        /* 项目已授权登记的 pi 包：显式路径不受 `--no-extensions` 影响（见函数注释）。 */
        ...projectPackageArgs,
        /* 投影在 `context` 阶段生效；最终 budget observer 保持所有请求改写器之后。 */
        ...(this.contextBudgetMaintenanceExtension
          ? ['--extension', this.contextBudgetMaintenanceExtension]
          : []),
        /* 必须排在所有会改请求内容的内置、受管、项目扩展之后。 */
        ...(this.contextBudgetObserverExtension
          ? ['--extension', this.contextBudgetObserverExtension]
          : []),
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
        ...(this.capabilityOpts?.sessionId
          ? { YAN_RUNNER_ID: this.capabilityOpts.sessionId }
          : { YAN_RUNNER_ID: 'primary' }),
        YAN_RUNNER_EPOCH: String(this.capabilityOpts?.runnerGeneration ?? 1),
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

    rpc.on('ui', (req) => this.ui.handleUi(req))
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
    /* 问答回放：切会话 / 分叉 / 重载后按会话重新对齐（不依赖上一条推送） */
    this.pushQuestionLog()
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
      const entries = await this.sessionEntries()
      if (!entries) return []
      return entries
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
      const entries = await this.sessionEntries()
      if (!entries) return []
      const hostEntries = await this.taskPlanEntries()
      const snaps = todoSnapshotsFromEntries([...entries, ...hostEntries])
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
      return this.browserCommands.runBrowserCommand(command.slice('browser.'.length), params)
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
      return this.acquisition.runCapabilitiesSearch(params)
    }
    /*
     * 按需获取能力（实施-25 P17）：用自然语言说「我要做什么」，
     * 宿主回答「缺什么、怎么接」。它只给路径，不替你装
     * （安装仍走下面的 prepare / acquire）。
     */
    if (command === 'capabilities.discover') {
      return this.acquisition.runCapabilitiesDiscover(params)
    }
    if (command === 'capabilities.prepare') {
      return this.acquisition.runCapabilitiesPrepare(params)
    }
    if (command === 'capabilities.acquire') {
      return this.acquisition.runCapabilitiesAcquire(params)
    }
    if (command === 'skill.read') {
      return this.runSkillRead(params)
    }
    if (command === 'skill.save') {
      return this.runSkillSave(params)
    }
    if (command.startsWith('mcp.')) {
      return this.runMcpCommand(command.slice('mcp.'.length), params)
    }
    if (command.startsWith('knowledge.')) {
      return this.lookup.runKnowledgeCommand(command.slice('knowledge.'.length), params)
    }
    /*
     * 联网搜索（实施-27 S3）：只查询与诊断。
     * 「把搜索结果打开」走 `yan browser navigate` —— 搜索不碰浏览器状态。
     */
    if (command.startsWith('search.')) {
      return this.lookup.runSearchCommand(command.slice('search.'.length), params)
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
    /* 资料引用：按版本读片段与引用状态（对照做法在 research 技能）。 */
    if (command.startsWith('research.')) {
      if (!this.researchHost) {
        throw new CapabilityCommandError('research_unavailable', '研究入口当前不可用（宿主未注入）')
      }
      return this.researchHost.run(command, params, {
        sessionId: this.capabilityOpts?.sessionId ?? 'primary',
        projectId: this.capabilityOpts?.projectId ?? ''
      })
    }
    /*
     * 持续关注（实施-25 P16）：模型能提议与回报，不能启用（那要用户点）、
     * 不能删、也没有「你去后台盯一下」这种命令。
     */
    if (command.startsWith('follow.')) {
      if (!this.followHost) {
        throw new CapabilityCommandError('follow_unavailable', '关注入口当前不可用（宿主未注入）')
      }
      return this.followHost.run(command, params, {
        sessionId: this.capabilityOpts?.sessionId ?? 'primary',
        projectId: this.capabilityOpts?.projectId ?? ''
      })
    }
    if (command === 'artifact.attach') return this.runArtifactAttachCommand(params)
    if (command === 'question.ask') return this.runQuestionCommand(params)
    if (command === 'context.recall') return this.runContextRecallCommand(params)
    if (command === 'context.find') return this.runContextFindCommand(params)
    if (command === 'office.read') return this.runOfficeReadCommand(params)
    if (command === 'consent.request') return this.runConsentRequestCommand(params)
    if (command === 'danger.confirm') return this.runDangerConfirmCommand(params)
    if (command.startsWith('context.budget.')) return this.contextBudget.runContextBudgetCommand(command, params)
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

  /** 把当前会话的问答记录推给渲染端（记录新增、切会话、分叉后都要对齐） */
  private pushQuestionLog(): void {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) return
    this.push({ ch: 'question-log', payload: { sessionId, entries: questionLog.list(sessionId) } })
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
    /*
     * 选项上限 3（用户 2026-09-27 口径）：面板固定为「最多 3 个选项 +
     * 一行自行撰写」，不是界面只显示 3 个 —— 超过就当场拒绝，模型改完再提。
     * 上限与 `resources/pi-extensions/question.js` 里的提示词同一口径，
     * 那边说的是「at most 3」，这里是硬约束。
     */
    if (options.length > 3) throw new CapabilityCommandError('question_options_too_many', '问题最多提供 3 个选项')
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

    /* 缺省 3 分钟；声明值夹在 5 秒 ~ 10 分钟（口径在 shared/ui-timeout.ts） */
    const timeout = requestedTimeout(params.timeout)
    let response: HostUiResponse
    if (options.length === 0) {
      response = await this.ui.requestHostUi({
        method: 'input',
        title: '需要你的回答',
        message: question,
        timeout
      })
    } else {
      /*
       * 选项**原样**交给面板：面板底部固定有一行「或自行撰写回复」，
       * 用户在那里写的内容直接作为 `response.value` 回来。
       *
       * 以前这里会再追加一项「其他（自行输入）」，与面板自带的那行重复，
       * 而且选中它还要再弹一次输入框（两次交互换一个自定义回答）。
       */
      response = await this.ui.requestHostUi({
        method: 'select',
        title: '需要你的选择',
        message: question,
        options,
        timeout
      })
    }

    const answer = typeof response.value === 'string' && response.value.trim()
      ? response.value.trim()
      : null
    const cancelled = response.cancelled === true || (answer === null && response.confirmed !== true)
    /*
     * 记一笔并推给界面：问答只存在工具结果里，对话流上看不到用户回答了什么。
     * 这里**只回放**（不再发一次给模型，见 `question-log.ts`）。
     * 落盘失败不回退 —— `append` 只是附加信息。
     */
    const entries = questionLog.append(this.state?.sessionId, {
      question,
      options,
      answer,
      cancelled,
      at: Date.now()
    })
    if (entries) this.pushQuestionLog()
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

  /** `yan context find`：按摘录查归档引用（只读元数据，不读原始会话、不占召回预算） */
  private async runContextFindCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) {
      throw new CapabilityCommandError('context_session_unavailable', '当前还没有可查询归档的会话')
    }
    try {
      return await findArchivedContext({ sessionId, query: params.query, limit: params.limit })
    } catch (error) {
      if (error instanceof ContextRecallError) throw new CapabilityCommandError(error.code, error.message)
      throw new CapabilityCommandError('context_find_unavailable', '归档查询暂时不可用')
    }
  }

  /**
   * `yan consent request`：使用一个普通工具前先问宿主。
   * 宿主按真实答复记录决定自动放行或弹确认框；只有确认框的结果会被记下。
   * 这只是「能不能用」的判断，不替代工作模式、危险操作与远程授权的其他检查。
   */
  private async runConsentRequestCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const normalized = normalizeConsentParts(params, localDeviceId(), 'local')
    if (!normalized.ok) throw new CapabilityCommandError('consent_bad_request', normalized.error)
    const parts = normalized.parts
    const purpose = typeof params.purpose === 'string' ? params.purpose.trim().slice(0, 500) : ''
    const declaredDanger = params.dangerous === true || params.dangerous === 'true'
    const ledger = await readConsentLedger()
    const verdict = consentVerdict(ledger.entries.find((entry) => entry.key === consentKeyOf(parts)), parts, Date.now(), declaredDanger)
    const summary = (decision: 'auto' | ConsentDecision | 'no-answer') => ({
      kind: 'consent',
      capability: parts.capability,
      action: parts.action,
      resource: parts.resource,
      decision,
      allowed: decision === 'auto' || decision === 'allow',
      reason: verdict.reason
    })
    if (verdict.mode === 'auto') {
      await markConsentAuto(parts).catch(() => undefined)
      return { data: { verdict }, summary: summary('auto') }
    }
    const answer = this.confirmToolConsent ? await this.confirmToolConsent({ parts, purpose, verdict, cwd: this.cwd }) : null
    if (!answer) return { data: { verdict }, summary: summary('no-answer') }
    await recordConsentAnswer(parts, answer)
    return { data: { verdict }, summary: summary(answer) }
  }

  /**
   * `danger.confirm`：danger-guard 薄层命中高危操作后来问一次。
   * 每次都弹框，不看历史答复、不记「以后都允许」——高危操作不该被同意率放行。
   * 没有窗口 / 没有回调 / 用户关掉框都算没有确认（薄层据此拦下）。
   */
  private async runDangerConfirmCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const tool = typeof params.tool === 'string' ? params.tool.slice(0, 40) : 'tool'
    const detail = typeof params.detail === 'string' ? params.detail.slice(0, 2000) : ''
    const reasons = Array.isArray(params.reasons)
      ? params.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 200)).slice(0, 6)
      : []
    const answer = this.confirmDanger ? await this.confirmDanger({ tool, detail, reasons, cwd: this.cwd }) : null
    const decision = answer ?? 'no-answer'
    return {
      data: { decision },
      summary: { kind: 'danger-confirm', tool, decision, allowed: answer === 'allow' }
    }
  }

  /**
   * `yan office read`：读 docx / xlsx / pptx / pdf 的文字正文（与界面预览同一条提取链）。
   * 只读；路径按会话目录解析，校验规则与文件预览相同。
   */
  private async runOfficeReadCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const path = typeof params.path === 'string' ? params.path.trim() : ''
    if (!path) throw new CapabilityCommandError('office_path_required', '缺少 --path')
    const view = await previewOffice(path, this.cwd)
    if (!view.ok) throw new CapabilityCommandError('office_read_failed', view.error)
    return {
      data: { path, format: view.format, note: view.note, truncated: view.truncated, sections: view.sections },
      summary: {
        kind: 'office-read',
        format: view.format,
        sections: view.sections.length,
        lines: view.sections.reduce((n, section) => n + section.lines.length, 0),
        truncated: view.truncated
      }
    }
  }


  startHostUiTimer(id: string): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    return this.ui.startHostUiTimer(id)
  }

  extendHostUi(id: string, extraMs?: unknown): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    return this.ui.extendHostUi(id, extraMs)
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
      const mcp = await this.acquisition.collectMcpCatalog()
      const catalog = buildCatalog(commands, mcp.tools)
      return webSearchAvailability(catalog.capabilities)
    } catch {
      return { available: false }
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

  /**
   * 保存用户技能（例如把一次做成的任务整理成可复用的做法）。
   * 写到 YAN_DIR/skills/<名称>/SKILL.md；不能与随包技能重名，已存在时需 replace。
   */
  private async runSkillSave(params: Record<string, unknown>) {
    const reservedNames = this.bundledSkills.map((file) => basename(dirname(file)))
    const res = await saveUserSkill(
      {
        name: typeof params.name === 'string' ? params.name : '',
        description: typeof params.description === 'string' ? params.description : '',
        body: typeof params.body === 'string' ? params.body : '',
        replace: params.replace === true || params.replace === 'true'
      },
      { reservedNames }
    )
    if (!res.ok) throw new CapabilityCommandError(`skill_${res.code.replace(/-/g, '_')}`, res.error)
    return {
      data: { name: res.name, path: res.path, replaced: res.replaced },
      summary: {
        kind: 'skill',
        action: 'save',
        name: res.name,
        replaced: res.replaced,
        note: '已保存；新会话启动时加载，之后可用 yan skill read --id skill:' + res.name + ' 读取'
      }
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
    const result = await this.acquisition.runCapabilitiesDiscover({ queryText })
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
    return paramString(params, keys)
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
      const entries = await this.sessionEntries()
      if (!entries) return 1
      let userMsgs = 0
      for (const e of entries) {
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

    /*
     * 简单问答不建任务（实施-25 P05 / T05-2）。
     *
     * 只有 `add` / `set` 会**建**清单；`complete` / `remove` / `clear` 是维护
     * 已有清单的操作，拦它们会让用户清不掉东西。判定用宿主写下的档案快照
     * （与薄层扩展同一份）；读不到就按「不干预」放行 —— 宁可多建一份清单，
     * 也不要因为一次读盘失败把用户的任务默默吞掉。
     *
     * 拦下时不写盘、不报错，而是回一句可读说明：模型知道“没建”，就不会
     * 反复重试提交同一个清单。
     */
    if (request.action === 'add' || request.action === 'set') {
      const snapshot = this.readAgentProfileSnapshot()
      if (snapshot) {
        const itemCount = Array.isArray(params.items) ? params.items.length : 0
        const existing = await currentTaskPlan(sessionId).catch(() => null)
        const decision = decideTaskCreation({
          profile: snapshot.profile,
          activity: snapshot.activity,
          itemCount,
          /* `set` 是整份替换，不算追加；只有 `add` 往已有清单上加才放行 */
          existingItems: request.action === 'add' ? (existing?.state.todos.length ?? 0) : 0
        })
        if (!decision.create) {
          const current = await currentTaskPlan(sessionId).catch(() => null)
          return {
            data: {
              ok: true,
              skipped: true,
              reason: decision.reason,
              message: taskCreationRefusal(decision.reason),
              operationId: current?.state.operationId ?? null,
              revision: current?.state.revision ?? 0,
              todos: current?.state.todos ?? []
            },
            summary: {
              kind: 'task-plan',
              action: request.action,
              skipped: true,
              reason: decision.reason,
              items: current?.state.todos.length ?? 0
            }
          }
        }
      }
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
   * 读宿主写给这个实例的档案快照（薄层扩展读的是同一份文件）。
   *
   * 返回 `null` = 没有快照或形状不对：调用方按「不干预」处理。
   * 注意这里**不**抛错 —— 简单问答的闸门不该成为一轮对话的失败点。
   */
  private readAgentProfileSnapshot(): { profile: AgentProfileKind; activity: AgentActivity } | null {
    const key = this.capabilityOpts?.sessionId
    if (!key) return null
    try {
      const raw = JSON.parse(readFileSync(agentProfileSnapshotPath(key), 'utf8')) as Record<string, unknown>
      if (!isAgentProfileKind(raw.profile) || !isAgentActivity(raw.activity)) return null
      return { profile: raw.profile, activity: raw.activity }
    } catch {
      return null
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
          /*
           * id 必须与 `normalizeMessage` / `normalizeHistory` 用**同一口径**（`m<序号>`）。
           *
           * 以前是 `a<时间戳><随机>`，于是同一条消息在实时视图里叫 `a…`、
           * 重启 / 压缩后从会话文件读回来却叫 `m<idx>` —— 任何按消息 id 挂上去的
           * 东西全部失配。用户报的就是这个：`yan artifact attach` 的图（以及
           * 工具产物）在**自动压缩之后集体消失** —— `artifacts.json` 里记的是
           * `a…`，而 hydrate 重建出来的消息是 `m…`（实测用户本机 11 条记录全是
           * `a…`）。
           *
           * 同一个坑以前在回合计时锚点 `anchorId` 上踩过一次，见 normalize.ts 里
           * `normalizeHistory` 那段注释。
           *
           * 同一轮的多次 `message_start`（一条消息分多个 block）会拿到同一个
           * id —— 这是对的，它们本来就是同一条消息。
           */
          const id = `m${this.messages.length}`
          this.streaming = {
            id,
            text: '',
            thinking: '',
            responseDetail: this.turn.responseDetail,
            tools: [],
            startedAt: Date.now(),
            // 增量游标从 0 开始（渲染端拿到的 msg-add 里 text 也是空）
            pushedText: 0,
            pushedThinking: 0
          }
          this.push({
            ch: 'msg-add',
            payload: { id, role: 'assistant', text: '', responseDetail: this.turn.responseDetail, timestamp: Date.now() }
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
          this.turn.outputTokens = Math.max(this.turn.outputTokens ?? 0, finalUsage.output)
        }
        const sp = this.speedOf({ ...s, usage: finalUsage }, Date.now(), this.turn.startedAt)
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
        this.turn.messageIds.push(id)
        if (this.turn.startedMono !== undefined) {
          this.turn.elapsedMs = Math.max(1, Math.round(performance.now() - this.turn.startedMono))
        } else if (sp.elapsedMs !== undefined) {
          this.turn.elapsedMs = sp.elapsedMs
        }
        /* 推送值用单调口径覆盖：墙钟被调整时不至于让用时变负数或凭空变长。 */
        if (this.turn.elapsedMs !== undefined) msg.elapsedMs = this.turn.elapsedMs
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
          this.turn.terminal = 'failed'
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
        this.turn.responseDetail = this.currentResponseDetail()
        this.turn.startedAt = Date.now()
        this.turn.startedMono = performance.now()
        this.turn.messageIds = []
        this.turn.terminal = 'completed'
        this.turn.elapsedMs = undefined
        this.turn.persisted = false
        /* 每个 pi 回合一个 run id（H-6b）：自动继续会开新 run、归同一个逻辑回合。 */
        this.turn.runSeq += 1
        this.turn.runId = `run-${this.turn.runSeq}-${Date.now().toString(36)}`
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled':
        this.markStreaming(false)
        this.setAgentRunning(false)
        this.turn.startedAt = undefined
        this.turn.startedMono = undefined
        void this.contextBudget.settleContextBudgetTurn()
        /* 回合结束才写元数据日志：中途写会得到一堆半截记录（H-6）。 */
        void this.persistTurnTiming()
        void this.refreshState()
        /* 回合结束是唯一允许按工作集动手的时机（这次刷新顺带做判定） */
        void this.refreshStats({ allowPolicyTrigger: true })
        // 兑底：扩展也可能通过 /panel task 命令改任务（不经过工具调用）
        void this.refreshTodos()
        // 用户每说一句都重算标题（用户要求每次都是新生成的）；
        // 自动续跑、重试这类没有新用户消息的回合不重算 —— 标题样本没变，只会白花一次调用
        void this.maybeGenerateTitle({ force: true, onlyIfSamplesChanged: true })
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

    const sp = this.speedOf(s, Date.now(), this.turn.startedAt)
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
    await this.turn.persist(final, this.state?.sessionFile, this.messages)
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

  /** 当前还没答复的问题（远程端列出用；不含通知类请求） */
  pendingUiRequests(): ExtensionUiRequest[] {
    return this.ui.pendingUiRequests()
  }

  /** 从手机回答一个问题（敏感确认只能在电脑上答） */
  answerUiRemotely(
    id: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): { ok: true } | { ok: false; code: 'question_not_pending' | 'sensitive_confirmation_requires_desktop' } {
    return this.ui.answerUiRemotely(id, answer)
  }

  /** 回答一个问题（渲染端经 IPC 调用；手机端经 answerUiRemotely）。 */
  respondUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): void {
    this.ui.respondUi(res, by)
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

  /** Start one host-authorized, session-bound V1 maintenance transaction while idle. */
  async requestContextMaintenanceV1(retryOperationId?: string): Promise<{
    ok: boolean
    operationId?: string
    state?: 'committed' | 'applied' | 'needs_action'
    error?: string
  }> {
    const sessionId = this.state?.sessionId
    const sessionFile = this.state?.sessionFile
    if (!isSafeSessionId(sessionId) || !sessionFile || !this.rpc?.running) {
      return { ok: false, error: '当前没有可整理的活动会话' }
    }
    if (this.agentRunning || this.state?.isStreaming || this.state?.isCompacting) {
      return { ok: false, error: '当前会话仍在运行；等本轮结束后再整理' }
    }
    const hold = await this.automaticMaintenanceHold()
    if (hold === 'blocked') {
      return { ok: false, error: '上下文整理没有完成。请在设置 → 上下文中选择「重试整理 / 临时抬软线 / 降档」，然后再继续；草稿仍保留' }
    }
    if (hold === 'running') {
      return { ok: false, error: '当前有自动整理或续接操作；请等它完成，或在会话中明确停止后再操作' }
    }
    if (this.contextMaintenanceInProgress) return { ok: false, error: '已有上下文整理操作正在运行' }
    this.contextMaintenanceInProgress = true
    try {
      if (!(await contextBudgetStoreV1.isConfigured(sessionId))) {
        return { ok: false, error: '当前会话仍使用 legacy 策略；先在上下文设置中启用 V1' }
      }
      const policy = await contextBudgetStoreV1.read(sessionId)
      const index = await readSessionEntryIndex(sessionFile)
      if (!index || index.sessionId !== sessionId || index.incompleteTail || index.unreadableEntries > 0) {
        return { ok: false, error: '会话原始记录不完整；未启动整理，原始记录已保留' }
      }
      const model = this.state?.model
      if (!model?.provider || !model.id || !model.endpointKey) {
        return { ok: false, error: '当前模型端点信息不完整；未启动整理' }
      }
      const registered = await this.rawCommands()
      if (!registered.some((command) => String(command.name ?? '').replace(/^\/+/, '') === 'yan-context-maintain')) {
        return { ok: false, error: '当前 pi runner 未确认加载整理命令；未发送控制消息' }
      }
      const watermark = index.watermark
      const sourceRevision = `messages:${index.contextMessageWatermark.entryCount}:${index.contextMessageWatermark.lastEntryId ?? 'empty'}`
      const runnerId = this.capabilityOpts?.sessionId ?? 'primary'
      const runnerEpoch = String(this.capabilityOpts?.runnerGeneration ?? 1)
      const capabilityRevision = [model.endpointKey, model.contextWindow, model.maxTokens]
        .map((part) => String(part ?? '')).join('/')
      let operationId = retryOperationId
      if (retryOperationId !== undefined) {
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(retryOperationId)) {
          return { ok: false, error: '整理操作身份无效' }
        }
        const prior = await contextBudgetStoreV1.readOperation(sessionId, retryOperationId)
        if (!prior || (prior.state !== 'needs_action' && prior.state !== 'failed')) {
          return { ok: false, error: '该整理操作当前不可重试；请刷新状态' }
        }
        if (prior.failureCode === 'resume_send_uncertain') {
          return { ok: false, error: '续接消息发送状态不明；为避免重复执行，请先检查会话记录后再继续' }
        }
        if (
          prior.identity.runnerId !== runnerId ||
          prior.base.sourceRevision !== sourceRevision || prior.base.policyRevision !== policy.revision ||
          prior.base.capabilityRevision !== capabilityRevision
        ) return { ok: false, error: '会话、策略、原始记录或模型已变化；旧候选不能重试，请刷新并按当前状态重新整理' }
        if (prior.resumeReceipt === null) {
          try {
            await contextBudgetStoreV1.recoverAndCommitCandidate(
              sessionId,
              retryOperationId,
              prior.revision,
              {
                rawWatermark: { entryCount: watermark.entryCount, lastEntryId: watermark.lastEntryId },
                sourceRevision,
                policyRevision: policy.revision,
                capabilityRevision
              },
              runnerId,
              runnerEpoch,
              index.entryIds
            )
            const recovered = await contextBudgetStoreV1.readOperation(sessionId, retryOperationId)
            if (recovered?.state === 'committed' || recovered?.state === 'applied') {
              if (recovered.requestKind === 'automatic') {
                const commands = await this.rawCommands()
                if (commands.some((command) => String(command.name ?? '').replace(/^\/+/, '') === 'yan-context-resume')) {
                  const resume = await this.rpc.command('prompt', { message: `/yan-context-resume ${retryOperationId}` })
                  if (!resume.success) {
                    return { ok: false, operationId: retryOperationId, state: recovered.state, error: resume.error ?? '续接命令未能排队' }
                  }
                }
              }
              return { ok: true, operationId: retryOperationId, state: recovered.state }
            }
          } catch {
            /* A stale candidate can still be explicitly regenerated below after the same base checks. */
          }
        }
        await contextBudgetStoreV1.transitionOperation(sessionId, retryOperationId, prior.revision, 'preparing', {
          requestKind: prior.requestKind === 'automatic' ? 'automatic' : 'user_retry',
          identity: { ...prior.identity, runnerEpoch },
          base: {
            ...prior.base,
            rawWatermark: { entryCount: watermark.entryCount, lastEntryId: watermark.lastEntryId }
          },
          reason: '用户明确重试上下文整理',
          retryNonce: randomUUID(),
          candidateRef: null,
          failureCode: null,
          resumeId: null,
          resumeReceipt: null,
          projectionReceipt: null
        })
      } else {
        const previous = await contextBudgetStoreV1.latestOperation(sessionId)
        const waitingForProjection = previous?.state === 'committed' &&
          (previous.requestKind !== 'automatic' || previous.resumeReceipt === null || previous.resumeReceipt.startsWith('intent:'))
        const waitingForAutoResume = previous?.state === 'applied' && previous.requestKind === 'automatic' &&
          (previous.resumeReceipt === null || previous.resumeReceipt.startsWith('intent:'))
        if (previous && (
          ['requested', 'preparing', 'summarizing', 'validating'].includes(previous.state) ||
          waitingForProjection || waitingForAutoResume
        )) {
          return { ok: false, error: '已有整理操作正在等待完成或应用；请先刷新状态' }
        }
        if (previous && (previous.state === 'needs_action' || previous.state === 'failed') && previous.base.sourceRevision === sourceRevision) {
          return { ok: false, error: '当前整理操作需要处理；请使用该操作的重试入口' }
        }
        operationId = `context-${randomUUID()}`
        const now = Date.now()
        const operation: ContextMaintenanceOperationV1 = {
          version: 1,
          revision: randomUUID(),
          identity: { sessionId, runnerId, runnerEpoch, operationId },
          base: {
            rawWatermark: { entryCount: watermark.entryCount, lastEntryId: watermark.lastEntryId },
            sourceRevision,
            policyRevision: policy.revision,
            capabilityRevision
          },
          requestKind: 'manual',
          reason: '用户从上下文设置请求整理',
          protectedRefs: [],
          candidateRef: null,
          beforeSnapshot: null,
          afterSnapshot: null,
          resumeId: null,
          resumeReceipt: null,
          projectionReceipt: null,
          lastSummarizedSourceRevision: null,
          retryNonce: null,
          state: 'requested',
          failureCode: null,
          createdAt: now,
          updatedAt: now
        }
        await contextBudgetStoreV1.createOperation(operation)
      }
      if (!operationId) return { ok: false, error: '整理操作没有生成身份' }
      const result = await this.rpc.command('prompt', { message: `/yan-context-maintain ${operationId}` })
      let latest = await contextBudgetStoreV1.readOperation(sessionId, operationId)
      if (latest?.state === 'validating' && latest.candidateRef) {
        const match = /^projections\/([A-Za-z0-9._-]{1,120})\.json$/.exec(latest.candidateRef)
        try {
          if (!match) throw new Error('整理候选路径无效；原始记录已保留')
          const candidate = await contextBudgetStoreV1.readProjectionCandidate(sessionId, match[1])
          if (!candidate) throw new Error('整理候选文件不存在；原始记录已保留')
          const currentPolicy = await contextBudgetStoreV1.read(sessionId)
          const currentIndex = await readSessionEntryIndex(sessionFile)
          const currentModel = this.state?.model
          const currentCapabilityRevision = currentModel?.endpointKey
            ? [currentModel.endpointKey, currentModel.contextWindow, currentModel.maxTokens].map((part) => String(part ?? '')).join('/')
            : ''
          if (
            this.state?.sessionId !== sessionId || currentPolicy.revision !== latest.base.policyRevision ||
            !currentIndex || currentIndex.sessionId !== sessionId || currentIndex.incompleteTail || currentIndex.unreadableEntries > 0 ||
            currentIndex.watermark.entryCount !== latest.base.rawWatermark.entryCount ||
            currentIndex.watermark.lastEntryId !== latest.base.rawWatermark.lastEntryId ||
            `messages:${currentIndex.contextMessageWatermark.entryCount}:${currentIndex.contextMessageWatermark.lastEntryId ?? 'empty'}` !== latest.base.sourceRevision ||
            currentCapabilityRevision !== latest.base.capabilityRevision
          ) throw new Error('整理期间会话、策略、原始记录或模型端点发生变化；候选未提交')
          await contextBudgetStoreV1.commitProjection(sessionId, operationId, latest.revision, candidate)
          latest = await contextBudgetStoreV1.readOperation(sessionId, operationId)
        } catch (error) {
          const current = await contextBudgetStoreV1.readOperation(sessionId, operationId)
          if (current?.state === 'validating') {
            await contextBudgetStoreV1.transitionOperation(
              sessionId, operationId, current.revision, 'needs_action', { failureCode: 'projection_commit_failed' }
            ).catch(() => undefined)
          }
          return {
            ok: false,
            operationId,
            state: 'needs_action',
            error: error instanceof Error ? error.message : '整理候选未能提交；原始记录已保留'
          }
        }
      }
      if (latest?.state === 'committed' || latest?.state === 'applied') {
        return { ok: true, operationId, state: latest.state }
      }
      if (!result.success) {
        if (latest?.state === 'requested' || latest?.state === 'preparing') {
          await contextBudgetStoreV1.transitionOperation(
            sessionId, operationId, latest.revision, 'needs_action', { failureCode: 'maintenance_command_failed' }
          ).catch(() => undefined)
        }
        return { ok: false, operationId, state: 'needs_action', error: result.error ?? '整理命令未完成' }
      }
      if (latest?.state === 'requested' || latest?.state === 'preparing') {
        await contextBudgetStoreV1.transitionOperation(
          sessionId, operationId, latest.revision, 'needs_action', { failureCode: 'maintenance_command_not_run' }
        ).catch(() => undefined)
      }
      return {
        ok: false,
        operationId,
        state: 'needs_action',
        error: latest?.failureCode ?? '整理操作尚未提交；原始记录未改动'
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '上下文整理失败；原始记录已保留' }
    } finally {
      this.contextMaintenanceInProgress = false
    }
  }

  /** Cancel outstanding context work before an explicit stop or endpoint change. */
  async cancelContextMaintenanceV1(reason: string): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) return
    try {
      const operation = await contextBudgetStoreV1.latestOperation(sessionId)
      if (!operation) return
      const working = ['requested', 'preparing', 'summarizing', 'validating'].includes(operation.state)
      const pendingAutoResume = operation.requestKind === 'automatic' &&
        ['committed', 'applied'].includes(operation.state) &&
        (operation.resumeReceipt === null || operation.resumeReceipt.startsWith('intent:'))
      if (!working && !pendingAutoResume) return
      if (pendingAutoResume) {
        /* 已提交的整理照常生效，只是不再自动续跑；把它标成 cancelled 会让投影失效、下一轮又撞线 */
        await contextBudgetStoreV1.transitionOperation(
          sessionId, operation.identity.operationId, operation.revision, operation.state,
          { resumeReceipt: `skipped:${String(reason).slice(0, 120)}` }
        )
        return
      }
      await contextBudgetStoreV1.transitionOperation(
        sessionId, operation.identity.operationId, operation.revision, 'cancelled',
        { failureCode: String(reason).slice(0, 160) }
      )
    } catch {
      /* Stale operation revisions fail closed in the extension before commit. */
    }
  }

  /**
   * 自动整理当前是否挡着新消息。
   *
   * 两种挡法要分开（用户能做的下一步不同）：
   *   · `running` —— 整理正在进行，等它完成即可；
   *   · `blocked` —— 整理失败停在待处理；用户必须从设置里的三个出口选一个
   *     （重试整理 / 临时抬软线 / 降档），出口会把这笔操作标成已取代。
   *
   * 读不到状态时**不挡**：真正防止超预算的是请求前的预算门禁，它不受这里影响；
   * 本地 IO 读不出来就让用户停手，代价比多发一次被挡下的请求大。
   */
  private async automaticMaintenanceHold(): Promise<'running' | 'blocked' | null> {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) return null
    try {
      const operation = await contextBudgetStoreV1.latestOperation(sessionId)
      if (!operation || operation.requestKind !== 'automatic') return null
      if (['requested', 'preparing', 'summarizing', 'validating'].includes(operation.state)) return 'running'
      if (operation.state === 'needs_action') return 'blocked'
      if (['committed', 'applied'].includes(operation.state) && operation.resumeReceipt?.startsWith('intent:') === true) return 'running'
      return null
    } catch {
      return null
    }
  }

  async send(
    text: string,
    images?: { data: string; mimeType: string }[],
    /**
     * 生成中投递时的行为：`steer` = 插话（当前这轮就看到）、
     * `followUp` = 排队（等这轮跑完再投）。
     *
     * 不传时按排队处理：运行中发送的普通消息默认排队（压缩维护期间才悬在
     * 输入框上方待定）。这也防止别的调用路径漏传时 pi 直接报
     * 「Specify streamingBehavior」。
     */
    mode?: 'steer' | 'followUp'
  ): Promise<{ ok: boolean; error?: string }> {
    const hold = await this.automaticMaintenanceHold()
    if (hold === 'blocked') {
      return { ok: false, error: '上下文整理没有完成。请在设置 → 上下文中选择「重试整理 / 临时抬软线 / 降档」，然后再继续；草稿仍保留' }
    }
    if (hold === 'running') return { ok: false, error: '上下文正在自动整理；完成前暂不接收新消息，草稿仍保留' }
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前暂不接收新消息；草稿仍保留' }
    const payload: Record<string, unknown> = { message: text }
    if (images?.length) {
      payload.images = images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
    }
    // 智能体正在处理时必须指定投递行为，否则 pi 直接报错。
    // 具体用哪个由**渲染端**通过 `mode` 决定；不传时默认 followUp（排队），
    // 需要打断当前这一轮时由队列行的「插队」把它提升为 steer。
    // 无论如何都要带上，否则 pi 会抛
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
    //    压缩期间渲染端会先把消息悬到待定区，结束后再投递；这里是漏网时的兜底。
    if (this.agentRunning || this.state?.isStreaming || this.state?.isCompacting) {
      payload.streamingBehavior = mode ?? 'followUp'
    }

    await this.prepareKnowledge(text)
    const res = await this.rpc!.command('prompt', payload)
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async steer(text: string): Promise<{ ok: boolean; error?: string }> {
    const hold = await this.automaticMaintenanceHold()
    if (hold === 'blocked') {
      return { ok: false, error: '上下文整理没有完成。请在设置 → 上下文中选择「重试整理 / 临时抬软线 / 降档」，然后再继续；草稿仍保留' }
    }
    if (hold === 'running') return { ok: false, error: '上下文正在自动整理；完成前暂不接收插话，草稿仍保留' }
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前暂不接收插话；草稿仍保留' }
    await this.prepareKnowledge(text)
    const res = await this.rpc!.command('steer', { message: text })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async followUp(text: string): Promise<{ ok: boolean; error?: string }> {
    const hold = await this.automaticMaintenanceHold()
    if (hold === 'blocked') {
      return { ok: false, error: '上下文整理没有完成。请在设置 → 上下文中选择「重试整理 / 临时抬软线 / 降档」，然后再继续；草稿仍保留' }
    }
    if (hold === 'running') return { ok: false, error: '上下文正在自动整理；完成前暂不接收排队消息，草稿仍保留' }
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前暂不接收排队消息；草稿仍保留' }
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
    await this.cancelContextMaintenanceV1('user_stopped')
    /* 用户主动停止：用时冻结在当下，并标明这不是正常完成（H-6）。 */
    this.turn.terminal = 'stopped'
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
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前不能创建新会话' }
    await this.cancelContextMaintenanceV1('session_changed')
    this.suppressPush = true
    try {
      const res = await this.rpc!.command('new_session')
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.ui.seen.clear()
      this.ui.pending.clear()
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
      return this.initializeContextBudgetV1Default()
    } finally {
      this.suppressPush = false
    }
  }

  /** Persist V1 defaults only for sessions the host has just created. */
  async initializeContextBudgetV1Default(): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) {
      return { ok: false, error: '新会话身份不可核实，未启用上下文预算 V1' }
    }
    /*
     * 显式旧覆盖（env / 用户 / 供应商 / 模型级的数值或开关）保留 legacy：
     * V1 会取消未经整理事务的原生压缩，默认迁过去会让旧阈值、
     * 按压缩次数的自动交接这些用户明确配置过的行为静默失效。
     */
    if (hasExplicitLegacyOverride(this.effectivePolicy().resolved)) return { ok: true }
    try {
      await contextBudgetStoreV1.ensureDefault(sessionId)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: `新会话上下文策略未能保存：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前不能切换会话' }
    await this.cancelContextMaintenanceV1('session_changed')
    this.suppressPush = true
    try {
      const res = await this.rpc!.command('switch_session', { sessionPath: path })
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.ui.seen.clear()
      this.ui.pending.clear()
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
    this.ui.seen.clear()
    this.ui.pending.clear()
    await this.hydrate()
    return { ok: true, text: res.data?.text }
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command<{ cancelled?: boolean }>('clone')
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '复制被扩展取消' }
    this.ui.seen.clear()
    this.ui.pending.clear()
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
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前不能切换模型' }
    await this.cancelContextMaintenanceV1('model_changed')
    return this.enqueueCapabilityChange(() => this.applyModel(provider, modelId))
  }

  async setThinking(level: string): Promise<{ ok: boolean; error?: string }> {
    if (this.contextMaintenanceInProgress) return { ok: false, error: '上下文整理完成前不能切换思考档位' }
    await this.cancelContextMaintenanceV1('thinking_level_changed')
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
    opts: { force?: boolean; candidate?: boolean; lockHeld?: boolean; onlyIfSamplesChanged?: boolean } = {}
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
    const samplesKey = samples.join('\n')
    if (opts.onlyIfSamplesChanged && this.titledSamples.get(st.sessionId) === samplesKey) return null

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
      this.titledSamples.set(sessionId, samplesKey)
      if (this.titledSamples.size > 200) this.titledSamples.clear()

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
    return this.ui.pending.size
  }

  /** 宿主改了 MCP 配置（如开关电脑操作）：关掉现有连接，下次用到时按新配置重建 */
  async reloadMcpServers(): Promise<void> {
    const old = this.mcpManager
    this.mcpManager = undefined
    await old?.close().catch(() => undefined)
  }

  async stop(): Promise<void> {
    await this.cancelContextMaintenanceV1('runner_stopped')
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
    this.ui.rejectPendingHostUi('会话已关闭，问题请求已取消')
    this.ui.pending.clear()
    await this.rpc?.close()
    this.rpc = null
    this.messages = []
    this.resetQueue()
  }
}

export type { BashRun, ForkPoint, SlashCommand }
