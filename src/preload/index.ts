import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { stripIpcErrorPrefix } from '../shared/ipc-error'
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
import type {
  OAuthLoginEvent,
  ManagedSkillAction,
  AttentionNotify,
  BrowserBounds,
  BrowserViewport,
  FileRequestContext,
  MainPush,
  YanBridge,
  VideoExportProgress
} from '../shared/ipc'
import type { DeepLinkIntent } from '../shared/ipc'
import type { DesktopPetResult, DesktopPetStatus } from '../shared/desktop-pet'
import type { AndroidFrame } from '../shared/android-sdk'
import type { AuxPush, QuickAskSubmit } from '../main/windows/aux-types'
import type { IpcArgs, IpcChannel, IpcResult } from '../shared/ipc-channels'
const invokeUnmapped = (ch: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(ch, ...args).catch((error: unknown) => {
    if (error instanceof Error) {
      const message = stripIpcErrorPrefix(error.message)
      if (message !== error.message) throw new Error(message)
    }
    throw error
  })

const invoke = <C extends IpcChannel>(ch: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> =>
  invokeUnmapped(ch, ...args) as Promise<IpcResult<C>>

let rendererReadySent = false

const api: YanBridge = {
  probeMode: process.argv.includes('--yan-isolated-probe'),
  windowMaterial: (process.argv.find((a) => a.startsWith('--yan-window-material=')) ?? '').slice('--yan-window-material='.length),
  pinnedNetwork: {
    status: () => invoke('yan:pinnedNetworkStatus')
  },

  appUpdate: {
    status: () => invoke('yan:update:status'),
    check: () => invoke('yan:update:check'),
    automatic: (enabled) => invoke('yan:update:automatic', enabled),
    download: () => invoke('yan:update:download'),
    install: () => invoke('yan:update:install'),
    whatsNew: () => invoke('yan:update:whatsNew'),
    whatsNewSeen: (version) => invoke('yan:update:whatsNewSeen', version)
  },
  isProbe: !!process.env.YAN_PROBE,

  start: () => invoke('yan:start'),
  send: (text, images, mode, expectedRuntime) => invoke('yan:send', text, images, mode, expectedRuntime),
  steer: (text, expectedRuntime) => invoke('yan:steer', text, expectedRuntime),
  followUp: (text, expectedRuntime) => invoke('yan:followUp', text, expectedRuntime),
  steerQueued: (queueId, expectedRuntime) => invoke('yan:steerQueued', queueId, expectedRuntime),
  removeQueued: (queueId, expectedRuntime) => invoke('yan:removeQueued', queueId, expectedRuntime),
  queueEdit: (next, expectedRuntime) => invoke('yan:queueEdit', next, expectedRuntime),
  abort: (expectedRuntime) => invoke('yan:abort', expectedRuntime),
  newSession: (target) => invoke('yan:newSession', target),
  switchSession: (path) => invoke('yan:switchSession', path),
  selectSession: (target) => invoke('yan:selectSession', target),
  moveSession: (sessionId, projectId, cwd) => invoke('yan:moveSession', sessionId, projectId, cwd),
  setSessionArchived: (sessionId, archived) => invoke('yan:setSessionArchived', sessionId, archived),
  translateText: (text) => invoke('yan:translateText', text),
  archivedCompression: (run) => invoke('yan:archivedCompression', run),
  setSessionPinned: (sessionId, pinned) => invoke('yan:setSessionPinned', sessionId, pinned),
  setSessionSnoozed: (sessionId, until) => invoke('yan:setSessionSnoozed', sessionId, until),
  setSessionMarkedUnread: (sessionId, marked) => invoke('yan:setSessionMarkedUnread', sessionId, marked),
  setVisibleRunnerSessions: (sessions) => invoke('yan:setVisibleRunnerSessions', sessions),
  nativeSession: (request) => invoke('yan:nativeSession', request),
  runnerStatuses: () => invoke('yan:runnerStatuses'),
  stopRunner: (id) => invoke('yan:stopRunner', id),
  runs: {
    snapshot: () => invoke('yan:runs:snapshot'),
    markSeen: (runId) => invoke('yan:runs:markSeen', runId),
    history: (query) => invoke('yan:runs:history', query),
    stop: (runId) => invoke('yan:runs:stop', runId)
  },
  sessionTransfer: {
    exportSession: (sessionPath, options) => invoke('yan:sessionTransfer:export', sessionPath, options),
    importSession: () => invoke('yan:sessionTransfer:import'),
    sessionMarkdown: (sessionPath, title) => invoke('yan:sessionTransfer:markdown', sessionPath, title)
  },
  compact: (customInstructions, expected) => invoke('yan:compact', customInstructions, expected),
  compactionInfo: (cwd, contextWindow) => invoke('yan:compactionInfo', cwd, contextWindow),
  renameSession: (name, expected) => invoke('yan:renameSession', name, expected),
  fork: (entryId, expected) => invoke('yan:fork', entryId, expected),
  clone: (expected) => invoke('yan:clone', expected),
  forkPoints: () => invoke('yan:forkPoints'),
  exportHtml: (outputPath, expected) => invoke('yan:exportHtml', outputPath, expected),
  deleteSession: (path) => invoke('yan:deleteSession', path),
  restoreSession: (undoToken) => invoke('yan:restoreSession', undoToken),
  listArtifactLibrary: () => invoke('yan:listArtifactLibrary'),
  saveInlineArtifact: (input) => invoke('yan:saveInlineArtifact', input),

  runBash: (command, options, expectedRuntime) => invoke('yan:runBash', command, options, expectedRuntime),
  abortBash: (expected) => invoke('yan:abortBash', expected),

  listModels: () => invoke('yan:listModels'),
  setModel: (provider, modelId, expected) => invoke('yan:setModel', provider, modelId, expected),
  setThinking: (level, expected) => invoke('yan:setThinking', level, expected),
  setUltracode: (on, expected) => invoke('yan:setUltracode', on, expected),
  listThinkingLevels: () => invoke('yan:listThinkingLevels'),
  listCommands: () => invoke('yan:listCommands'),

  setAutoCompaction: (enabled) => invoke('yan:setAutoCompaction', enabled),
  setAutoRetry: (enabled) => invoke('yan:setAutoRetry', enabled),
  piRuntimePrefs: () => invoke('yan:piRuntimePrefs'),
  piNativeSettings: () => invoke('yan:piNativeSettings'),
  setPiNativeSettings: (patch) => invoke('yan:setPiNativeSettings', patch),

  answerApproval: (id, choice, identity, feedback) => invoke('yan:approvalAnswer', id, choice, identity, feedback),
  holdApproval: (id, identity) => invoke('yan:approvalHold', id, identity),
  pendingApprovals: () => invoke('yan:approvalPending'),
  pendingUiRequests: () => invoke('yan:pendingUiRequests'),
  resyncView: (reason) => invoke('yan:resyncView', reason),
  setSteeringMode: (mode) => invoke('yan:setSteeringMode', mode),
  setFollowUpMode: (mode) => invoke('yan:setFollowUpMode', mode),
  abortRetry: (expected) => invoke('yan:abortRetry', expected),
  cycleModel: (expected) => invoke('yan:cycleModel', expected),
  cycleModelBack: (expected) => invoke('yan:cycleModelBack', expected),
  cycleThinking: (expected) => invoke('yan:cycleThinking', expected),
  lastAssistantText: (expected) => invoke('yan:lastAssistantText', expected),
  piInfo: () => invoke('yan:piInfo'),
  redetectPi: () => invoke('yan:redetectPi'),

  getState: () => invoke('yan:getState'),
  agentStatus: () => invoke('yan:agentStatus'),
  getMessages: () => invoke('yan:getMessages'),
  getStats: () => invoke('yan:getStats'),
  cachedTitles: () => invoke('yan:cachedTitles'),
  manualTitles: () => invoke('yan:manualTitles'),
  setManualTitle: (sessionId, name) => invoke('yan:setManualTitle', sessionId, name),
  regenerateTitle: (sessionId) => invoke('yan:regenerateTitle', sessionId),
  refreshTodos: () => invoke('yan:refreshTodos'),
  listSessions: () => invoke('yan:listSessions'),
  checkpoints: {
    list: () => invoke('yan:checkpoints:list'),
    preview: (recordId) => invoke('yan:checkpoints:preview', recordId),
    restore: (recordId) => invoke('yan:checkpoints:restore', recordId),
    undo: (undoId) => invoke('yan:checkpoints:undo', undoId),
    assess: (cwd) => invoke('yan:checkpoints:assess', cwd)
  },
  searchSessions: (query, limit) => invoke('yan:searchSessions', query, limit),
  usageStats: (range) => invoke('yan:usageStats', range),
  peekSession: (path, opts) => invoke('yan:peekSession', path, opts),

  authProviders: (deep) => invoke('yan:authProviders', deep),
  codexLogin: () => invoke('yan:codexLogin'),
  codexLoginCancel: () => invoke('yan:codexLoginCancel'),
  oauthAccounts: () => invoke('yan:oauthAccounts'),
  oauthAccountSwitch: (provider, key) => invoke('yan:oauthAccountSwitch', provider, key),
  oauthAccountRemove: (provider, key) => invoke('yan:oauthAccountRemove', provider, key),
  oauthAccountRename: (provider, key, label) => invoke('yan:oauthAccountRename', provider, key, label),
  oauthLogin: (provider) => invoke('yan:oauthLogin', provider),
  oauthLoginAnswer: (provider, promptId, value) => invoke('yan:oauthLoginAnswer', provider, promptId, value),
  oauthLoginCancel: (provider) => invoke('yan:oauthLoginCancel', provider),
  onOAuthEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: OAuthLoginEvent): void => cb(ev)
    ipcRenderer.on('yan:oauth', listener)
    return () => {
      ipcRenderer.removeListener('yan:oauth', listener)
    }
  },
  setApiKey: (provider, key) => invoke('yan:setApiKey', provider, key),
  clearAuth: (provider) => invoke('yan:clearAuth', provider),
  apiKeys: () => invoke('yan:apiKeys'),
  addApiKey: (provider, key, label) => invoke('yan:addApiKey', provider, key, label),
  switchApiKey: (provider, id) => invoke('yan:switchApiKey', provider, id),
  renameApiKey: (provider, id, label) => invoke('yan:renameApiKey', provider, id, label),
  removeApiKey: (provider, id) => invoke('yan:removeApiKey', provider, id),
  authFileInfo: () => invoke('yan:authFileInfo'),
  accountQuota: () => invoke('yan:accountQuota'),
  accountResetCredit: (provider, key, creditId) => invoke('yan:accountResetCredit', provider, key, creditId),
  codexAccounts: () => invoke('yan:codexAccounts'),
  codexAccountSwitch: (key) => invoke('yan:codexAccountSwitch', key),
  codexAccountRemove: (key) => invoke('yan:codexAccountRemove', key),
  toolchainStatus: () => invoke('yan:toolchainStatus'),
  gitRuntimeStatus: () => invoke('yan:gitRuntimeStatus'),
  gitRuntimeInstall: () => invoke('yan:gitRuntimeInstall'),
  gitRuntimeCancel: () => invoke('yan:gitRuntimeCancel'),
  gitRuntimeRemove: () => invoke('yan:gitRuntimeRemove'),
  customProviders: () => invoke('yan:customProviders'),
  plugins: {
    action: (id, action) => invoke('yan:plugins:action', id, action),
    invoke: (id, action, params) => invoke('yan:plugins:invoke', id, action, params)
  },
  desktopPet: {
    status: async () => {
      const result = await invoke('yan:plugins:action', 'desktop-pet', 'status')
      return (result.status as DesktopPetStatus | undefined) ?? { installed: false, running: false, version: '', autoStart: false, model: null, installDir: '', edges: { state: 'idle', done: 0, total: 0 }, log: [] }
    },
    install: () => invoke('yan:plugins:action', 'desktop-pet', 'install') as Promise<DesktopPetResult>,
    start: () => invoke('yan:plugins:invoke', 'desktop-pet', 'start') as Promise<DesktopPetResult>,
    stop: () => invoke('yan:plugins:invoke', 'desktop-pet', 'stop') as Promise<DesktopPetResult>,
    uninstall: () => invoke('yan:plugins:action', 'desktop-pet', 'remove') as Promise<DesktopPetResult>,
    autoStart: (enabled) => invoke('yan:plugins:invoke', 'desktop-pet', 'autoStart', enabled) as Promise<DesktopPetResult>,
    setModel: (model) => invoke('yan:plugins:invoke', 'desktop-pet', 'setModel', model) as Promise<DesktopPetResult>
  },
  saveCustomProvider: (input) => invoke('yan:saveCustomProvider', input),
  discoverCustomModels: (input) => invoke('yan:discoverCustomModels', input),
  detectLocalModels: () => invoke('yan:detectLocalModels'),
  removeCustomProvider: (id) => invoke('yan:removeCustomProvider', id),
  testCustomProvider: (id, mode, modelId) => invoke('yan:testCustomProvider', id, mode, modelId),
  completePath: (prefix, cwd, context) => invoke('yan:completePath', prefix, cwd, context),

  pickImages: () => invoke('yan:pickImages'),
  pickFilePaths: () => invoke('yan:pickFiles'),

  canvas: {
    capture: (rect, scope) => invoke(CANVAS_CAPTURE_CHANNEL, rect, scope)
  },

  htmlEdit: {
    apply: (request) => invoke(HTML_EDIT_APPLY_CHANNEL, request),
    undo: (request) => invoke(HTML_EDIT_UNDO_CHANNEL, request)
  },

  videoExport: {
    start: (request) => invoke(VIDEO_EXPORT_START_CHANNEL, request),
    cancel: (id) => invoke(VIDEO_EXPORT_CANCEL_CHANNEL, id),
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
  describeFiles: (paths) => invoke('yan:describeFiles', paths),
  savePastedText: (text, name) => invoke('yan:savePastedText', text, name),
  quoteSession: (path, title) => invoke('yan:quoteSession', path, title),
  readFileText: (p) => invoke('yan:readFileText', p),
  readPreview: (p, line, cwd, lineEnd) => invoke('yan:readPreview', p, line, cwd, lineEnd),
  readPreviewBytes: (p, cwd) => invoke('yan:readPreviewBytes', p, cwd),
  prepareHtmlArtifact: (p, cwd) => invoke('yan:prepareHtmlArtifact', p, cwd),
  releaseHtmlArtifact: (url) => invoke('yan:releaseHtmlArtifact', url),
  prepareHtmlWidget: (html) => invoke('yan:prepareHtmlWidget', html),
  statPreview: (p, cwd) => invoke('yan:statPreview', p, cwd),

  subagents: {
    list: () => invoke('yan:subagents:list'),
    get: (id) => invoke('yan:subagents:get', id),
    start: (task, model, isolation, expectedRuntime) => invoke('yan:subagents:start', task, model, isolation, expectedRuntime),
    askSideQuestion: (question, expectedRuntime) => invoke('yan:subagents:askSideQuestion', question, expectedRuntime),
    stop: (id) => invoke('yan:subagents:stop', id),
    send: (id, message) => invoke('yan:subagents:send', id, message),
    dismiss: (id) => invoke('yan:subagents:dismiss', id),
    stopAll: () => invoke('yan:subagents:stopAll'),
    clearFinished: (ids) => invoke('yan:subagents:clear', ids),
    merge: (id) => invoke('yan:subagents:merge', id),
    discard: (id) => invoke('yan:subagents:discard', id)
  },

  workflows: {
    list: () => invoke('yan:workflows:list'),
    pause: (id) => invoke('yan:workflows:pause', id),
    resume: (id) => invoke('yan:workflows:resume', id),
    stop: (id) => invoke('yan:workflows:stop', id)
  },

  sources: {
    list: (sessionId) => invoke('yan:sources:list', sessionId),
    addImage: (req) => invoke('yan:sources:addImage', req),
    verifyFiles: (req) => invoke('yan:sources:verifyFiles', req),
    link: (req) => invoke('yan:sources:link', req),
    removeImage: (req) => invoke('yan:sources:removeImage', req)
  },
  searchOps: {
    read: (operationId) => invoke(SEARCH_OPS_READ_CHANNEL, operationId),
    siteIcon: (url) => invoke(SEARCH_SITE_ICON_CHANNEL, url)
  },
  packages: {
    search: (query, offset) => invoke('yan:packages:search', query, offset),
    catalog: (refresh) => invoke('yan:packages:catalog', refresh === true),
    exportPlugin: (id) => invoke('yan:packages:exportPlugin', id),
    addMcp: (id) => invoke('yan:packages:addMcp', id),
    minecraft: (action) => invoke('yan:packages:minecraft', action),
    codegraphStatus: (cwd) => invoke('yan:packages:codegraphStatus', cwd),
    codegraphIndex: (cwd) => invoke('yan:packages:codegraphIndex', cwd),
    anthropicEnv: () => invoke('yan:packages:anthropicEnv'),
    list: (cwd) => invoke('yan:packages:list', cwd),
    action: (req) => invoke('yan:packages:action', req)
  },
  builtinCapabilities: {
    list: () => invoke('yan:capabilities:builtin')
  },
  image: {
    config: () => invoke('yan:image:config'),
    update: (patch) => invoke('yan:image:update', patch),
    setKey: (service, key) => invoke('yan:image:setKey', service, key),
    clearKey: (service) => invoke('yan:image:clearKey', service)
  },
  search: {
    doctor: () => invoke('yan:search:doctor'),
    apiConfig: () => invoke('yan:search:apiConfig'),
    setApiKey: (provider, key) => invoke('yan:search:setApiKey', provider, key),
    clearApiKey: (provider) => invoke('yan:search:clearApiKey', provider),
    setApiHintDismissed: (dismissed) => invoke('yan:search:setApiHintDismissed', dismissed)
  },
  computerUse: {
    status: () => invoke('yan:computerUse:status'),
    installUv: () => invoke('yan:computerUse:installUv'),
    resolveInteraction: () => invoke('yan:computerUse:resolveInteraction'),
    set: (enabled: boolean) => invoke('yan:computerUse:set', enabled)
  },
  capabilities: {
    snapshot: () => invoke('yan:capabilities:settings'),
    promptDirectories: () => invoke('yan:capabilities:promptDirectories'),
    openPromptDirectory: (path: string) => invoke('yan:capabilities:openPromptDirectory', path),
    createPromptTemplate: (input: { name: string; content: string }) => invoke('yan:capabilities:createPromptTemplate', input),
    discover: (queryText: string) => invoke('yan:capabilities:discover', queryText),
    sessionSkill: (action: 'promote' | 'remove', name: string) => invoke('yan:capabilities:sessionSkill', { action, name }),
    manageSkill: (action: ManagedSkillAction, scope: 'yan' | 'pi', dir: string) => invoke('yan:capabilities:manageSkill', { action, scope, dir }),
    revealSkill: (location: string) => invoke('yan:capabilities:revealSkill', location),
    verify: (serverId: string) => invoke('yan:capabilities:verify', serverId),
    verification: (operationId: string) => invoke('yan:capabilities:verification', operationId),
    cancelVerification: (operationId: string) => invoke('yan:capabilities:cancelVerification', operationId),
    nativeServers: () => invoke('yan:capabilities:nativeMcpServers'),
    mcpServices: () => invoke('yan:capabilities:mcpServices'),
    changeMcpService: (input) => invoke('yan:capabilities:changeMcpService', input),
    applyMcpServices: (input) => invoke('yan:capabilities:applyMcpServices', input),
    manageNativeServer: (action: 'enable' | 'disable' | 'remove', name: string) => invoke('yan:capabilities:manageNativeMcpServer', { action, name })
  },
  mcpApps: {
    prepare: (callId: string) => invoke(MCP_APP_VIEW_CHANNELS.prepare, callId),
    dispatch: (instanceId: string, message: unknown) => invoke(MCP_APP_VIEW_CHANNELS.dispatch, instanceId, message),
    release: (instanceId: string) => invoke(MCP_APP_VIEW_CHANNELS.release, instanceId),
    audit: (callId: string) => invoke(MCP_APP_VIEW_CHANNELS.audit, callId),
    snapshot: () => invoke(MCP_APP_VIEW_CHANNELS.snapshot),
    refresh: () => invoke(MCP_APP_VIEW_CHANNELS.refresh),
    hostContext: (instanceId: string) => invoke(MCP_APP_VIEW_CHANNELS.hostContext, instanceId)
  },
  git: {
    state: (cwd, options) => invoke('yan:git:state', cwd, options),
    refs: (cwd) => invoke('yan:git:refs', cwd),
    action: (req) => invoke('yan:git:action', req),
    remotes: (cwd) => invoke('yan:git:remotes', cwd),
    untracked: (cwd) => invoke('yan:git:untracked', cwd),
    changes: (cwd, options) => invoke('yan:git:changes', cwd, options),
    screenPaths: (cwd, paths) => invoke('yan:git:screenPaths', cwd, paths),
    identity: (cwd, refresh) => invoke('yan:git:identity', cwd, refresh === true),
    diff: (req) => invoke('yan:git:diff', req),
    worktrees: (cwd) => invoke('yan:git:worktrees', cwd)
  },
  github: {
    status: (cwd) => invoke('yan:github:status', cwd),
    createDefaults: (cwd) => invoke('yan:github:createDefaults', cwd),
    list: (cwd, options) => invoke('yan:github:list', cwd, options),
    action: (cwd, request) => invoke('yan:github:action', cwd, request),
    candidates: (cwd, request) => invoke('yan:github:candidates', cwd, request),
    detail: (cwd, number) => invoke('yan:github:detail', cwd, number),
    diff: (cwd, number) => invoke('yan:github:diff', cwd, number),
    openUrl: (url) => invoke('yan:github:openUrl', url),
    account: () => invoke('yan:github:account'),
    repos: (request) => invoke('yan:github:repos', request),
    searchRepos: (query) => invoke('yan:github:searchRepos', query),
    clone: (request) => invoke('yan:github:clone', request),
    cancelClone: (id) => invoke('yan:github:cancelClone', id),
    createProject: (name, parentDir) => invoke('yan:github:createProject', name, parentDir),
    branches: (cwd) => invoke('yan:github:branches', cwd),
    defaultCloneDir: () => invoke('yan:github:defaultCloneDir')
  },

  getSettings: () => invoke('yan:getSettings'),
  patchSettings: (patch) => invoke('yan:patchSettings', patch),
  removeGuardAllowRoot: (path) => invoke('yan:removeGuardAllowRoot', path),
  changeProjectDirectory: (request) => invoke('yan:project:changeDirectory', request),
  pickCwd: () => invoke('yan:pickCwd'),
  setCwd: (cwd) => invoke('yan:setCwd', cwd),

  respondUi: (res) => invoke('yan:respondUi', res),
  extendUi: (id, extraMs) => invoke('yan:extendUi', id, extraMs),
  startUiTimer: (id) => invoke('yan:startUiTimer', id),

  notifyAttention: (n: AttentionNotify) => invoke('yan:notifyAttention', n),

  openPath: (p) => invoke('yan:openPath', p),
  backup: (action) => invoke('yan:backup', action),
  storage: {
    info: () => invoke('yan:storage:info'),
    pick: () => invoke('yan:storage:pick'),
    schedule: (target, relaunch) => invoke('yan:storage:schedule', target, relaunch),
    cancel: () => invoke('yan:storage:cancel')
  },
  revealPath: (p) => invoke('yan:revealPath', p),
  exportHtmlImage: (p) => invoke('yan:exportHtmlImage', p),
  stashImages: (images) => invoke('yan:image:stash', images),
  copyImage: (dataUrl) => invoke('yan:image:copy', dataUrl),
  saveImage: (dataUrl, suggestedName) => invoke('yan:image:save', dataUrl, suggestedName),

  getZoom: () => invoke('yan:getZoom'),
  setUiScale: (v) => invoke('yan:setUiScale', v),

  listDir: (rel, showHidden, context?: FileRequestContext) => invoke('yan:listDir', rel, showHidden === true, context),
  watchDirs: (watchId, dirs, context) => invoke('yan:files:watch', watchId, dirs, context),
  searchFiles: (request) => invoke('yan:searchFiles', request),
  searchFileContents: (request) => invoke('yan:searchFileContents', request),
  readEditableFile: (path, cwd) => invoke('yan:readEditableFile', path, cwd),
  writeEditableFile: (path, text, expectedHash, cwd) => invoke('yan:writeEditableFile', path, text, expectedHash, cwd),
  reportUnsavedFiles: (paths) => invoke('yan:files:unsaved', paths),
  searchFileNames: (request) => invoke('yan:files:searchNames', request),
  providerQuota: (provider, monthlyBudget) => invoke('yan:providerQuota', provider, monthlyBudget),

  attachments: {
    usage: () => invoke('yan:attachments:usage'),
    read: (url) => invoke('yan:attachments:read', url),
    prune: () => invoke('yan:attachments:prune')
  },

  browser: {
    activateSession: (sessionId) => invoke('yan:browser:activateSession', sessionId),
    install: () => invoke('yan:browser:install'),
    getState: (sessionId) => invoke('yan:browser:getState', sessionId),
    open: (url, sessionId) => invoke('yan:browser:open', url, sessionId),
    observe: () => invoke('yan:browser:observe'),
    network: () => invoke('yan:browser:network'),
    newTab: (url, sessionId) => invoke('yan:browser:newTab', url, sessionId),
    switchTab: (id, sessionId) => invoke('yan:browser:switchTab', id, sessionId),
    closeTab: (id, sessionId) => invoke('yan:browser:closeTab', id, sessionId),
    close: (sessionId) => invoke('yan:browser:close', sessionId),
    navigate: (url, sessionId) => invoke('yan:browser:navigate', url, sessionId),
    siteAccess: (sessionId, url) => invoke('yan:browser:siteAccess', sessionId, url),
    remoteImage: (sessionId, url, prompt) => invoke('yan:browser:remoteImage', sessionId, url, prompt),
    allowedSites: () => invoke('yan:browser:allowedSites'),
    addAllowedSite: (value) => invoke('yan:browser:addAllowedSite', value),
    removeAllowedSite: (value) => invoke('yan:browser:removeAllowedSite', value),
    clearAllowedSites: () => invoke('yan:browser:clearAllowedSites'),
    siteAskAnswer: (id, allowed) => invoke('yan:browser:siteAskAnswer', id, allowed),
    back: (sessionId) => invoke('yan:browser:back', sessionId),
    forward: (sessionId) => invoke('yan:browser:forward', sessionId),
    reload: (sessionId) => invoke('yan:browser:reload', sessionId),
    openExternal: (url, sessionId) => invoke('yan:browser:openExternal', url, sessionId),
    releaseUserControl: (sessionId) => invoke('yan:browser:releaseUserControl', sessionId),
    openExternalChrome: (url) => invoke('yan:browser:openExternalChrome', url),
    closeExternalChrome: () => invoke('yan:browser:closeExternalChrome'),
    syncLocalProfile: () => invoke('yan:browser:syncLocalProfile'),
    syncPageStorage: () => invoke('yan:browser:syncPageStorage'),
    startLoginImport: () => invoke('yan:browser:startLoginImport'),
    loginImportStatus: (id) => invoke('yan:browser:loginImportStatus', id),
    cancelLoginImport: (id) => invoke('yan:browser:cancelLoginImport', id),
    setPermission: (permission, origin, allowed) => invoke('yan:browser:setPermission', permission, origin, allowed),
    setBounds: (bounds: BrowserBounds) => invoke('yan:browser:setBounds', bounds),
    setVisible: (visible: boolean) => invoke('yan:browser:setVisible', visible),
    snapshot: () => invoke('yan:browser:snapshot'),
    setViewport: (viewport: BrowserViewport) => invoke('yan:browser:setViewport', viewport),
    localServers: () => invoke('yan:browser:localServers'),
    stopLocalServer: (port) => invoke('yan:browser:stopLocalServer', port)
  },

  office: {
    preview: (path, cwd) => invoke('yan:office:preview', path, cwd)
  },

  voice: {
    available: () => invoke('yan:voice:available'),
    prepare: () => invoke('yan:voice:prepare'),
    status: () => invoke('yan:voice:status'),
    plan: (target) => invoke('yan:voice:plan', target),
    download: (planId) => invoke('yan:voice:download', planId),
    cancel: () => invoke('yan:voice:cancel'),
    pick: (kind) => invoke('yan:voice:pick', kind),
    transcribe: (wav, language) => invoke('yan:voice:transcribe', wav, language)
  },

  android: {
    status: () => invoke('yan:android:status'),
    install: (ids) => invoke('yan:android:install', ids),
    cancel: () => invoke('yan:android:cancel'),
    openSdkDir: () => invoke('yan:android:openSdkDir'),
    devices: () => invoke('yan:android:devices'),
    boot: (avd) => invoke('yan:android:boot', avd),
    watch: (serial) => invoke('yan:android:watch', serial),
    control: (serial, action) => invoke('yan:android:control', serial, action),
    onFrame: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, frame: AndroidFrame): void => cb(frame)
      ipcRenderer.on('yan:android-frame', listener)
      return () => {
        ipcRenderer.removeListener('yan:android-frame', listener)
      }
    }
  },

  remote: {
    status: () => invoke('yan:remote:status'),
    configure: (settings) => invoke('yan:remote:configure', settings),
    pair: () => invoke('yan:remote:pair'),
    cancelPairing: () => invoke('yan:remote:cancelPairing'),
    revoke: (deviceId) => invoke('yan:remote:revoke', deviceId),
    forget: (deviceId) => invoke('yan:remote:forget', deviceId),
    relayPair: (kind) => invoke('yan:remote:relayPair', kind),
    relayCancel: () => invoke('yan:remote:relayCancel'),
    relayRevoke: (id) => invoke('yan:remote:relayRevoke', id),
    relayForget: (id) => invoke('yan:remote:relayForget', id),
    resetIdentity: () => invoke('yan:remote:resetIdentity')
  },

  terminal: {
    available: () => invoke('yan:terminal:available'),
    list: () => invoke('yan:terminal:list'),
    start: (request) => invoke('yan:terminal:start', request),
    write: (id, data) => invoke('yan:terminal:write', id, data),
    resize: (id, cols, rows) => invoke('yan:terminal:resize', id, cols, rows),
    kill: (id) => invoke('yan:terminal:kill', id),
    attach: (id) => invoke('yan:terminal:attach', id),
    clear: (id) => invoke('yan:terminal:clear', id),
    processes: (id) => invoke('yan:terminal:processes', id),
    jobs: () => invoke('yan:terminal:jobs'),
    stopJob: (id) => invoke('yan:terminal:jobStop', id),
    clearJobs: (ids) => invoke('yan:terminal:jobsClear', ids)
  },

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    setAlwaysOnTop: (v) => invoke('win:setAlwaysOnTop', v),
    requestExit: () => invoke('win:requestExit'),
    lifecycle: () => invoke('win:lifecycle')
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
    state: (): Promise<unknown> => invokeUnmapped('yan:aux:quick-ask:state'),
    submit: (payload: QuickAskSubmit): Promise<unknown> => invokeUnmapped('yan:aux:quick-ask:submit', payload),
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
