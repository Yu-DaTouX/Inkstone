import type { FileNameSearchResult } from '../shared/file-name-search'
import type { GitRemoteIdentity } from '../shared/git'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { MCP_APP_VIEW_CHANNELS } from '../shared/mcp-app-view'
import {
  CANVAS_CAPTURE_CHANNEL,
  HTML_EDIT_APPLY_CHANNEL,
  HTML_EDIT_UNDO_CHANNEL,
  SEARCH_OPS_READ_CHANNEL,
  SEARCH_SITE_ICON_CHANNEL,
  VIDEO_EXPORT_CANCEL_CHANNEL,
  VIDEO_EXPORT_PROGRESS_CHANNEL,
  VIDEO_EXPORT_START_CHANNEL
} from '../shared/ipc'
import type { HtmlArtifactPreviewResult } from '../shared/html-artifact-preview'
import type { ArtifactLibraryResult, SaveInlineArtifactResult } from '../shared/artifact-library'
import type {
  NativeMcpImportCommitResponse,
  NativeMcpImportPrepareResponse,
  NativeMcpServerListView
} from '../shared/mcp-native-import'
import type {
  McpAppOwnershipResponse,
  McpAppSwitchCommitResponse,
  McpAppSwitchPrepareResponse
} from '../shared/mcp-app-switch'
import type {
  McpAppViewAuditEntry,
  McpAppViewDescriptor,
  McpAppViewRefreshResult,
  McpAppViewSnapshot
} from '../shared/mcp-app-view'
import type {
  AppSettings,
  OAuthLoginEvent,
  OAuthLoginResult,
  ComputerUseStatusView,
  ComputerUseActionResult,
  StorageInfoView,
  AttachmentPruneResult,
  AttachmentUsage,
  BuiltinCapabilityView,
  CapabilitySettingsSnapshot,
  PromptTemplateDirectories,
  ManagedSkillAction,
  CapabilitySearchResultView,
  CapabilityVerificationStatus,
  PackageActionResultView,
  PackageListingView,
  SourceRefView,
  SourceLinkView,
  WebSearchOpView,
  Attachment,
  AttentionNotify,
  BrowserBounds,
  BrowserObservation,
  BrowserNetworkSnapshot,
  BrowserState,
  TerminalAvailability,
  TerminalProcessList,
  TerminalSnapshot,
  ChromeSyncReport,
  BrowserLoginImportStatus,
  AuthProviderInfo,
  CustomProviderResult,
  CustomProviderView,
  ToolchainStatus,
  GitRuntimeStatus,
  CustomProviderDiscoverResult,
  CodexLoginResult,
  TrustStatusView,
  DirListing,
  EditableFileView,
  EditableFileWriteResult,
  FileContentSearchResult,
  FileRequestContext,
  FileSearchResult,
  FilePreview,
  PreviewBytes,
  FileRefInfo,
  FileTextResult,
  ForkPoint,
  GitActionExpected,
  GitActionResult,
  GitChangesResult,
  GitDiffResult,
  GitRefOption,
  GitRepoState,
  MainPush,
  ModelInfo,
  WorktreeListing,
  PeekResult,
  PiInfo,
  PathCompletionResult,
  ProviderQuota,
  RunnerStatus,
  SessionLayoutEntry,
  SessionState,
  SessionStats,
  SessionSearchResult,
  UsageStatsResult,
  SessionSummary,
  SessionTodo,
  SubagentRun,
  SubagentStopResult,
  SlashCommand,
  UIMessage,
  ApprovalRequest,
  YanBridge,
  ZoomState,
  CustomProviderTestResult,
  LocalModelServer,
  PiRuntimePrefs,
  PiNativeSettingsResult,
  RemoteImageResult,
  VideoExportProgress
} from '../shared/ipc'
import type { DeepLinkIntent } from '../shared/ipc'
import type { ApiKeyPools } from '../shared/api-keys'
import type { DesktopPetResult, DesktopPetStatus } from '../shared/desktop-pet'
import type { RunSnapshot } from '../shared/runs'
import type { ProjectPackageScripts } from '../shared/project-scripts'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult, WorkspaceFit } from '../shared/checkpoints'
import type { RemoteAccessStatus } from '../shared/remote-protocol'
import type { OfficeDocumentView } from '../shared/office'
import type { VoiceDownloadPlan, VoiceInputStatus, VoiceTranscribeResult } from '../shared/voice-input'
import type { AndroidDevice, AndroidFrame, AndroidSdkStatus } from '../shared/android-sdk'
import type { SearchApiConfigView, SearchBackendStatus } from '../shared/search'
import type { AccountQuotaReport, CodexAccountView } from '../shared/account-quota'
import type { OAuthAccountPools } from '../shared/oauth-accounts'
import type { AuxPush, QuickAskSubmit } from '../main/windows/aux-types'
import type { LocalServerSnapshot } from '../shared/local-servers'
const invoke = <T>(ch: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(ch, ...args) as Promise<T>

let rendererReadySent = false

type Ok = { ok: boolean; error?: string }

const api: YanBridge = {
  probeMode: process.argv.includes('--yan-isolated-probe'),
  windowMaterial: (process.argv.find((a) => a.startsWith('--yan-window-material=')) ?? '').slice('--yan-window-material='.length),
  appUpdate: {
    status: () => invoke('yan:update:status'),
    check: () => invoke('yan:update:check'),
    automatic: (enabled) => invoke('yan:update:automatic', enabled),
    download: () => invoke('yan:update:download'),
    install: () => invoke('yan:update:install')
  },
  isProbe: !!process.env.YAN_PROBE,

  start: () =>
    invoke<{ ok: boolean; error?: string; state?: SessionState }>('yan:start'),
  send: (text, images, mode, expectedRuntime) => invoke<Ok>('yan:send', text, images, mode, expectedRuntime),
  steer: (text, expectedRuntime) => invoke<Ok>('yan:steer', text, expectedRuntime),
  followUp: (text) => invoke<Ok>('yan:followUp', text),
  steerQueued: (queueId) => invoke<Ok>('yan:steerQueued', queueId),
  removeQueued: (queueId) => invoke<Awaited<ReturnType<YanBridge['removeQueued']>>>('yan:removeQueued', queueId),
  queueEdit: (next) => invoke<Awaited<ReturnType<YanBridge['queueEdit']>>>('yan:queueEdit', next),
  abort: (expectedRuntime) => invoke<Awaited<ReturnType<YanBridge['abort']>>>('yan:abort', expectedRuntime),
  newSession: (target) =>
    invoke<Ok & { id?: string; runId?: string; sessionId?: string; generation?: number }>('yan:newSession', target),
  switchSession: (path) => invoke<Ok>('yan:switchSession', path),
  selectSession: (target) =>
    invoke<{
      ok: boolean
      id?: string
      runId?: string
      sessionId?: string
      generation?: number
      via?: 'hit' | 'reuse' | 'new'
      error?: string
    }>(
      'yan:selectSession',
      target
    ),
  moveSession: (sessionId, projectId, cwd) =>
    invoke<{ ok: boolean; error?: string; entry?: SessionLayoutEntry; cwdChanged?: boolean }>('yan:moveSession', sessionId, projectId, cwd),
  setSessionArchived: (sessionId, archived) => invoke<{ ok: boolean; error?: string }>('yan:setSessionArchived', sessionId, archived),
  setSessionPinned: (sessionId, pinned) => invoke<{ ok: boolean; error?: string }>('yan:setSessionPinned', sessionId, pinned),
  setSessionSnoozed: (sessionId, until) => invoke<{ ok: boolean; error?: string }>('yan:setSessionSnoozed', sessionId, until),
  setSessionMarkedUnread: (sessionId, marked) => invoke<{ ok: boolean; error?: string }>('yan:setSessionMarkedUnread', sessionId, marked),
  setVisibleRunnerSessions: (sessions) => invoke<boolean>('yan:setVisibleRunnerSessions', sessions),
  nativeSession: (request) => invoke<Awaited<ReturnType<YanBridge['nativeSession']>>>('yan:nativeSession', request),
  runnerStatuses: () => invoke<RunnerStatus[]>('yan:runnerStatuses'),
  mergeIsolation: (cwd) => invoke<Awaited<ReturnType<YanBridge['mergeIsolation']>>>('yan:mergeIsolation', cwd),
  stopRunner: (id) => invoke<boolean>('yan:stopRunner', id),
  runs: {
    snapshot: () => invoke<{ revision: number; runs: RunSnapshot[] }>('yan:runs:snapshot'),
    markSeen: (runId) => invoke<{ ok: boolean }>('yan:runs:markSeen', runId),
    history: (query) => invoke<Awaited<ReturnType<YanBridge['runs']['history']>>>('yan:runs:history', query),
    stop: (runId) => invoke<Awaited<ReturnType<YanBridge['runs']['stop']>>>('yan:runs:stop', runId)
  },
  sync: {
    status: () => invoke<Awaited<ReturnType<YanBridge['sync']['status']>>>('yan:sync:status'),
    configure: (root) => invoke<Awaited<ReturnType<YanBridge['sync']['configure']>>>('yan:sync:configure', root),
    setMode: (mode) => invoke<Awaited<ReturnType<YanBridge['sync']['setMode']>>>('yan:sync:setMode', mode),
    now: () => invoke<Awaited<ReturnType<YanBridge['sync']['now']>>>('yan:sync:now'),
    conflicts: () => invoke<Awaited<ReturnType<YanBridge['sync']['conflicts']>>>('yan:sync:conflicts'),
    resolve: (id, resolution) =>
      invoke<Awaited<ReturnType<YanBridge['sync']['resolve']>>>('yan:sync:resolve', id, resolution),
    exportSession: (sessionPath) =>
      invoke<Awaited<ReturnType<YanBridge['sync']['exportSession']>>>('yan:sync:exportSession', sessionPath),
    importSession: () => invoke<Awaited<ReturnType<YanBridge['sync']['importSession']>>>('yan:sync:importSession')
  },
  compact: (customInstructions) => invoke<Ok>('yan:compact', customInstructions),
  compactionInfo: (cwd, contextWindow) => invoke<Awaited<ReturnType<YanBridge['compactionInfo']>>>('yan:compactionInfo', cwd, contextWindow),
  renameSession: (name, sessionId) => invoke<Ok>('yan:renameSession', name, sessionId),
  fork: (entryId, expected) => invoke<{ ok: boolean; error?: string; text?: string }>('yan:fork', entryId, expected),
  clone: () => invoke<Ok>('yan:clone'),
  forkPoints: () => invoke<ForkPoint[]>('yan:forkPoints'),
  exportHtml: (outputPath, expected) => invoke<{ ok: boolean; path?: string; error?: string }>('yan:exportHtml', outputPath, expected),
  deleteSession: (path) => invoke<{ ok: boolean; undoToken?: string; error?: string }>('yan:deleteSession', path),
  restoreSession: (undoToken) => invoke<Ok>('yan:restoreSession', undoToken),
  listArtifactLibrary: () => invoke<ArtifactLibraryResult>('yan:listArtifactLibrary'),
  saveInlineArtifact: (input) => invoke<SaveInlineArtifactResult>('yan:saveInlineArtifact', input),

  runBash: (command, options, expectedRuntime) => invoke<Ok>('yan:runBash', command, options, expectedRuntime),
  abortBash: () => invoke<void>('yan:abortBash'),

  listModels: () => invoke<ModelInfo[]>('yan:listModels'),
  setModel: (provider, modelId, expected) => invoke<Ok>('yan:setModel', provider, modelId, expected),
  setThinking: (level, expected) => invoke<Ok>('yan:setThinking', level, expected),
  setUltracode: (on, expected) => invoke<Ok>('yan:setUltracode', on, expected),
  listThinkingLevels: () => invoke<string[]>('yan:listThinkingLevels'),
  listCommands: () => invoke<SlashCommand[]>('yan:listCommands'),

  setAutoCompaction: (enabled) => invoke<Ok>('yan:setAutoCompaction', enabled),
  setAutoRetry: (enabled) => invoke<Ok>('yan:setAutoRetry', enabled),
  piRuntimePrefs: () => invoke<PiRuntimePrefs>('yan:piRuntimePrefs'),
  piNativeSettings: () => invoke<PiNativeSettingsResult>('yan:piNativeSettings'),
  setPiNativeSettings: (patch) => invoke<PiNativeSettingsResult>('yan:setPiNativeSettings', patch),

  answerApproval: (id, choice, identity, feedback) => invoke<{ ok: boolean }>('yan:approvalAnswer', id, choice, identity, feedback),
  pendingApprovals: () => invoke<ApprovalRequest[]>('yan:approvalPending'),
  setSteeringMode: (mode) => invoke<Ok>('yan:setSteeringMode', mode),
  setFollowUpMode: (mode) => invoke<Ok>('yan:setFollowUpMode', mode),
  abortRetry: () => invoke<Ok>('yan:abortRetry'),
  cycleModel: (expected) => invoke<Ok>('yan:cycleModel', expected),
  cycleModelBack: (expected) => invoke<Ok>('yan:cycleModelBack', expected),
  cycleThinking: (expected) => invoke<Ok>('yan:cycleThinking', expected),
  lastAssistantText: () => invoke<string | null>('yan:lastAssistantText'),
  piInfo: () => invoke<PiInfo>('yan:piInfo'),
  redetectPi: () => invoke<PiInfo>('yan:redetectPi'),

  getState: () => invoke<SessionState | null>('yan:getState'),
  agentStatus: () =>
    invoke<{ state: 'starting' | 'ready' | 'exited' | 'error'; detail: string }>('yan:agentStatus'),
  getMessages: () => invoke<UIMessage[]>('yan:getMessages'),
  getStats: () => invoke<SessionStats | null>('yan:getStats'),
  cachedTitles: () => invoke<Record<string, string>>('yan:cachedTitles'),
  manualTitles: () => invoke<Record<string, string>>('yan:manualTitles'),
  setManualTitle: (sessionId, name) => invoke<{ ok: boolean; error?: string }>('yan:setManualTitle', sessionId, name),
  regenerateTitle: (sessionId) => invoke<{ ok: boolean; title?: string; error?: string }>('yan:regenerateTitle', sessionId),
  refreshTodos: () => invoke<SessionTodo[]>('yan:refreshTodos'),
  listSessions: () => invoke<SessionSummary[]>('yan:listSessions'),
  checkpoints: {
    list: () => invoke<CheckpointRecord[]>('yan:checkpoints:list'),
    preview: (recordId) => invoke<CheckpointPreview>('yan:checkpoints:preview', recordId),
    restore: (recordId) => invoke<CheckpointRestoreResult>('yan:checkpoints:restore', recordId),
    undo: (undoId) => invoke<CheckpointRestoreResult>('yan:checkpoints:undo', undoId),
    assess: (cwd) => invoke<WorkspaceFit | null>('yan:checkpoints:assess', cwd)
  },
  searchSessions: (query, limit) => invoke<SessionSearchResult>('yan:searchSessions', query, limit),
  usageStats: (range) => invoke<UsageStatsResult>('yan:usageStats', range),
  peekSession: (path, opts) => invoke<PeekResult | null>('yan:peekSession', path, opts),

  authProviders: (deep) => invoke<AuthProviderInfo[]>('yan:authProviders', deep),
  codexLogin: () => invoke<CodexLoginResult>('yan:codexLogin'),
  codexLoginCancel: () => invoke<void>('yan:codexLoginCancel'),
  oauthAccounts: () => invoke<OAuthAccountPools>('yan:oauthAccounts'),
  oauthAccountSwitch: (provider, key) => invoke<Ok>('yan:oauthAccountSwitch', provider, key),
  oauthAccountRemove: (provider, key) => invoke<Ok & { wasActive: boolean }>('yan:oauthAccountRemove', provider, key),
  oauthAccountRename: (provider, key, label) => invoke<Ok>('yan:oauthAccountRename', provider, key, label),
  oauthLogin: (provider) => invoke<OAuthLoginResult>('yan:oauthLogin', provider),
  oauthLoginAnswer: (provider, promptId, value) => invoke<boolean>('yan:oauthLoginAnswer', provider, promptId, value),
  oauthLoginCancel: (provider) => invoke<void>('yan:oauthLoginCancel', provider),
  onOAuthEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: OAuthLoginEvent): void => cb(ev)
    ipcRenderer.on('yan:oauth', listener)
    return () => {
      ipcRenderer.removeListener('yan:oauth', listener)
    }
  },
  setApiKey: (provider, key) => invoke<Ok>('yan:setApiKey', provider, key),
  clearAuth: (provider) => invoke<Ok>('yan:clearAuth', provider),
  apiKeys: () => invoke<ApiKeyPools>('yan:apiKeys'),
  addApiKey: (provider, key, label) => invoke<Ok>('yan:addApiKey', provider, key, label),
  switchApiKey: (provider, id) => invoke<Ok>('yan:switchApiKey', provider, id),
  renameApiKey: (provider, id, label) => invoke<Ok>('yan:renameApiKey', provider, id, label),
  removeApiKey: (provider, id) => invoke<Ok & { wasActive: boolean }>('yan:removeApiKey', provider, id),
  authFileInfo: () => invoke<{ path: string; exists: boolean; count: number }>('yan:authFileInfo'),
  accountQuota: () => invoke<AccountQuotaReport>('yan:accountQuota'),
  codexAccounts: () => invoke<CodexAccountView[]>('yan:codexAccounts'),
  codexAccountSwitch: (key) => invoke<Ok>('yan:codexAccountSwitch', key),
  codexAccountRemove: (key) => invoke<Ok & { wasActive: boolean }>('yan:codexAccountRemove', key),
  toolchainStatus: () => invoke<ToolchainStatus>('yan:toolchainStatus'),
  gitRuntimeStatus: () => invoke<GitRuntimeStatus>('yan:gitRuntimeStatus'),
  gitRuntimeInstall: () => invoke<{ ok: boolean; error?: string }>('yan:gitRuntimeInstall'),
  gitRuntimeCancel: () => invoke<void>('yan:gitRuntimeCancel'),
  gitRuntimeRemove: () => invoke<void>('yan:gitRuntimeRemove'),
  customProviders: () => invoke<CustomProviderView[]>('yan:customProviders'),
  plugins: {
    action: (id, action) => invoke('yan:plugins:action', id, action),
    invoke: (id, action, params) => invoke('yan:plugins:invoke', id, action, params)
  },
  desktopPet: {
    status: async () => {
      const result = await invoke<{ status?: DesktopPetStatus }>('yan:plugins:action', 'desktop-pet', 'status')
      return result.status ?? { installed: false, running: false, version: '', autoStart: false, model: null, installDir: '', edges: { state: 'idle', done: 0, total: 0 }, log: [] }
    },
    install: () => invoke<DesktopPetResult>('yan:plugins:action', 'desktop-pet', 'install'),
    start: () => invoke<DesktopPetResult>('yan:plugins:invoke', 'desktop-pet', 'start'),
    stop: () => invoke<DesktopPetResult>('yan:plugins:invoke', 'desktop-pet', 'stop'),
    uninstall: () => invoke<DesktopPetResult>('yan:plugins:action', 'desktop-pet', 'remove'),
    autoStart: (enabled) => invoke<DesktopPetResult>('yan:plugins:invoke', 'desktop-pet', 'autoStart', enabled),
    setModel: (model) => invoke<DesktopPetResult>('yan:plugins:invoke', 'desktop-pet', 'setModel', model)
  },
  saveCustomProvider: (input) => invoke<CustomProviderResult>('yan:saveCustomProvider', input),
  discoverCustomModels: (input) => invoke<CustomProviderDiscoverResult>('yan:discoverCustomModels', input),
  detectLocalModels: () => invoke<LocalModelServer[]>('yan:detectLocalModels'),
  removeCustomProvider: (id) => invoke<CustomProviderResult>('yan:removeCustomProvider', id),
  testCustomProvider: (id, mode, modelId) =>
    invoke<CustomProviderTestResult>('yan:testCustomProvider', id, mode, modelId),
  completePath: (prefix, cwd, context) => invoke<PathCompletionResult>('yan:completePath', prefix, cwd, context),

  pickImages: () => invoke<Attachment[]>('yan:pickImages'),
  pickFilePaths: () => invoke<string[]>('yan:pickFiles'),

  canvas: {
    capture: (rect, scope) => invoke<Awaited<ReturnType<YanBridge['canvas']['capture']>>>(CANVAS_CAPTURE_CHANNEL, rect, scope)
  },

  htmlEdit: {
    apply: (request) => invoke<Awaited<ReturnType<YanBridge['htmlEdit']['apply']>>>(HTML_EDIT_APPLY_CHANNEL, request),
    undo: (request) => invoke<Awaited<ReturnType<YanBridge['htmlEdit']['undo']>>>(HTML_EDIT_UNDO_CHANNEL, request)
  },

  videoExport: {
    start: (request) => invoke<Awaited<ReturnType<YanBridge['videoExport']['start']>>>(VIDEO_EXPORT_START_CHANNEL, request),
    cancel: (id) => invoke<boolean>(VIDEO_EXPORT_CANCEL_CHANNEL, id),
    onProgress: (cb): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: VideoExportProgress): void => {
        if (payload) cb(payload)
      }
      ipcRenderer.on(VIDEO_EXPORT_PROGRESS_CHANNEL, listener)
      return () => {
        ipcRenderer.removeListener(VIDEO_EXPORT_PROGRESS_CHANNEL, listener)
      }
    }
  },

  pathForFile: (file) => webUtils.getPathForFile(file),
  describeFiles: (paths) => invoke<FileRefInfo[]>('yan:describeFiles', paths),
  savePastedText: (text, name) => invoke<import('../shared/pasted-text').SavedPastedText>('yan:savePastedText', text, name),
  quoteSession: (path, title) => invoke<import('../shared/ipc').SessionQuoteResult>('yan:quoteSession', path, title),
  readFileText: (p) => invoke<FileTextResult>('yan:readFileText', p),
  readPreview: (p, line, cwd, lineEnd) => invoke<FilePreview>('yan:readPreview', p, line, cwd, lineEnd),
  readPreviewBytes: (p, cwd) => invoke<PreviewBytes>('yan:readPreviewBytes', p, cwd),
  prepareHtmlArtifact: (p, cwd) => invoke<HtmlArtifactPreviewResult>('yan:prepareHtmlArtifact', p, cwd),
  releaseHtmlArtifact: (url) => invoke<void>('yan:releaseHtmlArtifact', url),
  prepareHtmlWidget: (html) => invoke<HtmlArtifactPreviewResult>('yan:prepareHtmlWidget', html),
  statPreview: (p, cwd) =>
    invoke<{ ok: boolean; abs: string; mtimeMs: number; size: number; error?: string }>(
      'yan:statPreview',
      p,
      cwd
    ),

  schedule: {
    list: () => invoke('yan:schedule:list'),
    create: (input) => invoke('yan:schedule:create', input),
    update: (id, input) => invoke('yan:schedule:update', id, input),
    setEnabled: (id, enabled) => invoke('yan:schedule:enabled', id, enabled),
    remove: (id) => invoke('yan:schedule:remove', id),
    runNow: (id) => invoke('yan:schedule:run', id)
  },

  subagents: {
    list: () => invoke<SubagentRun[]>('yan:subagents:list'),
    get: (id) => invoke<SubagentRun | null>('yan:subagents:get', id),
    start: (task, model, isolation, expectedRuntime) =>
      invoke<{ ok: boolean; error?: string; run?: SubagentRun }>('yan:subagents:start', task, model, isolation, expectedRuntime),
    stop: (id) => invoke<SubagentStopResult>('yan:subagents:stop', id),
    send: (id, message) => invoke<{ ok: boolean; error?: string; delivery?: 'queued' | 'started' | 'resumed' }>('yan:subagents:send', id, message),
    dismiss: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:dismiss', id),
    stopAll: () => invoke<void>('yan:subagents:stopAll'),
    clearFinished: () => invoke<void>('yan:subagents:clear'),
    merge: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:merge', id),
    discard: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:discard', id)
  },

  sources: {
    list: (sessionId) => invoke<{ ok: boolean; images: SourceRefView[]; dir: string; links: SourceLinkView[]; error?: string }>('yan:sources:list', sessionId),
    addImage: (req) => invoke<SourceRefView | null>('yan:sources:addImage', req),
    verifyFiles: (req) => invoke<SourceRefView[]>('yan:sources:verifyFiles', req),
    link: (req) => invoke('yan:sources:link', req),
    removeImage: (req) => invoke('yan:sources:removeImage', req)
  },
  searchOps: {
    read: (operationId) => invoke<WebSearchOpView>(SEARCH_OPS_READ_CHANNEL, operationId),
    siteIcon: (url) => invoke<string | null>(SEARCH_SITE_ICON_CHANNEL, url)
  },
  packages: {
    search: (query, offset) => invoke('yan:packages:search', query, offset),
    catalog: (refresh) => invoke('yan:packages:catalog', refresh === true),
    exportPlugin: (id) => invoke('yan:packages:exportPlugin', id),
    addMcp: (id) => invoke('yan:packages:addMcp', id),
    minecraft: (action) => invoke('yan:packages:minecraft', action),
    codegraphStatus: (cwd) => invoke('yan:packages:codegraphStatus', cwd),
    codegraphIndex: (cwd) => invoke('yan:packages:codegraphIndex', cwd),
    anthropicEnv: () => invoke<string[]>('yan:packages:anthropicEnv'),
    list: (cwd) => invoke<PackageListingView>('yan:packages:list', cwd),
    action: (req) => invoke<PackageActionResultView>('yan:packages:action', req)
  },
  builtinCapabilities: {
    list: () => invoke<BuiltinCapabilityView[]>('yan:capabilities:builtin')
  },
  search: {
    doctor: () => invoke<SearchBackendStatus>('yan:search:doctor'),
    apiConfig: () => invoke<SearchApiConfigView>('yan:search:apiConfig'),
    setApiKey: (provider, key) => invoke<{ ok: boolean; error?: string }>('yan:search:setApiKey', provider, key),
    clearApiKey: (provider) => invoke<{ ok: boolean; error?: string }>('yan:search:clearApiKey', provider),
    setApiHintDismissed: (dismissed) => invoke<void>('yan:search:setApiHintDismissed', dismissed)
  },
  computerUse: {
    status: () => invoke<ComputerUseStatusView>('yan:computerUse:status'),
    installUv: () => invoke<ComputerUseActionResult>('yan:computerUse:installUv'),
    resolveInteraction: () => invoke<ComputerUseStatusView>('yan:computerUse:resolveInteraction'),
    set: (enabled: boolean) => invoke<ComputerUseActionResult>('yan:computerUse:set', enabled)
  },
  capabilities: {
    snapshot: () => invoke<CapabilitySettingsSnapshot>('yan:capabilities:settings'),
    promptDirectories: () => invoke<PromptTemplateDirectories>('yan:capabilities:promptDirectories'),
    openPromptDirectory: (path: string) => invoke<{ ok: boolean; error?: string }>('yan:capabilities:openPromptDirectory', path),
    createPromptTemplate: (input: { name: string; content: string }) =>
      invoke<{ ok: boolean; path?: string; error?: string }>('yan:capabilities:createPromptTemplate', input),
    discover: (queryText: string) => invoke<CapabilitySearchResultView>('yan:capabilities:discover', queryText),
    sessionSkill: (action: 'promote' | 'remove', name: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:sessionSkill', { action, name }),
    manageSkill: (action: ManagedSkillAction, scope: 'yan' | 'pi', dir: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:manageSkill', { action, scope, dir }),
    revealSkill: (location: string) => invoke<{ ok: boolean; error?: string }>('yan:capabilities:revealSkill', location),
    verify: (serverId: string) => invoke<{ ok: boolean; operationId?: string; error?: string }>('yan:capabilities:verify', serverId),
    verification: (operationId: string) =>
      invoke<CapabilityVerificationStatus | null>('yan:capabilities:verification', operationId),
    cancelVerification: (operationId: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:cancelVerification', operationId),
    prepareNativeImport: (serverId: string) =>
      invoke<NativeMcpImportPrepareResponse>('yan:capabilities:prepareNativeImport', serverId),
    commitNativeImport: (token: string) =>
      invoke<NativeMcpImportCommitResponse>('yan:capabilities:commitNativeImport', token),
    nativeServers: () => invoke<NativeMcpServerListView>('yan:capabilities:nativeMcpServers'),
    mcpServices: () => invoke('yan:capabilities:mcpServices'),
    changeMcpService: (input) => invoke('yan:capabilities:changeMcpService', input),
    applyMcpServices: (input) => invoke('yan:capabilities:applyMcpServices', input),
    manageNativeServer: (action: 'enable' | 'disable' | 'remove', name: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:manageNativeMcpServer', { action, name })
  },
  mcpApp: {
    ownership: () => invoke<McpAppOwnershipResponse>('yan:mcpApp:ownership'),
    prepareSwitch: (serverId: string) =>
      invoke<McpAppSwitchPrepareResponse>('yan:mcpApp:prepareSwitch', serverId),
    commitSwitch: (token: string) => invoke<McpAppSwitchCommitResponse>('yan:mcpApp:commitSwitch', token)
  },
  mcpApps: {
    prepare: (callId: string) => invoke<McpAppViewDescriptor>(MCP_APP_VIEW_CHANNELS.prepare, callId),
    dispatch: (instanceId: string, message: unknown) =>
      invoke<unknown>(MCP_APP_VIEW_CHANNELS.dispatch, instanceId, message),
    release: (instanceId: string) => invoke<{ ok: boolean }>(MCP_APP_VIEW_CHANNELS.release, instanceId),
    audit: (callId: string) => invoke<McpAppViewAuditEntry[]>(MCP_APP_VIEW_CHANNELS.audit, callId),
    snapshot: () => invoke<McpAppViewSnapshot>(MCP_APP_VIEW_CHANNELS.snapshot),
    refresh: () => invoke<McpAppViewRefreshResult>(MCP_APP_VIEW_CHANNELS.refresh),
    hostContext: (instanceId: string) => invoke<unknown | null>(MCP_APP_VIEW_CHANNELS.hostContext, instanceId)
  },
  git: {
    state: (cwd) =>
      invoke<{ repo: GitRepoState | null; expected?: GitActionExpected; error?: string }>('yan:git:state', cwd),
    refs: (cwd) =>
      invoke<{ ok: boolean; refs: GitRefOption[]; busyBranches: string[]; error?: string }>('yan:git:refs', cwd),
    action: (req) => invoke<GitActionResult>('yan:git:action', req),
    remotes: (cwd) => invoke<string[]>('yan:git:remotes', cwd),
    untracked: (cwd) => invoke<string[]>('yan:git:untracked', cwd),
    changes: (cwd, options) => invoke<GitChangesResult>('yan:git:changes', cwd, options),
    screenPaths: (cwd, paths) => invoke<import('../shared/git').GitPathScreen>('yan:git:screenPaths', cwd, paths),
    identity: (cwd, refresh) => invoke<GitRemoteIdentity | null>('yan:git:identity', cwd, refresh === true),
    diff: (req) => invoke<GitDiffResult>('yan:git:diff', req),
    worktrees: (cwd) => invoke<WorktreeListing>('yan:git:worktrees', cwd)
  },
  github: {
    status: (cwd) => invoke<import('../shared/github').GithubStatus>('yan:github:status', cwd),
    createDefaults: (cwd) => invoke<import('../shared/github').GhPrCreateDefaultsResult>('yan:github:createDefaults', cwd),
    list: (cwd, options) => invoke<import('../shared/github').GhPrListResult>('yan:github:list', cwd, options),
    action: (cwd, request) => invoke<import('../shared/github').GhPrActionResult>('yan:github:action', cwd, request),
    candidates: (cwd, request) => invoke<import('../shared/github').GhPrCandidatesResult>('yan:github:candidates', cwd, request),
    detail: (cwd, number) => invoke<import('../shared/github').GhPrDetailResult>('yan:github:detail', cwd, number),
    diff: (cwd, number) => invoke<import('../shared/github').GhPrDiffResult>('yan:github:diff', cwd, number),
    openUrl: (url) => invoke<{ ok: boolean; error?: string }>('yan:github:openUrl', url),
    account: () => invoke<import('../shared/github').GithubAccountStatus>('yan:github:account'),
    repos: (request) => invoke<import('../shared/github').GithubRepoListResult>('yan:github:repos', request),
    searchRepos: (query) => invoke<import('../shared/github').GithubRepoListResult>('yan:github:searchRepos', query),
    clone: (request) => invoke<import('../shared/github').GithubCloneResult>('yan:github:clone', request),
    cancelClone: (id) => invoke<{ ok: boolean }>('yan:github:cancelClone', id),
    createProject: (name, parentDir) => invoke<import('../shared/github').GithubCreateProjectResult>('yan:github:createProject', name, parentDir),
    branches: (cwd) => invoke<import('../shared/github').GithubBranchListResult>('yan:github:branches', cwd),
    publishPeerBranch: (cwd, request) => invoke<import('../shared/github').GhPrActionResult>('yan:github:publishPeerBranch', cwd, request),
    defaultCloneDir: () => invoke<string>('yan:github:defaultCloneDir')
  },

  getSettings: () => invoke<AppSettings>('yan:getSettings'),
  patchSettings: (patch) => invoke<AppSettings>('yan:patchSettings', patch),
  removeGuardAllowRoot: (path) => invoke<AppSettings>('yan:removeGuardAllowRoot', path),
  changeProjectDirectory: (request) => invoke<import('../shared/ipc').ProjectDirectoryResult>('yan:project:changeDirectory', request),
  pickCwd: () => invoke<string | null>('yan:pickCwd'),
  setCwd: (cwd) => invoke<Ok>('yan:setCwd', cwd),
  workFolderRoot: () => invoke<string>('yan:workFolderRoot'),
  createWorkFolder: (name) => invoke<{ ok: boolean; cwd?: string; error?: string }>('yan:createWorkFolder', name),

  respondUi: (res) => ipcRenderer.send('yan:respondUi', res),
  extendUi: (id, extraMs) => invoke('yan:extendUi', id, extraMs),
  startUiTimer: (id) => invoke('yan:startUiTimer', id),

  notifyAttention: (n: AttentionNotify) =>
    invoke<{ shown: boolean; simulated?: boolean; error?: string }>('yan:notifyAttention', n),

  openPath: (p) => invoke<{ ok: boolean; error?: string }>('yan:openPath', p),
  backup: (action) => invoke<import('../shared/data-backup').BackupResult>('yan:backup', action),
  storage: {
    info: () => invoke<StorageInfoView>('yan:storage:info'),
    pick: () => invoke<string | null>('yan:storage:pick'),
    schedule: (target, relaunch) => invoke<{ ok: boolean; error?: string }>('yan:storage:schedule', target, relaunch),
    cancel: () => invoke<void>('yan:storage:cancel')
  },
  revealPath: (p) => invoke<{ ok: boolean }>('yan:revealPath', p),
  exportHtmlImage: (p) => invoke<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>('yan:exportHtmlImage', p),
  copyImage: (dataUrl) => invoke<{ ok: boolean; error?: string }>('yan:image:copy', dataUrl),
  saveImage: (dataUrl, suggestedName) => invoke<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>('yan:image:save', dataUrl, suggestedName),

  getZoom: () => invoke<ZoomState>('yan:getZoom'),
  setUiScale: (v) => invoke<ZoomState>('yan:setUiScale', v),

  listDir: (rel, showHidden, context?: FileRequestContext) => invoke<DirListing>('yan:listDir', rel, showHidden === true, context),
  watchDirs: (watchId, dirs, context) => invoke<{ dirs: string[]; dropped: string[] }>('yan:files:watch', watchId, dirs, context),
  searchFiles: (request) => invoke<FileSearchResult>('yan:searchFiles', request),
  searchFileContents: (request) => invoke<FileContentSearchResult>('yan:searchFileContents', request),
  readEditableFile: (path, cwd) => invoke<EditableFileView>('yan:readEditableFile', path, cwd),
  writeEditableFile: (path, text, expectedHash, cwd) =>
    invoke<EditableFileWriteResult>('yan:writeEditableFile', path, text, expectedHash, cwd),
  reportUnsavedFiles: (paths) => invoke<number>('yan:files:unsaved', paths),
  searchFileNames: (request) => invoke<FileNameSearchResult>('yan:files:searchNames', request),
  trust: {
    status: (cwd?: string) => invoke<TrustStatusView>('yan:trust:status', cwd),
    allow: (cwd?: string) => invoke<{ ok: boolean; entry: string; error?: string }>('yan:trust:allow', cwd),
    revoke: (cwd?: string) => invoke<{ ok: boolean; entry: string; error?: string }>('yan:trust:revoke', cwd)
  },
  providerQuota: (provider, monthlyBudget) => invoke<ProviderQuota>('yan:providerQuota', provider, monthlyBudget),

  attachments: {
    usage: () => invoke<AttachmentUsage>('yan:attachments:usage'),
    prune: () => invoke<AttachmentPruneResult>('yan:attachments:prune')
  },

  browser: {
    activateSession: (sessionId) => invoke<BrowserState>('yan:browser:activateSession', sessionId),
    install: () => invoke<void>('yan:browser:install'),
    getState: (sessionId) => invoke<BrowserState>('yan:browser:getState', sessionId),
    open: (url, sessionId) => invoke<BrowserState>('yan:browser:open', url, sessionId),
    observe: () => invoke<BrowserObservation>('yan:browser:observe'),
    network: () => invoke<BrowserNetworkSnapshot>('yan:browser:network'),
    newTab: (url, sessionId) => invoke<BrowserState>('yan:browser:newTab', url, sessionId),
    switchTab: (id, sessionId) => invoke<BrowserState>('yan:browser:switchTab', id, sessionId),
    closeTab: (id, sessionId) => invoke<BrowserState>('yan:browser:closeTab', id, sessionId),
    close: (sessionId) => invoke<BrowserState>('yan:browser:close', sessionId),
    navigate: (url, sessionId) => invoke<Ok>('yan:browser:navigate', url, sessionId),
    siteAccess: (sessionId, url) => invoke<{ decision: 'allow' | 'deny' | 'forbidden' | 'invalid' }>('yan:browser:siteAccess', sessionId, url),
    remoteImage: (sessionId, url, prompt) => invoke<RemoteImageResult>('yan:browser:remoteImage', sessionId, url, prompt),
    allowedSites: () => invoke<string[]>('yan:browser:allowedSites'),
    addAllowedSite: (value) =>
      invoke<{ result: 'ok' | 'invalid' | 'exists' | 'blocked' | 'unavailable'; list: string[]; origin?: string }>(
        'yan:browser:addAllowedSite',
        value
      ),
    removeAllowedSite: (value) => invoke<{ removed: boolean; list: string[] }>('yan:browser:removeAllowedSite', value),
    clearAllowedSites: () => invoke<string[]>('yan:browser:clearAllowedSites'),
    siteAskAnswer: (id, allowed) => invoke<void>('yan:browser:siteAskAnswer', id, allowed),
    back: (sessionId) => invoke<Ok>('yan:browser:back', sessionId),
    forward: (sessionId) => invoke<Ok>('yan:browser:forward', sessionId),
    reload: (sessionId) => invoke<Ok>('yan:browser:reload', sessionId),
    openExternal: (url, sessionId) => invoke<Ok>('yan:browser:openExternal', url, sessionId),
    releaseUserControl: (sessionId) => invoke<BrowserState>('yan:browser:releaseUserControl', sessionId),
    openExternalChrome: (url) => invoke<Ok>('yan:browser:openExternalChrome', url),
    closeExternalChrome: () => invoke<BrowserState>('yan:browser:closeExternalChrome'),
    syncLocalProfile: () => invoke<ChromeSyncReport>('yan:browser:syncLocalProfile'),
    syncPageStorage: () => invoke<ChromeSyncReport>('yan:browser:syncPageStorage'),
    startLoginImport: () => invoke<{ id: string }>('yan:browser:startLoginImport'),
    loginImportStatus: (id) => invoke<BrowserLoginImportStatus>('yan:browser:loginImportStatus', id),
    cancelLoginImport: (id) => invoke<BrowserLoginImportStatus>('yan:browser:cancelLoginImport', id),
    setPermission: (permission, origin, allowed) =>
      invoke<{ ok: boolean; error?: string }>('yan:browser:setPermission', permission, origin, allowed),
    setBounds: (bounds: BrowserBounds) => invoke<void>('yan:browser:setBounds', bounds),
    setVisible: (visible: boolean) => invoke<void>('yan:browser:setVisible', visible),
    localServers: () => invoke<LocalServerSnapshot>('yan:browser:localServers')
  },

  office: {
    preview: (path, cwd) => invoke<OfficeDocumentView>('yan:office:preview', path, cwd)
  },

  peer: {
    hostPending: () => invoke('yan:peer-host:pending'),
    hostDecide: (decision) => invoke('yan:peer-host:decide', decision),
    hostRevoke: (connectionId) => invoke('yan:peer-host:revoke', connectionId),
    status: () => invoke('yan:peer:status'),
    pair: (address, code) => invoke('yan:peer:pair', address, code),
    remove: (peerId) => invoke('yan:peer:remove', peerId),
    connect: (peerId, operations, note) => invoke('yan:peer:connect', peerId, operations, note),
    disconnect: (peerId) => invoke('yan:peer:disconnect', peerId),
    sessions: (peerId) => invoke('yan:peer:sessions', peerId),
    history: (peerId, sessionId, before) => invoke('yan:peer:history', peerId, sessionId, before),
    send: (peerId, sessionId, text) => invoke('yan:peer:send', peerId, sessionId, text),
    startSession: (peerId, projectId, text) => invoke('yan:peer:startSession', peerId, projectId, text),
    abort: (peerId, runId) => invoke('yan:peer:abort', peerId, runId),
    importSession: (peerId, sessionId) => invoke('yan:peer:importSession', peerId, sessionId)
  } as YanBridge['peer'],

  collab: {
    overview: () => invoke('yan:collab:overview'),
    remoteProject: (peerId, projectId) => invoke('yan:collab:remoteProject', peerId, projectId),
    link: (peerId, projectId, localProjectId) => invoke('yan:collab:link', peerId, projectId, localProjectId),
    fetch: (peerId, projectId, branch) => invoke('yan:collab:fetch', peerId, projectId, branch),
    compare: (localProjectId, ref) => invoke('yan:collab:compare', localProjectId, ref),
    fileDiff: (localProjectId, ref, path) => invoke('yan:collab:fileDiff', localProjectId, ref, path),
    merge: (localProjectId, ref, requestId) => invoke('yan:collab:merge', localProjectId, ref, requestId),
    abortMerge: (localProjectId) => invoke('yan:collab:abortMerge', localProjectId),
    push: (input) => invoke('yan:collab:push', input),
    closeRequest: (requestId) => invoke('yan:collab:closeRequest', requestId),
    continueFrom: (localProjectId, ref, importId) => invoke('yan:collab:continueFrom', localProjectId, ref, importId)
  } as YanBridge['collab'],

  voice: {
    prepare: () => invoke('yan:voice:prepare'),
    status: () => invoke<VoiceInputStatus>('yan:voice:status'),
    plan: (target) => invoke<{ ok: true; plan: VoiceDownloadPlan } | { ok: false; error: string }>('yan:voice:plan', target),
    download: (planId) => invoke<Ok>('yan:voice:download', planId),
    cancel: () => invoke<void>('yan:voice:cancel'),
    pick: (kind) => invoke<VoiceInputStatus | null>('yan:voice:pick', kind),
    transcribe: (wav, language) => invoke<VoiceTranscribeResult>('yan:voice:transcribe', wav, language)
  },

  android: {
    status: () => invoke<AndroidSdkStatus>('yan:android:status'),
    install: (ids) => invoke<Ok>('yan:android:install', ids),
    cancel: () => invoke<void>('yan:android:cancel'),
    openSdkDir: () => invoke<string>('yan:android:openSdkDir'),
    devices: () => invoke<AndroidDevice[]>('yan:android:devices'),
    boot: (avd) => invoke<void>('yan:android:boot', avd),
    watch: (serial) => invoke<void>('yan:android:watch', serial),
    control: (serial, action) => invoke<void>('yan:android:control', serial, action),
    onFrame: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, frame: AndroidFrame): void => cb(frame)
      ipcRenderer.on('yan:android-frame', listener)
      return () => {
        ipcRenderer.removeListener('yan:android-frame', listener)
      }
    }
  },

  remote: {
    status: () => invoke<RemoteAccessStatus | null>('yan:remote:status'),
    configure: (settings) => invoke<RemoteAccessStatus | null>('yan:remote:configure', settings),
    pair: () => invoke<RemoteAccessStatus | null>('yan:remote:pair'),
    cancelPairing: () => invoke<RemoteAccessStatus | null>('yan:remote:cancelPairing'),
    revoke: (deviceId) => invoke<RemoteAccessStatus | null>('yan:remote:revoke', deviceId),
    forget: (deviceId) => invoke<RemoteAccessStatus | null>('yan:remote:forget', deviceId),
    relayPair: (kind) => invoke<RemoteAccessStatus | null>('yan:remote:relayPair', kind),
    relayCancel: () => invoke<RemoteAccessStatus | null>('yan:remote:relayCancel'),
    relayRevoke: (id) => invoke<RemoteAccessStatus | null>('yan:remote:relayRevoke', id),
    relayForget: (id) => invoke<RemoteAccessStatus | null>('yan:remote:relayForget', id)
  },

  terminal: {
    available: () => invoke<TerminalAvailability>('yan:terminal:available'),
    list: () => invoke<TerminalSnapshot[]>('yan:terminal:list'),
    start: (request) => invoke<TerminalSnapshot | null>('yan:terminal:start', request),
    write: (id, data) => invoke<boolean>('yan:terminal:write', id, data),
    resize: (id, cols, rows) => invoke<boolean>('yan:terminal:resize', id, cols, rows),
    kill: (id) => invoke<boolean>('yan:terminal:kill', id),
    attach: (id) => invoke<TerminalSnapshot | null>('yan:terminal:attach', id),
    clear: (id) => invoke<boolean>('yan:terminal:clear', id),
    processes: (id) => invoke<TerminalProcessList>('yan:terminal:processes', id)
  },

  projectScripts: {
    read: (projectId) => invoke<ProjectPackageScripts>('yan:projectScripts:read', projectId)
  },

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    setAlwaysOnTop: (v) => invoke<boolean>('win:setAlwaysOnTop', v),
    requestExit: () => invoke<{ action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }>('win:requestExit'),
    lifecycle: () => invoke<{ tray: boolean; visible: boolean; quitting: boolean }>('win:lifecycle')
  },

  onPush: (cb: (msg: MainPush) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: MainPush): void => cb(msg)
    ipcRenderer.on('yan:push', listener)

    if (!rendererReadySent) {
      rendererReadySent = true
      ipcRenderer.send('yan:renderer-ready')
    }

    return () => {
      ipcRenderer.removeListener('yan:push', listener)
    }
  },

  onFilesChanged: (cb: (payload: { watchId: string; dir: string }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { watchId: string; dir: string }): void => {
      if (payload) cb(payload)
    }
    ipcRenderer.on('yan:files-changed', listener)
    return () => {
      ipcRenderer.removeListener('yan:files-changed', listener)
    }
  },

  onHotkey: (cb: (action: 'cycleModel' | 'cycleModelBack' | 'cycleThinking') => void): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: { action: 'cycleModel' | 'cycleModelBack' | 'cycleThinking' }
    ): void => {
      cb(p.action)
    }
    ipcRenderer.on('yan:hotkey', listener)
    return () => {
      ipcRenderer.removeListener('yan:hotkey', listener)
    }
  },

  onDeepLink: (cb: (intent: DeepLinkIntent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, intent: DeepLinkIntent): void => {
      cb(intent)
    }
    ipcRenderer.on('yan:deeplink', listener)
    return () => {
      ipcRenderer.removeListener('yan:deeplink', listener)
    }
  },

  setHotkeyGuard: (paused: boolean): void => {
    ipcRenderer.send('yan:hotkey-guard', Boolean(paused))
  },

  setMotionPreference: (reduced: boolean): void => {
    ipcRenderer.send('yan:motion-preference', Boolean(reduced))
  }
}

const auxApi = {
  quickAsk: {
    state: (): Promise<unknown> => invoke('yan:aux:quick-ask:state'),
    submit: (payload: QuickAskSubmit): Promise<unknown> => invoke('yan:aux:quick-ask:submit', payload),
    close: (): void => ipcRenderer.send('yan:aux:quick-ask:close')
  },
  onPush: (cb: (msg: AuxPush) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: AuxPush): void => cb(msg)
    ipcRenderer.on('yan:aux:push', listener)
    return () => {
      ipcRenderer.removeListener('yan:aux:push', listener)
    }
  }
}
contextBridge.exposeInMainWorld('auxBridge', auxApi)

contextBridge.exposeInMainWorld('yan', api)
