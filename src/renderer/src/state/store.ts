import { create } from 'zustand'
import type {
  AppSettings,
  Attachment,
  AuthProviderInfo,
  BrowserState,
  ChromeSyncReport,
  ExtensionUiRequest,
  QuestionLogEntry,
  ApprovalReceipt,
  MainPush,
  MessagePatch,
  ModelInfo,
  PiInfo,
  QueueMode,
  QueueState,
  RuntimeEnvelope,
  RunnerStatus,
  SessionState,
  SessionStats,
  SessionSummary,
  SessionTodo,
  SessionTodoSnapshot,
  SlashCommand,
  SubagentRun,
  TerminalSessionInfo,
  UIMessage,
  UIToolCall,
  ApprovalAnswerIdentity,
  ApprovalChoice,
  ApprovalRequest,
  GitInstallProgress,
  ZoomState
} from '../../../shared/ipc'
import type { CheckpointRecord } from '../../../shared/checkpoints'
import { attentionForOutcome } from '../../../shared/turn-outcome'
import { playSound } from '../lib/sound'
import type { BrowserOpenTarget } from '../features/browser/browser-open'
import { applySyncDelta, mergePeekedHistory, mergeSyncHistory } from './session-message-merge'
import { MessagePatchBatch, createFrameFlush } from './push-coalesce'
import { cssQuoted, highlightMessageElement, locateMessageInView } from './message-locator'
import {
  type ComposerSubmitIdentity
} from './composer-recovery'
import type { QueueOp } from '../features/composer/queue-plan'
import { reuseIfSame } from './same-messages'
import { keepRef } from './stable-ref'
import {
  migratePathDraft,
  migrateSessionRuntime,
  pruneSessionRuntimes,
  reduceSessionRuntime,
  patchArtifact,
  seedRuntimeHistory,
  type SessionRuntimeMap
} from './session-runtime'
import { routePush, viewingSessionId } from './push-routing'
import { useSplitView } from './split-view'
import { pushBelongsToView, viewIdentityOf } from './view-identity'
import { consumeQuestionPush, consumeShellPush, consumeSubagentPush, consumeTaskStatePush } from './push-consumers'
import { releaseResource } from './resource-owners'
import type { SubmittingMessage } from './submitting-messages'
import { compactionErrorText } from './compaction-view'
import { uiText } from '../i18n/ui-text'
import { piCall, pushNotice, type SliceContext } from './slices/shared'
import { applyBrowserVisibility, createBrowserSlice, revealBrowserPane, revealTerminalPane } from './slices/browser'
import { createSettingsSlice } from './slices/settings'
import {
  EMPTY_QUEUE,
  findRuntimeSnapshot,
  nav,
  projectSnapshotKeepingHistory,
  runtimeFromRunner,
  sessionActionTarget,
  snapshotForView,
  switchToRuntimeSnapshot,
  viewedActiveRunner
} from './slices/runtime'
import { createSessionListSlice } from './slices/session-list'
import { createComposerSlice } from './slices/composer'
import { blankViewKey, createSendSlice, pendingSendsForView, type PendingSend } from './slices/send'
import { applyQueueRecovery, heldQueueReclaims, holdQueueReclaim, takeHeldQueueReclaim, type QueueReclaim } from './slices/queue-recovery'
import { createUiRequestsSlice } from './slices/ui-requests'
import { alertAttention, alertTurnSettled } from './slices/attention'
import { createSessionNavSlice } from './slices/session-nav'
import { createNoticesSlice } from './slices/notices'
import { createCheckpointsSlice } from './slices/checkpoints'
import { createPreviewSlice, type FilePreviewState } from './slices/preview'
import { createSubagentsSlice } from './slices/subagents'
import { createModelSlice } from './slices/model'
import { createQuotaResumeSlice, stopRetryWhenQuotaWindowFull } from './slices/quota-resume'

export { pushNotice }
export { blankViewKey, pendingSendsForView }
export type { PendingSend, FilePreviewState }

export type ConnState = 'starting' | 'ready' | 'exited' | 'error'

export type WidgetPlacement = 'aboveEditor' | 'belowEditor'

export interface Notice {
  id: string
  type: 'info' | 'warning' | 'error'
  text: string
  at: number
  action?: 'search-api-hint' | 'git-install' | 'app-update'
}

export interface Store {
  conn: ConnState
  connDetail: string
  logs: string[]
  startupPhase: boolean

  session: SessionState | null
  stats: SessionStats | null
  queue: QueueState
  pendingSends: PendingSend[]
  compactCommand: { sessionId: string; text: string } | null
  quotaResume: QuotaResumeWait | null
  runTail: { sessionId: string; id: string } | null
  messages: UIMessage[]
  sessions: SessionSummary[]
  todos: SessionTodo[]
  todoHistory: SessionTodoSnapshot[]

  models: ModelInfo[]
  thinkingLevels: string[]
  commands: SlashCommand[]
  authProviders: AuthProviderInfo[]

  settings: AppSettings | null
  settingsOpen: boolean
  nativeSessionPanel: {
    mode: import('../../../shared/native-session').NativeSessionMode | 'entries'
    sessionId: string
  } | null
  closeNativeSessionPanel: () => void
  nativeSession: (action: import('../lib/composer-submit').NativeSessionAction, args?: string) => Promise<import('../../../shared/native-session-host').NativeSessionHostResult>
  settingsTab: string
  settingsRequestRevision: number
  checkpoints: CheckpointRecord[]
  rewind: { recordId: string; preview: string } | null
  refreshCheckpoints: () => Promise<void>
  openRewind: (recordId: string, preview: string) => void
  closeRewind: () => void
  titles: Record<string, string>
  manualTitles: Record<string, string>
  autoRetryEnabled: boolean
  maximized: boolean

