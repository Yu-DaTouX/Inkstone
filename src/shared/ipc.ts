import type { ApiKeyPools } from './api-keys'
import type { FileNameSearchRequest, FileNameSearchResult } from './file-name-search'
import type { HtmlArtifactPreviewResult } from './html-artifact-preview'
import type { HtmlEditPatch } from './html-edit-patch'
import type { ArtifactLibraryResult, SaveInlineArtifactInput, SaveInlineArtifactResult } from './artifact-library'
import type {
  NativeMcpImportCommitResponse,
  NativeMcpImportPrepareResponse,
  NativeMcpServerListView
} from './mcp-native-import'
import type { McpAppBridge } from './mcp-app-switch'
import type { McpSettingsMutation, McpSettingsResult, McpSettingsSnapshot } from './mcp-settings'
import type { McpAppViewApi } from './mcp-app-view'

export type {
  CustomProviderDiscoverResult,
  CustomProviderInput,
  CustomProviderTestResult,
  CustomProviderView,
  LocalModelServer
} from './custom-provider'
import type {
  CustomProviderDiscoverResult,
  CustomProviderInput,
  CustomProviderTestResult,
  CustomProviderView,
  LocalModelServer
} from './custom-provider'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult, WorkspaceFit } from './checkpoints'
import type { GitChangesOptions, GitChangesResult, GitDiffRequest, GitDiffResult, GitPathScreen, GitRefOption, GitRemoteIdentity, GitRepoState } from './git'
export type {
  GitActionExpected,
  GitActionKind,
  GitActionRequest,
  GitActionResult,
  GitFailure,
  GitFailureCode
} from './git-actions'
import type { GitActionExpected, GitActionRequest, GitActionResult } from './git-actions'
import type { ApprovalAnswerIdentity, ApprovalChoice, ApprovalRequest, ApprovalSnapshot, PermissionMode } from './approval'
import type { GitInstallProgress, GitRuntimeStatus } from './git-runtime'
export type { GitInstallProgress, GitRuntimeStatus } from './git-runtime'
export type { ApprovalAnswerIdentity, ApprovalChoice, ApprovalKind, ApprovalRequest, ApprovalSnapshot, PermissionMode } from './approval'
import type { WorkspaceMode } from './workspace-mode'
import type { BrowserLoadFailure } from './browser-navigation'
import type { UsageRange, UsageStatsView } from './usage-stats'
export type UsageStatsResult = UsageStatsView & { userName: string }
import type { SearchBackendStatus, SearchApiConfigView, SearchProviderId } from './search'
import type { AccountQuotaReport, CodexAccountView } from './account-quota'
import type { OAuthAccountPools } from './oauth-accounts'
import type { QuotaForecast } from './quota-forecast'
import type { TurnOutcome } from './turn-outcome'

export type { GitChangeEntry, GitChangesResult, GitDiffResult, GitRefOption, GitRepoState } from './git'

export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  costEstimated?: boolean
  reasoning?: number
}

export type ResponseDetail = 'brief' | 'standard' | 'detailed' | 'unknown'

export interface QuestionLogEntry {
  id: string
  question: string
  options: string[]
  answer: string | null
  cancelled: boolean
  at: number
}

export interface UIMessageImage {
  mimeType: string
  data: string
  url?: string
}

export interface UIToolCall {
  parentToolCallId?: string
  historySummary?: boolean
  incomplete?: boolean
  nestedCallsIncomplete?: boolean
  id: string
  name: string
  args: unknown
  argsRaw?: string
  status: 'pending' | 'running' | 'ok' | 'error'
  cancelled?: boolean
  denied?: boolean
  output?: string
  images?: UIMessageImage[]
  details?: unknown
  startedAt?: number
  endedAt?: number
}

export type TurnTerminalReason = 'completed' | 'stopped' | 'failed' | 'interrupted'

export interface TurnTimingMeta {
  logicalTurnId: string
  startedAt: number
  endedAt: number
  elapsedMs: number
  terminalReason: TurnTerminalReason
}

export interface GenerationTiming {
  durationMs: number
  ttftMs?: number
  decodeMs?: number
  outputDecodeMs?: number
  startEvent?: 'turn_start'
}

export interface UIMessage {
  id: string
  entryId?: string
  role: 'user' | 'assistant' | 'bash' | 'note'
  note?: { kind: 'custom' | 'branchSummary'; customType?: string }
  question?: boolean
  qa?: { question: string; answer?: string }[]
  sourceCwd?: string
  text: string
  images?: UIMessageImage[]
  thinking?: string
  thinkingMs?: number
  thinkingLive?: boolean
  toolCalls?: UIToolCall[]
  artifacts?: AssistantArtifact[]
  imageProgress?: ImageGenerationProgress[]
  usage?: Usage
  speed?: number
  elapsedMs?: number
  generationTiming?: GenerationTiming
  turnTiming?: TurnTimingMeta
  responseDetail?: ResponseDetail
  model?: string
  timestamp?: number
  bash?: { command: string; exitCode: number | null; cancelled: boolean }
  error?: string
}

export type ImageGenerationStage =
  | 'queued'
  | 'preparing'
  | 'confirming'
  | 'requesting'
  | 'generating'
  | 'saving'
  | 'done'
  | 'error'

export interface ImageGenerationProgress {
  id: string
  stage: ImageGenerationStage
  startedAt: number
  updatedAt: number
  endedAt?: number
  provider?: string
  model?: string
  detail?: string
}

export interface AssistantArtifact {
  id: string
  sourceId: string
  version?: number
  sha256?: string
  filename: string
  path: string
  sourcePath?: string
  mediaType: string
  kind: 'image' | 'svg' | 'code' | 'document' | 'binary'
  bytes: number
  createdAt: number
  previewable: boolean
  unavailable?: boolean
  error?: string
  provider?: string
  model?: string
  description?: string
}

export type QueueMode = 'all' | 'one-at-a-time'

export interface PiRuntimePrefs {
  autoRetry: boolean
  steeringMode: QueueMode
  followUpMode: QueueMode
}

export type PiCacheWarming = 'off' | 'streaming' | 'idle'
export type PiProjectTrustDefault = 'ask' | 'always' | 'never'
export type PiShareDestination = 'auto' | 'gist' | 'radius'

export interface PiNativeSettings {
  compactionEnabled: boolean
  retryMaxRetries: number
  retryBaseDelayMs: number
  httpIdleTimeoutMs: number
  cacheWarming: PiCacheWarming
  imagesAutoResize: boolean
  imagesBlockImages: boolean
  defaultProjectTrust: PiProjectTrustDefault
  sessionShareDestination: PiShareDestination
  modelThinkingLevels: Record<string, string>
}

export type PiNativeSettingsResult =
  | { ok: true; settings: PiNativeSettings }
  | { ok: false; error: string; settings?: PiNativeSettings }

export type PiSource =
  | 'override'
  | 'env'
  | 'bundled'
  | 'global'
  | 'path'
  | 'shell'

export interface PiInfo {
  bin: string
  version?: string
  home?: string
  source?: PiSource
  bundled?: boolean
  bundledAvailable?: boolean
  error?: string
}

export interface SessionState {
  conversationId?: string
  conversationFile?: string
  sessionId: string
  sessionFile?: string
  sessionName?: string
  model?: ModelInfo
  thinkingLevel: string
  ultracode?: boolean
  availableThinkingLevels: string[]
  thinkingLevelsStatus?: CapabilityStatus
  capabilities?: ModelCapabilitySnapshot
  isStreaming: boolean
  isAgentRunning?: boolean
  isCompacting: boolean
  compaction?: CompactionRun
  retry?: RetryRun
  lastCompaction?: CompactionRun
  contextFrom?: ContextFrom
  messageCount: number
  pendingMessageCount: number
  cwd: string
  autoCompactionEnabled?: boolean
  steeringMode?: QueueMode
  followUpMode?: QueueMode
}

export interface RetryRun {
  attempt: number
  maxAttempts: number
  delayMs: number
  at: number
  error?: string
}

export interface RuntimeEnvelope {
  sessionId: string
  runId: string
  projectId?: string
  generation: number
}

export type ExpectedRuntimeOwner = {
  sessionId?: string
  runId: string
  projectId?: string
  generation?: number
}

