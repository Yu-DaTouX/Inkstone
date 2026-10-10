import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { HtmlArtifactPreviewResult } from '../shared/html-artifact-preview'
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
  LibraryImportViewResult,
  LibraryOpenView,
  LibraryRefRecordView,
  LibraryVersion,
  LibrarySource,
  ContextAssembly,
  FollowBridge,
  FollowMutationResult,
  ActivityBridge,
  ActivityModelResolution,
  ActivityModelRow,
  FollowRun,
  Watch,
  WatchView,
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
  Space,
  SpaceProjectLink,
  SessionTodo,
  SubagentRun,
  SlashCommand,
  UIMessage,
  GoalState,
  PursuedBrief,
  HandoffView,
  WorkModeState,
  ApprovalRequest,
  AgentProfileState,
  YanBridge,
  ZoomState,
  CustomProviderTestResult
} from '../shared/ipc'
import type { WebSearchAvailability } from '../shared/web-search'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult } from '../shared/checkpoints'
import type { RemoteAccessStatus } from '../shared/remote-protocol'
import type { OfficeDocumentView } from '../shared/office'
import type { ConsentEntryView } from '../shared/tool-consent'
import type { VoiceDownloadPlan, VoiceInputStatus, VoiceTranscribeResult } from '../shared/voice-input'
import type { SearchApiConfigView, SearchBackendStatus } from '../shared/search'
import type { TaskInboxPage } from '../shared/task-inbox'
import type { ContextActionSummary } from '../shared/context-actions'
import type { ContextBackgroundUsageSummary } from '../shared/context-background-usage'
import type { ContextInspectSnapshot } from '../shared/context-inspect'
import type { AccountQuotaPrefs, AccountQuotaReport, CodexAccountView } from '../shared/account-quota'
/**
 * 白名单桥 —— renderer 全程 nodeIntegration:false + contextIsolation:true。
 * 这里的方法就是渲染端能碰到的**全部**能力（HANDOFF §9 原则 3）。
 *
 * api 显式标注成 YanBridge：形态对不上就编译报错。
 * 这层是安全边界，值得多写点类型。
 *
 * ── 新增一个 IPC 要同步四处（少一处就静默不通）──
 *   ① `../shared/ipc.ts`   类型 + `YanBridge` 上的签名
 *   ② 本文件               挂上实现
 *   ③ `../main/index.ts`   `ipcMain.handle('yan:xxx', …)`
 *   ④ `../renderer/src/state/store.ts`   界面侧的消费点
 */