  alwaysOnTop: boolean
  browserState: BrowserState
  browserStates: Record<string, BrowserState>
  browserNativeVisible: boolean
  browserCover: string | null
  terminals: TerminalSessionInfo[]
  filePreview: FilePreviewState | null
  subagents: SubagentRun[]
  zoom: ZoomState | null
  piInfo: PiInfo | null
  widgets: Record<string, string[]>
  widgetPlacements: Record<string, WidgetPlacement>
  uiRequests: ExtensionUiRequest[]
  questionLogs: Record<string, QuestionLogEntry[]>
  approvalLogs: Record<string, ApprovalReceipt[]>
  uiCollapsed: boolean
  uiDrafts: Record<string, string>
  composerInsert: string | null
  notices: Notice[]
  nativeMcpStatus: { sessionId: string; pending: boolean; text: string; action?: 'login' | 'logout' | 'reconnect' } | null
  statuses: Record<string, string>
  editorInject: { text: string; mode: 'replace' | 'append' } | null
  composerFocus: { tick: number; at: number; sessionId?: string; path?: string }
  queueRestore: string | null
  attachments: Attachment[]
  pendingSourceLinks: { sessionId: string; sourceIds: string[] }[]
  submittingMessages: SubmittingMessage[]
  locateMessage: (messageId: string) => Promise<boolean>

  peekedPath: string | null
  peekedSessionId: string | null
  peekNote: { truncated: number; total: number } | null
  switchLoading: boolean
  pendingActivation: {
    sessionFile?: string
    sessionId?: string
    projectId?: string
    scope?: 'global' | 'project' | 'pending'
    cwd: string
  } | null

  activeRunnerId: string | null
  runners: RunnerStatus[]
  sessionRuntimes: SessionRuntimeMap
  approvals: ApprovalRequest[]

  bootstrap: () => Promise<void>
  syncRunners: () => Promise<void>
  applyPush: (m: MainPush) => void
  refreshSessions: () => Promise<void>
  reloadModels: () => Promise<void>
  reloadCommands: () => Promise<void>
  loadAuthProviders: () => Promise<void>
  setSessionDraft: (value: string, key?: string) => void
  hydrateComposerDraft: (key: string) => void
  injectComposerText: (text: string) => void
  redetectPi: () => Promise<void>
  commandsAt: number
  markCommandUsed: (name: string) => void
  commandUse: Record<string, number>

  send: (
    text: string,
    images?: { data: string; mimeType: string }[],
    mode?: 'steer' | 'followUp'
  ) => Promise<boolean>
  holdSend: (text: string, images?: { data: string; mimeType: string }[]) => void
  releaseSend: (id: string, mode: 'steer' | 'followUp') => Promise<void>
  restoreSend: (id: string) => void
  discardSend: (id: string) => void
  steerQueued: (queueId: string) => Promise<void>
  removeQueued: (queueId: string) => Promise<void>
  recoverComposerInput: (input: {
    identity: ComposerSubmitIdentity
    text: string
    attachments: Attachment[]
    idPrefix?: string
    notice?: string
  }) => void
  applyQueueOrder: (next: QueueState) => Promise<void>
  applyQueueOp: (op: QueueOp) => Promise<void>
  armQuotaResume: (ifWindowFull?: boolean) => Promise<boolean>
  cancelQuotaResume: () => void
  abort: () => Promise<void>
  abortTurn: () => Promise<void>
  runBash: (command: string, options?: { excludeFromContext?: boolean }) => Promise<{ ok: boolean; error?: string }>
  abortBash: () => Promise<void>
  newSession: (target?: { cwd?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; worktree?: boolean }) => Promise<{
    ok: boolean
    sessionId?: string
    runId?: string
    error?: string
  }>
  switchSession: (path: string) => Promise<void>
  pickProjectSession: (cwd: string, projectId?: string) => string | undefined
  ensureActivated: (expected?: ComposerSubmitIdentity) => Promise<boolean>
  moveSession: (sessionId: string, projectId: string | null, cwd?: string) => Promise<boolean>
  setSessionArchived: (sessionId: string, archived: boolean) => Promise<boolean>
  setSessionPinned: (sessionId: string, pinned: boolean) => Promise<boolean>
  setSessionSnoozed: (sessionId: string, until: number | null) => Promise<boolean>
  setSessionMarkedUnread: (sessionId: string, marked: boolean) => Promise<boolean>
  renameSession: (name: string) => Promise<void>
  setManualTitle: (sessionId: string, name: string) => Promise<void>
  regenerateTitle: (sessionId: string) => Promise<void>
  deleteSession: (path: string) => Promise<{ ok: boolean; undoToken?: string }>
  restoreDeletedSession: (undoToken: string) => Promise<{ ok: boolean; error?: string }>
  fork: (entryId: string) => Promise<boolean>
  clone: () => Promise<void>
  exportHtml: (outputPath?: string) => Promise<{ ok: boolean; error?: string }>
  compact: (customInstructions?: string) => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<void>

