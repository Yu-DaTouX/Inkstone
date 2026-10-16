import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { MCP_APP_VIEW_CHANNELS } from '../shared/mcp-app-view'
import type { HtmlArtifactPreviewResult } from '../shared/html-artifact-preview'
import type {
  NativeMcpImportCommitResponse,
  NativeMcpImportPrepareResponse
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
  CapabilitySearchResultView,
  CapabilityVerificationStatus,
  PackageActionResultView,
  PackageListingView,
  SourceRefView,
  SourceLinkView,
  ForkContextResultView,
  ForkRefsReportView,
  WorktreeLinkView,
  Attachment,
  AttentionNotify,
  BrowserBounds,
  BrowserObservation,
  BrowserNetworkSnapshot,
  BrowserState,
  TerminalAvailability,
  TerminalSnapshot,
  ChromeSyncReport,
  AuthProviderInfo,
  CustomProviderResult,
  CustomProviderView,
  ToolchainStatus,
  GitRuntimeStatus,
  CustomProviderDiscoverResult,
  CodexLoginResult,
  CompactionInfo,
  TrustStatusView,
  ContextPolicyResolution,
  ContextBudgetSelectionUpdateResultV1,
  ContextBudgetRuntimeSnapshotV1,
  ContextBudgetSessionPolicyV1,
  ContextMaintenanceOperationV1,
  CustomEntry,
  DirListing,
  FileRequestContext,
  FilePreview,
  FileRefInfo,
  FileSearchRequest,
  FileSearchResult,
  FileTextResult,
  ForkPoint,
  GitActionExpected,
  GitActionResult,
  GitChangesResult,
  GitDiffResult,
  GitRefOption,
  GitRepoState,
  KnowledgeActionResult,
  KnowledgeActionRequest,
  KnowledgeExportResult,
  KnowledgeListView,
  MainPush,
  ModelInfo,
  WorktreeCreateResult,
  WorktreeListing,
  WorktreeRemoveResult,
  PeekResult,
  PiInfo,
  PiProbe,
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
  SlashCommand,
  UIMessage,
  WorkModeState,
  SessionQuestionFrequencyInput,
  SessionQuestionFrequencyResult,
  SessionQuestionFrequencyView,
  ApprovalRequest,
  YanBridge,
  ZoomState,
  CustomProviderTestResult,
  LocalModelServer
} from '../shared/ipc'
import type { DeepLinkIntent } from '../shared/ipc'
import type { WebSearchAvailability } from '../shared/web-search'
import type { RunSnapshot } from '../shared/runs'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult } from '../shared/checkpoints'
import type { RemoteAccessStatus } from '../shared/remote-protocol'
import type { OfficeDocumentView } from '../shared/office'
import type { ConsentEntryView } from '../shared/tool-consent'
import type { VoiceDownloadPlan, VoiceInputStatus, VoiceTranscribeResult } from '../shared/voice-input'
import type { SearchApiConfigView, SearchBackendStatus } from '../shared/search'
import type { ContextActionSummary } from '../shared/context-actions'
import type { ContextBackgroundUsageSummary } from '../shared/context-background-usage'
import type { ContextInspectSnapshot } from '../shared/context-inspect'
import type { AccountQuotaPrefs, AccountQuotaReport, CodexAccountView } from '../shared/account-quota'
import type { CodexFailoverResult } from '../shared/quota-failover'
import type { AuxPush, MiniItem, QuickAskSubmit } from '../main/windows/aux-types'
import { PANE_POPOUT_CHANNELS } from '../shared/pane-popout'
import { PANE_BROWSER_CHANNELS } from '../shared/pane-popout'
import type { PaneBrowserStateView } from '../shared/pane-popout'
import type { BrowserLeaseResult } from '../main/windows/pane-browser-transfer'
import type {
  PaneActionEvent,
  PaneActionRequest,
  PaneActionResult,
  PanePopoutAnyTabId,
  PanePopoutOpenRequest,
  PanePopoutOpenResult,
  PaneProjectionEnvelope,
  PaneStateView
} from '../shared/pane-popout'
import { PANE_TERMINAL_CHANNELS } from '../shared/pane-terminal'
import type {
  PaneTerminalBridge,
  PaneTerminalLeaseView,
  PaneTerminalOpenRequest,
  PaneTerminalOpenResult,
  PaneTerminalPushEvent
} from '../shared/pane-terminal'
const invoke = <T>(ch: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(ch, ...args) as Promise<T>

type Ok = { ok: boolean; error?: string }

const api: YanBridge = {
  probeMode: process.argv.includes('--yan-isolated-probe'),
  appUpdate: {
    status: () => invoke('yan:update:status'),
    check: () => invoke('yan:update:check'),
    automatic: (enabled) => invoke('yan:update:automatic', enabled),
    download: () => invoke('yan:update:download'),
    install: () => invoke('yan:update:install')
  },
  isProbe: !!process.env.YAN_PROBE,

  start: () =>
    invoke<{ ok: boolean; error?: string; state?: SessionState; settings?: AppSettings }>('yan:start'),
  send: (text, images, mode, expectedRuntime) => invoke<Ok>('yan:send', text, images, mode, expectedRuntime),
  steer: (text) => invoke<Ok>('yan:steer', text),
  followUp: (text) => invoke<Ok>('yan:followUp', text),
  steerQueued: (queueId) => invoke<Ok>('yan:steerQueued', queueId),
  removeQueued: (queueId) => invoke<Awaited<ReturnType<YanBridge['removeQueued']>>>('yan:removeQueued', queueId),
  queueEdit: (next) => invoke<Awaited<ReturnType<YanBridge['queueEdit']>>>('yan:queueEdit', next),
  abort: () => invoke<Awaited<ReturnType<YanBridge['abort']>>>('yan:abort'),
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
  moveSession: (sessionId, projectId) =>
    invoke<{ ok: boolean; error?: string; entry?: SessionLayoutEntry }>('yan:moveSession', sessionId, projectId),
  setSessionArchived: (sessionId, archived) => invoke<{ ok: boolean; error?: string }>('yan:setSessionArchived', sessionId, archived),
  setSessionPinned: (sessionId, pinned) => invoke<{ ok: boolean; error?: string }>('yan:setSessionPinned', sessionId, pinned),
  setVisibleRunnerSessions: (sessions) => invoke<boolean>('yan:setVisibleRunnerSessions', sessions),
  nativeSession: (request) => invoke<Awaited<ReturnType<YanBridge['nativeSession']>>>('yan:nativeSession', request),
  runnerStatuses: () => invoke<RunnerStatus[]>('yan:runnerStatuses'),
  stopRunner: (id) => invoke<boolean>('yan:stopRunner', id),
  runs: {
    snapshot: () => invoke<{ revision: number; runs: RunSnapshot[] }>('yan:runs:snapshot'),
    markSeen: (runId) => invoke<{ ok: boolean }>('yan:runs:markSeen', runId),
    history: (query) => invoke<Awaited<ReturnType<YanBridge['runs']['history']>>>('yan:runs:history', query),
    stop: (runId) => invoke<Awaited<ReturnType<YanBridge['runs']['stop']>>>('yan:runs:stop', runId)
  },
  review: {
    changeSet: (query) => invoke<Awaited<ReturnType<YanBridge['review']['changeSet']>>>('yan:review:changes', query),
    diff: (query) => invoke<Awaited<ReturnType<YanBridge['review']['diff']>>>('yan:review:diff', query),
    annotations: (changeSetId, scopeKey) =>
      invoke<Awaited<ReturnType<YanBridge['review']['annotations']>>>('yan:review:annotations', changeSetId, scopeKey),
    annotationAdd: (input) => invoke<Awaited<ReturnType<YanBridge['review']['annotationAdd']>>>('yan:review:annotationAdd', input),
    annotationUpdate: (input) => invoke<Awaited<ReturnType<YanBridge['review']['annotationUpdate']>>>('yan:review:annotationUpdate', input),
    annotationRemove: (input) => invoke<Awaited<ReturnType<YanBridge['review']['annotationRemove']>>>('yan:review:annotationRemove', input),
    annotationClear: (input) => invoke<Awaited<ReturnType<YanBridge['review']['annotationClear']>>>('yan:review:annotationClear', input),
    annotationTask: (query) => invoke<Awaited<ReturnType<YanBridge['review']['annotationTask']>>>('yan:review:annotationTask', { query }),
    start: (req) => invoke<Awaited<ReturnType<YanBridge['review']['start']>>>('yan:review:start', req),
    ghStatus: (cwd) => invoke<Awaited<ReturnType<YanBridge['review']['ghStatus']>>>('yan:review:ghStatus', cwd),
    commit: (req) => invoke<Awaited<ReturnType<YanBridge['review']['commit']>>>('yan:review:commit', req),
    push: (req) => invoke<Awaited<ReturnType<YanBridge['review']['push']>>>('yan:review:push', req),
    pullRequest: (req) => invoke<Awaited<ReturnType<YanBridge['review']['pullRequest']>>>('yan:review:pr', req)
  },
  sync: {
    status: () => invoke<Awaited<ReturnType<YanBridge['sync']['status']>>>('yan:sync:status'),
    configure: (root) => invoke<Awaited<ReturnType<YanBridge['sync']['configure']>>>('yan:sync:configure', root),
    now: () => invoke<Awaited<ReturnType<YanBridge['sync']['now']>>>('yan:sync:now'),
    conflicts: () => invoke<Awaited<ReturnType<YanBridge['sync']['conflicts']>>>('yan:sync:conflicts'),
    resolve: (id, resolution) =>
      invoke<Awaited<ReturnType<YanBridge['sync']['resolve']>>>('yan:sync:resolve', id, resolution),
    exportSession: (sessionPath) =>
      invoke<Awaited<ReturnType<YanBridge['sync']['exportSession']>>>('yan:sync:exportSession', sessionPath),
    importSession: () => invoke<Awaited<ReturnType<YanBridge['sync']['importSession']>>>('yan:sync:importSession')
  },
  compact: (customInstructions) => invoke<Ok>('yan:compact', customInstructions),
  renameSession: (name) => invoke<Ok>('yan:renameSession', name),
  fork: (entryId) => invoke<{ ok: boolean; error?: string; text?: string }>('yan:fork', entryId),
  clone: () => invoke<Ok>('yan:clone'),
  forkPoints: () => invoke<ForkPoint[]>('yan:forkPoints'),
  exportHtml: (outputPath) => invoke<{ ok: boolean; path?: string; error?: string }>('yan:exportHtml', outputPath),
  deleteSession: (path) => invoke<{ ok: boolean; undoToken?: string; error?: string }>('yan:deleteSession', path),
  restoreSession: (undoToken) => invoke<Ok>('yan:restoreSession', undoToken),

  runBash: (command, options, expectedRuntime) => invoke<Ok>('yan:runBash', command, options, expectedRuntime),
  abortBash: () => invoke<void>('yan:abortBash'),

  listModels: () => invoke<ModelInfo[]>('yan:listModels'),
  setModel: (provider, modelId) => invoke<Ok>('yan:setModel', provider, modelId),
  setThinking: (level) => invoke<Ok>('yan:setThinking', level),
  listThinkingLevels: () => invoke<string[]>('yan:listThinkingLevels'),
  listCommands: () => invoke<SlashCommand[]>('yan:listCommands'),

  setAutoCompaction: (enabled) => invoke<Ok>('yan:setAutoCompaction', enabled),
  setAutoRetry: (enabled) => invoke<Ok>('yan:setAutoRetry', enabled),

  getWorkMode: () => invoke<WorkModeState>('yan:getWorkMode'),
  answerApproval: (id, choice) => invoke<{ ok: boolean }>('yan:approvalAnswer', id, choice),
  pendingApprovals: () => invoke<ApprovalRequest[]>('yan:approvalPending'),
  setWorkMode: (mode, expectedRevision) =>
    invoke<{ ok: boolean; state: WorkModeState; error?: string }>('yan:setWorkMode', mode, expectedRevision),
  getSessionQuestionFrequency: (runnerId?: string) =>
    invoke<({ ok: true } & SessionQuestionFrequencyView) | { ok: false; error: string }>(
      'yan:getSessionQuestionFrequency',
      runnerId
    ),
  setSessionQuestionFrequency: (input: SessionQuestionFrequencyInput) =>
    invoke<SessionQuestionFrequencyResult>('yan:setSessionQuestionFrequency', input),

  setSteeringMode: (mode) => invoke<Ok>('yan:setSteeringMode', mode),
  setFollowUpMode: (mode) => invoke<Ok>('yan:setFollowUpMode', mode),
  abortRetry: () => invoke<Ok>('yan:abortRetry'),
  cycleModel: () => invoke<Ok>('yan:cycleModel'),
  cycleModelBack: () => invoke<Ok>('yan:cycleModelBack'),
  cycleThinking: () => invoke<Ok>('yan:cycleThinking'),
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
  getCustomEntries: () => invoke<CustomEntry[]>('yan:getCustomEntries'),
  refreshTodos: () => invoke<SessionTodo[]>('yan:refreshTodos'),
  listSessions: () => invoke<SessionSummary[]>('yan:listSessions'),
  checkpoints: {
    list: () => invoke<CheckpointRecord[]>('yan:checkpoints:list'),
    preview: (recordId) => invoke<CheckpointPreview>('yan:checkpoints:preview', recordId),
    restore: (recordId) => invoke<CheckpointRestoreResult>('yan:checkpoints:restore', recordId),
    undo: (undoId) => invoke<CheckpointRestoreResult>('yan:checkpoints:undo', undoId)
  },
  searchSessions: (query, limit) => invoke<SessionSearchResult>('yan:searchSessions', query, limit),
  usageStats: (range) => invoke<UsageStatsResult>('yan:usageStats', range),
  peekSession: (path) => invoke<PeekResult | null>('yan:peekSession', path),

  authProviders: (deep) => invoke<AuthProviderInfo[]>('yan:authProviders', deep),
  codexLogin: () => invoke<CodexLoginResult>('yan:codexLogin'),
  codexLoginCancel: () => invoke<void>('yan:codexLoginCancel'),
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
  authFileInfo: () => invoke<{ path: string; exists: boolean; count: number }>('yan:authFileInfo'),
  accountQuota: () => invoke<AccountQuotaReport>('yan:accountQuota'),
  accountQuotaSource: (source, enabled) => invoke<AccountQuotaPrefs>('yan:accountQuotaSource', source, enabled),
  accountLabel: (key, label) => invoke<AccountQuotaPrefs>('yan:accountLabel', key, label),
  codexAccounts: () => invoke<CodexAccountView[]>('yan:codexAccounts'),
  codexAccountSwitch: (key) => invoke<Ok>('yan:codexAccountSwitch', key),
  codexAccountRemove: (key) => invoke<Ok>('yan:codexAccountRemove', key),
  codexAccountFailover: (skip) => invoke<CodexFailoverResult>('yan:codexAccountFailover', skip),
  toolchainStatus: () => invoke<ToolchainStatus>('yan:toolchainStatus'),
  gitRuntimeStatus: () => invoke<GitRuntimeStatus>('yan:gitRuntimeStatus'),
  gitRuntimeInstall: () => invoke<{ ok: boolean; error?: string }>('yan:gitRuntimeInstall'),
  gitRuntimeCancel: () => invoke<void>('yan:gitRuntimeCancel'),
  gitRuntimeRemove: () => invoke<void>('yan:gitRuntimeRemove'),
  customProviders: () => invoke<CustomProviderView[]>('yan:customProviders'),
  saveCustomProvider: (input) => invoke<CustomProviderResult>('yan:saveCustomProvider', input),
  discoverCustomModels: (input) => invoke<CustomProviderDiscoverResult>('yan:discoverCustomModels', input),
  detectLocalModels: () => invoke<LocalModelServer[]>('yan:detectLocalModels'),
  localModelUrls: () => invoke<string[]>('yan:localModelUrls'),
  saveLocalModelUrls: (urls) => invoke<string[]>('yan:saveLocalModelUrls', urls),
  removeCustomProvider: (id) => invoke<CustomProviderResult>('yan:removeCustomProvider', id),
  testCustomProvider: (id, mode, modelId) =>
    invoke<CustomProviderTestResult>('yan:testCustomProvider', id, mode, modelId),
  completePath: (prefix, cwd, context) => invoke<PathCompletionResult>('yan:completePath', prefix, cwd, context),
  cancelFileSearch: (requestId) => invoke<void>('yan:cancelFileSearch', requestId),
  searchFiles: (request: FileSearchRequest) => invoke<FileSearchResult>('yan:searchFiles', request),

  pickImages: () => invoke<Attachment[]>('yan:pickImages'),
  pickFilePaths: () => invoke<string[]>('yan:pickFiles'),

  pathForFile: (file) => webUtils.getPathForFile(file),
  describeFiles: (paths) => invoke<FileRefInfo[]>('yan:describeFiles', paths),
  readFileText: (p) => invoke<FileTextResult>('yan:readFileText', p),
  readPreview: (p, line, cwd, lineEnd) => invoke<FilePreview>('yan:readPreview', p, line, cwd, lineEnd),
  prepareHtmlArtifact: (p) => invoke<HtmlArtifactPreviewResult>('yan:prepareHtmlArtifact', p),
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
    start: (task, model, isolation, expectedRuntime) =>
      invoke<{ ok: boolean; error?: string; run?: SubagentRun }>('yan:subagents:start', task, model, isolation, expectedRuntime),
    stop: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:stop', id),
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
    removeImage: (req) => invoke('yan:sources:removeImage', req),
    readImage: (req) => invoke('yan:sources:readImage', req),
    webSearch: () => invoke<WebSearchAvailability>('yan:sources:webSearch')
  },
  packages: {
    search: (query, offset) => invoke('yan:packages:search', query, offset),
    exportPlugin: (id) => invoke('yan:packages:exportPlugin', id),
    addMcp: (id) => invoke('yan:packages:addMcp', id),
    list: (cwd) => invoke<PackageListingView>('yan:packages:list', cwd),
    action: (req) => invoke<PackageActionResultView>('yan:packages:action', req)
  },
  knowledge: {
    list: (scope) => invoke<KnowledgeListView>('yan:knowledge:list', scope),
    action: (req: KnowledgeActionRequest) => invoke<KnowledgeActionResult>('yan:knowledge:action', req),
    export: (mode: 'copy' | 'save', scope) => invoke<KnowledgeExportResult>('yan:knowledge:export', mode, scope),
    sourceSession: (sessionId: string) =>
      invoke<{ ok: boolean; path?: string; title?: string; error?: string }>('yan:knowledge:sourceSession', sessionId)
  },
  builtinCapabilities: {
    list: () => invoke<BuiltinCapabilityView[]>('yan:capabilities:builtin')
  },
  search: {
    doctor: () => invoke<SearchBackendStatus>('yan:search:doctor'),
    installBackend: () => invoke<{ ok: boolean; needsNode?: boolean; error?: string; log?: string }>('yan:search:install'),
    apiConfig: () => invoke<SearchApiConfigView>('yan:search:apiConfig'),
    setApiKey: (provider, key) => invoke<{ ok: boolean; error?: string }>('yan:search:setApiKey', provider, key),
    clearApiKey: (provider) => invoke<{ ok: boolean; error?: string }>('yan:search:clearApiKey', provider),
    setApiHintDismissed: (dismissed) => invoke<void>('yan:search:setApiHintDismissed', dismissed)
  },
  computerUse: {
    status: () => invoke<ComputerUseStatusView>('yan:computerUse:status'),
    installUv: () => invoke<ComputerUseActionResult>('yan:computerUse:installUv'),
    set: (enabled: boolean) => invoke<ComputerUseActionResult>('yan:computerUse:set', enabled)
  },
  capabilities: {
    snapshot: () => invoke<CapabilitySettingsSnapshot>('yan:capabilities:settings'),
    discover: (queryText: string) => invoke<CapabilitySearchResultView>('yan:capabilities:discover', queryText),
    sessionSkill: (action: 'promote' | 'remove', name: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:sessionSkill', { action, name }),
    verify: (serverId: string) => invoke<{ ok: boolean; operationId?: string; error?: string }>('yan:capabilities:verify', serverId),
    verification: (operationId: string) =>
      invoke<CapabilityVerificationStatus | null>('yan:capabilities:verification', operationId),
    cancelVerification: (operationId: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:cancelVerification', operationId),
    prepareNativeImport: (serverId: string) =>
      invoke<NativeMcpImportPrepareResponse>('yan:capabilities:prepareNativeImport', serverId),
    commitNativeImport: (token: string) =>
      invoke<NativeMcpImportCommitResponse>('yan:capabilities:commitNativeImport', token)
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
    release: (instanceId: string) => invoke<void>(MCP_APP_VIEW_CHANNELS.release, instanceId),
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
    remoteWeb: (cwd) => invoke('yan:git:remoteWeb', cwd),
    prStatus: (cwd) => invoke('yan:git:prStatus', cwd),
    untracked: (cwd) => invoke<string[]>('yan:git:untracked', cwd),
    changes: (cwd) => invoke<GitChangesResult>('yan:git:changes', cwd),
    diff: (req) => invoke<GitDiffResult>('yan:git:diff', req),
    worktrees: (cwd) => invoke<WorktreeListing>('yan:git:worktrees', cwd),
    worktreeCreate: (req) => invoke<WorktreeCreateResult>('yan:git:worktreeCreate', req),
    worktreeRemove: (req) => invoke<WorktreeRemoveResult>('yan:git:worktreeRemove', req),
    worktreeLink: (req) => invoke('yan:git:worktreeLink', req),
    worktreeLinks: () => invoke<WorktreeLinkView[]>('yan:git:worktreeLinks'),
    forkFileRefs: (input: {
      worktree: string
      sourceFile?: string
      sourceCwd?: string
      explicitRefs?: string[]
    }) => invoke<ForkRefsReportView>('yan:fork:fileRefs', input),
    forkContext: (input: {
      worktree: string
      sourceFile?: string
      sourceCwd?: string
      sourceSessionId?: string
      explicitAttachmentCount?: number
    }) => invoke<ForkContextResultView>('yan:fork:context', input)
  },

  getSettings: () => invoke<AppSettings>('yan:getSettings'),
  patchSettings: (patch) => invoke<AppSettings>('yan:patchSettings', patch),
  changeProjectDirectory: (request) => invoke<import('../shared/ipc').ProjectDirectoryResult>('yan:project:changeDirectory', request),
  pickCwd: () => invoke<string | null>('yan:pickCwd'),
  setCwd: (cwd) => invoke<Ok>('yan:setCwd', cwd),

  respondUi: (res) => ipcRenderer.send('yan:respondUi', res),
  extendUi: (id, extraMs) => invoke('yan:extendUi', id, extraMs),
  startUiTimer: (id) => invoke('yan:startUiTimer', id),

  notifyAttention: (n: AttentionNotify) =>
    invoke<{ shown: boolean; simulated?: boolean; error?: string }>('yan:notifyAttention', n),

  probePi: () => invoke<PiProbe>('yan:probePi'),
  openPath: (p) => invoke<{ ok: boolean; error?: string }>('yan:openPath', p),
  interactions: {
    get: (session) => invoke<import('../shared/interaction-state').InteractionValues>('yan:interactions:get', session),
    set: (session, key, value) => invoke<import('../shared/interaction-state').InteractionValues>('yan:interactions:set', session, key, value)
  },
  backup: (action) => invoke<import('../shared/data-backup').BackupResult>('yan:backup', action),
  storage: {
    info: () => invoke<StorageInfoView>('yan:storage:info'),
    pick: () => invoke<string | null>('yan:storage:pick'),
    schedule: (target, relaunch) => invoke<{ ok: boolean; error?: string }>('yan:storage:schedule', target, relaunch),
    cancel: () => invoke<void>('yan:storage:cancel')
  },
  openFileDefault: (p, cwd) => invoke<{ ok: boolean; revealed?: boolean; error?: string }>('yan:openFileDefault', p, cwd),
  revealPath: (p) => invoke<{ ok: boolean }>('yan:revealPath', p),

  getZoom: () => invoke<ZoomState>('yan:getZoom'),
  setUiScale: (v) => invoke<ZoomState>('yan:setUiScale', v),

  listDir: (rel, showHidden, context?: FileRequestContext) => invoke<DirListing>('yan:listDir', rel, showHidden === true, context),
  compactionInfo: (win) => invoke<CompactionInfo>('yan:compactionInfo', win),
  trust: {
    status: (cwd?: string) => invoke<TrustStatusView>('yan:trust:status', cwd),
    allow: (cwd?: string) => invoke<{ ok: boolean; entry: string; error?: string }>('yan:trust:allow', cwd),
    revoke: (cwd?: string) => invoke<{ ok: boolean; entry: string; error?: string }>('yan:trust:revoke', cwd)
  },
  contextBudget: (win) => invoke<ContextPolicyResolution>('yan:contextBudget', win),
  contextBudgetV1: () => invoke<ContextBudgetSessionPolicyV1 | null>('yan:contextBudgetV1'),
  contextBudgetV1Enabled: () => invoke<boolean>('yan:contextBudgetV1Enabled'),
  contextBudgetSnapshotV1: () => invoke<ContextBudgetRuntimeSnapshotV1 | null>('yan:contextBudgetSnapshotV1'),
  contextBudgetMaintainV1: (operationId?: string) => invoke<{
    ok: boolean
    operationId?: string
    state?: 'committed' | 'applied' | 'needs_action'
    error?: string
  }>('yan:contextBudgetMaintainV1', operationId),
  contextBudgetMaintenanceStatusV1: () => invoke<ContextMaintenanceOperationV1 | null>('yan:contextBudgetMaintenanceStatusV1'),
  setContextBudgetV1: (update) => invoke<ContextBudgetSelectionUpdateResultV1>('yan:setContextBudgetV1', update),
  setContextBudgetMaterialPinV1: (update) => invoke<ContextBudgetSelectionUpdateResultV1>('yan:setContextBudgetMaterialPinV1', update),
  contextBudgetMaintenanceExitV1: (request: { action: 'raise-line' | 'lower-tier'; expectedRevision: string }) =>
    invoke<{
      ok: boolean
      policy?: ContextBudgetSessionPolicyV1
      selectedBudget?: number
      temporary?: boolean
      expiresAt?: number | null
      error?: string
    }>('yan:contextBudgetMaintenanceExitV1', request),
  contextActions: () => invoke<ContextActionSummary>('yan:contextActions'),
  contextBackgroundUsage: () => invoke<ContextBackgroundUsageSummary>('yan:contextBackgroundUsage'),
  contextInspect: () => invoke<ContextInspectSnapshot | null>('yan:contextInspect'),
  providerQuota: (provider, monthlyBudget) => invoke<ProviderQuota>('yan:providerQuota', provider, monthlyBudget),

  attachments: {
    usage: () => invoke<AttachmentUsage>('yan:attachments:usage'),
    prune: () => invoke<AttachmentPruneResult>('yan:attachments:prune')
  },

  browser: {
    getState: () => invoke<BrowserState>('yan:browser:getState'),
    open: (url) => invoke<BrowserState>('yan:browser:open', url),
    observe: () => invoke<BrowserObservation>('yan:browser:observe'),
    network: () => invoke<BrowserNetworkSnapshot>('yan:browser:network'),
    newTab: (url) => invoke<BrowserState>('yan:browser:newTab', url),
    switchTab: (id) => invoke<BrowserState>('yan:browser:switchTab', id),
    closeTab: (id) => invoke<BrowserState>('yan:browser:closeTab', id),
    close: () => invoke<BrowserState>('yan:browser:close'),
    navigate: (url) => invoke<Ok>('yan:browser:navigate', url),
    back: () => invoke<Ok>('yan:browser:back'),
    forward: () => invoke<Ok>('yan:browser:forward'),
    reload: () => invoke<Ok>('yan:browser:reload'),
    openExternal: (url) => invoke<Ok>('yan:browser:openExternal', url),
    openExternalChrome: (url) => invoke<Ok>('yan:browser:openExternalChrome', url),
    closeExternalChrome: () => invoke<BrowserState>('yan:browser:closeExternalChrome'),
    syncLocalProfile: () => invoke<ChromeSyncReport>('yan:browser:syncLocalProfile'),
    syncPageStorage: () => invoke<ChromeSyncReport>('yan:browser:syncPageStorage'),
    setPermission: (permission, origin, allowed) =>
      invoke<{ ok: boolean; error?: string }>('yan:browser:setPermission', permission, origin, allowed),
    setUserControl: (value) => invoke<BrowserState>('yan:browser:setUserControl', value),
    setBounds: (bounds: BrowserBounds) => invoke<void>('yan:browser:setBounds', bounds),
    setVisible: (visible: boolean) => invoke<void>('yan:browser:setVisible', visible)
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
    importSession: (peerId, sessionId) => invoke('yan:peer:importSession', peerId, sessionId),
    importKnowledge: (peerId, remoteProjectId, localProjectId) => invoke('yan:peer:importKnowledge', peerId, remoteProjectId, localProjectId),
    readImport: (importId) => invoke('yan:peer:readImport', importId),
    revealImport: (importId) => invoke('yan:peer:revealImport', importId)
  } as YanBridge['peer'],

  consent: {
    list: () => invoke<ConsentEntryView[]>('yan:consent:list'),
    change: (key, action) => invoke<ConsentEntryView[]>('yan:consent:change', key, action)
  },

  voice: {
    prepare: () => invoke('yan:voice:prepare'),
    status: () => invoke<VoiceInputStatus>('yan:voice:status'),
    plan: (target) => invoke<{ ok: true; plan: VoiceDownloadPlan } | { ok: false; error: string }>('yan:voice:plan', target),
    download: (planId) => invoke<Ok>('yan:voice:download', planId),
    cancel: () => invoke<void>('yan:voice:cancel'),
    pick: (kind) => invoke<VoiceInputStatus | null>('yan:voice:pick', kind),
    transcribe: (wav, language) => invoke<VoiceTranscribeResult>('yan:voice:transcribe', wav, language)
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
    attach: (id) => invoke<TerminalSnapshot | null>('yan:terminal:attach', id)
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

    ipcRenderer.send('yan:renderer-ready')

    return () => {
      ipcRenderer.removeListener('yan:push', listener)
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
  mini: {
    state: (): Promise<unknown> => invoke('yan:aux:mini:state'),
    open: (item: MiniItem): void => ipcRenderer.send('yan:aux:mini:open', item),
    close: (): void => ipcRenderer.send('yan:aux:mini:close'),
    setEnabled: (enabled: boolean): void => ipcRenderer.send('yan:aux:mini:set-enabled', Boolean(enabled))
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

const paneApi = {
  open: (request: PanePopoutOpenRequest): Promise<PanePopoutOpenResult> =>
    invoke(PANE_POPOUT_CHANNELS.open, request),
  update: (envelope: PaneProjectionEnvelope): void => ipcRenderer.send(PANE_POPOUT_CHANNELS.update, envelope),
  close: (tab: PanePopoutAnyTabId): void => ipcRenderer.send(PANE_POPOUT_CHANNELS.close, tab),
  state: (): Promise<PaneStateView | null> => invoke(PANE_POPOUT_CHANNELS.state),
  action: (action: PaneActionRequest): Promise<PaneActionResult> => invoke(PANE_POPOUT_CHANNELS.action, action),
  closeSelf: (): void => ipcRenderer.send(PANE_POPOUT_CHANNELS.closeSelf),
  onPush: (cb: (view: PaneStateView) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, view: PaneStateView): void => cb(view)
    ipcRenderer.on(PANE_POPOUT_CHANNELS.push, listener)
    return () => {
      ipcRenderer.removeListener(PANE_POPOUT_CHANNELS.push, listener)
    }
  },
  onAction: (cb: (event: PaneActionEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: PaneActionEvent): void => cb(event)
    ipcRenderer.on(PANE_POPOUT_CHANNELS.actionEvent, listener)
    return () => {
      ipcRenderer.removeListener(PANE_POPOUT_CHANNELS.actionEvent, listener)
    }
  }
}
contextBridge.exposeInMainWorld('paneBridge', paneApi)

const paneBrowserApi = {
  state: (): Promise<PaneBrowserStateView | null> => invoke(PANE_BROWSER_CHANNELS.state),
  setBounds: (bounds: { x: number; y: number; width: number; height: number }): Promise<BrowserLeaseResult> =>
    invoke(PANE_BROWSER_CHANNELS.bounds, bounds),
  navigate: (url: string): Promise<BrowserLeaseResult> => invoke(PANE_BROWSER_CHANNELS.navigate, url),
  goBack: (): Promise<BrowserLeaseResult> => invoke(PANE_BROWSER_CHANNELS.back),
  goForward: (): Promise<BrowserLeaseResult> => invoke(PANE_BROWSER_CHANNELS.forward),
  reload: (): Promise<BrowserLeaseResult> => invoke(PANE_BROWSER_CHANNELS.reload),
  close: (): Promise<BrowserLeaseResult> => invoke(PANE_BROWSER_CHANNELS.close),
  returnToHost: (): Promise<BrowserLeaseResult> => invoke(PANE_BROWSER_CHANNELS.returnToHost)
}
contextBridge.exposeInMainWorld('paneBrowserBridge', paneBrowserApi)

const paneTerminalApi: PaneTerminalBridge = {
  open: (request: PaneTerminalOpenRequest): Promise<PaneTerminalOpenResult> =>
    invoke(PANE_TERMINAL_CHANNELS.open, request),
  state: (): Promise<PaneTerminalLeaseView | null> => invoke(PANE_TERMINAL_CHANNELS.state),
  input: (leaseId: string, data: string): Promise<boolean> => invoke(PANE_TERMINAL_CHANNELS.input, leaseId, data),
  resize: (leaseId: string, cols: number, rows: number): Promise<boolean> =>
    invoke(PANE_TERMINAL_CHANNELS.resize, leaseId, cols, rows),
  detach: (leaseId: string): Promise<boolean> => invoke(PANE_TERMINAL_CHANNELS.detach, leaseId),
  closeSelf: (): void => ipcRenderer.send(PANE_TERMINAL_CHANNELS.closeSelf),
  onPush: (cb: (event: PaneTerminalPushEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: PaneTerminalPushEvent): void => cb(event)
    ipcRenderer.on(PANE_TERMINAL_CHANNELS.push, listener)
    return () => {
      ipcRenderer.removeListener(PANE_TERMINAL_CHANNELS.push, listener)
    }
  }
}
contextBridge.exposeInMainWorld('paneTerminalBridge', paneTerminalApi)

contextBridge.exposeInMainWorld('yan', api)
