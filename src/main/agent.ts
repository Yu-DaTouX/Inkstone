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
import { isTransientModelError, modelErrorNotice, modelErrorText } from '../shared/model-errors'
import { isQuotaWaitError } from '../shared/quota-resume'
import { isSubagentNotice } from '../shared/subagent-notice'
import { agentOwnedPiArgs, nativePiToolsSupported } from '../shared/agent-context'
import type { CapabilityCommandResult, CapabilityHandlers, YanCliEnv } from './capability-server'
import { CapabilityCommandError, CapabilityServer } from './capability-server'
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
  entryMessage,
  type PiContentBlock,
  type PiMessage
} from './normalize'
import { SESSIONS_DIR, SESSIONS_DIR_IS_OVERRIDE } from './sessions'
import { consumeQueuedItem, reconcileQueueItems, sameQueueImages, snapshotQueue } from './queue-items'
import { applyQueueRewrite, type QueueRewriteResult } from './queue-edit'
import { contextWindowAssumed } from './custom-providers'
import { clearStaleRunning, contextFromEntry, contextFromRun, EMPTY_COMPACTION_STATE, measuredAfterCompaction, projectTrustedFrom, reduceCompaction, type CompactionState } from './compaction'
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
import { isSafeSessionId } from './session-id'

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
  ContextFrom,
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
  TokenCounts,
  SessionTodo,
  SlashCommand,
  ResponseDetail,
  UIMessage,
  UIToolCall,
  Usage
} from '../shared/ipc'
import type { CapabilityStrategy, WorkMode } from '../shared/ipc'
import { hasUsageNumbers } from '../shared/turns'
import { captureMoveContinuation, type SessionMoveAnswer, type SessionMovePrompt } from './session-move'
import type { ScheduleService } from './schedule-service'
import { runScheduleCommand, ScheduleCommandError } from './schedule-commands'

const FLUSH_MS = 16
const MAX_FLUSH_MS = 120

const COMPACT_REQUEST_TIMEOUT_MS = 300_000

type Push = (msg: MainPush) => void
type ExtUiPush = Extract<MainPush, { ch: 'status' | 'widget' }>

function extUiKey(msg: ExtUiPush): string {
  return `${msg.ch}:${msg.payload.key}`
}

function extUiCleared(msg: ExtUiPush): boolean {
  return msg.ch === 'status' ? msg.payload.text === undefined : !msg.payload.lines?.length
}

function extUiRemoval(msg: ExtUiPush): ExtUiPush {
  return msg.ch === 'status'
    ? { ch: 'status', payload: { key: msg.payload.key } }
    : { ch: 'widget', payload: { key: msg.payload.key, ...(msg.payload.placement ? { placement: msg.payload.placement } : {}) } }
}

export interface RunObserverContext {
  sessionId: string
  sessionPath?: string
  title?: string
  model?: RunModel
}

export type RunObserver = (ctx: RunObserverContext, signal: RunSignal) => void

type BrowserCommandResult = { ok: boolean; error?: string; code?: string }
type AutoContinueScope = { rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number; reason?: 'model-error' }

export type BrowserObservationResult = BrowserCommandResult & { observation?: BrowserObservation }

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

export interface SubagentCommandContext {
  model?: string
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
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

export interface ResearchCommandHost {
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
export interface DangerConfirmPrompt {
  tool: string
  detail: string
  reasons: string[]
  cwd: string
  kind?: 'permission' | 'delete'
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

export interface CapabilityRunOptions {
  sessionId: string
  runnerGeneration: number
  projectId: string
  opsDir: string
  binDir: string
  artifactDir: string
  devResourcesDir?: string
  getWorkMode?: () => Promise<WorkMode>
  getCapabilityStrategy?: () => Promise<CapabilityStrategy>
  execution?: ExecuteAdmissionPort
  onBashSettled?: () => void
  trashItem?: (path: string) => Promise<void>
}

async function projectPiPackageArgs(cwd: string): Promise<string[]> {
  let trusted = false
  try {
    const raw = JSON.parse(await readFile(join(PI_AGENT_DIR, 'trust.json'), 'utf8')) as unknown
    trusted = projectTrustedFrom(raw, cwd)
  } catch {
    trusted = false
  }
  if (!trusted) return []
  return projectPackageDirs(cwd, PI_AGENT_DIR).flatMap((dir) => ['--extension', dir])
}

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
  private workModeExtension?: string
  private shellFallbackExtension?: string
  private agentProfileExtension?: string
  private responseDetailExtension?: string
  private preambleExtension?: string
  private languageExtension?: string
  private temperatureExtension?: string
  private capabilityGuideExtension?: string
  private mcpAppProxyExtension?: string
  private mcpAppToolsSnapshot?: string
  private nativeConfigReader?: McpNativeConfigReader
  private contextTrimExtension?: string
  private repeatGuardExtension?: string
  private bundledSkills: string[] = []
  private userSkills?: () => Promise<string[]>
  private readHistory?: (sessionFile: string) => Promise<ReadResult | null>
  private getResponseDetail?: () => ResponseDetail
  private getBrowserHost?: () => BrowserCommandHost | null
  private subagentHost?: SubagentCommandHost
  private scheduleHost?: ScheduleService
  private researchHost?: ResearchCommandHost
  private confirmCapabilityAuthorization?: (
    request: CapabilityAuthorizationPrompt
  ) => Promise<CapabilityAuthorizationChoice>
  private readonly imageRequests = new Set<AbortController>()
  private confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
  private confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentDecision | null>
  private confirmDanger?: (request: DangerConfirmPrompt) => Promise<ConsentDecision | null>
  private cancelApprovals?: () => void
  private getPermissionMode?: () => Promise<'danger' | 'all'>
  private requestSessionMove?: (request: SessionMovePrompt) => Promise<SessionMoveAnswer>
  private dangerGuardExtension?: string
  private permissionGuardExtension?: string
  private providerExtensions: string[] = []
  private yanCliEnv?: YanCliEnv
  private capabilityServer?: CapabilityServer
  private capabilityOpts?: CapabilityRunOptions
  private executionAdmissionToken?: number
  private executionAdmissionTimer?: ReturnType<typeof setTimeout>
  private runObserver?: RunObserver

  private capabilityChangeTail: Promise<void> = Promise.resolve()
  private mcpManager?: McpConnectionManager
  private retiredMcpManagers: McpConnectionManager[] = []
  private mcpReleasing = new Map<string, Promise<{ confirmed: boolean; unknown: number }>>()
  private retiredCloseTail: Promise<void> = Promise.resolve()
  private mcpConfigError?: string
  private readonly lookup = new LookupCommands({
    capabilityOpts: () => this.capabilityOpts,
    cwd: () => this.cwd,
    notifySearchApiMissing: () => this.push({ ch: 'search-api-hint', payload: {} })
  })
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
    rawCommands: () => this.rawCommands(),
    push: (msg) => this.push(msg),
    getState: () => this.getState(),
    confirmCapabilityAuthorization: () => this.confirmCapabilityAuthorization,
    bundledSkills: () => this.bundledSkills,
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

  private messages: UIMessage[] = []
  private suppressPush = false
  private extUi = new Map<string, ExtUiPush>()
  private extUiPending: Map<string, ExtUiPush> | null = null
  private streaming: {
    id: string
    text: string
    thinking: string
    thinkingMs?: number
    thinkingStartedAt?: number
    thinkingLive?: boolean
    responseDetail: ResponseDetail
    tools: UIToolCall[]
    startedAt?: number
    firstTokenAt?: number
    generationStartedMono?: number
    requestStartEvent?: 'turn_start'
    firstContentMono?: number
    usage?: Usage
    pushedText: number
    pushedThinking: number
    toolOpen?: boolean
  } | null = null
  private agentRunning = false
  private wroteThisRun = false
  private streamLoopDetector: StreamLoopDetector | null = null
  private loopGuardTripped = false
  private loopGuardAbortSent = false
  private loopGuardStopping = false
  private loopGuardStopTask?: Promise<void>
  private loopGuardAbortedMessage = false
  private loopGuardAutoContinueCount = 0
  private loopGuardContinuationVersion = 0
  private sessionMoveFailureVersion = 0
  private loopGuardResumeVersion = -1
  private loopGuardContinueTask?: Promise<void>
  private loopGuardHit?: { rule: LoopHit['rule']; stream: 'thinking' | 'text' }
  private retrySeenThisRun = false
  private pendingModelError?: { text: string; retried: boolean }