export interface RunnerStatus {
  id: string
  runId: string
  sessionFile?: string
  sessionId?: string
  projectId?: string
  generation: number
  cwd: string
  running: boolean
  waiting: boolean
  failed: boolean
  conn: 'starting' | 'ready' | 'exited' | 'error'
  createdAt: number
  lastActiveAt: number
  isActive: boolean
  isolation?: 'waiting' | 'ready' | 'blocked'
  isolationBranch?: string
}

export interface ForkPoint {
  entryId: string
  text: string
}

export type CommandSource = 'pi' | 'extension' | 'skill' | 'prompt' | 'yan' | 'compatibility'

export interface CommandDescriptor {
  name: string
  description?: string
  source: CommandSource
  location?: string
  module?: string
  executable: boolean
  usage?: string
  availability?: string
  hiddenInMenu?: boolean
}

export type SlashCommand = CommandDescriptor

export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  data: string
  preview: string
  kind?: 'image' | 'file'
  path?: string
  isDirectory?: boolean
}

export const CANVAS_CAPTURE_CHANNEL = 'yan:canvas:capture'

export interface CanvasCaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasCaptureResult =
  | { ok: true; data: string; width: number; height: number; scaleFactor: number }
  | { ok: false; error: string }

export const VIDEO_EXPORT_START_CHANNEL = 'yan:videoExport:start'
export const VIDEO_EXPORT_CANCEL_CHANNEL = 'yan:videoExport:cancel'
export const VIDEO_EXPORT_PROGRESS_CHANNEL = 'yan:videoExport:progress'

export interface VideoExportRequest {
  id: string
  path: string
  cwd?: string
  fps?: number
  scale?: number
}

export type VideoExportErrorCode =
  | 'export-busy'
  | 'bad-request'
  | 'ffmpeg-missing'
  | 'load-failed'
  | 'no-timeline'
  | 'too-long'
  | 'capture-failed'
  | 'encode-failed'
  | 'output-failed'
  | 'cancelled'
  | 'failed'

export interface VideoExportProgress {
  id: string
  frame: number
  total: number
}

export type VideoExportResult =
  | {
      ok: true
      id: string
      path: string
      frames: number
      fps: number
      width: number
      height: number
      duration: number
      bytes: number
      elapsedMs: number
    }
  | { ok: false; id: string; error: VideoExportErrorCode; detail?: string }

interface VideoExportBridge {
  start(request: VideoExportRequest): Promise<VideoExportResult>
  cancel(id: string): Promise<boolean>
  onProgress(cb: (payload: VideoExportProgress) => void): () => void
}

export const HTML_EDIT_APPLY_CHANNEL = 'yan:htmlEdit:apply'
export const HTML_EDIT_UNDO_CHANNEL = 'yan:htmlEdit:undo'

export type HtmlEditError =
  | 'not-html'
  | 'denied'
  | 'missing'
  | 'too-large'
  | 'encoding'
  | 'conflict'
  | 'draft'
  | 'offset'
  | 'styles'
  | 'attributes'
  | 'text'
  | 'text-children'
  | 'empty'
  | 'undo'
  | 'failed'

export interface HtmlEditRequest {
  path: string
  cwd?: string
  sha256: string
  frameHash: string
  sourceOffset: number
  tag: string
  patch: HtmlEditPatch
}

export interface HtmlEditUndoRequest {
  path: string
  cwd?: string
  sha256: string
}

export type HtmlEditResult =
  | { ok: true; sha256: string }
  | { ok: false; error: HtmlEditError; detail?: string }

export interface ModelInfo {
  id: string
  name: string
  provider: string
  api?: string
  reasoning: boolean
  reasoningStatus?: CapabilityStatus
  input?: Array<'text' | 'image' | string>
  inputStatus?: CapabilityStatus
  contextWindow: number
  contextWindowStatus?: CapabilityStatus
  contextWindowAssumed?: boolean
  maxTokens?: number
  maxTokensStatus?: CapabilityStatus
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

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

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
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
  costEstimated?: number
  overheadUsage?: TokenCounts
  countedUntil?: number | null
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
    modelKey?: string
    availability?: CapabilityStatus
    estimated?: boolean
  }
  toolCalls: number
  userMessages: number
  assistantMessages: number
}

export interface BashRun {
  id: string
  command: string
  output: string
  running: boolean
  exitCode: number | null
  truncated?: boolean
  fullOutputPath?: string
}

export interface QueueItem {
  id: string
  text: string
  images?: { data: string; mimeType: string }[]
}

export interface QueueState {
  steering: QueueItem[]
  followUp: QueueItem[]
}

export type QueueEditOp =
  | { op: 'move'; id: string; direction: 'up' | 'down' }
  | { op: 'edit'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'clear' }

export interface QueueSnapshot {
  steering: string[]
  followUp: string[]
  items?: QueueState
}

export interface SessionTodo {
  text: string
  done: boolean
  status?: TodoStatus
}

export type TodoStatus = 'pending' | 'running' | 'done' | 'blocked'

export interface SessionTodoSnapshot {
  id: string
  todos: SessionTodo[]
  round: number
}

export interface CustomEntry {
  id: string
  customType: string
  data: unknown
}

export interface SessionSearchHit {
  path: string
  snippet: string
  matches: number
  updatedAt: number
}

export interface SessionSearchResult {
  hits: SessionSearchHit[]
  indexed: number
  total: number
}

export interface SessionSummary {
  id: string
  path: string
  cwd: string
  title: string
  named: boolean
  parentSession?: string
  branchOrigin?: string
  lastActivityAt?: number
  lastReply?: { id: string; at: number; text: string }
  createdAt: number
  updatedAt: number
  messageCount: number
  model?: string
  projectId?: string
  scope?: SessionScope
  lastOpenedAt?: number
  archivedAt?: number
  pinned?: boolean
  projectCandidates?: string[]
}

export type SessionScope = 'global' | 'project' | 'pending'

export interface SessionMoveRecord {
  at: number
  fromProjectId?: string
  toProjectId?: string
  fromScope: SessionScope
  toScope: SessionScope
}

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
  archivedAt?: number
  pinned?: boolean
  moveHistory: SessionMoveRecord[]
}

export interface SessionLayoutDocument {
  version: 1
  entries: SessionLayoutEntry[]
}

export interface PeekResult {
  messages: UIMessage[]
  total: number
  truncated: number
  bytes: number
  sessionId?: string
}

export type AuthStatus = 'ready' | 'missing' | 'unknown'

export interface CodexLoginResult {
  ok: boolean
  accountId?: string
  error?: string
}

export interface StorageInfoView {
  agentDir: string
  realDir: string
  relocated: boolean
  movable: boolean
  bytes: number
  pendingTarget?: string
  strandedBackup?: string
  lastResult?: { ok: boolean; at: number; from: string; to: string; error?: string; leftover?: string }
}

export interface ComputerUseStatusView {
  supported: boolean
  uvx: string | null
  enabled: boolean
  canInstallUv: boolean
  interactionUncertain: boolean
}

export interface ComputerUseActionResult {
  ok: boolean
  error?: string
  log?: string
  needsManual?: boolean
}

export interface OAuthLoginResult {
  ok: boolean
  cancelled?: boolean
  error?: string
}

export type OAuthLoginEvent =
  | { provider: string; type: 'auth_url'; url: string; message?: string }
  | { provider: string; type: 'device_code'; userCode: string; url: string; expiresInSeconds?: number }
  | { provider: string; type: 'progress'; message: string }
  | {
      provider: string
      type: 'prompt'
      promptId: number
      kind: 'manual_code' | 'text' | 'select'
      message: string
      placeholder?: string
      options?: { id: string; label: string }[]
    }
  | { provider: string; type: 'prompt_closed'; promptId: number }
  | { provider: string; type: 'done' }

export type AuthKind = 'subscription' | 'api_key'

export interface CustomProviderResult {
  ok: boolean
  errors?: string[]
  providers?: CustomProviderView[]
}

export interface ToolStatus {
  ok: boolean
  path?: string
  managed?: boolean
  reason?: ToolMissingReason
}

export type ToolMissingReason =
  | { code: 'shell-path-missing'; path: string }
  | { code: 'bash-missing'; shell: 'pwsh' | 'powershell' }
  | { code: 'git-missing' }

export interface ToolchainStatus {
  platform: string
  bash: ToolStatus
  git: ToolStatus
}

export interface AuthProviderInfo {
  id: string
  name: string
  kind: AuthKind
  envVar: string
  authKey: string
  loginCmd?: string
  inAppLogin?: boolean
  status: AuthStatus
  source?: 'auth.json' | 'env'
}