  setModel: (provider: string, id: string, quiet?: boolean) => Promise<{ ok: boolean; error?: string }>
  setThinking: (level: string) => Promise<void>
  setUltracode: (on: boolean) => Promise<void>
  setAutoCompaction: (on: boolean) => Promise<void>
  setAutoRetry: (on: boolean) => Promise<void>
  setSteeringMode: (mode: QueueMode) => Promise<void>
  setFollowUpMode: (mode: QueueMode) => Promise<void>
  abortRetry: () => Promise<void>
  cycleModel: () => Promise<void>
  cycleModelBack: () => Promise<void>
  cycleThinking: () => Promise<void>
  copyLastReply: () => Promise<void>
  setUiScale: (v: number) => Promise<void>
  openBrowser: (url?: string, target?: BrowserOpenTarget) => Promise<void>
  openLink: (url: string) => Promise<void>
  previewFile: (path: string, line?: number, cwd?: string, lineEnd?: number) => Promise<void>
  loadSubagents: () => Promise<void>
  startSubagent: (task: string, model?: string, isolation?: 'worktree' | 'controlled-cwd' | 'shared-cwd') => Promise<void>
  askSideQuestion: (question: string) => Promise<{ ok: boolean; error?: string }>
  stopSubagent: (id: string) => Promise<void>
  openExternalChrome: (url?: string) => Promise<void>
  closeExternalChrome: () => Promise<void>
  syncLocalProfile: () => Promise<ChromeSyncReport>
  syncPageStorage: () => Promise<ChromeSyncReport>
  patchSettings: (p: Partial<AppSettings>) => Promise<void>
  removeGuardAllowRoot: (path: string) => Promise<void>
  answerApproval: (id: string, choice: ApprovalChoice, identity?: ApprovalAnswerIdentity, feedback?: string) => Promise<boolean>
  gitInstall: GitInstallProgress
  installGit: () => Promise<void>
  cancelGitInstall: () => Promise<void>
  loadZoom: () => Promise<void>

  addAttachments: (a: Attachment[], identity?: ComposerSubmitIdentity) => void
  addFileRefs: (files: File[], identity?: ComposerSubmitIdentity) => Promise<void>
  addFileRefPaths: (paths: string[], identity?: ComposerSubmitIdentity) => Promise<void>
  removeAttachment: (id: string) => void
  dropSentAttachments: (sentIds: readonly string[], draftKeys: readonly string[]) => void
  clearAttachments: () => void
  pickImages: () => Promise<void>
  pickFiles: () => Promise<void>

  answerUi: (res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => Promise<boolean>
  extendUi: (id: string, extraMs?: number) => Promise<boolean>
  startUiTimer: (id: string) => Promise<boolean>
  setUiCollapsed: (v: boolean) => void
  setUiDraft: (id: string, value: string) => void
  insertIntoComposer: (text: string) => void
  clearComposerInsert: () => void
  dismissNotice: (id: string) => void
  notify: (type: Notice['type'], text: string) => void
  checkToolchainNotice: () => void
  consumeEditorInject: () => void
  requestComposerFocus: (target: { sessionId?: string; path?: string }) => void
  consumeQueueRestore: () => void
  setSettings: (s: AppSettings) => void
  applyServerSettings: (s: AppSettings) => void
  startConnWatch: () => void
  openSettings: (tab?: string) => void
  closeSettings: () => void
  toggleAlwaysOnTop: () => Promise<void>
  setRightPanelOpen: (v: boolean) => Promise<void>
  setBrowserSurfaceActive: (active: boolean) => void
  acquireOverlayBlocker: (token: string) => () => void
  log: (line: string) => void
  dismissRequest: (id: string) => void
}

export type QuotaResumeWait = {
  sessionId: string
  sessionFile?: string
  provider: string
  armedAt: number
  resetAt?: number
}

export function currentThinkingLevels(state: Pick<Store, 'session' | 'thinkingLevels'>): string[] {
  const own = state.session?.availableThinkingLevels
  return state.session?.thinkingLevelsStatus === 'known' && Array.isArray(own) ? own : state.thinkingLevels
}

export function streamingMessageId(state: Pick<Store, 'session' | 'messages' | 'runTail'>, includeAgentRunning = true): string | undefined {
  const running = state.session?.isStreaming || (includeAgentRunning && state.session?.isAgentRunning)
  const id = running ? state.messages[state.messages.length - 1]?.id : undefined
  if (!id) return undefined
  const tail = state.runTail
  return tail && tail.sessionId === state.session?.sessionId && tail.id === id ? undefined : id
}

function syncProtectedTail(state: Store, runtime: RuntimeEnvelope | undefined): string | undefined {
  if (!runtime) return undefined
  const viewing = viewingSessionId(state)
  if (viewing && runtime.sessionId && viewing !== runtime.sessionId) return undefined
  const runner = state.runners.find((item) => (item.runId ?? item.id) === runtime.runId)
  if (runner && runtime.generation !== undefined && runner.generation !== runtime.generation) return undefined
  return streamingMessageId(state)
}

function lastAssistantTextOf(messages: readonly UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && typeof message.text === 'string' && message.text.trim()) return message.text
  }
  return ''
}

export { mergePeekedHistory }

let connWatchActive = false

function patchMessage(list: UIMessage[], id: string, patch: MessagePatch): UIMessage[] {
  const i = list.findLastIndex((m) => m.id === id)
  if (i < 0) return list

  if (patch.textDelta === undefined && patch.thinkingDelta === undefined) {
    const next = list.slice()
    next[i] = { ...next[i], ...patch }
    return next
  }

  const cur = list[i]
  const { textDelta, thinkingDelta, ...rest } = patch
  const next = list.slice()
  next[i] = {
    ...cur,
    ...rest,
    ...(textDelta ? { text: (cur.text ?? '') + textDelta } : null),
    ...(thinkingDelta ? { thinking: (cur.thinking ?? '') + thinkingDelta } : null)
  }
  return next
}

