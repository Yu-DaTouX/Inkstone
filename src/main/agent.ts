import { pick } from '../shared/ui-lang'
import { isRestoredReadonly, restoredReadonlyMessage } from './restored-readonly'
import { EventEmitter } from 'node:events'
import { dangerGuardPrefs, getSettings } from './settings'
import { randomUUID } from 'node:crypto'
import { runPluginCommand } from './plugin-commands'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { listManagedSkills, managedSkillOf, type ManagedSkillEntry } from './skill-manager'
import { acquiredUserSkillNames, listSessionSkills, promoteSessionSkill, removeSessionSkill } from './capabilities/acquired-skills'
import { runArtifactPreview } from './artifact-preview-command'
import { runConsentRequestCommand } from './agent-commands/consent-request'
import { runMcpCommand } from './agent-commands/mcp-command'
import { runOfficeReadCommand } from './agent-commands/office-read'
import { runSkillRead } from './agent-commands/skill-read'
import { runSkillSave } from './agent-commands/skill-save'
import { runDangerConfirmCommand, runDangerReviewCommand } from './agent-commands/danger-confirm'
import type { ModelReviewReceiptInput } from './approval-log'
import { runFileTrashCommand } from './agent-commands/file-trash'
import { runSessionMoveCommand } from './agent-commands/session-move'
import { runArtifactExportImageCommand, runArtifactExportVideoCommand } from './agent-commands/artifact-export'
import { PiRpc, resolvePi } from './protocol'
import { assistantModelIdentity } from '../shared/assistant-model'
import { continuationPrompt } from '../shared/continuation-prompt'
import { NativeSessionRuntime, type NavigateTreeResult, type ScopedModelsSnapshot, type ProjectTrustSnapshot } from './native-session-runtime'
import { nativeActiveBranch } from './native-session-history'
import { flattenNativeTree, type NativeTreeFlatNode } from '../shared/native-session'
import { allowTrust, revokeTrust } from './project-trust'
import { workspaceMutationInProgress } from './workspace-mutation'
import type { ExecuteAdmissionPort } from './session-send-guard'
import { SessionItemProjector, projectHistory } from './session-items/projector'
import { planSessionSync, planSessionSyncAgainst } from './session-sync-plan'
import { rememberSyncBaseline, takeSyncBaseline } from './sync-baseline'
import { messageSyncSignature } from '../shared/session-sync'
import { QueueCoordinator } from './queue-coordinator'
import { mergeToolDetails, streamsHtmlWriteArgs, toolOutputPushMode, type ToolResultPayload } from './session-items/tool-events'
import { GENERATION_MISMATCH_ERROR, SessionOperationGate, generationMatches, type SessionOperation } from './session-operation-gate'
import { apiKeyLooksUnusable, isAuthRejected, isTransientModelError, modelErrorNotice, modelErrorText } from '../shared/model-errors'
import { readAuthEntry } from './credentials'
import { failoverApiKey } from './api-key-pool'
import { settledTurnOutcome } from '../shared/turn-outcome'
import { isQuotaWaitError, isRateLimitError } from '../shared/quota-resume'
import { isSubagentNotice } from '../shared/subagent-notice'
import { agentOwnedPiArgs, nativePiToolsSupported } from '../shared/agent-context'
import type { CapabilityCommandResult, CapabilityHandlers, YanCliEnv } from './capability-server'
import { CapabilityCommandError, CapabilityServer } from './capability-server'
import type { ApprovalDecision } from '../shared/approval'
import {
  type ConsentAnswer,
  type ConsentKeyParts,
  type ConsentVerdict
} from '../shared/tool-consent'
import { ensureYanLauncher } from './yan-cli'
import {
  assistantError,
  imagesOf,
  toUsage,
  entryMessage,
  type PiMessage
} from './normalize'
import { serverSearchCalls } from './server-search-calls'
import { SESSIONS_DIR, SESSIONS_DIR_IS_OVERRIDE } from './sessions'
import { snapshotQueue } from './queue-items'
import type { QueueRewriteResult } from './queue-edit'
import { contextWindowAssumed } from './custom-providers'
import { attributeCompaction, clearStaleRunning, contextFromEntry, contextFromRun, EMPTY_COMPACTION_ORIGIN, EMPTY_COMPACTION_STATE, measuredAfterCompaction, projectTrustedFrom, reduceCompaction, type CompactionOrigin, type CompactionState } from './compaction'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { androidAgentEnv } from './android/android-paths'
import { projectPackageDirs } from './packages'
import { generationTiming, turnTiming } from '../shared/turn-timing'
import { applyTurnTimings, readTurnTimings, timingKey } from './turn-timing-store'
import { mergeCommandDescriptors } from './command-registry'
import { cachedTitles, fallbackTitle, generateTitle, manualTitleOf, setManualTitle } from './title'
import { readSessionMessages, type ReadResult } from './session-reader'
import { SessionEntriesLite } from './session-entries-lite'
import { withTrailingEntryIds } from './live-entry-ids'
import { localizeImage } from './image-store'
import { todoSnapshotsFromEntries } from './todo-snapshots'
import { applyTaskPlanOperation, currentTaskPlan, readTaskPlanLog, TaskPlanStoreError } from './task-plan-store'
import { isSafeSessionId } from './session-id'

import { questionLog } from './question-log'
import { approvalLog } from './approval-log'
import { parseQuestionAnswers, parseQuestionFields, QuestionFormError, separateSecrets, summarizeAnswers, type QuestionField } from '../shared/question-form'

import { requestedTimeout } from '../shared/ui-timeout'
import { createStreamLoopDetector, type LoopHit, type StreamLoopDetector } from '../shared/stream-loop-detector'
import { skillsFromCommands, type RawSkillCommand } from './capabilities/skill-service'
import { CapabilityAcquisition } from './capabilities/acquisition-commands'

import { BrowserCommands } from './browser-commands'
import { TerminalAgentCommands } from './terminal-agent'
import { BackgroundBashCommands } from './background-bash'
import { TerminalNoticeDelivery } from './terminal-notice-delivery'
import { PhoneAgentCommands } from './phone-agent'
import { terminalAgentHost } from './terminal-agent-host'
import { LookupCommands } from './lookup-commands'
import { TurnTimingTracker } from './turn-timing-tracker'
import { UiRequests, questionToolCallId, type HostUiResponse, type UiAnswerResult } from './ui-requests'
import { runSignalFromUiRequest, runSignalFromUiResolved, signalFromQueueUpdate, signalsFromPiEvent } from './runs/pi-events'
import type { RunModel, RunSignal } from '../shared/runs'
import { RunnerMcpConnections } from './mcp/runner-connections'
import {
  captureNativeStartupWitness,
  newBootId,
  verifyNativeStartupWitness,
  type McpNativeBootWitness,
  type McpNativeConfigReader
} from './mcp/app-native-witness'
import { runMcpAppProxyCommand } from './mcp/app-proxy-service'
import type { McpServerStatus } from '../shared/mcp'
import type { ApprovalOwner } from '../shared/approval'
import { taskPlanLogEntry, type TaskAction, type TaskPlanRequest } from '../shared/task-plan'
import { titleSampleImages, titleSamples, titleSampleText, type TitleSampleMessage } from '../shared/title-samples'
import { beginTreeSnapshot, endTreeSnapshot, isShellTool, isWriteTool, snapshotAfter, snapshotBefore, writePathOf } from './snapshots'
import type { QueueEditOp } from '../shared/ipc'
import type { BrowserActionOptions, BrowserActionReceipt } from './browser/receipt'
import { ArtifactStore } from './artifacts'
import { hasBash } from './git-runtime'
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
  RetryRun,
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
import { hasUsageNumbers } from '../shared/turns'
import type { SubagentForkSource } from './subagent-fork'
import { isUltracodeOn, setUltracodeOn } from './ultracode-sessions'
import { readPendingModelSwitch, takePendingModelSwitch, writePendingModelSwitch } from './pending-model-switch'
import { captureMoveContinuation, type SessionMoveAnswer, type SessionMovePrompt } from './session-move'

const FLUSH_MS = 16
const AUTH_BLIP_RETRY_MS = 5000
const MAX_FLUSH_MS = 120
const HTML_ARGS_PUSH_MS = 600

const COMPACT_REQUEST_TIMEOUT_MS = 300_000
const BASH_REQUEST_TIMEOUT_MS = 30 * 60_000
const STOP_ABORT_TIMEOUT_MS = 5_000
const STOP_ABORT_BASH_TIMEOUT_MS = 2_000
const STOP_TOTAL_BUDGET_MS = 12_000