export interface ProjectRecord {
  id: string
  cwd: string
  name: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface ProjectDirectoryChange {
  projectId: string
  expectedCwd: string
  cwd: string
}

export type ProjectDirectoryResult = { ok: true; settings: AppSettings } | { ok: false; error: string }

export interface AppSettings {
  lastMainModel?: import('./model-selection').ModelChoice
  lastSubagentModel?: import('./model-selection').ModelChoice | 'follow'
  subagentDefaultModel?: import('./model-selection').ModelChoice | 'follow'
  subagentModelForce?: boolean
  modelFavorites?: import('./model-selection').ModelChoice[]
  modelProviderOrder?: string[]
  cwd: string
  theme: 'dark' | 'light'
  lang: 'zh-CN' | 'en-US'
  piBin?: string
  codemodeEnabled?: boolean
  asciiBackground?: boolean
  autoArchiveDays?: number
  keepAwakeWhileWorking?: boolean
  visualAnswers?: boolean
  contextTrim?: boolean
  contextTrimTokens?: number
  autoCompactTokens?: number
  fontUi?: 'sans' | 'serif' | 'maple' | 'custom'
  fontUiCustom?: string
  fontCode?: 'maple' | 'custom'
  fontCodeCustom?: string
  fontSizeUi?: number
  streamWidth?: number
  reduceMotion?: boolean
  keepAwakeOnBattery?: boolean
  checkpointsEnabled?: boolean
  guardOutsideWrites?: boolean
  permissionMode?: PermissionMode
  guardAllowRoots?: string[]
  browserAllowedSites?: string[]
  recentCwds: string[]
  projectNames: Record<string, string>
  projects: ProjectRecord[]
  providerBudgets: Record<string, number>
  rightPanelOpen: boolean
  workspaceMode?: WorkspaceMode
  alwaysOnTop: boolean
  uiScale: number
  profile: UserProfile
  subagentNotify?: boolean
  streamLoopAutoContinue?: boolean
  wrapUpCard?: boolean
  workspaceTiles?: boolean
  smoothText?: boolean
  usageCurrency?: import('./currency').UsageCurrencySettings
  remoteAccess?: import('./remote-protocol').RemoteAccessSettings
  voiceInput?: import('./voice-input').VoiceInputSettings
  sendKey: 'auto' | 'enter' | 'ctrlEnter'
  responseDetail: 'brief' | 'standard' | 'detailed'
  density: 'compact' | 'standard' | 'comfortable'
  sound: SoundSettings
  shortcutOverrides?: import('../renderer/src/app/shortcuts').ShortcutOverrides
}

export type SoundEvent = 'done' | 'question' | 'error'

export interface SoundSettings {
  enabled: boolean
  volume: number
  notifications: boolean
  events: Record<SoundEvent, boolean>
}

export interface AttentionNotify {
  kind: SoundEvent
  title: string
  body?: string
  model?: { provider?: string; id?: string }
}

export const SOUND_VOLUME_MIN = 0
export const SOUND_VOLUME_MAX = 1

export interface ProviderQuota {
  provider: string
  supported: boolean
  remaining?: number
  total?: number
  used?: number
  currency?: string
  label?: string
  error?: string
  staleError?: string
  windows?: QuotaWindow[]
  checkedAt: number
}

export interface QuotaWindow {
  id: string
  label: string
  used: number
  total: number
  resetAt?: number
  exceeded?: boolean
  informational?: boolean
  estimated?: boolean
  durationMs?: number
  allowsOverage?: boolean
  forecast?: QuotaForecast
}

export interface TrustStatusView {
  cwd: string
  trusted: boolean
  entry: string | null
}

export interface CompactionInfo {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
  contextWindow: number
  threshold: number
  cappedByInkstone?: boolean
  custom: boolean
  scope?: 'global' | 'project'
  projectIgnored?: boolean
}

export type CompactionReason = 'manual' | 'threshold' | 'overflow'

export type CompactionStatus = 'running' | 'completed' | 'declined' | 'failed' | 'cancelled'

export interface CompactionRun {
  status: CompactionStatus
  reason?: CompactionReason
  reasonRaw?: string
  startedAt?: number
  endedAt?: number
  error?: string
  entryId?: string
  firstKeptEntryId?: string
  beforeTokens?: number
  afterTokens?: number
  afterMeasured?: boolean
  triggeredBy?: 'policy'
  policyStage?: 'compact' | 'emergency'
}

export interface ContextFrom {
  firstKeptEntryId?: string
  compactedAt?: number
}

export interface UserProfile {
  name: string
  avatarKind: 'letter' | 'icon'
  avatarValue: string
  avatarHue: number
  signedIn: boolean
}

export interface PiProbe {
  ok: boolean
  cmd: string
  args: string[]
  version?: string
  source: PiSource
  home?: string
  error?: string
  tried: string[]
}

export type TerminalProgramState = 'working' | 'blocked' | 'done' | 'error' | 'idle' | 'clear'

export type TerminalBlockedKind = 'permission' | 'question' | 'auth'

export interface TerminalProgramStatus {
  state: TerminalProgramState
  kind?: TerminalBlockedKind
  progress?: number
  title?: string
  app?: string
}

export interface TerminalSessionInfo {
  id: string
  title: string
  shell: string
  cwd: string
  cols: number
  rows: number
  alive: boolean
  exitCode?: number | null
  status?: TerminalProgramStatus
  owner?: string
}

export interface TerminalSnapshot extends TerminalSessionInfo {
  buffer: string
  seq: number
}

export interface TerminalStartRequest {
  cwd?: string
  fallbackCwd?: string
  cols?: number
  rows?: number
  owner?: string
}

export interface TerminalAvailability {
  available: boolean
  error?: string
}

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
  userControlRequest?: { reason: string; sessionId: string; at: number }
  lastDownload?: { path: string; filename: string; size?: number; source?: string }
  permissions?: BrowserPermissionRecord[]
  blockedRequests?: BrowserBlockedRequest[]
  mode?: 'embedded' | 'external'
  loadError?: BrowserLoadFailure
  external?: BrowserExternalState
}

export interface BrowserPermissionRecord {
  permission: string
  origin: string
  status: 'allowed' | 'blocked'
  at: number
}

export interface BrowserBlockedRequest {
  host: string
  reason: 'private-host' | 'dns-rebind'
  from: string
  at: number
  count: number
}

export interface BrowserExternalState {
  url: string
  title: string
  loading: boolean
  profileDir?: string
  debuggingPort?: number
  sync?: ChromeSyncReport
}

export interface ChromeSyncReport {
  found: boolean
  source?: string
  target?: string
  copied: string[]
  failed: { item: string; reason: string }[]
  chromeRunning: boolean
  cookiesSynced: boolean
}

export interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  loadError?: BrowserLoadFailure
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
    frameId?: string
    frameUrl?: string
  }>
  accessibilityNodeCount: number
  frameCount?: number
  observedFrameCount?: number
}

export interface BrowserNetworkEntry {
  url: string
  method: string
  status?: number
  resourceType?: string
  state: 'pending' | 'finished' | 'failed'
}