let approvalBootstrapSeq = 0
let bootPushes: { state: boolean; messages: boolean } | null = null
let approvalsBootstrapped = false
let approvalChanges = new Map<string, ApprovalRequest | null>()

const pendingMessagePatches = new MessagePatchBatch()
const pendingRuntimePushes: MainPush[] = []
const messagePatchFlush = createFrameFlush(() => flushPendingMessagePatches())
const VIEW_RESYNC_GAP_MS = 3000
let viewResyncTimer: ReturnType<typeof setTimeout> | null = null
let viewResyncAt = 0
let uiRestoreAt = 0

function reduceRuntimePushes(map: SessionRuntimeMap, pushes: readonly MainPush[]): SessionRuntimeMap {
  let next = map
  for (const push of pushes) {
    if (push.runtime) next = migrateSessionRuntime(reduceSessionRuntime(next, push.runtime, push), push.runtime)
  }
  return next
}

function flushPendingMessagePatches(): void {
  messagePatchFlush.cancel()
  const drained = pendingMessagePatches.drain()
  const runtimePushes = pendingRuntimePushes.splice(0)
  if (drained.length === 0 && runtimePushes.length === 0) return
  let missing = false
  useStore.setState((state) => {
    const patch: Partial<Store> = {}
    if (runtimePushes.length) patch.sessionRuntimes = reduceRuntimePushes(state.sessionRuntimes, runtimePushes)
    if (drained.length) {
      let messages = state.messages
      for (const item of drained) {
        const before = messages
        messages = patchMessage(messages, item.id, item.patch) as typeof state.messages
        if (messages === before) missing = true
      }
      patch.messages = messages
    }
    return patch
  })
  if (missing) requestViewResync('patch-target-missing')
}

export function discardPendingMessagePatches(): void {
  pendingMessagePatches.drain()
  messagePatchFlush.cancel()
  const runtimePushes = pendingRuntimePushes.splice(0)
  if (runtimePushes.length) useStore.setState((state) => ({ sessionRuntimes: reduceRuntimePushes(state.sessionRuntimes, runtimePushes) }))
}

function requestViewResync(reason: string): void {
  if (viewResyncTimer || bootPushes) return
  viewResyncTimer = setTimeout(() => {
    viewResyncTimer = null
    viewResyncAt = Date.now()
    void window.yan.resyncView(reason).then(() => restorePendingUiRequests()).catch(() => undefined)
  }, Math.max(300, viewResyncAt + VIEW_RESYNC_GAP_MS - Date.now()))
}

async function restorePendingUiRequests(): Promise<void> {
  uiRestoreAt = Date.now()
  const pushes = await window.yan.pendingUiRequests().catch(() => [] as MainPush[])
  if (!useStore.getState().activeRunnerId) return
  for (const push of pushes) useStore.getState().applyPush(push)
}

function restoreMissingUiRequests(runners: readonly RunnerStatus[]): void {
  if (Date.now() - uiRestoreAt < VIEW_RESYNC_GAP_MS) return
  const state = useStore.getState()
  const viewing = viewingSessionId(state)
  const missing = runners.some((runner) =>
    runner.waiting &&
    !!runner.sessionId &&
    !(state.sessionRuntimes[runner.sessionId]?.uiRequests.length) &&
    !(runner.sessionId === viewing && state.uiRequests.length))
  if (missing) void restorePendingUiRequests().catch(() => undefined)
}

