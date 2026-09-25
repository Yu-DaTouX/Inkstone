import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
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
  BrowserState,
  TerminalAvailability,
  TerminalSnapshot,
  ChromeSyncReport,
  AuthProviderInfo,
  CodexLoginResult,
  CompactionInfo,
  TrustStatusView,
  ContextPolicyResolution,
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
  GitFileContent,
  GitFilePatch,
  GitRefOption,
  GitRepoState,
  GitReviewSnapshot,
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
  SessionSummary,
  SessionTodo,
  SubagentRun,
  SlashCommand,
  UIMessage,
  GoalState,
  PursuedBrief,
  HandoffView,
  WorkModeState,
  YanBridge,
  ZoomState
} from '../shared/ipc'
import type { WebSearchAvailability } from '../shared/web-search'
import type { ContextActionSummary } from '../shared/context-actions'
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
  peekSession: (path) => invoke<PeekResult | null>('yan:peekSession', path),

  /* ---- 模型接入（凭证） ---- */
  authProviders: (deep) => invoke<AuthProviderInfo[]>('yan:authProviders', deep),
  codexLogin: () => invoke<CodexLoginResult>('yan:codexLogin'),
  codexLoginCancel: () => invoke<void>('yan:codexLoginCancel'),
  setApiKey: (provider, key) => invoke<Ok>('yan:setApiKey', provider, key),
  clearAuth: (provider) => invoke<Ok>('yan:clearAuth', provider),
  authFileInfo: () => invoke<{ path: string; exists: boolean; count: number }>('yan:authFileInfo'),
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

  /* ---- Git 审查（只读，方案 G1）---- */
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
  packages: {
    list: (cwd) => invoke<PackageListingView>('yan:packages:list', cwd),
    action: (req) => invoke<PackageActionResultView>('yan:packages:action', req)
  },
  /*
   * 项目知识（实施-03 S5）。四个方法都只汇当前会话绑定的项目 ——
   * 渲染端**不能**指定 projectId（身份由宿主按会话推导，与 `yan knowledge` 同一条边界）。
   */
  knowledge: {
    list: () => invoke<KnowledgeListView>('yan:knowledge:list'),
    action: (req: KnowledgeActionRequest) => invoke<KnowledgeActionResult>('yan:knowledge:action', req),
    export: (mode: 'copy' | 'save') => invoke<KnowledgeExportResult>('yan:knowledge:export', mode),
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
    snapshot: (req) => invoke<GitReviewSnapshot>('yan:git:snapshot', req),
    patch: (req) => invoke<GitFilePatch>('yan:git:patch', req),
    content: (req) => invoke<GitFileContent>('yan:git:content', req),
    action: (req) => invoke<GitActionResult>('yan:git:action', req),
    remotes: (cwd) => invoke<string[]>('yan:git:remotes', cwd),
    remoteWeb: (cwd) => invoke('yan:git:remoteWeb', cwd),
    /* PR 状态（§7）：只读，未认证时只能读公开仓库 */
    prStatus: (cwd) => invoke('yan:git:prStatus', cwd),
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
  /** 三类整理动作账本（实施-11 C-2b）：`tool-sweep` / `episode-fold` 的真实发生次数 */
  contextActions: () => invoke<ContextActionSummary>('yan:contextActions'),
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