export interface BrowserNetworkSnapshot {
  capturedAt: number
  entries: BrowserNetworkEntry[]
  limit: number
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text'

export interface ExtensionUiRequest {
  id: string
  method: ExtensionUiMethod
  sensitive?: boolean
  purpose?: 'approval'
  toolCallId?: string
  title?: string
  message?: string
  options?: string[]
  form?: import('./question-form').QuestionField[]
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
  deadline?: number
}

export interface ToolPatch {
  msgId: string
  call: UIToolCall
  outputDelta?: string
}

export type MessagePatch = Partial<UIMessage> & {
  textDelta?: string
  thinkingDelta?: string
}

export type SubagentReviewState = 'none' | 'pending' | 'conflict' | 'merged' | 'discarded' | 'archived'

export interface SubagentDiffSummary {
  files: number
  additions: number
  deletions: number
  paths: string[]
  truncated: boolean
  patchPath?: string
}

export interface SubagentUsageTotals {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  totalTokens: number | null
  cost: number | null
  reportedMessages: number
}

export type SubagentEndReason = 'completed' | 'timeout' | 'budget' | 'model-error' | 'startup' | 'exited' | 'failed' | 'stopped'

export type { SubagentBrief, SubagentResult } from './subagent-brief'
import type { SubagentBrief, SubagentResult } from './subagent-brief'

export interface SubagentStopResult {
  ok: boolean
  error?: string
  noop?: boolean
  before?: SubagentRun['status']
}

export interface SubagentRun {
  id: string
  task: string
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  projectId?: string
  isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd'
  fork?: boolean
  resultPath?: string
  model?: string
  thinkingLevel?: string
  contextUsage?: SessionStats['contextUsage']
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  latestActivity?: string
  progressWarning?: string
  transcript: UIMessage[]
  transcriptOmitted?: boolean
  diff?: SubagentDiffSummary
  review: SubagentReviewState
  error?: string
  endReason?: SubagentEndReason
  launchFailed?: boolean
  dismissedAt?: number
  toolCalls?: number
  wrapUp?: { reason: 'timeout' | 'budget'; since: number }
  recovery?: SubagentRecovery
  usage?: SubagentUsageTotals
  brief?: SubagentBrief
  result?: SubagentResult
}

export interface SubagentRecovery {
  piRetries?: number
  piMaxRetries?: number
  resumed?: boolean
}

export interface ScheduleBridge {
  list(): Promise<import('./schedule').ScheduledTask[]>
  create(input: { name?: string; prompt: string; cwd?: string; model?: string; trigger: import('./schedule').ScheduleTrigger }): Promise<{ ok: boolean; error?: string; task?: import('./schedule').ScheduledTask }>
  update(id: string, input: { name?: string; prompt?: string; cwd?: string; model?: string; trigger?: import('./schedule').ScheduleTrigger }): Promise<{ ok: boolean; error?: string; task?: import('./schedule').ScheduledTask }>
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string; task?: import('./schedule').ScheduledTask }>
  remove(id: string): Promise<{ ok: boolean }>
  runNow(id: string): Promise<{ ok: boolean; error?: string; sessionId?: string }>
}

export interface SubagentBridge {
  list(): Promise<SubagentRun[]>
  get(id: string): Promise<SubagentRun | null>
  start(
    task: string,
    model?: string,
    isolation?: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    expectedRuntime?: ExpectedRuntimeOwner
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }>
  stop(id: string): Promise<SubagentStopResult>
  send(id: string, message: string): Promise<{ ok: boolean; error?: string; delivery?: 'queued' | 'started' | 'resumed' }>
  dismiss(id: string): Promise<{ ok: boolean; error?: string }>
  stopAll(): Promise<void>
  clearFinished(): Promise<void>
  merge(id: string): Promise<{ ok: boolean; error?: string }>
  discard(id: string): Promise<{ ok: boolean; error?: string }>
}

export type BrowserSiteAddResult = 'ok' | 'invalid' | 'exists' | 'blocked' | 'unavailable'

export interface SessionSyncDelta {
  anchorId: string
  anchorIndex: number
  anchorSignature: string
  messages: UIMessage[]
}

export type MainPushBody =
  | { ch: 'browser-site-ask'; payload: { id: string; origin: string; url: string } }
  | { ch: 'sync'; payload: UIMessage[] }
  | { ch: 'sync-delta'; payload: SessionSyncDelta }
  | { ch: 'msg-add'; payload: UIMessage }
  | { ch: 'msg-update'; payload: { id: string; patch: MessagePatch } }
  | { ch: 'artifact'; payload: { messageId: string; artifact: AssistantArtifact } }
  | { ch: 'tool'; payload: ToolPatch }
  | { ch: 'subagent'; payload: SubagentRun }
  | { ch: 'subagent-patch'; payload: { id: string; run: SubagentRun; transcriptFrom: number } }
  | { ch: 'subagent-remove'; payload: string }
  | { ch: 'state'; payload: SessionState }
  | { ch: 'stats'; payload: SessionStats }
  | { ch: 'queue'; payload: QueueState }
  | { ch: 'queue-reclaimed'; payload: QueueSnapshot & { sessionId: string } }
  | { ch: 'todos'; payload: SessionTodo[] }
  | { ch: 'approval'; payload: ApprovalRequest }
  | { ch: 'approval-close'; payload: { id: string } }
  | { ch: 'approval-snapshot'; payload: ApprovalSnapshot }
  | { ch: 'git-install'; payload: GitInstallProgress }
  | { ch: 'todo-history'; payload: SessionTodoSnapshot[] }
  | { ch: 'ui-request'; payload: ExtensionUiRequest }
  | { ch: 'ui-deadline'; payload: { id: string; timeout: number; deadline: number } }
  | { ch: 'ui-resolved'; payload: { id: string; by: 'desktop' | 'remote' | 'timeout' } }
  | { ch: 'question-log'; payload: { sessionId: string; entries: QuestionLogEntry[] } }
  | { ch: 'notify'; payload: ExtensionUiRequest }
  | { ch: 'agent-error'; payload: { message: string; text: string; source: 'auto-retry' | 'stop-reason' } }
  | { ch: 'quota-wait'; payload: { provider?: string } }
  | { ch: 'turn-settled'; payload: { sessionId?: string; outcome: TurnOutcome } }
  | { ch: 'status'; payload: { key: string; text?: string } }
  | { ch: 'title'; payload: string }
  | { ch: 'win-state'; payload: { maximized: boolean; alwaysOnTop: boolean } }
  | { ch: 'session-title'; payload: { sessionId: string; title: string } }
  | { ch: 'editor-text'; payload: string }
  | { ch: 'widget'; payload: { key: string; lines?: string[]; placement?: 'aboveEditor' | 'belowEditor' } }
  | { ch: 'pi-info'; payload: PiInfo }
  | { ch: 'proc'; payload: { state: 'starting' | 'ready' | 'exited' | 'stderr' | 'error'; detail?: string; code?: number | null } }
  | { ch: 'ui-scale'; payload: { uiScale: number; effective: number; scaleFactor: number; autoScale: number } }
  | { ch: 'browser-state'; payload: BrowserState }
  | { ch: 'terminal'; payload: { id: string; kind: 'data' | 'exit' | 'status'; data?: string; seq?: number; exitCode?: number | null; status?: TerminalProgramStatus } }
  | { ch: 'log'; payload: { text: string; level?: 'info' | 'error' } }
  | { ch: 'search-api-hint'; payload: Record<string, never> }
  | { ch: 'runners'; payload: RunnerStatus[] }
  | { ch: 'runs'; payload: { revision: number; upsert: import('./runs').RunSnapshot[]; remove: string[] } }
  | { ch: 'tray-new-session'; payload: null }
  | { ch: 'peer-request'; payload: import('./peer-protocol').PeerApprovalRequest }
  | { ch: 'peer-request-closed'; payload: { requestId: string } }
  | { ch: 'session-moved'; payload: { sessionId: string; sessionFile: string; cwd: string; ok: boolean; error?: string; continued?: boolean; continuationError?: string } }
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

export type MainPush = MainPushBody & {
  runtime?: RuntimeEnvelope
  sessionKey?: string
}


export interface GitBridge {
  state(cwd: string): Promise<{ repo: GitRepoState | null; expected?: GitActionExpected; error?: string }>
  refs(cwd: string): Promise<{ ok: boolean; refs: GitRefOption[]; busyBranches: string[]; error?: string }>
  action(req: GitActionRequest): Promise<GitActionResult>
  remotes(cwd: string): Promise<string[]>
  untracked(cwd: string): Promise<string[]>
  changes(cwd: string, options?: GitChangesOptions): Promise<GitChangesResult>
  screenPaths(cwd: string, paths: string[]): Promise<GitPathScreen>
  diff(req: GitDiffRequest): Promise<GitDiffResult>
  identity(cwd: string, refresh?: boolean): Promise<GitRemoteIdentity | null>
  worktrees(cwd: string): Promise<WorktreeListing>
}

export interface WorktreeInfo {
  path: string
  head: string
  branch: string | null
  bare: boolean
  main: boolean
  locked: boolean
  prunable: boolean
  ours: boolean
}

export interface WorktreeListing {
  ok: boolean
  repoRoot: string
  worktrees: WorktreeInfo[]
  error?: string
}

export interface PackageEntryView {
  source: string
  scope: 'user' | 'project'
  name: string
  version: string | null
  description: string | null
  repository: string | null
  license: string | null
  installed: boolean
  path: string | null
}

export interface PackageListingView {
  ok: boolean
  agentDir: string
  userSettings: string
  projectSettings: string
  entries: PackageEntryView[]
  error?: string
}

export interface PackageActionView {
  kind: 'install' | 'remove' | 'update'
  source: string
  local?: boolean
  cwd: string
}