export const useStore = create<Store>((rawSet, get) => {
  const set = (partial: Partial<Store>): void => {
    rawSet((state) => {
      const notices = partial.notices
      if (notices && notices !== state.notices) {
        const added = notices.filter(
          (n) => n.type === 'error' && !state.notices.some((o) => o.id === n.id)
        )
        if (added.length) {
          return {
            ...partial,
            logs: [...(partial.logs ?? state.logs), ...added.map((n) => uiText('state.log.error', { text: n.text }))].slice(-200)
          }
        }
      }
      return partial
    })
  }
  const sliceCtx: SliceContext = { set, get }
  return {
  conn: 'starting',
  connDetail: '',
  ...createNoticesSlice(sliceCtx),
  startupPhase: true,

  session: null,
  stats: null,
  ...createSendSlice(sliceCtx),
  ...createSessionNavSlice(sliceCtx),
  ...createQuotaResumeSlice(sliceCtx),
  runTail: null,
  messages: [],
  ...createSessionListSlice(sliceCtx),
  todos: [],
  todoHistory: [],
  activeRunnerId: null,
  runners: [],
  sessionRuntimes: {},
  ...createUiRequestsSlice(sliceCtx),

  ...createModelSlice(sliceCtx),

  ...createSettingsSlice(sliceCtx),
  nativeSessionPanel: null,
  closeNativeSessionPanel: () => set({ nativeSessionPanel: null }),
  nativeSession: async (action, args) => {
    if (!(await get().ensureActivated())) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    const sessionId = get().session?.sessionId
    if (!sessionId) return { ok: false, error: uiText('state.error.noActiveSession') }
    if (action === 'tree' || action === 'scoped-models' || action === 'trust') {
      set({ nativeSessionPanel: { mode: action, sessionId } })
      return { ok: true }
    }
    const result = await piCall(() => window.yan.nativeSession({ action, args, expectedSessionId: sessionId }))
    if (result.ok) {
      await get().refreshSessions()
      if (action === 'reload') await Promise.all([get().reloadModels(), get().reloadCommands()])
      const message = result.url
        ? uiText('state.native.shareLink', { url: result.url })
        : result.path
          ? uiText('state.native.donePath', { path: result.path })
          : uiText('state.native.done')
      get().notify('info', message)
    }
    return result
  },
  ...createCheckpointsSlice(sliceCtx),
  ...createBrowserSlice(sliceCtx),
  terminals: [],
  ...createPreviewSlice(sliceCtx),
  ...createSubagentsSlice(sliceCtx),
  ...createComposerSlice(sliceCtx),
  statuses: {},
  widgets: {},
  widgetPlacements: {},
  piInfo: null,

  bootstrap: async () => {
    const bootstrapApprovals = ++approvalBootstrapSeq
    approvalChanges = new Map()
    approvalsBootstrapped = false
    const timedBoot = <T,>(name: string, p: Promise<T>): Promise<T> => p.finally(() => { try { performance.measure('yan:boot:' + name, 'yan:bootstrap-start') } catch { } })
    const api = window.yan
    performance.mark('yan:bootstrap-start')
    const pushed = { state: false, messages: false }
    bootPushes = pushed
    let loadedSettings: Awaited<ReturnType<typeof api.getSettings>>
    let session: Awaited<ReturnType<typeof api.getState>>
    let messages: Awaited<ReturnType<typeof api.getMessages>>
    let stats: Awaited<ReturnType<typeof api.getStats>>
    let todos: SessionTodo[]
    let titles: Record<string, string>
    let manualTitles: Record<string, string>
    let browserState: BrowserState
    try {
      ;[loadedSettings, session, messages, stats, todos, titles, manualTitles, browserState] =
      await Promise.all([
        timedBoot('settings', api.getSettings()),
        timedBoot('getState', api.getState()),
        timedBoot('getMessages', api.getMessages()),
        timedBoot('getStats', api.getStats()),
        timedBoot('todos', api.refreshTodos().catch(() => [] as SessionTodo[])),
        timedBoot('titles', api.cachedTitles().catch(() => ({}) as Record<string, string>)),
        timedBoot('manualTitles', api.manualTitles().catch(() => ({}) as Record<string, string>)),
        api.browser.getState().catch(() => ({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false } as BrowserState))
      ])
    } finally {
      if (bootPushes === pushed) bootPushes = null
    }

    performance.mark('yan:bootstrap-fetched')
    const settings = loadedSettings
    const fetchedIds = new Set(messages.map((item) => item.id))

    set({
      settings,
      session: pushed.state ? get().session : session ?? get().session,
      messages: pushed.messages ? [...messages, ...get().messages.filter((item) => !fetchedIds.has(item.id))] : messages.length ? messages : get().messages,
      stats: stats ?? get().stats,
      todos,
      titles,
      manualTitles,
      browserState
    })
    if (!browserState.open) releaseResource('browser')

    performance.mark('yan:bootstrap-set')
    void timedBoot('listSessions', get().refreshSessions())
    void timedBoot('piInfo', api.piInfo().catch(() => null)).then((info) => {
      if (info) set({ piInfo: info })
    })
    void get().reloadModels()
    void window.yan.pendingApprovals().then((approvals) => {
      if (bootstrapApprovals !== approvalBootstrapSeq) return
      const byId = new Map(approvals.map((item) => [item.id, item]))
      for (const [id, item] of approvalChanges) {
        if (item) byId.set(id, item)
        else byId.delete(id)
      }
      for (const item of get().approvals) if (!approvalChanges.has(item.id)) byId.set(item.id, item)
      set({ approvals: [...byId.values()] })
      approvalChanges.clear()
      approvalsBootstrapped = true
    }).catch(() => undefined)
    void window.yan.appUpdate
      .status()
      .then((status) => status.automatic && status.packaged && (status.phase === 'checking' || status.phase === 'idle')
        ? window.yan.appUpdate.check()
        : status)
      .then((status) => {
        if (status.phase !== 'available' && status.phase !== 'manual') return
        set({
          notices: [
            ...get().notices.filter((n) => n.id !== 'app-update'),
            { id: 'app-update', type: 'info', text: status.latest ?? '', at: Date.now(), action: 'app-update' }
          ]
        })
      })
      .catch(() => undefined)
    void get().loadZoom()
    void get().reloadCommands()
    void get().loadSubagents()
    void get().syncRunners().then(() => restorePendingUiRequests()).catch(() => undefined)
  },

  syncRunners: async () => {
    try {
      const list = await window.yan.runnerStatuses()
      const active = viewedActiveRunner(get(), list)
      set({ runners: keepRef(get().runners, list), ...(active ? { activeRunnerId: active.runId ?? active.id } : {}) })
      if (active) {
        const runtime = runtimeFromRunner(active)
        const snapshot = snapshotForView(get(), findRuntimeSnapshot(get().sessionRuntimes, runtime.sessionId, runtime.runId))
        if (snapshot) set(projectSnapshotKeepingHistory(get(), snapshot))
      }
    } catch {
    }
  },

  applyPush: (m) => {
    if (bootPushes) {
      if (m.ch === 'state') bootPushes.state = true
      else if (m.ch.startsWith('msg')) bootPushes.messages = true
    }
    if (!approvalsBootstrapped) {
      if (m.ch === 'approval') approvalChanges.set(m.payload.id, m.payload)
      else if (m.ch === 'approval-close') approvalChanges.set(m.payload.id, null)
    }

    if (m.ch === 'queue-reclaimed') {
      const current = get()
      const items = [...(m.payload.items?.steering ?? []), ...(m.payload.items?.followUp ?? [])]
      const texts = [...m.payload.steering, ...m.payload.followUp].filter((text) => text)
      const reclaimedCount = Math.max(texts.length, items.length)
      if (reclaimedCount > 0) {
        const sessionId = m.payload.sessionId
        const recovery: QueueReclaim = {
          text: texts.join('\n'),
          images: items.flatMap((item) => item.images ?? []),
          idPrefix: 'queue-image',
          notice: uiText('state.queue.reclaimed', { count: reclaimedCount })
        }
        const sameView = !!sessionId && viewingSessionId(current) === sessionId
        const patch: Partial<Store> = sameView
          ? applyQueueRecovery(current, { sessionId, ...recovery, sameSession: true })
          : { notices: pushNotice(current.notices, 'info', recovery.notice) }
        if (sessionId && !sameView) holdQueueReclaim(sessionId, recovery)
        if (sessionId) {
          const cache = patch.sessionRuntimes ?? current.sessionRuntimes
          const cached = cache[sessionId]
          if (cached) patch.sessionRuntimes = { ...cache, [sessionId]: { ...cached, queue: EMPTY_QUEUE } }
          if (sameView) patch.queue = EMPTY_QUEUE
        }
        set(patch)
      }
      return
    }

    if (m.ch !== 'msg-update') flushPendingMessagePatches()

    const s = get()

    const route = routePush(
      {
        runners: s.runners,
        activeRunnerId: s.activeRunnerId,
        sessionRuntimes: s.sessionRuntimes,
        peekedSessionId: s.peekedSessionId,
        peekedPath: s.peekedPath,
        session: s.session,
        visibleSessionIds: useSplitView.getState().split?.tiles.flatMap((tile) => tile.sessionId ? [tile.sessionId] : [])
      },
      m
    )
    if (route.patch) {
      if (m.ch === 'msg-update' && m.runtime) {
        pendingRuntimePushes.push(m)
        messagePatchFlush.schedule()
      } else set(route.patch)
    }
    if (!route.project) {
      if (m.ch === 'session-title') set({ titles: { ...get().titles, [m.payload.sessionId]: m.payload.title } })
      if (m.ch === 'ui-request' && route.patch && !m.replay) alertAttention(s.settings, 'question', m.payload.message ?? m.payload.title, undefined, null, m.runtime?.sessionId || undefined, m.payload.id)
      if (m.ch === 'turn-settled' && route.patch?.sessionRuntimes && m.payload.sessionId) {
        const event = attentionForOutcome(m.payload.outcome)
        const sid = m.payload.sessionId
        const runtime = route.patch.sessionRuntimes[sid]
        if (event && !runtime?.session?.isAgentRunning) {
          const label = s.manualTitles[sid] || s.titles[sid] || runtime?.session?.sessionName || ''
          alertTurnSettled(s.settings, event, sid, label, runtime?.messages ?? [], runtime?.session?.model ?? null)
        }
      }
      return
    }

    if (m.ch === 'quota-wait') {
      if ((m.payload as { cancel?: boolean } | undefined)?.cancel === true) get().cancelQuotaResume()
      else if ((m.payload as { ifWindowFull?: boolean } | undefined)?.ifWindowFull === true) void stopRetryWhenQuotaWindowFull()
      return
    }

    const ctx = { get, set, alertAttention, pushNotice, applyBrowserVisibility: () => applyBrowserVisibility(get), revealBrowser: () => revealBrowserPane(get, false), revealTerminal: (owner: string, terminalId: string) => revealTerminalPane(get, owner, terminalId), t: uiText }
    if (consumeShellPush(m, s, ctx) || consumeQuestionPush(m, s, ctx) || consumeSubagentPush(m, s, ctx) || consumeTaskStatePush(m, s, ctx)) return

    switch (m.ch) {
      case 'sync': {
        const incoming = m.runtime?.sessionId
        if (!pushBelongsToView(s, incoming)) break
        set({
          messages: reuseIfSame(s.messages, mergeSyncHistory(m.payload, s.messages, syncProtectedTail(s, m.runtime))) as typeof s.messages,
          peekedPath: null,
          peekedSessionId: null,
          peekNote: null
        })
        break
      }
      case 'sync-delta': {
        const incoming = m.runtime?.sessionId
        if (!pushBelongsToView(s, incoming)) break
        const next = applySyncDelta(s.messages, m.payload, syncProtectedTail(s, m.runtime))
        if (next) {
          set({
            messages: reuseIfSame(s.messages, next) as typeof s.messages,
            sessionRuntimes: seedRuntimeHistory(get().sessionRuntimes, m.runtime, next),
            peekedPath: null,
            peekedSessionId: null,
            peekNote: null
          })
          break
        }
        const requestedFrom = { runnerId: s.activeRunnerId, sessionId: s.session?.sessionId, peeked: s.peekedSessionId }
        const activeSessionId = s.runners.find((runner) => (runner.runId ?? runner.id) === s.activeRunnerId)?.sessionId
        if (requestedFrom.peeked && (requestedFrom.peeked !== incoming || activeSessionId !== incoming)) break
        void window.yan.getMessages().then((list) => {
          const latest = get()
          if (latest.activeRunnerId !== requestedFrom.runnerId) return
          if (latest.session?.sessionId !== requestedFrom.sessionId) return
          if (latest.peekedSessionId !== requestedFrom.peeked) return
          const merged = mergeSyncHistory(list, latest.messages, syncProtectedTail(latest, m.runtime))
          set({
            messages: reuseIfSame(latest.messages, merged) as typeof latest.messages,
            sessionRuntimes: seedRuntimeHistory(latest.sessionRuntimes, m.runtime, merged),
            ...(requestedFrom.peeked ? { peekedPath: null, peekedSessionId: null, peekNote: null } : {})
          })
        })
        break
      }
      case 'runners':
        {
          const active = viewedActiveRunner(s, m.payload)
          const keep = new Set([viewingSessionId(s) ?? '',
            ...(useSplitView.getState().split?.tiles.flatMap((tile) => tile.sessionId ? [tile.sessionId] : []) ?? [])])
          for (const runner of m.payload) if (runner.running || runner.waiting || runner.isActive) keep.add(runner.sessionId || `run:${runner.runId}`)
          set({ runners: keepRef(s.runners, m.payload), sessionRuntimes: pruneSessionRuntimes(get().sessionRuntimes, keep), ...(active ? { activeRunnerId: active.runId ?? active.id } : {}) })
          restoreMissingUiRequests(m.payload)
          if (active) {
            const runtime = runtimeFromRunner(active)
            const found = findRuntimeSnapshot(get().sessionRuntimes, runtime.sessionId, runtime.runId)
            let snapshot = snapshotForView(get(), found)
            if (!snapshot && found) {
              const view = get()
              const emptyView =
                !view.peekedSessionId &&
                view.messages.length === 0 &&
                view.uiRequests.length === 0 &&
                view.session?.isStreaming !== true &&
                view.session?.sessionId !== runtime.sessionId
              if (emptyView) snapshot = found
            }
            if (snapshot) set(projectSnapshotKeepingHistory(get(), snapshot))
          }
        }
        break
      case 'tray-new-session':
        void get().newSession({ scope: 'global' })
        break
      case 'tray-select-session': {
        const target = m.payload
        if (target.sessionFile) {
          void get().switchSession(target.sessionFile)
          break
        }
        nav.seq += 1
        const gate = ++nav.gate
        if (get().switchLoading) set({ switchLoading: false })
        void (async () => {
          const res = await piCall(() => window.yan.selectSession(target))
          if (gate !== nav.gate) return
          if (!res.ok) {
            set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.selectRunningFailed')) })
            return
          }
          const runId = res.runId ?? res.id
          const snapshot = findRuntimeSnapshot(
            get().sessionRuntimes,
            res.sessionId ?? target.sessionId,
            runId
          )
          set({
            ...(snapshot ? switchToRuntimeSnapshot(snapshot) : { messages: [], session: null }),
            peekedPath: null,
            peekedSessionId: res.sessionId ?? target.sessionId ?? null,
            peekNote: null,
            queue: snapshot?.queue ?? EMPTY_QUEUE,
            activeRunnerId: runId ?? null,
            stats: snapshot?.stats ?? null,
            pendingActivation: null
          })
          void get().syncRunners()
          void get().reloadModels()
          void get().reloadCommands()
        })()
        break
      }
      case 'session-title':
        set({ titles: { ...s.titles, [m.payload.sessionId]: m.payload.title } })
        break
      case 'msg-update':
        pendingMessagePatches.add(m.payload.id, m.payload.patch)
        messagePatchFlush.schedule()
        break
      case 'artifact':
        set({ messages: patchArtifact(s.messages, m.payload.messageId, m.payload.artifact) })
        break
      case 'tool': {
        const { msgId, call, outputDelta } = m.payload
        const msg = s.messages.findLast((x) => x.id === msgId)
        if (!msg) {
          requestViewResync('tool-target-missing')
          break
        }
        const calls = (msg.toolCalls ?? []).slice()
        const i = calls.findIndex((c) => c.id === call.id)
        if (i >= 0) {
          const base = calls[i]
          const merged: UIToolCall = { ...base, ...call }
          if (outputDelta) merged.output = (base.output ?? '') + outputDelta
          calls[i] = merged
        } else if (m.payload.sameArgs) {
          requestViewResync('tool-target-missing')
          break
        } else {
          calls.push(outputDelta ? { ...call, output: outputDelta } : call)
        }
        set({ messages: patchMessage(s.messages, msgId, { toolCalls: calls }) })
        break
      }
      case 'turn-settled': {
        const event = attentionForOutcome(m.payload.outcome)
        if (!event || !s.session || s.session.sessionId !== m.payload.sessionId || s.session.isAgentRunning) break
        const sid = s.session.sessionId
        const label = (sid && (s.manualTitles[sid] || s.titles[sid])) || s.session.sessionName || ''
        alertTurnSettled(s.settings, event, sid, label, s.messages)
        break
      }
      case 'attention-sound': {
        const sound = s.settings?.sound
        if (sound?.enabled && sound.events?.[m.payload.event]) playSound(m.payload.event, sound.volume)
        break
      }
      case 'state': {
        const endedRun =
          s.session?.sessionId === m.payload.sessionId && s.session?.compaction && !m.payload.compaction
            ? m.payload.lastCompaction
            : undefined
        const wasRunning = !!(s.session?.isAgentRunning || s.session?.isStreaming)
        const nowRunning = !!(m.payload.isAgentRunning || m.payload.isStreaming)
        const tailId = s.messages.at(-1)?.id
        const runTail = !nowRunning ? null
          : !wasRunning && s.session?.sessionId === m.payload.sessionId && tailId ? { sessionId: m.payload.sessionId, id: tailId }
            : s.runTail?.sessionId === m.payload.sessionId ? s.runTail : null
        const cacheNow = get().sessionRuntimes
        const migratedDrafts = migratePathDraft(cacheNow, m.payload.sessionFile, m.payload.sessionId)
        set({ session: s.session ? keepRef(s.session, m.payload) : m.payload, runTail, ...(migratedDrafts !== cacheNow ? { sessionRuntimes: migratedDrafts } : {}) })
        if (endedRun?.status === 'completed') {
          set({ notices: pushNotice(get().notices, 'info', uiText('state.compact.done')) })
        } else if (endedRun?.status === 'failed') {
          set({ notices: pushNotice(get().notices, 'error', uiText('state.compact.failed', { error: compactionErrorText(uiText, endedRun.error) })) })
        }
        if (endedRun) {
          for (const item of pendingSendsForView(get())) void get().releaseSend(item.id, 'followUp')
        }
        if (Array.isArray(m.payload.availableThinkingLevels)) {
          const levels = keepRef(get().thinkingLevels, m.payload.availableThinkingLevels)
          if (levels !== get().thinkingLevels) set({ thinkingLevels: levels })
        }
        break
      }
      case 'msg-add': {
        const patch: Partial<Store> = { messages: [...s.messages, m.payload], runTail: null }
        if (s.startupPhase) patch.startupPhase = false
        set(patch)
        if (m.payload.role === 'user') {
          const head = get().pendingSourceLinks[0]
          const sid = get().session?.sessionId
          if (head && sid && head.sessionId === sid) {
            void window.yan.sources
              .link({ sessionId: sid, sourceIds: head.sourceIds, messageId: m.payload.id })
              .then((res) => {
                if (res && !res.ok) {
                  set({ pendingSourceLinks: get().pendingSourceLinks.filter((x) => x !== head) })
                } else if (res?.ok) {
                  set({ pendingSourceLinks: get().pendingSourceLinks.filter((x) => x !== head) })
                }
              })
              .catch(() => {
                set({ pendingSourceLinks: get().pendingSourceLinks.filter((item) => item !== head) })
              })
          }
        }
        break
      }
      case 'stats':
        set({ stats: m.payload })
        break
      case 'queue':
        set({ queue: m.payload })
        break
    }
  },

  redetectPi: async () => {
    const info = await window.yan.redetectPi().catch(() => null)
    if (info) set({ piInfo: info })
    const status = await window.yan.agentStatus().catch(() => null)
    if (status) set({ conn: status.state, connDetail: status.detail })
    void get().reloadModels()
  },

  locateMessage: async (messageId) => {
    const id = String(messageId ?? '')
    if (!id) return false
    if (await locateMessageInView(id)) return true
    const quoted = cssQuoted(id)
    const el = document.querySelector(`[data-msg-id="${quoted}"], .v3-msg[data-turn-id="${quoted}"]`)
    if (!el) return false
    highlightMessageElement(el)
    return true
  },

  copyLastReply: async () => {
    const target = await sessionActionTarget(get)
    let text: string | null = null
    if (target) {
      try {
        text = await window.yan.lastAssistantText(target.expected)
      } catch {
      }
      if (!target.current()) return
    }
    if (!text) text = lastAssistantTextOf(get().messages)
    if (!text) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.error.noReplyToCopy')) })
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      set({ notices: pushNotice(get().notices, 'info', uiText('state.copy.chars', { count: text.length })) })
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.copyFailedClipboard')) })
    }
  },

  startConnWatch: () => {
    if (connWatchActive) return
    connWatchActive = true
    let tries = 0
    const tick = async (): Promise<void> => {
      const cur = get().conn
      try {
        const st = await window.yan.agentStatus()
        if (st && st.state !== get().conn) {
          set({ conn: st.state, connDetail: st.detail })
          if (st.state === 'ready' && cur !== 'ready') {
            void get().reloadModels()
            void get().reloadCommands()
            void get().refreshSessions()
          }
        }
      } catch {
      }
      if (cur === 'ready') tries = 0
      const delay = cur === 'ready' ? 5000 : tries++ < 20 ? 500 : 3000
      setTimeout(() => void tick(), delay)
    }
    void tick()
  },

  }
})