  private readonly turn = new TurnTimingTracker()
  private pendingRequestMono?: number
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirtyTools = new Set<string>()
  private callIndex = new Map<string, UIToolCall>()
  private callOwner = new Map<string, string>()
  private pushedOut = new Map<string, number>()

  private state: SessionState | null = null
  private compactionState: CompactionState = EMPTY_COMPACTION_STATE
  private contextFrom: ContextFrom | undefined
  private timingContinues = false
  private readonly assumedWindows = new Map<string, boolean>()

  private readonly entriesLite = new SessionEntriesLite()

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

  private readonly localizeHistoryImage = (mimeType: string, data: string): string =>
    localizeImage(join(YAN_DIR, 'attachments'), mimeType, data)

  private async readHistoryOf(sessionFile: string): Promise<ReadResult | null> {
    if (this.readHistory) return this.readHistory(sessionFile).catch(() => null)
    return readSessionMessages(sessionFile, { localizeImage: this.localizeHistoryImage })
      .then(result => result ? { ...result, messages: structuredClone(result.messages) } : null)
      .catch(() => null)
  }

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
    responseDetailExtension?: string
    preambleExtension?: string
    languageExtension?: string
    temperatureExtension?: string
    capabilityGuideExtension?: string
    mcpAppProxyExtension?: string
    mcpAppToolsSnapshot?: string
    nativeConfigReader?: McpNativeConfigReader
    contextTrimExtension?: string
    nativeSessionExtension?: string
    repeatGuardExtension?: string
    bundledSkills?: string[]
    userSkills?: () => Promise<string[]>
    readHistory?: (sessionFile: string) => Promise<ReadResult | null>
    getResponseDetail?: () => ResponseDetail
    browserHost?: () => BrowserCommandHost | null
    subagentHost?: SubagentCommandHost
    scheduleHost?: ScheduleService
  researchHost?: ResearchCommandHost
    confirmCapabilityAuthorization?: (
      request: CapabilityAuthorizationPrompt
    ) => Promise<CapabilityAuthorizationChoice>
    confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
    confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentDecision | null>
    confirmDanger?: (request: DangerConfirmPrompt) => Promise<ConsentDecision | null>
    cancelApprovals?: () => void
    getPermissionMode?: () => Promise<'danger' | 'all'>
    requestSessionMove?: (request: SessionMovePrompt) => Promise<SessionMoveAnswer>
    dangerGuardExtension?: string
    permissionGuardExtension?: string
    providerExtensions?: string[]
    yanCliEnv?: YanCliEnv
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
      onBashSettled?: () => void
      trashItem?: (path: string) => Promise<void>
    }
    observeRun?: RunObserver
  }) {
    super()
    const emit = opts.push
    this.push = (msg) => {
      if (msg.ch === 'status' || msg.ch === 'widget') {
        if (this.extUiPending) {
          this.extUiPending.set(extUiKey(msg), msg)
          return
        }
        this.recordExtUi(msg)
      } else if (this.suppressPush && msg.ch !== 'ui-request' && msg.ch !== 'ui-resolved' && msg.ch !== 'notify') return
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
    this.researchHost = opts.researchHost
    this.confirmCapabilityAuthorization = opts.confirmCapabilityAuthorization
    this.confirmExternalApi = opts.confirmExternalApi
    this.confirmToolConsent = opts.confirmToolConsent
    this.confirmDanger = opts.confirmDanger
    this.cancelApprovals = opts.cancelApprovals
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

  private async ensureCapability(): Promise<void> {
    const opts = this.capabilityOpts
    if (!opts || this.capabilityServer || this.yanCliEnv) return
    try {
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

  get workingDirectory(): string {
    return this.cwd
  }

  private currentResponseDetail(): ResponseDetail {
    const value = this.getResponseDetail?.()
    return value === 'brief' || value === 'standard' || value === 'detailed' ? value : 'unknown'
  }

  private conn: 'starting' | 'ready' | 'exited' | 'error' = 'starting'
  private connDetail = ''

  private titleTried = new Set<string>()
  private titledSamples = new Map<string, string>()

  private lastTitle: string | undefined

  private queueState: QueueState = { steering: [], followUp: [] }
  private queueSequence = 0
  private queueConsumed = new Set<string>()
  private queueRemoved: QueueItem[] = []
  private consumedEmptyQueue = { steering: 0, followUp: 0 }
  private queueScope?: { rpc: PiRpc | null; sessionId?: string; generation?: number }
  private queueBusy = false
  private queueOperations: Promise<void> = Promise.resolve()
  private titleLifecycle = 0
  private stopping = false
  private nativeWitnessPending: McpNativeBootWitness | null = null
  private nativeWitness: McpNativeBootWitness | null = null

  getConn(): { state: 'starting' | 'ready' | 'exited' | 'error'; detail: string } {
    return { state: this.conn, detail: this.connDetail }
  }

  private setConn(state: 'starting' | 'ready' | 'exited' | 'error', detail = ''): void {
    this.conn = state
    this.connDetail = detail
    this.push({ ch: 'proc', payload: { state, detail } })
  }

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

    await this.ensureCapability()

    const managedSkillArgs = this.capabilityOpts?.projectId
      ? await activeSkillArgs(YAN_DIR, this.capabilityOpts.projectId)
      : []
    const userSkillArgs = this.userSkills ? await this.userSkills().catch(() => [] as string[]) : []
    const probe = resolvePi({ override: this.piBin })
    const version = probe.home ? await readFile(join(probe.home, 'package.json'), 'utf8').then(text => JSON.parse(text).version as string).catch(() => undefined) : undefined
    const nativeTools = nativePiToolsSupported(version)
    const projectPackageArgs = nativeTools ? [] : await projectPiPackageArgs(this.cwd)
    const shellFallback = !(await hasBash())
    const rpc = new PiRpc({
      cwd: this.cwd,
      piBin: this.piBin,
      args: agentOwnedPiArgs([
        '--no-extensions',
        ...(this.nativeSessionExtension ? ['--extension', this.nativeSessionExtension] : []),
        ...(nativeTools && this.codemodeExtension ? ['--extension', this.codemodeExtension] : []),
        ...(this.questionExtension ? ['--extension', this.questionExtension] : []),
        ...(this.shellFallbackExtension ? ['--extension', this.shellFallbackExtension] : []),
        ...(this.workModeExtension ? ['--extension', this.workModeExtension] : []),
        ...(this.agentProfileExtension ? ['--extension', this.agentProfileExtension] : []),
        ...(this.responseDetailExtension ? ['--extension', this.responseDetailExtension] : []),
        ...(this.preambleExtension ? ['--extension', this.preambleExtension] : []),
        ...(this.languageExtension ? ['--extension', this.languageExtension] : []),
        ...(this.temperatureExtension ? ['--extension', this.temperatureExtension] : []),
        ...(this.capabilityGuideExtension
          ? ['--extension', this.capabilityGuideExtension]
          : []),
        ...(this.contextTrimExtension ? ['--extension', this.contextTrimExtension] : []),
        ...(this.repeatGuardExtension ? ['--extension', this.repeatGuardExtension] : []),
        ...(this.mcpAppProxyExtension ? ['--extension', this.mcpAppProxyExtension] : []),
        ...(this.dangerGuardExtension ? ['--extension', this.dangerGuardExtension] : []),
        ...(this.permissionGuardExtension ? ['--extension', this.permissionGuardExtension] : []),
        ...this.providerExtensions.flatMap((path) => ['--extension', path]),
        ...managedSkillArgs,
        ...this.bundledSkills.flatMap((skill) => ['--skill', skill]),
        ...userSkillArgs.flatMap((skill) => ['--skill', skill]),
        ...projectPackageArgs,
        ...(process.env.YAN_PROBE && process.env.YAN_PROBE_SKILL
          ? ['--skill', process.env.YAN_PROBE_SKILL]
          : []),
        ...(process.env.YAN_TEST_MODEL ? ['--model', process.env.YAN_TEST_MODEL] : []),
        ...(SESSIONS_DIR_IS_OVERRIDE ? ['--session-dir', SESSIONS_DIR] : [])
      ], nativeTools),
      env: {
        YAN_DATA_DIR: YAN_DIR,
        PI_CODING_AGENT_DIR: PI_AGENT_DIR,
        ...(this.nativeSessionExtension ? { YAN_NATIVE_BRIDGE: '1' } : {}),
        ...(shellFallback ? { YAN_SHELL: 'powershell' } : {}),
        ...(this.capabilityOpts?.sessionId
          ? { YAN_SESSION_ID: this.capabilityOpts.sessionId }
          : {}),
        ...(this.capabilityOpts?.sessionId
          ? { YAN_RUNNER_ID: this.capabilityOpts.sessionId }
          : { YAN_RUNNER_ID: 'primary' }),
        YAN_RUNNER_EPOCH: String(this.capabilityOpts?.runnerGeneration ?? 1),
        ...(this.mcpAppToolsSnapshot ? { YAN_MCP_APP_TOOLS: this.mcpAppToolsSnapshot } : {}),
        ...(this.mcpAppToolsSnapshot && this.capabilityOpts?.projectId
          ? { YAN_MCP_APP_PROJECT_ID: this.capabilityOpts.projectId }
          : {}),
        ...(this.capabilityOpts?.projectId
          ? { YAN_PROJECT_ID: this.capabilityOpts.projectId }
          : {}),
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
    this.nativeRuntime = new NativeSessionRuntime(
      { command: (type, payload, options) => rpc.command(type, payload, options) },
      undefined,
      (receipt) => {
        if (this.rpc !== rpc || receipt.op !== 'model_select') return
        void this.refreshState()
        void this.listThinkingLevels()
      }
    )

    rpc.on('stderr', (line) => {
      this.push({ ch: 'proc', payload: { state: 'stderr', detail: line } })
    })

    rpc.on('exit', (code) => {
      if (this.rpc !== rpc) return
      this.flushNow()
      this.streaming = null
      this.bash = null
      this.agentRunning = false
      this.releaseExecutionAdmission()
      this.compactionState = EMPTY_COMPACTION_STATE
      this.contextFrom = undefined
      this.ui.rejectPendingHostUi('pi 已退出，问题请求已取消')
      this.ui.pending.clear()
      this.cancelApprovals?.()
      if (this.state) {
        this.state = { ...this.state, isAgentRunning: false, isStreaming: false, isCompacting: false }
        this.push({ ch: 'state', payload: this.state })
      }
      this.setConn('exited', `pi 已退出（code=${code ?? 'null'}）`)
      this.nativeWitness = null
      this.nativeWitnessPending = null
      const runSink = this.runObserver
      const runCtx = this.runObserverContext()
      if (runSink && runCtx) {
        runSink(runCtx, this.stopping ? { type: 'stopped', by: 'host' } : { type: 'pi-exit', code: code ?? null, signal: null })
      }
    })

    rpc.on('ui', (req) => {
      if (this.rpc !== rpc) return
      if (this.nativeRuntime?.handleUi(req)) return
      this.ui.handleUi(req)
    })
    rpc.on('event', (evt) => {
      if (this.rpc !== rpc) return
      this.handleEvent(evt)
    })

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

    const ok = await this.waitReady(20_000)
    if (!ok) {
      const msg = 'pi 启动超时（20s）。点「详情」看 stderr，或跑 npm run probe-pi。'
      this.setConn('error', msg)
      return { ok: false, error: msg }
    }

    this.setConn('ready')

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

    void this.listThinkingLevels().catch(() => undefined)

    await this.hydrate()
    return { ok: true }
  }

  private async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await this.requireRpc().command('get_state')
        if (res.success) return true
      } catch {
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  private async hydrate(): Promise<void> {
    const state = await this.requireRpc().command('get_state').catch(() => null)
    if (state?.success) this.setStateFrom(state.data as Record<string, unknown>)
    const sessionFile = this.state?.sessionFile

    const fromFile = sessionFile ? await this.readHistoryOf(sessionFile) : null
    if (this.nativeBranchView) {
      const snapshot = await this.sessionEntries()
      if (!snapshot.ok) throw new Error(snapshot.error ?? '无法读取当前原生分支')
      const path = nativeActiveBranch(snapshot.entries ?? [], snapshot.leafId ?? null)
      const messageEntries = path.flatMap(entry => {
        const message = entryMessage(entry)
        return message ? [{ id: entry.id, message }] : []
      })
      const compactionEntry = path.findLast(entry => entry.type === 'compaction')
      this.setContextFrom(compactionEntry ? contextFromEntry(compactionEntry) : undefined)
      const previousSegments = fromFile?.messages.filter(message => message.id.startsWith('history:')) ?? []
      this.messages = [...previousSegments, ...normalizeHistory(messageEntries.map(entry => entry.message),
        (mimeType, data) => localizeImage(join(YAN_DIR, 'attachments'), mimeType, data),
        messageEntries.map(entry => typeof entry.id === 'string' ? entry.id : undefined))]
    } else if (fromFile?.messages.length) {
      this.messages = fromFile.messages
      this.setContextFrom(fromFile.contextFrom ?? contextFromRun(this.compactionState.last))
    } else {
      const msgs = await this.requireRpc().command('get_messages').catch(() => null)
      const raw = (msgs?.data as { messages?: unknown[] } | undefined)?.messages
      this.messages = Array.isArray(raw)
        ? normalizeHistory(raw, (mimeType, data) => localizeImage(join(YAN_DIR, 'attachments'), mimeType, data))
        : []
    }
    if (sessionFile) {
      this.messages = await new ArtifactStore(this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts'))
        .hydrateMessages(sessionFile, this.messages)
    }

    const timingBucket = timingKey(this.state?.sessionFile)
    if (timingBucket) {
      const records = await readTurnTimings(YAN_DIR, timingBucket).catch(() => [])
      if (records.length) this.messages = applyTurnTimings(this.messages, records)
    }

    this.callIndex.clear()
    this.callOwner.clear()
    this.pushedOut.clear()
    for (const msg of this.messages) this.indexCalls(msg)
    for (const call of this.streaming?.tools ?? []) {
      this.registerCall(call, this.streaming?.id)
    }

    this.push({ ch: 'sync', payload: this.messages })
    this.pushQuestionLog()
    const stats = await this.requireRpc().command('get_session_stats').catch(() => null)
    if (stats?.success) {
      const counted = this.statsForCurrentModel(stats.data as SessionStats)
      this.push({ ch: 'stats', payload: await this.withOverheadUsage(counted) })
    }

    void this.refreshTodos()

    this.titleTried.clear()
    this.lastTitle = undefined
    void this.maybeGenerateTitle()
  }

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

  async refreshTodos(): Promise<SessionTodo[]> {
    try {
      const entries = await this.sessionEntriesLite()
      if (!entries) return []
      const hostEntries = await this.taskPlanEntries()
      const snaps = todoSnapshotsFromEntries([...entries, ...hostEntries])
      const latest = snaps.length ? snaps[snaps.length - 1].todos : []
      this.push({ ch: 'todos', payload: latest })
      this.push({ ch: 'todo-history', payload: snaps })
      return latest
    } catch {
      return []
    }
  }

  private async taskPlanEntries(): Promise<Record<string, unknown>[]> {
    const sessionId = this.state?.sessionId
    if (!sessionId || !isSafeSessionId(sessionId)) return []
    try {
      return (await readTaskPlanLog(sessionId)).map(taskPlanLogEntry)
    } catch {
      return []
    }
  }

  private async runCapabilityCommand(
    command: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CapabilityCommandResult> {
    if (command.startsWith('browser.')) {
      return this.browserCommands.runBrowserCommand(command.slice('browser.'.length), params)
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
        parentSessionId: this.state?.sessionId || (this.capabilityOpts?.sessionId ? `pending:${this.capabilityOpts.sessionId}` : undefined),
        parentRunId: this.capabilityOpts?.sessionId,
        parentGeneration: this.capabilityOpts?.runnerGeneration,
        parentMessageId: this.latestAssistantMessageId(),
        projectId: this.capabilityOpts?.projectId
      })
    }
    if (command === 'capabilities.search') {
      return this.acquisition.runCapabilitiesSearch(params)
    }
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
    if (command.startsWith('search.')) {
      return this.lookup.runSearchCommand(command.slice('search.'.length), params)
    }
    if (command === 'image.generate') return this.runImageCommand(params)
    if (command === 'image.local.status' || command === 'image.local.start' || command === 'image.local.stop') return this.runLocalImageServiceCommand(command)
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
    if (command === 'office.read') return this.runOfficeReadCommand(params)
    if (command === 'file.trash') return this.runFileTrashCommand(params)
    if (command === 'consent.request') return this.runConsentRequestCommand(params)
    if (command === 'danger.confirm') return this.runDangerConfirmCommand(params)
    if (command === 'session.move') return this.runSessionMoveCommand(params)
    switch (command) {
      case 'tasks.apply':
        return this.applyTaskPlan(params)
      default:
        throw new CapabilityCommandError('not_implemented', `命令已接通但尚未实现：${command}`)
    }
  }

  private latestAssistantMessageId(): string {
    if (this.streaming?.id) return this.streaming.id
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].role === 'assistant') return this.messages[i].id
    }
    return `artifact-${Date.now().toString(36)}`
  }

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

  private async runQuestionCommand(
    params: Record<string, unknown>
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const question = typeof params.question === 'string' ? params.question.trim() : ''
    if (!question) throw new CapabilityCommandError('question_missing', 'question ask 需要 question')
    if (question.length > 4000) throw new CapabilityCommandError('question_too_long', '问题不能超过 4000 个字符')

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

  private async runConsentRequestCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const normalized = normalizeConsentParts(params, localDeviceId(), 'local')
    if (!normalized.ok) throw new CapabilityCommandError('consent_bad_request', normalized.error)
    const parts = normalized.parts
    const purpose = typeof params.purpose === 'string' ? params.purpose.trim().slice(0, 500) : ''
    const declaredDanger = params.dangerous === true || params.dangerous === 'true'
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

  private async runDangerConfirmCommand(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    if ((await this.getPermissionMode?.()) === 'all') return { summary: { kind: 'danger-confirm', allowed: true, decision: 'auto' } }
    const tool = typeof params.tool === 'string' ? params.tool.slice(0, 40) : 'tool'
    const detail = typeof params.detail === 'string' ? params.detail : ''
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

  private mcpConnectionManager(): McpConnectionManager {
    const loaded = loadMcpServers()
    this.mcpConfigError = loaded.error
    const visible = mcpServersForProject(loaded.servers, this.capabilityOpts?.projectId)
    const legacyConfigs = visible.filter((server) => !isInkstoneManaged(server))
    if (!this.mcpManager) {
      this.mcpManager = new McpConnectionManager(legacyConfigs)
      return this.mcpManager
    }
    const releases = this.mcpManager.syncServers(legacyConfigs)
    for (const { serverId, release } of releases) {
      this.mcpReleasing.set(serverId, release)
      void release.then(
        (outcome) => {
          if (outcome.confirmed && this.mcpReleasing.get(serverId) === release) this.mcpReleasing.delete(serverId)
        },
        () => {
        }
      )
    }
    return this.mcpManager
  }

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

  private async reconcileLegacyForManaged(serverId: string): Promise<LegacyReconcileResult> {
    const result = await reconcileLegacyManaged(
      this.settingsSafeAccess(),
      serverId,
      this.capabilityOpts?.projectId
    )
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
    for (const serverId of this.mcpReleasing.keys()) {
      if (services.some((service) => service.serverId === serverId)) continue
      services.push({ serverId, status: 'connecting' })
    }
    return { services }
  }

  async capabilitySettingsSnapshot() {
    const commands = await this.rawCommands()
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
        return undefined
      }
    }
    const loadedForSettings = loadMcpServers()
    this.mcpConfigError = loadedForSettings.error
    const projectId = this.capabilityOpts?.projectId
    const visible = mcpServersForProject(loadedForSettings.servers, projectId)
    const managedConfigs = visible.filter((server) => isInkstoneManaged(server))
    for (const managed of managedConfigs) await this.reconcileLegacyForManaged(managed.id)
    const access = this.settingsSafeAccess()
    const manager = this.mcpConnectionManager()
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
        ...(server.migratedToNative ? { migratedToNative: server.migratedToNative } : {})
      })
    }
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

  async disconnectCapabilityMcp(serverId: string): Promise<boolean> {
    const access = this.settingsSafeAccess()
    const managed = await this.reconcileLegacyForManaged(serverId)
    if (managed.managed) return disconnectManagedServer(access, serverId, this.capabilityOpts?.projectId)
    return this.mcpConnectionManager().disconnect(serverId)
  }

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

  private async runMcpList() {
    const manager = this.mcpConnectionManager()
    const usable = manager.list().filter((server) => server.enabled !== false && !server.migratedToNative)
    const servers = await Promise.all(
      usable.map(async (server) => {
        try {
          const tools = await manager.listToolsCached(server.id)
          return {
            serverId: server.id,
            title: server.title ?? server.id,
            effect: server.effect ?? 'unknown',
            status: manager.statusOf(server.id).status,
            tools: tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description.replace(/\s+/g, ' ').slice(0, 200) } : {})
            }))
          }
        } catch (error) {
          return {
            serverId: server.id,
            title: server.title ?? server.id,
            effect: server.effect ?? 'unknown',
            status: manager.statusOf(server.id).status,
            tools: [],
            error: error instanceof Error ? error.message : String(error)
          }
        }
      })
    )
    return {
      data: { servers },
      summary: {
        kind: 'mcp',
        action: 'list',
        servers: servers.map((server) => ({
          serverId: server.serverId,
          status: server.status,
          tools: server.tools.map((tool) => tool.name),
          ...('error' in server ? { error: server.error } : {})
        })),
        ...(this.mcpConfigError ? { configWarning: this.mcpConfigError } : {})
      }
    }
  }

  private async runMcpCommand(action: string, params: Record<string, unknown>) {
    if (action === 'list') return this.runMcpList()
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
          toolError: outcome.toolError,
          bytes: outcome.bytes,
          ...(outcome.resultFile ? { resultFile: outcome.resultFile } : {}),
          ...(outcome.images ? { imageFiles: outcome.images } : {}),
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

  private knowledgeString(params: Record<string, unknown>, keys: string[]): string | undefined {
    return paramString(params, keys)
  }

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

    if (request.action === 'add' || request.action === 'set') {
      const snapshot = await this.readAgentProfileSnapshot()
      if (snapshot) {
        const itemCount = Array.isArray(params.items) ? params.items.length : 0
        const existing = await currentTaskPlan(sessionId).catch(() => null)
        const decision = decideTaskCreation({
          profile: snapshot.profile,
          activity: snapshot.activity,
          itemCount,
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
        if (err instanceof TaskPlanStoreError) {
          throw new CapabilityCommandError(err.code, err.message)
        }
        throw err
      }
    )

    if (!outcome.ok) {
      const current = await currentTaskPlan(sessionId).catch(() => null)
      throw new CapabilityCommandError(outcome.code, outcome.message, {
        revision: current?.state.revision ?? 0,
        todos: current?.state.todos ?? []
      })
    }

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
        replayed: outcome.replayed,
        items: state.todos.length,
        done: state.todos.filter((t) => t.done).length,
        changed: outcome.changed.length
      }
    }
  }

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

  private setStateFrom(data: Record<string, unknown>): void {
    const model = this.withAssumedWindow(normalizeModelInfo(data.model))
    this.compactionState = clearStaleRunning(this.compactionState, !!data.isCompacting)
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
      isAgentRunning: this.agentRunning,
      isCompacting: !!data.isCompacting,
      compaction: this.compactionState.running ?? undefined,
      lastCompaction: this.compactionState.last ?? undefined,
      ...(this.contextFrom ? { contextFrom: this.contextFrom } : {}),
      messageCount: Number(data.messageCount ?? 0),
      pendingMessageCount: Number(data.pendingMessageCount ?? 0),
      cwd: this.cwd,
      autoCompactionEnabled:
        data.autoCompactionEnabled === undefined ? undefined : !!data.autoCompactionEnabled,
      steeringMode: normalizeQueueMode(data.steeringMode),
      followUpMode: normalizeQueueMode(data.followUpMode)
    }
    this.push({ ch: 'state', payload: this.state })
    if (previous && previous.sessionId === this.state.sessionId && modelKeyOf(previous.model) !== modelKeyOf(model)) void this.refreshStats()
  }

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

  private emitRunSignals(evt: Record<string, unknown>, type: string): void {
    const sink = this.runObserver
    if (!sink || this.suppressPush) return
    const ctx = this.runObserverContext()
    if (!ctx) return
    const now = Date.now()
    for (const signal of signalsFromPiEvent(evt, now)) sink(ctx, signal)
    if (type === 'queue_update') {
      const queued = signalFromQueueUpdate(evt)
      if (queued) sink(ctx, queued)
    }
  }

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
    this.emitRunSignals(evt, type)

    switch (type) {
      case 'message_start': {
        const m = evt.message as PiMessage | undefined
        if (m?.role === 'user') {
          const norm = normalizeMessage(m, this.messages.length)
          if (norm) {
            if (isSubagentNotice(norm.text) && this.turn.messageIds.length > 0) {
              this.finishTimingSegmentForNotice()
            }
            this.messages.push(norm)
            this.indexCalls(norm)
            this.push({ ch: 'msg-add', payload: norm })
            this.consumeQueued(norm.text, imagesOf(m.content) ?? [])
          }
        } else if (m?.role === 'custom') {
          const norm = normalizeMessage(m, this.messages.length)
          if (norm) {
            this.messages.push(norm)
            this.push({ ch: 'msg-add', payload: norm })
          }
        } else if (m?.role === 'assistant') {
          const id = `m${this.messages.length}`
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
            pushedText: 0,
            pushedThinking: 0
          }
          this.streamLoopDetector = createStreamLoopDetector()
          this.push({
            ch: 'msg-add',
            payload: { id, role: 'assistant', text: '', responseDetail: this.turn.responseDetail, timestamp: Date.now() }
          })
          this.markStreaming(true)
        }
        break
      }

      case 'message_update': {
        const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
        if (!ev || !this.streaming) break
        const kind = String(ev.type ?? '')

        const u = toUsage(evt.usage as PiMessage['usage'], this.state?.model?.id)
        if (u) this.streaming.usage = u

        if (
          !this.streaming.firstTokenAt &&
          (kind === 'text_delta' || kind === 'thinking_delta' || kind === 'toolcall_start')
        ) {
          this.streaming.firstTokenAt = Date.now()
        }
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
            try {
              if (/[}\]]\s*$/.test(last.argsRaw)) last.args = JSON.parse(last.argsRaw)
            } catch {
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

      case 'message_end': {
        const m = evt.message as PiMessage | undefined
        if (m?.role !== 'assistant' || !this.streaming) break

        const s = this.streaming
        const id = s.id
        const endedMono = performance.now()
        this.streaming = null
        this.streamLoopDetector = null
        for (const c of s.tools) this.registerCall(c, id)

        const finalUsage = toUsage(m.usage, m.model ?? this.state?.model?.id) ?? s.usage
        if (typeof finalUsage?.output === 'number' && finalUsage.output > 0) {
          this.turn.outputTokens = Math.max(this.turn.outputTokens ?? 0, finalUsage.output)
        }
        const sp = this.speedOf({ ...s, usage: finalUsage }, Date.now(), this.turn.startedAt)
        const genTiming = this.generationTimingOf(s, endedMono)
        const msg: UIMessage = {
          id,
          role: 'assistant',
          text: s.text,
          thinking: s.thinking || undefined,
          thinkingMs: s.thinkingMs,
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
        this.turn.messageIds.push(id)
        this.backfillCompactionAfter()
        if (this.turn.startedMono !== undefined) {
          this.turn.elapsedMs = Math.max(1, Math.round(performance.now() - this.turn.startedMono))
        } else if (sp.elapsedMs !== undefined) {
          this.turn.elapsedMs = sp.elapsedMs
        }
        if (this.turn.elapsedMs !== undefined) msg.elapsedMs = this.turn.elapsedMs
        void this.persistTurnTiming(false)
        this.push({
          ch: 'msg-update',
          payload: { id, patch: msg }
        })
        if (m.stopReason === 'error' || m.stopReason === 'aborted') this.sessionMoveFailureVersion += 1
        this.pendingModelError = m.stopReason === 'error' ? { text: modelErrorText(m.errorMessage), retried: this.retrySeenThisRun } : undefined
        if (m.stopReason === 'error') {
          this.push({
            ch: 'agent-error',
            payload: { message: modelErrorNotice(m.errorMessage), text: modelErrorText(m.errorMessage), source: 'stop-reason' }
          })
          this.turn.terminal = 'failed'
        } else if (m.stopReason === 'aborted' && this.turn.terminal === 'interrupted') {
          this.loopGuardAbortedMessage = this.loopGuardAbortSent
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
          this.push({
            ch: 'agent-error',
            payload: { message: modelErrorNotice(m.errorMessage ?? 'Request aborted'), text: modelErrorText(m.errorMessage ?? 'Request aborted'), source: 'stop-reason' }
          })
        }
        this.markStreaming(false)
        break
      }

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
        if (isWriteTool(call.name)) {
          const path = writePathOf(call.args)
          if (path) snapshotBefore(call.id, path)
        } else if (isShellTool(call.name)) {
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
        this.markToolOutput(call.id)
        break
      }

      case 'tool_execution_end': {
        const call = this.findCall(String(evt.toolCallId ?? ''))
        if (!call) break
        const result = evt.result as { content?: PiContentBlock[]; details?: unknown } | undefined
        const cancelled = (evt as { cancelled?: boolean }).cancelled === true
        call.cancelled = cancelled || undefined
        call.status = evt.isError && !cancelled ? 'error' : 'ok'
        call.output = (result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        call.images = imagesOf(result?.content)
        call.details = result?.details
        call.endedAt = Date.now()
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

        if (call.name === 'panel_todos') {
          void this.refreshTodos()
        }
        break
      }

      case 'turn_start':
        this.pendingRequestMono = performance.now()
        break

      case 'agent_start':
        this.wroteThisRun = false
        this.turn.responseDetail = this.currentResponseDetail()
        if (!this.timingContinues || this.turn.startedMono === undefined) this.startTimingSegment()
        else if (this.turn.terminal === 'failed') this.turn.terminal = 'completed'
        this.timingContinues = false
        this.pendingRequestMono = undefined
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled': {
        const continuation = this.loopGuardAbortSent && this.loopGuardAbortedMessage && this.rpc && this.state?.sessionId
          ? { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardResumeVersion }
          : null
        const modelError = this.pendingModelError
        const errorContinuation = !continuation && modelError && !modelError.retried && isTransientModelError(modelError.text) &&
          this.rpc && this.state?.sessionId
          ? { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardContinuationVersion, reason: 'model-error' as const }
          : null
        this.pendingModelError = undefined
        this.retrySeenThisRun = false
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
        this.timingContinues = false
        void this.persistTurnTiming()
        void this.refreshState()
        void this.refreshStats({ allowPolicyTrigger: true })
        void this.refreshTodos()
        void this.maybeGenerateTitle({ force: true, onlyIfSamplesChanged: true })
        const task = continuation ? this.continueAfterLoopGuard(continuation)
          : errorContinuation ? this.continueAfterModelError(errorContinuation) : undefined
        if (task) {
          this.loopGuardContinueTask = task
          void task.finally(() => {
            if (this.loopGuardContinueTask === task) this.loopGuardContinueTask = undefined
          }).catch(() => undefined)
        }
        break
      }

      case 'turn_end':
        void this.refreshStats()
        break

      case 'agent_end':
        this.pendingRequestMono = undefined
        if (evt.willRetry === true) this.timingContinues = true
        if (evt.willRetry !== true) {
          this.streamLoopDetector = null
          void this.persistTurnTiming()
        }
        void this.refreshStats()
        break

      case 'queue_update':
        const update = {
          steering: Array.isArray(evt.steering) ? (evt.steering as string[]) : [],
          followUp: Array.isArray(evt.followUp) ? (evt.followUp as string[]) : [],
          sessionId: this.state?.sessionId,
          generation: this.capabilityOpts?.runnerGeneration
        }
        if (this.queueBusy) this.pendingQueueUpdate = update
        else this.publishQueue(update.steering, update.followUp)
        break

      case 'bash_execution_update': {
        if (!this.bash) break
        const evtId = String(evt.id ?? '')
        if (evtId && evtId !== this.bash.reqId) break

        this.bash.output += String(evt.delta ?? '')
        const call = this.findCall(this.bash.msgId)
        if (call) call.output = this.bash.output
        this.markToolOutput(this.bash.msgId)
        break
      }

      case 'compaction_start':
        this.setCompaction(this.compactionState, evt)
        this.markStreaming(true)
        void this.refreshState()
        break

      case 'compaction_end':
        if (evt.willRetry === true && this.turn.startedMono !== undefined) this.timingContinues = true
        this.setCompaction(this.compactionState, evt)
        this.markStreaming(false)
        void this.refreshState()
        void this.refreshStats()
        void this.hydrate()
        break

      case 'thinking_level_changed':
        void this.refreshState()
        break

      case 'session_info_changed': {
        const name = typeof evt.name === 'string' ? evt.name.trim() : ''
        const sessionId = this.state?.sessionId
        if (name && sessionId) this.push({ ch: 'session-title', payload: { sessionId, title: name } })
        void this.refreshState()
        break
      }

      case 'entry_appended': {
        const entry = evt.entry as { type?: unknown } | undefined
        if (entry?.type === 'usage') void this.refreshStats()
        break
      }

      case 'summarization_retry_scheduled': {
        const what = this.compactionState.running ? '压缩' : '分支摘要'
        const seconds = Math.max(1, Math.round(Number(evt.delayMs ?? 0) / 1000))
        const reason = modelErrorText(evt.errorMessage)
        this.push({
          ch: 'notify',
          payload: {
            id: `summary-retry-${Date.now()}`,
            method: 'notify',
            notifyType: 'warning',
            message: `${what}失败${reason ? `（${reason}）` : ''}，${seconds} 秒后第 ${Number(evt.attempt ?? 1)}/${Number(evt.maxAttempts ?? 1)} 次重试…`
          }
        })
        break
      }

      case 'auto_retry_start': {
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
        this.retrySeenThisRun = true
        if (this.pendingModelError) this.pendingModelError.retried = true
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
        if (evt.success === true) {
          this.retrySeenThisRun = false
          this.pendingModelError = undefined
        }
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

  private registerCall(call: UIToolCall, msgId?: string): void {
    this.callIndex.set(call.id, call)
    const owner = msgId ?? this.callOwner.get(call.id)
    if (owner) this.callOwner.set(call.id, owner)
  }

  private indexCalls(msg: UIMessage): void {
    for (const c of msg.toolCalls ?? []) this.registerCall(c, msg.id)
  }

  private findCall(id: string): UIToolCall | undefined {
    if (!id) return undefined
    return this.callIndex.get(id)
  }

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

  private pushTool(call: UIToolCall): void {
    const msgId = this.ownerOf(call)
    if (!msgId) return
    this.pushedOut.set(call.id, call.output?.length ?? 0)
    this.dirtyTools.delete(call.id)
    this.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
  }

  private markToolOutput(callId: string): void {
    if (!callId) return
    this.dirtyTools.add(callId)
    this.scheduleFlush()
  }

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

  private markDirty(): void {
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
      this.flushTools()
    }, this.flushDelay())
  }

  private flushDelay(): number {
    if (this.streaming) return FLUSH_MS
    const len = this.bash?.output.length ?? 0
    return Math.min(MAX_FLUSH_MS, Math.max(FLUSH_MS, Math.round(len / 2000)))
  }

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
          usage: s.usage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs,
          ...(genTiming ? { generationTiming: genTiming } : null)
        }
      }
    })
  }

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

  private finishTimingSegmentForNotice(): void {
    void this.turn.persist(true, this.state?.sessionFile, this.messages)
    this.startTimingSegment()
  }

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
    if (g.startEvent === 'turn_start') return g
    return {
      durationMs: g.durationMs,
      ...(g.decodeMs !== undefined ? { decodeMs: g.decodeMs } : {})
    }
  }

  private setAgentRunning(v: boolean): void {
    if (this.agentRunning === v) return
    this.agentRunning = v
    if (!this.state) return
    this.state = { ...this.state, isAgentRunning: v }
    this.push({ ch: 'state', payload: this.state })
    if (!v && this.state.isStreaming !== true && this.state.isCompacting !== true &&
      !this.queueState.steering.length && !this.queueState.followUp.length) {
      this.releaseExecutionAdmission()
    }
  }

  private executionActive(): boolean {
    return this.agentRunning || this.state?.isStreaming === true || this.state?.isCompacting === true || this.bash != null
  }

  private claimExecutionAdmission(): { ok: true } | { ok: false; error: string } {
    const port = this.capabilityOpts?.execution
    if (!port) return { ok: true }
    if (this.executionAdmissionToken !== undefined) return { ok: true }
    const claim = port.claim()
    if (!claim.ok) return claim
    this.executionAdmissionToken = claim.token
    return { ok: true }
  }

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

  private setCompaction(cur: CompactionState, evt: Record<string, unknown>): void {
    const next = reduceCompaction(cur, evt)
    if (!next) return
    this.compactionState = next
    if (next.last !== cur.last) this.contextFrom = contextFromRun(next.last) ?? this.contextFrom
    if (!this.state) return
    this.state = { ...this.state, compaction: next.running ?? undefined, lastCompaction: next.last ?? undefined, ...(this.contextFrom ? { contextFrom: this.contextFrom } : {}) }
    this.push({ ch: 'state', payload: this.state })
  }

  private withAssumedWindow(model: ModelInfo | undefined): ModelInfo | undefined {
    const key = modelKeyOf(model)
    if (!model || !key) return model
    const known = this.assumedWindows.get(key)
    if (known === undefined) {
      this.assumedWindows.set(key, false)
      void contextWindowAssumed(model.provider, model.id).then((assumed) => {
        if (!assumed) return
        this.assumedWindows.set(key, true)
        if (!this.state?.model || modelKeyOf(this.state.model) !== key) return
        this.state = { ...this.state, model: { ...this.state.model, contextWindowAssumed: true } }
        this.push({ ch: 'state', payload: this.state })
      }).catch(() => undefined)
    }
    return known ? { ...model, contextWindowAssumed: true } : model
  }

  private backfillCompactionAfter(): void {
    const measured = measuredAfterCompaction(this.compactionState.last, this.messages)
    if (!measured) return
    this.compactionState = { ...this.compactionState, last: measured }
    if (!this.state) return
    this.state = { ...this.state, lastCompaction: measured }
    this.push({ ch: 'state', payload: this.state })
  }

  private setContextFrom(next: ContextFrom | undefined): void {
    this.contextFrom = next
    if (!this.state) return
    const { contextFrom: _previous, ...rest } = this.state
    this.state = next ? { ...rest, contextFrom: next } : rest
    this.push({ ch: 'state', payload: this.state })
  }

  private streamLoopGuardEnabled(): boolean {
    return process.env.YAN_STREAM_LOOP_GUARD !== '0'
  }

  private checkStreamLoop(kind: 'thinking' | 'text', delta: string): void {
    const detector = this.streamLoopDetector
    if (!detector || !delta) return
    if (this.loopGuardTripped || this.loopGuardAbortSent) return
    if (!this.streamLoopGuardEnabled()) return
    const hit = kind === 'thinking' ? detector.onThinking(delta) : detector.onText(delta)
    if (!hit) return
    if (this.streaming?.toolOpen) {
      this.logStreamLoopGuard('break-suppressed', {
        rule: hit.rule, stream: kind, emittedChars: hit.emittedChars, repeatedChars: hit.repeatedChars,
        reason: 'tool-block-open', outcome: 'suppressed'
      })
      return
    }
    this.loopGuardStopTask = this.stopForLoopGuard(hit, kind)
  }

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
      await this.queueRun(async () => {
        if (!canStop()) return
        const original = this.queueState
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
        this.loopGuardAbortSent = false
        this.loopGuardContinuationVersion += 1
        if (this.turn.terminal === 'interrupted') this.turn.terminal = 'failed'
      }
    } finally {
      if (ownsRun()) this.loopGuardStopping = false
    }
  }

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

  private async continueAfterModelError(scope: AutoContinueScope): Promise<void> {
    try {
      if (!this.canContinueAfterLoopGuard(scope) || !(await this.readStreamLoopAutoContinue())) return
      if (!this.canContinueAfterLoopGuard(scope) || this.loopGuardAutoContinueCount >= 1) return
      const prompt = '[模型错误恢复 · 自动继续 1/1]\n上一轮模型请求因暂时性错误（超时、连接中断或服务过载）中断，且没有自动重试。请核对已完成的工具结果，在当前会话继续尚未完成的原任务；不要重复已完成的操作。若原任务已完成、需要用户决定或无法安全继续，请简短说明并结束。'
      const result = await this.send(prompt, undefined, undefined, scope)
      if (!result.ok && this.loopGuardContinuationVersion === scope.version) {
        this.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: `未能自动继续（${result.error ?? '发送失败'}），请手动决定。` } })
      }
    } catch (error) {
      if (this.canContinueAfterLoopGuard(scope)) {
        this.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: `未能自动继续（${error instanceof Error ? error.message : String(error)}），请手动决定。` } })
      }
    }
  }

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

  pendingUiRequests(): ExtensionUiRequest[] {
    return this.ui.pendingUiRequests()
  }

  answerUiRemotely(
    id: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): { ok: true } | { ok: false; code: 'question_not_pending' | 'sensitive_confirmation_requires_desktop' } {
    return this.ui.answerUiRemotely(id, answer)
  }

  respondUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): void {
    this.ui.respondUi(res, by)
  }

  private queueItems(raw: string[], previous: QueueItem[]): QueueItem[] {
    return reconcileQueueItems(raw, previous, text => this.newQueueItem(text))
  }

  private newQueueItem(text: string, images?: QueueItem['images']): QueueItem {
    return { id: `q-${(++this.queueSequence).toString(36)}`, text,
      ...(images?.length ? { images: images.map(image => ({ ...image })) } : {}) }
  }

  private liveQueueTexts(raw: string[], kind: 'steering' | 'followUp'): string[] {
    let skip = this.consumedEmptyQueue[kind]
    return raw.filter(text => text || skip-- <= 0)
  }

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

  private queueRun<T>(work: () => Promise<T>, allowLoopStop = false): Promise<T> {
    const owner = { rpc: this.rpc, sessionId: this.state?.sessionId, generation: this.capabilityOpts?.runnerGeneration }
    const guarded = async (): Promise<T> => {
      if (!allowLoopStop && (this.loopGuardStopping || this.loopGuardAbortSent)) throw new Error('正在按流式防护终止生成，暂不接受队列修改')
      if (owner.rpc !== this.rpc || owner.sessionId !== this.state?.sessionId || owner.generation !== this.capabilityOpts?.runnerGeneration) throw new Error('会话已切换，队列操作已停止')
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
    autoContinue?: AutoContinueScope
  ): Promise<{ ok: boolean; error?: string }> {
    const admission = this.claimExecutionAdmission()
    if (!admission.ok) return { ok: false, error: admission.error }
    let started = false
    try {
      const result = await this.sendAdmitted(text, images, mode, autoContinue)
      started = result.ok
      return result
    } finally {
      if (started) this.settleExecutionAdmission()
      else this.releaseExecutionAdmission()
    }
  }

  private async sendAdmitted(
    text: string,
    images?: { data: string; mimeType: string }[],
    mode?: 'steer' | 'followUp',
    autoContinue?: AutoContinueScope
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
        if (autoContinue.reason === 'model-error') {
          this.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'info',
            message: '模型请求因暂时性错误中断且未自动重试，正在同一会话自动继续（1/1）。' } })
        } else {
          this.logStreamLoopGuard('auto-continue-requested', { sessionId: autoContinue.sessionId, runId: autoContinue.runId, count: 1, limit: 1, outcome: 'sending' })
          this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'info',
            message: '已安全中止循环，正在同一会话自动继续（1/1）；不会执行收回的排队草稿。' } })
        }
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

  queueSnapshot(): QueueSnapshot {
    return snapshotQueue(this.queueState)
  }

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

  async steerQueued(queueId: string): Promise<{ ok: boolean; error?: string }> {
    return this.editQueued(queueId, true)
  }

  async removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; images?: QueueItem['images']; error?: string }> {
    return this.editQueued(queueId, false)
  }

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
    this.loopGuardContinuationVersion += 1
    if (this.loopGuardStopping || this.loopGuardAbortSent) {
      await this.loopGuardStopTask
      if (this.loopGuardAbortSent || !this.agentRunning) return { steering: [], followUp: [] }
    }
    this.cancelImages()
    this.cancelApprovals?.()
    this.turn.terminal = 'stopped'
    let cleared: QueueSnapshot = { steering: [], followUp: [] }
    try {
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
    }

    const stoppedAt = Date.now()
    const stoppedElapsed = this.turn.startedMono !== undefined
      ? Math.max(1, Math.round(performance.now() - this.turn.startedMono))
      : this.turn.elapsedMs
    const stoppedAnchor = [...this.messages].reverse().find((m) => m.role === 'user' && /^m\d+$/.test(m.id))?.id
    const stoppedMeta = (id: string): Pick<UIMessage, 'turnTiming' | 'elapsedMs'> => stoppedElapsed === undefined
      ? {}
      : {
          elapsedMs: stoppedElapsed,
          turnTiming: { logicalTurnId: stoppedAnchor ?? id, startedAt: stoppedAt - stoppedElapsed, endedAt: stoppedAt, elapsedMs: stoppedElapsed, terminalReason: 'stopped' }
        }
    const settledId = this.streaming ? null : this.agentRunning ? this.turn.messageIds.at(-1) : undefined
    if (settledId) {
      const settled = this.messages.find((m) => m.id === settledId)
      const patch = stoppedMeta(settledId)
      if (settled && patch.turnTiming) {
        Object.assign(settled, patch)
        this.push({ ch: 'msg-update', payload: { id: settledId, patch } })
      }
    }

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
        model: this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : undefined,
        timestamp: stoppedAt,
        ...stoppedMeta(s.id)
      }
      this.messages.push(msg)
      for (const c of s.tools) {
        this.registerCall(c, s.id)
        this.pushedOut.set(c.id, c.output?.length ?? 0)
        this.dirtyTools.delete(c.id)
      }
      this.push({ ch: 'msg-update', payload: { id: s.id, patch: msg } })
    }

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
    if (!this.loopGuardAbortSent) await this.rpc?.command('abort').catch(() => null)
    void this.refreshState()

    return cleared
  }

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
    const changes = endTreeSnapshot(msgId)
    const details: Record<string, unknown> = {}
    if (truncated) {
      details.truncated = truncated
      details.fullOutputPath = fullOutputPath
    }
    if (changes && (changes.files.length > 0 || changes.unknown)) details.workspaceChanges = changes
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
    this.capabilityOpts?.onBashSettled?.()
  }

  async abortBash(): Promise<void> {
    await this.rpc?.command('abort_bash').catch(() => null)
  }

  hasRunningBash(): boolean {
    return this.bash !== null
  }

  hasWrittenThisRun(): boolean {
    return this.wroteThisRun
  }

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
    this.contextFrom = undefined
    this.nativeBranchView = false
  }

  private recordExtUi(msg: ExtUiPush): void {
    if (extUiCleared(msg)) this.extUi.delete(extUiKey(msg))
    else this.extUi.set(extUiKey(msg), msg)
  }

  private async changeSessionScope<T>(run: (changed: () => void) => Promise<T>): Promise<T> {
    let changed = false
    this.suppressPush = true
    this.extUiPending = new Map()
    try {
      return await run(() => { changed = true })
    } finally {
      const pending = this.extUiPending
      this.extUiPending = null
      this.suppressPush = false
      if (changed) {
        const previous = [...this.extUi.entries()]
        this.extUi.clear()
        for (const [key, msg] of previous) if (!pending.has(key)) this.push(extUiRemoval(msg))
      }
      for (const msg of pending.values()) this.push(msg)
    }
  }

  async newSession(parentSession?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const payload: Record<string, unknown> = typeof parentSession === 'string' && parentSession ? { parentSession } : {}
    return this.changeSessionScope(async (changed) => {
      try {
        const res = await this.requireRpc().command('new_session', payload)
        if (!res.success) return { ok: false, error: res.error }
        if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
          return { ok: false, error: '会话切换被扩展取消' }
        }
        changed()
        this.ui.cancelPending()
        this.resetSessionScope()
        await this.hydrate()
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    return this.changeSessionScope(async (changed) => {
      const res = await this.requireRpc().command('switch_session', { sessionPath: path })
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      changed()
      this.ui.cancelPending()
      this.resetSessionScope()
      await this.hydrate()
      return { ok: true }
    })
  }

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

  async regenerateTitle(): Promise<{ ok: boolean; title?: string; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: '当前还没有可重生成标题的会话' }
    if (this.titleTried.has(sessionId)) return { ok: false, error: '标题正在生成，请稍候' }
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
    return this.changeSessionScope(async (changed) => {
      const res = await this.requireRpc().command<{ text?: string; cancelled?: boolean }>('fork', { entryId })
      if (!res.success) return { ok: false, error: res.error }
      if (res.data?.cancelled) return { ok: false, error: '分叉被扩展取消' }
      changed()
      this.resetSessionScope()
      this.ui.cancelPending()
      await this.hydrate()
      return { ok: true, text: res.data?.text }
    })
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    return this.changeSessionScope(async (changed) => {
      const res = await this.requireRpc().command<{ cancelled?: boolean }>('clone')
      if (!res.success) return { ok: false, error: res.error }
      if (res.data?.cancelled) return { ok: false, error: '复制被扩展取消' }
      changed()
      this.resetSessionScope()
      this.ui.cancelPending()
      await this.hydrate()
      return { ok: true }
    })
  }

  async forkPoints(): Promise<ForkPoint[]> {
    if (!this.rpc) return []
    const res = await this.rpc.command<{ messages?: ForkPoint[] }>('get_fork_messages')
    return res.success ? (res.data?.messages ?? []) : []
  }

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
      this.ui.cancelPending()
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
    await this.listThinkingLevels()
    await this.refreshStats()
    return { ok: true }
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

  async abortRetry(): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const res = await this.rpc.command('abort_retry')
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async cycleModel(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.cycleModelBy(1)
  }

  async cycleModelBack(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.cycleModelBy(-1)
  }

  private async cycleModelBy(dir: 1 | -1): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.enqueueCapabilityChange(() => this.cycleModelNow(dir))
  }

  private async nativeCycleLength(): Promise<number> {
    const models = await this.listModels()
    if (!this.nativeRuntime) return models.length
    const scoped = await this.nativeRuntime.getScopedModels()
    if (!scoped.scopedModels.length) return models.length
    const available = new Set(models.map(model => `${model.provider}/${model.id}`))
    return scoped.scopedModels.filter(item => available.has(item.key)).length
  }

  private async cycleModelNow(dir: 1 | -1): Promise<{ ok: boolean; error?: string; to?: string }> {
    if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
    const steps = dir === 1 ? 1 : (await this.nativeCycleLength()) - 1
    if (steps < 1) return { ok: false, error: '只有一个可用模型' }
    this.loopGuardContinuationVersion += 1
    let landed: { name?: string; id?: string } | undefined
    for (let i = 0; i < steps; i += 1) {
      const res = await this.requireRpc().command<{ model?: { name?: string; id?: string } } | null>('cycle_model')
      if (!res.success) return { ok: false, error: res.error }
      if (!res.data?.model) return { ok: false, error: '只有一个可用模型' }
      landed = res.data.model
    }
    await this.refreshState()
    await this.listThinkingLevels()
    await this.refreshStats()
    return { ok: true, to: landed?.name || landed?.id }
  }

  async cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.enqueueCapabilityChange(async () => {
      if (!this.rpc) return { ok: false, error: 'pi 尚未就绪' }
      const res = await this.rpc.command<{ level?: string } | null>('cycle_thinking_level')
      if (!res.success) return { ok: false, error: res.error }
      const level = res.data?.level
      if (!level) return { ok: false, error: '当前模型不支持思考' }
      this.loopGuardContinuationVersion += 1
      await this.refreshState()
      return { ok: true, to: level }
    })
  }

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
      return mergeCommandDescriptors([])
    }
  }

  private async rawCommands(): Promise<RawSkillCommand[]> {
    if (!this.rpc) return []
    try {
      const res = await this.rpc.command<{ commands?: unknown[] }>('get_commands')
      return res.success ? ((res.data?.commands ?? []) as RawSkillCommand[]) : []
    } catch {
      return []
    }
  }

  get capabilityProjectId(): string | null {
    return this.capabilityOpts?.projectId ?? null
  }

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

  async getMessages(): Promise<UIMessage[]> {
    return this.messages
  }

  async refreshState(): Promise<SessionState | null> {
    try {
      const res = await this.rpc?.command('get_state')
      if (res?.success) this.setStateFrom(res.data as Record<string, unknown>)
    } catch {
    }
    return this.state
  }

  async refreshStats(_opts: { allowPolicyTrigger?: boolean; expectGeneration?: number } = {}): Promise<SessionStats | null> {
    try {
      const generation = this.capabilityOpts?.runnerGeneration
      const res = await this.rpc?.command<SessionStats>('get_session_stats')
      if (res?.success && res.data) {
        if (_opts.expectGeneration !== undefined && generation !== _opts.expectGeneration) return null
        if (_opts.expectGeneration !== undefined && this.capabilityOpts?.runnerGeneration !== _opts.expectGeneration) return null
        const stats = await this.withOverheadUsage(this.statsForCurrentModel(res.data))
        if (_opts.expectGeneration !== undefined && this.capabilityOpts?.runnerGeneration !== _opts.expectGeneration) return null
        this.push({ ch: 'stats', payload: stats })
        return stats
      }
    } catch { }
    return null
  }

  private async maybeGenerateTitle(
    opts: { force?: boolean; candidate?: boolean; lockHeld?: boolean; onlyIfSamplesChanged?: boolean; sessionId?: string } = {}
  ): Promise<string | null> {
    const st = this.state
    const rpc = this.rpc
    const titleLifecycle = this.titleLifecycle
    if (!st || !rpc || this.stopping || (opts.sessionId && st.sessionId !== opts.sessionId)) return null
    if (!opts.lockHeld && this.titleTried.has(st.sessionId)) return null

    const users = this.messages.filter(
      (m) => m.role === 'user' && (m.text.trim() || m.images?.length)
    )
    if (users.length === 0) return null

    const samples = titleSamples(users)
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

      const stillSameSession = this.state?.sessionId === sessionId
      if (stillSameSession && this.lastTitle !== res.title) {
        this.lastTitle = res.title
        const ok = await this.rpc?.command('set_session_name', { name: res.title })
        if (ok?.success) await this.refreshState()
      }
      if (this.stopping || this.rpc !== rpc || this.titleLifecycle !== titleLifecycle) return null
      this.push({ ch: 'session-title', payload: { sessionId, title: res.title } })
      return res.title
    } catch (e) {
      console.error('[agent] 标题生成失败：', e)
      return null
    } finally {
      if (!opts.lockHeld) this.titleTried.delete(sessionId)
    }
  }

  getState(): SessionState | null {
    return this.state
  }

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

  nativeBootWitness(): McpNativeBootWitness | null {
    if (!this.nativeWitness) return null
    return {
      ...this.nativeWitness,
      generation: this.capabilityOpts?.runnerGeneration ?? this.nativeWitness.generation
    }
  }

  setRunnerGeneration(generation: number): void {
    if (this.capabilityOpts && Number.isSafeInteger(generation) && generation > 0) {
      if (this.capabilityOpts.runnerGeneration !== generation) this.releaseExecutionAdmission()
      this.capabilityOpts.runnerGeneration = generation
    }
  }

  private async withOverheadUsage(stats: SessionStats): Promise<SessionStats> {
    const entries = await this.sessionEntriesLite().catch(() => null)
    if (!entries) return stats
    const sum: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let found = false
    for (const e of entries) {
      if (e.type !== 'compaction' && e.type !== 'branch_summary' && e.type !== 'usage') continue
      const u = e.usage as Partial<Record<keyof TokenCounts, unknown>> | undefined
      if (!u) continue
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        const v = u[key]
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          sum[key] += v
          found = true
        }
      }
    }
    return found ? { ...stats, overheadUsage: sum } : stats
  }

  private statsForCurrentModel(stats: SessionStats): SessionStats {
    const modelKey = modelKeyOf(this.state?.model)
    let costEstimated = 0
    let countedUntil: number | null = null
    for (const msg of this.messages) {
      if (msg.usage?.costEstimated) costEstimated += msg.usage.cost
      if (msg.role === 'assistant' && hasUsageNumbers(msg.usage) && typeof msg.timestamp === 'number') {
        countedUntil = Math.max(countedUntil ?? msg.timestamp, msg.timestamp)
      }
    }
    const priced = costEstimated > 0 ? { cost: stats.cost + costEstimated, costEstimated } : {}
    if (!stats.contextUsage) return { ...stats, ...priced, countedUntil }
    return {
      ...stats,
      ...priced,
      countedUntil,
      contextUsage: {
        ...stats.contextUsage,
        ...(modelKey ? { modelKey } : {}),
        availability: typeof stats.contextUsage.tokens === 'number' ? 'known' : 'unknown',
        estimated: false
      }
    }
  }

  getPendingUiCount(): number {
    return this.ui.pending.size
  }

  async reloadMcpServers(): Promise<void> {
    const old = this.mcpManager
    this.mcpManager = undefined
    await old?.close().catch(() => undefined)
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
    this.cancelApprovals?.()
    this.capabilityServer?.stop()
    this.capabilityServer = undefined
    this.yanCliEnv = undefined
    this.mcpAppToolsSnapshot = undefined
    this.nativeWitness = null
    this.nativeWitnessPending = null
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