const invoke = <T>(ch: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(ch, ...args) as Promise<T>

type Ok = { ok: boolean; error?: string }

const api: YanBridge = {
  agentService: {
    snapshot: () => invoke('yan:service:snapshot'),
    create: request => invoke('yan:service:create', request),
    run: (id, prompt) => invoke('yan:service:run', id, prompt),
    cancel: id => invoke('yan:service:cancel', id),
    reconcile: id => invoke('yan:service:reconcile', id),
    outputs: id => invoke('yan:service:outputs', id),
    preview: (id, name) => invoke('yan:service:preview', id, name),
    planApply: (id, items) => invoke('yan:service:plan', id, items),
    approve: (id, generation, approved) => invoke('yan:service:approve', id, generation, approved),
    apply: (id, approval, request) => invoke('yan:service:apply', id, approval, request),
    chooseInputs: () => invoke('yan:service:inputs'),
    configureModel: () => invoke('yan:service:configure'),
    chooseDestination: name => invoke('yan:service:destination', name),
    openOutput: (id, name) => invoke('yan:service:open', id, name)
  },
  appUpdate: {
    status: () => invoke('yan:update:status'),
    check: () => invoke('yan:update:check'),
    automatic: (enabled) => invoke('yan:update:automatic', enabled),
    download: () => invoke('yan:update:download'),
    install: () => invoke('yan:update:install')
  },
  /* 探针标记（YAN_PROBE）——渲染端唯一能知道自己在被验收的方式 */
  isProbe: !!process.env.YAN_PROBE,

  /* ---- 会话 ---- */
  start: () =>
    invoke<{ ok: boolean; error?: string; state?: SessionState; settings?: AppSettings }>('yan:start'),
  send: (text, images, mode) => invoke<Ok>('yan:send', text, images, mode),
  steer: (text) => invoke<Ok>('yan:steer', text),
  followUp: (text) => invoke<Ok>('yan:followUp', text),
  steerQueued: (queueId) => invoke<Ok>('yan:steerQueued', queueId),
  removeQueued: (queueId) => invoke<{ ok: boolean; text?: string; error?: string }>('yan:removeQueued', queueId),
  abort: () => invoke<{ steering: string[]; followUp: string[] }>('yan:abort'),
  newSession: (target) =>
    invoke<Ok & { id?: string; runId?: string; sessionId?: string; generation?: number }>('yan:newSession', target),
  switchSession: (path) => invoke<Ok>('yan:switchSession', path),
  /* N12：切换视图（不停止其它运行中的会话）、实例状态、单独停止 */
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
  /* 主题空间（实施-25 P02）：与 moveSession 同一个四处清单（ipc → main → preload → store） */
  getSpaces: () => invoke<{ spaces: Space[]; links: SpaceProjectLink[] }>('yan:getSpaces'),
  createSpace: (input) =>
    invoke<{
      ok: boolean
      error?: string
      space?: Space
      spaces?: Space[]
      links?: SpaceProjectLink[]
    }>('yan:createSpace', input),
  updateSpace: (id, patch) =>
    invoke<{
      ok: boolean
      error?: string
      space?: Space
      spaces?: Space[]
      links?: SpaceProjectLink[]
    }>('yan:updateSpace', id, patch),
  linkSpaceProject: (spaceId, projectId) =>
    invoke<{ ok: boolean; error?: string; links?: SpaceProjectLink[] }>('yan:linkSpaceProject', spaceId, projectId),
  unlinkSpaceProject: (spaceId, projectId) =>
    invoke<{ ok: boolean; error?: string; links?: SpaceProjectLink[] }>('yan:unlinkSpaceProject', spaceId, projectId),
  setSessionArchived: (sessionId, archived) => invoke<{ ok: boolean; error?: string }>('yan:setSessionArchived', sessionId, archived),
  setSessionPinned: (sessionId, pinned) => invoke<{ ok: boolean; error?: string }>('yan:setSessionPinned', sessionId, pinned),
  setSessionSpace: (sessionId, spaceId) =>
    invoke<{ ok: boolean; error?: string; entry?: SessionLayoutEntry }>('yan:setSessionSpace', sessionId, spaceId),
  runnerStatuses: () => invoke<RunnerStatus[]>('yan:runnerStatuses'),
  stopRunner: (id) => invoke<boolean>('yan:stopRunner', id),
  compact: () => invoke<Ok>('yan:compact'),
  renameSession: (name) => invoke<Ok>('yan:renameSession', name),
  fork: (entryId) => invoke<{ ok: boolean; error?: string; text?: string }>('yan:fork', entryId),
  clone: () => invoke<Ok>('yan:clone'),
  forkPoints: () => invoke<ForkPoint[]>('yan:forkPoints'),
  exportHtml: () => invoke<{ ok: boolean; path?: string; error?: string }>('yan:exportHtml'),
  deleteSession: (path) => invoke<{ ok: boolean; undoToken?: string; error?: string }>('yan:deleteSession', path),
  restoreSession: (undoToken) => invoke<Ok>('yan:restoreSession', undoToken),

  /* ---- 直执行 bash ---- */
  runBash: (command) => invoke<Ok>('yan:runBash', command),
  abortBash: () => invoke<void>('yan:abortBash'),

  /* ---- 模型 / 思考 / 命令 ---- */
  listModels: () => invoke<ModelInfo[]>('yan:listModels'),
  setModel: (provider, modelId) => invoke<Ok>('yan:setModel', provider, modelId),
  setThinking: (level) => invoke<Ok>('yan:setThinking', level),
  listThinkingLevels: () => invoke<string[]>('yan:listThinkingLevels'),
  listCommands: () => invoke<SlashCommand[]>('yan:listCommands'),

  /* ---- 开关 ---- */
  setAutoCompaction: (enabled) => invoke<Ok>('yan:setAutoCompaction', enabled),
  setAutoRetry: (enabled) => invoke<Ok>('yan:setAutoRetry', enabled),

  /* ---- 工作模式（实施-05，按当前会话） ---- */
  getWorkMode: () => invoke<WorkModeState>('yan:getWorkMode'),
  answerApproval: (id, choice) => invoke<{ ok: boolean }>('yan:approvalAnswer', id, choice),
  pendingApprovals: () => invoke<ApprovalRequest[]>('yan:approvalPending'),
  getAgentProfile: () => invoke<AgentProfileState>('yan:getAgentProfile'),
  setAgentProfile: (patch, expectedRevision) =>
    invoke<{ ok: boolean; state: AgentProfileState; error?: string; detail?: string }>(
      'yan:setAgentProfile',
      patch,
      expectedRevision
    ),
  getGoal: () => invoke<{ goal: GoalState; mode: WorkModeState }>('yan:getGoal'),
  /* 设定持续目标（`+` 菜单 → 目标）：两栏都必填，拒收只回可读原因 */
  setGoal: (brief: PursuedBrief) =>
    invoke<{ ok: true; goal: GoalState } | { ok: false; error: 'no_session' | 'incomplete' }>(
      'yan:setGoal',
      brief
    ),
  setGoalReadyApproval: (mode, expectedGoalRevision) =>
    invoke<{ ok: true; goal: GoalState } | { ok: false; error: string; goal: GoalState }>(
      'yan:setGoalReadyApproval',
      mode,
      expectedGoalRevision
    ),
  approveGoalReady: (input) =>
    invoke<
      | { ok: true; replayed: boolean; started?: boolean; startError?: string; goal: GoalState }
      | { ok: false; error: string; goal: GoalState }
    >('yan:approveGoalReady', input),
  modifyGoalReady: (input) =>
    invoke<{ ok: true; goal: GoalState } | { ok: false; error: string; goal: GoalState }>(
      'yan:modifyGoalReady',
      input
    ),
  /* 放弃目标（实施-14 A2）：与按停止（暂停）分开的终态出口 */
  stopGoal: () => invoke<{ ok: boolean; goal?: GoalState | null; error?: string }>('yan:stopGoal'),
  /* 交接状态（实施-05 S5b-2）：只读快照，探针与（后续）界面共用 */
  getHandoff: () => invoke<HandoffView>('yan:getHandoff'),
  /* 交接状态的「重试」（实施-14 F5）：只重跑一次调度判定，不强行换段 */
  retryHandoff: () => invoke<Ok>('yan:retryHandoff'),
  confirmHandoff: (handoffId) => invoke<Ok>('yan:confirmHandoff', handoffId),
  setWorkMode: (mode, expectedRevision) =>
    invoke<{ ok: boolean; state: WorkModeState; error?: string }>('yan:setWorkMode', mode, expectedRevision),

  /* ---- 队列模式 / 轮换（pi 自带能力） ---- */
  setSteeringMode: (mode) => invoke<Ok>('yan:setSteeringMode', mode),
  setFollowUpMode: (mode) => invoke<Ok>('yan:setFollowUpMode', mode),
  abortRetry: () => invoke<Ok>('yan:abortRetry'),
  cycleModel: () => invoke<Ok>('yan:cycleModel'),
  cycleModelBack: () => invoke<Ok>('yan:cycleModelBack'),
  cycleThinking: () => invoke<Ok>('yan:cycleThinking'),
  lastAssistantText: () => invoke<string | null>('yan:lastAssistantText'),
  piInfo: () => invoke<PiInfo>('yan:piInfo'),
  redetectPi: () => invoke<PiInfo>('yan:redetectPi'),

  /* ---- 状态 ---- */
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

  /* ---- 模型接入（凭证） ---- */
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
  toolchainStatus: () => invoke<ToolchainStatus>('yan:toolchainStatus'),
  gitRuntimeStatus: () => invoke<GitRuntimeStatus>('yan:gitRuntimeStatus'),
  gitRuntimeInstall: () => invoke<{ ok: boolean; error?: string }>('yan:gitRuntimeInstall'),
  gitRuntimeCancel: () => invoke<void>('yan:gitRuntimeCancel'),
  gitRuntimeRemove: () => invoke<void>('yan:gitRuntimeRemove'),
  customProviders: () => invoke<CustomProviderView[]>('yan:customProviders'),
  saveCustomProvider: (input) => invoke<CustomProviderResult>('yan:saveCustomProvider', input),
  discoverCustomModels: (input) => invoke<CustomProviderDiscoverResult>('yan:discoverCustomModels', input),
  removeCustomProvider: (id) => invoke<CustomProviderResult>('yan:removeCustomProvider', id),
  testCustomProvider: (id, mode, modelId) =>
    invoke<CustomProviderTestResult>('yan:testCustomProvider', id, mode, modelId),
  completePath: (prefix, cwd, context) => invoke<PathCompletionResult>('yan:completePath', prefix, cwd, context),
  cancelFileSearch: (requestId) => invoke<void>('yan:cancelFileSearch', requestId),
  searchFiles: (request: FileSearchRequest) => invoke<FileSearchResult>('yan:searchFiles', request),

  /* ---- 附件 ---- */
  pickImages: () => invoke<Attachment[]>('yan:pickImages'),
  /* 只回路径：校验与登记由 `describeFiles` 那条既有链路做，不在这里读文件 */
  pickFilePaths: () => invoke<string[]>('yan:pickFiles'),

  /* ---- 文件引用（拖入 / 加入上下文的普通文件） ---- */  /*
   * `webUtils.getPathForFile` 必须在渲染进程的 File 对象上调用，
   * 而且只能通过 contextBridge 暴露（File 会被结构化克隆，
   * 直接当 IPC 参数传过去会变成空对象）。这也是 Electron 官方推荐的写法。
   */
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

  /* ---- 子代理（方案第 8 节） ---- */
  subagents: {
    list: () => invoke<SubagentRun[]>('yan:subagents:list'),
    start: (task, model, isolation) =>
      invoke<{ ok: boolean; error?: string; run?: SubagentRun }>('yan:subagents:start', task, model, isolation),
    stop: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:stop', id),
    stopAll: () => invoke<void>('yan:subagents:stopAll'),
    clearFinished: () => invoke<void>('yan:subagents:clear'),
    merge: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:merge', id),
    discard: (id) => invoke<{ ok: boolean; error?: string }>('yan:subagents:discard', id)
  },

  /* ---- Git 仓库状态与环境操作---- */
  /*
   * pi 插件包管理（§9 的 P2）。
   * list 只读；action 会改用户磁盘上的包 —— 主进程那边会做形状校验并在有任务
   * 运行时拒绝，渲染端不需要（也不该）自己拼 pi 的命令行。
   */
  /*
   * 会话来源（§8 的 S1）。只有 addImage/removeImage 会写磁盘，
   * 而且只写数据目录下属于**这个会话**的那份副本。
   */
  sources: {
    list: (sessionId) => invoke<{ ok: boolean; images: SourceRefView[]; dir: string; links: SourceLinkView[]; error?: string }>('yan:sources:list', sessionId),
    addImage: (req) => invoke<SourceRefView | null>('yan:sources:addImage', req),
    verifyFiles: (req) => invoke<SourceRefView[]>('yan:sources:verifyFiles', req),
    link: (req) => invoke('yan:sources:link', req),
    removeImage: (req) => invoke('yan:sources:removeImage', req),
    readImage: (req) => invoke('yan:sources:readImage', req),
    /* 来源搜索入口的可用性（实施-07 S4）：只读查询，没命中就隐藏入口 */
    webSearch: () => invoke<WebSearchAvailability>('yan:sources:webSearch')
  },
  /* 资料库（实施-25 P03）：与 sources 并存；打开只收 { sourceId, version } */
  library: {
    list: (req) =>
      invoke<{
        ok: boolean
        error?: string
        sources: LibrarySource[]
        versions: LibraryVersion[]
        refs: LibraryRefRecordView[]
      }>('yan:library:list',
        req
      ),
    import: (view) => invoke<LibraryImportViewResult>('yan:library:import', view),
    open: (ref, options) => invoke<LibraryOpenView>('yan:library:open', ref, options),
    remove: (sourceId) => invoke<{ ok: boolean; error?: string }>('yan:library:remove', sourceId),
    restore: (sourceId) => invoke<{ ok: boolean; error?: string }>('yan:library:restore', sourceId),
    rename: (sourceId, title) =>
      invoke<{ ok: boolean; error?: string; source?: LibrarySource }>('yan:library:rename', sourceId, title),
    attach: (sourceId, spaceId) => invoke<{ ok: boolean; error?: string }>('yan:library:attach', sourceId, spaceId),
    verify: (refs) =>
      invoke<{ ok: boolean; error?: string; checked: number; unavailable: number }>('yan:library:verify', refs),
    addRef: (owner, ref) => invoke<{ ok: boolean; error?: string; added: boolean }>('yan:library:addRef', owner, ref),
    promoteLegacy: (req) => invoke<LibraryImportViewResult & { mapped?: boolean }>('yan:library:promoteLegacy', req),
    /* 本轮上下文装配结果（实施-25 P05）：只读，供界面 / 探针核对来源引用 */
    current: () => invoke<{ ok: boolean; error?: string; assembly?: ContextAssembly }>('yan:context:current')
  },
  follow: {
    list: (spaceId) => invoke<Watch[]>('yan:follow:list', spaceId),
    views: (spaceId) => invoke<(WatchView & { lastRunText?: string })[]>('yan:follow:views', spaceId),
    due: () => invoke<Watch[]>('yan:follow:due'),
    runs: (input) => invoke<FollowRun[]>('yan:follow:runs', input),
    save: (input) => invoke<FollowMutationResult>('yan:follow:save', input),
    update: (input) => invoke<FollowMutationResult>('yan:follow:update', input),
    remove: (id) => invoke<{ ok: boolean; error?: string }>('yan:follow:remove', id),
    report: (input) => invoke<{ ok: boolean; error?: string; code?: string; run?: FollowRun; watch?: Watch }>('yan:follow:report', input)
  } as FollowBridge,
  activity: {
    rows: (input) => invoke<ActivityModelRow[]>('yan:activity:modelRows', input),
    model: (input) => invoke<ActivityModelResolution>('yan:activity:model', input),
    setModel: (input) => invoke<{ ok: boolean; error?: string; rows?: ActivityModelRow[] }>('yan:activity:modelSet', input)
  } as ActivityBridge,
  packages: {
    search: (query, offset) => invoke('yan:packages:search', query, offset),
    exportPlugin: (id) => invoke('yan:packages:exportPlugin', id),
    list: (cwd) => invoke<PackageListingView>('yan:packages:list', cwd),
    action: (req) => invoke<PackageActionResultView>('yan:packages:action', req)
  },
  /*
   * 项目知识（实施-03 S5）。四个方法都只汇当前会话绑定的项目 ——
   * 渲染端**不能**指定 projectId（身份由宿主按会话推导，与 `yan knowledge` 同一条边界）。
   */
  knowledge: {
    list: (scope) => invoke<KnowledgeListView>('yan:knowledge:list', scope),
    action: (req: KnowledgeActionRequest) => invoke<KnowledgeActionResult>('yan:knowledge:action', req),
    export: (mode: 'copy' | 'save', scope) => invoke<KnowledgeExportResult>('yan:knowledge:export', mode, scope),
    sourceSession: (sessionId: string) =>
      invoke<{ ok: boolean; path?: string; title?: string; error?: string }>('yan:knowledge:sourceSession', sessionId)
  },
  /*
   * 砚自带的受信能力（实施-02 S4）。只读 —— 内置能力没有安装/卸载，
   * 所以这里**不应该**长出一个 action。
   */
  builtinCapabilities: {
    list: () => invoke<BuiltinCapabilityView[]>('yan:capabilities:builtin')
  },
  search: {
    /** 搜索后端诊断（实施-27 S3/D4）：未安装也返回可读结果 */
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
  taskInbox: {
    /*
     * 任务收件箱（实施-28 T2）：只读投影 + 本地忽略名单。
     * `dismiss` / `restore` 只改 `YAN_DIR/task-inbox.json`，不动会话数据。
     */
    page: (query) => invoke<TaskInboxPage>('yan:taskinbox:page', query),
    dismiss: (sessionId) => invoke<{ ok: boolean; dismissed: string[] }>('yan:taskinbox:dismiss', sessionId),
    restore: (sessionId) => invoke<{ ok: boolean; dismissed: string[] }>('yan:taskinbox:restore', sessionId),
    seen: (sessionId) => invoke<{ ok: boolean }>('yan:taskinbox:seen', sessionId)
  },
  capabilities: {
    snapshot: () => invoke<CapabilitySettingsSnapshot>('yan:capabilities:settings'),
    discover: (queryText: string) => invoke<CapabilitySearchResultView>('yan:capabilities:discover', queryText),
    verify: (serverId: string) => invoke<{ ok: boolean; operationId?: string; error?: string }>('yan:capabilities:verify', serverId),
    verification: (operationId: string) =>
      invoke<CapabilityVerificationStatus | null>('yan:capabilities:verification', operationId),
    cancelVerification: (operationId: string) =>
      invoke<{ ok: boolean; error?: string }>('yan:capabilities:cancelVerification', operationId)
  },
  git: {
    state: (cwd) =>
      invoke<{ repo: GitRepoState | null; expected?: GitActionExpected; error?: string }>('yan:git:state', cwd),
    refs: (cwd) =>
      invoke<{ ok: boolean; refs: GitRefOption[]; busyBranches: string[]; error?: string }>('yan:git:refs', cwd),
    action: (req) => invoke<GitActionResult>('yan:git:action', req),
    remotes: (cwd) => invoke<string[]>('yan:git:remotes', cwd),
    remoteWeb: (cwd) => invoke('yan:git:remoteWeb', cwd),
    /* PR 状态（§7）：只读，未认证时只能读公开仓库 */
    prStatus: (cwd) => invoke('yan:git:prStatus', cwd),
    untracked: (cwd) => invoke<string[]>('yan:git:untracked', cwd),
    worktrees: (cwd) => invoke<WorktreeListing>('yan:git:worktrees', cwd),
    worktreeCreate: (req) => invoke<WorktreeCreateResult>('yan:git:worktreeCreate', req),
    worktreeRemove: (req) => invoke<WorktreeRemoveResult>('yan:git:worktreeRemove', req),
    worktreeLink: (req) => invoke('yan:git:worktreeLink', req),
    worktreeLinks: () => invoke<WorktreeLinkView[]>('yan:git:worktreeLinks'),
    /* 工作树 Fork 的文件引用重绑定（实施-07 S2b-3）：仓库相对路径 + 存在性验证 */
    forkFileRefs: (input: {
      worktree: string
      sourceFile?: string
      sourceCwd?: string
      explicitRefs?: string[]
    }) => invoke<ForkRefsReportView>('yan:fork:fileRefs', input),
    /* Fork 的语义注入正文（实施-07 S2b-4）：拿回来当输入框草稿，不自动发送 */
    forkContext: (input: {
      worktree: string
      sourceFile?: string
      sourceCwd?: string
      sourceSessionId?: string
      explicitAttachmentCount?: number
    }) => invoke<ForkContextResultView>('yan:fork:context', input)
  },

  /* ---- 设置 ---- */
  getSettings: () => invoke<AppSettings>('yan:getSettings'),
  patchSettings: (patch) => invoke<AppSettings>('yan:patchSettings', patch),
  pickCwd: () => invoke<string | null>('yan:pickCwd'),
  setCwd: (cwd) => invoke<Ok>('yan:setCwd', cwd),

  /* ---- 扩展 UI 应答（单向） ---- */
  respondUi: (res) => ipcRenderer.send('yan:respondUi', res),
  /* 延长等待：超时计时器在主进程，必须往返一次才能真的延长 */
  extendUi: (id, extraMs) => invoke('yan:extendUi', id, extraMs),
  /* 「这一条已经显示给用户了」→ 主进程才开始计时（多条问题分页显示时每条各算各的） */
  startUiTimer: (id) => invoke('yan:startUiTimer', id),

  /* ---- 系统通知（声音提示的通知开关用） ---- */
  notifyAttention: (n: AttentionNotify) =>
    invoke<{ shown: boolean; simulated?: boolean; error?: string }>('yan:notifyAttention', n),

  /* ---- 诊断 ---- */
  probePi: () => invoke<PiProbe>('yan:probePi'),
  openPath: (p) => invoke<{ ok: boolean; error?: string }>('yan:openPath', p),
  storage: {
    info: () => invoke<StorageInfoView>('yan:storage:info'),
    pick: () => invoke<string | null>('yan:storage:pick'),
    schedule: (target, relaunch) => invoke<{ ok: boolean; error?: string }>('yan:storage:schedule', target, relaunch),
    cancel: () => invoke<void>('yan:storage:cancel')
  },
  openFileDefault: (p, cwd) => invoke<{ ok: boolean; revealed?: boolean; error?: string }>('yan:openFileDefault', p, cwd),
  revealPath: (p) => invoke<void>('yan:revealPath', p),

  /* ---- 界面缩放（0 = 自动） ---- */
  getZoom: () => invoke<ZoomState>('yan:getZoom'),
  setUiScale: (v) => invoke<ZoomState>('yan:setUiScale', v),

  /* ---- 文件树 ---- */
  listDir: (rel, showHidden, context?: FileRequestContext) => invoke<DirListing>('yan:listDir', rel, showHidden === true, context),
  compactionInfo: (win) => invoke<CompactionInfo>('yan:compactionInfo', win),
  /* 项目信任（实施-07 S2b-2）：只读状态 + 用户显式信任一个目录（**不自动继承**） */
  trust: {
    status: (cwd?: string) => invoke<TrustStatusView>('yan:trust:status', cwd),
    allow: (cwd?: string) => invoke<{ ok: boolean; entry: string; error?: string }>('yan:trust:allow', cwd)
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
  /** 整理失败后的一键出口：临时抬软线 / 降档（同时作废那笔停住的整理） */
  contextBudgetMaintenanceExitV1: (request: { action: 'raise-line' | 'lower-tier'; expectedRevision: string }) =>
    invoke<{
      ok: boolean
      policy?: ContextBudgetSessionPolicyV1
      selectedBudget?: number
      temporary?: boolean
      expiresAt?: number | null
      error?: string
    }>('yan:contextBudgetMaintenanceExitV1', request),
  /** 三类整理动作账本（实施-11 C-2b）：`tool-sweep` / `episode-fold` 的真实发生次数 */
  contextActions: () => invoke<ContextActionSummary>('yan:contextActions'),
  /** 后台调用用量账（供应商口径）：未缓存输入 / 缓存命中率 / 各类调用次数 */
  contextBackgroundUsage: () => invoke<ContextBackgroundUsageSummary>('yan:contextBackgroundUsage'),
  /** 当前会话最近一次上报的系统提示分段与工具定义（估算）；还没有对话时为 null */
  contextInspect: () => invoke<ContextInspectSnapshot | null>('yan:contextInspect'),
  providerQuota: (provider, monthlyBudget) => invoke<ProviderQuota>('yan:providerQuota', provider, monthlyBudget),

  /* ---- 图片附件：占用与手动清理（不做自动 GC）---- */
  attachments: {
    usage: () => invoke<AttachmentUsage>('yan:attachments:usage'),
    prune: () => invoke<AttachmentPruneResult>('yan:attachments:prune')
  },

  /* ---- 内置浏览器 ---- */
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
    /** 临时隐藏/恢复原生网页视图（文件预览占用同一区域时） */
    setVisible: (visible: boolean) => invoke<void>('yan:browser:setVisible', visible)
  },

  /* ---- 办公文件 ---- */
  office: {
    preview: (path, cwd) => invoke<OfficeDocumentView>('yan:office:preview', path, cwd)
  },

  /* ---- 砚对砚 ---- */
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

  /* ---- 普通工具的自动调用依据 ---- */
  consent: {
    list: () => invoke<ConsentEntryView[]>('yan:consent:list'),
    change: (key, action) => invoke<ConsentEntryView[]>('yan:consent:change', key, action)
  },

  /* ---- 语音输入（本地转写） ---- */
  voice: {
    prepare: () => invoke('yan:voice:prepare'),
    status: () => invoke<VoiceInputStatus>('yan:voice:status'),
    plan: (target) => invoke<{ ok: true; plan: VoiceDownloadPlan } | { ok: false; error: string }>('yan:voice:plan', target),
    download: (planId) => invoke<Ok>('yan:voice:download', planId),
    cancel: () => invoke<void>('yan:voice:cancel'),
    pick: (kind) => invoke<VoiceInputStatus | null>('yan:voice:pick', kind),
    transcribe: (wav, language) => invoke<VoiceTranscribeResult>('yan:voice:transcribe', wav, language)
  },

  /* ---- 手机接入 ---- */
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

  /* ---- 交互终端（实施-11 H-11） ---- */
  terminal: {
    available: () => invoke<TerminalAvailability>('yan:terminal:available'),
    list: () => invoke<TerminalSnapshot[]>('yan:terminal:list'),
    start: (request) => invoke<TerminalSnapshot | null>('yan:terminal:start', request),
    write: (id, data) => invoke<boolean>('yan:terminal:write', id, data),
    resize: (id, cols, rows) => invoke<boolean>('yan:terminal:resize', id, cols, rows),
    kill: (id) => invoke<boolean>('yan:terminal:kill', id),
    attach: (id) => invoke<TerminalSnapshot | null>('yan:terminal:attach', id)
  },
  hub: {
    snapshot: () => invoke('yan:hub:snapshot'),
    command: (command) => invoke('yan:hub:command', command),
    detect: () => invoke('yan:hub:detect')
  },

  /* ---- 窗口 ---- */
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    setAlwaysOnTop: (v) => invoke<boolean>('win:setAlwaysOnTop', v),
    requestExit: () => invoke<{ action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }>('win:requestExit'),
    lifecycle: () => invoke<{ tray: boolean; visible: boolean; quitting: boolean }>('win:lifecycle')
  },

  /** 订阅主进程推送，返回退订函数 */
  onPush: (cb: (msg: MainPush) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: MainPush): void => cb(msg)
    ipcRenderer.on('yan:push', listener)

    // 握手：告诉主进程「我准备好了，把当前状态重发一遍」。
    //
    // 为什么需要：主进程启动 pi 只要几秒，可能在 webContents 还没
    // 有能力接收时就把 `proc: ready` 发出去 —— 那条消息就永久丢了，
    // 界面停在「正在启动 pi」而功能其实是好的。
    // 单向 push 不可靠，必须有一次「拉」。
    ipcRenderer.send('yan:renderer-ready')

    return () => {
      ipcRenderer.removeListener('yan:push', listener)
    }
  },

  /**
   * 订阅主进程拦下来的全局快捷键。
   *
   * 主进程用 before-input-event 先拦（输入法组合态、焦点不在 webContents
   * 的时候也拦得住），再把**动作名**发过来；具体怎么算下一档由渲染端决定 ——
   * 协议知识不进主进程（HANDOFF §9 原则 1）。
   */
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

  /**
   * 模态层守卫：有弹窗/对话框打开时，暂停主进程对 cycleModel / cycleThinking
   * 的全局拦截（见 shared/ipc.ts 的说明）。单向 send —— 不需要回执。
   */
  setHotkeyGuard: (paused: boolean): void => {
    ipcRenderer.send('yan:hotkey-guard', Boolean(paused))
  }
}

contextBridge.exposeInMainWorld('yan', api)
