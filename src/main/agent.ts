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
import { getSettings } from './settings'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { saveUserSkill, userSkillsDir } from './user-skills'
import { acquiredUserSkillNames, listSessionSkills, promoteSessionSkill, removeSessionSkill } from './capabilities/acquired-skills'
import { PiRpc, resolvePi } from './protocol'
import { assistantModelIdentity } from '../shared/assistant-model'
import { NativeSessionRuntime, type NavigateTreeResult, type ScopedModelsSnapshot, type ProjectTrustSnapshot } from './native-session-runtime'
import { nativeActiveBranch } from './native-session-history'
import { allowTrust, revokeTrust } from './project-trust'
import { workspaceMutationInProgress } from './workspace-mutation'
import type { ExecuteAdmissionPort } from './session-send-guard'
import { modelErrorNotice, modelErrorText } from '../shared/model-errors'
import { isQuotaWaitError } from '../shared/quota-resume'
import { isSubagentNotice } from '../shared/subagent-notice'
import { AGENT_CONTEXT_ERROR, agentOwnedPiArgs, nativePiToolsSupported } from '../shared/agent-context'
import type { CapabilityCommandResult, CapabilityHandlers, YanCliEnv } from './capability-server'
import { CapabilityCommandError, CapabilityServer } from './capability-server'
import { saveContextInspect } from './context-inspect'
import { ContextRecallError,findArchivedContext, recallArchivedContext } from './context-recall'
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
  assistantError,
  normalizeHistory,
  normalizeMessage,
  imagesOf,
  toUsage,
  type PiContentBlock,
  type PiMessage
} from './normalize'
import { SESSIONS_DIR, SESSIONS_DIR_IS_OVERRIDE } from './sessions'
import { consumeQueuedItem, reconcileQueueItems, sameQueueImages, snapshotQueue } from './queue-items'
import { applyQueueRewrite, type QueueRewriteResult } from './queue-edit'
import { clearStaleRunning, EMPTY_COMPACTION_STATE, projectTrustedFrom, reduceCompaction, type CompactionState } from './compaction'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { projectPackageDirs } from './packages'
import { generationTiming, turnTiming } from '../shared/turn-timing'
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

import { questionLog } from './question-log'
import { parseQuestionAnswers, parseQuestionFields, QuestionFormError, summarizeAnswers, type QuestionField } from '../shared/question-form'

import { requestedTimeout } from '../shared/ui-timeout'
import { createStreamLoopDetector, type LoopHit, type StreamLoopDetector } from '../shared/stream-loop-detector'
import { buildCatalog } from './capabilities/catalog'
import { webSearchAvailability, type WebSearchAvailability } from '../shared/web-search'
import { readSkillById, skillsFromCommands, type RawSkillCommand } from './capabilities/skill-service'
import { CapabilityAcquisition } from './capabilities/acquisition-commands'

import { BrowserCommands } from './browser-commands'
import { LookupCommands } from './lookup-commands'
import { TurnTimingTracker } from './turn-timing-tracker'
import { UiRequests, type HostUiResponse } from './ui-requests'
import { runSignalFromUiRequest, runSignalFromUiResolved, signalFromQueueUpdate, signalsFromPiEvent } from './runs/pi-events'
import type { RunModel, RunSignal } from '../shared/runs'
import { paramString } from './command-params'
import { activeSkillArgs } from './capabilities/skill-files'
import { McpConnectionManager } from './mcp/connection-manager'
import { loadMcpServers, mcpServersForProject } from './mcp/config'
import {
  captureNativeStartupWitness,
  newBootId,
  verifyNativeStartupWitness,
  type McpNativeBootWitness,
  type McpNativeConfigReader
} from './mcp/app-native-witness'
import { assertLegacyMcpAccessBlocked, runMcpAppProxyCommand } from './mcp/app-proxy-service'
import { mcpAppHost } from './mcp/app-host'
import { isInkstoneManaged } from './mcp/app-spec'
import {
  disconnectManagedServer,
  managedRuntimeFacts,
  reconcileLegacyManaged,
  verifyManagedServer,
  SettingsSafeAccessError,
  type LegacyReconcileResult,
  type SettingsSafeAccess
} from './mcp/settings-safe-access'
import { callMcpTool, describeMcpTool, McpToolError } from './mcp/tool-service'
import type { McpServerStatus } from '../shared/mcp'
import type { CapabilityMcpServerSettingView } from '../shared/ipc'
import { migratedMcpCommandNotice } from '../shared/mcp-native-import'
import { taskPlanLogEntry, type TaskAction, type TaskPlanRequest } from '../shared/task-plan'
import { titleSampleImages, titleSamples } from '../shared/title-samples'
import { beginTreeSnapshot, endTreeSnapshot, isShellTool, isWriteTool, snapshotAfter, snapshotBefore, writePathOf } from './snapshots'
import { ArtifactStore } from './artifacts'
import { hasBash } from './git-runtime'
import { comfyStatus, ComfyLaunchError, ensureComfyRunning, stopManagedComfy } from './comfy-launcher'
import { defaultImageModel, detectImageProviders, generateImage, imageProviderEndpoint, imageProviderNeedsConfirmation, isImageProvider, resolveImageProvider, waitForImage, type ImageGenerationRequest } from './image-generation'
import {
  capabilitySnapshot,
  modelKeyOf,
  normalizeModelInfo,
  normalizeThinkingLevels,
  resolveThinkingLevels
} from '../shared/model-capabilities'
import { attachModelPrice } from './models/price'
import type {
  BashRun,
  BrowserObservation,
  BrowserNetworkSnapshot,
  BrowserState,
  CustomEntry,
  ExtensionUiRequest,
  ForkPoint,
  GenerationTiming,
  MainPush,
  AssistantArtifact,
  ImageGenerationProgress,
  ModelInfo,
  QueueItem,
  QueueSnapshot,
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
import { captureMoveContinuation, type SessionMoveAnswer, type SessionMovePrompt } from './session-move'
import type { ScheduleService } from './schedule-service'
import { runScheduleCommand, ScheduleCommandError } from './schedule-commands'

/** 流式文本的推送节流：60 帧够了，再多是给 IPC 白干活 */
const FLUSH_MS = 16
/**
 * 节流间隔的上限。
 *
 * 独立bash输出按累积长度降频。模型正文已经只传增量，不应因为
 * 之前的回答变长就把后续新字压成120ms一批。
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

/**
 * 旁路给运行注册表的压缩上下文（v3 WP-10）。
 *
 * 只带注册表需要的事实，不含消息 / 工具原始输出；由 AgentController 在
 * **事件到达时**按当时的会话状态构造，所以旧会话的迟到事件不会套用新会话身份。
 */
export interface RunObserverContext {
  sessionId: string
  sessionPath?: string
  title?: string
  model?: RunModel
}

/**
 * 只读旁路：把 pi / 宿主事件压缩成 run signals 交给宿主。
 *
 * 它**不**参与 pi 循环、不改消息投影、不影响原有 push 与授权流程 ——
 * 只是把同一批事实另外归约一份给运行注册表。
 */
export type RunObserver = (ctx: RunObserverContext, signal: RunSignal) => void

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
  setAutomationOwner?(owner?: string): void
  getOwnedDownload?(owner: string): BrowserState['lastDownload']
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
  model?: string
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
  provider: 'openai' | 'compatible' | 'google' | 'doubao' | 'local'
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
  /** `permission` = 询问档下的写入确认（permission-guard 发起）；缺省是高危确认 */
  kind?: 'permission' | 'delete'
  /** 越界写入涉及的目录（来自 danger-guard）；有值时确认框可「允许并记住」 */
  outsideDirs?: string[]
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
    image_cancelled: '已停止生图',
    image_provider_unavailable: '没有可用的图像模型',
    image_provider_unknown: '不认识的图像服务',
    image_result_empty: '图像服务返回了空文件',
    artifact_empty: '生成结果为空文件',
    codex_auth_missing: 'ChatGPT 登录不可用或已过期，请在设置里重新登录',
    codex_auth_rejected: 'ChatGPT 登录被拒绝，请在设置里重新登录',
    codex_rate_limited: 'ChatGPT 额度已用尽或请求过于频繁',
    codex_image_result_missing: '图像服务没有返回图片数据',
    codex_response_failed: 'ChatGPT 生图失败',
    image_api_result_missing: '图像 API 没有返回图片数据',
    image_api_auth_rejected: '图像 API 拒绝了凭证',
    image_api_rate_limited: '图像 API 额度不足或请求过于频繁',
    google_api_key_missing: '没有配置 Google Gemini API key',
    google_auth_rejected: 'Google Gemini 拒绝了 API key',
    google_rate_limited: 'Google Gemini 额度不足或请求过于频繁',
    google_image_blocked: 'Google Gemini 拦截了这次生成',
    google_image_result_missing: 'Google Gemini 没有返回图片',
    doubao_api_key_missing: '没有配置火山方舟（豆包）API key',
    doubao_auth_rejected: '火山方舟拒绝了 API key（或未开通该模型）',
    doubao_rate_limited: '火山方舟额度不足或请求过于频繁',
    doubao_image_result_missing: '火山方舟没有返回图片',
    local_service_missing: '本机没有可用的生图服务',
    local_launch_unavailable: '没有能自动启动的本机 ComfyUI',
    local_launch_failed: '本机 ComfyUI 启动失败',
    local_launch_timeout: '本机 ComfyUI 启动超时',
    local_workflow_missing: 'ComfyUI 里没有可用的已保存工作流',
    local_workflow_unsupported: 'ComfyUI 工作流无法自动套用',
    local_upload_failed: '参考图上传到 ComfyUI 失败',
    local_workflow_failed: '本机 ComfyUI 工作流执行失败',
    local_timeout: '本机生图超时',
    image_source_outside_project: '参考图必须在当前项目或砚的产物目录内',
    image_source_missing: '找不到参考图',
    image_source_unsupported: '参考图只支持 PNG / JPEG / WebP',
    image_source_too_large: '参考图超过 20 MB',
    image_source_too_many: '参考图最多 4 张'
  }
  const reason = error && typeof error === 'object' && 'reason' in error && typeof (error as { reason?: unknown }).reason === 'string'
    ? (error as { reason: string }).reason
    : ''
  const label = labels[code] ?? (/_http_\d+$/.test(code) ? `图像服务返回 HTTP ${code.replace(/^.*_http_/, '')}` : `生成失败：${code}`)
  return reason ? `${label}：${reason}` : label
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
  /** 同步执行入场（同 cwd claim/token）；宿主未注入时（纯测试 / 旧调用）不发 claim。 */
  execution?: ExecuteAdmissionPort
  /** 直执行 bash 收尾后给受管能力调度器一个安全边界机会。 */
  onBashSettled?: () => void
  /** 移到系统回收站（宿主注入 Electron `shell.trashItem`）。 */
  trashItem?: (path: string) => Promise<void>
}

/**
 * 项目 `.pi/settings.json` 里登记的 pi 包 → 显式 `--extension` 参数。
 *
 * 仅旧版 runner 使用：`--no-extensions` 关闭项目包发现，需显式补入。
 * 原生 pi 自己处理项目包与禁用设置，不能用显式路径绕过其设置。
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

/**
 * ack 早于 `agent_start` 时，执行入场 claim 的宽限窗口。
 * 回合真的启动后由 `setAgentRunning(false)` / `stop()` 释放；一直没启动则到期释放，
 * 不会因为一次异常发送永久锁住同 cwd。
 */
const EXECUTION_ADMISSION_GRACE_MS = 10_000

export class AgentController extends EventEmitter {
  private rpc: PiRpc | null = null
  private nativeRuntime: NativeSessionRuntime | null = null
  private nativeBranchView = false
  private nativeSessionExtension?: string
  private push: Push
  private cwd: string
  private piBin?: string
  private codemodeExtension?: string
  private questionExtension?: string
  /** 工作模式的工具策略执行（实施-05 S3）：计划档收紧工具表 + 兜底阻断。 */
  private workModeExtension?: string
  private shellFallbackExtension?: string
  /** 活动档案（实施-25 P01）：按会话注角色与受限工具。 */
  private agentProfileExtension?: string
  private responseDetailExtension?: string
  /**
   * 保留pi原生规则，补充砚身份与简短进展说明约定。
   */
  private preambleExtension?: string
  /** 界面语言扩展（每轮注入一句语言要求，见 resources/pi-extensions/language.js） */
  private languageExtension?: string
  /** 采样温度扩展（每次请求读设置，见 resources/pi-extensions/temperature.js） */
  private temperatureExtension?: string
  /** 能力入口说明扩展（每轮静态追加，不随设置变化）。 */
  private capabilityGuideExtension?: string
  /** 托管 MCP 工具的模型代理薄层路径（读快照注册 mcp__ 工具，执行打回宿主端点）。 */
  private mcpAppProxyExtension?: string
  /** 工具快照文件路径；缺省表示没有可用缓存，代理薄层不注册任何托管工具。 */
  private mcpAppToolsSnapshot?: string
  /** 读 pi 原生 MCP 配置文本（A7 启动见证）；缺省 fs。 */
  private nativeConfigReader?: McpNativeConfigReader
  /** 上下文构成观测薄层（只读上报系统提示分段与工具定义）。 */
  private contextInspectExtension?: string
  /** 旧工具输出裁剪与自动压缩上限（只改发给模型的视图，压缩走 pi 原生 compact）。 */
  private contextTrimExtension?: string
  /**
   * 单轮重复动作兜底（2026-09-22）：`tool_call` 看参数、连续相同就提醒或拦下。
   * 被拦下的计数由宿主在回合收尾时计入目标失败签名（`shared/repeat-guard.ts`）。
   */
  private repeatGuardExtension?: string
  /** 随包技能（resources/skills/<名称>/SKILL.md）：显式 --skill 传入，不开启自动发现 */
  private bundledSkills: string[] = []
  /** 用户技能（YAN_DIR/skills）：每次启动时重新列出，新保存的技能在下一次启动生效。 */
  private userSkills?: () => Promise<string[]>
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
  private scheduleHost?: ScheduleService
  private hubHost?: SubagentCommandHost
  /** `yan goal …` 的宿主实现（实施-05 S3）；同样不是 pi 工具。 */
  private goalHost?: GoalCommandHost
  /** 资料引用：按版本读片段与引用状态。 */
  private researchHost?: GoalCommandHost
  /** CLI 只能请求授权；最终选择由主进程的可见确认 UI 返回。 */
  private confirmCapabilityAuthorization?: (
    request: CapabilityAuthorizationPrompt
  ) => Promise<CapabilityAuthorizationChoice>
  private readonly imageRequests = new Set<AbortController>()
  private confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
  private confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentDecision | null>
  private confirmDanger?: (request: DangerConfirmPrompt) => Promise<ConsentDecision | null>
  private getPermissionMode?: () => Promise<'danger' | 'all'>
  private requestSessionMove?: (request: SessionMovePrompt) => Promise<SessionMoveAnswer>
  private dangerGuardExtension?: string
  private permissionGuardExtension?: string
  /** 内置服务扩展（Command Code：凭证页填了密钥就注册模型） */
  private providerExtensions: string[] = []
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
  /** 同步执行入场 token；成功后持有到回合结束，失败 / 取消立即归还。 */
  private executionAdmissionToken?: number
  private executionAdmissionTimer?: ReturnType<typeof setTimeout>
  /**
   * 运行注册表旁路（v3 WP-10）。
   *
   * 由主进程按 runner 实例注入；只收压缩后的 run signals，不参与执行控制。
   */
  private runObserver?: RunObserver