async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms))
  })
  try {
    await Promise.race([work.then(() => undefined, () => undefined), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
type AutoContinueScope = { rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number; reason?: 'model-error' | 'key-failover' | 'account-switch' }

export type BrowserObservationResult = BrowserCommandResult & { observation?: BrowserObservation; receipt?: BrowserActionReceipt }

export interface BrowserCommandHost {
  forSession?(sessionId: string): BrowserCommandHost
  runScript?(code: string, signal?: AbortSignal): Promise<unknown>
  guide?(): Promise<string>
  getState(): BrowserState
  setAutomationOwner?(owner?: string): void
  setAgentSession?(sessionId: string): void
  getOwnedDownload?(owner: string): BrowserState['lastDownload']
  pendingDownloads?(): string[]
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
  click(ref: string, options?: BrowserActionOptions): Promise<BrowserObservationResult>
  type(ref: string, text: string, options?: BrowserActionOptions): Promise<BrowserObservationResult>
  select(ref: string, value: string, options?: BrowserActionOptions): Promise<BrowserObservationResult>
  press(key: string, options?: BrowserActionOptions): Promise<BrowserObservationResult>
  scroll(deltaX: number, deltaY: number): Promise<BrowserObservationResult>
  requestUserControl(request?: { reason?: string; sessionId?: string }): BrowserState | Promise<BrowserState>
  screenshot(): Promise<{ mimeType: string; data: Buffer }>
}

export interface SubagentCommandContext {
  model?: string
  cwd: string
  parentSessionId?: string
  parentSessionFile?: string
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
  outsideTruncated?: boolean
  owner?: ApprovalOwner
  toolCallId?: string
  signal?: AbortSignal
  timeoutMs?: number
  onTimeout?: 'review' | 'deny'
}

export interface ToolConsentPrompt {
  parts: ConsentKeyParts
  purpose: string
  verdict: ConsentVerdict
  cwd: string
  owner?: ApprovalOwner
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

function stateModelKey(data: unknown): string | undefined {
  return data && typeof data === 'object' ? modelKeyOf(normalizeModelInfo((data as Record<string, unknown>).model)) : undefined
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
    codex_image_tool_not_called: '图像服务只回了文字，没有调用出图工具',
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
  preserveResult?: (command: string, operationId: string, data: unknown) => void
  execution?: ExecuteAdmissionPort
  onBashSettled?: () => void
  trashItem?: (path: string) => Promise<void>
  previewHtml?: (htmlPath: string, root: string, options?: { at?: number[] }) => Promise<unknown>
  exportVideo?: (
    htmlPath: string,
    root: string,
    request: { fps?: number; scale?: number; outPath?: string }
  ) => Promise<unknown>
  exportImage?: (
    htmlPath: string,
    root: string,
    request: { width?: number; height?: number; scale?: number; selector?: string; outPath?: string }
  ) => Promise<unknown>
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

interface HydrateExpectation {
  sessionId?: string
  sessionFile?: string
  notSessionId?: string
  notSessionFile?: string
}

interface HydrateResult {
  ok: boolean
  error?: string
  changed?: boolean
}

function sameSessionPath(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()
}

async function sameSessionFileIdentity(a: string | undefined, b: string | undefined): Promise<boolean> {
  if (!a || !b) return false
  if (sameSessionPath(a, b)) return true
  const [left, right] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)])
  if (left && right && sameSessionPath(left, right)) return true
  const [leftStat, rightStat] = await Promise.all([stat(a, { bigint: true }).catch(() => null), stat(b, { bigint: true }).catch(() => null)])
  return !!leftStat && !!rightStat && leftStat.isFile() && rightStat.isFile() && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

function sessionSwitchUnconfirmed(): string {
  return pick('没能确认已经切到目标会话，请重新打开这个会话', 'Could not confirm the switch to the target session; reopen this session')
}

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
  private promptSuggestionExtension?: string
  private shellFallbackExtension?: string
  private responseDetailExtension?: string
  private preambleExtension?: string
  private languageExtension?: string
  private userAddressExtension?: string
  private ultracodeExtension?: string
  private turnModelSwitchExtension?: string
  private deferredModelSwitch?: {
    sessionId: string
    model?: ModelInfo
    thinkingLevel?: string
    previousModel?: ModelInfo
    previousThinkingLevel: string
  }
  private capabilityGuideExtension?: string
  private mcpAppProxyExtension?: string
  private phoneToolsExtension?: string
  private mcpAppToolsSnapshot?: string
  private nativeConfigReader?: McpNativeConfigReader
  private autoCompactExtension?: string
  private contextCompactExtension?: string
  private contextUsageExtension?: string
  private imageLabelsExtension?: string
  private repeatGuardExtension?: string
  private bundledSkills: string[] = []
  private userSkills?: () => Promise<string[]>
  private readHistory?: (sessionFile: string, liveRunId?: string) => Promise<ReadResult | null>
  private getResponseDetail?: () => ResponseDetail
  private getBrowserHost?: () => BrowserCommandHost | null
  private subagentHost?: SubagentCommandHost
  private confirmCapabilityAuthorization?: (
    request: CapabilityAuthorizationPrompt
  ) => Promise<CapabilityAuthorizationChoice>
  private readonly imageRequests = new Set<AbortController>()
  private confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
  private confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentAnswer | null>
  private confirmDanger?: (request: DangerConfirmPrompt) => Promise<ApprovalDecision | null>
  private recordDangerReview?: (sessionId: string | undefined, review: ModelReviewReceiptInput) => void
  private cancelApprovals?: (owner: ApprovalOwner) => void
  private activateApprovals?: (owner: ApprovalOwner) => void
  private retireApprovals?: (owner: ApprovalOwner) => void
  private rpcInstanceId = ''
  private readonly operations = new SessionOperationGate()
  private getPermissionMode?: () => Promise<'danger' | 'all'>
  private requestSessionMove?: (request: SessionMovePrompt) => Promise<SessionMoveAnswer>
  private switchSpareAccount?: (provider: string) => Promise<{ label: string; switched: boolean } | null>
  private dangerGuardExtension?: string
  private providerExtensions: string[] = []
  private yanCliEnv?: YanCliEnv
  private capabilityServer?: CapabilityServer
  private capabilityOpts?: CapabilityRunOptions
  private executionAdmissionToken?: number
  private executionRunObserved = false
  private executionAdmissionTimer?: ReturnType<typeof setTimeout>
  private runObserver?: RunObserver

  private capabilityChangeTail: Promise<void> = Promise.resolve()
  private readonly mcp = new RunnerMcpConnections({ projectId: () => this.capabilityOpts?.projectId })
  private readonly lookup = new LookupCommands({
    capabilityOpts: () => this.capabilityOpts,
    cwd: () => this.cwd,
    notifySearchApiMissing: () => this.push({ ch: 'search-api-hint', payload: {} })
  })
  private get commandHost() {
    return {
      cwd: () => this.cwd,
      rawCommands: () => this.rawCommands(),
      mcpConnectionManager: () => this.mcp.connectionManager(),
      mcpConfigError: () => this.mcp.configError(),
      permissionMode: async () => this.getPermissionMode?.(),
      confirmToolConsent: async (request: ToolConsentPrompt) => (this.confirmToolConsent ? this.confirmToolConsent(request) : null),
      confirmDanger: async (request: DangerConfirmPrompt) => (this.confirmDanger ? this.confirmDanger(request) : null),
      approvalOwner: () => this.approvalOwner(),
      recordDangerReview: (review: ModelReviewReceiptInput) => this.recordDangerReview?.(this.state?.sessionId, review),
      trashItem: () => this.capabilityOpts?.trashItem,
      session: () => ({ sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }),
      sessionMover: () => this.requestSessionMove,
      bundledSkills: () => this.bundledSkills,
      requestApproval: (request: { title: string; message: string; options: string[]; placeholder: string; timeout: number }) => this.requestApprovalChoice(request)
    }
  }
  private readonly browserCommands = new BrowserCommands({
    browserHostOrNull: () => this.getBrowserHost?.() ?? null,
    capabilityOpts: () => this.capabilityOpts,
    conversationId: () => this.state?.sessionId,
    cwd: () => this.cwd
  })

  private terminalTurnStop = new AbortController()

  private readonly terminalCommands = new TerminalAgentCommands(terminalAgentHost(), {
    ownerKeys: () => this.terminalOwnerKeys(),
    cwd: () => this.cwd,
    turnSignal: () => this.terminalTurnStop.signal,
    confirm: async (request) => {
      const result = await runDangerConfirmCommand(this.commandHost, { tool: 'terminal', detail: request.detail, reasons: request.reasons, outsideDirs: request.outsideDirs, ...(request.critical ? { critical: true } : {}) })
      const feedback = result.summary.feedback
      return { allowed: result.summary.allowed === true, ...(typeof feedback === 'string' && feedback ? { feedback } : {}) }
    },
    notify: (text, stillOwner, wake) => {
      void this.terminalNotices.deliver(text, stillOwner, wake)
    }
  })

  private readonly backgroundBash = new BackgroundBashCommands({
    ownerKeys: () => this.terminalOwnerKeys(),
    now: () => Date.now(),
    notify: (text, stillOwner, wake) => {
      void this.terminalNotices.deliver(text, stillOwner, wake)
    }
  })

  private readonly terminalNotices = new TerminalNoticeDelivery({
    session: () => {
      const state = this.state
      return {
        stopping: this.stopping,
        ready: !!this.rpc?.running && !!state && !state.isCompacting && !this.holdsNotices(),
        running: !!state && (state.isAgentRunning || state.isStreaming)
      }
    },
    ownerKeys: () => this.terminalOwnerKeys(),
    steer: (text) => this.steer(text),
    followUp: (text) => this.send(text, undefined, 'followUp'),
    submitHeld: (text) => this.queue.submit('steer', text, undefined, 'steering', this.queue.payload({ text }))
  })

  private terminalOwnerKeys(): string[] {
    return [this.state?.sessionFile, this.state?.sessionId].filter((key): key is string => typeof key === 'string' && key.length > 0)
  }

  hasPendingTerminalWork(): boolean {
    return this.terminalNotices.hasPendingWork()
  }

  private readonly phoneCommands = new PhoneAgentCommands({ opsDir: () => this.capabilityOpts?.opsDir ?? join(YAN_DIR, 'ops') })

  private readonly acquisition = new CapabilityAcquisition({
    capabilityOpts: () => this.capabilityOpts,
    cwd: () => this.cwd,
    mcpConfigError: () => this.mcp.configError(),
    mcpConnectionManager: () => this.mcp.connectionManager(),
    rawCommands: () => this.rawCommands(),
    push: (msg) => this.push(msg),
    getState: () => this.getState(),
    confirmCapabilityAuthorization: () => this.confirmCapabilityAuthorization,
    bundledSkills: () => this.bundledSkills,
    requestApproval: (request) => this.requestApprovalChoice(request)
  })

  private async requestApprovalChoice(request: { title: string; message: string; options: string[]; placeholder: string; timeout: number }): Promise<HostUiResponse> {
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

  private readonly items = new SessionItemProjector((mimeType, data) => this.localizeHistoryImage(mimeType, data))
  private get messages(): UIMessage[] {
    return this.items.uiMessages()
  }
  private set messages(messages: UIMessage[]) {
    this.items.load(messages)
  }
  private suppressPush = false
  private afterScope: Array<() => void> = []
  private scopeDepth = 0
  private scopeChanged = false
  private extUi = new Map<string, ExtUiPush>()
  private extUiPending: Map<string, ExtUiPush> | null = null
  private streaming: {
    id: string
    thinkingMs?: number
    thinkingStartedAt?: number
    thinkingLive?: boolean
    responseDetail: ResponseDetail
    startedAt?: number
    firstTokenAt?: number
    generationStartedMono?: number
    requestStartEvent?: 'turn_start'
    firstContentMono?: number
    firstOutputMono?: number
    usage?: Usage
    pushedText: number
    pushedThinking: number
    toolOpen?: boolean
  } | null = null
  private agentRunning = false
  private liveItemEdits = 0
  private hydrateDeferred: { sessionId?: string; sessionFile?: string } | null = null
  private pendingAborts = 0
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
  private loopGuardContinueTask?: Promise<boolean>
  private loopGuardHit?: { rule: LoopHit['rule']; stream: 'thinking' | 'text' }
  private retrySeenThisRun = false
  private pendingModelError?: { text: string; retried: boolean }
  private pendingTruncated = false
  private quotaExhausted = false

  private readonly turn = new TurnTimingTracker()
  private pendingRequestMono?: number
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirtyTools = new Set<string>()
  private pushedOut = new Map<string, number>()
  private pushedOutText = new Map<string, string>()
  private pushedArgs = new Map<string, unknown>()
  private htmlArgsPushedAt = new Map<string, number>()

  private state: SessionState | null = null
  private compactionState: CompactionState = EMPTY_COMPACTION_STATE
  private compactionOrigin: CompactionOrigin = EMPTY_COMPACTION_ORIGIN
  private retryRun: RetryRun | null = null
  private contextFrom: ContextFrom | undefined
  private timingContinues = false
  private readonly assumedWindows = new Map<string, boolean>()

  private readonly entriesLite = new SessionEntriesLite()

  private sessionReadCurrent(): () => boolean {
    const rpc = this.rpc
    const sessionId = this.state?.sessionId
    const sessionFile = this.state?.sessionFile
    const generation = this.capabilityOpts?.runnerGeneration
    return () => !this.stopping && this.rpc === rpc && this.state?.sessionId === sessionId &&
      this.state?.sessionFile === sessionFile && this.capabilityOpts?.runnerGeneration === generation
  }

  private async sessionEntriesLite(): Promise<Record<string, unknown>[] | null> {
    const current = this.sessionReadCurrent()
    const rpc = this.rpc
    const lite = await this.entriesLite.entries(this.state?.sessionFile).catch(() => null)
    if (!current()) return null
    if (lite) return lite
    const res = await rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
    if (!current()) return null
    return res?.success ? (res.data?.entries ?? []) : null
  }

  private readonly ui = new UiRequests({
    push: (msg) => this.push(msg),
    respondToPi: (res) => this.rpc?.respondUi(res)
  })

  private readonly localizeHistoryImage = (mimeType: string, data: string): string =>
    localizeImage(join(YAN_DIR, 'attachments'), mimeType, data)

  liveTimingRunId(): string | undefined {
    return this.agentRunning ? this.turn.runId : undefined
  }

  private async readHistoryOf(sessionFile: string): Promise<ReadResult | null> {
    if (this.readHistory) return this.readHistory(sessionFile, this.liveTimingRunId()).catch(() => null)
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
    promptSuggestionExtension?: string
    shellFallbackExtension?: string
    responseDetailExtension?: string
    preambleExtension?: string
    languageExtension?: string
    userAddressExtension?: string
    ultracodeExtension?: string
    turnModelSwitchExtension?: string
    capabilityGuideExtension?: string
    mcpAppProxyExtension?: string
    phoneToolsExtension?: string
    mcpAppToolsSnapshot?: string
    nativeConfigReader?: McpNativeConfigReader
    autoCompactExtension?: string
    contextCompactExtension?: string
    contextUsageExtension?: string
    imageLabelsExtension?: string
    nativeSessionExtension?: string
    repeatGuardExtension?: string
    bundledSkills?: string[]
    userSkills?: () => Promise<string[]>
    readHistory?: (sessionFile: string, liveRunId?: string) => Promise<ReadResult | null>
    getResponseDetail?: () => ResponseDetail
    browserHost?: () => BrowserCommandHost | null
    subagentHost?: SubagentCommandHost
    confirmCapabilityAuthorization?: (
      request: CapabilityAuthorizationPrompt
    ) => Promise<CapabilityAuthorizationChoice>
    confirmExternalApi?: (request: ExternalApiConfirmationRequest) => Promise<boolean>
    confirmToolConsent?: (request: ToolConsentPrompt) => Promise<ConsentAnswer | null>
    confirmDanger?: (request: DangerConfirmPrompt) => Promise<ApprovalDecision | null>
    recordDangerReview?: (sessionId: string | undefined, review: ModelReviewReceiptInput) => void
    cancelApprovals?: (owner: ApprovalOwner) => void
    activateApprovals?: (owner: ApprovalOwner) => void
    retireApprovals?: (owner: ApprovalOwner) => void
    getPermissionMode?: () => Promise<'danger' | 'all'>
    requestSessionMove?: (request: SessionMovePrompt) => Promise<SessionMoveAnswer>
    switchSpareAccount?: (provider: string) => Promise<{ label: string; switched: boolean } | null>
    dangerGuardExtension?: string
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
      preserveResult?: (command: string, operationId: string, data: unknown) => void
      onBashSettled?: () => void
      trashItem?: (path: string) => Promise<void>
      previewHtml?: (htmlPath: string, root: string, options?: { at?: number[] }) => Promise<unknown>
      exportVideo?: (
        htmlPath: string,
        root: string,
        request: { fps?: number; scale?: number; outPath?: string }
      ) => Promise<unknown>
      exportImage?: (
        htmlPath: string,
        root: string,
        request: { width?: number; height?: number; scale?: number; selector?: string; outPath?: string }
      ) => Promise<unknown>
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
    this.promptSuggestionExtension = opts.promptSuggestionExtension
    this.shellFallbackExtension = opts.shellFallbackExtension
    this.responseDetailExtension = opts.responseDetailExtension
    this.preambleExtension = opts.preambleExtension
    this.languageExtension = opts.languageExtension
    this.userAddressExtension = opts.userAddressExtension
    this.ultracodeExtension = opts.ultracodeExtension
    this.turnModelSwitchExtension = opts.turnModelSwitchExtension
    this.capabilityGuideExtension = opts.capabilityGuideExtension
    this.mcpAppProxyExtension = opts.mcpAppProxyExtension
    this.phoneToolsExtension = opts.phoneToolsExtension
    this.mcpAppToolsSnapshot = opts.mcpAppToolsSnapshot
    this.nativeConfigReader = opts.nativeConfigReader
    this.autoCompactExtension = opts.autoCompactExtension
    this.contextCompactExtension = opts.contextCompactExtension
    this.contextUsageExtension = opts.contextUsageExtension
    this.imageLabelsExtension = opts.imageLabelsExtension
    this.nativeSessionExtension = opts.nativeSessionExtension
    this.repeatGuardExtension = opts.repeatGuardExtension
    this.bundledSkills = opts.bundledSkills ?? []
    this.userSkills = opts.userSkills
    this.readHistory = opts.readHistory
    this.getResponseDetail = opts.getResponseDetail
    this.getBrowserHost = opts.browserHost
    this.subagentHost = opts.subagentHost
    this.confirmCapabilityAuthorization = opts.confirmCapabilityAuthorization
    this.confirmExternalApi = opts.confirmExternalApi
    this.confirmToolConsent = opts.confirmToolConsent
    this.confirmDanger = opts.confirmDanger
    this.recordDangerReview = opts.recordDangerReview
    this.cancelApprovals = opts.cancelApprovals
    this.activateApprovals = opts.activateApprovals
    this.retireApprovals = opts.retireApprovals
    this.getPermissionMode = opts.getPermissionMode
    this.requestSessionMove = opts.requestSessionMove
    this.switchSpareAccount = opts.switchSpareAccount
    this.dangerGuardExtension = opts.dangerGuardExtension
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
    let server: CapabilityServer | undefined
    try {
      const handlers: CapabilityHandlers = {
        run: (command, params, _ctx, signal) => this.runCapabilityCommand(command, params, signal)
      }
      server = new CapabilityServer({
        opsDir: opts.opsDir,
        handlers,
        toolBacked: this.toolBackedCommands(),
        ...(opts.preserveResult ? { preserveResult: opts.preserveResult } : {})
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
      if (server && this.capabilityServer !== server) server.stop()
      this.noteCapabilityProblem(`能力服务启动失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private toolBackedCommands(): Record<string, string> {
    return {
      ...(this.capabilityGuideExtension ? { 'tasks.apply': 'This session has the todos tool: call it to update the to-do list instead of yan tasks.' } : {}),
      ...(this.questionExtension ? { 'question.ask': 'This session has the question tool: call it to ask the user instead of yan question.' } : {})
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

  private lastTitle: string | undefined

  private readonly queue = new QueueCoordinator({
    owner: () => ({ rpc: this.rpc, sessionId: this.state?.sessionId, generation: this.capabilityOpts?.runnerGeneration }),
    push: (message) => this.push(message),
    pushAfterScope: (emit) => {
      if (this.suppressPush) this.afterScope.push(emit)
      else emit()
    },
    loopStopping: () => this.loopGuardStopping || this.loopGuardAbortSent,
    confirmAdmission: () => this.confirmExecutionAdmission()
  })
  private titleLifecycle = 0
  private stopping = false
  private spawnFailure: string | undefined
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
    this.queue.reset()
    this.streamLoopDetector = null
    this.loopGuardTripped = false
    this.loopGuardAbortSent = false
    this.loopGuardStopping = false
    this.loopGuardAbortedMessage = false
    this.loopGuardAutoContinueCount = 0
    this.loopGuardContinuationVersion += 1
    this.loopGuardHit = undefined
    this.setConn('starting')

    const probe = resolvePi({ override: this.piBin })
    const [, userSkillArgs, version, bashAvailable] = await Promise.all([
      this.ensureCapability(),
      this.userSkills ? this.userSkills().catch(() => [] as string[]) : Promise.resolve([] as string[]),
      probe.home ? readFile(join(probe.home, 'package.json'), 'utf8').then(text => JSON.parse(text).version as string).catch(() => undefined) : Promise.resolve(undefined),
      hasBash()
    ])
    const nativeTools = nativePiToolsSupported(version)
    const projectPackageArgs = nativeTools ? [] : await projectPiPackageArgs(this.cwd)
    const shellFallback = !bashAvailable
    const androidEnv = androidAgentEnv()
    const rpc = new PiRpc({
      cwd: this.cwd,
      piBin: this.piBin,
      args: agentOwnedPiArgs([
        '--no-extensions',
        ...(this.nativeSessionExtension ? ['--extension', this.nativeSessionExtension] : []),
        ...(nativeTools && this.codemodeExtension ? ['--extension', this.codemodeExtension] : []),
        ...(this.questionExtension ? ['--extension', this.questionExtension] : []),
        ...(this.shellFallbackExtension ? ['--extension', this.shellFallbackExtension] : []),
        ...(this.responseDetailExtension ? ['--extension', this.responseDetailExtension] : []),
        ...(this.preambleExtension ? ['--extension', this.preambleExtension] : []),
        ...(this.languageExtension ? ['--extension', this.languageExtension] : []),
        ...(this.userAddressExtension ? ['--extension', this.userAddressExtension] : []),
        ...(this.ultracodeExtension ? ['--extension', this.ultracodeExtension] : []),
        ...(this.turnModelSwitchExtension ? ['--extension', this.turnModelSwitchExtension] : []),
        ...(this.capabilityGuideExtension
          ? ['--extension', this.capabilityGuideExtension]
          : []),
        ...(this.autoCompactExtension ? ['--extension', this.autoCompactExtension] : []),
        ...(this.imageLabelsExtension ? ['--extension', this.imageLabelsExtension] : []),
        ...(this.repeatGuardExtension ? ['--extension', this.repeatGuardExtension] : []),
        ...(this.mcpAppProxyExtension ? ['--extension', this.mcpAppProxyExtension] : []),
        ...(this.phoneToolsExtension ? ['--extension', this.phoneToolsExtension] : []),
        ...(this.dangerGuardExtension ? ['--extension', this.dangerGuardExtension] : []),
        ...this.providerExtensions.flatMap((path) => ['--extension', path]),
        // 预测下一句和压缩扩展都要截取最终发出的请求体，必须排在所有 before_provider_request 改写者之后
        ...(this.promptSuggestionExtension ? ['--extension', this.promptSuggestionExtension] : []),
        ...(this.contextCompactExtension ? ['--extension', this.contextCompactExtension] : []),
        ...(this.contextUsageExtension ? ['--extension', this.contextUsageExtension] : []),
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
        ...androidEnv,
        ...(this.yanCliEnv && Object.keys(this.toolBackedCommands()).length
          ? { YAN_TOOL_BACKED: Object.keys(this.toolBackedCommands()).map((name) => name.split('.')[0]).join(',') }
          : {}),
        ...(this.yanCliEnv
          ? {
              YAN_CLI_URL: this.yanCliEnv.url,
              YAN_CLI_TOKEN: this.yanCliEnv.token,
              PATH: `${this.yanCliEnv.binDir}${delimiter}${androidEnv.PATH ?? process.env.PATH ?? ''}`
            }
          : {})
      }
    })
    this.rpc = rpc
    this.rpcInstanceId = randomUUID()
    this.activateApprovals?.(this.approvalOwner())
    this.nativeRuntime = new NativeSessionRuntime(
      { command: (type, payload, options) => rpc.command(type, payload, options) },
      undefined,
      (receipt) => {
        if (this.rpc !== rpc || receipt.op !== 'model_select') return
        void this.refreshState()
        void this.listThinkingLevels()
      }
    )

    this.spawnFailure = undefined
    rpc.on('stderr', (line) => {
      this.push({ ch: 'proc', payload: { state: 'stderr', detail: line } })
    })

    rpc.on('spawn-error', (err: Error) => {
      if (this.rpc !== rpc) return
      const raw = err instanceof Error ? err.message : String(err)
      this.spawnFailure = raw.slice(0, 300) || pick('未知启动错误', 'Unknown start error')
    })

    rpc.on('exit', (code) => {
      if (this.rpc !== rpc) return
      this.operations.reset()
      this.flushNow()
      const interrupted = this.streaming
      if (interrupted?.thinkingLive) {
        interrupted.thinkingLive = false
        this.push({ ch: 'msg-update', payload: { id: interrupted.id, patch: { thinkingLive: false } } })
      }
      this.streaming = null
      for (const call of this.items.cancelUnfinishedTools(Date.now())) this.pushTool(call)
      this.items.discardStreaming()
      this.bash = null
      this.backgroundBash.dispose()
      this.agentRunning = false
      this.releaseExecutionAdmission()
      this.compactionState = EMPTY_COMPACTION_STATE
      this.contextFrom = undefined
      this.nativeRuntime?.dispose()
      this.ui.rejectPendingHostUi('pi 已退出，问题请求已取消')
      this.ui.discardPending()
      this.cancelApprovals?.(this.approvalOwner())
      this.retireApprovals?.(this.approvalOwner())
      if (this.state) {
        this.state = { ...this.state, isAgentRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
        this.push({ ch: 'state', payload: this.state })
      }
      this.setConn('exited', pick(`pi 已退出（code=${code ?? 'null'}）`, `pi exited (code=${code ?? 'null'})`))
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
        return { ok: false, error: pick('pi 启动在采集归属事实期间被取消', 'pi start was cancelled while collecting ownership facts') }
      }
      if (capture.ok) this.nativeWitnessPending = capture.witness ?? null
    }

    rpc.spawn()

    const ok = await this.waitReady(20_000, rpc)
    if (!ok) {
      const msg = this.spawnFailure
        ? pick(`无法启动 pi：${this.spawnFailure}。可跑 npm run probe-pi 排查。`, `Cannot start pi: ${this.spawnFailure}. Run npm run probe-pi to investigate.`)
        : rpc.running
          ? pick('pi 启动超时（20s）。点「详情」看 stderr，或跑 npm run probe-pi。', 'pi start timed out (20s). See stderr under Details, or run npm run probe-pi.')
          : pick('pi 启动后立即退出。点「详情」看 stderr，或跑 npm run probe-pi。', 'pi exited right after starting. See stderr under Details, or run npm run probe-pi.')
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
      return { ok: false, error: pick('pi 启动在复核归属事实期间被取消', 'pi start was cancelled while rechecking ownership facts') }
    }

    void this.listThinkingLevels().catch(() => undefined)

    await this.hydrate()
    return { ok: true }
  }

  private async waitReady(timeoutMs: number, rpc: PiRpc): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.spawnFailure || this.rpc !== rpc || !rpc.running) return false
      try {
        const res = await this.requireRpc().command('get_state')
        if (res.success) return true
      } catch {
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  private asyncOwner(): { rpc: PiRpc | null; generation: number | undefined } {
    return { rpc: this.rpc, generation: this.capabilityOpts?.runnerGeneration }
  }

  private ownerCurrent(owner: { rpc: PiRpc | null; generation: number | undefined }): boolean {
    return !this.stopping && this.rpc === owner.rpc && this.capabilityOpts?.runnerGeneration === owner.generation
  }

  private async hydrate(expected?: HydrateExpectation): Promise<HydrateResult> {
    const syncedBefore = this.messages
    const scopeBefore = { sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }
    const editsBefore = this.liveItemEdits
    const supersededByLive = (): boolean => {
      if (!this.agentRunning || this.liveItemEdits === editsBefore) return false
      this.hydrateDeferred = { sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }
      return true
    }
    const matches = (sessionId: string | undefined, sessionFile: string | undefined): boolean => {
      if (!expected) return true
      if (expected.sessionId !== undefined && sessionId !== expected.sessionId) return false
      if (expected.sessionFile !== undefined && !sameSessionPath(sessionFile, expected.sessionFile)) return false
      if (expected.notSessionId !== undefined && sessionId === expected.notSessionId) return false
      if (expected.notSessionFile !== undefined && sameSessionPath(sessionFile, expected.notSessionFile)) return false
      return true
    }
    const matchesExpected = (): boolean => matches(this.state?.sessionId, this.state?.sessionFile)
    const superseded = (): HydrateResult => ({ ok: false, changed: true })
    const outsideExpected = (): boolean => !!expected && !matchesExpected()
    const rpc = this.requireRpc()
    const owner = this.asyncOwner()
    const state = await rpc.command('get_state').catch(() => null)
    if (!this.ownerCurrent(owner)) return superseded()
    if (expected && !state?.success) {
      return { ok: false, error: pick('读不到会话状态，没能确认当前会话；请重新打开这个会话', 'Could not read the session state, so the current session is unconfirmed. Reopen this session') }
    }
    if (expected && state?.success) {
      const data = state.data as Record<string, unknown>
      const sessionId = data.sessionId === undefined ? this.state?.sessionId : String(data.sessionId)
      const idMismatch =
        (expected.sessionId !== undefined && sessionId !== expected.sessionId) ||
        (expected.notSessionId !== undefined && sessionId === expected.notSessionId)
      if (idMismatch) {
        return { ok: false, changed: true, error: pick('会话状态与预期不一致，请重新打开这个会话', 'Session state does not match what was expected; reopen this session') }
      }
    }
    if (state?.success) this.setStateFrom(state.data as Record<string, unknown>)
    if (outsideExpected()) {
      return { ok: false, changed: true, error: pick('会话状态与预期不一致，请重新打开这个会话', 'Session state does not match what was expected; reopen this session') }
    }
    if (this.state?.sessionId && this.state.sessionId !== scopeBefore.sessionId) await this.reclaimSavedQueue().catch(() => undefined)
    const sessionFile = this.state?.sessionFile
    const hydrateSessionId = this.state?.sessionId
    const stillOwned = (): boolean => this.ownerCurrent(owner) && this.state?.sessionId === hydrateSessionId
    if (!stillOwned()) return superseded()

    const fromFile = sessionFile ? await this.readHistoryOf(sessionFile) : null
    if (!stillOwned()) return superseded()
    let presentationReady = false
    let nextMessages: UIMessage[] = this.messages
    let nextContext: { value: ContextFrom | undefined } | null = null
    if (!this.nativeBranchView && outsideExpected()) return superseded()
    if (supersededByLive()) return superseded()
    if (this.nativeBranchView) {
      const snapshot = await this.sessionEntries()
      if (outsideExpected() || !stillOwned()) return superseded()
      if (!snapshot.ok) throw new Error(snapshot.error ?? pick('无法读取当前原生分支', 'Cannot read the current native branch'))
      const path = nativeActiveBranch(snapshot.entries ?? [], snapshot.leafId ?? null)
      const messageEntries = path.flatMap(entry => {
        const message = entryMessage(entry)
        return message ? [{ id: entry.id, message }] : []
      })
      const compactionEntry = path.findLast(entry => entry.type === 'compaction')
      nextContext = { value: compactionEntry ? contextFromEntry(compactionEntry) : undefined }
      const previousSegments = fromFile?.messages.filter(message => message.id.startsWith('history:')) ?? []
      nextMessages = [...previousSegments, ...projectHistory(messageEntries.map(entry => entry.message),
        this.localizeHistoryImage,
        messageEntries.map(entry => typeof entry.id === 'string' ? entry.id : undefined))]
    } else if (fromFile?.messages.length) {
      nextMessages = fromFile.messages
      nextContext = { value: fromFile.contextFrom ?? contextFromRun(this.compactionState.last) }
      presentationReady = this.readHistory !== undefined
    } else {
      const msgs = await rpc.command('get_messages').catch(() => null)
      if (outsideExpected() || !stillOwned()) return superseded()
      const raw = (msgs?.data as { messages?: unknown[] } | undefined)?.messages
      nextMessages = Array.isArray(raw)
        ? projectHistory(raw, this.localizeHistoryImage)
        : []
    }
    if (sessionFile && !presentationReady) {
      const hydrated = await new ArtifactStore(this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts'))
        .hydrateMessages(sessionFile, nextMessages)
      if (outsideExpected() || !stillOwned() || supersededByLive()) return superseded()
      nextMessages = hydrated
    }

    const timingBucket = presentationReady ? undefined : timingKey(sessionFile)
    if (timingBucket) {
      const records = await readTurnTimings(YAN_DIR, timingBucket, this.liveTimingRunId()).catch(() => [])
      if (records.length) nextMessages = applyTurnTimings(nextMessages, records)
    }

    if (outsideExpected() || !stillOwned() || supersededByLive()) return superseded()
    if (nextContext) this.setContextFrom(nextContext.value)
    this.messages = nextMessages
    this.pushedOut.clear()
    this.pushedOutText.clear()
    this.pushedArgs.clear()

    this.pushSessionSync(scopeBefore, syncedBefore)
    this.pushQuestionLog()
    this.pushApprovalLog()
    const stats = await rpc.command('get_session_stats').catch(() => null)
    if (stats?.success && stillOwned()) {
      const counted = this.statsForCurrentModel(stats.data as SessionStats)
      const withOverhead = await this.withOverheadUsage(counted)
      if (stillOwned()) this.push({ ch: 'stats', payload: withOverhead })
    }

    if (!stillOwned()) return superseded()
    void this.refreshTodos()

    this.titleTried.clear()
    this.lastTitle = undefined
    void this.maybeGenerateTitle()
    return { ok: true }
  }

  private pushSessionSync(
    scopeBefore: { sessionId?: string; sessionFile?: string },
    syncedBefore: readonly UIMessage[]
  ): void {
    const next = this.messages
    const sameSession =
      this.state?.sessionId === scopeBefore.sessionId && this.state?.sessionFile === scopeBefore.sessionFile
    const plan = sameSession
      ? planSessionSync(syncedBefore, next)
      : planSessionSyncAgainst(takeSyncBaseline(this.state?.sessionFile), next)
    rememberSyncBaseline(this.state?.sessionFile, next)
    if (plan.kind === 'none') {
      if (!sameSession && next.length) {
        const anchor = next[next.length - 1]
        this.push({ ch: 'sync-delta', payload: { anchorId: anchor.id, anchorIndex: next.length - 1, anchorSignature: messageSyncSignature(anchor), messages: [] } })
      }
      return
    }
    if (plan.kind === 'full') {
      this.push({ ch: 'sync', payload: next })
      return
    }
    this.push({
      ch: 'sync-delta',
      payload: {
        anchorId: plan.anchorId,
        anchorIndex: plan.anchorIndex,
        anchorSignature: plan.anchorSignature,
        messages: plan.messages
      }
    })
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

  private async attachLiveEntryIds(): Promise<void> {
    const scope = { sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }
    const entries = await this.sessionEntriesLite().catch(() => null)
    if (!entries || this.agentRunning) return
    if (this.state?.sessionId !== scope.sessionId || this.state?.sessionFile !== scope.sessionFile) return
    const before = this.messages
    const next = withTrailingEntryIds(before, entries)
    if (!next) return
    this.messages = next
    this.pushSessionSync(scope, before)
  }

  async refreshTodos(): Promise<SessionTodo[]> {
    const current = this.sessionReadCurrent()
    const sessionId = this.state?.sessionId
    try {
      const entries = await this.sessionEntriesLite()
      if (!current() || !entries) return []
      const hostEntries = await this.taskPlanEntries(sessionId)
      if (!current()) return []
      const snaps = todoSnapshotsFromEntries([...entries, ...hostEntries])
      const latest = snaps.length ? snaps[snaps.length - 1].todos : []
      this.push({ ch: 'todos', payload: latest })
      this.push({ ch: 'todo-history', payload: snaps })
      return latest
    } catch {
      return []
    }
  }

  private async taskPlanEntries(sessionId = this.state?.sessionId): Promise<Record<string, unknown>[]> {
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
      return this.browserCommands.runBrowserCommand(command.slice('browser.'.length), params, signal)
    }
    if (command.startsWith('terminal.')) {
      return this.terminalCommands.run(command.slice('terminal.'.length), params, signal)
    }
    if (command === 'shell.background') {
      return this.backgroundBash.run(params, signal)
    }
    if (command.startsWith('phone.')) {
      return this.phoneCommands.run(command.slice('phone.'.length), params, signal)
    }
    if (command.startsWith('subagent.') || command.startsWith('workflow.')) {
      if (!this.subagentHost) {
        throw new CapabilityCommandError('subagent_unavailable', '子代理宿主入口当前不可用')
      }
      return this.subagentHost.run(command, params, {
        cwd: this.cwd,
        model: this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : undefined,
        parentSessionId: this.state?.sessionId || (this.capabilityOpts?.sessionId ? `pending:${this.capabilityOpts.sessionId}` : undefined),
        ...(this.state?.sessionFile ? { parentSessionFile: this.state.sessionFile } : {}),
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
      return runSkillRead(this.commandHost, params)
    }
    if (command === 'skill.save') {
      return runSkillSave(this.commandHost, params)
    }
    if (command.startsWith('mcp.app.')) {
      return this.runMcpAppCommand(command, params, signal)
    }
    if (command.startsWith('mcp.')) {
      return runMcpCommand(this.commandHost, command.slice('mcp.'.length), params, signal)
    }
    if (command.startsWith('search.')) {
      return this.lookup.runSearchCommand(command.slice('search.'.length), params, signal)
    }
    if (command === 'image.generate') return this.runImageCommand(params)
    if (command === 'artifact.attach') return this.runArtifactAttachCommand(params)
    if (command === 'artifact.preview') return runArtifactPreview(this.capabilityOpts?.previewHtml, params.path, this.cwd, params.at)
    if (command === 'artifact.exportVideo') return runArtifactExportVideoCommand(this.cwd, this.capabilityOpts?.exportVideo, params)
    if (command === 'artifact.exportImage') return runArtifactExportImageCommand(this.cwd, this.capabilityOpts?.exportImage, params)
    if (command === 'question.ask') return this.runQuestionCommand(params, signal)
    if (command === 'office.read') return runOfficeReadCommand(this.cwd, params)
    if (command === 'file.trash') return runFileTrashCommand(this.commandHost, params, signal)
    if (command === 'consent.request') return runConsentRequestCommand(this.commandHost, params)
    if (command === 'danger.confirm') return runDangerConfirmCommand(this.commandHost, params)
    if (command === 'danger.review') return runDangerReviewCommand(this.commandHost, params)
    if (command === 'danger.prefs') return { summary: { kind: 'danger-prefs', ...(await dangerGuardPrefs()) } }
    if (command === 'session.move') return runSessionMoveCommand(this.commandHost, params)
    switch (command) {
      case 'tasks.apply':
        return this.applyTaskPlan(params)
      default:
        return runPluginCommand(command, params, { cwd: this.cwd }, signal)
    }
  }

  latestAssistantMessageId(): string {
    if (this.streaming?.id) return this.streaming.id
    const messages = this.messages
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return `artifact-${Date.now().toString(36)}`
  }

  private pushApprovalLog(): void {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) return
    let entries
    try {
      entries = approvalLog.list(sessionId)
    } catch (error) {
      console.warn('[approval-log] 读取失败：', error instanceof Error ? error.message : error)
      return
    }
    this.push({ ch: 'approval-log', payload: { sessionId, entries } })
  }

  private pushQuestionLog(): void {
    const sessionId = this.state?.sessionId
    if (!isSafeSessionId(sessionId)) return
    this.push({ ch: 'question-log', payload: { sessionId, entries: questionLog.list(sessionId) } })
  }

  pushSessionLogs(): void {
    this.pushQuestionLog()
    this.pushApprovalLog()
  }

  private async runQuestionForm(
    question: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ data?: unknown; summary: Record<string, unknown>; secrets?: Record<string, string> }> {
    let fields: QuestionField[]
    try {
      fields = parseQuestionFields(params.fields)
    } catch (error) {
      if (error instanceof QuestionFormError) throw new CapabilityCommandError('question_form_invalid', error.message)
      throw error
    }
    const toolCallId = questionToolCallId(params)
    const asksSecret = fields.some((field) => field.kind === 'secret')
    if (asksSecret && !toolCallId) throw new CapabilityCommandError('question_secret_needs_tool', 'secret fields only work through the question tool')
    const response = await this.ui.requestHostUi({ method: 'input', message: question, form: fields, timeout: requestedTimeout(params.timeout), signal, ...(asksSecret ? { sensitive: true } : {}), ...(toolCallId ? { toolCallId } : {}) })
    const raw = typeof response.value === 'string' ? response.value : null
    const parsed = raw !== null ? parseQuestionAnswers(fields, raw) : null
    const separated = parsed && raw !== null ? separateSecrets(fields, parsed, raw) : null
    const answers = separated?.answers ?? null
    const secrets = separated && Object.keys(separated.secrets).length ? separated.secrets : undefined
    const freeText = !answers && !asksSecret && raw?.trim() ? raw.trim().slice(0, 4000) : null
    const answer = answers ? summarizeAnswers(fields, answers) : freeText
    const cancelled = response.cancelled === true || answer === null
    const entries = questionLog.append(this.state?.sessionId, { question, options: [], answer, cancelled, at: Date.now() })
    if (entries) this.pushQuestionLog()
    return {
      data: { question, fields, answers, answer, cancelled, autonomous: false },
      summary: { kind: 'question', action: 'ask', mode: 'standard', form: true, answered: answer !== null, cancelled },
      ...(secrets ? { secrets } : {})
    }
  }

  private async runQuestionCommand(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const question = typeof params.question === 'string' ? params.question.trim() : ''
    if (!question) throw new CapabilityCommandError('question_missing', 'question ask 需要 question')
    if (question.length > 4000) throw new CapabilityCommandError('question_too_long', '问题不能超过 4000 个字符')

    if (params.fields !== undefined) return this.runQuestionForm(question, params, signal)

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

    const timeout = requestedTimeout(params.timeout)
    const toolCallId = questionToolCallId(params)
    let response: HostUiResponse
    if (options.length === 0) {
      response = await this.ui.requestHostUi({
        method: 'input',
        message: question,
        timeout,
        signal,
        ...(toolCallId ? { toolCallId } : {})
      })
    } else {
      response = await this.ui.requestHostUi({
        method: 'select',
        message: question,
        options,
        timeout,
        signal,
        ...(toolCallId ? { toolCallId } : {})
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
      summary: { kind: 'question', action: 'ask', mode: 'standard', answered: answer !== null, cancelled }
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
    if (message.artifacts?.some((item) => item.id === artifact.id)) return
    message.artifacts = [...(message.artifacts ?? []), artifact]
    this.push({ ch: 'artifact', payload: { messageId, artifact } })
  }

  async saveInlineArtifact(input: { sessionId: string; messageId: string; filename: string; content: string; sourceId: string }): Promise<AssistantArtifact> {
    const sessionFile = this.state?.sessionFile
    if (!sessionFile || this.state?.sessionId !== input.sessionId) throw new Error('session_mismatch')
    const messageId = input.messageId.split('#')[0]
    if (!this.messages.some((item) => item.id === messageId)) throw new Error('message_not_found')
    const artifact = await new ArtifactStore(this.capabilityOpts?.artifactDir ?? join(YAN_DIR, 'artifacts')).save({
      sessionFile,
      messageId,
      filename: input.filename,
      bytes: Buffer.from(input.content, 'utf8'),
      sourceId: input.sourceId
    })
    await this.attachArtifact(artifact, messageId, sessionFile)
    return artifact
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

    publishProgress('queued', pick('已加入当前回合', 'Added to the current turn'))
    try {
      const availability = await waitForImage(detectImageProviders(), controller.signal)
      checkCancelled()
      const resolved = resolveImageProvider(request.provider, availability)
      provider = resolved === 'unavailable' ? undefined : resolved
      model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : defaultImageModel(resolved, availability)
      if (resolved !== 'unavailable' && resolved !== 'codex' && resolved !== 'mock' && imageProviderNeedsConfirmation(resolved, availability)) {
        publishProgress('confirming', pick('等待确认外部图像 API 请求', 'Waiting for approval of the external image API request'))
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

  getLegacyMcpHolderSnapshot(): { services: Array<{ serverId: string; status: McpServerStatus }> } {
    return this.mcp.holderSnapshot()
  }

  async capabilitySettingsSnapshot() {
    const commands = await this.rawCommands()
    const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
    const acquiredUser = await acquiredUserSkillNames(YAN_DIR)
    const managed = await listManagedSkills().catch(() => [] as ManagedSkillEntry[])
    const managedView = (location: string) => {
      const owner = managedSkillOf(location)
      if (!owner) return null
      const entry = managed.find((item) => samePath(item.location, location))
      return {
        origin: owner.scope === 'yan' ? 'user' as const : 'pi' as const,
        enabled: entry?.enabled ?? true,
        manage: { scope: owner.scope, dir: owner.dirName },
        ...(owner.scope === 'yan' && acquiredUser.has(owner.dirName) ? { acquired: true } : {})
      }
    }
    const loadedSkills = skillsFromCommands(commands).map(({ capability, location }) => {
      const owned = this.bundledSkills.some((path) => samePath(path, location)) ? null : managedView(location)
      return {
        id: capability.id,
        title: capability.title,
        description: capability.description,
        location,
        ...(owned ?? { origin: this.bundledSkills.some((path) => samePath(path, location)) ? 'bundled' as const : 'other' as const })
      }
    })
    const unloadedSkills = managed
      .filter((entry) => !loadedSkills.some((skill) => samePath(skill.location, entry.location)))
      .flatMap((entry) => {
        const owned = managedView(entry.location)
        return owned
          ? [{ id: `${owned.manage.scope}:${owned.manage.dir}`, title: entry.name, description: entry.description, location: entry.location, ...owned }]
          : []
      })
    const loaded = [...loadedSkills, ...unloadedSkills]
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
    const servers = await this.mcp.settingsServers()
    const probe = resolvePi({ override: this.piBin })
    const version = probe.home ? await readFile(join(probe.home, 'package.json'), 'utf8').then(text => JSON.parse(text).version as string).catch(() => undefined) : undefined
    return { skills, servers, nativeMcpAvailable: nativePiToolsSupported(version) && commands.some(command => command.name === 'mcp'), configWarning: Boolean(this.mcp.configError()) }
  }

  async sessionSkillAction(action: 'promote' | 'remove', name: string): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: pick('当前没有会话', 'No active session') }
    try {
      if (action === 'remove') return { ok: await removeSessionSkill(YAN_DIR, sessionId, name) }
      await promoteSessionSkill(YAN_DIR, sessionId, name, this.bundledSkills.map((path) => basename(dirname(path))))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async verifyCapabilityMcp(serverId: string) {
    return this.mcp.verify(serverId)
  }

  async disconnectCapabilityMcp(serverId: string): Promise<boolean> {
    return this.mcp.disconnect(serverId)
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
    const actualThinkingLevel = String(data.thinkingLevel ?? 'off')
    let deferred = this.deferredModelSwitch?.sessionId === String(data.sessionId ?? '') ? this.deferredModelSwitch : undefined
    if (deferred && (!deferred.model || modelKeyOf(deferred.model) === modelKeyOf(model)) &&
      (deferred.thinkingLevel === undefined || deferred.thinkingLevel === actualThinkingLevel)) {
      this.deferredModelSwitch = undefined
      deferred = undefined
    }
    if (deferred) {
      deferred.previousModel = model ?? undefined
      deferred.previousThinkingLevel = actualThinkingLevel
    }
    this.state = {
      sessionId: String(data.sessionId ?? ''),
      sessionFile: data.sessionFile ? String(data.sessionFile) : undefined,
      sessionName: data.sessionName ? String(data.sessionName) : undefined,
      model: deferred?.model ?? model ?? undefined,
      thinkingLevel: deferred?.thinkingLevel ?? actualThinkingLevel,
      ...(deferred
        ? { pendingModelChange: { previousModel: model ?? undefined, previousThinkingLevel: actualThinkingLevel } }
        : {}),
      ultracode: isUltracodeOn(String(data.sessionId ?? '')),
      availableThinkingLevels,
      thinkingLevelsStatus: levels.status,
      capabilities: capabilitySnapshot(model, availableThinkingLevels, levels.status),
      isStreaming: !!data.isStreaming,
      isAgentRunning: this.agentRunning,
      isCompacting: !!data.isCompacting,
      compaction: this.compactionState.running ?? undefined,
      lastCompaction: this.compactionState.last ?? undefined,
      ...(this.retryRun ? { retry: this.retryRun } : {}),
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
    if (previous && previous.sessionId === this.state.sessionId && modelKeyOf(previous.model) !== modelKeyOf(this.state.model)) void this.refreshStats()
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
    if (type.startsWith('message_') || type.startsWith('tool_execution_')) this.liveItemEdits += 1
    this.emitRunSignals(evt, type)

    switch (type) {
      case 'message_start': {
        const m = evt.message as PiMessage | undefined
        if (m?.role === 'user') {
          const norm = this.items.previewLive(m)
          if (norm) {
            if (isSubagentNotice(norm.text) && this.turn.messageIds.length > 0) {
              this.finishTimingSegmentForNotice()
            }
            const added = this.items.commitLive(norm, m)
            this.push({ ch: 'msg-add', payload: added })
            this.queue.consume(added.text, imagesOf(m.content) ?? [])
          }
          this.syncDeferredModelSwitch()
        } else if (m?.role === 'custom') {
          const added = this.items.liveMessageStart(m, Date.now())
          if (added) this.push({ ch: 'msg-add', payload: added })
        } else if (m?.role === 'assistant') {
          const started = this.items.liveMessageStart(m, Date.now())!
          const id = started.id
          const requestStartMono = this.pendingRequestMono
          this.pendingRequestMono = undefined
          this.streaming = {
            id,
            responseDetail: this.turn.responseDetail,
            startedAt: Date.now(),
            generationStartedMono: requestStartMono ?? performance.now(),
            ...(requestStartMono !== undefined ? { requestStartEvent: 'turn_start' as const } : {}),
            pushedText: 0,
            pushedThinking: 0
          }
          this.streamLoopDetector = createStreamLoopDetector()
          this.push({
            ch: 'msg-add',
            payload: { ...started, responseDetail: this.turn.responseDetail }
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
        if (u && (this.streaming.usage?.output !== u.output || this.streaming.usage?.input !== u.input)) this.streaming.usage = u

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
        if (this.streaming.firstOutputMono === undefined &&
          (kind === 'toolcall_start' || (kind === 'text_delta' && String(ev.delta ?? '').length > 0))) {
          this.streaming.firstOutputMono = performance.now()
        }

        const call = this.items.liveAssistantDelta(ev, Date.now())
        if (kind === 'thinking_start') {
          this.streaming.thinkingStartedAt = Date.now()
          this.streaming.thinkingLive = true
        } else if (kind === 'thinking_delta') {
          this.checkStreamLoop('thinking', String(ev.delta ?? ''))
          this.markDirty()
        } else if (kind === 'thinking_end') {
          const started = this.streaming.thinkingStartedAt
          if (started) this.streaming.thinkingMs = Date.now() - started
          this.streaming.thinkingLive = false
          this.markDirty()
        } else if (kind === 'text_delta') {
          this.checkStreamLoop('text', String(ev.delta ?? ''))
          this.markDirty()
        } else if (kind === 'toolcall_start') {
          this.streaming.toolOpen = true
          this.dirty = true
          this.flushNow()
          if (call) this.pushTool(call)
        } else if (kind === 'toolcall_delta') {
          if (call && streamsHtmlWriteArgs(call)) {
            const now = Date.now()
            if (now - (this.htmlArgsPushedAt.get(call.id) ?? 0) >= HTML_ARGS_PUSH_MS) {
              this.htmlArgsPushedAt.set(call.id, now)
              this.pushTool(call)
            }
          }
        } else if (kind === 'toolcall_end') {
          this.streaming.toolOpen = false
          this.flushNow()
          if (call) {
            this.htmlArgsPushedAt.delete(call.id)
            this.pushTool(call)
          }
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
        this.htmlArgsPushedAt.clear()

        const finalUsage = toUsage(m.usage, m.model ?? this.state?.model?.id) ?? s.usage
        if (typeof finalUsage?.output === 'number' && finalUsage.output > 0) {
          this.turn.outputTokens = (this.turn.outputTokens ?? 0) + finalUsage.output
        }
        const sp = this.speedOf({ ...s, usage: finalUsage }, Date.now(), this.turn.startedAt)
        const genTiming = this.generationTimingOf(s, endedMono)
        const msg = this.settleStreaming(id, {
          thinkingMs: s.thinkingMs,
          thinkingLive: false,
          usage: finalUsage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs,
          ...(genTiming ? { generationTiming: genTiming } : {}),
          responseDetail: s.responseDetail,
          model: assistantModelIdentity(m),
          timestamp: m.timestamp ?? Date.now(),
          error: assistantError(m)
        }, serverSearchCalls(m as { yanWebSearch?: unknown; timestamp?: number }, id))
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
        this.pendingTruncated = m.stopReason === 'length'
        if (m.stopReason !== 'aborted') this.quotaExhausted = m.stopReason === 'error' && isQuotaWaitError(modelErrorText(m.errorMessage))
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
              message: pick(`已按流式防护终止本次生成（${this.loopGuardHit?.rule ?? 'stream-loop'}）。会话可继续，本次任务尚未完成。`, `Generation stopped by stream guard (${this.loopGuardHit?.rule ?? 'stream-loop'}). The session can continue; this task is not finished.`)
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
        const started = this.items.liveToolStart({
          toolCallId: String(evt.toolCallId ?? ''),
          toolName: String(evt.toolName ?? 'tool'),
          args: evt.args,
          parentToolCallId: typeof evt.parentToolCallId === 'string' ? evt.parentToolCallId : undefined
        }, Date.now())
        if (started.created) this.push({ ch: 'msg-add', payload: started.created })
        const call = started.call
        if (isWriteTool(call.name)) {
          const path = writePathOf(call.args)
          if (path) snapshotBefore(call.id, path, isAbsolute(path) ? path : resolve(this.cwd, path))
        } else if (isShellTool(call.name)) {
          void beginTreeSnapshot(call.id, this.cwd, this.state?.sessionId)
        }
        this.pushTool(call)
        break
      }

      case 'tool_execution_update': {
        const call = this.items.liveToolUpdate(String(evt.toolCallId ?? ''), evt.partialResult as ToolResultPayload | undefined)
        if (!call) break
        this.markToolOutput(call.id)
        break
      }

      case 'tool_execution_end': {
        const call = this.items.liveToolEnd(String(evt.toolCallId ?? ''), {
          result: evt.result as ToolResultPayload | undefined,
          isError: evt.isError,
          cancelled: (evt as { cancelled?: boolean }).cancelled
        }, Date.now())
        if (!call) break
        if (isWriteTool(call.name)) {
          const diff = snapshotAfter(call.id)
          if (diff) mergeToolDetails(call, { fileDiff: diff })
        }
        this.pushTool(call)
        if (isShellTool(call.name)) this.attachWorkspaceChanges(call)
        break
      }

      case 'turn_start':
        this.pendingRequestMono = performance.now()
        break

      case 'agent_start':
        this.turn.responseDetail = this.currentResponseDetail()
        if (!this.timingContinues || this.turn.startedMono === undefined) this.startTimingSegment()
        else if (this.turn.terminal === 'failed') this.turn.terminal = 'completed'
        this.timingContinues = false
        this.pendingRequestMono = undefined
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled': {
        this.setRetryRun(null)
        this.cancelApprovals?.(this.approvalOwner())
        const continuation = this.loopGuardAbortSent && this.loopGuardAbortedMessage && this.rpc && this.state?.sessionId
          ? { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardResumeVersion }
          : null
        const modelError = this.pendingModelError
        const settledSessionId = this.state?.sessionId
        const outcome = settledTurnOutcome({ aborted: evt.aborted === true, terminal: this.turn.terminal, modelError: !!modelError || this.pendingTruncated })
        if (evt.aborted === true || this.turn.terminal === 'stopped') {
          for (const call of this.items.cancelUnfinishedTools(Date.now())) this.pushTool(call)
        }
        const errorContinuation = !continuation && modelError && !modelError.retried && isTransientModelError(modelError.text) &&
          this.rpc && this.state?.sessionId
          ? { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardContinuationVersion, reason: 'model-error' as const }
          : null
        const failedProvider = this.state?.model?.provider
        const authBlip = !continuation && !errorContinuation && modelError && !modelError.retried && failedProvider &&
          this.loopGuardAutoContinueCount < 1 && isAuthRejected(modelError.text) && this.rpc && this.state?.sessionId
          ? { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardContinuationVersion, reason: 'model-error' as const }
          : null
        const keyFailover = !continuation && !errorContinuation && modelError && failedProvider && apiKeyLooksUnusable(modelError.text) && this.rpc && this.state?.sessionId
          ? { provider: failedProvider, quota: isQuotaWaitError(modelError.text), scope: { rpc: this.rpc, sessionId: this.state.sessionId, generation: this.capabilityOpts?.runnerGeneration,
            runId: this.turn.runId, version: this.loopGuardContinuationVersion, reason: 'key-failover' as const } }
          : null
        this.pendingModelError = undefined
        this.pendingTruncated = false
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
        if (this.turn.terminal === 'stopped' && this.turn.startedMono !== undefined) {
          this.turn.elapsedMs = Math.max(this.turn.elapsedMs ?? 0, Math.max(1, Math.round(performance.now() - this.turn.startedMono)))
        }
        this.turn.startedAt = undefined
        this.turn.startedMono = undefined
        this.pendingRequestMono = undefined
        this.timingContinues = false
        const deferredHydrate = this.hydrateDeferred
        this.hydrateDeferred = null
        const persisted = this.persistTurnTiming()
        if (deferredHydrate) void persisted.catch(() => undefined).then(() => this.hydrate(deferredHydrate)).then((refreshed) => {
          if (refreshed.ok || refreshed.changed) return
          this.push({
            ch: 'notify',
            payload: {
              id: `hydrate-${Date.now()}`,
              method: 'notify',
              notifyType: 'warning',
              message: pick('回合结束后刷新会话失败，请切一次会话或重新打开', 'Failed to refresh the session after the turn. Switch sessions or reopen it')
            }
          })
        }).catch(() => undefined)
        this.syncDeferredModelSwitch()
        void this.refreshState()
        void this.refreshStats()
        void this.refreshTodos()
        void this.attachLiveEntryIds()
        void this.maybeGenerateTitle()
        const failover = keyFailover
          ? () => this.continueAfterKeyFailover(keyFailover.scope, keyFailover.provider)
            .then((ok) => ok || !keyFailover.quota ? ok : this.continueAfterQuota(keyFailover.scope, keyFailover.provider))
          : undefined
        const task = continuation ? this.continueAfterLoopGuard(continuation)
          : errorContinuation ? this.continueAfterModelError(errorContinuation)
            : authBlip && failedProvider ? this.continueAfterAuthBlip(authBlip, failedProvider).then((ok) => ok || !failover ? ok : failover())
              : failover ? failover() : undefined
        if (task) {
          this.loopGuardContinueTask = task
          void task.then((resumed) => {
            if (!resumed) this.push({ ch: 'turn-settled', payload: { sessionId: settledSessionId, outcome } })
          }).finally(() => {
            if (this.loopGuardContinueTask === task) this.loopGuardContinueTask = undefined
          }).catch(() => undefined)
        } else {
          this.push({ ch: 'turn-settled', payload: { sessionId: settledSessionId, outcome } })
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
          const terminal = this.turn.terminal
          if (terminal === 'stopped' && this.turn.startedMono !== undefined) {
            this.turn.elapsedMs = Math.max(this.turn.elapsedMs ?? 0, Math.max(1, Math.round(performance.now() - this.turn.startedMono)))
          }
          void this.persistTurnTiming()
          this.turn.terminal = terminal
        }
        this.syncDeferredModelSwitch()
        void this.refreshStats()
        break

      case 'queue_update':
        const update = {
          steering: Array.isArray(evt.steering) ? (evt.steering as string[]) : [],
          followUp: Array.isArray(evt.followUp) ? (evt.followUp as string[]) : [],
          sessionId: this.state?.sessionId,
          generation: this.capabilityOpts?.runnerGeneration
        }
        this.queue.applyUpdate(update)
        break

      case 'bash_execution_update': {
        if (!this.bash) break
        const evtId = String(evt.id ?? '')
        if (evtId && evtId !== this.bash.reqId) break

        this.bash.output += String(evt.delta ?? '')
        const call = this.items.call(this.bash.msgId)
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
        this.operations.settle('compact')
        if (evt.willRetry === true && this.turn.startedMono !== undefined) this.timingContinues = true
        this.setCompaction(this.compactionState, evt)
        this.markStreaming(false)
        if (this.state?.isCompacting) this.state = { ...this.state, isCompacting: false }
        if (evt.willRetry !== true) this.settleExecutionAdmission()
        void this.refreshState()
        void this.refreshStats()
        void this.hydrate({ sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }).then((refreshed) => {
          if (refreshed.ok || refreshed.changed) return
          console.warn('[agent] session refresh after compaction failed', refreshed.error)
          this.push({
            ch: 'notify',
            payload: {
              id: `hydrate-${Date.now()}`,
              method: 'notify',
              notifyType: 'warning',
              message: pick('压缩后刷新会话失败，请切一次会话或重新打开', 'Failed to refresh the session after compaction. Switch sessions or reopen it')
            }
          })
        }).catch((error) => {
          console.warn('[agent] session refresh after compaction failed', error)
          this.push({
            ch: 'notify',
            payload: {
              id: `hydrate-${Date.now()}`,
              method: 'notify',
              notifyType: 'warning',
              message: pick('压缩后刷新会话失败，请切一次会话或重新打开', 'Failed to refresh the session after compaction. Switch sessions or reopen it')
            }
          })
        })
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
        const what = this.compactionState.running ? pick('压缩', 'Compaction') : pick('分支摘要', 'Branch summary')
        const seconds = Math.max(1, Math.round(Number(evt.delayMs ?? 0) / 1000))
        const reason = modelErrorText(evt.errorMessage)
        this.push({
          ch: 'notify',
          payload: {
            id: `summary-retry-${Date.now()}`,
            method: 'notify',
            notifyType: 'warning',
            message: pick(`${what}失败${reason ? `（${reason}）` : ''}，${seconds} 秒后第 ${Number(evt.attempt ?? 1)}/${Number(evt.maxAttempts ?? 1)} 次重试…`, `${what} failed${reason ? ` (${reason})` : ''}; retry ${Number(evt.attempt ?? 1)}/${Number(evt.maxAttempts ?? 1)} in ${seconds}s…`)
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
              message: pick('已按流式防护停止本次生成，不再自动重试。', 'Generation stopped by stream guard; no further auto-retry.')
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
              message: pick(`模型额度已到限，已停止自动重试。${modelErrorNotice(retryError)}`, `Model quota reached; auto-retry stopped. ${modelErrorNotice(retryError)}`)
            }
          })
          void this.abortRetry()
          break
        }
        if (isRateLimitError(retryError)) this.push({ ch: 'quota-wait', payload: { ifWindowFull: true } } as unknown as MainPush)
        this.retrySeenThisRun = true
        if (this.pendingModelError) this.pendingModelError.retried = true
        this.setRetryRun({
          attempt: Number(evt.attempt ?? 1),
          maxAttempts: Number(evt.maxAttempts ?? evt.attempt ?? 1),
          delayMs: Math.max(0, Number(evt.delayMs ?? 0)),
          at: Date.now(),
          ...(retryError ? { error: retryError } : {})
        })
        break
      }

      case 'auto_retry_end':
        this.setRetryRun(null)
        if (evt.success === true) {
          this.retrySeenThisRun = false
          this.pendingModelError = undefined
        }
        if (evt.success === false) {
          const finalError = modelErrorText(evt.finalError)
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
            message: pick(`扩展出错：${String(evt.error ?? evt.message ?? '未知')}`, `Extension error: ${String(evt.error ?? evt.message ?? 'unknown')}`)
          }
        })
        break

      default:
        break
    }
  }

  private ownerOf(call: UIToolCall): string | undefined {
    return this.items.ownerOf(call.id) ?? this.streaming?.id
  }

  private settleStreaming(id: string, meta: Partial<UIMessage>, extraCalls: UIToolCall[] = []): UIMessage {
    return this.items.liveMessageEnd(meta, extraCalls) ?? this.items.appendMessage({ id, role: 'assistant', text: '', ...meta, ...(extraCalls.length ? { toolCalls: extraCalls } : {}) })
  }

  private pushTool(call: UIToolCall): void {
    const msgId = this.ownerOf(call)
    if (!msgId) return
    this.pushedOut.set(call.id, call.output?.length ?? 0)
    this.pushedOutText.set(call.id, call.output ?? '')
    this.dirtyTools.delete(call.id)
    this.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
  }

  private attachWorkspaceChanges(call: UIToolCall): void {
    const msgId = this.ownerOf(call)
    const rpc = this.rpc
    const generation = this.capabilityOpts?.runnerGeneration
    const sessionId = this.state?.sessionId
    const ownsCall = (): boolean =>
      !this.stopping && this.rpc === rpc && this.capabilityOpts?.runnerGeneration === generation && this.state?.sessionId === sessionId
    void endTreeSnapshot(call.id)
      .then((changes) => {
        if (!changes || (!changes.files.length && !changes.unknown)) return
        if (!ownsCall()) return
        mergeToolDetails(call, { workspaceChanges: changes })
        const owner = this.ownerOf(call) ?? msgId
        if (!owner) return
        this.pushedOut.set(call.id, call.output?.length ?? 0)
        this.pushedOutText.set(call.id, call.output ?? '')
        this.dirtyTools.delete(call.id)
        this.push({ ch: 'tool', payload: { msgId: owner, call: { ...call } } })
      })
      .catch(() => null)
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
      const call = this.items.call(id)
      if (!call) {
        this.pushedOut.delete(id)
        this.pushedOutText.delete(id)
        this.pushedArgs.delete(id)
        continue
      }
      const pushed = this.pushedOut.get(id) ?? 0
      const out = call.output ?? ''
      const previous = this.pushedOutText.get(id)
      const mode = toolOutputPushMode(previous, pushed, out)
      if (mode === 'skip') continue
      const msgId = this.ownerOf(call)
      if (!msgId) continue
      this.pushedOut.set(id, out.length)
      this.pushedOutText.set(id, out)
      const sameArgs = this.pushedArgs.has(id) && this.pushedArgs.get(id) === call.args
      this.pushedArgs.set(id, call.args)
      if (mode === 'replace') {
        this.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
        continue
      }
      const { args: _args, output: _output, ...rest } = call
      this.push({
        ch: 'tool',
        payload: {
          msgId,
          call: sameArgs ? (rest as UIToolCall) : { ...call, output: undefined },
          outputDelta: out.slice(pushed),
          ...(sameArgs ? { sameArgs: true } : {})
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
    const content = this.items.streamingContent()
    const text = content?.text ?? ''
    const thinking = content?.thinking ?? ''

    const textDelta = text.length > s.pushedText ? text.slice(s.pushedText) : ''
    const thinkingDelta =
      thinking.length > s.pushedThinking ? thinking.slice(s.pushedThinking) : ''
    const thinkingShrank = thinking.length < s.pushedThinking
    s.pushedText = text.length
    s.pushedThinking = thinking.length

    const sp = this.speedOf(s, Date.now(), this.turn.startedAt)
    const genTiming = this.generationTimingOf(s)
    this.push({
      ch: 'msg-update',
      payload: {
        id: s.id,
        patch: {
          ...(textDelta ? { textDelta } : null),
          ...(thinkingDelta ? { thinkingDelta } : null),
          ...(thinkingShrank ? { thinking } : null),
          thinkingMs: s.thinkingMs,
          thinkingStartedAt: s.thinkingStartedAt,
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
    s: { generationStartedMono?: number; firstContentMono?: number; firstOutputMono?: number; requestStartEvent?: 'turn_start' },
    endedMono = performance.now()
  ): GenerationTiming | undefined {
    if (s.generationStartedMono === undefined) return undefined
    const g = generationTiming({
      startedMono: s.generationStartedMono,
      endedMono,
      firstContentMono: s.firstContentMono,
      firstOutputMono: s.firstOutputMono,
      ...(s.requestStartEvent ? { startEvent: s.requestStartEvent } : {})
    })
    if (!g) return undefined
    if (g.startEvent === 'turn_start') return g
    return {
      durationMs: g.durationMs,
      ...(g.decodeMs !== undefined ? { decodeMs: g.decodeMs } : {}),
      ...(g.outputDecodeMs !== undefined ? { outputDecodeMs: g.outputDecodeMs } : {})
    }
  }

  private setAgentRunning(v: boolean): void {
    if (this.agentRunning === v) return
    this.agentRunning = v
    if (v) this.executionRunObserved = true
    if (!this.state) return
    this.state = { ...this.state, isAgentRunning: v }
    this.push({ ch: 'state', payload: this.state })
    if (!v && this.pendingAborts === 0 && this.state.isStreaming !== true && this.state.isCompacting !== true &&
      this.queue.isEmpty()) {
      this.releaseExecutionAdmission()
    }
  }

  private executionActive(): boolean {
    return this.pendingAborts > 0 || this.agentRunning || this.state?.isStreaming === true || this.state?.isCompacting === true || this.bash != null
  }

  private claimExecutionAdmission(): { ok: true } | { ok: false; error: string } {
    if (this.pendingAborts > 0) return { ok: false, error: pick('正在等待停止确认，请稍后执行', 'Waiting for stop confirmation. Try again shortly') }
    if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: pick('项目正在保存或回退代码，请稍后执行', 'The project is saving or reverting code. Try again shortly') }
    const port = this.capabilityOpts?.execution
    if (!port) return { ok: true }
    if (this.executionAdmissionToken !== undefined) return { ok: true }
    const claim = port.claim()
    if (!claim.ok) return claim
    this.executionAdmissionToken = claim.token
    this.executionRunObserved = false
    return { ok: true }
  }

  private confirmExecutionAdmission(): boolean {
    const port = this.capabilityOpts?.execution
    const token = this.executionAdmissionToken
    if (!port || token === undefined) return true
    return port.confirm(token)
  }

  private releaseExecutionAdmission(): void {
    if (this.pendingAborts > 0) return
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
    if (this.executionRunObserved && this.queue.isEmpty()) {
      this.releaseExecutionAdmission()
      return
    }
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

  private setCompaction(cur: CompactionState, raw: Record<string, unknown>): void {
    const attributed = attributeCompaction(this.compactionOrigin, raw)
    this.compactionOrigin = attributed.origin
    const next = reduceCompaction(cur, attributed.evt)
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
      await this.queue.run(async () => {
        if (!canStop()) return
        const original = this.queue.state
        const queuedImages = [...original.steering, ...original.followUp].some(item => item.images?.length)
        if (queuedImages) {
          record('queue-kept', { rule: hit.rule, stream, messageId, outcome: 'kept-with-images' })
        } else {
          const result = await rpc.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
          if (!result.success || !result.data || !Array.isArray(result.data.steering) || !Array.isArray(result.data.followUp)) {
            throw new Error(result.error || 'clear_queue 未返回可确认的队列快照')
          }
          const reclaimed = snapshotQueue({
            steering: this.queue.reconcile(result.data.steering, original.steering),
            followUp: this.queue.reconcile(result.data.followUp, original.followUp)
          })
          if (ownsRun()) {
            this.queue.reset(true)
            this.queue.clearSaved()
          }
          if (reclaimed.steering.length || reclaimed.followUp.length) {
            this.push({ ch: 'queue-reclaimed', payload: { ...reclaimed, sessionId } })
            record('queue-reclaimed', { rule: hit.rule, stream, messageId, outcome: 'reclaimed' })
          }
        }
        if (!canStop()) {
          record('stale-before-abort', { rule: hit.rule, stream, messageId, outcome: 'stale' })
          return
        }
        this.loopGuardAbortSent = true
        this.turn.terminal = 'interrupted'
        this.push({ ch: 'notify', payload: {
          id: `loop-guard-${Date.now()}`, method: 'notify', notifyType: 'warning',
          message: pick(`检测到模型输出重复（${hit.rule}），正在终止本次生成；会话可继续，本次任务尚未完成。`, `Repeated model output detected (${hit.rule}); stopping this generation. The session can continue; this task is not finished.`)
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
          message: pick(`检测到模型输出重复（${hit.rule}），但未能确认终止（${detail}）。请手动决定，不会自动续跑。`, `Repeated model output detected (${hit.rule}) but the stop was not confirmed (${detail}). Decide manually; it will not auto-continue.`)
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
      this.queue.isEmpty()
  }

  private async continueAfterLoopGuard(scope: {
    rpc: PiRpc; sessionId: string; generation?: number; runId?: string; version: number
  }): Promise<boolean> {
    try {
      await this.loopGuardStopTask
      if (!this.canContinueAfterLoopGuard(scope) || !(await this.readStreamLoopAutoContinue())) return false
      if (!this.canContinueAfterLoopGuard(scope)) return false
      if (this.loopGuardAutoContinueCount >= 1) {
        this.logStreamLoopGuard('auto-continue-limit', { sessionId: scope.sessionId, runId: scope.runId, outcome: 'not-resumed' })
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'warning',
          message: pick('自动继续后再次检测到循环，已停止；同一任务最多自动续一次，请手动决定。', 'A loop was detected again after auto-continue and it stopped. A task auto-continues once at most; decide manually.') } })
        return false
      }
      const prompt = continuationPrompt('loop')
      const result = await this.send(prompt, undefined, undefined, scope)
      if (!result.ok && this.loopGuardContinuationVersion === scope.version) {
        this.logStreamLoopGuard('auto-continue-failed', { sessionId: scope.sessionId, runId: scope.runId, detail: result.error, outcome: 'not-resumed' })
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: pick(`未能自动继续（${result.error ?? '发送失败'}），请手动决定。`, `Could not auto-continue (${result.error ?? 'send failed'}). Decide manually.`) } })
      }
      return result.ok
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logStreamLoopGuard('auto-continue-failed', { sessionId: scope.sessionId, runId: scope.runId, detail, outcome: 'not-resumed' })
      if (this.canContinueAfterLoopGuard(scope)) {
        this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: pick(`未能自动继续（${detail}），请手动决定。`, `Could not auto-continue (${detail}). Decide manually.`) } })
      }
      return false
    }
  }

  private async continueAfterKeyFailover(scope: AutoContinueScope, provider: string): Promise<boolean> {
    try {
      if ((await getSettings()).apiKeyFailover !== true) return false
      if (!this.canContinueAfterLoopGuard(scope) || !(await this.readStreamLoopAutoContinue()) || this.loopGuardAutoContinueCount >= 1) return false
      const moved = await failoverApiKey(provider)
      if (!moved || !this.canContinueAfterLoopGuard(scope)) return false
      this.quotaExhausted = false
      this.push({ ch: 'quota-wait', payload: { cancel: true } } as unknown as MainPush)
      this.push({ ch: 'notify', payload: { id: `key-failover-${Date.now()}`, method: 'notify', notifyType: 'info',
        message: moved.switched
          ? pick(`${moved.from ?? '当前 Key'} 不可用，已切到 ${moved.to} 继续`, `${moved.from ?? 'The current key'} is unusable; continuing with ${moved.to}`)
          : pick(`继续使用刚切换的 ${moved.to}`, `Continuing with ${moved.to}, switched just now`) } })
      const result = await this.send(continuationPrompt('key-failover'), undefined, undefined, scope)
      return result.ok
    } catch (error) {
      this.push({ ch: 'log', payload: { level: 'error', text: `[key-failover] ${error instanceof Error ? error.message : String(error)}` } })
      return false
    }
  }

  private async continueAfterQuota(scope: AutoContinueScope, provider: string): Promise<boolean> {
    if (!this.canContinueAfterLoopGuard(scope)) return false
    scope = { ...scope, reason: 'account-switch' }
    const account = this.loopGuardAutoContinueCount < 1 ? await this.switchSpareAccount?.(provider).catch(() => null) : null
    if (!account || !this.canContinueAfterLoopGuard(scope)) {
      if (this.canContinueAfterLoopGuard(scope)) this.push({ ch: 'quota-wait', payload: {} } as unknown as MainPush)
      return false
    }
    this.quotaExhausted = false
    this.push({ ch: 'quota-wait', payload: { cancel: true } } as unknown as MainPush)
    this.push({ ch: 'notify', payload: { id: `account-switch-${Date.now()}`, method: 'notify', notifyType: 'info',
      message: account.switched
        ? pick(`额度用完，已换到 ${account.label} 继续`, `Quota exhausted; continuing on ${account.label}`)
        : pick(`继续使用刚切换的 ${account.label}`, `Continuing with ${account.label}, switched just now`) } })
    try {
      const result = await this.send(continuationPrompt('account-switch'), undefined, undefined, scope)
      return result.ok
    } catch (error) {
      this.push({ ch: 'log', payload: { level: 'error', text: `[account-switch] ${error instanceof Error ? error.message : String(error)}` } })
      return false
    }
  }

  private async continueAfterAuthBlip(scope: AutoContinueScope, provider: string): Promise<boolean> {
    const entry = await readAuthEntry(provider).catch(() => undefined) as { type?: unknown } | undefined
    if (entry?.type !== 'oauth') return false
    await new Promise((done) => setTimeout(done, AUTH_BLIP_RETRY_MS))
    return this.continueAfterModelError(scope)
  }

  private async continueAfterModelError(scope: AutoContinueScope): Promise<boolean> {
    try {
      if (!this.canContinueAfterLoopGuard(scope) || !(await this.readStreamLoopAutoContinue())) return false
      if (!this.canContinueAfterLoopGuard(scope) || this.loopGuardAutoContinueCount >= 1) return false
      const prompt = continuationPrompt('model-error')
      const result = await this.send(prompt, undefined, undefined, scope)
      if (!result.ok && this.loopGuardContinuationVersion === scope.version) {
        this.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: pick(`未能自动继续（${result.error ?? '发送失败'}），请手动决定。`, `Could not auto-continue (${result.error ?? 'send failed'}). Decide manually.`) } })
      }
      return result.ok
    } catch (error) {
      if (this.canContinueAfterLoopGuard(scope)) {
        this.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
          message: pick(`未能自动继续（${error instanceof Error ? error.message : String(error)}），请手动决定。`, `Could not auto-continue (${error instanceof Error ? error.message : String(error)}). Decide manually.`) } })
      }
      return false
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

  async answerUiRemotely(
    id: Parameters<UiRequests['answerUiRemotely']>[0],
    answer: Parameters<UiRequests['answerUiRemotely']>[1]
  ): Promise<Awaited<ReturnType<UiRequests['answerUiRemotely']>>> {
    return await this.ui.answerUiRemotely(id, answer)
  }

  respondUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): void {
    void Promise.resolve(this.ui.respondUi(res, by)).catch(() => undefined)
  }

  async respondUiResult(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): Promise<UiAnswerResult> {
    return await this.ui.respondUi(res, by)
  }

  async reclaimSavedQueue(): Promise<void> {
    await this.queue.reclaimSaved()
  }

  private requireRpc(): PiRpc {
    return this.queue.requireRpc()
  }

  private async withOperation<T extends { ok: boolean; error?: string }>(
    op: SessionOperation,
    expectGeneration: number | undefined,
    task: () => Promise<T>
  ): Promise<T | { ok: false; error: string }> {
    if (!generationMatches(expectGeneration, this.capabilityOpts?.runnerGeneration)) return { ok: false, error: GENERATION_MISMATCH_ERROR }
    return this.operations.run<T | { ok: false; error: string }>(op, this.capabilityOpts?.runnerGeneration, task, (error) => ({ ok: false, error }))
  }

  async send(
    text: string,
    images?: { data: string; mimeType: string }[],
    mode?: 'steer' | 'followUp',
    autoContinue?: AutoContinueScope,
    expectGeneration?: number
  ): Promise<{ ok: boolean; error?: string }> {
    if (isRestoredReadonly()) return { ok: false, error: restoredReadonlyMessage() }
    return this.withOperation('send', expectGeneration, () => this.withExecutionAdmission(() => this.sendAdmitted(text, images, mode, autoContinue)))
  }

  private async withExecutionAdmission(task: () => Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean; error?: string }> {
    const admission = this.claimExecutionAdmission()
    if (!admission.ok) return { ok: false, error: admission.error }
    let started = false
    try {
      const result = await task()
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
    if (text.trimStart().startsWith('/__inkstone_native')) return { ok: false, error: pick('原生内部命令只能通过桌面操作面板调用', 'Native internal commands can only be run from the desktop action panel') }
    if (this.loopGuardStopping || this.loopGuardAbortSent) return { ok: false, error: pick('正在按流式防护终止本次生成，请稍候再发送', 'Stream guard is stopping generation. Try sending again shortly') }
    const payload: Record<string, unknown> = { message: text }
    if (images?.length) {
      payload.images = images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
    }

    return this.queue.run(async () => {
      if (autoContinue && ((autoContinue.reason !== 'account-switch' && !(await this.readStreamLoopAutoContinue())) || !this.canContinueAfterLoopGuard(autoContinue) || this.loopGuardAutoContinueCount >= 1)) {
        return { ok: false, error: pick('自动继续已取消或运行归属改变', 'Auto-continue was cancelled or the run owner changed') }
      }
      if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: pick('项目正在回退代码，请稍后发送', 'The project is reverting code. Try sending again shortly') }
      payload.streamingBehavior = mode ?? 'followUp'
      if (!autoContinue && this.deferredModelSwitch && !this.executionActive()) {
        const wanted = this.deferredModelSwitch
        const label = wanted.model ? `${wanted.model.provider}/${wanted.model.id}` : wanted.thinkingLevel ? pick(`思考档 ${wanted.thinkingLevel}`, `thinking level ${wanted.thinkingLevel}`) : ''
        const switched = await this.enqueueCapabilityChange(() => this.applyDeferredModelSwitch())
          .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
        if (!switched.ok) {
          const detail = switched.error ? `：${switched.error}` : ''
          return { ok: false, error: pick(`没能切换到 ${label}，消息未发送，草稿已保留${detail}`, `Could not switch to ${label}; message not sent, draft kept${switched.error ? `: ${switched.error}` : ''}`) }
        }
      }
      const rpc = this.rpc
      const sessionId = this.state?.sessionId
      const generation = this.capabilityOpts?.runnerGeneration
      if (!rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
      const titleOnSend = !autoContinue && !this.state?.sessionName && !this.messages.some((m) => m.role === 'user')
      if (autoContinue) {
        this.loopGuardAutoContinueCount += 1
        if (autoContinue.reason === 'model-error') {
          this.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'info',
            message: pick('模型请求因暂时性错误中断且未自动重试，正在同一会话自动继续（1/1）。', 'The model request was interrupted by a temporary error without auto-retry; continuing in the same session (1/1).') } })
        } else if (autoContinue.reason !== 'key-failover' && autoContinue.reason !== 'account-switch') {
          this.logStreamLoopGuard('auto-continue-requested', { sessionId: autoContinue.sessionId, runId: autoContinue.runId, count: 1, limit: 1, outcome: 'sending' })
          this.push({ ch: 'notify', payload: { id: `loop-continue-${Date.now()}`, method: 'notify', notifyType: 'info',
            message: pick('已安全中止循环，正在同一会话自动继续（1/1）；不会执行收回的排队草稿。', 'Loop aborted safely; continuing in the same session (1/1). Withdrawn queued drafts will not run.') } })
        }
      }
      await this.terminalNotices.flushHeld()
      const res = await this.queue.submit('prompt', text, images, mode === 'steer' ? 'steering' : 'followUp', payload)
      if (!res.success) return { ok: false, error: res.error }
      if (this.rpc !== rpc || this.state?.sessionId !== sessionId || this.capabilityOpts?.runnerGeneration !== generation) return { ok: false, error: pick('会话已切换，发送结果未应用到当前会话', 'Session changed; the send result was not applied to the current session') }
      if (titleOnSend) void this.maybeGenerateTitle({ prompt: { text, images } })
      await this.refreshState()
      return { ok: true }
    })
  }

  async steer(text: string, images?: QueueItem['images'], expectGeneration?: number): Promise<{ ok: boolean; error?: string }> {
    return this.withOperation('send', expectGeneration, () => this.withExecutionAdmission(() => this.steerAdmitted(text, images)))
  }

  private async steerAdmitted(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    this.loopGuardContinuationVersion += 1
    this.loopGuardAutoContinueCount = 0
    if (this.loopGuardStopping || this.loopGuardAbortSent) return { ok: false, error: pick('正在按流式防护终止本次生成，请稍候再插话', 'Stream guard is stopping generation. Try interjecting again shortly') }
    return this.queue.run(async () => {
      if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: pick('项目正在回退代码，请稍后插话', 'The project is reverting code. Try interjecting again shortly') }
      const rpc = this.rpc, sessionId = this.state?.sessionId, generation = this.capabilityOpts?.runnerGeneration
      if (!rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
      const res = await this.queue.submit('steer', text, images, 'steering', this.queue.payload({ text, images }))
      if (!res.success) return { ok: false, error: res.error }
      if (this.rpc !== rpc || this.state?.sessionId !== sessionId || this.capabilityOpts?.runnerGeneration !== generation) return { ok: false, error: pick('会话已切换，插话结果未应用到当前会话', 'Session changed; the interjection was not applied to the current session') }
      await this.refreshState()
      return { ok: true }
    })
  }

  async followUp(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    return this.withOperation('send', undefined, () => this.withExecutionAdmission(() => this.followUpAdmitted(text, images)))
  }

  private async followUpAdmitted(text: string, images?: QueueItem['images']): Promise<{ ok: boolean; error?: string }> {
    this.loopGuardContinuationVersion += 1
    this.loopGuardAutoContinueCount = 0
    if (this.loopGuardStopping || this.loopGuardAbortSent) return { ok: false, error: pick('正在按流式防护终止本次生成，请稍候再排队', 'Stream guard is stopping generation. Try queueing again shortly') }
    return this.queue.run(async () => {
      if (workspaceMutationInProgress(this.cwd)) return { ok: false, error: pick('项目正在回退代码，请稍后排队', 'The project is reverting code. Try queueing again shortly') }
      const rpc = this.rpc, sessionId = this.state?.sessionId, generation = this.capabilityOpts?.runnerGeneration
      if (!rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
      const res = await this.queue.submit('follow_up', text, images, 'followUp', this.queue.payload({ text, images }))
      if (!res.success) return { ok: false, error: res.error }
      if (this.rpc !== rpc || this.state?.sessionId !== sessionId || this.capabilityOpts?.runnerGeneration !== generation) return { ok: false, error: pick('会话已切换，排队结果未应用到当前会话', 'Session changed; the queued message was not applied to the current session') }
      await this.refreshState()
      return { ok: true }
    })
  }

  queueSnapshot(): QueueSnapshot {
    return this.queue.snapshot()
  }

  async restoreQueueSnapshot(snapshot: QueueSnapshot): Promise<{ ok: boolean; error?: string }> {
    return this.queue.restoreSnapshot(snapshot)
  }

  async steerQueued(queueId: string): Promise<{ ok: boolean; error?: string }> {
    return this.queue.editItem(queueId, true)
  }

  async removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; images?: QueueItem['images']; error?: string }> {
    return this.queue.editItem(queueId, false)
  }

  async rewriteQueue(next: QueueState): Promise<QueueRewriteResult> {
    return this.queue.rewrite(next)
  }

  async editQueue(op: QueueEditOp): Promise<QueueRewriteResult> {
    return this.queue.edit(op)
  }

  async abort(expectGeneration?: number): Promise<QueueSnapshot & { error?: string }> {
    if (!generationMatches(expectGeneration, this.capabilityOpts?.runnerGeneration)) return { steering: [], followUp: [], error: GENERATION_MISMATCH_ERROR }
    this.pendingAborts += 1
    try {
      return await this.abortCurrent()
    } finally {
      this.pendingAborts -= 1
      this.settleExecutionAdmission()
    }
  }

  private async abortCurrent(): Promise<QueueSnapshot & { error?: string }> {
    this.loopGuardContinuationVersion += 1
    if (this.loopGuardStopping || this.loopGuardAbortSent) {
      await this.loopGuardStopTask
      if (this.loopGuardAbortSent || !this.agentRunning) return { steering: [], followUp: [] }
    }
    this.cancelImages()
    this.cancelApprovals?.(this.approvalOwner())
    this.terminalTurnStop.abort()
    this.terminalTurnStop = new AbortController()
    this.turn.terminal = 'stopped'
    const stoppingActive = this.streaming !== null || this.agentRunning || this.turn.startedMono !== undefined
    const stoppedAt = Date.now()
    const stoppedElapsed = this.turn.startedMono !== undefined
      ? Math.max(1, Math.round(performance.now() - this.turn.startedMono))
      : this.turn.elapsedMs
    const stoppedAnchor = [...this.messages].reverse().find((m) => m.role === 'user' && /^m\d+$/.test(m.id))?.id
    const stoppedMessageId = this.streaming?.id ?? (stoppingActive ? this.turn.messageIds.at(-1) : undefined)
    const stoppedMeta = (id: string): Pick<UIMessage, 'turnTiming' | 'elapsedMs'> => stoppedElapsed === undefined
      ? {}
      : {
          elapsedMs: stoppedElapsed,
          turnTiming: { logicalTurnId: stoppedAnchor ?? id, startedAt: stoppedAt - stoppedElapsed, endedAt: stoppedAt, elapsedMs: stoppedElapsed, terminalReason: 'stopped' }
        }
    const rpc = this.rpc
    const generation = this.capabilityOpts?.runnerGeneration
    const sessionId = this.state?.sessionId
    const current = () => this.rpc === rpc && this.capabilityOpts?.runnerGeneration === generation && this.state?.sessionId === sessionId
    let cleared: QueueSnapshot = { steering: [], followUp: [] }
    try {
      cleared = await this.queue.clearForStop()
    } catch {
    }

    if (!current()) return { ...cleared, error: GENERATION_MISMATCH_ERROR }
    try {
      if (this.bash && rpc) {
        const result = await rpc.command('abort_bash')
        if (!current()) return { ...cleared, error: GENERATION_MISMATCH_ERROR }
        if (!result.success) return { ...cleared, error: result.error ?? pick('命令停止尚未确认', 'Command stop not confirmed yet') }
      }
      if (!this.loopGuardAbortSent && rpc) {
        const result = await rpc.command('abort')
        if (!current()) return { ...cleared, error: GENERATION_MISMATCH_ERROR }
        if (!result.success) return { ...cleared, error: result.error ?? pick('会话停止尚未确认', 'Session stop not confirmed yet') }
      }
    } catch (error) {
      return { ...cleared, error: error instanceof Error ? error.message : String(error) }
    }

    const stoppedTime = Date.now()
    for (const call of this.items.cancelUnfinishedTools(stoppedTime)) this.pushTool(call)
    const settledId = this.streaming ? null : stoppedMessageId ?? (this.agentRunning ? this.turn.messageIds.at(-1) : undefined)
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
      const msg = this.settleStreaming(s.id, {
        thinkingLive: false,
        model: this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : undefined,
        timestamp: stoppedAt,
        ...stoppedMeta(s.id)
      })
      for (const c of msg.toolCalls ?? []) {
        this.pushedOut.set(c.id, c.output?.length ?? 0)
        this.pushedOutText.delete(c.id)
        this.pushedArgs.delete(c.id)
        this.dirtyTools.delete(c.id)
      }
      this.push({ ch: 'msg-update', payload: { id: s.id, patch: msg } })
    }

    if (this.bash) {
      const b = this.bash
      this.bash = null
      void endTreeSnapshot(b.msgId).catch(() => null)
      const endedAt = Date.now()
      this.items.settleBash(b.msgId, { bash: { command: b.command, exitCode: null, cancelled: true } }, { status: 'error', output: b.output, endedAt })
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
                endedAt
              }
            ]
          }
        }
      })
    }

    this.markStreaming(false)
    this.setAgentRunning(false)
    void this.refreshState()

    return cleared
  }

  async runBash(command: string, options?: { excludeFromContext?: boolean }): Promise<{ ok: boolean; error?: string }> {
    return this.withExecutionAdmission(() => this.runBashAdmitted(command, options))
  }

  private async runBashAdmitted(command: string, options?: { excludeFromContext?: boolean }): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const cmd = command.trim()
    if (!cmd) return { ok: false, error: pick('命令为空', 'Command is empty') }
    if (this.bash) return { ok: false, error: pick('已有一条命令在跑', 'A command is already running') }

    const reqId = `yan-bash-${randomUUID()}`
    const msgId = `bash-${reqId}`
    this.bash = { reqId, msgId, command: cmd, output: '' }
    const snapshotReady = beginTreeSnapshot(msgId, this.cwd, this.state?.sessionId)

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
    this.items.appendMessage(msg)
    this.push({ ch: 'msg-add', payload: msg })

    try {
      await snapshotReady
      if (this.bash?.reqId !== reqId) {
        await endTreeSnapshot(msgId)
        return { ok: false, error: pick('bash 请求已被停止或会话已切换', 'The bash request was stopped or the session changed') }
      }
      const payload: Record<string, unknown> = { command: cmd }
      if (options?.excludeFromContext !== undefined) payload.excludeFromContext = options.excludeFromContext
      const res = await this.requireRpc().command<{
        output?: string
        exitCode?: number
        cancelled?: boolean
        truncated?: boolean
        fullOutputPath?: string
      }>('bash', payload, { id: reqId, timeoutMs: BASH_REQUEST_TIMEOUT_MS })

      const b = this.bash?.reqId === reqId ? this.bash : undefined
      if (b) this.bash = null
      if (!b) {
        await endTreeSnapshot(msgId)
        return { ok: false, error: pick('bash 请求已被停止或会话已切换', 'The bash request was stopped or the session changed') }
      }

      if (!res.success) {
        await this.finishBash(msgId, cmd, b?.output ?? '', null, true, res.error)
        return { ok: false, error: res.error }
      }

      const d = res.data ?? {}
      const output = d.output && d.output.length > (b?.output.length ?? 0) ? d.output : (b?.output ?? '')
      await this.finishBash(msgId, cmd, output, d.exitCode ?? null, !!d.cancelled, undefined, d.truncated, d.fullOutputPath)
      return { ok: true }
    } catch (e) {
      const b = this.bash?.reqId === reqId ? this.bash : undefined
      if (b) this.bash = null
      const err = e instanceof Error ? e.message : String(e)
      if (!b) {
        await endTreeSnapshot(msgId)
        return { ok: false, error: pick('bash 请求已被停止或会话已切换', 'The bash request was stopped or the session changed') }
      }
      await this.finishBash(msgId, cmd, b.output, null, true, err)
      return { ok: false, error: err }
    }
  }

  private async finishBash(
    msgId: string,
    command: string,
    output: string,
    exitCode: number | null,
    cancelled: boolean,
    error?: string,
    truncated?: boolean,
    fullOutputPath?: string
  ): Promise<void> {
    const failed = cancelled || exitCode === null || exitCode !== 0
    const changes = await endTreeSnapshot(msgId)
    const details: Record<string, unknown> = {}
    if (truncated) {
      details.truncated = truncated
      details.fullOutputPath = fullOutputPath
    }
    if (changes && (changes.files.length > 0 || changes.unknown)) details.workspaceChanges = changes
    this.pushedOut.set(msgId, output.length)
    this.dirtyTools.delete(msgId)
    const endedAt = Date.now()
    const detailsPatch = Object.keys(details).length ? details : undefined
    this.items.settleBash(msgId, { text: command, bash: { command, exitCode, cancelled }, error }, { status: failed ? 'error' : 'ok', output, details: detailsPatch, endedAt })
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
              details: detailsPatch,
              endedAt
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

  private resetSessionScope(): void {
    this.clearPendingModelChange()
    this.loopGuardContinuationVersion += 1
    this.loopGuardAutoContinueCount = 0
    if (this.bash) void endTreeSnapshot(this.bash.msgId).catch(() => null)
    this.bash = null
    this.streaming = null
    this.items.discardStreaming()
    this.markStreaming(false)
    this.setAgentRunning(false)
    this.queue.reset()
    this.compactionState = EMPTY_COMPACTION_STATE
    this.contextFrom = undefined
    this.nativeBranchView = false
  }

  private recordExtUi(msg: ExtUiPush): void {
    if (extUiCleared(msg)) this.extUi.delete(extUiKey(msg))
    else this.extUi.set(extUiKey(msg), msg)
  }

  private setRetryRun(next: RetryRun | null): void {
    if (!next && !this.retryRun) return
    this.retryRun = next
    if (!this.state) return
    const { retry: _previous, ...rest } = this.state
    this.state = next ? { ...rest, retry: next } : rest
    this.push({ ch: 'state', payload: this.state })
  }

  private async changeSessionScope<T>(run: (changed: () => void) => Promise<T>): Promise<T> {
    this.scopeDepth += 1
    if (this.scopeDepth === 1) {
      this.scopeChanged = false
      this.suppressPush = true
      this.extUiPending = new Map()
    }
    try {
      return await run(() => {
        this.scopeChanged = true
        this.retryRun = null
      })
    } finally {
      this.scopeDepth -= 1
      if (this.scopeDepth === 0) {
        const pending = this.extUiPending ?? new Map<string, ExtUiPush>()
        this.extUiPending = null
        this.suppressPush = false
        if (this.scopeChanged) {
          const previous = [...this.extUi.entries()]
          this.extUi.clear()
          for (const [key, msg] of previous) if (!pending.has(key)) this.push(extUiRemoval(msg))
        }
        this.scopeChanged = false
        for (const msg of pending.values()) this.push(msg)
        for (const emit of this.afterScope.splice(0)) {
          try {
            emit()
          } catch (error) {
            console.warn('[agent] push after session switch failed', error)
          }
        }
      }
    }
  }

  async newSession(parentSession?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const payload: Record<string, unknown> = typeof parentSession === 'string' && parentSession ? { parentSession } : {}
    return this.changeSessionScope(async (changed) => {
      const previous = { sessionId: this.state?.sessionId, sessionFile: this.state?.sessionFile }
      try {
        const res = await this.requireRpc().command('new_session', payload)
        if (!res.success) return { ok: false, error: res.error }
        if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
          return { ok: false, error: pick('会话切换被扩展取消', 'Session switch was cancelled by an extension') }
        }
        changed()
        this.ui.cancelPending()
        this.resetSessionScope()
        const hydrated = await this.hydrate({
          ...(previous.sessionId ? { notSessionId: previous.sessionId } : {}),
          ...(previous.sessionFile ? { notSessionFile: previous.sessionFile } : {})
        })
        return hydrated.ok ? { ok: true } : { ok: false, error: hydrated.error ?? sessionSwitchUnconfirmed() }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    return this.changeSessionScope(async (changed) => {
      const res = await this.requireRpc().command('switch_session', { sessionPath: path })
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: pick('会话切换被扩展取消', 'Session switch was cancelled by an extension') }
      }
      changed()
      this.ui.cancelPending()
      this.resetSessionScope()
      const hydrated = await this.hydrate({ sessionFile: path })
      if (hydrated.ok) return { ok: true }
      const current = this.state?.sessionFile
      if (current && await sameSessionFileIdentity(current, path)) {
        const retried = await this.hydrate({ sessionFile: current })
        if (retried.ok) return { ok: true }
        return { ok: false, error: retried.error ?? sessionSwitchUnconfirmed() }
      }
      return { ok: false, error: hydrated.error ?? sessionSwitchUnconfirmed() }
    })
  }

  async renameSession(name: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
    if (sessionId && this.state?.sessionId !== sessionId) return { ok: false, error: pick('要改名的会话已不是当前会话，请重新打开后再试', 'The session to rename is no longer current. Reopen it and try again') }
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, error: pick('名字不能为空（pi 不支持清除会话名）', 'Name cannot be empty (pi cannot clear a session name)') }
    }
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const res = await this.rpc.command('set_session_name', { name: trimmed })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async regenerateTitle(): Promise<{ ok: boolean; title?: string; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: pick('当前还没有可重生成标题的会话', 'No session to regenerate a title for') }
    if (this.titleTried.has(sessionId)) return { ok: false, error: pick('标题正在生成，请稍候', 'Title is being generated. Wait a moment') }
    this.titleTried.add(sessionId)
    try {
      const manual = await manualTitleOf(sessionId)
      const title = await this.maybeGenerateTitle({ force: true, candidate: !!manual, lockHeld: true, sessionId })
      return title ? { ok: true, title } : { ok: false, error: pick('标题生成失败，已保留原标题', 'Title generation failed; kept the original title') }
    } finally {
      this.titleTried.delete(sessionId)
    }
  }

  async fork(entryId: string): Promise<{ ok: boolean; error?: string; text?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    return this.withOperation('fork', undefined, () => this.changeSessionScope(async (changed) => {
      const res = await this.requireRpc().command<{ text?: string; cancelled?: boolean }>('fork', { entryId })
      if (!res.success) return { ok: false, error: res.error }
      if (res.data?.cancelled) return { ok: false, error: pick('分叉被扩展取消', 'Fork was cancelled by an extension') }
      changed()
      this.resetSessionScope()
      this.ui.cancelPending()
      await this.hydrate()
      return { ok: true, text: res.data?.text }
    }))
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    return this.withOperation('fork', undefined, () => this.changeSessionScope(async (changed) => {
      const res = await this.requireRpc().command<{ cancelled?: boolean }>('clone')
      if (!res.success) return { ok: false, error: res.error }
      if (res.data?.cancelled) return { ok: false, error: pick('复制被扩展取消', 'Copy was cancelled by an extension') }
      changed()
      this.resetSessionScope()
      this.ui.cancelPending()
      await this.hydrate()
      return { ok: true }
    }))
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
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
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
    tree?: NativeTreeFlatNode[]
    leafId?: string | null
    error?: string
  }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    try {
      const res = await this.requireRpc().command<{
        tree?: Record<string, unknown>[]
        leafId?: string | null
      }>('get_tree')
      if (!res.success) return { ok: false, error: res.error }
      return { ok: true, tree: flattenNativeTree(res.data?.tree ?? []), leafId: res.data?.leafId ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async exportHtml(outputPath?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
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
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const trimmed = typeof customInstructions === 'string' ? customInstructions.trim() : ''
    const payload: Record<string, unknown> = trimmed ? { customInstructions: trimmed } : {}
    const admission = this.operations.acquire('compact', this.capabilityOpts?.runnerGeneration)
    if (!admission.ok) return { ok: false, error: admission.error }
    const execution = this.claimExecutionAdmission()
    if (!execution.ok) {
      this.operations.release(admission.lease)
      return execution
    }
    let res: Awaited<ReturnType<PiRpc['command']>>
    this.compactionOrigin = { ...this.compactionOrigin, manualRequests: this.compactionOrigin.manualRequests + 1 }
    try {
      res = await this.requireRpc().command('compact', payload, { timeoutMs: COMPACT_REQUEST_TIMEOUT_MS })
    } catch (err) {
      if (this.rpc?.running) this.operations.markUnknown(admission.lease)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.compactionOrigin = { ...this.compactionOrigin, manualRequests: Math.max(0, this.compactionOrigin.manualRequests - 1) }
      this.operations.release(admission.lease)
      this.settleExecutionAdmission()
    }
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async confirmNativeOperation(prompt: { title: string; message: string; acceptLabel: string }): Promise<boolean> {
    const response = await this.ui.requestHostUi({
      method: 'select', purpose: 'approval', sensitive: true, title: prompt.title, message: prompt.message,
      options: [prompt.acceptLabel, pick('取消', 'Cancel')], timeout: 180_000
    })
    return !response.cancelled && response.value === prompt.acceptLabel
  }

  async nativeNavigate(entryId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    if (this.hasRunningBash() || this.agentRunning || this.state?.isCompacting || this.state?.pendingMessageCount || this.ui.pending.size) throw new Error(pick('当前会话尚未空闲', 'The session is not idle yet'))
    const admission = this.operations.acquire('rewind', this.capabilityOpts?.runnerGeneration)
    if (!admission.ok) throw new Error(admission.error)
    try {
      const result = await this.nativeRuntime.navigateTree(entryId, options)
      if (!result.cancelled) {
        this.nativeBranchView = true
        this.queue.reset()
        this.ui.cancelPending()
        await this.hydrate()
      }
      return result
    } finally {
      this.operations.release(admission.lease)
    }
  }

  async nativeSetLabel(entryId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    if (this.hasRunningBash() || this.agentRunning || this.state?.isCompacting || this.state?.pendingMessageCount || this.ui.pending.size) throw new Error(pick('当前会话尚未空闲', 'The session is not idle yet'))
    await this.nativeRuntime.setLabel(entryId, label)
    return { ok: true }
  }

  async nativeReload(): Promise<void> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    if (this.hasRunningBash() || this.agentRunning || this.state?.isCompacting || this.state?.pendingMessageCount || this.ui.pending.size) throw new Error(pick('当前会话尚未空闲', 'The session is not idle yet'))
    const admission = this.operations.acquire('reload', this.capabilityOpts?.runnerGeneration)
    if (!admission.ok) throw new Error(admission.error)
    const rpc = this.rpc
    const identity = this.state?.sessionId
    try {
      const capture = await captureNativeStartupWitness({
        agentDir: PI_AGENT_DIR, cwd: this.cwd, bootId: newBootId(),
        generation: this.capabilityOpts?.runnerGeneration ?? 1,
        projectId: this.capabilityOpts?.projectId ?? null,
        ...(this.nativeConfigReader ? { readNativeConfig: this.nativeConfigReader } : {})
      })
      if (this.rpc !== rpc || this.stopping || this.state?.sessionId !== identity) throw new Error(pick('会话已切换，重新加载已取消', 'Session changed; reload cancelled'))
      this.nativeWitness = null
      await this.nativeRuntime.reload()
      if (this.rpc !== rpc || this.stopping || this.state?.sessionId !== identity) throw new Error(pick('会话已切换，请检查当前工具状态', 'Session changed; check the current tool state'))
      if (capture.ok && capture.witness) {
        const confirmed = await verifyNativeStartupWitness(capture.witness, {
          ...(this.nativeConfigReader ? { readNativeConfig: this.nativeConfigReader } : {})
        })
        if (this.rpc === rpc && !this.stopping && confirmed.ok) this.nativeWitness = capture.witness
      }
      await this.refreshState()
      await this.refreshStats()
    } finally {
      this.operations.release(admission.lease)
    }
  }

  async nativeScopedModels(): Promise<ScopedModelsSnapshot> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    return this.nativeRuntime.getScopedModels()
  }

  async nativeSetScopedModels(modelIds: string[]): Promise<void> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    await this.nativeRuntime.saveScopedModels(modelIds)
  }

  async nativeProjectTrust(): Promise<ProjectTrustSnapshot> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    return this.nativeRuntime.getProjectTrust()
  }

  async nativeSetProjectTrust(trusted: boolean): Promise<void> {
    if (!this.nativeRuntime) throw new Error(pick('pi 原生桥尚未就绪', 'The pi native bridge is not ready'))
    const result = trusted ? await allowTrust(this.cwd) : await revokeTrust(this.cwd)
    if (!result.ok) throw new Error(result.error ?? pick('项目信任保存失败', 'Failed to save project trust'))
  }

  private enqueueCapabilityChange<T>(work: () => Promise<T>): Promise<T | { ok: false; error: string }> {
    const rpc = this.rpc, sessionId = this.state?.sessionId, generation = this.capabilityOpts?.runnerGeneration
    const guarded = async (): Promise<T | { ok: false; error: string }> => rpc === this.rpc && sessionId === this.state?.sessionId && generation === this.capabilityOpts?.runnerGeneration
      ? work()
      : { ok: false as const, error: pick('会话已切换，设置已取消', 'Session changed; settings change cancelled') }
    const next = this.capabilityChangeTail.then(guarded, guarded)
    this.capabilityChangeTail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async applyModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    let res: Awaited<ReturnType<PiRpc['command']>>
    try {
      res = await this.rpc.command('set_model', { provider, modelId })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!res.success) return { ok: false, error: res.error }
    await this.refreshStateWithThinkingLevels()
    await this.refreshStats()
    return { ok: true }
  }

  private async refreshStateWithThinkingLevels(): Promise<void> {
    const rpc = this.rpc
    if (!rpc) return
    const owner = this.asyncOwner()
    const sessionId = this.state?.sessionId
    const current = (): boolean => this.ownerCurrent(owner) && (sessionId === undefined || this.state?.sessionId === sessionId)
    try {
      const before = await rpc.command('get_state')
      if (!current()) return
      const levels = await rpc.command<{ levels?: string[] }>('get_available_thinking_levels')
      if (!current()) return
      const state = await rpc.command('get_state')
      if (!current() || !state.success) return
      const data = { ...(state.data as Record<string, unknown>) }
      const sameModel = before.success && stateModelKey(before.data) === stateModelKey(state.data)
      if (levels.success && sameModel && !Object.prototype.hasOwnProperty.call(data, 'availableThinkingLevels')) {
        data.availableThinkingLevels = levels.data?.levels
      }
      this.setStateFrom(data)
    } catch {
    }
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
    return this.enqueueCapabilityChange(async () => {
      if (this.shouldDeferModelSwitch()) return this.deferModelSwitch({ provider, modelId })
      return this.applyModel(provider, modelId)
    })
  }

  private shouldDeferModelSwitch(): boolean {
    return this.executionActive() || (!!this.deferredModelSwitch && this.deferredModelSwitch.sessionId === this.state?.sessionId)
  }

  private async deferModelSwitch(change: { provider?: string; modelId?: string; thinkingLevel?: string }): Promise<{ ok: boolean; error?: string }> {
    const state = this.state
    if (!this.rpc || !state?.sessionId) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const sessionId = state.sessionId
    const current = this.deferredModelSwitch?.sessionId === sessionId ? this.deferredModelSwitch : undefined
    const previousModel = current ? current.previousModel : state.model
    const previousThinkingLevel = current ? current.previousThinkingLevel : state.thinkingLevel
    let model = current?.model
    if (change.provider && change.modelId) {
      const found = (await this.listModels()).find((item) => item.provider === change.provider && item.id === change.modelId)
      if (!found) return { ok: false, error: pick(`模型不可用：${change.provider}/${change.modelId}`, `Model unavailable: ${change.provider}/${change.modelId}`) }
      model = modelKeyOf(found) === modelKeyOf(previousModel) ? undefined : this.withAssumedWindow(found) ?? found
    }
    const requestedLevel = change.thinkingLevel ?? current?.thinkingLevel
    const thinkingLevel = requestedLevel === previousThinkingLevel ? undefined : requestedLevel
    if (this.state?.sessionId !== sessionId) return { ok: false, error: pick('会话已切换，设置已取消', 'Session changed; settings change cancelled') }
    const pending = !!model || thinkingLevel !== undefined
    this.deferredModelSwitch = pending ? { sessionId, model, thinkingLevel, previousModel, previousThinkingLevel } : undefined
    writePendingModelSwitch(sessionId, pending
      ? { ...(model ? { provider: model.provider, id: model.id } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }
      : null)
    const { pendingModelChange: _, ...rest } = this.state
    this.state = {
      ...rest,
      model: model ?? previousModel,
      thinkingLevel: thinkingLevel ?? previousThinkingLevel,
      ...(pending ? { pendingModelChange: { previousModel, previousThinkingLevel } } : {})
    }
    this.push({ ch: 'state', payload: this.state })
    return { ok: true }
  }

  private async applyDeferredModelSwitch(): Promise<{ ok: boolean; error?: string }> {
    const deferred = this.deferredModelSwitch
    const rpc = this.rpc
    if (!deferred || !rpc || deferred.sessionId !== this.state?.sessionId) return { ok: true }
    this.deferredModelSwitch = undefined
    const target = takePendingModelSwitch(deferred.sessionId)
    let error: string | undefined
    if (target?.provider && target.id) {
      const res = await rpc.command('set_model', { provider: target.provider, modelId: target.id })
      if (!res.success) error = res.error
    }
    if (target?.thinkingLevel) {
      const res = await rpc.command('set_thinking_level', { level: target.thinkingLevel })
      if (!res.success) error ??= res.error
    }
    await this.refreshStateWithThinkingLevels()
    void this.refreshStats()
    return error ? { ok: false, error } : { ok: true }
  }

  private syncDeferredModelSwitch(): void {
    const deferred = this.deferredModelSwitch
    if (!deferred || deferred.sessionId !== this.state?.sessionId) return
    if (readPendingModelSwitch(deferred.sessionId)) return
    this.deferredModelSwitch = undefined
    void this.refreshStateWithThinkingLevels().then(() => {
      const state = this.state
      if (deferred.model && state?.sessionId === deferred.sessionId && modelKeyOf(state.model) !== modelKeyOf(deferred.model)) {
        const label = `${deferred.model.provider}/${deferred.model.id}`
        this.push({ ch: 'notify', payload: { id: `model-switch-unapplied-${Date.now()}`, method: 'notify', notifyType: 'warning', message: pick(`没能切换到 ${label}，仍在使用原来的模型。`, `Could not switch to ${label}; still using the previous model.`) } })
      }
      return this.refreshStats()
    })
  }

  private clearPendingModelChange(): void {
    const deferred = this.deferredModelSwitch
    this.deferredModelSwitch = undefined
    if (deferred) writePendingModelSwitch(deferred.sessionId, null)
    if (!this.state?.pendingModelChange) return
    const { pendingModelChange: _, ...current } = this.state
    this.state = current
    this.push({ ch: 'state', payload: this.state })
  }

  async setThinking(level: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueCapabilityChange(async () => {
      if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
      if (this.shouldDeferModelSwitch()) return this.deferModelSwitch({ thinkingLevel: level })
      const res = await this.rpc.command('set_thinking_level', { level })
      if (res.success) await this.refreshState()
      return res.success ? { ok: true } : { ok: false, error: res.error }
    })
  }

  async setUltracode(on: boolean): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    try {
      setUltracodeOn(sessionId, on)
    } catch (error) {
      return { ok: false, error: String(error) }
    }
    if (this.state?.sessionId === sessionId) {
      this.state = { ...this.state, ultracode: on }
      this.push({ ch: 'state', payload: this.state })
    }
    return { ok: true }
  }

  async listThinkingLevels(): Promise<string[]> {
    if (!this.rpc) return []
    const rpc = this.rpc
    const res = await rpc.command<{ levels?: string[] }>('get_available_thinking_levels')
    const owner = await rpc.command('get_state').catch(() => undefined)
    const normalized = normalizeThinkingLevels(res.data?.levels, res.success)
    const levels = normalized.values
    const ownerKey = owner?.success ? stateModelKey(owner.data) : undefined
    if (this.state && ownerKey && ownerKey === modelKeyOf(this.state.model)) {
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
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const res = await this.rpc.command('set_auto_compaction', { enabled })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setAutoRetry(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const res = await this.rpc.command('set_auto_retry', { enabled })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setSteeringMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const res = await this.rpc.command('set_steering_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setFollowUpMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const res = await this.rpc.command('set_follow_up_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async abortRetry(): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
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
    if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
    const steps = dir === 1 ? 1 : (await this.nativeCycleLength()) - 1
    if (steps < 1) return { ok: false, error: pick('只有一个可用模型', 'Only one model is available') }
    this.loopGuardContinuationVersion += 1
    let landed: { name?: string; id?: string } | undefined
    for (let i = 0; i < steps; i += 1) {
      const res = await this.requireRpc().command<{ model?: { name?: string; id?: string } } | null>('cycle_model')
      if (!res.success) return { ok: false, error: res.error }
      if (!res.data?.model) return { ok: false, error: pick('只有一个可用模型', 'Only one model is available') }
      landed = res.data.model
    }
    await this.refreshStateWithThinkingLevels()
    await this.refreshStats()
    return { ok: true, to: landed?.name || landed?.id }
  }

  async cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.enqueueCapabilityChange(async () => {
      if (!this.rpc) return { ok: false, error: pick('pi 尚未就绪', 'pi is not ready') }
      const res = await this.rpc.command<{ level?: string } | null>('cycle_thinking_level')
      if (!res.success) return { ok: false, error: res.error }
      const level = res.data?.level
      if (!level) return { ok: false, error: pick('当前模型不支持思考', 'The current model does not support thinking') }
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

  async getMessages(opts: { includeStreaming?: boolean } = {}): Promise<UIMessage[]> {
    const list = this.messages
    if (!opts.includeStreaming) return list
    const live = this.items.streamingMessage()
    return live ? [...list, live] : list
  }

  async refreshState(): Promise<SessionState | null> {
    const rpc = this.rpc
    const generation = this.capabilityOpts?.runnerGeneration
    const sessionId = this.state?.sessionId
    try {
      const res = await rpc?.command('get_state')
      if (res?.success && !this.stopping && this.rpc === rpc && this.capabilityOpts?.runnerGeneration === generation && this.state?.sessionId === sessionId) this.setStateFrom(res.data as Record<string, unknown>)
    } catch {
    }
    return this.state
  }

  async refreshStats(opts: { expectGeneration?: number } = {}): Promise<SessionStats | null> {
    try {
      const generation = this.capabilityOpts?.runnerGeneration
      const ownerSession = this.state?.sessionId
      const res = await this.rpc?.command<SessionStats>('get_session_stats')
      if (res?.success && res.data) {
        if (ownerSession !== this.state?.sessionId) return null
        if (opts.expectGeneration !== undefined && generation !== opts.expectGeneration) return null
        if (opts.expectGeneration !== undefined && this.capabilityOpts?.runnerGeneration !== opts.expectGeneration) return null
        const stats = await this.withOverheadUsage(this.statsForCurrentModel(res.data))
        if (ownerSession !== this.state?.sessionId) return null
        if (opts.expectGeneration !== undefined && this.capabilityOpts?.runnerGeneration !== opts.expectGeneration) return null
        this.push({ ch: 'stats', payload: stats })
        return stats
      }
    } catch { }
    return null
  }

  private async maybeGenerateTitle(
    opts: { force?: boolean; candidate?: boolean; lockHeld?: boolean; sessionId?: string; prompt?: TitleSampleMessage } = {}
  ): Promise<string | null> {
    const st = this.state
    const rpc = this.rpc
    const titleLifecycle = this.titleLifecycle
    if (!st || !rpc || this.stopping || (opts.sessionId && st.sessionId !== opts.sessionId)) return null
    if (!opts.lockHeld && this.titleTried.has(st.sessionId)) return null
    const automatic = !opts.force && !opts.candidate
    if (automatic && st.sessionName) {
      await this.adoptExternalTitle(st.sessionId, st.sessionName)
      return null
    }

    const users: TitleSampleMessage[] = this.messages.filter(
      (m) => m.role === 'user' && (m.text.trim() || m.images?.length)
    )
    if (users.length === 0 && opts.prompt && titleSampleText(opts.prompt)) users.push(opts.prompt)
    if (users.length === 0) return null

    const samples = titleSamples(users)
    const titleImages = titleSampleImages(users)

    if (!opts.lockHeld) this.titleTried.add(st.sessionId)
    const sessionId = st.sessionId

    try {
      const generated = await generateTitle({
        sessionId,
        samples,
        images: titleImages,
        cwd: this.cwd,
        piBin: this.piBin,
        ...(st.model ? { model: `${st.model.provider}/${st.model.id}` } : {}),
        extensions: this.providerExtensions,
        force: opts.force,
        allowManual: opts.candidate,
        persist: !opts.candidate
      })
      const res = generated ?? (opts.prompt && !this.stopping ? await fallbackTitle(sessionId, samples[0]) : null)
      if (!res?.title || this.stopping || this.rpc !== rpc || this.titleLifecycle !== titleLifecycle) return null

      if (opts.candidate) return res.title

      const stillSameSession = (): boolean => !this.stopping && this.rpc === rpc && this.titleLifecycle === titleLifecycle && this.state?.sessionId === sessionId
      if (stillSameSession() && automatic) {
        const fresh = await rpc.command('get_state').catch(() => null)
        const data = fresh?.success ? fresh.data as { sessionId?: unknown; sessionName?: unknown } | undefined : undefined
        if (data?.sessionId !== undefined && data.sessionId !== sessionId) return null
        const current = String(data?.sessionName ?? '').trim()
        if (current && current !== res.title) {
          if (stillSameSession()) await this.adoptExternalTitle(sessionId, current)
          return null
        }
      }
      if (stillSameSession() && this.lastTitle !== res.title) {
        this.lastTitle = res.title
        const ok = await rpc.command('set_session_name', { name: res.title })
        if (ok?.success && stillSameSession()) await this.refreshState()
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

  private async adoptExternalTitle(sessionId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      if ((await manualTitleOf(sessionId)) === trimmed) return
      if ((await cachedTitles())[sessionId] === trimmed) return
      await setManualTitle(sessionId, trimmed)
    } catch (e) {
      console.error('[agent] 记录外部标题失败：', e)
    }
  }

  getState(): SessionState | null {
    return this.state
  }

  holdsNotices(): boolean {
    return this.quotaExhausted
  }

  forkSource(): SubagentForkSource | string {
    const rpc = this.rpc
    if (!rpc?.running) return '来源会话没有在运行，不能派 fork 子代理'
    const state = this.state
    if (!state?.sessionFile) return '来源会话还没有保存，不能派 fork 子代理'
    if (!state.model) return '来源会话没有选定模型，不能派 fork 子代理'
    const usage = [...this.messages].reverse().find((msg) => msg.role === 'assistant' && hasUsageNumbers(msg.usage))?.usage
    const options = rpc.launchOptions
    return {
      cwd: options.cwd,
      piBin: options.piBin,
      args: [...(options.args ?? [])],
      env: { ...(options.env ?? {}) },
      sessionFile: state.sessionFile,
      model: `${state.model.provider}/${state.model.id}`,
      thinkingLevel: state.thinkingLevel || undefined,
      contextTokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : undefined,
      contextWindow: state.model.contextWindow || undefined
    }
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
        this.ui.pending.size === 0 && this.queue.isEmpty()
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
      const changed = this.capabilityOpts.runnerGeneration !== generation
      if (changed) this.releaseExecutionAdmission()
      this.capabilityOpts.runnerGeneration = generation
      if (changed && this.rpc) this.activateApprovals?.(this.approvalOwner())
    }
  }

  approvalOwner(): ApprovalOwner {
    return { instanceId: this.rpcInstanceId, generation: this.capabilityOpts?.runnerGeneration ?? 1 }
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
    let costCatalog = 0
    let countedUntil: number | null = null
    for (const msg of this.messages) {
      if (msg.usage?.costEstimated) costEstimated += msg.usage.cost
      else if (msg.usage?.costCatalog) costCatalog += msg.usage.cost
      if (msg.role === 'assistant' && hasUsageNumbers(msg.usage) && typeof msg.timestamp === 'number') {
        countedUntil = Math.max(countedUntil ?? msg.timestamp, msg.timestamp)
      }
    }
    const priced = costEstimated > 0 || costCatalog > 0 ? { cost: stats.cost + costEstimated, costEstimated: costEstimated + costCatalog } : {}
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
    await this.mcp.closeCurrent()
    this.nativeWitness = null
    this.nativeWitnessPending = null
    await this.mcp.closeRetired()
  }

  processId(): number | undefined {
    return this.rpc?.pid
  }

  async stop(): Promise<void> {
    const stopDeadline = Date.now() + STOP_TOTAL_BUDGET_MS
    const stopRemaining = (): number => Math.max(0, stopDeadline - Date.now())
    this.stopping = true
    this.releaseExecutionAdmission()
    this.loopGuardContinuationVersion += 1
    this.cancelApprovals?.(this.approvalOwner())
    this.retireApprovals?.(this.approvalOwner())
    const liveRpc = this.rpc
    if (liveRpc?.running && (this.agentRunning || this.state?.isStreaming || this.bash)) {
      if (this.turn.terminal === 'completed') this.turn.terminal = 'stopped'
      await liveRpc.command('abort', {}, { timeoutMs: Math.max(1, Math.min(STOP_ABORT_TIMEOUT_MS, stopRemaining())) }).catch(() => null)
      await liveRpc.command('abort_bash', {}, { timeoutMs: Math.max(1, Math.min(STOP_ABORT_BASH_TIMEOUT_MS, stopRemaining())) }).catch(() => null)
    }
    this.nativeRuntime?.dispose()
    this.nativeRuntime = null
    this.titleLifecycle += 1
    this.cancelImages()
    this.backgroundBash.dispose()
    this.capabilityServer?.stop()
    this.capabilityServer = undefined
    this.yanCliEnv = undefined
    this.mcpAppToolsSnapshot = undefined
    this.nativeWitness = null
    this.nativeWitnessPending = null
    const mcpClosing = this.mcp.close()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.streaming = null
    this.bash = null
    this.dirty = false
    this.dirtyTools.clear()
    this.pushedOut.clear()
    this.pushedOutText.clear()
    this.pushedArgs.clear()
    this.ui.rejectPendingHostUi('会话已关闭，问题请求已取消')
    this.ui.discardPending()
    await settleWithin(mcpClosing, stopRemaining())
    await this.rpc?.close()
    const runSink = this.runObserver
    const runCtx = this.runObserverContext()
    if (runSink && runCtx) runSink(runCtx, { type: 'stopped', by: 'host' })
    this.rpc = null
    await this.queue.flush()
    await this.turn.writeTail.catch(() => undefined)
    this.items.reset()
    this.queue.reset()
  }
}

export type { ForkPoint, SlashCommand }
