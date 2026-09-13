import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  Attachment,
  AttentionNotify,
  BrowserBounds,
  BrowserObservation,
  BrowserState,
  ChromeSyncReport,
  AuthProviderInfo,
  CompactionInfo,
  CustomEntry,
  DirListing,
  ForkPoint,
  MainPush,
  ModelInfo,
  PeekResult,
  PiInfo,
  PiProbe,
  ProviderQuota,
  SessionState,
  SessionStats,
  SessionSummary,
  SessionTodo,
  SlashCommand,
  UIMessage,
  YanBridge,
  ZoomState
} from '../shared/ipc'

/**
 * 白名单桥 —— renderer 全程 nodeIntegration:false + contextIsolation:true。
 * 这里的方法就是渲染端能碰到的**全部**能力（HANDOFF §9 原则 3）。
 *
 * api 显式标注成 YanBridge：形态对不上就编译报错。
 * 这层是安全边界，值得多写点类型。
 */
const invoke = <T>(ch: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(ch, ...args) as Promise<T>

type Ok = { ok: boolean; error?: string }

const api: YanBridge = {
  /* ---- 会话 ---- */
  start: () =>
    invoke<{ ok: boolean; error?: string; state?: SessionState; settings?: AppSettings }>('yan:start'),
  send: (text, images) => invoke<Ok>('yan:send', text, images),
  steer: (text) => invoke<Ok>('yan:steer', text),
  followUp: (text) => invoke<Ok>('yan:followUp', text),
  steerQueued: (text) => invoke<Ok>('yan:steerQueued', text),
  abort: () => invoke<{ steering: string[]; followUp: string[] }>('yan:abort'),
  newSession: () => invoke<Ok>('yan:newSession'),
  switchSession: (path) => invoke<Ok>('yan:switchSession', path),
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
  setManualTitle: (sessionId, name) => invoke<{ ok: boolean }>('yan:setManualTitle', sessionId, name),
  getCustomEntries: () => invoke<CustomEntry[]>('yan:getCustomEntries'),
  refreshTodos: () => invoke<SessionTodo[]>('yan:refreshTodos'),
  listSessions: () => invoke<SessionSummary[]>('yan:listSessions'),
  peekSession: (path) => invoke<PeekResult | null>('yan:peekSession', path),

  /* ---- 模型接入（凭证） ---- */
  authProviders: (deep) => invoke<AuthProviderInfo[]>('yan:authProviders', deep),
  setApiKey: (provider, key) => invoke<Ok>('yan:setApiKey', provider, key),
  clearAuth: (provider) => invoke<Ok>('yan:clearAuth', provider),
  authFileInfo: () => invoke<{ path: string; exists: boolean; count: number }>('yan:authFileInfo'),
  completePath: (prefix) => invoke<string[]>('yan:completePath', prefix),

  /* ---- 附件 ---- */
  pickImages: () => invoke<Attachment[]>('yan:pickImages'),

  /* ---- 设置 ---- */
  getSettings: () => invoke<AppSettings>('yan:getSettings'),
  patchSettings: (patch) => invoke<AppSettings>('yan:patchSettings', patch),
  pickCwd: () => invoke<string | null>('yan:pickCwd'),
  setCwd: (cwd) => invoke<Ok>('yan:setCwd', cwd),

  /* ---- 扩展 UI 应答（单向） ---- */
  respondUi: (res) => ipcRenderer.send('yan:respondUi', res),

  /* ---- 系统通知（声音提示的通知开关用） ---- */
  notifyAttention: (n: AttentionNotify) =>
    invoke<{ shown: boolean; simulated?: boolean; error?: string }>('yan:notifyAttention', n),

  /* ---- 诊断 ---- */
  probePi: () => invoke<PiProbe>('yan:probePi'),
  openPath: (p) => invoke<void>('yan:openPath', p),
  revealPath: (p) => invoke<void>('yan:revealPath', p),

  /* ---- 界面缩放（0 = 自动） ---- */
  getZoom: () => invoke<ZoomState>('yan:getZoom'),
  setUiScale: (v) => invoke<ZoomState>('yan:setUiScale', v),

  /* ---- 文件树 ---- */
  listDir: (rel, showHidden) => invoke<DirListing>('yan:listDir', rel, showHidden === true),
  compactionInfo: (win) => invoke<CompactionInfo>('yan:compactionInfo', win),
  providerQuota: (provider, monthlyBudget) => invoke<ProviderQuota>('yan:providerQuota', provider, monthlyBudget),

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
    setUserControl: (value) => invoke<BrowserState>('yan:browser:setUserControl', value),
    setBounds: (bounds: BrowserBounds) => invoke<void>('yan:browser:setBounds', bounds)
  },

  /* ---- 窗口 ---- */
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    setAlwaysOnTop: (v) => invoke<boolean>('win:setAlwaysOnTop', v)
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
  }
}

contextBridge.exposeInMainWorld('yan', api)