export interface PackageActionResultView {
  ok: boolean
  output?: string
  detail?: string
  error?: string
  listing?: PackageListingView
}

export interface PackagesBridge {
  search(query: string, offset?: number): Promise<import('./plugin-market').MarketSearchResult>
  catalog(refresh?: boolean): Promise<import('./plugin-catalog').PluginCatalogView>
  exportPlugin(id: string): Promise<import('./plugin-market').PluginExportResult>
  addMcp(id: string): Promise<import('./plugin-market').PluginExportResult>
  minecraft(action: 'status' | 'install' | 'remove'): Promise<import('./plugin-market').MinecraftPluginResult>
  codegraphStatus(cwd: string): Promise<import('./plugin-market').CodegraphStatus>
  codegraphIndex(cwd: string): Promise<{ ok: boolean; error?: string; log?: string }>
  anthropicEnv(): Promise<string[]>
  list(cwd: string): Promise<PackageListingView>
  action(req: PackageActionView): Promise<PackageActionResultView>
}

export type PeerResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export interface PeerSessionRow {
  id: string
  title: string
  projectId?: string
  cwdName?: string
  updatedAt: number
  messageCount: number
}

export interface PeerHistoryMessage {
  id: string
  role: string
  text?: string
  createdAt?: number
  artifacts?: Array<{ id: string; filename: string }>
}

export interface BuiltinCapabilityView {
  id: string
  file?: string
}

export interface BuiltinCapabilitiesBridge {
  list(): Promise<BuiltinCapabilityView[]>
}

export interface CapabilitySkillSettingView {
  id: string
  title: string
  description: string
  origin?: 'session' | 'user' | 'pi' | 'bundled' | 'other'
  acquired?: boolean
  sourceUrl?: string
  location?: string
  enabled?: boolean
  manage?: { scope: 'yan' | 'pi'; dir: string }
}

export type ManagedSkillAction = 'enable' | 'disable' | 'trash'

export interface CapabilityMcpServerSettingView {
  id: string
  title: string
  transport: 'stdio' | 'http'
  enabled: boolean
  effect: 'read' | 'write' | 'external-action' | 'unknown'
  projectScoped: boolean
  endpointOrigin?: string
  status: 'ready' | 'connecting' | 'disconnected' | 'needs-auth' | 'error'
  toolCount: number | null
  ownedBy?: 'pi' | 'inkstone'
  migratedToNative?: import('./mcp').McpMigratedToNativeMark
}

export interface CapabilitySettingsSnapshot {
  skills: CapabilitySkillSettingView[]
  servers: CapabilityMcpServerSettingView[]
  nativeMcpAvailable?: boolean
  configWarning: boolean
}

export interface CapabilitySearchSourceView {
  sourceId: string
  ok: boolean
  pages: number
  candidateCount: number
}

export interface CapabilitySearchCandidateView {
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
}

export interface CapabilitySearchResultView {
  query: string
  reason: 'unavailable' | 'no-candidates' | null
  sources: CapabilitySearchSourceView[]
  candidates: CapabilitySearchCandidateView[]
}

export interface CapabilityVerificationStatus {
  operationId: string
  state: 'connecting' | 'ready' | 'error' | 'cancelled' | 'stale'
  toolCount?: number
}

export interface PromptTemplateDirectories {
  user: string
  project?: string
}

export interface CapabilitiesBridge {
  snapshot(): Promise<CapabilitySettingsSnapshot>
  promptDirectories(): Promise<PromptTemplateDirectories>
  openPromptDirectory(path: string): Promise<{ ok: boolean; error?: string }>
  createPromptTemplate(input: { name: string; content: string }): Promise<{ ok: boolean; path?: string; error?: string }>
  discover(queryText: string): Promise<CapabilitySearchResultView>
  sessionSkill(action: 'promote' | 'remove', name: string): Promise<{ ok: boolean; error?: string }>
  manageSkill(action: ManagedSkillAction, scope: 'yan' | 'pi', dir: string): Promise<{ ok: boolean; error?: string }>
  revealSkill(location: string): Promise<{ ok: boolean; error?: string }>
  verify(serverId: string): Promise<{ ok: boolean; operationId?: string; error?: string }>
  verification(operationId: string): Promise<CapabilityVerificationStatus | null>
  cancelVerification(operationId: string): Promise<{ ok: boolean; error?: string }>
  prepareNativeImport(serverId: string): Promise<NativeMcpImportPrepareResponse>
  commitNativeImport(token: string): Promise<NativeMcpImportCommitResponse>
  nativeServers(): Promise<NativeMcpServerListView>
  mcpServices(): Promise<McpSettingsSnapshot>
  changeMcpService(input: McpSettingsMutation): Promise<McpSettingsResult>
  applyMcpServices(input: { context: string; expectedSessionId: string }): Promise<McpSettingsResult>
  manageNativeServer(action: NativeMcpManageAction, name: string): Promise<NativeMcpManageResult>
}

export type NativeMcpManageAction = 'enable' | 'disable' | 'remove'

export interface NativeMcpManageResult {
  ok: boolean
  error?: string
}

export type SourceKindView = 'image' | 'file' | 'web'

export interface SourceRefView {
  sourceId: string
  sessionId: string
  kind: SourceKindView
  title: string
  ref: string
  fingerprint: string
  origin: string
  addedAt: number
  available: boolean
  error?: string
  size?: number
}

export interface SourceLinkView {
  sourceId: string
  messageId: string
  at: number
}

export interface SourcesBridge {
  list(sessionId: string): Promise<{ ok: boolean; images: SourceRefView[]; dir: string; links: SourceLinkView[]; error?: string }>
  addImage(req: { sessionId: string; name: string; mimeType: string; base64: string }): Promise<SourceRefView | null>
  verifyFiles(req: { sessionId: string; entries: { path: string; name?: string; addedAt?: number }[] }): Promise<SourceRefView[]>
  link(req: { sessionId: string; sourceIds: string[]; messageId: string }): Promise<{ ok: boolean; added: number; skipped: number; error?: string }>
  removeImage(req: { sessionId: string; sourceId: string }): Promise<{ ok: boolean; error?: string }>
}

export interface WebSearchSourceView {
  title: string
  url: string
  domain: string
  snippet: string
  source: string
}

export interface WebSearchPageView {
  title: string
  url: string
  domain: string
  excerpt: string
}

export type WebSearchOpView =
  | { ok: true; kind: 'search'; sources: WebSearchSourceView[] }
  | { ok: true; kind: 'fetch'; page: WebSearchPageView }
  | { ok: false; error: string }

export const SEARCH_OPS_READ_CHANNEL = 'yan:searchOps:read'

export interface SearchOpsBridge {
  read(operationId: string): Promise<WebSearchOpView>
}

export interface AttachmentUsage {
  files: number
  bytes: number
}

export interface AttachmentPruneResult {
  removed: number
  bytes: number
  kept: number
}

export interface VisibleRunnerSession {
  sessionId?: string
  sessionFile?: string
}

export interface RunsHistorySegment {
  phase: string
  from: number
  to: number
}

export interface RunsHistoryRecord {
  runId: string
  code: string
  kind: import('./runs').RunKind
  sessionId: string
  sessionPath?: string
  projectId?: string
  parentRunId?: string
  title: string
  model?: import('./runs').RunModel
  startedAt: number
  endedAt: number
  terminal: 'done' | 'stopped' | 'failed'
  cause?: string
  errorKind?: string
  message?: string
  segments: RunsHistorySegment[]
  costUsd?: number
  counts: import('./runs').RunCounts
}

export interface RunsHistoryQuery {
  date?: string
  range?: { from: string; to?: string }
  filters?: {
    terminal?: RunsHistoryRecord['terminal'][]
    kind?: import('./runs').RunKind[]
    projectId?: string
    sessionId?: string
    model?: string
    query?: string
  }
  limit?: number
}

export interface RunsHistoryResult {
  ok: boolean
  error?: string
  records: RunsHistoryRecord[]
  days: string[]
  truncated: boolean
  failures?: { day: string; error: string }[]
}

export interface RunsStopResult {
  ok: boolean
  error?: string
  runId?: string
  kind?: import('./runs').RunKind
  recovered?: { steering: string[]; followUp: string[] }
}

export type DeepLinkIntent =
  | { action: 'session'; sessionId: string; entryId?: string }
  | { action: 'new-session'; text?: string }
  | { action: 'settings'; section: string }
  | { action: 'pair'; address: string; code: string }

