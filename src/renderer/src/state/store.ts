import { create } from 'zustand'
import { THINK_LABEL } from './think-label'
import { translate, type MessageKey, type TVars } from '../i18n'
import { currentLang } from '../i18n/lang'
import { toolMissingText } from '../lib/toolchain-text'
import type {
  AppSettings,
  Attachment,
  AuthProviderInfo,
  BrowserState,
  ChromeSyncReport,
  ExpectedRuntimeOwner,
  ExtensionUiRequest,
  QuestionLogEntry,
  FilePreview,
  MainPush,
  MessagePatch,
  ModelInfo,
  PiInfo,
  QueueItem,
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
  SoundEvent,
  SubagentRun,
  TerminalSessionInfo,
  UIMessage,
  UIToolCall,
  ApprovalAnswerIdentity,
  ApprovalChoice,
  ApprovalRequest,
  GitInstallProgress,
  ZoomState,
  QuotaWindow
} from '../../../shared/ipc'
import type { CheckpointRecord } from '../../../shared/checkpoints'
import { stripIpcErrorPrefix } from '../../../shared/ipc-error'
import { attentionForOutcome } from '../../../shared/turn-outcome'
import { playSound } from '../lib/sound'
import { pickProjectSession as pickProjectSessionTarget } from './project-session'
import { isCapabilityResponseStale } from './capability-request'
import { fileResourceKey } from '../../../shared/file-resource'
import { OverlayBlockers, shouldShowBrowser } from './browser-visibility'
import { BrowserOpener, type BrowserOpenTarget } from '../features/browser/browser-open'
import { markStopRequested } from '../features/session/stop-intent'
import { applySyncDelta, mergePeekedHistory, mergeSyncHistory } from './session-message-merge'
import { MessagePatchBatch, createFrameFlush } from './push-coalesce'
import { reuseSessionSummaries } from './session-list'
import { planQueueRecovery, mergeQueueAttachments, type QueueImageRef } from './queue-images'
import {
  composerDraftForView,
  composerDraftKey,
  composerSubmitIdentity,
  planComposerRecovery,
  recoveryRuntimeFor,
  sameComposerView,
  type ComposerSubmitIdentity
} from './composer-recovery'
import type { QueueOp } from '../features/composer/queue-plan'
import { blockedQuotaWindows, decideQuotaResume, QUOTA_RESUME_POLL_MS, QUOTA_RESUME_PROMPT } from '../../../shared/quota-resume'
import { reuseIfSame } from './same-messages'
import { keepRef } from './stable-ref'
import {
  migratePathDraft,
  pruneSessionRuntimes,
  sessionRuntimeKey,
  updateSessionRuntime,
  updateSessionRuntimeAt,
  type SessionRuntimeDataPatch,
  type SessionRuntimeMap,
  type SessionRuntimeSnapshot
} from './session-runtime'
import { routePush, viewingSessionId } from './push-routing'
import { beginSessionSwitch as markSessionSwitch, endSessionSwitch as unmarkSessionSwitch } from './session-activation'
import { pushBelongsToView, sameSessionFile, viewIdentityOf, viewKeyRef } from './view-identity'
import { consumeQuestionPush, consumeShellPush, consumeSubagentPush, consumeTaskStatePush } from './push-consumers'
import { useSplitView } from './split-view'
import { claimResource, releaseResource, resourceOwner } from './resource-owners'
import { conversationKeyOf, workspaceKeyFor } from './workspace-key'
import { useSubagentStopping } from './subagent-stopping'

function uiText(key: MessageKey, vars?: TVars): string {
  return translate(currentLang(), key, vars)
}

function attentionTitle(event: SoundEvent): string {
  switch (event) {
    case 'done':
      return uiText('state.attention.done')
    case 'question':
      return uiText('state.attention.question')
    case 'error':
      return uiText('state.attention.error')
  }
}

function alertAttention(settings: AppSettings | null, event: SoundEvent, body?: string, title?: string, source?: ModelInfo | null): void {
  const model = source === undefined ? useStore.getState().session?.model : source
  const sound = settings?.sound
  if (!sound?.enabled || !sound.events?.[event]) return
  playSound(event, sound.volume)
  if (sound.notifications && typeof document !== 'undefined' && !document.hasFocus()) {
    void window.yan
      .notifyAttention({ kind: event, title: title || attentionTitle(event), body, ...(model ? { model: { provider: model.provider, id: model.id } } : {}) })
      .catch(() => {
      })
  }
}