useStore.subscribe((state, previous) => {
  if (state.pendingSends === previous.pendingSends && state.session === previous.session && state.activeRunnerId === previous.activeRunnerId) return
  const identity = viewIdentityOf(state)
  if (!identity.sessionId || identity.peeked) return
  const key = blankViewKey(state)
  if (!key) return
  if (!state.pendingSends.some((item) => item.sessionId === null && item.ownerKey === key && item.navSeq === nav.seq)) return
  const sessionId = identity.sessionId
  useStore.setState({
    pendingSends: state.pendingSends.map((item) => (item.sessionId === null && item.ownerKey === key && item.navSeq === nav.seq ? { ...item, sessionId, ownerKey: undefined, navSeq: undefined } : item))
  })
})

useStore.subscribe((state, previous) => {
  if (heldQueueReclaims.size === 0) return
  if (viewingSessionId(state) === viewingSessionId(previous)) return
  const patch = takeHeldQueueReclaim(state)
  if (patch) useStore.setState(patch)
})

useStore.subscribe((state, previous) => {
  const id = viewingSessionId(state) ?? 'workspace'
  if (id === (viewingSessionId(previous) ?? 'workspace')) return
  if (state.browserState.sessionId !== id) {
    useStore.setState({ browserState: state.browserStates[id] ?? { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false } })
  }
  if (typeof window.yan?.browser?.activateSession !== 'function') return
  void window.yan.browser.activateSession(id).then((next) => {
    const current = useStore.getState()
    if ((viewingSessionId(current) ?? 'workspace') === id) useStore.setState({ browserState: next })
  }).catch(() => undefined)
})