  /** 模型/思考能力变更串行化，避免快速点击时旧响应覆盖新状态。 */
  private capabilityChangeTail: Promise<void> = Promise.resolve()
  /**
   * MCP 连接管理器（实施-04 S3）。懒创建：没配 MCP 服务的机器上不付任何代价，
   * 也不起多余进程。与 agent 同生命周期 —— `stop()` 时关掉，不留孤儿子进程。
   */
  private mcpManager?: McpConnectionManager
  /**
   * 因配置转托管而退役的旧 legacy manager。
   * 不能立刻 `close()`：其上的活连接要由显式对账 **await 断开** 后才允许交给
   * 砚宿主，否则会出现双连接窗口。见 `settings-safe-access.ts`。
   */
  private retiredMcpManagers: McpConnectionManager[] = []
  /**
   * 因配置转托管 / 删除而摘出的成员，正在释放底层连接（key = serverId）。
   * 在确认关闭前，这些 serverId 仍视为**可能持有者**（见 `getLegacyMcpHolderSnapshot`）——
   * 关闭悬挂时旧 holder 不能从事实里消失；关闭失败则保守保留。
   */
  private mcpReleasing = new Map<string, Promise<{ confirmed: boolean; unknown: number }>>()
  /** `closeRetiredMcpManagers` 的串行链：并发收尾不重复关闭同一个 manager。 */
  private retiredCloseTail: Promise<void> = Promise.resolve()
  /** 配置本身的毛病（坏条目 / 重复 id）；调用时如实带回，不静默。 */
  private mcpConfigError?: string
  /** `yan capabilities search / discover / prepare / acquire` 的实现（见 capabilities/acquisition-commands.ts） */
  /** `yan search …` 与 `yan knowledge …` 的实现（见 lookup-commands.ts） */
  private readonly lookup = new LookupCommands({
    capabilityOpts: () => this.capabilityOpts,
    cwd: () => this.cwd,
    notifySearchApiMissing: () => this.push({ ch: 'search-api-hint', payload: {} })
  })
  /** `yan browser …` 的实现（见 browser-commands.ts） */
  private readonly browserCommands = new BrowserCommands({
    browserHostOrNull: () => this.getBrowserHost?.() ?? null,
    capabilityOpts: () => this.capabilityOpts
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
    bundledSkills: () => this.bundledSkills,
    /* 接入批准复用提问面板；结果同样记进问答记录，对话里能看到当时怎么选的。 */
    requestApproval: async (request) => {
      let response: HostUiResponse | undefined
      try {
        response = await this.ui.requestHostUi({ method: 'select', purpose: 'approval', ...request })
        return response
      } finally {
        const answer = typeof response?.value === 'string' && response.value.trim() ? response.value.trim() : null
        const entries = questionLog.append(this.state?.sessionId, {
          question: request.title,
          options: request.options,
          answer,
          cancelled: answer === null,
          at: Date.now()
        })
        if (entries) this.pushQuestionLog()
      }
    }
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
    /** 本次模型请求的单调起点（`performance.now()`，与墙钟 `startedAt` 分开） */
    generationStartedMono?: number
    /**
     * 上述起点的语义：`'turn_start'` 表示来自原生 `turn_start`（请求准备 /
     * 网络等待 / provider 内部重试都算进 duration 与 ttft）；缺省表示起点
     * 只是流的下限（`message_start`），不得拿它当完整请求 TTFT 保存。
     */
    requestStartEvent?: 'turn_start'
    /** 首个**真正内容**到达的单调时刻（非空 text/thinking delta 或 toolcall_start） */
    firstContentMono?: number
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
    /** 工具参数块是否尚未闭合；未闭合时不触发流式重复熔断。 */
    toolOpen?: boolean
  } | null = null
  /** 回合级「正在干活」（含工具执行），见 setAgentRunning */
  private agentRunning = false
  /** 本回合是否已调用过写文件 / shell 类工具；同目录并发只在写过文件时才算冲突。 */
  private wroteThisRun = false
  /** 当前 assistant 消息的流式重复检测器；message_start 重建、message_end 清掉。 */
  private streamLoopDetector: StreamLoopDetector | null = null
  /** 本 run 是否已因流式重复触发过熔断（同一 run 至多一次）。 */
  private loopGuardTripped = false
  /** 流式防护的 rpc abort 是否已发出；发出后到权威 settled 前阻止新的 send/steer/followUp。 */
  private loopGuardAbortSent = false
  /** 从命中起锁住队列编辑；失败时释放，成功则由权威事件收尾。 */
  private loopGuardStopping = false
  private loopGuardStopTask?: Promise<void>
  private loopGuardAbortedMessage = false
  /** 次数只在显式新输入重置，agent_start 不重置。 */
  private loopGuardAutoContinueCount = 0
  private loopGuardContinuationVersion = 0
  /** Failed/aborted messages permanently invalidate a pending approved move's continuation. */
  private sessionMoveFailureVersion = 0
  private loopGuardResumeVersion = -1
  private loopGuardContinueTask?: Promise<void>
  /** 熔断命中信息（只记规则与量，不存思考原文），用于权威收尾展示与结构化日志。 */
  private loopGuardHit?: { rule: LoopHit['rule']; stream: 'thinking' | 'text' }

  /** 当前回合的计时与元数据（见 turn-timing-tracker.ts） */
  private readonly turn = new TurnTimingTracker()
  /**
   * 最近一次原生 `turn_start` 的单调时刻（请求准备起点）。
   *
   * pi 在每次模型请求前 emit `turn_start`（`runAgentLoop` 起手一次、`runLoop`
   * 内每次再请求一次），它早于该请求的 assistant `message_start`。收到后先
   * 暂存，等 assistant `message_start` 消费成这次请求的 GT 起点。
   *
   * 为什么放在 Agent 而不是 `turn` 里：同一 native run 内消费官方子代理通知
   * 会重置 turn 段（旧段封口、新段独立计时），而 turn_start 早于通知的
   * `message_start`，跟着 turn 一起清会把通知后这次请求的起点丢掉。
   */
  private pendingRequestMono?: number
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

  /** 扩展与宿主发起的界面请求（见 ui-requests.ts） */
  /** 会话文件的轻量条目索引（任务清单 / 自定义条目 / 用户轮次），见 session-entries-lite.ts */
  private readonly entriesLite = new SessionEntriesLite()

  /**
   * 宿主内部读者要的条目：优先读会话文件（只读新增部分、不带消息内容），
   * 文件还不存在（新会话尚未落盘）时退回 pi 的 `get_entries`。
   *
   * ⚠️ 与下面公开的 `sessionEntries(since?)` 不是一回事：那个是 IPC/探针面，
   * 带游标与 `leafId`、失败返回 `{ ok:false, error }`；这里只给任务清单与
   * 轮次统计用，形状是裸数组、失败返回 null。公开面要占用 `sessionEntries`
   * 这个名字，所以内部这份改名为 `sessionEntriesLite`。
   */
  private async sessionEntriesLite(): Promise<Record<string, unknown>[] | null> {
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
  private readonly localizeHistoryImage = (mimeType: string, data: string): string =>
    localizeImage(join(YAN_DIR, 'attachments'), mimeType, data)

  private async readHistoryOf(sessionFile: string): Promise<ReadResult | null> {
    /*
     * 图片在这里**落盘**，消息里只留文件地址（见 image-store.ts）：
     * 历史重读是唯一会把 base64 带进消息的路径，而它每次打开会话都会跑。
     */
    if (this.readHistory) return this.readHistory(sessionFile).catch(() => null)
    return readSessionMessages(sessionFile, { localizeImage: this.localizeHistoryImage })
      .then(result => result ? { ...result, messages: structuredClone(result.messages) } : null)
      .catch(() => null)
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
    codemodeExtension?: string
    questionExtension?: string
    workModeExtension?: string
    shellFallbackExtension?: string
    agentProfileExtension?: string
    goalResumeExtension?: string
    handoffsExtension?: string
    /** 回复详细程度扩展（方案 3.1）：按档位注入系统提示 */
    responseDetailExtension?: string
    /**
     * 薄系统提示扩展：砚身份与简短进展说明约定。
     *
     * 不用 `--system-prompt`（那是整段替换，
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
    temperatureExtension?: string
    /**
     * 能力入口说明扩展：把「怎么用 `yan`、输出怎么读」追加到系统提示。
     *
     * 不这么做的话，能力虽然通了，模型也不知道要去用（见
     * resources/pi-extensions/capability-guide.js）。
     */
    capabilityGuideExtension?: string
    /** 托管 MCP 代理薄层路径（由 index.ts 注入；缺省不注册托管工具）。 */
    mcpAppProxyExtension?: string
    /** 工具快照文件；只在存在且未过期时注入，不落盘 token / 凭证。 */
    mcpAppToolsSnapshot?: string
    /**
     * 读 pi 原生 MCP 配置文本（启动见证采集 / 复核用）。
     * 缺省走 fs；宿主注入时也用于测试「采集 / 复核期间 stop」的竞态。
     */
    nativeConfigReader?: McpNativeConfigReader
    /** 上下文构成观测：只读上报，不改提示与消息。 */
    contextInspectExtension?: string
    /** 旧工具输出裁剪与自动压缩上限。 */
    contextTrimExtension?: string
    /** Thin bridge for desktop-initiated native tree navigation and resource reload. */
    nativeSessionExtension?: string
    /** Legacy caller option accepted but ignored; context belongs to pi. */
    contextExtension?: string
    /** Legacy caller option accepted but ignored; no automatic knowledge injection. */
    projectKnowledgeExtension?: string
    /** 单轮重复动作兜底（2026-09-22）：连续相同调用 → 提醒 / 拦下 */
    repeatGuardExtension?: string
    bundledSkills?: string[]
    userSkills?: () => Promise<string[]>
    /** Legacy caller option accepted but ignored. */
    contextBudgetObserverExtension?: string
    /** Legacy caller option accepted but ignored. */
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
    /** 定时任务服务（`yan schedule …`） */
    scheduleHost?: ScheduleService
    hubHost?: SubagentCommandHost
    /** 目标状态入口（`yan goal …`），由 index.ts 注入（模式与目标在同一侧）。 */
    goalHost?: GoalCommandHost
    /** 资料引用：按版本读片段与引用状态。 */
  researchHost?: GoalCommandHost
    confirmCapabilityAuthorization?: (
      request: CapabilityAuthorizationPrompt
    ) => Promise<CapabilityAuthorizationChoice>
    confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
    confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentDecision | null>
    confirmDanger?: (request: DangerConfirmPrompt) => Promise<ConsentDecision | null>
    getPermissionMode?: () => Promise<'danger' | 'all'>
    /** `yan session move`：问用户能否把会话移到另一个文件夹（本轮结束后由宿主切换）。 */
    requestSessionMove?: (request: SessionMovePrompt) => Promise<SessionMoveAnswer>
    dangerGuardExtension?: string
    permissionGuardExtension?: string
    providerExtensions?: string[]
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
      trashItem?: (path: string) => Promise<void>
    }
    /**
     * 运行注册表旁路（v3 WP-10）。
     *
     * 传的是压缩后的 run signals，不是消息 / 工具原始输出；主进程按 runner
     * 实例注入并自带 generation，本类不把它并入任何 UI 路径。
     */
    observeRun?: RunObserver
  }) {
    super()
    const emit = opts.push
    this.push = (msg) => {
      if (this.suppressPush) return
      this.observeRunPush(msg)
      emit(msg)
    }
    this.cwd = opts.cwd
    this.piBin = opts.piBin
    this.codemodeExtension = opts.codemodeExtension
    this.questionExtension = opts.questionExtension
    this.workModeExtension = opts.workModeExtension
    this.shellFallbackExtension = opts.shellFallbackExtension
    this.agentProfileExtension = opts.agentProfileExtension
    this.responseDetailExtension = opts.responseDetailExtension
    this.preambleExtension = opts.preambleExtension
    this.languageExtension = opts.languageExtension
    this.temperatureExtension = opts.temperatureExtension
    this.capabilityGuideExtension = opts.capabilityGuideExtension
    this.mcpAppProxyExtension = opts.mcpAppProxyExtension
    this.mcpAppToolsSnapshot = opts.mcpAppToolsSnapshot
    this.nativeConfigReader = opts.nativeConfigReader
    this.contextInspectExtension = opts.contextInspectExtension
    this.contextTrimExtension = opts.contextTrimExtension
    this.nativeSessionExtension = opts.nativeSessionExtension
    this.repeatGuardExtension = opts.repeatGuardExtension
    this.bundledSkills = opts.bundledSkills ?? []
    this.userSkills = opts.userSkills
    this.readHistory = opts.readHistory
    this.getResponseDetail = opts.getResponseDetail
    this.getBrowserHost = opts.browserHost
    this.subagentHost = opts.subagentHost
    this.scheduleHost = opts.scheduleHost
    this.hubHost = opts.hubHost
    this.goalHost = opts.goalHost
    this.researchHost = opts.researchHost
    this.confirmCapabilityAuthorization = opts.confirmCapabilityAuthorization
    this.confirmExternalApi = opts.confirmExternalApi
    this.confirmToolConsent = opts.confirmToolConsent
    this.confirmDanger = opts.confirmDanger
    this.getPermissionMode = opts.getPermissionMode
    this.requestSessionMove = opts.requestSessionMove
    this.dangerGuardExtension = opts.dangerGuardExtension
    this.permissionGuardExtension = opts.permissionGuardExtension
    this.providerExtensions = opts.providerExtensions ?? []
    this.yanCliEnv = opts.yanCliEnv
    this.capabilityOpts = opts.capability
      ? { ...opts.capability, runnerGeneration: opts.capability.runnerGeneration ?? 1 }
      : undefined
    this.runObserver = opts.observeRun
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
        run: (command, params, _ctx, signal) => this.runCapabilityCommand(command, params, signal)
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

  /** 这个实例的项目目录（只读；检查点按它存取） */
  get workingDirectory(): string {
    return this.cwd
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
  private queueConsumed = new Set<string>()
  private queueRemoved: QueueItem[] = []
  private consumedEmptyQueue = { steering: 0, followUp: 0 }
  private queueScope?: { rpc: PiRpc | null; sessionId?: string; generation?: number }
  /**
   * 是否正在做基于 clear_queue 的队列操作。
   *
   * pi 在 clear_queue 之后会推好几帧中间快照（最先一帧就是“空队列”）。
   * 拿它覆盖本地快照，随后按文本复用 id 的重建就拿不到原来的 id ——
   * 用户点「插队 / 撤回」会被误判成“消息已被 pi 接收”，还会白重建一次队列。
   * 操作期间一律跳过 pi 的中间帧，由操作方在收尾时推权威数据。
   */
  private queueBusy = false
  /** clear_queue + 重排必须串行，避免两次撤回互相覆盖恢复结果。 */
  private queueOperations: Promise<void> = Promise.resolve()
  /** 停止开始就使后台标题失效，不等待 MCP/RPC 关闭完成。 */
  private titleLifecycle = 0
  private stopping = false
  /**
   * A7：pi spawn 前采集、ready 后复核通过的启动见证。
   * `nativeWitnessPending` 已采集待复核；`nativeWitness` 已签发。getter 只读，
   * renderer / RPC 不能赋值；stop / 重启 / 热重载 / 进程退出即作废。
   */
  private nativeWitnessPending: McpNativeBootWitness | null = null
  private nativeWitness: McpNativeBootWitness | null = null

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

    this.stopping = false
    this.resetQueue()
    this.streamLoopDetector = null
    this.loopGuardTripped = false
    this.loopGuardAbortSent = false
    this.loopGuardStopping = false
    this.loopGuardAbortedMessage = false
    this.loopGuardAutoContinueCount = 0
    this.loopGuardContinuationVersion += 1
    this.loopGuardHit = undefined
    this.setConn('starting')

    /* 先起能力服务：pi 的环境变量里要有它的地址与令牌。 */
    await this.ensureCapability()

    const managedSkillArgs = this.capabilityOpts?.projectId
      ? await activeSkillArgs(YAN_DIR, this.capabilityOpts.projectId)
      : []
    const userSkillArgs = this.userSkills ? await this.userSkills().catch(() => [] as string[]) : []
    const probe = resolvePi({ override: this.piBin })
    const version = probe.home ? await readFile(join(probe.home, 'package.json'), 'utf8').then(text => JSON.parse(text).version as string).catch(() => undefined) : undefined
    const nativeTools = nativePiToolsSupported(version)
    const projectPackageArgs = nativeTools ? [] : await projectPiPackageArgs(this.cwd)
    /* Windows 上找不到 bash（系统没有、也没装受管 Git）：命令行工具退到 PowerShell */
    const shellFallback = !(await hasBash())
    const rpc = new PiRpc({
      cwd: this.cwd,
      piBin: this.piBin,
      args: agentOwnedPiArgs([
        /* Trusted UI/authorization extensions are explicit; pi discovers its native skills. */
        '--no-extensions',
        ...(this.nativeSessionExtension ? ['--extension', this.nativeSessionExtension] : []),
        ...(nativeTools && this.codemodeExtension ? ['--extension', this.codemodeExtension] : []),
         // 工作模式的提问指引薄层（真正入口是宿主 yan question ask）
        ...(this.questionExtension ? ['--extension', this.questionExtension] : []),
        /*
         * 工作模式的工具策略（实施-05 S3）：计划档把非只读工具从表里拿掉。
         * 放最后加载：它要在其它扩展注册完工具之后再收紧工具表。
         */
        /* 没有 Git Bash 时把 bash 工具换成 PowerShell；必须在 work-mode 之前，让它记到换好的基线 */
        ...(this.shellFallbackExtension ? ['--extension', this.shellFallbackExtension] : []),
        ...(this.workModeExtension ? ['--extension', this.workModeExtension] : []),
        /*
         * 活动档案（实施-25 P01）：紧跟在 work-mode 之后加载。
         * 两边各自收紧工具、互不恢复对方，所以顺序不影响「更严的那个生效」。
         */
        ...(this.agentProfileExtension ? ['--extension', this.agentProfileExtension] : []),
        // 回复详细程度（简洁 / 标准 / 详细）：standard 档不注入任何东西
        ...(this.responseDetailExtension ? ['--extension', this.responseDetailExtension] : []),
        // 系统提示开场白：把 pi 内置英文 preamble 换成砚的中文开场白
        ...(this.preambleExtension ? ['--extension', this.preambleExtension] : []),
        // 界面语言 → 推理/回复语言：每轮读设置注入一句（不再用启动参数）
        ...(this.languageExtension ? ['--extension', this.languageExtension] : []),
        ...(this.temperatureExtension ? ['--extension', this.temperatureExtension] : []),
        // 能力入口说明：告诉模型有 `yan` 这个入口、输出怎么读（静态文本，不破缓存）
        ...(this.capabilityGuideExtension
          ? ['--extension', this.capabilityGuideExtension]
          : []),
        // 上下文构成：只读观测，放在提示类扩展之后，读到的是它们拼完的最终系统提示
        ...(this.contextInspectExtension ? ['--extension', this.contextInspectExtension] : []),
        // 旧工具输出裁剪 + 自动压缩上限：读设置，未到软线时不改任何消息
        ...(this.contextTrimExtension ? ['--extension', this.contextTrimExtension] : []),
        /*
         * 单轮重复动作兜底（2026-09-22）：连续 3 次相同调用提醒、5 次拦下。
         * 放最后：它要在其它扩展都不拦的时候才生效（不抢模式门禁的判断）。
         */
        ...(this.repeatGuardExtension ? ['--extension', this.repeatGuardExtension] : []),
        /* 托管 MCP 代理薄层：读快照注册 mcp__ 工具，执行时打回宿主能力端点。 */
        ...(this.mcpAppProxyExtension ? ['--extension', this.mcpAppProxyExtension] : []),
        ...(this.dangerGuardExtension ? ['--extension', this.dangerGuardExtension] : []),
        // 询问档：写文件 / 跑命令前先问（读设置，full 档不产生任何请求）
        ...(this.permissionGuardExtension ? ['--extension', this.permissionGuardExtension] : []),
        ...this.providerExtensions.flatMap((path) => ['--extension', path]),
        /* 受管 skill-files 只按当前项目 active 记录显式传入；不扫描全盘。 */
        ...managedSkillArgs,
        /* 随包技能：领域做法（例如办公文件）放在技能里按需加载，不写进宿主 */
        ...this.bundledSkills.flatMap((skill) => ['--skill', skill]),
        /* 用户技能：用户自己保存的做法（含旧办事模板的导出） */
        ...userSkillArgs.flatMap((skill) => ['--skill', skill]),
        /* 旧版 pi 的受信项目包补回；原生 pi 保留自身发现与禁用策略。 */
        ...projectPackageArgs,
        /*
         * 测试通道：`YAN_PROBE_SKILL` 指定一个 SKILL.md 时，像受管技能那样
         * 用显式 `--skill` 传进去，与真实用户技能目录隔离。
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
      ], nativeTools),
      env: {
        // 让内置扩展能读到桌面端设置（工作模式快照存在 desktop.json 旁边）。
        // 测试时 YAN_DATA_DIR 指向隔离目录，扩展会读到那份设置。
        YAN_DATA_DIR: YAN_DIR,
        // 便携版必须让 pi 也使用 EXE 同级的私有目录；否则它会回退到 ~/.pi。
        PI_CODING_AGENT_DIR: PI_AGENT_DIR,
        ...(this.nativeSessionExtension ? { YAN_NATIVE_BRIDGE: '1' } : {}),
        ...(shellFallback ? { YAN_SHELL: 'powershell' } : {}),
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
        /*
         * 托管 MCP 工具快照：只注入路径（快照不含 token / 配置 / 凭证）。
         * 没有快照就没有这一项 —— 代理薄层不注册工具，等用户刷新。
         * 项目身份一并注入：薄层据此只注册「全局 + 本项目」的工具，不注册别的项目。
         */
        ...(this.mcpAppToolsSnapshot ? { YAN_MCP_APP_TOOLS: this.mcpAppToolsSnapshot } : {}),
        ...(this.mcpAppToolsSnapshot && this.capabilityOpts?.projectId
          ? { YAN_MCP_APP_PROJECT_ID: this.capabilityOpts.projectId }
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
    this.nativeRuntime = new NativeSessionRuntime({ command: (type, payload, options) => rpc.command(type, payload, options) })

    rpc.on('stderr', (line) => {
      this.push({ ch: 'proc', payload: { state: 'stderr', detail: line } })
    })

    rpc.on('exit', (code) => {
      if (this.rpc !== rpc) return
      // A dead RPC cannot finish its turn or answer UI requests. Preserve history/queue
      // for explicit reload, but release busy flags so the runner can be replaced.
      this.flushNow()
      this.streaming = null
      this.bash = null
      this.agentRunning = false
      this.releaseExecutionAdmission()
      this.compactionState = EMPTY_COMPACTION_STATE
      this.ui.rejectPendingHostUi('pi 已退出，问题请求已取消')
      this.ui.pending.clear()
      if (this.state) {
        this.state = { ...this.state, isAgentRunning: false, isStreaming: false, isCompacting: false }
        this.push({ ch: 'state', payload: this.state })
      }
      this.setConn('exited', `pi 已退出（code=${code ?? 'null'}）`)
      /* A7：进程已退，启动见证不再代表任何存活进程，立刻作废。 */
      this.nativeWitness = null
      this.nativeWitnessPending = null
      /*
       * 进程退出 → 运行注册表：主动停（回收 / 切换 / 退出）记「停止」，
       * 意外退出记「失败」。两者都不是 done，不会把没跑完的一轮说成已完成。
       * ctx 在退出到达时快照，不用延迟后的「当前会话」。
       */
      const runSink = this.runObserver
      const runCtx = this.runObserverContext()
      if (runSink && runCtx) {
        runSink(runCtx, this.stopping ? { type: 'stopped', by: 'host' } : { type: 'pi-exit', code: code ?? null, signal: null })
      }
    })

    rpc.on('ui', (req) => {
      if (this.nativeRuntime?.handleUi(req)) return
      this.ui.handleUi(req)
    })
    rpc.on('event', (evt) => this.handleEvent(evt))

    /*
     * A7：spawn 前记下真实原生配置的启动快照（全局 `PI_AGENT_DIR/mcp.json` +
     * 本 cwd 项目 `.pi/mcp.json`；与砚实际传给 pi 的 agentDir / cwd 同源）。
     * pi ready 后重读比对，两次一致才签发见证。
     *
     * 采集是 await：期间可能 stop / 重启 / 换项目。若 `this.rpc` 已不是当前这个
     * rpc（或已进入 stopping），本次启动作废 —— 不 spawn、不签发、不覆盖新状态，
     * 旧回调不得让 stop 之后的旧进程复活。
     */
    this.nativeWitness = null
    this.nativeWitnessPending = null
    {
      const capture = await captureNativeStartupWitness({
        agentDir: PI_AGENT_DIR,
        cwd: this.cwd,
        bootId: newBootId(),
        generation: this.capabilityOpts?.runnerGeneration ?? 1,
        projectId: this.capabilityOpts?.projectId ?? null,
        ...(this.nativeConfigReader ? { readNativeConfig: this.nativeConfigReader } : {})
      })
      if (this.rpc !== rpc || this.stopping) {
        return { ok: false, error: 'pi 启动在采集归属事实期间被取消' }
      }
      if (capture.ok) this.nativeWitnessPending = capture.witness ?? null
    }

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
     * A7：pi 已就绪、原生配置已加载完；重读比对通过才签发启动见证。
     * 复核同样可能被 stop / 重启打断：`this.rpc` 变了或已 stopping 就不签发，
     * 也不让旧实例继续 hydrate。
     */
    {
      const pending = this.nativeWitnessPending
      this.nativeWitnessPending = null
      if (pending) {
        const confirmed = await verifyNativeStartupWitness(pending, {
          ...(this.nativeConfigReader ? { readNativeConfig: this.nativeConfigReader } : {})
        })
        if (this.rpc === rpc && !this.stopping && confirmed.ok) this.nativeWitness = pending
      }
    }
    if (this.rpc !== rpc || this.stopping) {
      return { ok: false, error: 'pi 启动在复核归属事实期间被取消' }
    }

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
        const res = await this.requireRpc().command('get_state')
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
    const state = await this.requireRpc().command('get_state').catch(() => null)
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
    if (this.nativeBranchView) {
      const snapshot = await this.sessionEntries()
      if (!snapshot.ok) throw new Error(snapshot.error ?? '无法读取当前原生分支')
      const path = nativeActiveBranch(snapshot.entries ?? [], snapshot.leafId ?? null)
      const messageEntries = path.filter(entry => entry.type === 'message' && entry.message)
      const previousSegments = fromFile?.messages.filter(message => message.id.startsWith('history:')) ?? []
      this.messages = [...previousSegments, ...normalizeHistory(messageEntries.map(entry => entry.message),
        (mimeType, data) => localizeImage(join(YAN_DIR, 'attachments'), mimeType, data),
        messageEntries.map(entry => typeof entry.id === 'string' ? entry.id : undefined))]
    } else if (fromFile?.messages.length) {
      this.messages = fromFile.messages
    } else {
      const msgs = await this.requireRpc().command('get_messages').catch(() => null)
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
    const stats = await this.requireRpc().command('get_session_stats').catch(() => null)
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
      const entries = await this.sessionEntriesLite()
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
      const entries = await this.sessionEntriesLite()
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
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CapabilityCommandResult> {
    if (command.startsWith('browser.')) {
      return this.browserCommands.runBrowserCommand(command.slice('browser.'.length), params)
    }
    if (command.startsWith('hub.')) {
      if (!this.hubHost) throw new CapabilityCommandError('hub_unavailable', '多 Agent 宿主当前不可用')
      return this.hubHost.run(command, params, { cwd: this.cwd, parentSessionId: this.state?.sessionId ?? this.capabilityOpts?.sessionId, parentRunId: this.capabilityOpts?.sessionId, projectId: this.capabilityOpts?.projectId })
    }
    if (command.startsWith('schedule.')) {
      if (!this.scheduleHost) throw new CapabilityCommandError('schedule_unavailable', '定时任务当前不可用')
      try {
        return await runScheduleCommand(this.scheduleHost, command, params, { cwd: this.cwd })
      } catch (error) {
        if (error instanceof ScheduleCommandError) throw new CapabilityCommandError(error.code, error.message)
        throw error
      }
    }
    if (command.startsWith('subagent.')) {
      if (!this.subagentHost) {
        throw new CapabilityCommandError('subagent_unavailable', '子代理宿主入口当前不可用')
      }
      return this.subagentHost.run(command, params, {
        cwd: this.cwd,
        model: this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : undefined,
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
    if (command.startsWith('mcp.app.')) {
      return this.runMcpAppCommand(command, params, signal)
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
    if (command === 'image.local.status' || command === 'image.local.start' || command === 'image.local.stop') return this.runLocalImageServiceCommand(command)
    /* 资料引用：按版本读片段与引用状态。 */
    if (command.startsWith('research.')) {
      if (!this.researchHost) {
        throw new CapabilityCommandError('research_unavailable', '研究入口当前不可用（宿主未注入）')
      }
      return this.researchHost.run(command, params, {
        sessionId: this.capabilityOpts?.sessionId ?? 'primary',
        projectId: this.capabilityOpts?.projectId ?? ''
      })
    }
    if (command === 'artifact.attach') return this.runArtifactAttachCommand(params)
    if (command === 'question.ask') return this.runQuestionCommand(params)
    if (command === 'context.recall') return this.runContextRecallCommand(params)
    if (command === 'context.find') return this.runContextFindCommand(params)
    if (command === 'office.read') return this.runOfficeReadCommand(params)
    if (command === 'file.trash') return this.runFileTrashCommand(params)
    if (command === 'consent.request') return this.runConsentRequestCommand(params)
    if (command === 'danger.confirm') return this.runDangerConfirmCommand(params)
    if (command === 'session.move') return this.runSessionMoveCommand(params)
    if (command === 'context.inspect') {
      /* 按 pi 会话 id 存（界面读的也是它）；capability 的 sessionId 是运行实例 id，换实例会变。 */
      const saved = saveContextInspect(this.state?.sessionId, params.snapshot)
      return { data: { saved }, summary: { kind: 'context-inspect', saved } }
    }
    if (command.startsWith('context.budget.')) throw new CapabilityCommandError('agent_owned_context', AGENT_CONTEXT_ERROR)
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

  private async runQuestionForm(
    question: string,
    params: Record<string, unknown>
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    let fields: QuestionField[]
    try {
      fields = parseQuestionFields(params.fields)
    } catch (error) {
      if (error instanceof QuestionFormError) throw new CapabilityCommandError('question_form_invalid', error.message)
      throw error
    }
    const mode = await this.capabilityOpts?.getWorkMode?.()
    if (mode === 'autonomous') {
      return {
        data: { question, fields, answers: null, answer: null, autonomous: true, cancelled: false },
        summary: { kind: 'question', action: 'ask', mode, form: true, answered: false, autonomous: true }
      }
    }
    const response = await this.ui.requestHostUi({ method: 'input', title: '需要你填写', message: question, form: fields, timeout: requestedTimeout(params.timeout) })
    const answers = typeof response.value === 'string' ? parseQuestionAnswers(fields, response.value) : null
    const answer = answers ? summarizeAnswers(fields, answers) : null
    const cancelled = response.cancelled === true || answers === null
    const entries = questionLog.append(this.state?.sessionId, { question, options: [], answer, cancelled, at: Date.now() })
    if (entries) this.pushQuestionLog()
    return {
      data: { question, fields, answers, answer, cancelled, autonomous: false },
      summary: { kind: 'question', action: 'ask', mode: mode ?? 'standard', form: true, answered: answers !== null, cancelled }
    }
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

    /* 表单形态：一次问清几项（单选卡片 / 多选 / 文字 / 日期 / 数字 / 滑块），格式见 shared/question-form.ts */
    if (params.fields !== undefined) return this.runQuestionForm(question, params)

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
    // 两档权限取代按工具积累的同意率；旧记录仍可读取但不再决定调用。
    if (!declaredDanger || (await this.getPermissionMode?.()) === 'all') {
      return { summary: { kind: 'consent', allowed: true, decision: 'auto', reason: 'permission-mode' } }
    }
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
    if ((await this.getPermissionMode?.()) === 'all') return { summary: { kind: 'danger-confirm', allowed: true, decision: 'auto' } }
    const tool = typeof params.tool === 'string' ? params.tool.slice(0, 40) : 'tool'
    const detail = typeof params.detail === 'string' ? params.detail : ''
    // Never authorize a different, truncated task than the one the user reviewed.
    if (detail.length > 20000) return { summary: { kind: 'danger-confirm', allowed: false, decision: 'no-answer', reason: '审批内容过长，请缩短任务后重试' } }
    const reasons = Array.isArray(params.reasons)
      ? params.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 200)).slice(0, 6)
      : []
    const outsideDirs = Array.isArray(params.outsideDirs)
      ? params.outsideDirs.filter((d): d is string => typeof d === 'string').map((d) => d.slice(0, 500)).slice(0, 6)
      : []
    const kind = params.kind === 'permission' || params.kind === 'delete' ? params.kind : undefined
    const answer = this.confirmDanger ? await this.confirmDanger({ tool, detail, reasons, cwd: this.cwd, ...(kind ? { kind } : {}), ...(outsideDirs.length ? { outsideDirs } : {}) }) : null
    const decision = answer ?? 'no-answer'
    return {
      data: { decision },
      summary: { kind: 'danger-confirm', tool, decision, allowed: answer === 'allow' }
    }
  }

  /**
   * `yan session move --dir <文件夹>`：任务属于另一个文件夹时，请求把这条会话移过去。
   * 宿主用批准卡片问用户；允许后等这一轮结束再切换工作目录（见 session-move.ts），
   * 所以这里只回结果与下一步说明，不在回合中途换目录。
   */
  private async runSessionMoveCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const dir = typeof params.dir === 'string' ? params.dir.trim().slice(0, 1000) : ''
    if (!dir) throw new CapabilityCommandError('session_move_dir_required', '缺少 --dir（要移到的文件夹）')
    const reason = typeof params.reason === 'string' ? params.reason.trim().slice(0, 300) : ''
    if (!this.requestSessionMove) throw new CapabilityCommandError('session_move_unavailable', '移动会话当前不可用（宿主未注入）')
    const sessionId = this.state?.sessionId
    const sessionFile = this.state?.sessionFile
    if (!sessionId || !sessionFile) {
      throw new CapabilityCommandError('session_move_unsaved', '会话还没有保存到文件，暂时不能移动；先完成这一轮再试')
    }
    const answer = await this.requestSessionMove({ dir, reason, cwd: this.cwd, sessionId, sessionFile })
    return {
      data: answer,
      summary: { kind: 'session-move', decision: answer.decision, target: answer.target ?? dir, allowed: answer.decision === 'approved' }
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

  /**
   * `yan file trash`：把文件或目录移到系统回收站。
   *
   * 权限档位不确认删除时，薄层（permission-guard / danger-guard）拦下删除命令并引到这里，
   * 删除因此总能从回收站找回。逐个处理，一个失败不影响其余；盘符根与家目录本身拒绝。
   */
  private async runFileTrashCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const trash = this.capabilityOpts?.trashItem
    if (!trash) throw new CapabilityCommandError('trash_unavailable', '回收站当前不可用（宿主未注入）')
    const raw = [
      ...(typeof params.path === 'string' ? [params.path] : []),
      ...(Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === 'string') : [])
    ].map((p) => p.trim()).filter(Boolean)
    if (!raw.length) throw new CapabilityCommandError('trash_path_required', '缺少 --path（或请求文件里的 paths）')
    if (raw.length > 200) throw new CapabilityCommandError('trash_too_many', '一次最多移动 200 个路径')
    const home = resolve(homedir()).toLowerCase()
    const trashed: string[] = []
    const failed: { path: string; error: string }[] = []
    for (const item of raw) {
      const abs = isAbsolute(item) ? resolve(item) : resolve(this.cwd, item)
      const key = abs.toLowerCase().replace(/[\\/]+$/, '')
      if (dirname(abs) === abs || key === home) {
        failed.push({ path: abs, error: '拒绝把盘符根目录或家目录整体移到回收站' })
        continue
      }
      try {
        await stat(abs)
        await trash(abs)
        trashed.push(abs)
      } catch (error) {
        failed.push({ path: abs, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      data: { trashed, failed },
      summary: { kind: 'file-trash', trashed: trashed.length, failed: failed.length }
    }
  }

  startHostUiTimer(id: string): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    return this.ui.startHostUiTimer(id)
  }

  extendHostUi(id: string, extraMs?: unknown): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    return this.ui.extendHostUi(id, extraMs)
  }

  /**
   * `sessionFile` 给出时要求当前仍是那条会话：异步生成期间实例换了会话，成果已按原会话写进
   * manifest，这里不把它挂到现在的消息上（也不改挂最新消息）。
   */
  private async attachArtifact(artifact: AssistantArtifact, messageId = this.latestAssistantMessageId(), sessionFile?: string): Promise<void> {
    if (sessionFile && this.state?.sessionFile !== sessionFile) return
    const message = this.messages.find((item) => item.id === messageId)
    if (!message || !messageId) return
    message.artifacts = [...(message.artifacts ?? []), artifact]
    this.push({ ch: 'artifact', payload: { messageId, artifact } })
  }

  private async runArtifactAttachCommand(params: Record<string, unknown>): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const sourcePath = typeof params.path === 'string' ? params.path.trim() : ''
    if (!sourcePath) throw new CapabilityCommandError('artifact_path_missing', 'artifact.attach 需要 path')
    const sessionFile = this.state?.sessionFile
    if (!sessionFile) throw new CapabilityCommandError('session_not_saved', '当前会话尚未保存，暂时不能关联产物')
    const messageId = this.latestAssistantMessageId()
    const artifact = await new ArtifactStore(this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts')).attach({
      sessionFile,
      messageId,
      cwd: this.cwd,
      sourcePath,
      description: typeof params.description === 'string' ? params.description : undefined
    })
    await this.attachArtifact(artifact, messageId, sessionFile)
    return {
      data: { artifact },
      summary: { artifactId: artifact.id, filename: artifact.filename, kind: artifact.kind, bytes: artifact.bytes }
    }
  }

  /** 本机 ComfyUI 的状态与开关；stop 只关砚自己拉起的进程 */
  private async runLocalImageServiceCommand(command: 'image.local.status' | 'image.local.start' | 'image.local.stop'): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    if (command === 'image.local.stop') {
      const stopped = stopManagedComfy()
      const status = await comfyStatus()
      return { data: status, summary: { kind: 'comfyui', stopped, running: status.running, note: stopped ? '已关闭砚启动的 ComfyUI' : status.running ? '正在运行的 ComfyUI 不是砚启动的，没有关闭' : 'ComfyUI 没有在运行' } }
    }
    if (command === 'image.local.start') {
      try {
        const server = await ensureComfyRunning()
        const status = await comfyStatus()
        return { data: status, summary: { kind: 'comfyui', running: true, baseUrl: server.baseUrl, managed: status.managed, workflows: server.models.length } }
      } catch (error) {
        if (error instanceof ComfyLaunchError) throw new CapabilityCommandError(error.code, error.reason ? `ComfyUI 启动失败：${error.reason}` : 'ComfyUI 启动失败')
        throw error
      }
    }
    const status = await comfyStatus()
    return { data: status, summary: { kind: 'comfyui', running: status.running, managed: status.managed, launchable: status.launchable, ...(status.idleStopAt ? { idleStopInSeconds: Math.max(0, Math.round((status.idleStopAt - Date.now()) / 1000)) } : {}), workflows: status.workflows.length } }
  }

  /** 仅取消这个实例拥有的请求，不影响其他会话的后台生成。 */
  private cancelImages(): void {
    for (const controller of this.imageRequests) controller.abort()
  }

  private async runImageCommand(params: Record<string, unknown>): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const request = params as unknown as ImageGenerationRequest
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw new CapabilityCommandError('image_prompt_missing', 'image.generate 需要 prompt')
    if (request.provider !== undefined && !isImageProvider(request.provider)) {
      throw new CapabilityCommandError('image_provider_unknown', 'image.generate 的 provider 只能是 auto、codex、openai、compatible、google、doubao、local')
    }
    // 归属先于异步探测固定；未保存会话不创建无法恢复的 manifest。
    const messageId = this.latestAssistantMessageId()
    const sessionFile = this.state?.sessionFile
    if (!sessionFile) throw new CapabilityCommandError('session_not_saved', '当前会话尚未保存，暂时不能生成并关联产物')
    const controller = new AbortController()
    this.imageRequests.add(controller)
    const cwd = this.cwd
    const progressId = `image-${randomUUID()}`
    const startedAt = Date.now()
    let provider: Exclude<NonNullable<ImageGenerationRequest['provider']>, 'auto'> | undefined
    let model = ''
    let terminal = false
    const publishProgress = (stage: ImageGenerationProgress['stage'], detail?: string): void => {
      if (terminal || (controller.signal.aborted && stage !== 'error')) return
      if (this.state?.sessionFile !== sessionFile) return
      terminal = stage === 'done' || stage === 'error'
      const progress: ImageGenerationProgress = {
        id: progressId, stage, startedAt, updatedAt: Date.now(),
        ...(terminal ? { endedAt: Date.now() } : {}),
        ...(provider ? { provider } : {}), model,
        ...(detail ? { detail } : {})
      }
      const message = this.messages.find((item) => item.id === messageId)
      if (message) {
        message.imageProgress = [...(message.imageProgress ?? []).filter((item) => item.id !== progressId), progress]
      }
      this.push({ ch: 'msg-update', payload: { id: messageId, patch: { imageProgress: [progress] } } })
    }
    const checkCancelled = (): void => {
      if (controller.signal.aborted) throw new CapabilityCommandError('image_cancelled', '已停止生图')
    }

    publishProgress('queued', '已加入当前回合')
    try {
      const availability = await waitForImage(detectImageProviders(), controller.signal)
      checkCancelled()
      const resolved = resolveImageProvider(request.provider, availability)
      provider = resolved === 'unavailable' ? undefined : resolved
      model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : defaultImageModel(resolved, availability)
      if (resolved !== 'unavailable' && resolved !== 'codex' && resolved !== 'mock' && imageProviderNeedsConfirmation(resolved, availability)) {
        publishProgress('confirming', '等待确认外部图像 API 请求')
        const allowed = await waitForImage(Promise.resolve(this.confirmExternalApi?.({
          provider: resolved, endpoint: imageProviderEndpoint(resolved, availability), model, prompt, cwd
        })), controller.signal)
        checkCancelled()
        if (!allowed) throw new CapabilityCommandError('external_api_denied', '已取消：未获得外部图像 API 请求确认')
      }
      const result = await generateImage({ ...request, prompt, ...(provider ? { provider } : {}) }, {
        cwd, availability, sessionFile, messageId,
        artifactDir: this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts'),
        signal: controller.signal,
        // 完成进度由宿主挂载后发布，避免提前报完成或停止后的迟到事件覆盖取消。
        onProgress: (stage, detail) => { if (stage !== 'done') publishProgress(stage, detail) }
      })
      checkCancelled()
      await this.attachArtifact(result.artifact, messageId, sessionFile)
      publishProgress('done', `${result.artifact.filename} · ${result.artifact.bytes} bytes`)
      return {
        data: { artifact: result.artifact, provider: result.provider, model: result.model, revisedPrompt: result.revisedPrompt },
        summary: { provider: result.provider, model: result.model, artifactId: result.artifact.id, filename: result.artifact.filename, path: result.artifact.path, bytes: result.artifact.bytes }
      }
    } catch (error) {
      const failure = controller.signal.aborted ? new CapabilityCommandError('image_cancelled', '已停止生图') : error
      publishProgress('error', imageFailureDetail(failure))
      throw failure
    } finally {
      this.imageRequests.delete(controller)
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

  /**
   * 懒创建 legacy 连接管理器；配置坏掉时把原因留着，调用时一并回报。
   *
   * **排除托管服务**：托管项只由 `McpAppHost` 单例连接，legacy manager 不再建
   * 第二条。配置后来转托管时旧 manager 里可能仍留活连接 —— 成员变化就重建；
   * 含托管项的旧 manager 退役进 `retiredMcpManagers`，等显式对账 await 断开。
   */
  private mcpConnectionManager(): McpConnectionManager {
    const loaded = loadMcpServers()
    this.mcpConfigError = loaded.error
    const visible = mcpServersForProject(loaded.servers, this.capabilityOpts?.projectId)
    const legacyConfigs = visible.filter((server) => !isInkstoneManaged(server))
    if (!this.mcpManager) {
      this.mcpManager = new McpConnectionManager(legacyConfigs)
      return this.mcpManager
    }
    /*
     * 复用同一个 manager，只按 server 协调成员（不重建、不建第二注册表）：
     * 转托管 / 删除的成员被立即摘出并异步释放；未变化的 legacy 成员（如 B）
     * 保持原连接，避免新 manager 对同一个 B 再连一条。释放确认前，被摘出的
     * serverId 仍经 `mcpReleasing` 计入持有者，不当成已安全交接。
     */
    const releases = this.mcpManager.syncServers(legacyConfigs)
    for (const { serverId, release } of releases) {
      this.mcpReleasing.set(serverId, release)
      void release.then(
        (outcome) => {
          if (outcome.confirmed && this.mcpReleasing.get(serverId) === release) this.mcpReleasing.delete(serverId)
        },
        () => {
          /* 关闭失败：保守保留，仍算可能持有 */
        }
      )
    }
    return this.mcpManager
  }

  /** 单一归属路径的注入点：现役 + 退役 legacy manager 只读引用 + 宿主单例。 */
  private settingsSafeAccess(): SettingsSafeAccess {
    return {
      loadServers: () => loadMcpServers(),
      legacyManagers: () =>
        [this.mcpManager, ...this.retiredMcpManagers].filter(
          (manager): manager is McpConnectionManager => Boolean(manager)
        ),
      host: () => mcpAppHost()
    }
  }

  /**
   * 关闭退役 manager。**先不把事实清空**：关闭期间它们仍在持有快照里可见；
   * 未能确认关闭的保守留在列表（下次再试），不因为 Promise 没抛错就当成已释放。
   */
  private closeRetiredMcpManagers(): Promise<void> {
    const run = this.retiredCloseTail.then(() => this.closeRetiredNow(), () => this.closeRetiredNow())
    this.retiredCloseTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async closeRetiredNow(): Promise<void> {
    if (this.retiredMcpManagers.length === 0) return
    const remaining: McpConnectionManager[] = []
    for (const manager of this.retiredMcpManagers) {
      const outcome = await manager.closeConfirmed().catch(() => ({ confirmed: false, unknown: 1 }))
      if (!outcome.confirmed) remaining.push(manager)
    }
    this.retiredMcpManagers = remaining
  }

  /** 显式对账旧 legacy 残留，并清掉已确认断开的退役 manager。 */
  private async reconcileLegacyForManaged(serverId: string): Promise<LegacyReconcileResult> {
    const result = await reconcileLegacyManaged(
      this.settingsSafeAccess(),
      serverId,
      this.capabilityOpts?.projectId
    )
    /*
     * 该成员可能已被 `mcpConnectionManager()` 同步摘出并在异步释放，
     * `reconcileLegacyManaged` 只在仍登记的 manager 里找得到它。
     * 关闭确认回来前不得交给宿主。
     */
    const releasing = this.mcpReleasing.get(serverId)
    if (releasing) {
      const outcome = await releasing
      if (!outcome.confirmed) {
        throw new SettingsSafeAccessError(
          'legacy-holder-unresolved',
          `旧 MCP 连接 ${serverId} 的关闭未能确认，不交给砚宿主，避免双连接`
        )
      }
      if (this.mcpReleasing.get(serverId) === releasing) this.mcpReleasing.delete(serverId)
      result.legacyReleased = true
    }
    await this.closeRetiredMcpManagers()
    return result
  }

  /**
   * 只读旧 legacy MCP manager 的持有事实（**不创建 manager、不连接、不含凭证**）。
   *
   * 为什么需要：runner 窄快照只反映 pi RPC 进程；`AgentController` 的 legacy
   * manager 可能在 pi 退出后仍活着。A7 的启动见证不能据此假定「无 legacy 连接」，
   * 下一整合者应把本事实并入 runners 窄快照（补丁见交接报告）。
   */
  getLegacyMcpHolderSnapshot(): { services: Array<{ serverId: string; status: McpServerStatus }> } {
    const managers = [this.mcpManager, ...this.retiredMcpManagers].filter(
      (manager): manager is McpConnectionManager => Boolean(manager)
    )
    const services: Array<{ serverId: string; status: McpServerStatus }> = []
    for (const manager of managers) {
      for (const serverId of manager.listServerIds()) {
        if (services.some((service) => service.serverId === serverId)) continue
        services.push({ serverId, status: manager.statusOf(serverId).status })
      }
    }
    /*
     * 已摘出但尚未确认关闭的成员仍算可能持有：关闭悬挂时旧 holder 不能从
     * 事实里消失，否则宿主会在旧 transport 还没关干净时接手。
     */
    for (const serverId of this.mcpReleasing.keys()) {
      if (services.some((service) => service.serverId === serverId)) continue
      services.push({ serverId, status: 'connecting' })
    }
    return { services }
  }

  /** 安全投影给设置页：不回传命令参数、环境变量、认证引用或完整端点 URL。 */
  async capabilitySettingsSnapshot() {
    const commands = await this.rawCommands()
    /* 技能分类：本次会话（模型接入）/ 我的技能 / 随包 / 其他（pi 原生发现、项目目录） */
    const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
    const userRoot = resolve(userSkillsDir())
    const acquiredUser = await acquiredUserSkillNames(YAN_DIR)
    const loaded = skillsFromCommands(commands).map(({ capability, location }) => {
      const origin = this.bundledSkills.some((path) => samePath(path, location))
        ? 'bundled' as const
        : resolve(location).toLowerCase().startsWith(`${userRoot.toLowerCase()}${sep}`)
          ? 'user' as const
          : 'other' as const
      return {
        id: capability.id,
        title: capability.title,
        description: capability.description,
        origin,
        ...(origin === 'user' && acquiredUser.has(basename(dirname(location))) ? { acquired: true } : {})
      }
    })
    const sessionId = this.state?.sessionId
    const sessionSkills = sessionId
      ? (await listSessionSkills(YAN_DIR, sessionId)).map((skill) => ({
          id: `session:${skill.name}`,
          title: skill.name,
          description: skill.description,
          origin: 'session' as const,
          acquired: true,
          ...(skill.sourceUrl ? { sourceUrl: skill.sourceUrl } : {})
        }))
      : []
    const skills = [...sessionSkills, ...loaded]
    const endpointOriginOf = (server: { transport: string; url?: string }): string | undefined => {
      if (server.transport !== 'http' || !server.url) return undefined
      try {
        const origin = new URL(server.url).origin
        return origin === 'null' ? undefined : origin
      } catch {
        /* 配置校验已报错；UI 不需要拿到可能含凭证的原始字符串。 */
        return undefined
      }
    }
    const loadedForSettings = loadMcpServers()
    this.mcpConfigError = loadedForSettings.error
    const projectId = this.capabilityOpts?.projectId
    const visible = mcpServersForProject(loadedForSettings.servers, projectId)
    const managedConfigs = visible.filter((server) => isInkstoneManaged(server))
    /* 展示前对账：配置刚转托管时，旧 legacy manager 里可能仍留活连接。 */
    for (const managed of managedConfigs) await this.reconcileLegacyForManaged(managed.id)
    const access = this.settingsSafeAccess()
    const manager = this.mcpConnectionManager()
    /* 对账后已无用的退役 manager 此刻可安全关闭。 */
    await this.closeRetiredMcpManagers()
    const servers: CapabilityMcpServerSettingView[] = []
    for (const server of manager.list()) {
      const endpointOrigin = endpointOriginOf(server)
      servers.push({
        id: server.id,
        title: server.title ?? server.id,
        transport: server.transport,
        enabled: server.enabled !== false,
        effect: server.effect ?? 'unknown',
        projectScoped: Boolean(server.projectScope),
        ...(endpointOrigin ? { endpointOrigin } : {}),
        status: manager.statusOf(server.id).status,
        toolCount: manager.toolCountOf(server.id),
        ownedBy: 'pi',
        /* 已导入 pi 原生的条目：设置页可显示「已导入」而不删条目（方案合集 06）。 */
        ...(server.migratedToNative ? { migratedToNative: server.migratedToNative } : {})
      })
    }
    /* 托管项：状态与工具数只读宿主已持有的缓存，不为展示而连接。 */
    for (const config of managedConfigs) {
      const facts = managedRuntimeFacts(access, config.id)
      const endpointOrigin = endpointOriginOf(config)
      servers.push({
        id: config.id,
        title: config.title ?? config.id,
        transport: config.transport,
        enabled: config.enabled !== false,
        effect: config.effect ?? 'unknown',
        projectScoped: Boolean(config.projectScope),
        ...(endpointOrigin ? { endpointOrigin } : {}),
        status: facts.status,
        toolCount: facts.toolCount,
        ownedBy: 'inkstone'
      })
    }
    const probe = resolvePi({ override: this.piBin })
    const version = probe.home ? await readFile(join(probe.home, 'package.json'), 'utf8').then(text => JSON.parse(text).version as string).catch(() => undefined) : undefined
    return { skills, servers, nativeMcpAvailable: nativePiToolsSupported(version) && commands.some(command => command.name === 'mcp'), configWarning: Boolean(this.mcpConfigError) }
  }

  /**
   * 设置页对本次会话技能的操作：保留到「我的技能」或从会话移除。
   * 只认当前会话的 index 里登记过的名字；保留后在新会话启动时由 `--skill` 加载。
   */
  async sessionSkillAction(action: 'promote' | 'remove', name: string): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: '当前没有会话' }
    try {
      if (action === 'remove') return { ok: await removeSessionSkill(YAN_DIR, sessionId, name) }
      await promoteSessionSkill(YAN_DIR, sessionId, name, this.bundledSkills.map((path) => basename(dirname(path))))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 只在用户明确点击「检查」时连接并刷新 MCP 工具表。
   *
   * 托管服务不得走 legacy 连接（否则是第二持有者）：先对账旧残留，再在同一
   * `McpAppHost` 单例上 `reconcile` + `listToolsWithMeta`，项目身份取真实 runner
   * 的 `capabilityProjectId`，不从 `config.projectScope` 伪造 caller。
   */
  async verifyCapabilityMcp(serverId: string) {
    const access = this.settingsSafeAccess()
    const managed = await this.reconcileLegacyForManaged(serverId)
    if (managed.managed) {
      return verifyManagedServer(access, serverId, this.capabilityOpts?.projectId)
    }
    const manager = this.mcpConnectionManager()
    await this.closeRetiredMcpManagers()
    if (!manager.listServerIds().includes(serverId)) throw new Error('当前 runner 没有这个 MCP 服务')
    const tools = await manager.listToolsCached(serverId, { refresh: true })
    return { status: manager.statusOf(serverId).status, toolCount: tools.length }
  }

  /**
   * 只断开该 runner 的一个已登记服务；可用于中止握手或工具表刷新。
   * 托管项只断 host 里该 server 的连接，**不 close 整个连接池**。
   */
  async disconnectCapabilityMcp(serverId: string): Promise<boolean> {
    const access = this.settingsSafeAccess()
    const managed = await this.reconcileLegacyForManaged(serverId)
    if (managed.managed) return disconnectManagedServer(access, serverId, this.capabilityOpts?.projectId)
    return this.mcpConnectionManager().disconnect(serverId)
  }

  /** 设置页的手动目录搜索；继续复用模型 CLI 的脱敏、限额与候选缓存规则。 */
  async discoverCapabilitiesForSettings(queryText: string) {
    const result = await this.acquisition.runCapabilitiesDiscover({ queryText })
    const rawData = result.data
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      throw new CapabilityCommandError('capability_discovery_invalid', '能力目录返回的数据格式无效，请重试')
    }
    const candidateData = rawData as Record<string, unknown>
    if (typeof candidateData.query !== 'string' || !Array.isArray(candidateData.sources) || !Array.isArray(candidateData.candidates)) {
      throw new CapabilityCommandError('capability_discovery_invalid', '能力目录返回的数据格式无效，请重试')
    }
    const data = candidateData as {
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
    const sourceIds = new Set(['github-skills', 'npm-registry', 'mcp-registry', 'skill-directory'])
    return {
      query: data.query,
      reason: data.candidates.length === 0 && data.reason
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
  /**
   * `mcp.app.call`：托管 MCP 工具的模型代理通道。
   * owner 取本实例绑定的 (sessionId, projectId)，不接受请求自报；
   * 端点已按同样两值鉴权，这里再钉到具体 runner 身份上。
   */
  private async runMcpAppCommand(
    command: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CapabilityCommandResult> {
    const sessionId = this.capabilityOpts?.sessionId
    const projectId = this.capabilityOpts?.projectId
    if (!sessionId || !projectId) {
      throw new CapabilityCommandError('mcp_app_owner_unavailable', '宿主 runner 身份不可用，拒绝托管 MCP 代理调用')
    }
    return runMcpAppProxyCommand({
      command: command.slice('mcp.app.'.length),
      params,
      owner: {
        sessionId,
        projectId,
        ...(this.capabilityOpts?.runnerGeneration !== undefined ? { epoch: this.capabilityOpts.runnerGeneration } : {})
      },
      ...(signal ? { signal } : {})
    })
  }

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

    /*
     * 托管服务：call / describe 都不得借旧连接管理器再建一条连接（第二持有者）。
     * 这里不满足于「只拦 app-only」——模型可见的工具也一律打回代理通道，
     * 由 mcp.app.call 走宿主同一条连接。fail closed，不建第二条连接。
     */
    assertLegacyMcpAccessBlocked({ serverId, toolName, action })
    const manager = this.mcpConnectionManager()
    const migratedToNative = manager.list().find((entry) => entry.id === serverId)?.migratedToNative
    if (migratedToNative) {
      throw new CapabilityCommandError('mcp_migrated_to_native', migratedMcpCommandNotice(serverId, migratedToNative))
    }
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
      const entries = await this.sessionEntriesLite()
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
      const snapshot = await this.readAgentProfileSnapshot()
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
  private async readAgentProfileSnapshot(): Promise<{ profile: AgentProfileKind; activity: AgentActivity } | null> {
    const key = this.capabilityOpts?.sessionId
    if (!key) return null
    try {
      const raw = JSON.parse(await readFile(agentProfileSnapshotPath(key), 'utf8')) as Record<string, unknown>
      if (!isAgentProfileKind(raw.profile) || !isAgentActivity(raw.activity)) return null
      return { profile: raw.profile, activity: raw.activity }
    } catch {
      return null
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
    const next: SessionState = { ...this.state }
    delete next.contextPolicy
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
    this.push({ ch: 'state', payload: this.state })
  }

  /* ---------------------------------------------------------------- 事件 */

  /**
   * 事件到达时的运行上下文（v3 WP-10）。
   *
   * 会话尚未建立（`pending:`）时返回 null —— 那时还没有可归属的真实会话，
   * 不猜、不登记。模型 / 标题 / 会话文件都是当时快照，事件不会被套用后来的身份。
   */
  private runObserverContext(): RunObserverContext | null {
    const sessionId = this.state?.sessionId
    if (!sessionId || sessionId.startsWith('pending:')) return null
    const model = this.state?.model
    return {
      sessionId,
      ...(this.state?.sessionFile ? { sessionPath: this.state.sessionFile } : {}),
      ...(this.state?.sessionName ? { title: this.state.sessionName } : {}),
      ...(model
        ? {
            model: {
              provider: model.provider,
              id: model.id,
              label: model.name,
              ...(this.state?.thinkingLevel ? { thinking: this.state.thinkingLevel } : {})
            }
          }
        : {})
    }
  }

  /**
   * pi 事件旁路 → run signals（只读）。
   *
   * 只读原始事件、只提取状态类字段；不复制消息 / 工具原始输出，
   * 也不改变下面 switch 的任何分支。会话切换的推送抑制窗口内一并跳过，
   * 避免旧会话的迟到事件被归到新会话。
   */
  private emitRunSignals(evt: Record<string, unknown>, type: string): void {
    const sink = this.runObserver
    if (!sink || this.suppressPush) return
    const ctx = this.runObserverContext()
    if (!ctx) return
    const now = Date.now()
    for (const signal of signalsFromPiEvent(evt, now)) sink(ctx, signal)
    /* 队列变化只影响「排队」阶段，单独映射（registry 侧还看当前是否已有运行）。 */
    if (type === 'queue_update') {
      const queued = signalFromQueueUpdate(evt)
      if (queued) sink(ctx, queued)
    }
  }

  /**
   * 扩展界面请求 / 答复、生成标题旁路：直接用正式请求封套与 id，不另造请求。
   *
   * `ui-request` 只映射需要应答的对话类（select / confirm / input / editor）；
   * `ui-resolved`（含拒绝、超时、远程答复）一律归还运行态；
   * `session-title` 用**它自己的** sessionId 与标题更新运行标题，不用当前会话猜。
   */
  private observeRunPush(msg: MainPush): void {
    const sink = this.runObserver
    if (!sink) return
    if (msg.ch === 'ui-request') {
      const signal = runSignalFromUiRequest(msg.payload as unknown as Record<string, unknown>)
      if (!signal) return
      const ctx = this.runObserverContext()
      if (ctx) sink(ctx, signal)
      return
    }
    if (msg.ch === 'ui-resolved') {
      const ctx = this.runObserverContext()
      if (ctx) sink(ctx, runSignalFromUiResolved(msg.payload.id))
      return
    }
    if (msg.ch === 'session-title' && msg.payload.sessionId) {
      sink(
        { sessionId: msg.payload.sessionId, title: msg.payload.title },
        { type: 'title', title: msg.payload.title }
      )
    }
  }

  private handleEvent(evt: Record<string, unknown>): void {
    const type = String(evt.type ?? '')
    /* 先旁路归约运行状态：与下面的 UI 投影完全独立，失败也不影响它。 */
    this.emitRunSignals(evt, type)

    switch (type) {
      /* ---- 助手消息：开始 ---- */
      case 'message_start': {
        const m = evt.message as PiMessage | undefined
        if (m?.role === 'user') {
          const norm = normalizeMessage(m, this.messages.length)
          if (norm) {
            /*
             * 同一 native run 内消费官方子代理通知。
             *
             * pi 在正忙时把 `followUp` 放进 `followUpQueue`，由同一个 `runLoop`
             * `continue` 消费（见 vendor chunk-TJXZSVTD.js）—— 不新开 `agent_start`，
             * 所以宿主唯一的 turn 重置点不会触发，旧段与新段会被当成同一段累计
             * elapsed / 归属消息。这里在把通知 push 之前，先为上一个已结束段封口
             * （`persist(true)` 冻结 final 与 elapsed），再起一段独立计时。
             * 普通用户 steer / followUp 不触发，保持原行为。
             */
            if (isSubagentNotice(norm.text) && this.turn.messageIds.length > 0) {
              this.finishTimingSegmentForNotice()
            }
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
            this.consumeQueued(norm.text, imagesOf(m.content) ?? [])
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
          /*
           * 原生 `turn_start` 已先到 → 用它的单调时刻作为这次请求的 GT 起点
           * （含请求准备 / 网络等待 / provider 内部重试）；没拿到就回退到本条
           * `message_start` 的流下限，只当 duration 的下限，不伪造 TTFT。
           */
          const requestStartMono = this.pendingRequestMono
          this.pendingRequestMono = undefined
          this.streaming = {
            id,
            text: '',
            thinking: '',
            responseDetail: this.turn.responseDetail,
            tools: [],
            startedAt: Date.now(),
            generationStartedMono: requestStartMono ?? performance.now(),
            ...(requestStartMono !== undefined ? { requestStartEvent: 'turn_start' as const } : {}),
            // 增量游标从 0 开始（渲染端拿到的 msg-add 里 text 也是空）
            pushedText: 0,
            pushedThinking: 0
          }
          /* 每条 assistant 消息独立检测；上一次 abort 尚未收尾时不重置去重标记。 */
          this.streamLoopDetector = createStreamLoopDetector()
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
        const u = toUsage(evt.usage as PiMessage['usage'], this.state?.model?.id)
        if (u) this.streaming.usage = u

        // 首个内容 delta 到达 → 记下首包时间（算速率时排除排队与首包延迟）
        if (
          !this.streaming.firstTokenAt &&
          (kind === 'text_delta' || kind === 'thinking_delta' || kind === 'toolcall_start')
        ) {
          this.streaming.firstTokenAt = Date.now()
        }
        /*
         * 每次模型请求的 TTFT 口径与速率的 `firstTokenAt` 不同：只认**非空**内容。
         * `text_delta` / `thinking_delta` 可能先来一个空 delta；把它当首包会让
         * TTFT 偏小、decodeMs 偏大。toolcall_start 本身就是一个内容块，直接算。
         */
        if (!this.streaming.firstContentMono) {
          const delta = String(ev.delta ?? '')
          const realContent =
            kind === 'toolcall_start' ||
            ((kind === 'text_delta' || kind === 'thinking_delta') && delta.length > 0)
          if (realContent) this.streaming.firstContentMono = performance.now()
        }

        if (kind === 'thinking_start') {
          this.streaming.thinkingStartedAt = Date.now()
          this.streaming.thinkingLive = true
        } else if (kind === 'thinking_delta') {
          const delta = String(ev.delta ?? '')
          this.streaming.thinking += delta
          /* 只观察增量文本；命中后由 stopForLoopGuard 决定是否中止。 */
          this.checkStreamLoop('thinking', delta)
          this.markDirty()
        } else if (kind === 'thinking_end') {
          const started = this.streaming.thinkingStartedAt
          if (started) this.streaming.thinkingMs = Date.now() - started
          this.streaming.thinkingLive = false
          this.markDirty()
        } else if (kind === 'text_delta') {
          const delta = String(ev.delta ?? '')
          this.streaming.text += delta
          this.checkStreamLoop('text', delta)
          this.markDirty()
        } else if (kind === 'toolcall_start') {
          this.streaming.toolOpen = true
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
              if (/[}\]]\s*$/.test(last.argsRaw)) last.args = JSON.parse(last.argsRaw)
            } catch {
              /* 还没流完，正常 */
            }
          }
        } else if (kind === 'toolcall_end') {
          this.streaming.toolOpen = false
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
        /* 这次模型请求的终点：取事件处理开始的单调时刻，不被后面的推送开销拖长。 */
        const endedMono = performance.now()
        this.streaming = null
        /* 消息结束：本条的检测器作废，迟到的命中不再作用于下一条消息。 */
        this.streamLoopDetector = null
        // 这一条消息的工具从此属于历史消息 —— 索引要落到 id 上（渲染端也会收到全量快照）
        for (const c of s.tools) this.registerCall(c, id)

        // 以 message_end 的 usage 为准（流式期间的可能是 0 或旧值）
        const finalUsage = toUsage(m.usage, m.model ?? this.state?.model?.id) ?? s.usage
        if (typeof finalUsage?.output === 'number' && finalUsage.output > 0) {
          /* 累积值：取最大，不相加（相加会把同一轮的中间快照重复计入） */
          this.turn.outputTokens = Math.max(this.turn.outputTokens ?? 0, finalUsage.output)
        }
        const sp = this.speedOf({ ...s, usage: finalUsage }, Date.now(), this.turn.startedAt)
        /* 本次模型请求的用时（单调口径）；没有首个内容时只有 durationMs。 */
        const genTiming = this.generationTimingOf(s, endedMono)
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
          ...(genTiming ? { generationTiming: genTiming } : {}),
          responseDetail: s.responseDetail,
          model: assistantModelIdentity(m),
          timestamp: m.timestamp ?? Date.now(),
          error: assistantError(m)
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
        if (m.stopReason === 'error' || m.stopReason === 'aborted') this.sessionMoveFailureVersion += 1
        if (m.stopReason === 'error') {
          /*
           * 模型侧错误（实施-05 S5c）：宿主据此决定要不要自动继续。
           * message_end 的 errorMessage 保留服务商原因，不能只转发 stopReason。
           */
          this.push({
            ch: 'agent-error',
            payload: { message: modelErrorNotice(m.errorMessage), text: modelErrorText(m.errorMessage), source: 'stop-reason' }
          })
          /* 失败也是终止原因：不能落盘成「正常完成」（H-6）。 */
          this.turn.terminal = 'failed'
        } else if (m.stopReason === 'aborted' && this.turn.terminal === 'interrupted') {
          this.loopGuardAbortedMessage = this.loopGuardAbortSent
          /*
           * 权威收尾：只有真的收到 aborted 才提示「已终止」——
           * RPC command success 不等于 settled。
           */
          this.push({
            ch: 'notify',
            payload: {
              id: `loop-guard-${Date.now()}`,
              method: 'notify',
              notifyType: 'warning',
              message: `已按流式防护终止本次生成（${this.loopGuardHit?.rule ?? 'stream-loop'}）。会话可继续，本次任务尚未完成。`
            }
          })
          this.logStreamLoopGuard('settled', { rule: this.loopGuardHit?.rule, stream: this.loopGuardHit?.stream, outcome: 'aborted-stream' })
        } else if (m.stopReason === 'aborted' && this.turn.terminal !== 'stopped') {
          /*
           * 请求被中止但不是用户点的停止（abort() 会先把 terminal 标成 stopped）：
           * 回复往往是空的，不提示的话界面看起来就是“发了没反应”。
           */
          this.push({
            ch: 'agent-error',
            payload: { message: modelErrorNotice(m.errorMessage ?? 'Request aborted'), text: modelErrorText(m.errorMessage ?? 'Request aborted'), source: 'stop-reason' }
          })
        }
        this.markStreaming(false)
        break
      }

      /* ---- 工具执行 ---- */
      case 'tool_execution_start': {
        const call = this.findOrCreateCall(
          String(evt.toolCallId ?? ''),
          String(evt.toolName ?? 'tool'),
          evt.args,
          typeof evt.parentToolCallId === 'string' ? evt.parentToolCallId : undefined
        )
        call.status = 'running'
        call.startedAt = Date.now()
        if (isWriteTool(call.name) || isShellTool(call.name)) this.wroteThisRun = true
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
      case 'turn_start':
        /*
         * 每次模型请求前 pi 的原生起点：暂存给该请求的 assistant `message_start`
         * 消费（见 pendingRequestMono）。重复 turn_start 直接覆盖成最新一次。
         */
        this.pendingRequestMono = performance.now()
        break

      case 'agent_start':
        this.wroteThisRun = false
        this.turn.responseDetail = this.currentResponseDetail()
        /* 每个 pi 回合一个 run id（H-6b）：自动继续会开新 run、归同一个逻辑回合。 */
        this.startTimingSegment()
        /* 新 run 的原生 turn_start 随后到达；清掉上一 run 残留避免跨 run 串起点。 */
        this.pendingRequestMono = undefined
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled': {
        // aborted 消息与 settled 都到达才有资格继续。
        const continuation = this.loopGuardAbortSent && this.loopGuardAbortedMessage && this.rpc && this.state?.sessionId
          ? { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardResumeVersion }
          : null
        if (this.loopGuardHit) this.logStreamLoopGuard('settled', { rule: this.loopGuardHit.rule, stream: this.loopGuardHit.stream, outcome: 'agent-settled' })
        this.streamLoopDetector = null
        this.loopGuardTripped = false
        this.loopGuardAbortSent = false
        this.loopGuardStopping = false
        this.loopGuardAbortedMessage = false
        this.loopGuardHit = undefined
        this.markStreaming(false)
        this.setAgentRunning(false)
        this.turn.startedAt = undefined
        this.turn.startedMono = undefined
        this.pendingRequestMono = undefined
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
        if (continuation) {
          const task = this.continueAfterLoopGuard(continuation)
          this.loopGuardContinueTask = task
          void task.finally(() => {
            if (this.loopGuardContinueTask === task) this.loopGuardContinueTask = undefined
          }).catch(() => undefined)
        }
        break
      }

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
         * 不能把仍会继续的逻辑回合提前冻结成终态（但重试会重新 emit
         * agent_start + turn_start，所以这里清起点是安全的）。
         */
        this.pendingRequestMono = undefined
        if (evt.willRetry !== true) {
          this.streamLoopDetector = null
          // abort 的确认标记保留到 agent_settled，不能在较早的 agent_end 解锁新消息。
          void this.persistTurnTiming()
        }
        void this.refreshStats()
        break

      case 'queue_update':
        /* 暂存闸门期间最后一帧；退出闸门后再应用，避免权威事件丢失。 */
        const update = {
          steering: Array.isArray(evt.steering) ? (evt.steering as string[]) : [],
          followUp: Array.isArray(evt.followUp) ? (evt.followUp as string[]) : [],
          sessionId: this.state?.sessionId,
          generation: this.capabilityOpts?.runnerGeneration
        }
        if (this.queueBusy) this.pendingQueueUpdate = update
        else this.publishQueue(update.steering, update.followUp)
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

      case 'auto_retry_start': {
        /* 流式防护已中止的 run 不允许被自动重试复活成同一次重复流。 */
        if (this.loopGuardAbortSent) {
          this.push({
            ch: 'notify',
            payload: {
              id: `retry-loop-guard-${Date.now()}`,
              method: 'notify',
              notifyType: 'warning',
              message: '已按流式防护停止本次生成，不再自动重试。'
            }
          })
          void this.abortRetry()
          break
        }
        /*
         * 套餐 / 窗口用量用尽再等一下也不会好：pi 把
         * “You have hit your ChatGPT usage limit (plus plan). Try again in ~31 min.”
         * 这类 429 归为**可重试**（它的终局判定表只认 monthly usage limit /
         * insufficient_quota / billing 等写法），于是照着服务端给的重试间隔一直等，
         * 界面上就是额度到限后长时间空转（用户实测挂到几十分钟）。
         *
         * 这里不再等：识别到“额度用尽”就直接停掉这次等待，把决定权交回用户 ——
         * 真想等的人可以在错误卡上选「额度恢复后继续」（那是明确要等，与重试不同）。
         */
        const retryError = modelErrorText(evt.errorMessage ?? evt.error)
        if (isQuotaWaitError(retryError)) {
          this.push({
            ch: 'notify',
            payload: {
              id: `retry-quota-${Date.now()}`,
              method: 'notify',
              notifyType: 'warning',
              message: `模型额度已到限，已停止自动重试。${modelErrorNotice(retryError)}`
            }
          })
          void this.abortRetry()
          break
        }
        this.push({
          ch: 'notify',
          payload: {
            id: `retry-${Date.now()}`,
            method: 'notify',
            notifyType: 'warning',
            message: `${modelErrorNotice(evt.errorMessage ?? evt.error)} 第 ${Number(evt.attempt ?? 1)} 次重试…`
          }
        })
        break
      }

      case 'auto_retry_end':
        if (evt.success === false) {
          const finalError = modelErrorText(evt.finalError)
          this.push({
            ch: 'notify',
            payload: {
              id: `retry-fail-${Date.now()}`,
              method: 'notify',
              notifyType: 'error',
              message: `重试失败，本轮结束。${modelErrorNotice(finalError)}`
            }
          })
          /* pi 的重试已用尽；把错误文本交给宿主（自动继续要靠它做分类，S5c） */
          this.push({
            ch: 'agent-error',
            payload: { message: modelErrorNotice(finalError), text: finalError, source: 'auto-retry' }
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

  private findOrCreateCall(id: string, name: string, args: unknown, parentToolCallId?: string): UIToolCall {
    const existing = this.findCall(id)
    if (existing) return existing

    const call: UIToolCall = { id, name, args, parentToolCallId, status: 'running', startedAt: Date.now() }
    const parent = parentToolCallId ? this.findCall(parentToolCallId) : undefined
    const parentOwner = parent ? this.ownerOf(parent) : undefined
    const parentMessage = parentOwner ? this.messages.find(message => message.id === parentOwner) : undefined
    if (parentMessage) {
      (parentMessage.toolCalls ??= []).push(call)
      this.registerCall(call, parentMessage.id)
    } else if (this.streaming) {
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
   * 模型增量维持一帧节奏；独立bash输出仍保留自适应限频。
   */
  private flushDelay(): number {
    if (this.streaming) return FLUSH_MS
    const len = this.bash?.output.length ?? 0
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
    const genTiming = this.generationTimingOf(s)
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
          elapsedMs: sp.elapsedMs,
          /* 请求用时逐帧更新；无首内容时只有 durationMs，不编 TTFT / decode。 */
          ...(genTiming ? { generationTiming: genTiming } : null)
        }
      }
    })
  }

  /**
   * 起一段新的计时片段：重置段内累计并换独立 run 标识。
   *
   * 两个调用点共用：`agent_start`（新 native run）与同一 native run 内消费
   * 官方子代理通知（旧段封口后）。只做字段归零，不动 pi 的 isRunning / 队列。
   */
  private startTimingSegment(): void {
    this.turn.startedAt = Date.now()
    this.turn.startedMono = performance.now()
    this.turn.messageIds = []
    this.turn.terminal = 'completed'
    this.turn.elapsedMs = undefined
    this.turn.outputTokens = undefined
    this.turn.persisted = false
    this.turn.runSeq += 1
    this.turn.runId = `run-${this.turn.runSeq}-${Date.now().toString(36)}`
  }

  /**
   * 同一 native run 内收到官方子代理通知时的段边界：先把上一段冻结成 final
   * （锚在通知前最后一条真实 user 上），再起新片段。
   *
   * `persist(true)` 在 await 前同步构造记录（anchor / sourceIds /
   * generationTimings / elapsed 是旧段的快照），所以这里不 await 也不会被随后的
   * 重置污染；`pendingRequestMono` 不清 —— 上一条 native `turn_start` 属于
   * 通知后的新请求。
   */
  private finishTimingSegmentForNotice(): void {
    void this.turn.persist(true, this.state?.sessionFile, this.messages)
    this.startTimingSegment()
  }

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

  /**
   * 算输出速率（token/秒）与整轮用时。
   *
   * 口径本身在 `shared/turn-timing.ts`（纯函数、有单测）：速度用
   * 「首个内容 token 到达」，整轮用时用 agent 回合起点，所以工具往返与重试
   * 只进后者。这里只是把流式对象里的字段喂进去，不重复实现算法。
   */
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

  /**
   * 本次模型请求的生成用时。流式期间也给实时值（`durationMs` 随帧增长，
   * 有首个真正内容后才有 `ttftMs` / `decodeMs`），终点默认取当前时刻。
   */
  private generationTimingOf(
    s: { generationStartedMono?: number; firstContentMono?: number; requestStartEvent?: 'turn_start' },
    endedMono = performance.now()
  ): GenerationTiming | undefined {
    if (s.generationStartedMono === undefined) return undefined
    const g = generationTiming({
      startedMono: s.generationStartedMono,
      endedMono,
      firstContentMono: s.firstContentMono,
      ...(s.requestStartEvent ? { startEvent: s.requestStartEvent } : {})
    })
    if (!g) return undefined
    /* 有原生 turn_start：duration / ttft 都从请求准备起点算，带标记。 */
    if (g.startEvent === 'turn_start') return g
    /*
     * 回退到流下限（没拿到原生 turn_start）：duration / decode 仍是真实测得的
     * 下限，但不保存 TTFT —— 它不含请求准备与网络等待，拿去当「请求首包延迟」
     * 参与会话平均就是伪造。
     */
    return {
      durationMs: g.durationMs,
      ...(g.decodeMs !== undefined ? { decodeMs: g.decodeMs } : {})
    }
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
    /*
     * 回合真正结束才归还执行入场 claim；队列里还有下一棒时继续持有，
     * 避免两拍之间放第二个同 cwd runner 进场写同一工作树。
     */
    if (!v && this.state.isStreaming !== true && this.state.isCompacting !== true &&
      !this.queueState.steering.length && !this.queueState.followUp.length) {
      this.releaseExecutionAdmission()
    }
  }

  /* ------------------------------------------------------ 执行入场 claim */

  /** 本实例是否还有正在执行的工作（回合 / 流 / 压缩 / 直执行 bash）。 */
  private executionActive(): boolean {
    return this.agentRunning || this.state?.isStreaming === true || this.state?.isCompacting === true || this.bash != null
  }

  /**
   * 同步取执行入场 claim；同实例重入直接复用已有 token（自己的插话 / 排队不被自己拦）。
   * 没有注入口（纯测试 / 旧调用）时视为放行。
   */
  private claimExecutionAdmission(): { ok: true } | { ok: false; error: string } {
    const port = this.capabilityOpts?.execution
    if (!port) return { ok: true }
    if (this.executionAdmissionToken !== undefined) return { ok: true }
    const claim = port.claim()
    if (!claim.ok) return claim
    this.executionAdmissionToken = claim.token
    return { ok: true }
  }

  /** 真正入队前再核一次：claim 已换代 / 被别的实例占用就拒绝。 */
  private confirmExecutionAdmission(): boolean {
    const port = this.capabilityOpts?.execution
    const token = this.executionAdmissionToken
    if (!port || token === undefined) return true
    return port.confirm(token)
  }

  private releaseExecutionAdmission(): void {
    const token = this.executionAdmissionToken
    this.executionAdmissionToken = undefined
    if (this.executionAdmissionTimer) {
      clearTimeout(this.executionAdmissionTimer)
      this.executionAdmissionTimer = undefined
    }
    if (token !== undefined) this.capabilityOpts?.execution?.release(token)
  }

  /**
   * 一次执行调用收尾时处理 claim：还在跑就保留（等 setAgentRunning(false)），
   * 已空闲则给一小段宽限，确认没有晚到的 `agent_start` 再释放。
   */
  private settleExecutionAdmission(): void {
    if (this.executionAdmissionToken === undefined) return
    if (this.executionActive()) return
    if (this.executionAdmissionTimer) clearTimeout(this.executionAdmissionTimer)
    this.executionAdmissionTimer = setTimeout(() => {
      this.executionAdmissionTimer = undefined
      if (!this.executionActive()) this.releaseExecutionAdmission()
    }, EXECUTION_ADMISSION_GRACE_MS)
    this.executionAdmissionTimer.unref?.()
  }

  private markStreaming(v: boolean): void {
    if (!this.state) return
    if (this.state.isStreaming === v) return
    this.state = { ...this.state, isStreaming: v }
    this.push({ ch: 'state', payload: this.state })
  }

  /** Project native compaction events without rewriting their origin. */
  private setCompaction(cur: CompactionState, evt: Record<string, unknown>): void {
    const next = reduceCompaction(cur, evt)
    if (!next) return
    this.compactionState = next
    if (!this.state) return
    this.state = { ...this.state, compaction: next.running ?? undefined, lastCompaction: next.last ?? undefined }
    this.push({ ch: 'state', payload: this.state })
  }

  /* ------------------------------------------------------ 流式重复防护 */

  /** 首版默认开启；`YAN_STREAM_LOOP_GUARD=0` 关闭，出现误报时可直接回退。 */
  private streamLoopGuardEnabled(): boolean {
    return process.env.YAN_STREAM_LOOP_GUARD !== '0'
  }

  /**
   * 只观察 thinking/text 增量；命中后交由 `stopForLoopGuard` 处理。
   * 工具参数流不参与统计，且工具块未闭合时即使命中也不熔断。
   */
  private checkStreamLoop(kind: 'thinking' | 'text', delta: string): void {
    const detector = this.streamLoopDetector
    if (!detector || !delta) return
    if (this.loopGuardTripped || this.loopGuardAbortSent) return
    if (!this.streamLoopGuardEnabled()) return
    const hit = kind === 'thinking' ? detector.onThinking(delta) : detector.onText(delta)
    if (!hit) return
    if (this.streaming?.toolOpen) {
      /* 参数还在生成：宁可漏报，也不在半截工具参数上切断。 */
      this.logStreamLoopGuard('break-suppressed', {
        rule: hit.rule, stream: kind, emittedChars: hit.emittedChars, repeatedChars: hit.repeatedChars,
        reason: 'tool-block-open', outcome: 'suppressed'
      })
      return
    }
    this.loopGuardStopTask = this.stopForLoopGuard(hit, kind)
  }

  /**
   * 流式重复熔断：与人工 `abort()` 分开的专用底层流程。
   *
   * 边界：
   *   · 不调用人工停止入口，不提前把 streaming / agentRunning 置 false、不伪造 completed；
   *   · 经 `queueRun` 串行 `clear_queue`，把原文、顺序与身份经
   *     `queue-reclaimed` 推回渲染端；含图片或 clear 失败则不自动 abort，仅告警保留；
   *   · terminal 记 `interrupted`，由 pi 的权威 `message_end` / `agent_settled` 收尾；
   *   · 同一 run 至多触发一次，事件重复到达只写一条日志。
   */
  private async stopForLoopGuard(hit: LoopHit, stream: 'thinking' | 'text'): Promise<void> {
    const target = this.streaming
    const rpc = this.rpc
    const sessionId = this.state?.sessionId
    const generation = this.capabilityOpts?.runnerGeneration
    const runId = this.turn.runId
    const messageId = target?.id
    if (!target || !rpc || !sessionId || this.loopGuardTripped || this.loopGuardAbortSent) return
    const record = (event: string, fields: Record<string, unknown>) =>
      this.logStreamLoopGuard(event, { sessionId, generation, runId, ...fields })
    this.loopGuardTripped = true
    this.loopGuardResumeVersion = this.loopGuardContinuationVersion
    this.loopGuardAbortedMessage = false
    this.loopGuardHit = { rule: hit.rule, stream }
    record('break-requested', {
      rule: hit.rule, stream, emittedChars: hit.emittedChars, repeatedChars: hit.repeatedChars,
      messageId, action: 'clear-queue-then-abort', outcome: 'pending'
    })

    const ownsRun = () => this.rpc === rpc && this.state?.sessionId === sessionId &&
      this.capabilityOpts?.runnerGeneration === generation && this.turn.runId === runId
    const canStop = () => ownsRun() && this.streaming === target && this.turn.terminal !== 'stopped'
    this.loopGuardStopping = true
    try {
      // 即使当前镜像为空，也须排在所有已发起的入队/编辑操作之后。
      await this.queueRun(async () => {
        if (!canStop()) return
        const original = this.queueState
        // 后台草稿缓存不保存图片。不能为自动熔断丢附件，首版有图片时仅告警。
        if ([...original.steering, ...original.followUp].some(item => item.images?.length)) {
          throw new Error('排队内容含图片，自动回填不能保证后台附件完整，请手动停止并收回')
        }
        const result = await rpc.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        if (!result.success || !result.data || !Array.isArray(result.data.steering) || !Array.isArray(result.data.followUp)) {
          throw new Error(result.error || 'clear_queue 未返回可确认的队列快照')
        }
        const reclaimed = snapshotQueue({
          steering: this.queueItems(result.data.steering, original.steering),
          followUp: this.queueItems(result.data.followUp, original.followUp)
        })
        if (ownsRun()) this.resetQueue(true)
        // clear 已生效，即使消息自然结束也必须归还；显式归属避免迟到事件投到新会话。
        if (reclaimed.steering.length || reclaimed.followUp.length) {
          this.push({ ch: 'queue-reclaimed', payload: { ...reclaimed, sessionId } })
          record('queue-reclaimed', { rule: hit.rule, stream, messageId, outcome: 'reclaimed' })
        }
        if (!canStop()) {
          record('stale-before-abort', { rule: hit.rule, stream, messageId, outcome: 'stale' })
          return
        }
        this.loopGuardAbortSent = true
        this.turn.terminal = 'interrupted'
        this.push({ ch: 'notify', payload: {
          id: `loop-guard-${Date.now()}`, method: 'notify', notifyType: 'warning',
          message: `检测到模型输出重复（${hit.rule}），正在终止本次生成；会话可继续，本次任务尚未完成。`
        } })
        const response = await rpc.command('abort')
        if (!response.success) throw new Error(response.error || 'abort 失败')
        record('abort-acknowledged', { rule: hit.rule, stream, messageId, outcome: this.agentRunning ? 'pending-settle' : 'settled-before-ack' })
      }, true)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      record('stop-failed', { rule: hit.rule, stream, messageId, detail, outcome: 'unconfirmed' })
      if (ownsRun()) {
        this.push({ ch: 'notify', payload: {
          id: `loop-guard-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: `检测到模型输出重复（${hit.rule}），但未能确认终止（${detail}）。请手动决定，不会自动续跑。`
        } })
        // 失败不能永久锁住人工处置；检测仍在本 run 去重，不再次自动尝试。
        this.loopGuardAbortSent = false
        this.loopGuardContinuationVersion += 1
        if (this.turn.terminal === 'interrupted') this.turn.terminal = 'failed'
      }
    } finally {
      if (ownsRun()) this.loopGuardStopping = false
    }
  }

  /** 桌面开关不改 pi 原生 settings/context。 */
  private async readStreamLoopAutoContinue(): Promise<boolean> {
    return (await getSettings()).streamLoopAutoContinue !== false
  }

  private canContinueAfterLoopGuard(scope: {
    rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number
  }): boolean {
    return !this.stopping && this.rpc === scope.rpc && this.state?.sessionId === scope.sessionId &&
      this.capabilityOpts?.runnerGeneration === scope.generation && this.turn.runId === scope.runId &&
      this.loopGuardContinuationVersion === scope.version && !this.agentRunning && !this.streaming &&
      !this.state?.isCompacting && !this.loopGuardStopping && !this.loopGuardAbortSent &&
      !this.queueState.steering.length && !this.queueState.followUp.length
  }

  /** 原记录不删改，通过原生 prompt 追加可见的一次恢复指令。 */
  private async continueAfterLoopGuard(scope: {
    rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number
  }): Promise<void> {
    try {
      await this.loopGuardStopTask
      if (!this.canContinueAfterLoopGuard(scope) || !(await this.readStreamLoopAutoContinue())) return
      if (!this.canContinueAfterLoopGuard(scope)) return
      if (this.loopGuardAutoContinueCount >= 1) {
        this.logStreamLoopGuard('auto-continue-limit', { sessionId: scope.sessionId, runId: scope.runId, outcome: 'not-resumed' })
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'warning',
          message: '自动继续后再次检测到循环，已停止；同一任务最多自动续一次，请手动决定。' } })
        return
      }
      const prompt = '[循环恢复 · 自动继续 1/1]\n上一轮因输出重复被安全中止。请核对已完成的工具结果，在当前会话继续尚未完成的原任务；不要复述循环内容或空转宣称调用工具。回收的排队消息不在本次续跑范围内。若原任务已完成、需要用户决定或无法安全继续，请简短说明并结束。'
      const result = await this.send(prompt, undefined, undefined, scope)
      if (!result.ok && this.loopGuardContinuationVersion === scope.version) {
        this.logStreamLoopGuard('auto-continue-failed', { sessionId: scope.sessionId, runId: scope.runId, detail: result.error, outcome: 'not-resumed' })
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: `未能自动继续（${result.error ?? '发送失败'}），请手动决定。` } })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logStreamLoopGuard('auto-continue-failed', { sessionId: scope.sessionId, runId: scope.runId, detail, outcome: 'not-resumed' })
      if (this.canContinueAfterLoopGuard(scope)) {
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: `未能自动继续（${detail}），请手动决定。` } })
      }
    }
  }

  /** 结构化防护日志：只记规则与量，不写思考 / 正文原文，也不含凭证。 */
  private logStreamLoopGuard(event: string, fields: Record<string, unknown>): void {
    const failed = event === 'stop-failed' || event === 'auto-continue-failed'
    this.push({
      ch: 'log',
      payload: {
        level: failed ? 'error' : 'info',
        text: JSON.stringify({
          type: 'stream-loop-guard',
          event,
          sessionId: this.state?.sessionId,
          generation: this.capabilityOpts?.runnerGeneration,
          runId: this.turn.runId,
          ...fields
        })
      }
    })
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
    return reconcileQueueItems(raw, previous, text => this.newQueueItem(text))
  }

  private newQueueItem(text: string, images?: QueueItem['images']): QueueItem {
    return { id: `q-${(++this.queueSequence).toString(36)}`, text,
      ...(images?.length ? { images: images.map(image => ({ ...image })) } : {}) }
  }

  /** pi 对纯图片消息不清文本镜像；已经消费的空项不能被下一帧复活。 */
  private liveQueueTexts(raw: string[], kind: 'steering' | 'followUp'): string[] {
    let skip = this.consumedEmptyQueue[kind]
    return raw.filter(text => text || skip-- <= 0)
  }

  /** 更新本地队列身份；原生先推缩短快照、后推 user 消息，记录已移除身份防止二次消费。 */
  private publishQueue(steering: string[], followUp: string[], clearing = false): QueueState {
    const next: QueueState = {
      steering: this.queueItems(this.liveQueueTexts(steering, 'steering'), this.queueState.steering),
      followUp: this.queueItems(this.liveQueueTexts(followUp, 'followUp'), this.queueState.followUp)
    }
    if (!clearing) {
      const retained = new Set([...next.steering, ...next.followUp].map(item => item.id))
      this.queueRemoved.push(...[...this.queueState.steering, ...this.queueState.followUp]
        .filter(item => !retained.has(item.id) && !this.queueConsumed.has(item.id)))
    } else this.consumedEmptyQueue = { steering: 0, followUp: 0 }
    return this.publishQueueItems(next)
  }

  private publishQueueItems(next: QueueState): QueueState {
    next = {
      steering: next.steering.filter(item => !this.queueConsumed.has(item.id)),
      followUp: next.followUp.filter(item => !this.queueConsumed.has(item.id))
    }
    this.queueState = next
    this.push({ ch: 'queue', payload: {
      steering: next.steering.filter(item => !isSubagentNotice(item.text)),
      followUp: next.followUp.filter(item => !isSubagentNotice(item.text))
    } })
    return next
  }

  /**
   * 从队列快照里摘掉一条“已经被消费”的项（D9）。
   *
   * 先 steering 后 followUp：同一个回合里 steering 会先被插进当前对话，
   * followUp 要等回合结束。两边都可能出现相同文本（用户反复发同一句），
   * 所以只摘**第一条**匹配（FIFO），剩下的等后续消息再到。
   */
  private consumeQueued(text: string, images: NonNullable<QueueItem['images']>): void {
    const removed = this.queueRemoved.findIndex(item => item.text.trim() === text.trim() && sameQueueImages(item.images, images))
    if (removed >= 0) {
      const [item] = this.queueRemoved.splice(removed, 1)
      if (this.queueBusy) this.queueConsumed.add(item.id)
      return
    }
    const next = consumeQueuedItem(this.queueState, text, images)
    if (!next) return
    const retained = new Set([...next.steering, ...next.followUp].map(item => item.id))
    for (const kind of ['steering', 'followUp'] as const) {
      for (const item of this.queueState[kind]) {
        if (retained.has(item.id)) continue
        if (this.queueBusy) this.queueConsumed.add(item.id)
        if (!item.text) this.consumedEmptyQueue[kind]++
      }
    }
    this.publishQueueItems(next)
    // 闸门内的快照可能早于本次消费，不能在 finally 把它重新加回来。
    if (this.pendingQueueUpdate && text) {
      for (const kind of ['steering', 'followUp'] as const) {
        const index = this.pendingQueueUpdate[kind].indexOf(text)
        const count = this.pendingQueueUpdate[kind].filter(value => value === text).length
        if (index >= 0 && count > next[kind].filter(item => item.text === text).length) {
          this.pendingQueueUpdate[kind].splice(index, 1)
          break
        }
      }
    }
  }

  private resetQueue(emit = false): void {
    this.queueRemoved = []
    this.queueConsumed.clear()
    this.consumedEmptyQueue = { steering: 0, followUp: 0 }
    this.pendingQueueUpdate = undefined
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

  private requireRpc(): PiRpc {
    if (!this.rpc) throw new Error('pi 尚未就绪或已经停止')
    if (this.queueScope && (this.queueScope.rpc !== this.rpc || this.queueScope.sessionId !== this.state?.sessionId || this.queueScope.generation !== this.capabilityOpts?.runnerGeneration)) throw new Error('会话已切换，队列操作已停止')
    return this.rpc
  }

  /** 发送与基于 clear_queue 的编辑共用闸门，最终投影采用同会话的末帧事件。 */
  private queueRun<T>(work: () => Promise<T>, allowLoopStop = false): Promise<T> {
    const owner = { rpc: this.rpc, sessionId: this.state?.sessionId, generation: this.capabilityOpts?.runnerGeneration }
    /* 等待闸门期间切了会话，旧操作不能落到新会话上。 */
    const guarded = async (): Promise<T> => {
      if (!allowLoopStop && (this.loopGuardStopping || this.loopGuardAbortSent)) throw new Error('正在按流式防护终止生成，暂不接受队列修改')
      if (owner.rpc !== this.rpc || owner.sessionId !== this.state?.sessionId || owner.generation !== this.capabilityOpts?.runnerGeneration) throw new Error('会话已切换，队列操作已停止')
      /* 真正入队前的第二道同步复核：claim 换代 / 被别的同 cwd 实例占用就不执行。 */
      if (!this.confirmExecutionAdmission()) throw new Error('同一工作目录的执行入场已失效，本次操作未开始')
      this.queueBusy = true
      const sessionId = this.state?.sessionId
      const generation = this.capabilityOpts?.runnerGeneration
      this.queueScope = { rpc: this.rpc, sessionId, generation }
      this.queueConsumed.clear()
      try {
        return await work()
      } finally {
        this.queueScope = undefined
        this.queueBusy = false
        const pending = this.pendingQueueUpdate
        this.pendingQueueUpdate = undefined
        if (pending && pending.sessionId === this.state?.sessionId && pending.generation === this.capabilityOpts?.runnerGeneration && sessionId === pending.sessionId && generation === pending.generation) this.publishQueue(pending.steering, pending.followUp)
        this.queueConsumed.clear()
      }
    }
    const previous = this.queueOperations
    const current = previous.then(guarded, guarded)
    this.queueOperations = current.then(() => undefined, () => undefined)
    return current
  }

  private pendingQueueUpdate?: { steering: string[]; followUp: string[]; sessionId?: string; generation?: number }

  private queuePayload(item: Pick<QueueItem, 'text' | 'images'>): Record<string, unknown> {
    return { message: item.text, ...(item.images?.length ? {
      images: item.images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
    } : {}) }
  }

  private async submitQueueCommand(command: 'prompt' | 'steer' | 'follow_up', text: string,
    images: QueueItem['images'], kind: 'steering' | 'followUp', payload: Record<string, unknown>) {
    const item = this.newQueueItem(text, images)
    const rpc = this.requireRpc()
    this.queueState = { ...this.queueState, [kind]: [...this.queueState[kind], item] }
    let queued = false
    try {
      const res = await rpc.command<{ disposition?: string }>(command, payload)
      this.requireRpc()
      queued = res.success && (!res.data?.disposition || res.data.disposition === 'queued')
      return res
    } finally {
      if (!queued && this.queueScope?.rpc === this.rpc && this.queueScope.sessionId === this.state?.sessionId) {
        this.queueState = { ...this.queueState, [kind]: this.queueState[kind].filter(value => value.id !== item.id) }
      }
    }
  }

  private async refillQueue(steering: QueueItem[], followUp: QueueItem[]): Promise<void> {
    for (const [command, items] of [['steer', steering], ['follow_up', followUp]] as const) {
      for (const item of items) {
        if (this.queueConsumed.has(item.id)) continue
        const res = await this.requireRpc().command(command, this.queuePayload(item))
        this.requireRpc()
        if (!res.success) throw new Error(res.error || '恢复队列失败')
      }
    }
  }

  /**
   * 清空后重排失败时尽力恢复原始队列。调用方会把恢复失败明确带给用户，
   * 不把“命令发出去了”伪装成成功。
   */
  private async restoreQueue(raw: QueueState): Promise<string | undefined> {
    if (!this.rpc) return 'pi 尚未就绪，无法恢复排队消息'
    try {
      const cleared = await this.requireRpc().command('clear_queue')
      this.requireRpc()
      if (!cleared.success) return cleared.error || '清空队列失败，无法恢复原顺序'
      this.consumedEmptyQueue = { steering: 0, followUp: 0 }
      const live = this.publishQueueItems(raw)
      await this.refillQueue(live.steering, live.followUp)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  async send(
    text: string,
    images?: { data: string; mimeType: string }[],
    mode?: 'steer' | 'followUp',
    autoContinue?: { rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number }
  ): Promise<{ ok: boolean; error?: string }> {
    const admission = this.claimExecutionAdmission()
    if (!admission.ok) return { ok: false, error: admission.error }
    let started = false
    try {
      const result = await this.sendAdmitted(text, images, mode, autoContinue)
      started = result.ok
      return result
    } finally {
      // 失败 / 直接被拒：立即归还；成功则保留到回合结束（或宽限后确认没启动）。
      if (started) this.settleExecutionAdmission()
      else this.releaseExecutionAdmission()
    }
  }

  private async sendAdmitted(
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
    mode?: 'steer' | 'followUp',
    autoContinue?: { rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number }
  ): Promise<{ ok: boolean; error?: string }> {
    if (!autoContinue) {
      this.loopGuardContinuationVersion += 1
      this.loopGuardAutoContinueCount = 0
    }
    if (text.trimStart().startsWith('/__inkstone_native')) return { ok: false, error: '原生内部命令只能通过桌面操作面板调用' }
    if (this.loopGuardStopping || this.loopGuardAbortSent) return { ok: false, error: '正在按流式防护终止本次生成，请稍候再发送' }
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

    return this.queueRun(async () => {
      if (autoContinue && (!(await this.readStreamLoopAutoContinue()) || !this.canContinueAfterLoopGuard(autoContinue) || this.loopGuardAutoContinueCount >= 1)) {
        return { ok: false, error: '自动继续已取消或运行归属改变' }
      }
      if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: '项目正在回退代码，请稍后发送' }
      payload.streamingBehavior = mode ?? 'followUp'
      const rpc = this.rpc
      const sessionId = this.state?.sessionId
      const generation = this.capabilityOpts?.runnerGeneration
      if (!rpc) return { ok: false, error: 'pi 尚未就绪' }
      if (autoContinue) {
        this.loopGuardAutoContinueCount += 1
        this.logStreamLoopGuard('auto-continue-requested', { sessionId: autoContinue.sessionId, runId: autoContinue.runId, count: 1, limit: 1, outcome: 'sending' })
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'info',
          message: '已安全中止循环，正在同一会话自动继续（1/1）；不会执行收回的排队草稿。' } })
      }
      const res = await this.submitQueueCommand('prompt', text, images, mode === 'steer' ? 'steering' : 'followUp', payload)
      if (!res.success) return { ok: false, error: res.error }
      if (this.rpc !== rpc || this.state?.sessionId !== sessionId || this.capabilityOpts?.runnerGeneration !== generation) return { ok: false, error: '会话已切换，发送结果未应用到当前会话' }
      await this.refreshState()
      return { ok: true }
    })
  }

  async steer(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    const admission = this.claimExecutionAdmission()
    if (!admission.ok) return { ok: false, error: admission.error }
    let started = false
    try {
      const result = await this.steerAdmitted(text, images)
      started = result.ok
      return result
    } finally {
      if (started) this.settleExecutionAdmission()
      else this.releaseExecutionAdmission()
    }
  }

  private async steerAdmitted(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    this.loopGuardContinuationVersion += 1
    this.loopGuardAutoContinueCount = 0
    if (this.loopGuardStopping || this.loopGuardAbortSent) return { ok: false, error: '正在按流式防护终止本次生成，请稍候再插话' }
    return this.queueRun(async () => {
      if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: '项目正在回退代码，请稍后插话' }
      const rpc = this.rpc, sessionId = this.state?.sessionId, generation = this.capabilityOpts?.runnerGeneration
      if (!rpc) return { ok: false, error: 'pi 尚未就绪' }
      const res = await this.submitQueueCommand('steer', text, images, 'steering', this.queuePayload({ text, images }))
      if (!res.success) return { ok: false, error: res.error }
      if (this.rpc !== rpc || this.state?.sessionId !== sessionId || this.capabilityOpts?.runnerGeneration !== generation) return { ok: false, error: '会话已切换，插话结果未应用到当前会话' }
      await this.refreshState()
      return { ok: true }
    })
  }

  async followUp(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    const admission = this.claimExecutionAdmission()
    if (!admission.ok) return { ok: false, error: admission.error }
    let started = false
    try {
      const result = await this.followUpAdmitted(text, images)
      started = result.ok
      return result
    } finally {
      if (started) this.settleExecutionAdmission()
      else this.releaseExecutionAdmission()
    }
  }

  private async followUpAdmitted(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    this.loopGuardContinuationVersion += 1
    this.loopGuardAutoContinueCount = 0
    if (this.loopGuardStopping || this.loopGuardAbortSent) return { ok: false, error: '正在按流式防护终止本次生成，请稍候再排队' }
    return this.queueRun(async () => {
      if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: '项目正在回退代码，请稍后排队' }
      const rpc = this.rpc, sessionId = this.state?.sessionId, generation = this.capabilityOpts?.runnerGeneration
      if (!rpc) return { ok: false, error: 'pi 尚未就绪' }
      const res = await this.submitQueueCommand('follow_up', text, images, 'followUp', this.queuePayload({ text, images }))
      if (!res.success) return { ok: false, error: res.error }
      if (this.rpc !== rpc || this.state?.sessionId !== sessionId || this.capabilityOpts?.runnerGeneration !== generation) return { ok: false, error: '会话已切换，排队结果未应用到当前会话' }
      await this.refreshState()
      return { ok: true }
    })
  }

  /**
   * 运行时重载前的队列快照。会话 JSONL 不包含尚未投递的 steering / follow-up，
   * 因此资源更新后重建 pi 时必须单独保存并恢复它们。
   */
  queueSnapshot(): QueueSnapshot {
    return snapshotQueue(this.queueState)
  }

  /**
   * 在空闲的新实例里恢复重载前的队列；调用方须先确保目标会话已经载入。
   * 队列变化由 pi 的 `queue_update` 事件回传，本地也同步一份以覆盖无事件的版本。
   */
  async restoreQueueSnapshot(snapshot: QueueSnapshot): Promise<{ ok: boolean; error?: string }> {
    const restore = (kind: 'steering' | 'followUp') => snapshot[kind].map((text, index) =>
      this.newQueueItem(text, snapshot.items?.[kind][index]?.text === text ? snapshot.items[kind][index].images : undefined))
      .filter(item => item.text.length > 0 || item.images?.length)
    const steering = restore('steering')
    const followUp = restore('followUp')
    if (steering.length === 0 && followUp.length === 0) return { ok: true }
    if (!this.rpc?.running) return { ok: false, error: 'pi 尚未就绪，无法恢复排队消息' }
    if (this.queueState.steering.length > 0 || this.queueState.followUp.length > 0) {
      const existing = {
        steering: this.queueState.steering.map((item) => item.text),
        followUp: this.queueState.followUp.map((item) => item.text)
      }
      if (JSON.stringify(existing) === JSON.stringify({ steering: snapshot.steering, followUp: snapshot.followUp }) &&
        (['steering', 'followUp'] as const).every(kind => this.queueState[kind].every((item, index) =>
          sameQueueImages(item.images, snapshot.items?.[kind][index]?.images)))) return { ok: true }
      return { ok: false, error: '新实例已有不同的排队消息；为避免丢失或重复，拒绝覆盖' }
    }
    try {
      return await this.queueRun(async () => {
        this.publishQueueItems({ steering, followUp })
        await this.refillQueue(steering, followUp)
        return { ok: true }
      })
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
    return this.editQueued(queueId, true)
  }

  /** 撤回时连同原始图片返回，剩余条目按完整消息重建。 */
  async removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; images?: QueueItem['images']; error?: string }> {
    return this.editQueued(queueId, false)
  }

  /**
   * 队列编辑 / 重排（WP-24b）：clear_queue 取回后按渲染端给的目标顺序重建。
   * 编排在 queue-edit.ts（可假端口单测），这里只把私有队列动作接成端口。
   */
  async rewriteQueue(next: QueueState): Promise<QueueRewriteResult> {
    return this.queueRun(async () => {
      if (!this.rpc) return { ok: false, error: 'pi 尚未就绪', dropped: [...next.steering, ...next.followUp] }
      const original: QueueState = { steering: [...this.queueState.steering], followUp: [...this.queueState.followUp] }
      return applyQueueRewrite({
        clearQueue: async () => {
          const res = await this.requireRpc().command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
          this.requireRpc()
          return { success: res.success, error: res.error, steering: res.data?.steering ?? [], followUp: res.data?.followUp ?? [] }
        },
        adoptCleared: (steering, followUp) => this.publishQueue(steering, followUp, true),
        publish: (queue) => { this.publishQueueItems(queue) },
        refill: (steering, followUp) => this.refillQueue(steering, followUp)
      }, original, next)
    })
  }

  private async editQueued(queueId: string, promote: boolean): Promise<{ ok: boolean; text?: string; images?: QueueItem['images']; error?: string }> {
    return this.queueRun(async () => {
      if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
      const target = this.queueItemOf(queueId)
      if (!target) return { ok: false, error: '这条排队消息已被接收或撤回' }
      try {
        const res = await this.requireRpc().command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        this.requireRpc()
        if (!res.success) return { ok: false, error: res.error }
        const original = this.publishQueue(res.data?.steering ?? [], res.data?.followUp ?? [], true)
        const liveTarget = original[target.kind].find(item => item.id === queueId)
        if (!liveTarget) {
          const recovery = await this.restoreQueue(original)
          return { ok: false, error: recovery
            ? `消息已被接收；恢复队列失败：${recovery}`
            : '消息已被 pi 接收（已进入本轮对话），无法再操作' }
        }
        const restSteer = original.steering.filter(item => item.id !== queueId)
        const restFollow = original.followUp.filter(item => item.id !== queueId)
        try {
          this.publishQueueItems({ steering: promote ? [...restSteer, liveTarget] : restSteer, followUp: restFollow })
          await this.refillQueue(restSteer, restFollow)
          if (promote) await this.refillQueue([liveTarget], [])
          return promote ? { ok: true } : {
            ok: true, text: liveTarget.text, ...(liveTarget.images?.length ? { images: liveTarget.images } : {})
          }
        } catch (error) {
          const recovery = await this.restoreQueue(original)
          return { ok: false, error: recovery
            ? `队列操作失败，且恢复原队列失败：${recovery}`
            : `队列操作失败，未消费内容已恢复：${error instanceof Error ? error.message : String(error)}` }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  async abort(): Promise<QueueSnapshot> {
    // 人工停止优先，连等待回执中的待续跑也取消。
    this.loopGuardContinuationVersion += 1
    if (this.loopGuardStopping || this.loopGuardAbortSent) {
      await this.loopGuardStopTask
      if (this.loopGuardAbortSent || !this.agentRunning) return { steering: [], followUp: [] }
    }
    this.cancelImages()
    /* 用户主动停止：用时冻结在当下，并标明这不是正常完成（H-6）。 */
    this.turn.terminal = 'stopped'
    // 按 pi 的约定：先 clear_queue 再 abort，把排队的文本拿回来。
    // 否则用户打了一半又改主意的话，那几句话就白打了（rpc.md §clear_queue）。
    let cleared: QueueSnapshot = { steering: [], followUp: [] }
    try {
      /*
       * 清空队列要走串行闸门：并发的「撤回 / 插队」收尾时会把剩余项 refill 回 pi，
       * 与这里的 clear_queue 交错的话，中止之后 pi 里会残留几帧「排队中」——
       * 用户看到中止了输入框上方还挂着消息。
       */
      await this.queueRun(async () => {
        if (!this.rpc) return undefined
        const result = await this.requireRpc().command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        this.requireRpc()
        if (result.success && result.data) {
          cleared = snapshotQueue(this.publishQueue(result.data.steering ?? [], result.data.followUp ?? [], true))
          this.resetQueue(true)
        }
        return result
      })
    } catch {
      /* clear_queue 失败不阻碍中止；保留本地快照，等待后续 queue_update 对齐 */
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
      for (const c of s.tools) {
        this.registerCall(c, s.id)
        this.pushedOut.set(c.id, c.output?.length ?? 0)
        this.dirtyTools.delete(c.id)
      }
      this.push({ ch: 'msg-update', payload: { id: s.id, patch: msg } })
    }

    // 直执行的 bash 也要收尾
    if (this.bash) {
      const b = this.bash
      this.bash = null
      endTreeSnapshot(b.msgId)
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
    /* 流式防护已发出过 abort 时不再发第二个：并发停止只归属一个终止动作。 */
    if (!this.loopGuardAbortSent) await this.rpc?.command('abort').catch(() => null)
    void this.refreshState()

    return cleared
  }

  /* ------------------------------------------------------ 直执行 bash */

  /**
   * 跑一个 shell 命令，不走 LLM。
   * pi 会把它当成 BashExecutionMessage 存进会话，**下一次 prompt 时会进上下文**。
   * 所以这是「我先看一眼，再让它基于这个结果干活」的逃生口。
   *
   * `options.excludeFromContext`：命令输出照旧存进会话，但下一次 prompt 时不进模型上下文。
   * 缺省（既有的无参调用）与 pi 默认一致 —— 进上下文。
   */
  async runBash(command: string, options?: { excludeFromContext?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const admission = this.claimExecutionAdmission()
    if (!admission.ok) return { ok: false, error: admission.error }
    let started = false
    try {
      const result = await this.runBashAdmitted(command, options)
      started = result.ok
      return result
    } finally {
      if (started) this.settleExecutionAdmission()
      else this.releaseExecutionAdmission()
    }
  }

  private async runBashAdmitted(command: string, options?: { excludeFromContext?: boolean }): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const cmd = command.trim()
    if (!cmd) return { ok: false, error: '命令为空' }
    if (this.bash) return { ok: false, error: '已有一条命令在跑' }

    const reqId = `yan-bash-${randomUUID()}`
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
      const payload: Record<string, unknown> = { command: cmd }
      if (options?.excludeFromContext !== undefined) payload.excludeFromContext = options.excludeFromContext
      const res = await this.requireRpc().command<{
        output?: string
        exitCode?: number
        cancelled?: boolean
        truncated?: boolean
        fullOutputPath?: string
      }>('bash', payload, { id: reqId, timeoutMs: 0 + 30 * 60_000 })

      const b = this.bash?.reqId === reqId ? this.bash : undefined
      if (b) this.bash = null
      if (!b) {
        endTreeSnapshot(msgId)
        return { ok: false, error: 'bash 请求已被停止或会话已切换' }
      }

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
      const b = this.bash?.reqId === reqId ? this.bash : undefined
      if (b) this.bash = null
      const err = e instanceof Error ? e.message : String(e)
      if (!b) {
        endTreeSnapshot(msgId)
        return { ok: false, error: 'bash 请求已被停止或会话已切换' }
      }
      this.finishBash(msgId, cmd, b.output, null, true, err)
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

  /** 本回合是否改过（或可能改过）工作目录里的文件 */
  hasWrittenThisRun(): boolean {
    return this.wroteThisRun
  }

  /* ---------------------------------------------------------- 会话管理 */

  /** 清理只属于上一会话的易变状态；调用方须先开启推送抑制。 */
  private resetSessionScope(): void {
    this.loopGuardContinuationVersion += 1
    this.loopGuardAutoContinueCount = 0
    if (this.bash) endTreeSnapshot(this.bash.msgId)
    this.bash = null
    this.streaming = null
    this.markStreaming(false)
    this.setAgentRunning(false)
    this.resetQueue()
    this.compactionState = EMPTY_COMPACTION_STATE
    this.nativeBranchView = false
  }

  async newSession(parentSession?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    /* parentSession 是「新会话记住来自哪条会话」的追踪字段，缺省（既有调用）不带。 */
    const payload: Record<string, unknown> = typeof parentSession === 'string' && parentSession ? { parentSession } : {}
    this.suppressPush = true
    try {
      const res = await this.requireRpc().command('new_session', payload)
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.ui.seen.clear()
      this.ui.pending.clear()
      this.resetSessionScope()
      await this.hydrate()
      return { ok: true }
    } catch (err) {
      /* 超时/进程退出：与 compact 同样的「不抛」契约，交给调用方看返回值。 */
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.suppressPush = false
    }
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    this.suppressPush = true
    try {
      const res = await this.requireRpc().command('switch_session', { sessionPath: path })
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.ui.seen.clear()
      this.ui.pending.clear()
      this.resetSessionScope()
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
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('set_session_name', { name: trimmed })
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
      const title = await this.maybeGenerateTitle({ force: true, candidate: !!manual, lockHeld: true, sessionId })
      return title ? { ok: true, title } : { ok: false, error: '标题生成失败，已保留原标题' }
    } finally {
      this.titleTried.delete(sessionId)
    }
  }

  async fork(entryId: string): Promise<{ ok: boolean; error?: string; text?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    this.suppressPush = true
    try {
      const res = await this.requireRpc().command<{ text?: string; cancelled?: boolean }>('fork', { entryId })
      if (!res.success) return { ok: false, error: res.error }
      if (res.data?.cancelled) return { ok: false, error: '分叉被扩展取消' }
      this.resetSessionScope()
      this.ui.seen.clear()
      this.ui.pending.clear()
      await this.hydrate()
      return { ok: true, text: res.data?.text }
    } finally {
      this.suppressPush = false
    }
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    this.suppressPush = true
    try {
      const res = await this.requireRpc().command<{ cancelled?: boolean }>('clone')
      if (!res.success) return { ok: false, error: res.error }
      if (res.data?.cancelled) return { ok: false, error: '复制被扩展取消' }
      this.resetSessionScope()
      this.ui.seen.clear()
      this.ui.pending.clear()
      await this.hydrate()
      return { ok: true }
    } finally {
      this.suppressPush = false
    }
  }

  async forkPoints(): Promise<ForkPoint[]> {
    if (!this.rpc) return []
    const res = await this.rpc.command<{ messages?: ForkPoint[] }>('get_fork_messages')
    return res.success ? (res.data?.messages ?? []) : []
  }

  /**
   * 会话条目的正式读取（pi `get_entries` 的薄透传）。
   *
   * `since` 是持久游标：传上次见到的条目 id，pi 只回它之后的新条目，跨重启可用；
   * 传了不存在的 id 时 pi 返回 `success:false`，这里原样翻成 `{ ok:false, error }`。
   * `leafId` 是当前分支末端，客户端据此判断活跃分支有没有动。
   *
   * 注意：与内部 `sessionEntriesLite()` 区分 —— 那个读者优先读会话文件、返回裸数组。
   */
  async sessionEntries(since?: string): Promise<{
    ok: boolean
    entries?: Record<string, unknown>[]
    leafId?: string | null
    error?: string
  }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const payload: Record<string, unknown> = typeof since === 'string' && since ? { since } : {}
    try {
      const res = await this.requireRpc().command<{
        entries?: Record<string, unknown>[]
        leafId?: string | null
      }>('get_entries', payload)
      if (!res.success) return { ok: false, error: res.error }
      return { ok: true, entries: res.data?.entries ?? [], leafId: res.data?.leafId ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 会话树（pi `get_tree` 的薄透传）：含被压缩的历史与已放弃分支。
   * 节点形如 `{ entry, children }`（带标签的节点另有 label / labelTimestamp）。
   * 失败（超时、进程退出、会话切换）同样翻成 `{ ok:false, error }`，不抛。
   */
  async sessionTree(): Promise<{
    ok: boolean
    tree?: Record<string, unknown>[]
    leafId?: string | null
    error?: string
  }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    try {
      const res = await this.requireRpc().command<{
        tree?: Record<string, unknown>[]
        leafId?: string | null
      }>('get_tree')
      if (!res.success) return { ok: false, error: res.error }
      return { ok: true, tree: res.data?.tree ?? [], leafId: res.data?.leafId ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 导出当前会话为 HTML。
   *
   * `outputPath` 缺省时由 pi 自己选位置；给出时透传给 pi（覆盖同名文件）。
   * 超时/进程退出也归成 `{ ok:false, error }` —— 调用方（IPC）本就把返回值
   * 当结果对象用，不该再额外处理一次异常。
   */
  async exportHtml(outputPath?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const payload: Record<string, unknown> = typeof outputPath === 'string' && outputPath ? { outputPath } : {}
    try {
      const res = await this.rpc.command<{ path?: string }>('export_html', payload)
      if (!res.success) return { ok: false, error: res.error }
      return { ok: true, path: res.data?.path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async compact(customInstructions?: string): Promise<{ ok: boolean; error?: string }> {
    this.loopGuardContinuationVersion += 1
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    /*
     * 契约是「不抛」：调用方有两类 —— 用户点的 `/compact`（会把它当提示弹出来）
     * 和策略触发的自动压缩（在 `void` 出去的异步链上）。后者没人接异常，
     * 一抛就是一条 `unhandledRejection` 控制台报错，所以超时/进程没了都归成 `{ ok: false }`。
     */
    const trimmed = typeof customInstructions === 'string' ? customInstructions.trim() : ''
    const payload: Record<string, unknown> = trimmed ? { customInstructions: trimmed } : {}
    let res: Awaited<ReturnType<PiRpc['command']>>
    try {
      res = await this.requireRpc().command('compact', payload, { timeoutMs: COMPACT_REQUEST_TIMEOUT_MS })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async confirmNativeOperation(prompt: { title: string; message: string; acceptLabel: string }): Promise<boolean> {
    const response = await this.ui.requestHostUi({
      method: 'select', purpose: 'approval', sensitive: true, title: prompt.title, message: prompt.message,
      options: [prompt.acceptLabel, '取消'], timeout: 180_000
    })
    return !response.cancelled && response.value === prompt.acceptLabel
  }

  async nativeNavigate(entryId: string): Promise<NavigateTreeResult> {
    if (!this.nativeRuntime) throw new Error('pi 原生桥尚未就绪')
    if (this.hasRunningBash() || this.agentRunning || this.state?.isCompacting || this.state?.pendingMessageCount || this.ui.pending.size) throw new Error('当前会话尚未空闲')
    const result = await this.nativeRuntime.navigateTree(entryId)
    if (!result.cancelled) {
      this.nativeBranchView = true
      this.resetQueue()
      this.ui.seen.clear()
      this.ui.pending.clear()
      await this.hydrate()
    }
    return result
  }

  async nativeReload(): Promise<void> {
    if (!this.nativeRuntime) throw new Error('pi 原生桥尚未就绪')
    if (this.hasRunningBash() || this.agentRunning || this.state?.isCompacting || this.state?.pendingMessageCount || this.ui.pending.size) throw new Error('当前会话尚未空闲')
    await this.nativeRuntime.reload()
    await this.refreshState()
    await this.refreshStats()
  }

  async nativeScopedModels(): Promise<ScopedModelsSnapshot> {
    if (!this.nativeRuntime) throw new Error('pi 原生桥尚未就绪')
    return this.nativeRuntime.getScopedModels()
  }

  async nativeSetScopedModels(modelIds: string[]): Promise<void> {
    if (!this.nativeRuntime) throw new Error('pi 原生桥尚未就绪')
    await this.nativeRuntime.saveScopedModels(modelIds)
  }

  async nativeProjectTrust(): Promise<ProjectTrustSnapshot> {
    if (!this.nativeRuntime) throw new Error('pi 原生桥尚未就绪')
    return this.nativeRuntime.getProjectTrust()
  }

  async nativeSetProjectTrust(trusted: boolean): Promise<void> {
    if (!this.nativeRuntime) throw new Error('pi 原生桥尚未就绪')
    const result = trusted ? await allowTrust(this.cwd) : await revokeTrust(this.cwd)
    if (!result.ok) throw new Error(result.error ?? '项目信任保存失败')
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
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('set_model', { provider, modelId })
    if (!res.success) return { ok: false, error: res.error }
    await this.refreshState()
    /* 模型可能没有任何思考档位；空数组也是权威结果，不能保留旧值。 */
    await this.listThinkingLevels()
    /* 新模型的上下文窗口与 token 统计必须一起刷新。 */
    await this.refreshStats()
    return { ok: true }
  }

  /** Host-only model metadata for an explicitly requested independent task. No secrets cross IPC. */
  async serviceModelDetails(): Promise<Record<string, unknown> | null> {
    const current = this.state?.model
    if (!current || !this.rpc) return null
    const response = await this.rpc.command<{ models?: Array<Record<string, unknown>> }>('get_available_models')
    if (!response.success) return null
    return response.data?.models?.find(model => model.id === current.id && model.provider === current.provider) ?? null
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.rpc) return []
    const res = await this.rpc.command<{ models?: ModelInfo[] }>('get_available_models')
    if (!res.success) return []
    return (res.data?.models ?? [])
      .map((raw) => attachModelPrice(normalizeModelInfo(raw), raw))
      .filter((model): model is ModelInfo => model !== undefined)
  }

  async setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    this.loopGuardContinuationVersion += 1
    return this.enqueueCapabilityChange(() => this.applyModel(provider, modelId))
  }

  async setThinking(level: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueCapabilityChange(async () => {
      if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
      const res = await this.rpc.command('set_thinking_level', { level })
      if (res.success) await this.refreshState()
      return res.success ? { ok: true } : { ok: false, error: res.error }
    })
  }

  async listThinkingLevels(): Promise<string[]> {
    if (!this.rpc) return []
    const res = await this.rpc.command<{ levels?: string[] }>('get_available_thinking_levels')
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
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('set_auto_compaction', { enabled })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setAutoRetry(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('set_auto_retry', { enabled })
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
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('set_steering_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setFollowUpMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('set_follow_up_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /** 取消正在等待的重试（自动重试计时器还开着的时候特别有用） */
  async abortRetry(): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('abort_retry')
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
    let models = await this.listModels()
    if (this.nativeRuntime) {
      const scoped = await this.nativeRuntime.getScopedModels()
      if (scoped.scopedModels.length) {
        const keys = new Set(scoped.scopedModels.map(item => item.key))
        models = models.filter(model => keys.has(`${model.provider}/${model.id}`))
      }
    }
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
      if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
      const levels = await this.listThinkingLevels()
      if (levels.length < 2) return { ok: false, error: '当前模型不支持思考' }

      const cur = this.state?.thinkingLevel ?? 'off'
      const i = levels.indexOf(cur)
      const next = levels[i < 0 ? 0 : (i + 1) % levels.length]

      const res = await this.requireRpc().command('set_thinking_level', { level: next })
      if (!res.success) return { ok: false, error: res.error }

      await this.refreshState()
      return { ok: true, to: next }
    })
  }

  /** 最后一条助手消息的纯文本（复制用） */
  async lastAssistantText(): Promise<string | null> {
    if (!this.rpc) return null
    const res = await this.rpc.command<{ text?: string | null }>('get_last_assistant_text')
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

  async refreshStats(_opts: { allowPolicyTrigger?: boolean; expectGeneration?: number } = {}): Promise<SessionStats | null> {
    try {
      const generation = this.capabilityOpts?.runnerGeneration
      const res = await this.rpc?.command<SessionStats>('get_session_stats')
      if (res?.success && res.data) {
        /* 采集期间换会话 / 换代次：这不属于旧请求，不能贴上当前封套推送。 */
        if (_opts.expectGeneration !== undefined && generation !== _opts.expectGeneration) return null
        if (_opts.expectGeneration !== undefined && this.capabilityOpts?.runnerGeneration !== _opts.expectGeneration) return null
        const stats = this.statsForCurrentModel(res.data)
        this.push({ ch: 'stats', payload: stats })
        return stats
      }
    } catch { /* A missing usage snapshot does not change agent execution. */ }
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
    opts: { force?: boolean; candidate?: boolean; lockHeld?: boolean; onlyIfSamplesChanged?: boolean; sessionId?: string } = {}
  ): Promise<string | null> {
    const st = this.state
    const rpc = this.rpc
    const titleLifecycle = this.titleLifecycle
    if (!st || !rpc || this.stopping || (opts.sessionId && st.sessionId !== opts.sessionId)) return null
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
      if (!res?.title || this.stopping || this.rpc !== rpc || this.titleLifecycle !== titleLifecycle) return null

      if (opts.candidate) return res.title
      this.titledSamples.set(sessionId, samplesKey)
      if (this.titledSamples.size > 200) this.titledSamples.clear()

      // 写回 pi（TUI 的 /resume 也能看到）。
      // ⚠️ 只有在标题真的变了才写 —— set_session_name 会改会话文件，
      // 每轮都写一下是没意义的磁盘写入。
      // 生成期间实例可能已换到别的会话：旧标题只推给界面（按原 sessionId），不写进当前 RPC
      const stillSameSession = this.state?.sessionId === sessionId
      if (stillSameSession && this.lastTitle !== res.title) {
        this.lastTitle = res.title
        const ok = await this.rpc?.command('set_session_name', { name: res.title })
        if (ok?.success) await this.refreshState()
      }
      // 停止或实例替换后不再推送迟到的标题结果。
      if (this.stopping || this.rpc !== rpc || this.titleLifecycle !== titleLifecycle) return null
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

  /** One approved cwd move may resume after a normal idle boundary, never after manual stop or new input. */
  captureSessionMoveContinuation(): (afterHostStop?: boolean) => boolean {
    return captureMoveContinuation(() => ({
      sessionId: this.state?.sessionId,
      sessionFile: this.state?.sessionFile,
      generation: this.capabilityOpts?.runnerGeneration,
      version: this.loopGuardContinuationVersion,
      failureVersion: this.sessionMoveFailureVersion,
      rpc: this.rpc,
      ready: this.conn === 'ready' && this.rpc?.running === true,
      stopped: this.stopping,
      idle: !this.agentRunning && !this.streaming && !this.bash && !this.state?.isCompacting &&
        this.ui.pending.size === 0 && this.queueState.steering.length === 0 && this.queueState.followUp.length === 0
    }))
  }

  /**
   * A7：宿主启动见证（只读内部事实）。
   *
   * bootId / cwd / servers 是该 pi 进程**启动时**采集并复核过的；generation 随
   * runner 代次重盖（同进程换会话不该让见证失效；跨 cwd 重起会换新的 AgentController
   * 实例，bootId 自然变化）。renderer / RPC 不能赋值或传入。
   */
  nativeBootWitness(): McpNativeBootWitness | null {
    if (!this.nativeWitness) return null
    return {
      ...this.nativeWitness,
      generation: this.capabilityOpts?.runnerGeneration ?? this.nativeWitness.generation
    }
  }

  /** RunnerRegistry increments this when an in-process runner changes sessions. */
  setRunnerGeneration(generation: number): void {
    if (this.capabilityOpts && Number.isSafeInteger(generation) && generation > 0) {
      if (this.capabilityOpts.runnerGeneration !== generation) this.releaseExecutionAdmission()
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
    /* pi 对没有报价的模型（订阅制、手写服务）记 0：把消息里按公开价估算的部分加进总花费 */
    let costEstimated = 0
    for (const msg of this.messages) if (msg.usage?.costEstimated) costEstimated += msg.usage.cost
    const priced = costEstimated > 0 ? { cost: stats.cost + costEstimated, costEstimated } : {}
    if (!stats.contextUsage) return { ...stats, ...priced }
    return {
      ...stats,
      ...priced,
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
    /*
     * A7：热重载后无法证明「进程启动时加载了什么」，主动作废见证，
     * 让该 runner 按可能持有处理（默认保守，不放行）。
     */
    this.nativeWitness = null
    this.nativeWitnessPending = null
    await this.closeRetiredMcpManagers()
  }

  async stop(): Promise<void> {
    this.loopGuardContinuationVersion += 1
    this.stopping = true
    this.releaseExecutionAdmission()
    this.nativeRuntime?.dispose()
    this.nativeRuntime = null
    this.titleLifecycle += 1
    this.cancelImages()
    /* 端点随实例一起停：token 作废，旧 CLI 环境变量从此无效。 */
    this.capabilityServer?.stop()
    this.capabilityServer = undefined
    this.yanCliEnv = undefined
    /* 快照是缓存文件，保留；这里只清运行时引用，避免旧实例复用过期路径。 */
    this.mcpAppToolsSnapshot = undefined
    /* A7：实例停止即作废启动见证，不能跨进程启动复用。 */
    this.nativeWitness = null
    this.nativeWitnessPending = null
    /* MCP 会起子进程；不停掉就会留下孤儿（Windows 上不会自己收）。 */
    await this.mcpManager?.close().catch(() => undefined)
    this.mcpManager = undefined
    await this.closeRetiredMcpManagers()
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