function readCommandUse(): Record<string, number> {
  try {
    const raw = localStorage.getItem('yan.cmdUse')
    const j = raw ? (JSON.parse(raw) as unknown) : null
    if (!j || typeof j !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

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
  browserNativeVisible: boolean
  terminals: TerminalSessionInfo[]
  filePreview: FilePreviewState | null
  subagents: SubagentRun[]
  zoom: ZoomState | null
  piInfo: PiInfo | null
  widgets: Record<string, string[]>
  widgetPlacements: Record<string, WidgetPlacement>
  uiRequests: ExtensionUiRequest[]
  questionLog: QuestionLogEntry[]
  questionLogSession: string | null
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
  pendingSourceLinks: { sessionId: string; sourceIds: string[]; attempts?: number }[]
  locateMessage: (messageId: string) => boolean

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
  runBash: (command: string, options?: { excludeFromContext?: boolean }) => Promise<{ ok: boolean; error?: string }>
  abortBash: () => Promise<void>
  newSession: (target?: { cwd?: string; projectId?: string; scope?: 'global' | 'project' | 'pending' }) => Promise<{
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
  renameSession: (name: string) => Promise<void>
  setManualTitle: (sessionId: string, name: string) => Promise<void>
  regenerateTitle: (sessionId: string) => Promise<void>
  deleteSession: (path: string) => Promise<void>
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
  stopSubagent: (id: string) => Promise<void>
  openExternalChrome: (url?: string) => Promise<void>
  closeExternalChrome: () => Promise<void>
  syncLocalProfile: () => Promise<ChromeSyncReport>
  syncPageStorage: () => Promise<ChromeSyncReport>
  patchSettings: (p: Partial<AppSettings>) => Promise<void>
  removeGuardAllowRoot: (path: string) => Promise<void>
  answerApproval: (id: string, choice: ApprovalChoice, identity?: ApprovalAnswerIdentity, feedback?: string) => Promise<void>
  gitInstall: GitInstallProgress
  installGit: () => Promise<void>
  cancelGitInstall: () => Promise<void>
  loadZoom: () => Promise<void>

  addAttachments: (a: Attachment[]) => void
  addFileRefs: (files: File[]) => Promise<void>
  addFileRefPaths: (paths: string[]) => Promise<void>
  removeAttachment: (id: string) => void
  dropSentAttachments: (sentIds: readonly string[], draftKeys: readonly string[]) => void
  clearAttachments: () => void
  pickImages: () => Promise<void>
  pickFiles: () => Promise<void>

  answerUi: (res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void
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

const EMPTY_QUEUE: QueueState = { steering: [], followUp: [] }

export type QuotaResumeWait = {
  sessionId: string
  sessionFile?: string
  provider: string
  armedAt: number
  resetAt?: number
}

export type PendingSend = {
  id: string
  sessionId: string | null
  text: string
  images?: { data: string; mimeType: string }[]
}

export function pendingSendsForView(s: Pick<Store, 'pendingSends' | 'peekedSessionId' | 'peekedPath' | 'session'>): PendingSend[] {
  const sessionId = viewIdentityOf(s).sessionId
  return s.pendingSends.filter((item) => item.sessionId === sessionId)
}

function runtimeFromRunner(runner: RunnerStatus): RuntimeEnvelope {
  return {
    sessionId: runner.sessionId ?? '',
    runId: runner.runId ?? runner.id,
    projectId: runner.projectId,
    generation: runner.generation
  }
}

export function streamingMessageId(state: Pick<Store, 'session' | 'messages' | 'runTail'>, includeAgentRunning = true): string | undefined {
  const running = state.session?.isStreaming || (includeAgentRunning && state.session?.isAgentRunning)
  const id = running ? state.messages[state.messages.length - 1]?.id : undefined
  if (!id) return undefined
  const tail = state.runTail
  return tail && tail.sessionId === state.session?.sessionId && tail.id === id ? undefined : id
}

export function identityForAwait(state: Pick<Store, 'session' | 'activeRunnerId' | 'runners'>): string {
  const runtime = runtimeForState(state)
  return runtime ? `${runtime.runId}|${runtime.sessionId}|${runtime.generation}` : ''
}

function runtimeForState(
  state: Pick<Store, 'session' | 'activeRunnerId' | 'runners'>
): RuntimeEnvelope | null {
  const runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
  const runId = runner?.runId ?? runner?.id ?? state.activeRunnerId
  if (!runId) return null
  return {
    sessionId: state.session?.sessionId ?? runner?.sessionId ?? '',
    runId,
    projectId: runner?.projectId,
    generation: runner?.generation ?? 0
  }
}

function syncProtectedTail(state: Store, runtime: RuntimeEnvelope | undefined): string | undefined {
  if (!runtime) return undefined
  const viewing = viewingSessionId(state)
  if (viewing && runtime.sessionId && viewing !== runtime.sessionId) return undefined
  const runner = state.runners.find((item) => (item.runId ?? item.id) === runtime.runId)
  if (runner && runtime.generation !== undefined && runner.generation !== runtime.generation) return undefined
  return streamingMessageId(state)
}

function hasComposerIdentity(id: ComposerSubmitIdentity): boolean {
  return !!(id.sessionId || id.path || id.runId)
}

function expectedRuntimeFor(state: Store, id: ComposerSubmitIdentity): ExpectedRuntimeOwner | undefined {
  const norm = (p?: string): string => (p ?? '').replace(/\\/g, '/').toLowerCase()
  const byRun = id.runId ? state.runners.find((item) => (item.runId ?? item.id) === id.runId) : undefined
  const bySession = id.sessionId && !id.sessionId.startsWith('pending:')
    ? state.runners.find((item) => item.sessionId === id.sessionId)
    : undefined
  const byPath = id.path ? state.runners.find((item) => norm(item.sessionFile) === norm(id.path)) : undefined
  let runner = byRun ?? bySession ?? byPath
  if (runner && id.sessionId && !id.sessionId.startsWith('pending:') && runner.sessionId && runner.sessionId !== id.sessionId) {
    runner = undefined
  }
  if (runner && id.path && runner.sessionFile && norm(runner.sessionFile) !== norm(id.path)) {
    runner = undefined
  }
  if (!runner && !id.sessionId && !id.path && !id.runId && state.activeRunnerId) {
    runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
  }
  if (!runner) return undefined
  const runId = runner.runId ?? runner.id
  if (!runId) return undefined
  return {
    ...(runner.sessionId ? { sessionId: runner.sessionId } : {}),
    runId,
    ...(runner.projectId ? { projectId: runner.projectId } : {}),
    ...(runner.generation !== undefined ? { generation: runner.generation } : {})
  }
}

function patchArtifact(list: UIMessage[], messageId: string, artifact: NonNullable<UIMessage['artifacts']>[number]): UIMessage[] {
  const index = list.findIndex((message) => message.id === messageId)
  if (index < 0) return list
  const current = list[index]
  if (current.artifacts?.some((item) => item.id === artifact.id)) return list
  const out = list.slice()
  out[index] = { ...current, artifacts: [...(current.artifacts ?? []), artifact] }
  return out
}

export function widgetsByPlacement(
  widgets: Record<string, string[]>,
  placements: Record<string, WidgetPlacement | undefined>
): { aboveEditor: Array<[string, string[]]>; belowEditor: Array<[string, string[]]> } {
  const aboveEditor: Array<[string, string[]]> = []
  const belowEditor: Array<[string, string[]]> = []
  for (const [key, lines] of Object.entries(widgets)) {
    if (placements[key] === 'belowEditor') belowEditor.push([key, lines])
    else aboveEditor.push([key, lines])
  }
  return { aboveEditor, belowEditor }
}

function projectRuntimeSnapshot(snapshot: SessionRuntimeSnapshot): Partial<Store> {
  const projection: Partial<Store> = {
    messages: snapshot.messages,
    stats: snapshot.stats,
    queue: snapshot.queue,
    todos: snapshot.todos,
    todoHistory: snapshot.todoHistory,
    uiRequests: snapshot.uiRequests,
    statuses: snapshot.statuses,
    widgets: snapshot.widgets,
    widgetPlacements: snapshot.widgetPlacements ?? {},
    models: snapshot.models,
    thinkingLevels: snapshot.thinkingLevels,
    commands: snapshot.commands,
    commandsAt: snapshot.commands.length ? Date.now() : 0
  }
  if (snapshot.session) projection.session = snapshot.session
  return projection
}

function projectSnapshotKeepingHistory(state: Store, snapshot: SessionRuntimeSnapshot): Partial<Store> {
  const projection = projectRuntimeSnapshot(snapshot)
  if (projection.messages) projection.messages = reuseIfSame(state.messages, projection.messages) as typeof state.messages
  if (snapshot.messagesLoaded === false && state.messages.length > 0) {
    delete projection.messages
  }
  return projection
}

function findRuntimeSnapshot(
  map: SessionRuntimeMap,
  sessionId?: string,
  runId?: string
): SessionRuntimeSnapshot | undefined {
  if (sessionId && map[sessionId]) return map[sessionId]
  if (runId) {
    const byRun = map[`run:${runId}`]
    if (byRun && (!sessionId || byRun.runtime.sessionId === sessionId)) return byRun
  }
  return undefined
}

function sameSessionPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

function findSnapshotByPath(map: SessionRuntimeMap, path: string): SessionRuntimeSnapshot | undefined {
  for (const snapshot of Object.values(map)) {
    const file = snapshot.session?.sessionFile
    if (file && sameSessionPath(file, path)) return snapshot
  }
  return undefined
}

function findNewSessionSnapshot(
  map: SessionRuntimeMap,
  sessionId: string | undefined,
  runId: string | undefined,
  generation: number | undefined
): SessionRuntimeSnapshot | undefined {
  const all = Object.values(map)
  if (sessionId) {
    const exact = all.find(
      (snapshot) =>
        snapshot.runtime.sessionId === sessionId &&
        (generation === undefined || snapshot.runtime.generation === generation)
    )
    if (exact) return exact
  }
  if (generation === undefined || !runId) return undefined
  return all.find(
    (snapshot) =>
      snapshot.runtime.runId === runId &&
      snapshot.runtime.generation === generation &&
      (!sessionId ||
        !snapshot.runtime.sessionId ||
        snapshot.runtime.sessionId === sessionId ||
        snapshot.runtime.sessionId.startsWith('pending:'))
  )
}

export { mergePeekedHistory }


function snapshotForView(s: Store, snapshot?: SessionRuntimeSnapshot): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined
  const viewing = viewingSessionId(s)
  return !viewing || snapshot.runtime.sessionId === viewing ? snapshot : undefined
}


export interface FilePreviewState {
  path: string
  cwd?: string
  line?: number
  lineEnd?: number
  loading: boolean
  data: FilePreview | null
  key?: string
  stale?: boolean
}

const MAX_ATTACHMENTS = 20
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const QUEUE_ATTACHMENT_LIMITS = { maxCount: MAX_ATTACHMENTS, maxImageBytes: MAX_IMAGE_BYTES }

function draftSeedRuntime(state: Store, key: string): RuntimeEnvelope {
  const cached = state.sessionRuntimes[key]
  if (cached) return cached.runtime
  const runner = state.runners.find(
    (item) =>
      item.sessionId === key ||
      `run:${item.runId ?? item.id}` === key ||
      (item.sessionFile ? `file:${item.sessionFile.replace(/\\/g, '/').toLowerCase()}` === key : false)
  )
  return {
    sessionId: key.startsWith('file:') ? '' : key,
    runId: runner?.runId ?? runner?.id ?? key,
    projectId: runner?.projectId,
    generation: runner?.generation ?? 0
  }
}

function writeDraftAttachments(
  state: Store,
  key: string,
  attachments: Attachment[]
): SessionRuntimeMap {
  if (!key) return state.sessionRuntimes
  return updateSessionRuntimeAt(state.sessionRuntimes, key, { draftAttachments: attachments }, draftSeedRuntime(state, key))
}

function applyQueueRecovery(
  current: Store,
  input: {
    sessionId?: string
    text: string
    images?: QueueImageRef[]
    attachments?: Attachment[]
    idPrefix: string
    notice?: string
    sameSession?: boolean
    draftRuntime?: RuntimeEnvelope
    draftKey?: string
  }
): Partial<Store> {
  const sameSession = input.sameSession ?? current.session?.sessionId === input.sessionId
  let recovery: { queueRestore: string | null; attachments: Attachment[]; cacheAttachments?: Attachment[] }
  let restoredCount: number
  let droppedCount: number
  if (input.attachments) {
    const plan = planComposerRecovery({
      sameView: sameSession,
      text: input.text,
      attachments: input.attachments,
      existing: current.attachments,
      limits: QUEUE_ATTACHMENT_LIMITS
    })
    recovery = plan
    restoredCount = plan.restoredAttachments
    droppedCount = plan.droppedAttachments
  } else {
    const plan = planQueueRecovery({
      sameSession,
      text: input.text,
      images: input.images,
      existing: current.attachments,
      limits: QUEUE_ATTACHMENT_LIMITS,
      idPrefix: input.idPrefix
    })
    recovery = plan
    restoredCount = plan.restoredImages
    droppedCount = plan.droppedImages
  }

  const crossKey = sameSession
    ? ''
    : input.draftKey || (input.draftRuntime ? sessionRuntimeKey(input.draftRuntime) : input.sessionId || '')
  let crossRuntimes: SessionRuntimeMap | undefined
  if (crossKey) {
    const cached = current.sessionRuntimes[crossKey]
    const seed = cached?.runtime ?? input.draftRuntime ?? draftSeedRuntime(current, crossKey)
    const dataPatch: SessionRuntimeDataPatch = {}
    if (recovery.queueRestore) {
      dataPatch.draft = [recovery.queueRestore, cached?.draft].filter(Boolean).join('\n')
    }
    if (recovery.cacheAttachments?.length) {
      const merged = mergeQueueAttachments(cached?.draftAttachments ?? [], recovery.cacheAttachments, QUEUE_ATTACHMENT_LIMITS)
      dataPatch.draftAttachments = merged.attachments
      droppedCount += merged.skipped
    }
    if (Object.keys(dataPatch).length) {
      crossRuntimes = updateSessionRuntimeAt(current.sessionRuntimes, crossKey, dataPatch, seed)
    }
  }

  let notices = current.notices
  if (droppedCount > 0) {
    notices = input.attachments
      ? pushNotice(notices, 'error', uiText('state.recover.attachmentsDropped', { count: droppedCount }))
      : pushNotice(notices, 'error', uiText('state.recover.imagesDropped', { count: droppedCount }))
  } else if (sameSession && input.notice && (recovery.queueRestore || restoredCount > 0)) {
    notices = pushNotice(notices, 'info', input.notice)
  }

  if (sameSession) {
    const patch: Partial<Store> = {}
    if (recovery.queueRestore) {
      patch.queueRestore = current.queueRestore ? `${recovery.queueRestore}\n${current.queueRestore}` : recovery.queueRestore
    }
    if (recovery.attachments !== current.attachments) {
      patch.attachments = recovery.attachments
      const key = composerDraftKey(current)
      if (key) patch.sessionRuntimes = writeDraftAttachments(current, key, recovery.attachments)
    }
    if (notices !== current.notices) patch.notices = notices
    return patch
  }

  const patch: Partial<Store> = {}
  if (crossRuntimes) patch.sessionRuntimes = crossRuntimes
  if (notices !== current.notices) patch.notices = notices
  return patch
}

interface QueueReclaim {
  text: string
  images: QueueImageRef[]
  idPrefix: string
  notice: string
}

const heldQueueReclaims = new Map<string, QueueReclaim>()

function holdQueueReclaim(sessionId: string, recovery: QueueReclaim): void {
  const held = heldQueueReclaims.get(sessionId)
  heldQueueReclaims.set(
    sessionId,
    held
      ? { ...recovery, text: [held.text, recovery.text].filter(Boolean).join('\n'), images: [...held.images, ...recovery.images] }
      : recovery
  )
}

function takeHeldQueueReclaim(state: Store): Partial<Store> | null {
  const viewing = viewingSessionId(state)
  if (!viewing) return null
  const held = heldQueueReclaims.get(viewing)
  if (!held) return null
  heldQueueReclaims.delete(viewing)
  return applyQueueRecovery(state, { ...held, sessionId: viewing, sameSession: true, notice: undefined })
}

async function imageFingerprint(base64: string): Promise<string | null> {
  try {
    const at = globalThis.atob
    if (typeof at !== 'function') return null
    const bin = at(String(base64 ?? ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)
  } catch {
    return null
  }
}

async function collectSourceIds(attachments: Attachment[], sessionId: string): Promise<string[]> {
  const out: string[] = []
  const files: string[] = []
  for (const a of attachments) {
    if (a.kind === 'file') {
      if (a.path) files.push(a.path)
      continue
    }
    if (!a.data) continue
    const fp = await imageFingerprint(a.data)
    if (fp) out.push(`image:${fp}`)
  }
  if (files.length) {
    try {
      const refs = await window.yan.sources.verifyFiles({
        sessionId,
        entries: files.map((path) => ({ path }))
      })
      for (const r of refs) if (r?.sourceId) out.push(r.sourceId)
    } catch {
    }
  }
  return [...new Set(out)]
}

let connWatchActive = false
let capabilityRequestSeq = 0
let commandRequestSeq = 0


function thinkLabelOf(level: string): string {
  const key = THINK_LABEL[level]
  return key ? uiText(key) : level
}

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

const MAX_NOTICES = 3
async function piCall<T extends { ok: boolean; error?: string }>(
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const error = stripIpcErrorPrefix(raw)
    return { ok: false, error } as T
  }
}

function pushNotice(
  list: Notice[],
  type: Notice['type'],
  text: string,
  id?: string
): Notice[] {
  if (!text.trim()) return list
  if (list.some((n) => n.text === text && Date.now() - (n.at ?? 0) < 8000)) return list
  const next = [...list, { id: id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, text, at: Date.now() }]
  return next.slice(-MAX_NOTICES)
}

let browserSurfaceActive = false
const overlayBlockers = new OverlayBlockers()
let settingsBlockerRelease: (() => void) | null = null

function browserVisibilityFor(state: Store): boolean {
  return shouldShowBrowser({
    browserOpen: state.browserState.open,
    rightPanelOpen: true,
    activeBrowserSurface: browserSurfaceActive,
    overlayBlockers: overlayBlockers.size
  })
}

let teardown = false
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => { teardown = true })
}

function applyBrowserVisibility(get: () => Store): void {
  if (teardown) return
  const desired = browserVisibilityFor(get())
  if (get().browserNativeVisible !== desired) useStore.setState({ browserNativeVisible: desired })
  void window.yan.browser.setVisible(desired)
}

function currentViewOwnerKey(view: Store): string {
  return workspaceKeyFor(viewKeyRef(view))
}

let sessionSwitchGate = 0

let sessionSwitchInFlight: { gate: number; done: Promise<void> } | null = null

function beginSessionSwitch(gate: number): () => void {
  discardPendingMessagePatches()
  let resolve!: () => void
  const done = new Promise<void>((r) => { resolve = r })
  sessionSwitchInFlight = { gate, done }
  markSessionSwitch(gate)
  return () => {
    if (sessionSwitchInFlight?.gate === gate) sessionSwitchInFlight = null
    unmarkSessionSwitch(gate)
    resolve()
  }
}

let quotaResumeGen = 0
let quotaResumeTimer: ReturnType<typeof setTimeout> | undefined

async function runQuotaResumeCheck(gen: number, known?: QuotaWindow[]): Promise<void> {
  const wait = useStore.getState().quotaResume
  if (gen !== quotaResumeGen || !wait) return
  let windows = known
  if (!windows) {
    try {
      const next = await window.yan.providerQuota(wait.provider, useStore.getState().settings?.providerBudgets?.[wait.provider])
      if (gen !== quotaResumeGen) return
      windows = next.staleError ? undefined : next.windows
    } catch {
      windows = undefined
    }
  }
  if (!windows?.length) {
    quotaResumeTimer = setTimeout(() => void runQuotaResumeCheck(gen), QUOTA_RESUME_POLL_MS)
    return
  }
  const decision = decideQuotaResume(windows, Date.now())
  if (!decision.ready) {
    useStore.setState({ quotaResume: { ...wait, resetAt: decision.resetAt } })
    quotaResumeTimer = setTimeout(() => void runQuotaResumeCheck(gen), Math.max(1000, decision.nextCheckAt - Date.now()))
    return
  }
  quotaResumeGen++
  useStore.setState({ quotaResume: null })
  if (useStore.getState().session?.sessionId !== wait.sessionId) {
    if (!wait.sessionFile) return
    await useStore.getState().switchSession(wait.sessionFile)
    if (useStore.getState().session?.sessionId !== wait.sessionId) return
  }
  if (useStore.getState().session?.isAgentRunning || useStore.getState().session?.isStreaming) return
  await useStore.getState().send(QUOTA_RESUME_PROMPT)
}
let approvalBootstrapSeq = 0
let approvalsBootstrapped = false
let approvalChanges = new Map<string, ApprovalRequest | null>()
let settingsPatchQueue: Promise<unknown> = Promise.resolve()
let rightPanelPatchSeq = 0
async function persistSettingsPatch(patch: Partial<AppSettings>): Promise<AppSettings> {
  const operation = settingsPatchQueue.then(async () => {
    const next = await window.yan.patchSettings(patch)
    useStore.setState({ settings: next })
    return useStore.getState().settings ?? next
  })
  settingsPatchQueue = operation.catch(() => undefined)
  return operation
}

type QueueEditArg = QueueState | QueueOp
type QueueEditResult = { ok: boolean; error?: string; dropped?: QueueItem[] }

function queueEditRequest(arg: QueueEditArg): Promise<QueueEditResult> {
  return (window.yan.queueEdit as unknown as (arg: QueueEditArg) => Promise<QueueEditResult>)(arg)
}

const pendingMessagePatches = new MessagePatchBatch()
const messagePatchFlush = createFrameFlush(() => flushPendingMessagePatches())

function flushPendingMessagePatches(): void {
  messagePatchFlush.cancel()
  const drained = pendingMessagePatches.drain()
  if (drained.length === 0) return
  useStore.setState((state) => {
    let messages = state.messages
    for (const item of drained) messages = patchMessage(messages, item.id, item.patch) as typeof state.messages
    return { messages }
  })
}

function discardPendingMessagePatches(): void {
  pendingMessagePatches.drain()
  messagePatchFlush.cancel()
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
  const browserOpener = new BrowserOpener({
    open: (url) => window.yan.browser.open(url),
    currentOwnerKey: () => currentViewOwnerKey(get()),
    resourceOwner: () => resourceOwner('browser'),
    claimResource: (owner) => claimResource('browser', owner),
    releaseResource: () => releaseResource('browser'),
    isBrowserOpen: () => get().browserState.open,
    setBrowserState: (browserState) => set({ browserState }),
    reveal: () => {
      if (!get().settings?.rightPanelOpen) void get().setRightPanelOpen(true)
      applyBrowserVisibility(get)
    },
    blocked: (reason) => {
      const text =
        reason === 'foreign-owner'
          ? uiText('state.browser.foreignOwner')
          : uiText('state.browser.busy')
      set({ notices: pushNotice(get().notices, 'warning', text) })
    },
    failed: (message) => {
      set({ notices: pushNotice(get().notices, 'error', stripIpcErrorPrefix(message)) })
    }
  })
  const settleQueueEdit = async (sessionId: string | undefined, res: QueueEditResult): Promise<void> => {
    if (res.ok) return
    const dropped = res.dropped ?? []
    if (dropped.length) {
      const current = get()
      set(applyQueueRecovery(current, {
        sessionId,
        text: dropped.map((item) => item.text ?? '').filter((text) => text).join('\n'),
        images: dropped.flatMap((item) => item.images ?? []),
        idPrefix: 'queue-image',
        notice: uiText('state.queue.editFailedRestored')
      }))
    }
    set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.queueEditFailed')) })
  }
  return {
  conn: 'starting',
  connDetail: '',
  logs: [],
  startupPhase: true,

  session: null,
  stats: null,
  queue: EMPTY_QUEUE,
  pendingSends: [],
  compactCommand: null,
  quotaResume: null,
  runTail: null,
  messages: [],
  sessions: [],
  todos: [],
  todoHistory: [],
  activeRunnerId: null,
  runners: [],
  sessionRuntimes: {},
  approvals: [],
  gitInstall: { phase: 'idle' },

  models: [],
  thinkingLevels: [],
  commands: [],
  commandsAt: 0,
  authProviders: [],
  commandUse: readCommandUse(),

  settings: null,
  settingsOpen: false,
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
  settingsTab: 'appearance',
  settingsRequestRevision: 0,
  checkpoints: [],
  rewind: null,
  titles: {},
  manualTitles: {},
  autoRetryEnabled: true,
  maximized: false,
  alwaysOnTop: false,
  browserState: { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
  browserNativeVisible: false,
  terminals: [],
  filePreview: null,
  subagents: [],
  zoom: null,
  uiRequests: [],
  questionLog: [],
  questionLogSession: null,
  uiCollapsed: false,
  uiDrafts: {},
  composerInsert: null,
  notices: [],
  nativeMcpStatus: null,
  statuses: {},
  widgets: {},
  widgetPlacements: {},
  piInfo: null,
  editorInject: null,
  composerFocus: { tick: 0, at: 0 },
  queueRestore: null,
  attachments: [],
  pendingSourceLinks: [],
  peekedPath: null,
  peekedSessionId: null,
  peekNote: null,
  switchLoading: false,
  pendingActivation: null,

  bootstrap: async () => {
    const bootstrapApprovals = ++approvalBootstrapSeq
    approvalChanges = new Map()
    approvalsBootstrapped = false
    const timedBoot = <T,>(name: string, p: Promise<T>): Promise<T> => p.finally(() => { try { performance.measure('yan:boot:' + name, 'yan:bootstrap-start') } catch { } })
    const api = window.yan
    performance.mark('yan:bootstrap-start')
    const [loadedSettings, sessions, session, messages, stats, todos, titles, manualTitles, browserState] =
      await Promise.all([
        timedBoot('settings', api.getSettings()),
        timedBoot('listSessions', api.listSessions()),
        timedBoot('getState', api.getState()),
        timedBoot('getMessages', api.getMessages()),
        timedBoot('getStats', api.getStats()),
        timedBoot('todos', api.refreshTodos().catch(() => [] as SessionTodo[])),
        timedBoot('titles', api.cachedTitles().catch(() => ({}) as Record<string, string>)),
        timedBoot('manualTitles', api.manualTitles().catch(() => ({}) as Record<string, string>)),
        api.browser.getState().catch(() => ({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false } as BrowserState))
      ])

    performance.mark('yan:bootstrap-fetched')
    const settings = loadedSettings

    set({
      settings,
      sessions,
      session: session ?? get().session,
      messages: messages.length ? messages : get().messages,
      stats: stats ?? get().stats,
      todos,
      titles,
      manualTitles,
      browserState
    })
    if (!browserState.open) releaseResource('browser')

    performance.mark('yan:bootstrap-set')
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
    void get().syncRunners()
  },

  syncRunners: async () => {
    try {
      const list = await window.yan.runnerStatuses()
      const active = list.find((r) => r.isActive)
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
    if (route.patch) set(route.patch)
    if (!route.project) {
      if (m.ch === 'ui-request' && route.patch) alertAttention(s.settings, 'question', m.payload.message ?? m.payload.title, undefined, null)
      return
    }

    if (m.ch === 'quota-wait') {
      void get().armQuotaResume((m.payload as { ifWindowFull?: boolean } | undefined)?.ifWindowFull === true)
      return
    }

    const ctx = { get, set, alertAttention, pushNotice, applyBrowserVisibility: () => applyBrowserVisibility(get), t: uiText }
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
            peekedPath: null,
            peekedSessionId: null,
            peekNote: null
          })
          break
        }
        const requestedFrom = { runnerId: s.activeRunnerId, sessionId: s.session?.sessionId, peeked: s.peekedSessionId }
        if (requestedFrom.peeked) break
        void window.yan.getMessages().then((list) => {
          const latest = get()
          if (latest.activeRunnerId !== requestedFrom.runnerId) return
          if (latest.session?.sessionId !== requestedFrom.sessionId) return
          if (latest.peekedSessionId !== requestedFrom.peeked) return
          set({
            messages: reuseIfSame(
              latest.messages,
              mergeSyncHistory(list, latest.messages, syncProtectedTail(latest, m.runtime))
            ) as typeof latest.messages
          })
        })
        break
      }
      case 'runners':
        {
          const active = m.payload.find((runner) => runner.isActive)
          const keep = new Set([viewingSessionId(s) ?? '',
            ...(useSplitView.getState().split?.tiles.flatMap((tile) => tile.sessionId ? [tile.sessionId] : []) ?? [])])
          for (const runner of m.payload) if (runner.running || runner.waiting || runner.isActive) keep.add(runner.sessionId || `run:${runner.runId}`)
          set({ runners: keepRef(s.runners, m.payload), sessionRuntimes: pruneSessionRuntimes(get().sessionRuntimes, keep), ...(active ? { activeRunnerId: active.runId ?? active.id } : {}) })
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
        const gate = ++sessionSwitchGate
        if (get().switchLoading) set({ switchLoading: false })
        void (async () => {
          const res = await piCall(() => window.yan.selectSession(target))
          if (gate !== sessionSwitchGate) return
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
            ...(snapshot ? projectRuntimeSnapshot(snapshot) : { messages: [], session: null }),
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
        if (!msg) break
        const calls = (msg.toolCalls ?? []).slice()
        const i = calls.findIndex((c) => c.id === call.id)
        if (i >= 0) {
          const base = calls[i]
          const merged: UIToolCall = { ...base, ...call }
          if (outputDelta) merged.output = (base.output ?? '') + outputDelta
          calls[i] = merged
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
        const reply = [...s.messages].reverse().find((msg) => msg.role === 'assistant' && msg.text.trim())?.text ?? ''
        const excerpt = reply.replace(/[#>*_`|]+/g, ' ').replace(/\s+/g, ' ').trim()
        const body = excerpt.length > 120 ? `${excerpt.slice(0, 119)}…` : excerpt
        alertAttention(s.settings, event, body || undefined, label ? `${attentionTitle(event)} · ${label}` : undefined)
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
          set({ notices: pushNotice(get().notices, 'error', uiText('state.compact.failed', { error: endedRun.error ?? uiText('state.error.unknownReason') })) })
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
                const latest = get().pendingSourceLinks.find((item) => item === head)
                if (latest && (latest as { attempts?: number }).attempts === undefined) {
                  set({ pendingSourceLinks: get().pendingSourceLinks.map((item) => item === head ? { ...item, attempts: 1 } : item) })
                } else if (latest && ((latest as { attempts: number }).attempts < 3)) {
                  set({ pendingSourceLinks: get().pendingSourceLinks.map((item) => item === head ? { ...item, attempts: (latest as { attempts: number }).attempts + 1 } : item) })
                } else if (latest) {
                  set({ pendingSourceLinks: get().pendingSourceLinks.filter((item) => item !== head) })
                }
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

  refreshSessions: async () => {
    try {
      const listed = await window.yan.listSessions()
      const sessions = reuseSessionSummaries(get().sessions, Array.isArray(listed) ? listed : [])
      if (sessions !== get().sessions) set({ sessions })
    } catch {
    }
  },

  loadAuthProviders: async () => {
    try {
      const list = await window.yan.authProviders()
      set({ authProviders: Array.isArray(list) ? list : [] })
    } catch {
    }
  },


  reloadModels: async () => {
    const request = ++capabilityRequestSeq
    const initial = get()
    const runnerId = initial.activeRunnerId
    const sessionId = initial.session?.sessionId
    const runtime = runtimeForState(initial)
    try {
      const [models, thinkingLevels] = await Promise.all([
        window.yan.listModels(),
        window.yan.listThinkingLevels()
      ])
      const current = get()
      if (request !== capabilityRequestSeq) return
      if (
        isCapabilityResponseStale(
          { runnerId, sessionId },
          { runnerId: current.activeRunnerId, sessionId: current.session?.sessionId }
        )
      ) {
        return
      }
      const currentRuntime = runtimeForState(current) ?? runtime
      const nextModels = keepRef(current.models, models)
      const nextLevels = keepRef(current.thinkingLevels, thinkingLevels)
      const runtimeEntry = currentRuntime ? current.sessionRuntimes[sessionRuntimeKey(currentRuntime)] : undefined
      const stableModels = runtimeEntry ? keepRef(runtimeEntry.models, nextModels) : nextModels
      const stableLevels = runtimeEntry ? keepRef(runtimeEntry.thinkingLevels, nextLevels) : nextLevels
      const runtimeUnchanged =
        !!runtimeEntry &&
        runtimeEntry.models === stableModels &&
        runtimeEntry.thinkingLevels === stableLevels &&
        runtimeEntry.runtime.generation === currentRuntime?.generation
      set({
        models: nextModels,
        thinkingLevels: nextLevels,
        ...(currentRuntime && !runtimeUnchanged
          ? {
              sessionRuntimes: updateSessionRuntime(current.sessionRuntimes, currentRuntime, {
                models: stableModels,
                thinkingLevels: stableLevels
              })
            }
          : {})
      })
    } catch {
    }
  },

  reloadCommands: async () => {
    const request = ++commandRequestSeq
    const initial = get()
    const runnerId = initial.activeRunnerId
    const sessionId = initial.session?.sessionId
    const runtime = runtimeForState(initial)
    try {
      const commands = await window.yan.listCommands()
      const current = get()
      if (request !== commandRequestSeq) return
      if (
        isCapabilityResponseStale(
          { runnerId, sessionId },
          { runnerId: current.activeRunnerId, sessionId: current.session?.sessionId }
        )
      ) {
        return
      }
      const currentRuntime = runtimeForState(current) ?? runtime
      const nextCommands = keepRef(current.commands, commands)
      const runtimeEntry = currentRuntime ? current.sessionRuntimes[sessionRuntimeKey(currentRuntime)] : undefined
      const stableCommands = runtimeEntry ? keepRef(runtimeEntry.commands, nextCommands) : nextCommands
      set({
        commands: nextCommands,
        commandsAt: Date.now(),
        ...(currentRuntime && !(runtimeEntry && runtimeEntry.commands === stableCommands && runtimeEntry.runtime.generation === currentRuntime.generation)
          ? {
              sessionRuntimes: updateSessionRuntime(current.sessionRuntimes, currentRuntime, {
                commands: stableCommands
              })
            }
          : {})
      })
    } catch {
    }
  },

  setSessionDraft: (value, key) => {
    const current = get()
    key = key ?? composerDraftKey(current)
    if (!key) return
    set({
      sessionRuntimes: updateSessionRuntimeAt(current.sessionRuntimes, key, { draft: value }, draftSeedRuntime(current, key))
    })
  },

  hydrateComposerDraft: (key) => {
    const snapshot = composerDraftForView(get(), key)
    set({ attachments: snapshot.attachments })
  },

  injectComposerText: (text) => set({ editorInject: { text, mode: 'append' } }),

  redetectPi: async () => {
    const info = await window.yan.redetectPi().catch(() => null)
    if (info) set({ piInfo: info })
    const status = await window.yan.agentStatus().catch(() => null)
    if (status) set({ conn: status.state, connDetail: status.detail })
    void get().reloadModels()
  },

  markCommandUsed: (name) => {
    const next = { ...get().commandUse, [name]: (get().commandUse[name] ?? 0) + 1 }
    set({ commandUse: next })
    try {
      localStorage.setItem('yan.cmdUse', JSON.stringify(next))
    } catch {
    }
  },

  send: async (text, images, mode) => {
    const target = composerSubmitIdentity(get())
    const guardView = hasComposerIdentity(target)
    if (!(await get().ensureActivated(target))) return false
    if (guardView && !sameComposerView(get(), target)) return false
    const sessionId = get().session?.sessionId
    const sourceIds = sessionId ? await collectSourceIds(get().attachments, sessionId) : []
    if (guardView && !sameComposerView(get(), target)) return false
    if (sourceIds.length) {
      set({ pendingSourceLinks: [...get().pendingSourceLinks, { sessionId: sessionId!, sourceIds }] })
    }
    const expected = expectedRuntimeFor(get(), target)
    const res = await piCall(() => window.yan.send(text, images, mode, expected))
    if (!res.ok) {
      if (sourceIds.length) {
        set({ pendingSourceLinks: get().pendingSourceLinks.filter((x) => x.sourceIds !== sourceIds) })
      }
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.sendFailed')) })
      return false
    }
    return true
  },

  armQuotaResume: async (ifWindowFull = false) => {
    const session = get().session
    const provider = session?.model?.provider
    if (!session || !provider) return false
    if (get().quotaResume) return true
    const snapshot = await window.yan
      .providerQuota(provider, get().settings?.providerBudgets?.[provider])
      .catch(() => null)
    if (ifWindowFull) {
      if (!snapshot?.windows?.length || snapshot.staleError || !blockedQuotaWindows(snapshot.windows).length) return false
      if (get().quotaResume) return true
      await get().abortRetry()
    }
    if (!snapshot) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.unknownError')) })
      return false
    }
    if (!snapshot.windows?.length || snapshot.staleError) {
      set({ notices: pushNotice(get().notices, 'error', snapshot.staleError ?? snapshot.error ?? uiText('state.quota.noWindows')) })
      return false
    }
    const gen = ++quotaResumeGen
    set({
      quotaResume: {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        provider,
        armedAt: Date.now(),
        resetAt: decideQuotaResume(snapshot.windows, Date.now()).resetAt
      }
    })
    void runQuotaResumeCheck(gen, snapshot.windows)
    return true
  },

  cancelQuotaResume: () => {
    quotaResumeGen++
    clearTimeout(quotaResumeTimer)
    set({ quotaResume: null })
  },

  locateMessage: (messageId) => {
    const id = String(messageId ?? '')
    if (!id) return false
    const quoted = id.replace(/["\\]/g, '\\$&')
    const el = document.querySelector(`[data-msg-id="${quoted}"], .v3-msg[data-turn-id="${quoted}"]`)
    if (!el) return false
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
    el.classList.add('msg-located')
    window.setTimeout(() => el.classList.remove('msg-located'), 1800)
    return true
  },

  holdSend: (text, images) => {
    const list = get().pendingSends
    const sessionId = viewIdentityOf(get()).sessionId
    set({
      pendingSends: [
        ...list,
        { id: `ps-${Date.now().toString(36)}-${list.length}`, sessionId, text, images }
      ]
    })
  },

  releaseSend: async (id, mode) => {
    const item = pendingSendsForView(get()).find((p) => p.id === id)
    if (!item) return
    const sessionId = get().session?.sessionId
    const ok = await get().send(item.text, item.images, mode)
    if (ok && get().session?.sessionId === sessionId) {
      set({ pendingSends: get().pendingSends.filter((p) => p.id !== id) })
    }
  },

  discardSend: (id) => {
    set({ pendingSends: get().pendingSends.filter((p) => p.id !== id) })
  },

  restoreSend: (id) => {
    const item = pendingSendsForView(get()).find((p) => p.id === id)
    if (!item) return
    const sessionId = get().session?.sessionId
    const current = get()
    set({
      pendingSends: current.pendingSends.filter((p) => p.id !== id),
      ...applyQueueRecovery(current, {
        sessionId,
        text: item.text,
        images: item.images,
        idPrefix: 'pending-image'
      })
    })
  },

  steerQueued: async (queueId) => {
    if (!(await get().ensureActivated())) return
    const res = await piCall(() => window.yan.steerQueued(queueId))
    if (!res.ok) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.steerFailed'))
      })
    }
  },

  removeQueued: async (queueId) => {
    const sessionId = get().session?.sessionId
    const res = await piCall(() => window.yan.removeQueued(queueId))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.removeQueuedFailed')) })
      return
    }
    const current = get()
    set(applyQueueRecovery(current, {
      sessionId,
      text: res.text ?? '',
      images: res.images,
      idPrefix: 'queue-image',
      notice: uiText('state.queue.withdrawn')
    }))
  },

  recoverComposerInput: (input) => {
    const current = get()
    const sameView = sameComposerView(current, input.identity)
    const draftRuntime = sameView ? undefined : recoveryRuntimeFor(current, input.identity) ?? undefined
    const draftKey = sameView ? undefined : draftRuntime ? undefined : input.identity.draftKey
    set(applyQueueRecovery(current, {
      sessionId: input.identity.sessionId,
      text: input.text,
      attachments: input.attachments,
      idPrefix: input.idPrefix ?? 'composer-recover',
      notice: input.notice,
      sameSession: sameView,
      draftRuntime,
      draftKey
    }))
  },

  applyQueueOrder: async (next) => {
    const sessionId = get().session?.sessionId
    await settleQueueEdit(sessionId, await piCall(() => window.yan.queueEdit(next)))
  },

  applyQueueOp: async (op) => {
    const sessionId = get().session?.sessionId
    await settleQueueEdit(sessionId, await piCall(() => queueEditRequest(op)))
  },

  abort: async () => {
    const sessionId = get().session?.sessionId
    markStopRequested(sessionId)
    try {
      const cleared = await window.yan.abort(expectedRuntimeFor(get(), composerSubmitIdentity(get())))
      if (cleared.error) set({ notices: pushNotice(get().notices, 'error', cleared.error) })
      const back = [...cleared.steering, ...cleared.followUp].filter(Boolean)
      const items = [...(cleared.items?.steering ?? []), ...(cleared.items?.followUp ?? [])]
      const current = get()
      const texts = items.length ? items.map((item) => item.text ?? '').filter((text) => text) : back
      if (texts.length || items.some((item) => item.images?.length)) {
        set(applyQueueRecovery(current, {
          sessionId,
          text: texts.join('\n'),
          images: items.flatMap((item) => item.images ?? []),
          idPrefix: 'queue-image',
          notice: uiText('state.queue.restored', { count: texts.length })
        }))
      }
    } catch (error) {
      set({ notices: pushNotice(get().notices, 'error', error instanceof Error && error.message ? stripIpcErrorPrefix(error.message) : uiText('state.error.unknownError')) })
    }
  },

  runBash: async (command, options) => {
    const target = composerSubmitIdentity(get())
    const guardView = hasComposerIdentity(target)
    if (!(await get().ensureActivated(target))) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    if (guardView && !sameComposerView(get(), target)) return { ok: false, error: uiText('state.error.sessionSwitchedCommandSkipped') }
    const expected = expectedRuntimeFor(get(), target)
    const res = await piCall(() => window.yan.runBash(command, options, expected))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.commandFailed')) })
    }
    return res
  },

  abortBash: async () => {
    await window.yan.abortBash()
  },

  newSession: async (target) => {
    discardPendingMessagePatches()
    const gate = ++sessionSwitchGate
    if (get().switchLoading) set({ switchLoading: false })
    const res = await piCall(() => window.yan.newSession(target))
    if (gate !== sessionSwitchGate) {
      return res.ok
        ? { ok: true, sessionId: res.sessionId ?? undefined, runId: res.runId ?? res.id }
        : { ok: false, error: res.error }
    }
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.newSessionFailed')) })
      return { ok: false, error: res.error }
    }
    const before = get()
    const arrived = findNewSessionSnapshot(
      before.sessionRuntimes,
      res.sessionId ?? undefined,
      res.runId ?? res.id,
      res.generation
    )
    set({
      pendingSends: [],
      ...(res.id || res.runId ? { activeRunnerId: res.runId ?? res.id } : {}),
      ...(arrived
        ? projectRuntimeSnapshot(arrived)
        : {
            messages: [],
            session: null,
            todos: [],
            todoHistory: [],
            uiRequests: [],
            statuses: {},
            widgets: {},
            widgetPlacements: {},
            stats: null
          }),
      queue: arrived?.queue ?? EMPTY_QUEUE,
      pendingActivation: null,
      peekedPath: null,
      peekedSessionId: null,
      peekNote: null
    })
    void get().syncRunners()
    void get().reloadModels()
    void get().reloadCommands()
    await get().refreshSessions()
    return { ok: true, sessionId: res.sessionId ?? undefined, runId: res.runId ?? res.id }
  },

  pickProjectSession: (cwd, projectId) => {
    const s = get()
    return pickProjectSessionTarget({ cwd, projectId, runners: s.runners, sessions: s.sessions })
  },

  switchSession: async (path) => {
    const gate = ++sessionSwitchGate
    const finishSwitch = beginSessionSwitch(gate)
    try {
    const findSummary = () => get().sessions.find((x) => x.path === path) ?? get().sessions.find((x) => sameSessionPath(x.path, path))
    let sum = findSummary()
    const cachedSnapshot = (sum?.id ? get().sessionRuntimes[sum.id] : undefined) ??
      findSnapshotByPath(get().sessionRuntimes, path)
    const cachedMessages = cachedSnapshot?.messages
    const left = get()
    const leftView = {
      peekedPath: left.peekedPath,
      peekedSessionId: left.peekedSessionId,
      peekNote: left.peekNote,
      messages: left.messages,
      session: left.session,
      stats: left.stats,
      queue: left.queue,
      todos: left.todos,
      todoHistory: left.todoHistory,
      uiRequests: left.uiRequests,
      statuses: left.statuses,
      widgets: left.widgets,
      widgetPlacements: left.widgetPlacements,
      pendingActivation: left.pendingActivation
    }
    set({
      peekedPath: path,
      peekedSessionId: sum?.id ?? cachedSnapshot?.runtime.sessionId ?? null,
      peekNote: null,
      switchLoading: !cachedMessages?.length,
      messages: cachedMessages ?? [],
      session: cachedSnapshot?.session ?? null,
      stats: cachedSnapshot?.stats ?? null,
      queue: cachedSnapshot?.queue ?? EMPTY_QUEUE,
      todos: cachedSnapshot?.todos ?? [],
      todoHistory: cachedSnapshot?.todoHistory ?? [],
      uiRequests: cachedSnapshot?.uiRequests ?? [],
      statuses: cachedSnapshot?.statuses ?? {},
      widgets: cachedSnapshot?.widgets ?? {},
      widgetPlacements: cachedSnapshot?.widgetPlacements ?? {}
    })

    performance.mark('yan:switch-start')
    try {
      const peek = await window.yan.peekSession(path)
      if (gate !== sessionSwitchGate) return
      performance.mark('yan:switch-peeked')
      if (peek) {
        const stableId = peek.sessionId ?? sum?.id
        const before = get()
        const migrated = migratePathDraft(before.sessionRuntimes, path, stableId)
        if (peek.messages.length) {
          set({
            messages: mergePeekedHistory(peek.messages, before.messages),
            peekedPath: path,
            peekedSessionId: stableId ?? null,
            peekNote: peek.truncated > 0 ? { truncated: peek.truncated, total: peek.total } : null,
            switchLoading: false,
            ...(migrated !== before.sessionRuntimes ? { sessionRuntimes: migrated } : {})
          })
        } else if (migrated !== before.sessionRuntimes) {
          set({ sessionRuntimes: migrated })
        }
        requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('yan:switch-painted')))
      }
    } catch {
      if (gate !== sessionSwitchGate) return
    }
    if (get().switchLoading) set({ switchLoading: false })

    if (!sum && !cachedSnapshot?.session?.cwd) {
      await get().refreshSessions().catch(() => undefined)
      if (gate !== sessionSwitchGate) return
      sum = findSummary()
    }
    const cwd = sum?.cwd || cachedSnapshot?.session?.cwd || get().session?.cwd || get().settings?.cwd || ''
    const settings = get().settings
    const projectId = sum?.scope === 'global'
      ? undefined
      : (sum?.projectId ?? settings?.projects.find((project) => project.cwd.toLowerCase() === cwd.toLowerCase())?.id)
    const scope = sum?.scope ?? (projectId ? 'project' : 'global')
    const res = await piCall(() =>
      window.yan.selectSession({ sessionFile: sum?.path ?? path, sessionId: sum?.id, projectId, scope, cwd, preview: true })
    )
    performance.mark('yan:switch-selected')
    if (gate !== sessionSwitchGate) return
    if (!res.ok) {
      const leftId = viewIdentityOf(leftView).sessionId
      const leftCache = leftId ? get().sessionRuntimes[leftId] : undefined
      set({
        ...leftView,
        ...(leftCache?.messages?.length ? { messages: leftCache.messages } : {}),
        ...(leftCache?.session ? { session: leftCache.session } : {}),
        ...(leftCache?.queue ? { queue: leftCache.queue } : {}),
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.switchFailed'))
      })
      return
    }
    if (res.sessionId && !get().peekedSessionId && get().peekedPath) {
      set({ peekedSessionId: res.sessionId })
    }
    if (res.deferred) {
      set({
        pendingActivation: { sessionFile: sum?.path ?? path, sessionId: res.sessionId ?? sum?.id, projectId, scope, cwd },
        peekedPath: path,
        peekedSessionId: res.sessionId ?? sum?.id ?? null,
        notices: pushNotice(
          get().notices,
          'info',
          uiText('state.session.readOnlyNotice')
        )
      })
      void get().syncRunners()
      return
    }
    const runId = res.runId ?? res.id
    const snapshot = findRuntimeSnapshot(
      get().sessionRuntimes,
      res.sessionId ?? sum?.id,
      runId
    )
    const usable = snapshotForView(get(), snapshot)
    set({
      ...(usable ? projectSnapshotKeepingHistory(get(), usable) : {}),
      queue: usable?.queue ?? EMPTY_QUEUE,
      ...(runId ? { activeRunnerId: runId } : {}),
      pendingActivation: null
    })
    void get().syncRunners()
    void get().reloadModels()
    void get().reloadCommands()
    } finally {
      if (gate === sessionSwitchGate && get().switchLoading) set({ switchLoading: false })
      finishSwitch()
    }
  },

  ensureActivated: async (expected?: ComposerSubmitIdentity): Promise<boolean> => {
    for (let i = 0; i < 8 && sessionSwitchInFlight; i += 1) {
      await sessionSwitchInFlight.done
    }
    if (sessionSwitchInFlight) return false
    const pending = get().pendingActivation
    if (!pending) return true
    if (expected && hasComposerIdentity(expected) && !sameComposerView(get(), expected)) return false
    const gate = sessionSwitchGate
    const res = await piCall(() => window.yan.selectSession(pending))
    if (gate !== sessionSwitchGate || get().pendingActivation !== pending) return false
    if (expected && hasComposerIdentity(expected) && !sameComposerView(get(), expected)) return false
    if (!res.ok || res.deferred) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.switchFailedMessageNotSent'))
      })
      return false
    }
    const activated = get()
    set({
      pendingActivation: null,
      ...(res.runId ?? res.id ? { activeRunnerId: res.runId ?? res.id } : {}),
      ...(res.sessionId && !activated.peekedSessionId && sameSessionFile(activated.peekedPath, pending.sessionFile)
        ? { peekedSessionId: res.sessionId }
        : {})
    })
    const activatedCache = get().sessionRuntimes
    const migrated = migratePathDraft(activatedCache, pending.sessionFile, res.sessionId)
    if (migrated !== activatedCache) set({ sessionRuntimes: migrated })
    void get().syncRunners()
    void get().reloadModels()
    void get().reloadCommands()
    return true
  },

  moveSession: async (sessionId, projectId, cwd) => {
    const before = get()
    const showing = before.session?.sessionId === sessionId
    const showingPath = showing ? before.session?.sessionFile : undefined
    const res = await window.yan.moveSession(sessionId, projectId, cwd)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.moveFailed')) })
      return false
    }
    await get().refreshSessions()
    if (res.cwdChanged && showingPath && get().session?.sessionId === sessionId) await get().switchSession(showingPath)
    return true
  },

  setSessionArchived: async (sessionId, archived) => {
    const res = await window.yan.setSessionArchived(sessionId, archived)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.archiveFailed')) })
      return false
    }
    await get().refreshSessions()
    return true
  },

  setSessionPinned: async (sessionId, pinned) => {
    const res = await window.yan.setSessionPinned(sessionId, pinned)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.pinFailed')) })
      return false
    }
    await get().refreshSessions()
    return true
  },

  renameSession: async (name) => {
    const res = await piCall(() => window.yan.renameSession(name))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.renameFailed')) })
      return
    }
    await get().refreshSessions()
  },

  setManualTitle: async (sessionId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const state = get()
    const sid = sessionId || state.session?.sessionId || ''
    if (!sid) return
    const previous = state.manualTitles[sid]
    set({ manualTitles: { ...state.manualTitles, [sid]: trimmed } })
    if (sid === state.session?.sessionId) {
      await piCall(() => window.yan.renameSession(trimmed))
    }
    const res = await piCall(() => window.yan.setManualTitle(sid, trimmed))
    if (!res.ok) {
      const rolled = { ...get().manualTitles }
      if (previous === undefined) delete rolled[sid]
      else rolled[sid] = previous
      set({
        manualTitles: rolled,
        notices: pushNotice(get().notices, 'error', uiText('state.error.renameSaveFailed', { error: res.error ?? uiText('state.error.writeFailed') }))
      })
    }
    await get().refreshSessions()
  },

  regenerateTitle: async (sessionId) => {
    const sid = sessionId || get().session?.sessionId || ''
    if (!sid) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.noSessionForTitle')) })
      return
    }
    let res: { ok: boolean; title?: string; error?: string }
    try {
      res = await window.yan.regenerateTitle(sid)
    } catch (error) {
      res = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!res.ok || !res.title) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.titleFailedKept')) })
      return
    }
    if (get().manualTitles[sid]) await get().setManualTitle(sid, res.title)
    set({ notices: pushNotice(get().notices, 'info', uiText('state.title.changed', { title: res.title })) })
  },

  deleteSession: async (path) => {
    const res = await piCall(() => window.yan.deleteSession(path))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.deleteFailed')) })
      return
    }
    const cache = { ...get().sessionRuntimes }
    const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
    const removedIds = new Set(get().sessions.filter((item) => normalize(item.path) === normalize(path)).map((item) => item.id))
    for (const [key, snapshot] of Object.entries(cache)) {
      if (snapshot.session?.sessionFile && normalize(snapshot.session.sessionFile) === normalize(path)) {
        delete cache[key]
        removedIds.add(snapshot.session.sessionId)
      }
    }
    const manualTitles = { ...get().manualTitles }
    const titles = { ...get().titles }
    for (const id of removedIds) { delete manualTitles[id]; delete titles[id] }
    set({ sessionRuntimes: cache, manualTitles, titles })
    await get().refreshSessions()
  },

  fork: async (entryId) => {
    ++sessionSwitchGate
    if (get().switchLoading) set({ switchLoading: false })
    if (!(await get().ensureActivated())) return false
    const sourceRunner = get().activeRunnerId
    const res = await piCall(() => window.yan.fork(entryId))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.forkFailed')) })
      return false
    }
    let branchState: SessionState | null
    let branchMessages: UIMessage[]
    try { [branchState, branchMessages] = await Promise.all([window.yan.getState(), window.yan.getMessages()]) }
    catch (error) {
      set({ notices: pushNotice(get().notices, 'warning', uiText('state.fork.createdNotActivated', { error: String(error) })) })
      await get().refreshSessions()
      return true
    }
    if (get().activeRunnerId !== sourceRunner) {
      set({ notices: pushNotice(get().notices, 'warning', uiText('state.fork.createdSessionChanged')) })
      await get().refreshSessions()
      return true
    }
    if (branchState) set({ session: branchState, messages: branchMessages, pendingActivation: null, peekedPath: null, peekedSessionId: null, peekNote: null })
    set({
      queue: EMPTY_QUEUE,
      pendingSends: [],
      notices: pushNotice(
        get().notices,
        'info',
        res.text
          ? uiText('state.fork.beforeMessage', { text: res.text.slice(0, 30) })
          : uiText('state.fork.done')
      )
    })
    if (res.text) get().injectComposerText(res.text)
    await get().refreshSessions()
    return true
  },

  clone: async () => {
    ++sessionSwitchGate
    if (get().switchLoading) set({ switchLoading: false })
    const res = await piCall(() => window.yan.clone())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.cloneFailed')) })
      return
    }
    set({ queue: EMPTY_QUEUE, pendingSends: [], notices: pushNotice(get().notices, 'info', uiText('state.clone.done')) })
    await get().refreshSessions()
  },

  exportHtml: async (outputPath) => {
    const res = await piCall(() => window.yan.exportHtml(outputPath))
    if (res.ok) get().notify('info', uiText('state.export.done', { path: res.path ?? '' }))
    return res
  },

  compact: async (customInstructions) => {
    if (!(await get().ensureActivated())) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    const sessionId = get().session?.sessionId
    if (sessionId) set({ compactCommand: { sessionId, text: customInstructions ? `/compact ${customInstructions}` : '/compact' } })
    return piCall(() => window.yan.compact(customInstructions))
  },

  stop: async () => {
    try {
      await window.yan.abort()
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.commandFailed')) })
    }
  },

  setModel: async (provider, id, quiet = false) => {
    const res = await piCall(() => window.yan.setModel(provider, id))
    if (!res.ok) {
      if (!quiet) set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.setModelFailed')) })
      return res
    }
    const selected = get().models.find(m => m.provider === provider && m.id === id)
    try { await get().patchSettings({ lastMainModel: { provider, id, name: selected?.name } }) }
    catch (error) { return { ok: false, error: uiText('state.error.modelPrefSaveFailed', { error: String(error) }) } }
    return res
  },

  setThinking: async (level) => {
    try {
      await window.yan.setThinking(level)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.cannotSwitchThinking')) })
    }
  },

  setUltracode: async (on) => {
    const res = await piCall(() => window.yan.setUltracode(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
    }
  },

  setAutoCompaction: async (on) => {
    const res = await piCall(() => window.yan.setAutoCompaction(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
    }
  },

  setAutoRetry: async (on) => {
    const res = await piCall(() => window.yan.setAutoRetry(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
    } else {
      set({ autoRetryEnabled: on })
    }
  },

  setSteeringMode: async (mode) => {
    const res = await piCall(() => window.yan.setSteeringMode(mode))
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
  },

  setFollowUpMode: async (mode) => {
    const res = await piCall(() => window.yan.setFollowUpMode(mode))
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
  },

  abortRetry: async () => {
    try {
      await window.yan.abortRetry()
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.commandFailed')) })
    }
  },

  cycleModel: async () => {
    const res = await piCall(() => window.yan.cycleModel())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? uiText('state.error.cannotSwitchModel')) })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.model.switched', { model: res.to })) })
    }
  },

  cycleModelBack: async () => {
    const res = await piCall(() => window.yan.cycleModelBack())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? uiText('state.error.cannotSwitchModel')) })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.model.switched', { model: res.to })) })
    }
  },

  cycleThinking: async () => {
    const res = await piCall(() => window.yan.cycleThinking())
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? uiText('state.error.cannotSwitchThinking')) })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.thinking.switched', { level: thinkLabelOf(res.to) })) })
    }
  },

  copyLastReply: async () => {
    let text: string | null = null
    try {
      text = await window.yan.lastAssistantText()
    } catch {
    }
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

  setUiScale: async (v) => {
    set({ zoom: await window.yan.setUiScale(v) })
    set({ settings: await window.yan.getSettings() })
  },

  loadZoom: async () => {
    try {
      set({ zoom: await window.yan.getZoom() })
    } catch {
    }
  },

  openBrowser: async (url, target) => {
    const view = get()
    const owner = target?.key ?? (view.peekedPath || view.peekedSessionId
      ? workspaceKeyFor(viewKeyRef(view))
      : conversationKeyOf(view.session))
    await browserOpener.open({ owner, url, guard: target !== undefined })
  },

  openLink: async (url) => {
    const view = get()
    const sessionId = view.session?.sessionId ?? view.session?.conversationId ?? ''
    let decision: string
    try {
      decision = (await window.yan.browser.siteAccess(sessionId, url)).decision
    } catch {
      return
    }
    if (decision === 'deny' || decision === 'forbidden') {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.siteBlocked', { url })) })
      return
    }
    await get().openBrowser(url)
  },

  previewFile: async (path, line, cwd, lineEnd) => {
    set({ filePreview: { path, cwd, line, lineEnd, loading: true, data: null } })
    let data: Awaited<ReturnType<typeof window.yan.readPreview>>
    try { data = await window.yan.readPreview(path, line, cwd, lineEnd) }
    catch (error) {
      const cur = get().filePreview
      if (cur?.path === path && cur.cwd === cwd && cur.line === line && cur.lineEnd === lineEnd) {
        const failed = { ...cur, loading: false, data: null }
        set({ filePreview: failed, notices: pushNotice(get().notices, 'error', uiText('state.error.previewFailed', { error: String(error) })) })
      }
      return
    }
    const cur = get().filePreview
    if (!cur || cur.path !== path || cur.cwd !== cwd || cur.line !== line || cur.lineEnd !== lineEnd) return
    const settings = get().settings
    const workspaceRoot = cwd || get().session?.cwd || settings?.cwd || ''
    const projectId =
      settings?.projects.find(
        (project) => project.cwd.toLowerCase() === String(workspaceRoot).toLowerCase()
      )?.id ?? null
    const canonical = data?.abs || path
    const key = canonical
      ? fileResourceKey({ projectId: projectId ?? null, workspaceRoot, canonicalPath: canonical })
      : undefined
    const next: FilePreviewState = {
      path,
      cwd,
      line,
      lineEnd,
      loading: false,
      data,
      ...(key ? { key } : {})
    }
    set({ filePreview: next })
  },

  loadSubagents: async () => {
    try {
      const runs = await window.yan.subagents.list()
      set({ subagents: runs })
      useSubagentStopping.getState().prune(runs.filter((r) => r.status === 'starting' || r.status === 'running').map((r) => r.id))
    } catch {
    }
  },

  startSubagent: async (task, model, isolation) => {
    const res = await window.yan.subagents.start(task, model, isolation)
    if (!res.ok) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.subagentStartFailed'))
      })
      return
    }
    if (res.run) {
      const run = res.run
      const idx = get().subagents.findIndex((r) => r.id === run.id)
      set({
        subagents: idx >= 0 ? get().subagents.map((r) => (r.id === run.id ? run : r)) : [...get().subagents, run]
      })
    }
  },

  stopSubagent: async (id) => {
    useSubagentStopping.getState().mark(id)
    const res = await window.yan.subagents.stop(id).catch((): { ok: false; error?: string } => ({ ok: false }))
    if (!res.ok) {
      useSubagentStopping.getState().clear(id)
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.subagentStopFailed')) })
    }
  },

  openExternalChrome: async (url) => {
    const res = await window.yan.browser.openExternalChrome(url)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.chromeConnectFailed')) })
      return
    }
    set({ browserState: await window.yan.browser.getState() })
  },

  closeExternalChrome: async () => {
    set({ browserState: await window.yan.browser.closeExternalChrome() })
  },

  syncLocalProfile: async () => {
    const report = await window.yan.browser.syncLocalProfile()
    set({ browserState: await window.yan.browser.getState() })
    return report
  },
  syncPageStorage: async () => {
    const report = await window.yan.browser.syncPageStorage()
    set({ browserState: await window.yan.browser.getState() })
    return report
  },

  patchSettings: async (p) => {
    try {
      set({ settings: await persistSettingsPatch(p) })
    } catch (cause) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.settingsSaveFailed')) })
      throw cause
    }
  },

  removeGuardAllowRoot: async (path) => {
    try {
      set({ settings: await window.yan.removeGuardAllowRoot(path) })
    } catch (error) {
      set({ notices: pushNotice(get().notices, 'error', error instanceof Error ? error.message : String(error)) })
    }
  },

  installGit: async () => {
    set({ gitInstall: { phase: 'downloading', received: 0, message: '' } })
    try {
      const res = await window.yan.gitRuntimeInstall()
      if (!res.ok) set({ gitInstall: { phase: 'error', message: res.error ?? uiText('state.error.installFailed') } })
    } catch (error) {
      set({ gitInstall: { phase: 'error', message: error instanceof Error ? error.message : String(error) } })
    }
  },
  cancelGitInstall: async () => {
    await window.yan.gitRuntimeCancel().catch(() => undefined)
  },

  answerApproval: async (id, choice, identity, feedback) => {
    set({ approvals: get().approvals.filter((item) => item.id !== id) })
    try {
      await window.yan.answerApproval(id, choice, identity, feedback)
    } catch {
    }
  },

  addAttachments: (a) => {
    if (!a.length) return
    const existing = get().attachments
    const seen = new Set(existing.map((e) => `${e.name}|${e.size}|${e.path ?? ''}`))
    const fresh: Attachment[] = []
    for (const x of a) {
      const k = `${x.name}|${x.size}|${x.path ?? ''}`
      if (seen.has(k)) continue
      seen.add(k)
      fresh.push(x)
    }
    if (fresh.length === 0) return

    let next = [...existing, ...fresh].slice(0, MAX_ATTACHMENTS)

    const imgBytes = next.filter((x) => x.kind !== 'file').reduce((n, x) => n + x.size, 0)
    if (imgBytes > MAX_IMAGE_BYTES) {
      const kept: Attachment[] = []
      let acc = 0
      for (const x of next) {
        if (x.kind === 'file') {
          kept.push(x)
          continue
        }
        if (acc + x.size > MAX_IMAGE_BYTES) continue
        acc += x.size
        kept.push(x)
      }
      next = kept
      set({ notices: pushNotice(get().notices, 'error', uiText('state.attach.imagesTooLarge')) })
    }

    const draftKey = composerDraftKey(get())
    const after: Partial<Store> = { attachments: next }
    if (draftKey) after.sessionRuntimes = writeDraftAttachments(get(), draftKey, next)
    set(after)

    const sessionId = get().session?.sessionId
    if (sessionId) {
      for (const x of fresh) {
        if (x.kind === 'file' || !x.data) continue
        void window.yan.sources
          .addImage({ sessionId, name: x.name, mimeType: x.mimeType, base64: x.data })
          .catch(() =>
            set({ notices: pushNotice(get().notices, 'error', uiText('state.attach.imageSaveFailed')) })
          )
      }
    }
  },

  addFileRefs: async (files) => {
    if (!files.length) return
    const paths: string[] = []
    for (const f of files) {
      try {
        const p = window.yan.pathForFile(f)
        if (p) paths.push(p)
      } catch {
      }
    }
    if (!paths.length) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.attach.noFilePath')) })
      return
    }

    await get().addFileRefPaths(paths)
  },

  addFileRefPaths: async (paths) => {
    const unique = [...new Set(paths.filter(Boolean))]
    if (!unique.length) return

    let infos: Awaited<ReturnType<typeof window.yan.describeFiles>>
    try {
      infos = await window.yan.describeFiles(unique)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.cannotReference')) })
      return
    }

    const refs: Attachment[] = []
    const errors: string[] = []
    for (const info of infos) {
      if (!info.ok) {
        errors.push(uiText('state.attach.refEntry', { name: info.name, error: info.error ?? uiText('state.error.cannotReference') }))
        continue
      }
      refs.push({
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: info.name,
        mimeType: info.mimeType,
        size: info.size,
        data: '',
        preview: '',
        kind: 'file',
        path: info.path
      })
    }
    if (refs.length) get().addAttachments(refs)
    if (errors.length) set({ notices: pushNotice(get().notices, 'error', errors.join(uiText('state.attach.refErrorsJoin'))) })
  },

  removeAttachment: (id) => {
    const current = get()
    const next = current.attachments.filter((a) => a.id !== id)
    const draftKey = composerDraftKey(current)
    set({
      attachments: next,
      ...(draftKey ? { sessionRuntimes: writeDraftAttachments(current, draftKey, next) } : {})
    })
  },

  dropSentAttachments: (sentIds, draftKeys) => {
    if (!sentIds.length) return
    const sent = new Set(sentIds)
    const current = get()
    let state: Store = current
    for (const key of new Set([...draftKeys, composerDraftKey(current)])) {
      const cached = key ? state.sessionRuntimes[key]?.draftAttachments ?? [] : []
      if (!cached.some((item) => sent.has(item.id))) continue
      state = { ...state, sessionRuntimes: writeDraftAttachments(state, key, cached.filter((item) => !sent.has(item.id))) }
    }
    const attachments = current.attachments.filter((item) => !sent.has(item.id))
    set({
      ...(attachments.length !== current.attachments.length ? { attachments } : {}),
      ...(state.sessionRuntimes !== current.sessionRuntimes ? { sessionRuntimes: state.sessionRuntimes } : {})
    })
  },

  clearAttachments: () => {
    const current = get()
    const draftKey = composerDraftKey(current)
    set({
      attachments: [],
      ...(draftKey ? { sessionRuntimes: writeDraftAttachments(current, draftKey, []) } : {})
    })
  },

  pickImages: async () => {
    try {
      get().addAttachments(await window.yan.pickImages())
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.pickFailed')) })
    }
  },

  pickFiles: async () => {
    try {
      const paths = await window.yan.pickFilePaths()
      if (paths.length) await get().addFileRefPaths(paths)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.pickFailed')) })
    }
  },

  answerUi: (res) => {
    window.yan.respondUi(res)
    const drafts = { ...get().uiDrafts }
    delete drafts[res.id]
    const next = get().uiRequests.filter((r) => r.id !== res.id)
    const runtime = runtimeForState(get())
    set({
      uiRequests: next,
      uiDrafts: drafts,
      ...(runtime
        ? { sessionRuntimes: updateSessionRuntime(get().sessionRuntimes, runtime, { uiRequests: next }) }
        : {})
    })
  },

  setUiCollapsed: (v) => set({ uiCollapsed: v }),

  setUiDraft: (id, value) => set({ uiDrafts: { ...get().uiDrafts, [id]: value } }),
  insertIntoComposer: (text) => set({ composerInsert: text }),
  clearComposerInsert: () => set({ composerInsert: null }),

  extendUi: async (id, extraMs) => {
    const res = await window.yan.extendUi(id, extraMs)
    if (!res.ok) return false
    if (res.deadline) {
      set({
        uiRequests: get().uiRequests.map((r) =>
          r.id === id ? { ...r, timeout: res.timeout ?? r.timeout, deadline: res.deadline } : r
        )
      })
    }
    return true
  },

  startUiTimer: async (id) => {
    const res = await window.yan.startUiTimer(id).catch(() => null)
    if (!res?.ok || !res.deadline) return false
    set({
      uiRequests: get().uiRequests.map((r) =>
        r.id === id ? { ...r, timeout: res.timeout ?? r.timeout, deadline: res.deadline } : r
      )
    })
    return true
  },

  dismissRequest: (id) => {
    const drafts = { ...get().uiDrafts }
    delete drafts[id]
    const next = get().uiRequests.filter((r) => r.id !== id)
    const runtime = runtimeForState(get())
    set({
      uiRequests: next,
      uiDrafts: drafts,
      ...(runtime
        ? { sessionRuntimes: updateSessionRuntime(get().sessionRuntimes, runtime, { uiRequests: next }) }
        : {})
    })
  },

  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  notify: (type, text) => set({ notices: pushNotice(get().notices, type, text) }),
  checkToolchainNotice: () => {
    void window.yan
      .toolchainStatus()
      .then((tools) => {
        const missing = [tools.bash, tools.git].filter((tool) => !tool.ok && tool.reason)
        if (!missing.length) return
        if (tools.platform === 'win32') {
          set({
            notices: [
              ...get().notices.filter((n) => n.id !== 'git-install'),
              { id: 'git-install', type: 'warning', text: uiText('notice.toolsMissing'), at: Date.now(), action: 'git-install' }
            ]
          })
        } else {
          for (const tool of missing) get().notify('warning', toolMissingText(tool.reason, uiText))
        }
      })
      .catch(() => undefined)
  },
  consumeEditorInject: () => set({ editorInject: null }),
  requestComposerFocus: (target) => set({ composerFocus: { tick: get().composerFocus.tick + 1, at: Date.now(), sessionId: target.sessionId, path: target.path } }),
  consumeQueueRestore: () => set({ queueRestore: null }),
  setSettings: (s) => set({ settings: s }),
  applyServerSettings: (s) => {
    const operation = settingsPatchQueue.then(async () => {
      useStore.setState({ settings: s })
    })
    settingsPatchQueue = operation.catch(() => undefined)
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

  openSettings: (tab) => {
    if (!settingsBlockerRelease) settingsBlockerRelease = get().acquireOverlayBlocker('settings')
    set({
      settingsOpen: true,
      settingsTab: tab ?? 'appearance',
      settingsRequestRevision: get().settingsRequestRevision + 1
    })
  },
  closeSettings: () => {
    set({ settingsOpen: false })
    settingsBlockerRelease?.()
    settingsBlockerRelease = null
  },
  refreshCheckpoints: async () => {
    try {
      const list = await window.yan.checkpoints.list()
      const prev = get().checkpoints
      if (prev.length === list.length && prev.every((r, i) => r.id === list[i].id)) return
      set({ checkpoints: list })
    } catch {
    }
  },
  openRewind: (recordId, preview) => set({ rewind: { recordId, preview } }),
  closeRewind: () => set({ rewind: null }),
  toggleAlwaysOnTop: async () => {
    const next = !get().alwaysOnTop
    const previous = !next
    set({ alwaysOnTop: next })
    try {
      const real = await window.yan.win.setAlwaysOnTop(next)
      if (get().alwaysOnTop !== next) return
      set({ alwaysOnTop: real })
    } catch (error) {
      if (get().alwaysOnTop === next) set({ alwaysOnTop: previous })
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.alwaysOnTopFailed', { error: String(error) })) })
      return
    }
    set({
      notices: pushNotice(
        get().notices,
        'info',
        get().alwaysOnTop ? uiText('state.alwaysOnTop.on') : uiText('state.alwaysOnTop.off')
      )
    })
  },
  setRightPanelOpen: async (v) => {
    const request = ++rightPanelPatchSeq
    const s = get().settings
    const previous = s?.rightPanelOpen ?? true
    if (s) set({ settings: { ...s, rightPanelOpen: v } })
    applyBrowserVisibility(get)
    try {
      const next = await persistSettingsPatch({ rightPanelOpen: v })
      if (request === rightPanelPatchSeq) set({ settings: next })
    } catch (error) {
      if (request === rightPanelPatchSeq) set({ settings: get().settings ? { ...get().settings!, rightPanelOpen: previous } : get().settings })
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.savePanelVisibilityFailed', { error: String(error) })) })
    }
    applyBrowserVisibility(get)
  },
  setBrowserSurfaceActive: (active) => {
    browserSurfaceActive = active
    applyBrowserVisibility(get)
  },
  acquireOverlayBlocker: (token) => {
    overlayBlockers.acquire(token)
    applyBrowserVisibility(get)
    return () => {
      overlayBlockers.release(token)
      applyBrowserVisibility(get)
    }
  },
  log: (line) => set({ logs: [...get().logs, line].slice(-200) })
  }
})

useStore.subscribe((state, previous) => {
  if (heldQueueReclaims.size === 0) return
  if (viewingSessionId(state) === viewingSessionId(previous)) return
  const patch = takeHeldQueueReclaim(state)
  if (patch) useStore.setState(patch)
})