export interface YanBridge {
  readonly probeMode: boolean
  appUpdate: {
    status(): Promise<import('./app-update').AppUpdateStatus>
    check(): Promise<import('./app-update').AppUpdateStatus>
    automatic(enabled: boolean): Promise<import('./app-update').AppUpdateStatus>
    download(): Promise<import('./app-update').AppUpdateStatus>
    install(): Promise<{ ok: boolean; error?: string }>
  }
  selectSession(target: {
    sessionFile?: string
    sessionId?: string
    projectId?: string
    scope?: SessionScope
    cwd: string
    preview?: boolean
  }): Promise<{
    ok: boolean
    id?: string
    runId?: string
    sessionId?: string
    generation?: number
    via?: 'hit' | 'reuse' | 'new'
    deferred?: boolean
    error?: string
  }>
  setVisibleRunnerSessions(sessions: VisibleRunnerSession[]): Promise<boolean>
  runnerStatuses(): Promise<RunnerStatus[]>
  mergeIsolation(cwd: string): Promise<{ ok: boolean; error?: string }>
  stopRunner(id: string): Promise<boolean>
  runs: {
    snapshot(): Promise<{ revision: number; runs: import('./runs').RunSnapshot[] }>
    markSeen(runId: string): Promise<{ ok: boolean }>
    history(query: RunsHistoryQuery): Promise<RunsHistoryResult>
    stop(runId: string): Promise<RunsStopResult>
  }
  sync: import('./sync').SyncBridge
  start(cwd?: string): Promise<{ ok: boolean; error?: string; state?: SessionState }>
  send(text: string, images?: { data: string; mimeType: string }[], mode?: 'steer' | 'followUp', expectedRuntime?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
  steer(text: string, expectedRuntime?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
  followUp(text: string): Promise<{ ok: boolean; error?: string }>
  steerQueued(queueId: string): Promise<{ ok: boolean; error?: string }>
  removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; images?: QueueItem['images']; error?: string }>
  queueEdit(arg: QueueState | QueueEditOp): Promise<{ ok: boolean; error?: string; dropped?: QueueItem[] }>
  abort(expectedRuntime?: ExpectedRuntimeOwner): Promise<QueueSnapshot & { error?: string }>
  newSession(target?: { cwd?: string; projectId?: string; scope?: SessionScope }): Promise<{
    ok: boolean
    error?: string
    id?: string
    runId?: string
    sessionId?: string
    generation?: number
  }>
  switchSession(path: string): Promise<{ ok: boolean; error?: string }>
  moveSession(sessionId: string, projectId: string | null, cwd?: string): Promise<{
    ok: boolean
    error?: string
    entry?: SessionLayoutEntry
    cwdChanged?: boolean
  }>

  setSessionArchived(sessionId: string, archived: boolean): Promise<{ ok: boolean; error?: string }>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<{ ok: boolean; error?: string }>
  nativeSession(request: import('./native-session-host').NativeSessionHostRequest): Promise<import('./native-session-host').NativeSessionHostResult>
  compact(customInstructions?: string): Promise<{ ok: boolean; error?: string }>
  compactionInfo(cwd: string, contextWindow: number): Promise<CompactionInfo | null>
  renameSession(name: string, sessionId?: string): Promise<{ ok: boolean; error?: string }>

  fork(entryId: string, expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string; text?: string }>
  clone(): Promise<{ ok: boolean; error?: string }>
  forkPoints(): Promise<ForkPoint[]>
  exportHtml(outputPath?: string, expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; path?: string; error?: string }>
  deleteSession(path: string): Promise<{ ok: boolean; undoToken?: string; error?: string }>
  restoreSession(undoToken: string): Promise<{ ok: boolean; error?: string }>
  listArtifactLibrary(): Promise<ArtifactLibraryResult>
  saveInlineArtifact(input: SaveInlineArtifactInput): Promise<SaveInlineArtifactResult>

  runBash(command: string, options?: { excludeFromContext?: boolean }, expectedRuntime?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
  abortBash(): Promise<void>

  listModels(): Promise<ModelInfo[]>
  setModel(provider: string, modelId: string, expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
  setThinking(level: string, expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
  setUltracode(on: boolean, expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
  listThinkingLevels(): Promise<string[]>

  setAutoCompaction(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  setAutoRetry(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  piRuntimePrefs(): Promise<PiRuntimePrefs>
  piNativeSettings(): Promise<PiNativeSettingsResult>
  setPiNativeSettings(patch: Partial<PiNativeSettings>): Promise<PiNativeSettingsResult>

  answerApproval(id: string, choice: ApprovalChoice, identity?: ApprovalAnswerIdentity, feedback?: string): Promise<{ ok: boolean }>
  pendingApprovals(): Promise<ApprovalRequest[]>
  setSteeringMode(mode: QueueMode): Promise<{ ok: boolean; error?: string }>
  setFollowUpMode(mode: QueueMode): Promise<{ ok: boolean; error?: string }>

  abortRetry(): Promise<{ ok: boolean; error?: string }>
  cycleModel(expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string; to?: string }>
  cycleModelBack(expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string; to?: string }>
  cycleThinking(expected?: ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string; to?: string }>
  lastAssistantText(): Promise<string | null>

  piInfo(): Promise<PiInfo>
  redetectPi(): Promise<PiInfo>

  listCommands(): Promise<SlashCommand[]>

  getState(): Promise<SessionState | null>
  agentStatus(): Promise<{ state: 'starting' | 'ready' | 'exited' | 'error'; detail: string }>
  getMessages(): Promise<UIMessage[]>
  getStats(): Promise<SessionStats | null>
  cachedTitles(): Promise<Record<string, string>>
  manualTitles(): Promise<Record<string, string>>
  setManualTitle(sessionId: string, name: string): Promise<{ ok: boolean; error?: string }>
  regenerateTitle(sessionId: string): Promise<{ ok: boolean; title?: string; error?: string }>
  refreshTodos(): Promise<SessionTodo[]>

  listSessions(): Promise<SessionSummary[]>
  checkpoints: {
    list(): Promise<CheckpointRecord[]>
    preview(recordId: string): Promise<CheckpointPreview>
    restore(recordId: string): Promise<CheckpointRestoreResult>
    undo(undoId: string): Promise<CheckpointRestoreResult>
    assess(cwd: string): Promise<WorkspaceFit | null>
  }
  searchSessions(query: string, limit?: number): Promise<SessionSearchResult>
  usageStats(range: UsageRange): Promise<UsageStatsResult>

  peekSession(path: string): Promise<PeekResult | null>

  authProviders(deep?: boolean): Promise<AuthProviderInfo[]>
  codexLogin(): Promise<CodexLoginResult>
  codexLoginCancel(): Promise<void>
  oauthAccounts(): Promise<OAuthAccountPools>
  oauthAccountSwitch(provider: string, key: string): Promise<{ ok: boolean; error?: string }>
  oauthAccountRemove(provider: string, key: string): Promise<{ ok: boolean; wasActive: boolean; error?: string }>
  oauthAccountRename(provider: string, key: string, label: string): Promise<{ ok: boolean; error?: string }>
  oauthLogin(provider: string): Promise<OAuthLoginResult>
  oauthLoginAnswer(provider: string, promptId: number, value: string): Promise<boolean>
  oauthLoginCancel(provider: string): Promise<void>
  onOAuthEvent(cb: (event: OAuthLoginEvent) => void): () => void
  setApiKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }>
  clearAuth(provider: string): Promise<{ ok: boolean; error?: string }>
  apiKeys(): Promise<ApiKeyPools>
  addApiKey(provider: string, key: string, label?: string): Promise<{ ok: boolean; error?: string }>
  switchApiKey(provider: string, id: string): Promise<{ ok: boolean; error?: string }>
  renameApiKey(provider: string, id: string, label: string): Promise<{ ok: boolean; error?: string }>
  removeApiKey(provider: string, id: string): Promise<{ ok: boolean; wasActive: boolean; error?: string }>
  authFileInfo(): Promise<{ path: string; exists: boolean; count: number }>
  accountQuota(): Promise<AccountQuotaReport>
  codexAccounts(): Promise<CodexAccountView[]>
  codexAccountSwitch(key: string): Promise<{ ok: boolean; error?: string }>
  codexAccountRemove(key: string): Promise<{ ok: boolean; wasActive: boolean; error?: string }>
  toolchainStatus(): Promise<ToolchainStatus>
  gitRuntimeStatus(): Promise<GitRuntimeStatus>
  gitRuntimeInstall(): Promise<{ ok: boolean; error?: string }>
  gitRuntimeCancel(): Promise<void>
  gitRuntimeRemove(): Promise<void>
  customProviders(): Promise<CustomProviderView[]>
  opencodeProxy: import('./opencode-proxy').OpenCodeProxyBridge
  desktopPet: import('./desktop-pet').DesktopPetBridge
  saveCustomProvider(input: CustomProviderInput): Promise<CustomProviderResult>
  removeCustomProvider(id: string): Promise<CustomProviderResult>
  discoverCustomModels(input: Partial<CustomProviderInput>): Promise<CustomProviderDiscoverResult>
  detectLocalModels(): Promise<LocalModelServer[]>
  testCustomProvider(
    id: string,
    mode: 'endpoint' | 'billable',
    modelId?: string
  ): Promise<CustomProviderTestResult>

  completePath(prefix: string, cwd?: string, context?: FileRequestContext): Promise<PathCompletionResult>

  pickImages(): Promise<Attachment[]>
  pickFilePaths(): Promise<string[]>

  getSettings(): Promise<AppSettings>
  patchSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  removeGuardAllowRoot(path: string): Promise<AppSettings>
  changeProjectDirectory(request: ProjectDirectoryChange): Promise<ProjectDirectoryResult>
  pickCwd(): Promise<string | null>
  setCwd(cwd: string): Promise<{ ok: boolean; cwd?: string; error?: string }>

  respondUi(res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void
  extendUi(id: string, extraMs?: number): Promise<{ ok: boolean; timeout?: number; deadline?: number; error?: string }>
  startUiTimer(id: string): Promise<{ ok: boolean; timeout?: number; deadline?: number; error?: string }>

  notifyAttention(n: AttentionNotify): Promise<{ shown: boolean; simulated?: boolean; error?: string }>

  openPath(p: string): Promise<{ ok: boolean; error?: string }>
  revealPath(p: string): Promise<{ ok: boolean }>
  exportHtmlImage(p: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  copyImage(dataUrl: string): Promise<{ ok: boolean; error?: string }>
  saveImage(dataUrl: string, suggestedName?: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  backup(action: import('./data-backup').BackupAction): Promise<import('./data-backup').BackupResult>
  storage: {
    info(): Promise<StorageInfoView>
    pick(): Promise<string | null>
    schedule(target: string, relaunch?: boolean): Promise<{ ok: boolean; error?: string }>
    cancel(): Promise<void>
  }

  readonly isProbe: boolean

  win: {
    minimize(): void
    maximize(): void
    close(): void
    setAlwaysOnTop(v: boolean): Promise<boolean>
    requestExit(): Promise<{
      action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting'
    }>
    lifecycle(): Promise<{ tray: boolean; visible: boolean; quitting: boolean }>
  }

  onPush(cb: (msg: MainPush) => void): () => void
  onFilesChanged(cb: (payload: { watchId: string; dir: string }) => void): () => void
  onHotkey(cb: (action: 'cycleModel' | 'cycleModelBack' | 'cycleThinking') => void): () => void
  onDeepLink(cb: (intent: DeepLinkIntent) => void): () => void
  setHotkeyGuard(paused: boolean): void
  setMotionPreference(reduced: boolean): void
  getZoom(): Promise<ZoomState>
  setUiScale(v: number): Promise<ZoomState>
  listDir(rel: string, showHidden?: boolean, context?: FileRequestContext): Promise<DirListing>
  pathForFile(file: File): string
  describeFiles(paths: string[]): Promise<FileRefInfo[]>
  readFileText(path: string): Promise<FileTextResult>
  readPreview(path: string, line?: number, cwd?: string, lineEnd?: number): Promise<FilePreview>
  readPreviewBytes(path: string, cwd?: string): Promise<PreviewBytes>
  prepareHtmlArtifact(path: string, cwd?: string): Promise<HtmlArtifactPreviewResult>
  releaseHtmlArtifact(url: string): Promise<void>
  prepareHtmlWidget(html: string): Promise<HtmlArtifactPreviewResult>
  statPreview(path: string, cwd?: string): Promise<{ ok: boolean; abs: string; mtimeMs: number; size: number; error?: string }>
  watchDirs(watchId: string, dirs: string[], context: FileRequestContext): Promise<{ dirs: string[]; dropped: string[] }>
  searchFiles(request: FileSearchRequest): Promise<FileSearchResult>
  searchFileContents(request: FileContentSearchRequest): Promise<FileContentSearchResult>
  readEditableFile(path: string, cwd?: string): Promise<EditableFileView>
  writeEditableFile(path: string, text: string, expectedHash: string | null, cwd?: string): Promise<EditableFileWriteResult>
  reportUnsavedFiles(paths: string[]): Promise<number>
  searchFileNames(request: FileNameSearchRequest): Promise<FileNameSearchResult>
  trust: {
    status(cwd?: string): Promise<TrustStatusView>
    allow(cwd?: string): Promise<{ ok: boolean; entry: string; error?: string }>
    revoke(cwd?: string): Promise<{ ok: boolean; entry: string; error?: string }>
  }
  providerQuota(provider: string, monthlyBudget?: number): Promise<ProviderQuota>

  attachments: {
    usage(): Promise<AttachmentUsage>
    prune(): Promise<AttachmentPruneResult>
  }

  canvas: {
    capture(rect: CanvasCaptureRect, scope?: CanvasCaptureRect): Promise<CanvasCaptureResult>
  }

  htmlEdit: {
    apply(request: HtmlEditRequest): Promise<HtmlEditResult>
    undo(request: HtmlEditUndoRequest): Promise<HtmlEditResult>
  }

  videoExport: VideoExportBridge

  subagents: SubagentBridge
  schedule: ScheduleBridge

  sources: SourcesBridge
  searchOps: SearchOpsBridge
  packages: PackagesBridge
  builtinCapabilities: BuiltinCapabilitiesBridge
  search: {
    doctor(): Promise<SearchBackendStatus>
    installBackend(): Promise<{ ok: boolean; needsNode?: boolean; error?: string; log?: string }>
    apiConfig(): Promise<SearchApiConfigView>
    setApiKey(provider: SearchProviderId, key: string): Promise<{ ok: boolean; error?: string }>
    clearApiKey(provider: SearchProviderId): Promise<{ ok: boolean; error?: string }>
    setApiHintDismissed(dismissed: boolean): Promise<void>
  }
  computerUse: {
    status(): Promise<ComputerUseStatusView>
    installUv(): Promise<ComputerUseActionResult>
    resolveInteraction(): Promise<ComputerUseStatusView>
    set(enabled: boolean): Promise<ComputerUseActionResult>
  }
  capabilities: CapabilitiesBridge
  mcpApp: McpAppBridge
  mcpApps: McpAppViewApi
  git: GitBridge

  browser: {
    getState(): Promise<BrowserState>
    open(url?: string): Promise<BrowserState>
    observe(): Promise<BrowserObservation>
    network(): Promise<BrowserNetworkSnapshot>
    newTab(url?: string): Promise<BrowserState>
    switchTab(id: string): Promise<BrowserState>
    closeTab(id?: string): Promise<BrowserState>
    close(): Promise<BrowserState>
    navigate(url: string): Promise<{ ok: boolean; error?: string }>
    siteAccess(sessionId: string, url: string): Promise<{ decision: 'allow' | 'deny' | 'forbidden' | 'invalid' }>
    remoteImage(sessionId: string, url: string, prompt: boolean): Promise<RemoteImageResult>
    allowedSites(): Promise<string[]>
    addAllowedSite(value: string): Promise<{ result: BrowserSiteAddResult; list: string[]; origin?: string }>
    removeAllowedSite(value: string): Promise<{ removed: boolean; list: string[] }>
    clearAllowedSites(): Promise<string[]>
    siteAskAnswer(id: string, allowed: boolean): Promise<void>
    back(): Promise<{ ok: boolean; error?: string }>
    forward(): Promise<{ ok: boolean; error?: string }>
    reload(): Promise<{ ok: boolean; error?: string }>
    openExternal(url?: string): Promise<{ ok: boolean; error?: string }>
    releaseUserControl(): Promise<BrowserState>
    openExternalChrome(url?: string): Promise<{ ok: boolean; error?: string }>
    closeExternalChrome(): Promise<BrowserState>
    syncLocalProfile(): Promise<ChromeSyncReport>
    syncPageStorage(): Promise<ChromeSyncReport>
    setPermission(permission: string, origin: string, allowed: boolean): Promise<{ ok: boolean; error?: string }>
    setBounds(bounds: BrowserBounds): Promise<void>
    setVisible(visible: boolean): Promise<void>
  }
  office: {
    preview(path: string, cwd?: string): Promise<import('./office').OfficeDocumentView>
  }
  collab: import('./collab').CollabBridge
  peer: {
    hostPending(): Promise<import('./peer-protocol').PeerApprovalRequest[]>
    hostDecide(decision: import('./peer-protocol').PeerApprovalDecision): Promise<boolean>
    hostRevoke(connectionId: string): Promise<boolean>
    status(): Promise<import('./peer-protocol').PeerStatusView>
    pair(address: string, code: string): Promise<PeerResult<import('./peer-protocol').PeerRecordView>>
    remove(peerId: string): Promise<boolean>
    connect(peerId: string, operations: import('./peer-protocol').PeerOperation[], note: string): Promise<PeerResult<import('./peer-protocol').PeerGrantView>>
    disconnect(peerId: string): Promise<void>
    sessions(peerId: string): Promise<PeerResult<{ projects: import('./peer-protocol').PeerProjectRef[]; sessions: PeerSessionRow[] }>>
    history(peerId: string, sessionId: string, before?: string): Promise<PeerResult<{ messages: PeerHistoryMessage[]; hasMore?: boolean; nextBefore?: string }>>
    send(peerId: string, sessionId: string, text: string): Promise<PeerResult<unknown>>
    startSession(peerId: string, projectId: string, text: string): Promise<PeerResult<{ sessionId: string | null; runId: string; projectId: string }>>
    abort(peerId: string, runId: string): Promise<PeerResult<unknown>>
    importSession(peerId: string, sessionId: string): Promise<PeerResult<import('./peer-protocol').PeerImportView>>
  }

  voice: {
    prepare(): Promise<{ ok: boolean; error?: string }>
    status(): Promise<import('./voice-input').VoiceInputStatus>
    plan(
      target: import('./voice-input').VoiceDownloadPlan['target']
    ): Promise<{ ok: true; plan: import('./voice-input').VoiceDownloadPlan } | { ok: false; error: string }>
    download(planId: string): Promise<{ ok: boolean; error?: string }>
    cancel(): Promise<void>
    pick(kind: 'binary' | 'model'): Promise<import('./voice-input').VoiceInputStatus | null>
    transcribe(wav: Uint8Array, language?: import('./voice-input').VoiceLanguage): Promise<import('./voice-input').VoiceTranscribeResult>
  }

  remote: {
    status(): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    configure(settings: import('./remote-protocol').RemoteAccessSettings): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    pair(): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    cancelPairing(): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    revoke(deviceId: string): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    forget(deviceId: string): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    relayPair(kind: 'phone'): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    relayCancel(): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    relayRevoke(id: string): Promise<import('./remote-protocol').RemoteAccessStatus | null>
    relayForget(id: string): Promise<import('./remote-protocol').RemoteAccessStatus | null>
  }

  terminal: {
    available(): Promise<TerminalAvailability>
    list(): Promise<TerminalSnapshot[]>
    start(request?: TerminalStartRequest): Promise<TerminalSnapshot | null>
    write(id: string, data: string): Promise<boolean>
    resize(id: string, cols: number, rows: number): Promise<boolean>
    kill(id: string): Promise<boolean>
    attach(id: string): Promise<TerminalSnapshot | null>
    clear(id: string): Promise<boolean>
  }
}

export interface ZoomState {
  uiScale: number
  effective: number
  scaleFactor: number
  autoScale: number
}

export interface DirEntryLink {
  state: 'ok' | 'external' | 'dangling' | 'cycle'
  target?: string
  targetKind?: 'dir' | 'file'
}

export interface DirEntry {  name: string
  dir: boolean
  size?: number
  link?: DirEntryLink
}

export interface FileRequestContext {
  cwd: string
  projectId?: string
  generation: number
}

export type FileListingStatus = 'ok' | 'empty' | 'missing' | 'permission' | 'invalid' | 'error'

export interface PathCompletionResult {
  paths: string[]
  truncated: boolean
  status: FileListingStatus
  request?: FileRequestContext
}

export interface FileSearchRequest extends FileRequestContext {
  requestId: string
  query: string
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

export type EditableFileError = 'missing' | 'binary' | 'encoding' | 'too-large' | 'denied' | 'permission' | 'error'

export interface EditableFileView {
  ok: boolean
  abs: string
  name: string
  text: string
  hash: string
  size: number
  mtimeMs: number
  error?: EditableFileError
}

export interface EditableFileWriteResult {
  status: 'saved' | 'conflict' | 'denied' | 'failed'
  hash?: string
  currentHash?: string
  error?: string
}

export interface FileContentSearchRequest extends FileRequestContext {
  requestId: string
  query: string
  limit?: number
  matchCase?: boolean
  wholeWord?: boolean
  regexp?: boolean
}

export interface FileContentHit {
  path: string
  name: string
  line: number
  text: string
  column?: number
  ranges?: Array<[number, number]>
}

export type FileContentTruncation = 'result-limit' | 'scan-limit' | 'timeout' | 'long-line'

export interface FileContentSearchResult {
  request: FileContentSearchRequest
  hits: FileContentHit[]
  status: FileListingStatus | 'partial' | 'cancelled' | 'pattern'
  truncated: boolean
  truncation?: FileContentTruncation[]
  scannedFiles: number
  skippedFiles: number
}

export interface DirListing {
  path: string
  abs: string
  entries: DirEntry[]
  skipped: string[]
  truncated: boolean
  status?: FileListingStatus
  error?: string
  totalEntries?: number
  request?: FileRequestContext
  rootName?: string
}

export type FileRefKind = 'text' | 'image' | 'pdf' | 'binary' | 'other'

export interface FileRefInfo {
  ok: boolean
  input: string
  path: string
  name: string
  size: number
  mimeType: string
  kind: FileRefKind
  isDirectory?: boolean
  error?: string
}

export interface FileTextResult {
  ok: boolean
  text?: string
  truncated?: boolean
  size?: number
  error?: string
}

export interface FileSnapshotSide {
  exists: boolean
  size: number
  hash?: string
  tooLarge?: boolean
}

export interface FileDiff {
  path: string
  before: FileSnapshotSide
  after: FileSnapshotSide
  added: number
  removed: number
  patch: string
  status: 'created' | 'deleted' | 'modified' | 'unchanged' | 'unknown'
}

export interface WorkspaceChangeFile {
  path: string
  status: 'created' | 'deleted' | 'modified' | 'unknown'
  beforeSize: number
  afterSize: number
  added: number
  removed: number
  patch: string
}

export interface WorkspaceChanges {
  root: string
  files: WorkspaceChangeFile[]
  total: number
  scanned: number
  unknown?: 'concurrent' | 'truncated' | 'unreadable'
}

export interface FilePreview {
  ok: boolean
  path: string
  abs: string
  name: string
  size: number
  kind: FileRefKind
  text?: string
  truncated?: boolean
  totalLines?: number
  windowStart?: number
  windowEnd?: number
  mtimeMs?: number
  line?: number
  lineEnd?: number
  dir?: string
  error?: string
  issue?: FilePreviewIssue
  creatable?: boolean
  media?: FilePreviewMedia
  encoding?: FilePreviewEncoding
  outsideRoot?: boolean
}

export type RemoteImageResult =
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; code: 'needs-consent' | 'denied' | 'bad-url' | 'private-host' | 'not-image' | 'too-large' | 'http' | 'timeout' | 'network'; error?: string }

export interface PreviewBytes {
  ok: boolean
  abs: string
  name: string
  size: number
  mtimeMs?: number
  bytes?: Uint8Array
  error?: string
  issue?: FilePreviewIssue
}

export type FilePreviewIssue =
  | 'outside_root'
  | 'missing'
  | 'directory'
  | 'not_file'
  | 'invalid'
  | 'unreadable'
  | 'too_large'
  | 'binary'
  | 'media'
  | 'encoding'

export type FilePreviewMedia = 'image' | 'video' | 'audio' | 'pdf'

export type FilePreviewEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gb18030' | 'unknown'
