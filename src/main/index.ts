import './exe-search-guard'
import { setUserHandoffRelease } from './browser/user-handoff'
import { isAgentContextExtension, nativePiToolsSupported } from '../shared/agent-context'
import { storageMoveReady } from './storage-move-boot'
import { pick } from '../shared/ui-lang'
import { app, shell, BrowserWindow, crashReporter, dialog, screen, Menu, Notification, Tray, nativeImage, nativeTheme, session } from 'electron'
import { unsavedFiles } from './unsaved-files'
import { disposeFileNameSearch } from './file-name-search'
import { disposeUsageStatsWorker } from './usage-stats-host'
import { disposeGitReadHost } from './git-read-host'
import { disposeContentSearch } from './file-content-search'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { release as osRelease } from 'node:os'
import { constants as fsConstants, appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loadModelPricing } from './model-pricing'
import { mcpAppProxyService } from './mcp/app-proxy-service'
import { AgentController, type CapabilityAuthorizationChoice, type CapabilityAuthorizationPrompt, type ExternalApiConfirmationRequest, type ToolConsentPrompt } from './agent'
import { applyRememberedModel } from './model-default'
import { applyTurnTimings, effectiveTerminalReason, readTurnTimings, timingKey } from './turn-timing-store'
import { readSessionTail, tailTurnInterrupted } from './session-tail'
import { RunnerRegistry } from './runners'
import { createRunsHost, type RunsHost } from './runs-host'
import { createAttentionService, createTrayAssetStore, type AttentionMenuNode, type AttentionService, type AttentionWindowPort, type TrayAnimationState, type TrayFrameSet, type TraySelectTarget, type TrayTheme } from './attention'
import { createAuxWindows, quickAskSessionTarget, registerAuxIpc, submitQuickAsk, type AuxWindows } from './windows'
import { createRendererRecovery } from './windows/renderer-recovery'
import { registerDeepLinkProtocol, windowDeepLinkRouter, type DeepLink } from './deeplink'
import { approvalNoticeTitle, createAttentionNotices, noticeLang, terminalNoticeText } from './attention-notice'
import { RunnerVisibility } from './runner-reclaim'
import { isBroadAllowRoot } from './guard-roots'
import { getSettings, patchSettings } from './settings'
import { syncNativeCompactionLines, type LineModel } from './native-compaction-line'
import { DEFAULT_AUTO_COMPACT_TOKENS } from '../shared/context-limits'
import { registerWorkspaceDataIpc } from './ipc/workspace-data-ipc'
import { getSessionLayout, moveSessionLayout, rememberSession } from './session-layout'
import { disposeKeepAwake, updateKeepAwake, watchPowerSource } from './keep-awake'
import { rewriteSessionCwd, movedSessionContinuationPrompt, beginSessionMove, restoreSessionHeaderCwd, type SessionMoveAnswer, type SessionMovePrompt, type SessionMoveLease } from './session-move'
import { resolveSessionOpenTarget } from './session-open-target'
import { readChainMessages } from './session-history'
import { localizeImage } from './image-store'
import { ArtifactStore, sessionArtifactDir } from './artifacts'
import { registerHtmlArtifactProtocol, guardHtmlArtifactFrames, htmlArtifactPreviews } from './html-artifact-preview'
import { attachPinnedNetworkGuard, shutdownPinnedNetworkGuard } from './net/pinned-network'
import { pinnedGuardNotice, type PinnedGuardNotice } from './pinned-guard-notice'
import { captureHtmlPreviewShots } from './artifact-preview-shots'
import { exportVideo } from './video-export'
import { exportHtmlImage } from './artifact-image-export'
import './mcp/app-protocol'
import { readRepoState } from './git-service'
import { configureWriteContext } from './git-actions'
import { configurePackageContext, installManagedPiPackage, listPackages } from './packages'
import { acquisitionServiceFor } from './capabilities/acquisition-service'
import { PackageAuthorizationService } from './capabilities/package-authorization-service'
import { createPiPackageActivationHostPorts } from './capabilities/pi-package-activation-host'
import { PiPackageActivationScheduler } from './capabilities/pi-package-scheduler'
import { smokeStagedPiPackage } from './capabilities/pi-package-smoke'
import { allowTrust, trustStatus } from './project-trust'
import { resolvePi } from './protocol'
import { applyZoom, clampScale, peekUiScale, stepScale, zoomState } from './zoom'
import { BrowserController, DOWNLOAD_CONFIRM_BYTES, type LargeDownload } from './browser'
import { openableExternalUrl } from './external-url'
import { disposeTerminals, hasBlockedTerminal, hasWorkingTerminal, setTerminalSink, terminalProcessId } from './terminal'
import { agentTerminalIds } from './terminal-agent'
import { installLocalServerControl } from './browser/local-server-owner'
import { installSessionPermissionBoundary, trustedFrameTrust } from './browser/permission-boundary'
import { choiceFromResponse, needsQuitConfirm, parseProbeChoice, quitPrompt, quitReasons, type ExitChoice, type QuitActivity } from './quit-guard'
import { runShutdownSteps } from './shutdown'
import { createIpcRegistrar } from './ipc/registrar'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerAgentIpc, type PinnedSendTarget } from './ipc/agent-ipc'
import { registerSettingsIpc } from './ipc/settings-ipc'
import { registerShellIpc } from './ipc/shell-ipc'
import { setSessionBrowserCloser } from './session-browser-cleanup'
import { createPreviewSiteGate } from './preview-site-gate'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { onTerminalJobs } from './terminal-jobs'
import { registerRemoteIpc } from './ipc/remote-ipc'
import { registerOfficeIpc } from './ipc/office-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerGithubIpc } from './ipc/github-ipc'
import { registerSourcesIpc } from './ipc/sources-ipc'
import { preserveSearchOp, registerSearchOpsIpc } from './ipc/search-ops-ipc'
import { registerCapabilitiesIpc } from './ipc/capabilities-ipc'
import { registerMcpAppViewIpc } from './ipc/mcp-app-view-ipc'
import { McpAppViewService, createMcpAppViewRuntime, type McpAppViewRunnerFacts } from './mcp/app-view-service'
import { McpAppViewAuditStore } from './mcp/app-view-audit'
import { createMcpAppHostRequests } from './mcp/app-host-requests'
import { createMcpAppResourceLoader, registerMcpAppProtocol } from './mcp/app-protocol'
import { mcpAppHost, closeMcpAppHost, configureMcpAppHostOwnership } from './mcp/app-host'
import { loadMcpServersCached } from './mcp/config'
import type { McpAppOwner } from '../shared/mcp-app-preview'
import { createMcpAppRuntimeOwnershipFacts } from './mcp/app-runtime-ownership'
import { refreshMinecraftPluginOnStartup, registerPackagesIpc } from './ipc/packages-ipc'
import { BundledPlugins } from './bundled-plugins'
import { completePluginText } from './plugin-completion'
import { configurePluginCommands } from './plugin-commands'
import { registerSubagentsIpc, type SubagentParentContext } from './ipc/subagents-ipc'
import { isSessionFileInSessionsDir, onSessionPurged, SESSIONS_DIR } from './sessions'
import { registerSessionIpc } from './ipc/session-ipc'
import { registerNativeSessionIpc } from './ipc/native-session-ipc'
import { registerRunsIpc } from './ipc/runs-ipc'
import { registerSessionTransferIpc } from './ipc/session-transfer-ipc'
import { registerCheckpointIpc } from './ipc/checkpoint-ipc'
import { registerCanvasCaptureIpc } from './ipc/canvas-capture-ipc'
import { registerHtmlEditIpc } from './ipc/html-edit-ipc'
import { registerVideoExportIpc } from './ipc/video-export-ipc'
import { pruneCheckpoints } from './checkpoints'
import type { SessionHost } from './session-host'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerWorkspaceIpc } from './ipc/workspace-ipc'
import { registerFilesIpc } from './ipc/files-ipc'
import { isAuthorizedFileCwd, isRunnerProjectCwd } from './file-context'
import { lockDataRoot } from '../core/data-root-lock'
import { executionBusy } from '../core/run-state'
import { RuntimeRef } from '../shared/runs'
import { isWithin } from './file-path-gate'
import { SubagentService } from './subagent-service'
import { LookupCommands } from './lookup-commands'
import { resolveSubagentModelPick } from './subagents/model-label'
import { createSubagentNotifier, findNoticeTarget } from './subagent-notify'
import { WorkflowService } from './workflows/service'
import { registerWorkflowsIpc } from './ipc/workflows-ipc'
import { createSubagentNoticeStore } from './subagent-notice-store'
import { buildSubagentOvertimeNotice } from '../shared/subagent-notice'
import { createSubagentQuotaWatch } from './subagent-quota-watch'
import { switchToSpareAccount } from './account-autoswitch'
import { botIconDirs, botIconFile, notificationBotMood, type NotificationBotKind } from './bot-icon'
import type { ModelRef } from '../shared/model-brand'
import { APPROVAL_DETAIL_MAX, DANGER_CONFIRM_TIMEOUT_MS, withDenyFeedback, type ApprovalDecision, type ApprovalRequest } from '../shared/approval'
import { configureRemoteHost, remoteSnapshot, remoteHistory, remoteModels, remoteSubagents, remoteInsight, remoteStopSubagent, remoteSetSessionFlag, remoteDeleteSession, remoteCompact, remoteBranches, remoteSwitchBranch, remoteSearch, executeRemoteCommand, remoteQuestions, remoteAnswer, remoteHumanApproval, remoteArtifact, remoteMessageImage } from './remote-host'
import { registerVoiceIpc, voiceTranscriber } from './ipc/voice-ipc'
import { registerAndroidIpc } from './ipc/android-ipc'
import { registerAppUpdate } from './app-update'
import { prepareUpdateAfterWriters } from './shutdown-update'
import type { ConsentAnswer } from '../shared/tool-consent'
import { RemoteAccess } from './remote-access'
import { SessionChainStore } from './session-chain-service'
import { sharedCwdNotice } from './cwd-sharing'
import { AutoIsolationStore, discardUnusedIsolation, isolateCwdForConflict, isolatedSessionCwd, isolationCwdKey, pendingIsolationChanges } from './session-isolation'
import { discardIdleEmptyIsolations, hasSavedSessionUnder } from './isolation-cleanup'
import { clearExitSnapshot, pickRestoreRunner, readExitSnapshot, writeExitSnapshot } from './exit-snapshot'
import { QUEUE_RECOVERY_DIR, pruneReclaimedQueues } from './queue-persistence'
import { installStdioGuard } from './stdio-guard'
import { decodeControlCommand, writeControlResponse, type ControlCommand, type ControlResponse } from './control-protocol'
import { smoothTextEnabledSync } from './early-switches'
import { DOWNLOADS_DIR, ELECTRON_CRASH_DUMPS_DIR, ELECTRON_USER_DATA_DIR, PI_AGENT_DIR, YAN_DIR } from './paths'
import { fillNativeMcpDescriptions } from './mcp/native-describe'
import { armProbeRun, armProbeShots } from './probe-hooks'
import { migrateLegacyPlaybooks, userSkillPaths } from './user-skills'
import { extensionDiagnostics } from './extensions-inventory'
import { projectIdForCwd as deriveProjectId } from './project-id'
import { ApprovalBroker } from './approval-broker'
import { approvalLog, type ModelReviewReceiptInput } from './approval-log'
import { refreshManagedGit } from './git-runtime'
import { applyBundledSearchTools } from './search-tools'
import { registerGitRuntimeIpc } from './ipc/git-runtime-ipc'
import { cachedTitlesSync, primeCachedTitles } from './title'
import { planSessionSyncAgainst } from './session-sync-plan'
import { takeSyncBaseline } from './sync-baseline'
import { messageSyncSignature } from '../shared/session-sync'
import type { FileRequestContext, MainPush, QueueSnapshot, RunnerStatus, RuntimeEnvelope, SessionState, TerminalProgramStatus } from '../shared/ipc'

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

let exitReason: string | undefined
let exitSource: string | undefined

function crashLogDir(): string {
  const dir = join(YAN_DIR, 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
  }
  return dir
}

installStdioGuard(
  { stdout: process.stdout, stderr: process.stderr },
  { onError: (stream, error) => reportMainError(`stdio/${stream}`, error) }
)

function reportMainError(kind: string, error: unknown): void {
  const detail =
    error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
      : String(error)
  const text = `[主进程/${kind}] ${detail}`
  try {
    push({ ch: 'log', payload: { text, level: 'error' } })
  } catch {
  }
  try {
    console.error(text)
  } catch {
  }
  try {
    const stamp = new Date().toISOString()
    appendFileSync(join(crashLogDir(), `main-${stamp.slice(0, 10)}.log`), `${stamp} ${text}\n`, 'utf8')
  } catch {
  }
}

function logMainEvent(kind: string, text: string): void {
  try {
    const stamp = new Date().toISOString()
    appendFileSync(join(crashLogDir(), `main-${stamp.slice(0, 10)}.log`), `${stamp} [主进程/${kind}] ${text}\n`, 'utf8')
  } catch {
  }
}

function pendingUiReplay(): MainPush[] {
  const registry = runners
  if (!registry) return []
  return registry.statuses().flatMap((status) => {
    const agent = registry.agentOf(status.id)
    const runtime = registry.runtimeOf(status.id)
    if (!agent || !runtime) return []
    return agent.pendingUiRequests().map((payload): MainPush => ({ ch: 'ui-request', payload, runtime, sessionKey: status.id, replay: true }))
  })
}

async function resyncActiveView(reason: unknown): Promise<{ ok: boolean }> {
  const id = runners?.activeRunnerId
  const agent = id ? runners?.agentOf(id) : null
  if (!id || !agent) return { ok: false }
  const state = agent.getState()
  takeSyncBaseline(state?.sessionFile)
  logMainEvent('视图重同步', `${String(reason ?? '').slice(0, 80)} runner=${id} session=${state?.sessionId ?? ''}`)
  await pushRunnerSnapshot(id)
  return { ok: true }
}

process.on('exit', (code) => {
  try {
    const record = JSON.stringify({
      at: Date.now(),
      code,
      reason: exitReason ?? 'unspecified',
      source: exitSource ?? null,
      shuttingDown,
      quitting: isQuitting,
      windows: BrowserWindow.getAllWindows().length,
      uptime: Math.round(process.uptime())
    })
    writeFileSync(join(crashLogDir(), 'last-exit.json'), record, 'utf8')
    appendFileSync(join(crashLogDir(), 'exit-history.jsonl'), `${record}\n`, 'utf8')
  } catch {
  }
})

const CRASH_CLEANUP_MS = 5000

process.on('uncaughtException', (error) => {
  reportMainError('uncaughtException', error)
  if (exitReason === 'uncaughtException') return
  exitReason = 'uncaughtException'
  const exit = (): void => app.exit(1)
  setTimeout(exit, CRASH_CLEANUP_MS)
  setImmediate(() => { void shutdown().finally(exit) })
})
process.on('unhandledRejection', (reason) => reportMainError('unhandledRejection', reason))

if (ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', ELECTRON_USER_DATA_DIR)
}
if (ELECTRON_CRASH_DUMPS_DIR) {
  app.setPath('crashDumps', ELECTRON_CRASH_DUMPS_DIR)
}
try {
  crashReporter.start({ uploadToServer: false, compress: true })
} catch (error) {
  reportMainError('crash-reporter', error)
}
if (DOWNLOADS_DIR) {
  app.setPath('downloads', DOWNLOADS_DIR)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.exit(0)
} else {
  app.on('second-instance', (_event, commandLine) => {
    const command = decodeControlCommand(commandLine)
    if (command) {
      void dispatchControlCommand(command)
      return
    }
    if (deepLinkRouter.handleArgv(commandLine)) return
    showMainWindow()
  })
}

function probeArg(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

if (!process.env.YAN_PROBE) {
  const probe = probeArg('yan-probe')
  if (probe) process.env.YAN_PROBE = probe
}
if (!process.env.YAN_PROBE_DELAY) {
  const delay = probeArg('yan-probe-delay')
  if (delay) process.env.YAN_PROBE_DELAY = delay
}
if (!process.env.YAN_PROBE_OUT) {
  const output = probeArg('yan-probe-out')
  if (output) process.env.YAN_PROBE_OUT = output
}

if (process.env.YAN_PROBE) {
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  if (/^\d{4,5}$/.test(process.env.YAN_PROBE_DEBUG_PORT ?? '')) app.commandLine.appendSwitch('remote-debugging-port', process.env.YAN_PROBE_DEBUG_PORT as string)
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (smoothTextEnabledSync()) app.commandLine.appendSwitch('disable-lcd-text')

const APP_ID = app.isPackaged ? 'com.yudatoux.yan' : 'com.yudatoux.yan.dev'


try {
  app.setAppUserModelId(APP_ID)
} catch {
}

let win: BrowserWindow | null = null
const rendererMayReload = createRendererRecovery()
let pendingPinnedGuardNotice: PinnedGuardNotice | null = null
let primaryRestoring = false
let primaryRestoreFile: string | null = null
let trayLanguage: string | undefined
let trayAssets: ReturnType<typeof createTrayAssetStore> | null = null
let trayMotionAllowed = false
let attention: AttentionService | null = null
let auxWindows: AuxWindows | null = null
let isQuitting = false
let exitRequestInFlight: Promise<{
  action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting'
}> | null = null
let runners: RunnerRegistry | null = null

function pinSendTarget(id: string): PinnedSendTarget | null {
  const agent = runners?.agentOf(id)
  const runtime = runners?.runtimeOf(id)
  if (!agent || !runtime) return null
  return { runId: runtime.runId, generation: runtime.generation, sessionId: runtime.sessionId, agent }
}

function pinnedTargetMatches(pin: PinnedSendTarget): boolean {
  if (runners?.agentOf(pin.runId) !== pin.agent) return false
  return RuntimeRef.matches(runners?.runtimeOf(pin.runId), pin, 'envelope')
}

let runsHost: RunsHost | null = null
let mcpAppViewService: McpAppViewService | null = null
let appViewForeground: { runnerId: string; sessionId: string; sessionFile: string; generation: number } | null = null
let updateControl: ReturnType<typeof registerAppUpdate> | null = null
const runnerVisibility = new RunnerVisibility()
let piPackageActivationScheduler: PiPackageActivationScheduler | null = null
let piPackageActivationTimer: ReturnType<typeof setTimeout> | null = null
let piPackageActivationInFlight = false
let piPackageActivationAgain = false
const piPackageActivationDeferred = new Map<string, string>()
let browser: BrowserController | null = null
const notifySubagentFinished = createSubagentNotifier({
  store: createSubagentNoticeStore(join(YAN_DIR, 'subagent-notices.json')),
  enabled: async () => (await getSettings()).subagentNotify !== false,
  find: (run) => (runners ? findNoticeTarget(subagentService.current()?.get(run.id) ?? run, runners) : null),
  runningSiblings: (run) => (subagentService.current()?.list() ?? []).filter((other) => (other.status === 'running' || other.status === 'starting') && !workflowService.owns(other) &&
    ((!!run.parentSessionId && other.parentSessionId === run.parentSessionId) || (!!run.parentRunId && other.parentRunId === run.parentRunId))).length
})
const subagentQuotaWatch = createSubagentQuotaWatch({
  switchAccount: switchToSpareAccount,
  notifyUser: ({ run, title, body }) => {
    push({ ch: 'notify', payload: { id: `subagent-quota-${run.id}`, method: 'notify', notifyType: 'warning', message: `${title}：${body}` } })
    void getSettings().then((settings) => {
      if (!win || win.isDestroyed() || win.isFocused() || settings.sound?.notifications === false || !Notification.isSupported()) return
      attentionNotices.show({ key: `subagent-quota:${run.id}`, title, body, icon: botNotificationIcon(run.model, 'question'), link: sessionNoticeLink(run.parentSessionId) })
    }).catch(() => undefined)
  },
  notifyParent: (run, text) => {
    void (async () => {
      if ((await getSettings()).subagentNotify === false || !runners || workflowService.owns(run)) return
      const target = findNoticeTarget(subagentService.current()?.get(run.id) ?? run, runners)
      if (!target || target.holdsNotices()) return
      await target.send(text, undefined, 'followUp')
    })().catch(() => undefined)
  }
})
const subagentSearch = new Map<string, LookupCommands>()
const subagentService: SubagentService = new SubagentService({
  preambleExtension: () => yanThinResourcePath(YAN_THIN_EXTENSION_FILES.preambleExtension),
  codemodeExtension: () => yanThinResourcePath(YAN_THIN_EXTENSION_FILES.codemodeExtension),
  providerExtensions: providerExtensionPaths,
  guardExtension: () => yanThinResourcePath(YAN_THIN_EXTENSION_FILES.dangerGuardExtension),
  contextCompactExtension: () => yanThinResourcePath(YAN_THIN_EXTENSION_FILES.contextCompactExtension),
  shellExtension: () => yanThinResourcePath(YAN_THIN_EXTENSION_FILES.shellFallbackExtension),
  guideExtension: () => yanThinResourcePath('subagent-guide.js'),
  readOnlyExtension: () => yanThinResourcePath('readonly-tools.js'),
  sideQuestionExtension: () => yanThinResourcePath('side-question.js'),
  runReadOnlyCommand: (command, params, cwd, signal, ownerId) => {
    const key = ownerId ?? cwd
    let lookup = subagentSearch.get(key)
    if (!lookup) {
      lookup = new LookupCommands({ capabilityOpts: () => undefined, cwd: () => cwd })
      subagentSearch.set(key, lookup)
      if (subagentSearch.size > 32) subagentSearch.delete(subagentSearch.keys().next().value!)
    }
    return lookup.runSearchCommand(command.slice('search.'.length), params, signal)
  },
  previewHtml: (htmlPath, root, options) => captureHtmlPreviewShots({ previews: htmlArtifactPreviews, htmlPath, root, outDir: join(YAN_DIR, 'artifact-previews'), ...(options?.at ? { at: options.at } : {}) }),
  resolveModelApi: async (label, origin) => {
    const parent = (origin.runId ? runners?.agentOf(origin.runId) : null) ??
      (origin.sessionId ? runners?.agentForSession(origin.sessionId) : null) ?? null
    if (!parent) throw new Error('来源会话已关闭，无法核对指定模型')
    const selected = (await parent.listModels()).find(model => `${model.provider}/${model.id}` === label)
    if (!selected) throw new Error(`来源会话中指定模型 ${label} 已不可用`)
    return selected.api
  },
  resolveModelLabel: async (requested, context) => {
    const parent = (context.parentRunId ? runners?.agentOf(context.parentRunId) : null) ??
      (context.parentSessionId ? runners?.agentForSession(context.parentSessionId) : null) ?? null
    const models = parent ? await parent.listModels().catch(() => []) : []
    const settings = await getSettings()
    const preferred = settings.subagentDefaultModel
    return resolveSubagentModelPick(requested, models, context.model, {
      ...(preferred && preferred !== 'follow' ? { model: preferred } : {}),
      force: settings.subagentModelForce === true
    })
  },
  confirmDanger: async (params, cwd, origin) => {
    if ((await getSettings()).permissionMode === 'all' && params.critical !== true) return true
    const detail = String(params.detail ?? '')
    if (detail.length > APPROVAL_DETAIL_MAX) return false
    const answer = await approvals.askTimed({
      ...(origin?.sessionId ? { sessionId: origin.sessionId } : {}),
      ...(origin?.runId ? { runId: origin.runId } : {}),
      ...(origin?.subagentId ? { subagentId: origin.subagentId } : {}),
      ...(typeof params.toolCallId === 'string' && params.toolCallId ? { toolCallId: params.toolCallId.slice(0, 200) } : {}),
      kind: 'danger', tool: String(params.tool ?? 'tool').slice(0, 40),
      onTimeout: params.critical === true ? 'deny' : 'review',
      title: '子 Agent 想执行一个难以撤销的操作',
      detail,
      reasons: Array.isArray(params.reasons) ? params.reasons.filter((item): item is string => typeof item === 'string').slice(0, 6).map(item => item.slice(0, 200)) : [],
      cwd, canRemember: false
    }, DANGER_CONFIRM_TIMEOUT_MS)
    if (answer === 'timeout') return { decision: 'timeout' as const }
    if (answer?.choice === 'once') return { decision: 'allow' as const }
    if (answer?.choice === 'deny') return { decision: 'deny' as const, ...(answer.feedback ? { feedback: answer.feedback } : {}) }
    return { decision: 'no-answer' as const }
  },
  recordDangerReview: (review, origin) => recordDangerReview(origin?.sessionId, review),
  forkSource: (context) => {
    const parent = (context.parentRunId ? runners?.agentOf(context.parentRunId) : null) ??
      (context.parentSessionId ? runners?.agentForSession(context.parentSessionId) : null) ?? null
    return parent ? parent.forkSource() : '来源会话已关闭，不能派 fork 子代理'
  },
  quotaWatch: subagentQuotaWatch,
  onChange: (run) => {
    if (run.status !== 'starting' && run.status !== 'running') {
      approvals.cancel((pending) => pending.subagentId === run.id)
      approvals.forgetSubagent(run.id)
    }
    queueSubagentRun(run)
    refreshTaskbar()
    workflowService.onSubagentChange()
  },
  onPatch: ({ id, run, transcriptFrom }) => {
    flushSubagentRuns()
    push({ ch: 'subagent-patch', payload: { id, run, transcriptFrom } })
    refreshTaskbar()
  },
  onRemove: (id) => {
    pendingSubagentRuns.delete(id)
    flushSubagentRuns()
    push({ ch: 'subagent-remove', payload: id })
    refreshTaskbar()
  },
  onEvent: (_runId, evt, run) => {
    runsHost?.observeSubagentEvent(run, evt)
  },
  onOvertime: (run, minutes) => {
    void (async () => {
      if ((await getSettings()).subagentNotify === false || !runners || workflowService.owns(run)) return
      const target = findNoticeTarget(subagentService.current()?.get(run.id) ?? run, runners)
      if (!target || target.holdsNotices()) return
      await target.send(buildSubagentOvertimeNotice(run, minutes), undefined, 'followUp')
    })().catch(() => undefined)
  },
  onFinished: (run) => {
    runsHost?.settleSubagent(run, run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'stopped' : 'failed', run.error)
    if (workflowService.owns(run)) workflowService.onSubagentFinished(run)
    else if (!run.launchFailed && !run.sideQuestion) notifySubagentFinished(run)
  }
})
const workflowService: WorkflowService = new WorkflowService({
  root: join(YAN_DIR, 'workflows', 'runs'),
  workerPath: join(__dirname_, 'workflow-worker.js'),
  subagentCommand: (command, params, context) => subagentService.capabilityHost.run(command, params, context),
  getSubagent: async (id) => (await subagentService.get()).getFull(id),
  runningSubagents: () => subagentService.current()?.runningCount ?? 0,
  findTarget: (run) => (runners ? findNoticeTarget({ parentSessionId: run.sessionId, parentRunId: run.parentRunId, parentGeneration: run.parentGeneration }, runners) : null),
  push: (view) => push({ ch: 'workflow', payload: view })
})
let remoteAccess: RemoteAccess | null = null

async function applyToAllAgents(
  apply: (agent: AgentController) => Promise<{ ok: boolean; error?: string }>
): Promise<{ ok: boolean; error?: string }> {
  const active = ac()
  if (!active) return { ok: false, error: piDown() }
  const result = await apply(active)
  if (!result.ok) return result
  await Promise.all(
    (runners?.agents() ?? [])
      .filter((agent) => agent !== active)
      .map((agent) => apply(agent).catch(() => undefined))
  )
  return result
}

function ac(): AgentController | null {
  return runners?.active() ?? null
}

function appViewForegroundFacts(): McpAppViewRunnerFacts | null {
  const runner = runners?.activeRunner()
  if (!runner) return null
  const agent = runners?.agentOf(runner.id)
  const envelope = runners?.runtimeOf(runner.id)
  if (!agent || !envelope) return null
  const sessionFile = agent.getState()?.sessionFile
  const sessionId = envelope.sessionId
  const projectId = agent.capabilityProjectId ?? envelope.projectId
  if (!sessionFile || !sessionId || !projectId) return null
  return {
    sessionId,
    sessionFile,
    projectId,
    runnerId: runner.id,
    generation: envelope.generation,
    cwd: runner.cwd
  }
}

function syncAppViewForeground(): void {
  const facts = appViewForegroundFacts()
  const next = facts ? { runnerId: facts.runnerId, sessionId: facts.sessionId, sessionFile: facts.sessionFile, generation: facts.generation } : null
  const previous = appViewForeground
  appViewForeground = next
  if (!mcpAppViewService || !previous) return
  if (
    next &&
    previous.runnerId === next.runnerId &&
    previous.sessionId === next.sessionId &&
    previous.sessionFile === next.sessionFile &&
    previous.generation === next.generation
  ) {
    return
  }
  mcpAppViewService.invalidateRunnerId(previous.runnerId)
  mcpAppViewService.invalidateSession(previous.sessionId)
}

const stopRunner = async (agent: AgentController | null): Promise<QueueSnapshot> =>
  (await agent?.abort()) ?? { steering: [], followUp: [] }

const bundledPlugins = new BundledPlugins({
  sources: [
    process.resourcesPath ? join(process.resourcesPath, 'integrations') : '',
    join(__dirname_, '..', '..', 'integrations')
  ].filter(Boolean),
  dataDir: YAN_DIR,
  runtime: process.execPath,
  complete: completePluginText,
  showWindow: showMainWindow,
  confirm: async (plugin, title, detail, signal) => {
    if (signal.aborted || !win || win.isDestroyed()) return false
    const result = await dialog.showMessageBox(win, {
      type: 'warning', title: pick(`插件 ${plugin}：${title}`, `Plugin ${plugin}: ${title}`), message: title, detail,
      buttons: [pick('拒绝', 'Deny'), pick('允许本次', 'Allow once')], defaultId: 0, cancelId: 0, noLink: true
    })
    return !signal.aborted && result.response === 1
  },
  proxyEnvironment: async () => {
    const rule = await session.defaultSession.resolveProxy('https://huggingface.co')
    const proxy = /(?:^|;)\s*PROXY\s+([^\s;]+)/i.exec(rule)?.[1]
    return proxy ? { HTTP_PROXY: `http://${proxy}`, HTTPS_PROXY: `http://${proxy}`, NO_PROXY: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1' } : {}
  }
})
configurePluginCommands((command, params, context, signal) => bundledPlugins.command(command, params, context, signal))

function bundledSkillPaths(): string[] {
  const roots = [
    process.resourcesPath ? join(process.resourcesPath, 'yan-skills') : '',
    join(__dirname_, '..', '..', 'resources', 'skills'),
    join(process.cwd(), 'resources', 'skills')
  ].filter(Boolean)
  const root = roots.find((dir) => existsSync(dir))
  if (!root) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'SKILL.md'))
      .filter((file) => existsSync(file))
  } catch {
    return []
  }
}

const foundYanThinResources = new Map<string, string>()

function yanThinResourcePath(file: string): string | undefined {
  const known = foundYanThinResources.get(file)
  if (known) return known
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'yan-thin', file) : '',
    join(__dirname_, '..', '..', 'resources', 'pi-extensions', file),
    join(process.cwd(), 'resources', 'pi-extensions', file)
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (found) foundYanThinResources.set(file, found)
  return found
}

const YAN_THIN_EXTENSION_FILES = {
  codemodeExtension: 'codemode-policy.js',
  questionExtension: 'question.js',
  promptSuggestionExtension: 'prompt-suggestion.js',
  shellFallbackExtension: 'shell-fallback.js',
  responseDetailExtension: 'response-detail.js',
  preambleExtension: 'preamble.js',
  languageExtension: 'language.js',
  userAddressExtension: 'user-address.js',
  ultracodeExtension: 'ultracode.js',
  sessionModeExtension: 'session-mode.js',
  turnModelSwitchExtension: 'turn-model-switch.js',
  capabilityGuideExtension: 'capability-guide.js',
  mcpAppProxyExtension: 'mcp-app-proxy.js',
  phoneToolsExtension: 'phone-tools.js',
  autoCompactExtension: 'auto-compact.js',
  contextCompactExtension: 'context-compact.js',
  contextUsageExtension: 'context-usage.js',
  imageLabelsExtension: 'image-labels.js',
  nativeSessionExtension: 'native-session-bridge.js',
  repeatGuardExtension: 'repeat-guard.js',
  dangerGuardExtension: 'danger-guard.js'
} as const

const PROVIDER_EXTENSION_FILES = ['commandcode.js', 'provider-diagnostics.js', 'anthropic-progress-updates.js', 'cache-retention.js', 'parallel-tool-calls.js', 'native-web-search.js', 'fast-mode.js'] as const

function yanThinExtensions(): { -readonly [K in keyof typeof YAN_THIN_EXTENSION_FILES]: string | undefined } {
  const entries = Object.entries(YAN_THIN_EXTENSION_FILES).map(([key, file]) => [key, yanThinResourcePath(file)])
  return Object.fromEntries(entries) as { -readonly [K in keyof typeof YAN_THIN_EXTENSION_FILES]: string | undefined }
}

let launchResourceCache: { at: number; providers: string[]; skills: string[]; signature: string } | null = null

function launchResources(): { providers: string[]; skills: string[]; signature: string } {
  if (launchResourceCache && Date.now() - launchResourceCache.at < 2000) return launchResourceCache
  const pluginExtensions = bundledPlugins.extensionPaths()
  const providers = [...PROVIDER_EXTENSION_FILES.map(yanThinResourcePath).filter((p): p is string => !!p), ...pluginExtensions]
  const skills = [...bundledSkillPaths(), ...bundledPlugins.skillPaths(pluginExtensions)]
  const signature = JSON.stringify([...providers, ...skills].map((path) => {
    try { return `${path}@${statSync(path).mtimeMs}` } catch { return path }
  }))
  launchResourceCache = { at: Date.now(), providers, skills, signature }
  return launchResourceCache
}

function providerExtensionPaths(): string[] {
  return launchResources().providers
}

function yanThinExtensionPaths(): string[] {
  return [...Object.values(yanThinExtensions()), ...providerExtensionPaths()]
    .filter((p): p is string => !!p && isAgentContextExtension(p))
}

function push(msg: MainPush): void {
  remoteAccess?.publish(msg)
  if (msg.ch === 'runs') bundledPlugins.publishRuns(msg.payload)
  if (msg.ch === 'runs') attention?.refreshTaskbar()
  if (!win || win.isDestroyed()) return
  win.webContents.send('yan:push', msg)
}

const browserSiteAsks = new Map<string, (allowed: boolean) => void>()

function askBrowserSiteApproval(origin: string, url: string): Promise<boolean> {
  if (!win || win.isDestroyed()) return Promise.resolve(false)
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const settle = (allowed: boolean): void => {
      if (!browserSiteAsks.delete(id)) return
      clearTimeout(timer)
      resolve(allowed)
    }
    const timer = setTimeout(() => settle(false), 120_000)
    browserSiteAsks.set(id, settle)
    push({ ch: 'browser-site-ask', payload: { id, origin, url } })
  })
}

function answerBrowserSiteApproval(id: string, allowed: boolean): void {
  browserSiteAsks.get(id)?.(allowed)
}

function botNotificationIcon(model: ModelRef, kind: NotificationBotKind): string | undefined {
  const dir = botIconDirs(process.resourcesPath, __dirname_, process.cwd()).find((candidate) => existsSync(candidate))
  if (!dir) return undefined
  return botIconFile(model, notificationBotMood(kind), nativeTheme.shouldUseDarkColorsForSystemIntegratedUI, { dir }) ?? undefined
}

function approvalModel(request: ApprovalRequest): ModelRef {
  if (request.subagentId) return subagentService.current()?.get(request.subagentId)?.model
  const agent = (request.runId ? runners?.agentOf(request.runId) : null) ??
    (request.sessionId ? runners?.agentForSession(request.sessionId) : null)
  return agent?.getState()?.model
}

const attentionNotices = createAttentionNotices(
  (options) => new Notification(options),
  (link) => {
    if (link && deepLinkRouter.open(link)) return
    showMainWindow()
  }
)

function sessionNoticeLink(sessionId?: string): DeepLink | undefined {
  return sessionId ? { action: 'session', sessionId } : undefined
}

const APPROVAL_REMIND_MS = 120_000

const approvals = new ApprovalBroker({
  canAsk: () => !!win && !win.isDestroyed(),
  open: (request) => {
    runsHost?.observeApproval(request)
    push({ ch: 'approval', payload: request })
    const notifyApproval = (): void => {
      if (!win || win.isDestroyed() || win.isFocused()) return
      attention?.flash()
      void getSettings().then((settings) => {
        if (settings.sound?.notifications === false || !Notification.isSupported()) return
        const lang = noticeLang(settings.lang)
        const subject = request.sessionId ? cachedTitlesSync()[request.sessionId] : undefined
        attentionNotices.show({
          key: request.sessionId ? `session:${request.sessionId}` : `approval:${request.id}`,
          title: approvalNoticeTitle(lang, subject),
          body: request.title,
          icon: botNotificationIcon(approvalModel(request), 'question'),
          link: sessionNoticeLink(request.sessionId)
        })
        push({ ch: 'attention-sound', payload: { event: 'question' } })
      }).catch(() => undefined)
    }
    notifyApproval()
    setTimeout(() => {
      if (approvals.list().some((item) => item.id === request.id)) notifyApproval()
    }, APPROVAL_REMIND_MS)
    refreshTaskbar()
  },
  close: (id) => {
    runsHost?.resolveApproval(id)
    push({ ch: 'approval-close', payload: { id } })
    refreshTaskbar()
  },
  update: (request) => push({ ch: 'approval', payload: request }),
  publish: (snapshot) => push({ ch: 'approval-snapshot', payload: snapshot }),
  record: (request, answer) => {
    const update = approvalLog.record(request, answer)
    if (update) push({ ch: 'approval-log', payload: update })
  }
})

function recordDangerReview(sessionId: string | undefined, review: ModelReviewReceiptInput): void {
  try {
    const update = approvalLog.recordReview(sessionId, review)
    if (update) push({ ch: 'approval-log', payload: update })
  } catch (error) {
    reportMainError('danger-review-record', error)
  }
}

async function askLargeDownloadApproval(download: LargeDownload): Promise<boolean> {
  const settings = await getSettings()
  const megabytes = Math.ceil(download.bytes / 1024 / 1024)
  const answer = await approvals.ask({
    kind: 'permission',
    tool: 'browser-download',
    title: `网页要下载一个 ${megabytes} MB 的文件，继续吗？`,
    detail: `文件：${download.filename}\n来源：${download.source}\n保存到：下载文件夹`,
    reasons: [`单个下载超过 ${DOWNLOAD_CONFIRM_BYTES / 1024 / 1024} MB`],
    cwd: settings.cwd,
    canRemember: false
  })
  return answer?.choice === 'once' || answer?.choice === 'remember'
}

async function askProfileSyncApproval(): Promise<boolean> {
  const settings = await getSettings()
  const answer = await approvals.ask({
    kind: 'permission',
    tool: 'chrome-profile-sync',
    title: '把本机 Chrome 的资料复制到砚的浏览器目录？',
    detail: '连接本机 Chrome 需要一份独立的浏览器资料，同意后会从本机 Chrome 复制一份。',
    reasons: ['复制会把本机 Chrome 的登录状态带进砚的浏览器资料目录'],
    cwd: settings.cwd,
    canRemember: false
  })
  return answer?.choice === 'once' || answer?.choice === 'remember'
}

attention = createAttentionService({
  platform: process.platform,
  snapshot: () => runsHost?.snapshot() ?? { revision: 0, runs: [] },
  hostBusy: () =>
    runners?.hasBusy() === true || (subagentService.current()?.runningCount ?? 0) > 0 || hasWorkingTerminal(),
  hostWaiting: () => approvals.list().length > 0 || hasBlockedTerminal(),
  window: () => (win && !win.isDestroyed() ? (win as unknown as AttentionWindowPort) : undefined),
  trayImage: () => trayImage(),
  trayAnimationAssets: (state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined => trayAssets?.set(state, theme),
  trayTheme: () => trayTheme(),
  motionAllowed: () => trayMotionAllowed,
  createTray: (image) => {
    const created = new Tray(image as Electron.NativeImage)
    return {
      setImage: (next) => created.setImage(next as Electron.NativeImage),
      setToolTip: (text) => created.setToolTip(text),
      setContextMenu: (nodes) => created.setContextMenu(Menu.buildFromTemplate(toElectronMenu(nodes))),
      on: (event, listener) => {
        if (event === 'click') created.on('click', () => listener())
        else created.on('double-click', () => listener())
      },
      setTitle: (title) => created.setTitle(title),
      destroy: () => created.destroy()
    }
  },
  language: () => trayLanguage,
  statuses: () => {
    const titles = cachedTitlesSync()
    return (runners?.statuses() ?? []).map((status) =>
      status.sessionId && titles[status.sessionId] ? { ...status, title: titles[status.sessionId] } : status
    )
  },
  showMainWindow,
  newSession: () => push({ ch: 'tray-new-session', payload: null }),
  selectSession: (target: TraySelectTarget) => {
    showMainWindow()
    push({ ch: 'tray-select-session', payload: target })
  },
  quit: () => void requestExit({ source: 'tray' }),
  onThemeChange: (listener) => {
    nativeTheme.on('updated', listener)
    return () => nativeTheme.removeListener('updated', listener)
  }
})

function toElectronMenu(nodes: AttentionMenuNode[]): Electron.MenuItemConstructorOptions[] {
  return nodes.map((node) => {
    if (node.type === 'separator') return { type: 'separator' as const }
    if (node.type === 'submenu') return { label: node.label, submenu: toElectronMenu(node.items) }
    return {
      label: node.label,
      ...(node.enabled === false ? { enabled: false } : {}),
      ...(node.click ? { click: node.click } : {})
    }
  })
}

function refreshTaskbar(force = false): void {
  attention?.refreshTaskbar(force)
}

function refreshTrayMenu(): void {
  attention?.refreshMenu()
}

const blockedTerminalNotices = new Map<string, { kind: TerminalProgramStatus['kind']; ticket: symbol }>()

function notifyBlockedTerminal(id: string, status?: TerminalProgramStatus): void {
  if (!status || status.state !== 'blocked') {
    blockedTerminalNotices.delete(id)
    return
  }
  if (blockedTerminalNotices.has(id) && blockedTerminalNotices.get(id)?.kind === status.kind) return
  const ticket = Symbol('terminal-blocked')
  blockedTerminalNotices.set(id, { kind: status.kind, ticket })
  if (!win || win.isDestroyed() || win.isFocused()) return
  void getSettings().then((settings) => {
    if (blockedTerminalNotices.get(id)?.ticket !== ticket || !win || win.isDestroyed() || win.isFocused()) return
    if (settings.sound?.enabled !== true || settings.sound.notifications === false || !Notification.isSupported()) return
    const text = terminalNoticeText(noticeLang(settings.lang), status.kind, status.title)
    attentionNotices.show({ key: `terminal:${id}`, title: text.title, body: text.body, icon: shellIconPath() })
    push({ ch: 'attention-sound', payload: { event: 'question' } })
  }).catch(() => undefined)
}

const sessionChains = new SessionChainStore()

const artifactStore = new ArtifactStore(join(YAN_DIR, 'artifacts'))

onSessionPurged(async (sessionId) => {
  const dir = sessionArtifactDir(join(YAN_DIR, 'artifacts'), sessionId)
  if (dir && existsSync(dir)) await shell.trashItem(dir)
})

const localizeHistoryImage = (mimeType: string, data: string): string =>
  localizeImage(join(YAN_DIR, 'attachments'), mimeType, data)

function liveTimingRunIdOf(sessionFile: string): string | undefined {
  const key = timingKey(sessionFile)
  if (!key) return undefined
  for (const status of runners?.statuses() ?? []) {
    if (!status.sessionFile || timingKey(status.sessionFile) !== key) continue
    const live = runners?.agentOf(status.id)?.liveTimingRunId()
    if (live) return live
  }
  return undefined
}

function readHistoryWithArtifacts(sessionFile: string, liveRunId?: string) {
  const liveRun = liveRunId ?? liveTimingRunIdOf(sessionFile)
  return readChainMessages(sessionFile, sessionChains, (file, messages) =>
    artifactStore.hydrateMessages(file, messages), localizeHistoryImage
  ).then(async (result) => {
    if (!result) return result
    const bucket = timingKey(sessionFile)
    if (!bucket) return result
    const records = await readTurnTimings(YAN_DIR, bucket, liveRun).catch(() => [])
    if (!records.length) return result
    return { ...result, messages: applyTurnTimings(result.messages, records) }
  })
}

const autoIsolations = new AutoIsolationStore()

let isolationSweepAt = 0
const ISOLATION_SYNC_MIN_INTERVAL = 3000
const isolationBlockedReason = new Map<string, string>()

type IsolationViewState = NonNullable<RunnerStatus['isolation']>
const isolationView = new Map<string, { state: IsolationViewState; branch: string }>()

function isolationOf(cwd: string): { state: IsolationViewState; branch: string } | undefined {
  return isolationView.get(isolationCwdKey(cwd))
}

function setIsolationView(worktree: string, view: { state: IsolationViewState; branch: string } | null): void {
  const key = isolationCwdKey(worktree)
  const before = isolationView.get(key)
  if (view === null) {
    if (!before) return
    isolationView.delete(key)
  } else {
    if (before && before.state === view.state && before.branch === view.branch) return
    isolationView.set(key, view)
  }
  pushIsolationStatus()
  pushRunners()
}

function piDown(): string {
  return pick('pi 未运行', 'pi is not running')
}

function pushIsolationStatus(): void {
  const pending = [...isolationView.values()].filter((x) => x.state !== 'waiting').length
  const text = pending === 0 ? undefined : pick(`工作树：${pending} 个有未合并的改动`, `Worktrees: ${pending} with unmerged changes`)
  push({ ch: 'status', payload: { key: 'isolation', text } })
}

async function initializeIsolationView(): Promise<void> {
  const records = await autoIsolations.all().catch(() => [])
  for (const record of records) setIsolationView(isolatedSessionCwd(record), { state: 'waiting', branch: record.branch })
  scheduleIsolationRefresh()
}

let isolationRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleIsolationRefresh(): void {
  if (isolationRefreshTimer) return
  const wait = Math.max(0, ISOLATION_SYNC_MIN_INTERVAL - (Date.now() - isolationSweepAt))
  isolationRefreshTimer = setTimeout(() => {
    isolationRefreshTimer = null
    void refreshIsolationViews()
  }, wait)
}

async function discardUnusedIsolations(): Promise<void> {
  const registry = runners
  if (!registry) return
  const discarded = await discardIdleEmptyIsolations({
    records: () => autoIsolations.all(),
    runners: () => registry.statuses().map((status) => ({
      id: status.id,
      cwd: status.cwd,
      isActive: status.isActive,
      busy: status.running || status.waiting,
      visible: runnerVisibility.includes(registry.agentOf(status.id)?.getState() ?? null),
      messageCount: registry.agentOf(status.id)?.getState()?.messageCount ?? 0
    })),
    stopRunner: (id) => registry.stopOne(id),
    hasSavedSession: (record) => hasSavedSessionUnder(SESSIONS_DIR, record),
    discard: discardUnusedIsolation,
    forget: (record) => autoIsolations.remove(record.worktree)
  }).catch(() => [])
  for (const record of discarded) setIsolationView(isolatedSessionCwd(record), null)
  if (discarded.length) pushRunners()
}

async function refreshIsolationViews(): Promise<void> {
  isolationSweepAt = Date.now()
  if (!runners || !win) {
    scheduleIsolationRefresh()
    return
  }
  if (win.isDestroyed()) return
  await discardUnusedIsolations()
  const records = await autoIsolations.all().catch(() => [])
  for (const record of records) {
    if (runners.hasBusyCwd(isolatedSessionCwd(record))) {
      setIsolationView(isolatedSessionCwd(record), { state: 'waiting', branch: record.branch })
      continue
    }
    const changes = await pendingIsolationChanges(record)
    const pending = changes.ok && changes.files + changes.commits > 0
    if (!pending) {
      isolationBlockedReason.delete(record.worktree)
      setIsolationView(isolatedSessionCwd(record), { state: 'waiting', branch: record.branch })
      continue
    }
    const state: IsolationViewState = isolationBlockedReason.has(record.worktree) ? 'blocked' : 'ready'
    setIsolationView(isolatedSessionCwd(record), { state, branch: record.branch })
  }
  const alive = new Set(records.map((record) => isolationCwdKey(isolatedSessionCwd(record))))
  for (const key of [...isolationView.keys()]) {
    if (!alive.has(key)) setIsolationView(key, null)
  }
}

const sharedCwdWarned = new Set<string>()

function warnSharedCwdOnce(runnerId: string, cwd: string, registry: RunnerRegistry): void {
  if (sharedCwdWarned.has(runnerId) || !registry.hasBusyCwd(cwd, runnerId)) return
  sharedCwdWarned.add(runnerId)
  push({
    ch: 'notify',
    payload: { id: `shared-cwd-${runnerId}`, method: 'notify', notifyType: 'warning', message: sharedCwdNotice(cwd) }
  })
}

function pushFrom(runnerId: string, msg: MainPush, expectedRuntime?: RuntimeEnvelope | null): void {
  if (primaryRestoring && msg.ch === 'state' && primaryRestoreFile) {
    const file = (msg.payload as SessionState | undefined)?.sessionFile
    if (file && resolve(file) !== resolve(primaryRestoreFile)) return
  }
  const runtime = runners?.runtimeOf(runnerId)
  if (!runtime) {
    if (msg.ch === 'ui-request') console.warn(`[ui-request] 实例 ${runnerId} 已摘登记，问题推送被丢弃：${msg.payload.id}`)
    return
  }
  if (expectedRuntime && !RuntimeRef.matches(runtime, expectedRuntime, 'envelope')) return
  runners?.noteActivity(runnerId)
  if (msg.ch === 'state') runners?.noteStateChange(runnerId)
  push({
    ...msg,
    ...(runtime ? { runtime } : {}),
    sessionKey: runnerId
  })
  if (msg.ch === 'state' || msg.ch === 'proc') refreshTrayMenu()
  if (msg.ch === 'state' || msg.ch === 'proc') requestPiPackageActivationTick()
  if (msg.ch === 'state' && (msg.payload as SessionState)?.isAgentRunning === false) scheduleIsolationRefresh()
  if (msg.ch === 'state') pushRunners()
  if (msg.ch === 'ui-request' || msg.ch === 'ui-resolved') pushRunners()
}

function requestPiPackageActivationTick(): void {
  if (!piPackageActivationScheduler) return
  if (piPackageActivationInFlight) {
    piPackageActivationAgain = true
    return
  }
  if (piPackageActivationTimer) clearTimeout(piPackageActivationTimer)
  piPackageActivationTimer = setTimeout(() => {
    piPackageActivationTimer = null
    const scheduler = piPackageActivationScheduler
    if (!scheduler) return
    if (piPackageActivationInFlight) {
      piPackageActivationAgain = true
      return
    }
    piPackageActivationInFlight = true
    void scheduler.tick().then((results) => {
      for (const result of results) {
        if (result.state === 'deferred') {
          const previous = piPackageActivationDeferred.get(result.operationId)
          if (previous !== result.detail) {
            piPackageActivationDeferred.set(result.operationId, result.detail)
            push({
              ch: 'log',
              payload: { text: `[能力接入] ${result.operationId} 暂缓：${result.detail}` }
            })
          }
          continue
        }
        if (result.state === 'resumed' || result.state === 'failed') {
          piPackageActivationDeferred.delete(result.operationId)
          push({
            ch: 'log',
            payload: {
              text: result.state === 'resumed'
                ? `[能力接入] ${result.operationId} 已激活并续接原目标`
                : `[能力接入] ${result.operationId} 未能激活：${result.detail}`
            }
          })
        }
      }
    }).catch((error) => {
      reportMainError('pi-package-activation', error)
    }).finally(() => {
      piPackageActivationInFlight = false
      if (piPackageActivationAgain) {
        piPackageActivationAgain = false
        requestPiPackageActivationTick()
      }
    })
  }, 300)
}

function adoptSubagentParentSessions(statuses: RunnerStatus[]): void {
  const ctrl = subagentService.current()
  if (!ctrl) return
  for (const status of statuses) {
    const sessionId = status.sessionId
    if (!sessionId || sessionId.startsWith('pending:')) continue
    ctrl.adoptParentSession({
      parentRunId: status.runId,
      parentGeneration: status.generation,
      fromSessionId: `pending:${status.runId}`,
      toSessionId: sessionId
    })
  }
}

function pushRunners(): void {
  const statuses = runners?.statuses() ?? []
  push({ ch: 'runners', payload: statuses })
  syncAppViewForeground()
  refreshTrayMenu()
  refreshTaskbar()
  void syncKeepAwake(statuses.some((r) => r.running))
  adoptSubagentParentSessions(statuses)
  notifySubagentFinished.retry()
  workflowService.adoptSessions(statuses)
  workflowService.retryNotices()
}

const publishedRunnerGenerations = new Map<string, number>()
let epochSnapshotScheduled = false
function scheduleEpochSnapshots(): void {
  if (epochSnapshotScheduled) return
  epochSnapshotScheduled = true
  queueMicrotask(() => {
    epochSnapshotScheduled = false
    const statuses = runners?.statuses() ?? []
    const live = new Set(statuses.map((s) => s.id))
    for (const st of statuses) {
      const known = publishedRunnerGenerations.get(st.id)
      if (known === undefined) {
        publishedRunnerGenerations.set(st.id, st.generation)
        continue
      }
      if (st.generation <= known) continue
      publishedRunnerGenerations.set(st.id, st.generation)
      void pushRunnerSnapshot(st.id)
    }
    for (const key of [...publishedRunnerGenerations.keys()]) if (!live.has(key)) publishedRunnerGenerations.delete(key)
  })
}

type ExpectedRuntimeInput = RuntimeRef

function normalizeExpectedRuntime(input: unknown): ExpectedRuntimeInput | null | 'invalid' {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object') return 'invalid'
  const { sessionId, runId, generation } = input as Record<string, unknown>
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) return 'invalid'
  if (runId !== undefined && (typeof runId !== 'string' || !runId)) return 'invalid'
  if (generation !== undefined && (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0)) return 'invalid'
  if (sessionId === undefined && runId === undefined && generation === undefined) return 'invalid'
  return { sessionId, runId, generation }
}

function targetMatchesExpected(id: string, expected: ExpectedRuntimeInput | null): boolean {
  if (!expected) return true
  return RuntimeRef.matches(runners?.runtimeOf(id), expected, 'expected')
}

function runnerForExpected(expected: ExpectedRuntimeInput): AgentController | null {
  const id = resolveExpectedTarget(expected)
  return id ? runners?.agentOf(id) ?? null : null
}

function resolveExpectedTarget(expected: ExpectedRuntimeInput | null): string | null {
  if (!expected) return null
  const id = runners?.resolveExpectedRunner(expected) ?? null
  if (!id || !targetMatchesExpected(id, expected)) return null
  return id
}

function parentContextFromOwner(owner: unknown, settings: Awaited<ReturnType<typeof getSettings>>): SubagentParentContext | null {
  const expected = normalizeExpectedRuntime(owner)
  if (!expected || expected === 'invalid') return null
  const id = resolveExpectedTarget(expected)
  if (!id) return null
  const state = runners?.agentOf(id)?.getState()
  const runtime = runners?.runtimeOf(id)
  if (!state || !runtime) return null
  return {
    cwd: state.cwd ?? settings.cwd,
    parentSessionId: state.sessionId || runtime.sessionId,
    parentRunId: id,
    parentGeneration: runtime.generation,
    projectId: state.cwd ? projectIdForCwd(settings, state.cwd) : undefined
  }
}

interface CapturedParent {
  runId: string
  generation: number
  sessionId?: string
  cwd?: string
  agent: AgentController
}

function captureDefaultParent(): CapturedParent | null {
  const active = runners?.activeRunner()
  const id = active?.id
  if (!id) return null
  const agent = runners?.agentOf(id)
  const runtime = runners?.runtimeOf(id)
  if (!agent || !runtime) return null
  const state = agent.getState()
  return {
    runId: runtime.runId,
    generation: runtime.generation,
    sessionId: runtime.sessionId,
    cwd: state?.cwd ?? active?.cwd,
    agent
  }
}

function parentContextFromCapture(captured: CapturedParent | null, settings: Awaited<ReturnType<typeof getSettings>>): SubagentParentContext {
  if (!captured) return { cwd: settings.cwd }
  if (runners?.agentOf(captured.runId) !== captured.agent) throw new Error('子代理父会话已不可用，未派发')
  const runtime = runners?.runtimeOf(captured.runId)
  if (!runtime || !RuntimeRef.matches(runtime, captured, 'envelope')) throw new Error('子代理父会话已不可用，未派发')
  const state = captured.agent.getState()
  return {
    cwd: captured.cwd ?? state?.cwd ?? settings.cwd,
    parentSessionId: state?.sessionId || runtime.sessionId,
    parentRunId: captured.runId,
    parentGeneration: captured.generation,
    projectId: state?.cwd ? projectIdForCwd(settings, state.cwd) : undefined
  }
}

function resolveSubagentParentContext(
  owner: unknown,
  captured: CapturedParent | null,
  settings: Awaited<ReturnType<typeof getSettings>>
): SubagentParentContext {
  if (owner !== undefined) {
    const context = parentContextFromOwner(owner, settings)
    if (!context) throw new Error('子代理父会话已不可用，未派发')
    return context
  }
  return parentContextFromCapture(captured, settings)
}

async function syncKeepAwake(working: boolean): Promise<void> {
  const s = await getSettings().catch(() => null)
  updateKeepAwake({ working, whileWorking: s?.keepAwakeWhileWorking, onBatteryAllowed: s?.keepAwakeOnBattery })
}

async function pushRunnerSnapshot(id: string, opts: { chainHistory?: boolean } = {}): Promise<void> {
  const ag = runners?.agentOf(id)
  if (!ag) return
  const expected = runners?.runtimeOf(id)
  if (!expected) return
  const st = ag.getState()
  if (st) pushFrom(id, { ch: 'state', payload: st }, expected)
  try {
    let payload = await ag.getMessages({ includeStreaming: true })
    if (runners?.agentOf(id) !== ag || !RuntimeRef.matches(runners?.runtimeOf(id), expected, 'envelope')) return
    if (opts.chainHistory && st?.sessionFile) {
      const chain = await readHistoryWithArtifacts(st.sessionFile, ag.liveTimingRunId()).catch(() => null)
      if (runners?.agentOf(id) !== ag || !RuntimeRef.matches(runners?.runtimeOf(id), expected, 'envelope')) return
      if (chain?.messages?.length && chain.messages.length >= payload.length) payload = chain.messages
    }
    const plan = planSessionSyncAgainst(takeSyncBaseline(st?.sessionFile), payload)
    if (plan.kind === 'delta') {
      pushFrom(id, { ch: 'sync-delta', payload: { anchorId: plan.anchorId, anchorIndex: plan.anchorIndex, anchorSignature: plan.anchorSignature, messages: plan.messages } }, expected)
    } else if (plan.kind === 'none') {
      const anchor = payload[payload.length - 1]
      pushFrom(id, { ch: 'sync-delta', payload: { anchorId: anchor.id, anchorIndex: payload.length - 1, anchorSignature: messageSyncSignature(anchor), messages: [] } }, expected)
    } else {
      pushFrom(id, { ch: 'sync', payload }, expected)
    }
  } catch {
  }
  void ag.refreshStats({ expectGeneration: expected.generation }).catch(() => {})
  void ag.refreshTodos().catch(() => {})
  if (runners?.agentOf(id) === ag) ag.pushSessionLogs()
  pushRunners()
}

let shuttingDown = false
let releaseDesktopDataRoot: (() => Promise<void>) | undefined
let shutdownTask: Promise<void> | null = null
let shutdownFinished = false
function shutdown(): Promise<void> {
  shutdownTask ??= runShutdown().catch((error) => {
    console.error('[shutdown] 退出清理失败', error)
  }).finally(() => {
    shutdownFinished = true
  })
  return shutdownTask
}

async function runShutdown(): Promise<void> {
  shuttingDown = true
  disposeKeepAwake()
  bundledPlugins.close()
  attention?.dispose()
  auxWindows?.dispose()
  const outcomes = await runShutdownSteps(
    [
      { name: 'remote-access', run: async () => { try { await remoteAccess?.stop() } finally { remoteAccess = null } } },
      { name: 'terminals', run: () => disposeTerminals() },
      { name: 'runners', run: () => runners?.stopAll() },
      {
        name: 'mcp-app-view',
        run: () => {
          try { mcpAppViewService?.close() } finally { mcpAppViewService = null; appViewForeground = null }
        }
      },
      { name: 'mcp-app-host', run: () => closeMcpAppHost() },
      { name: 'subagents', run: () => subagentService.current()?.stopAll() },
      { name: 'runs-host', run: async () => { try { await runsHost?.dispose() } finally { runsHost = null } } },
      { name: 'browser', run: () => browser?.dispose() },
      { name: 'pinned-network', run: () => shutdownPinnedNetworkGuard() },
      { name: 'file-name-search', run: () => disposeFileNameSearch() },
      { name: 'usage-stats-worker', run: () => disposeUsageStatsWorker() },
      { name: 'git-read-host', run: () => disposeGitReadHost() },
      { name: 'content-search', run: () => disposeContentSearch() }
    ],
    (outcome) => reportMainError(`shutdown-${outcome.name}`, outcome.timedOut ? new Error('退出步骤超时') : outcome.error)
  )
  try {
    const control = updateControl
    await prepareUpdateAfterWriters(
      outcomes,
      control
        ? {
            prepare: (options) => control.prepareAutomaticInstallOnQuit(options),
            cancel: () => control.cancelAutomaticInstallPreparation()
          }
        : null
    )
  } finally {
    try {
      await releaseDesktopDataRoot?.()
    } catch (error) {
      reportMainError('data-root-unlock', error)
    }
  }
}

type ExitResult = { action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }

function probeExitChoice(): ExitChoice | undefined {
  if (!process.env.YAN_PROBE) return undefined
  return parseProbeChoice(process.env.YAN_EXIT_CHOICE)
}

function quitActivity(): QuitActivity {
  return {
    sessionsBusy: runners?.hasBusy() === true,
    runningSubagents: subagentService.current()?.runningCount ?? 0,
    terminalWorking: hasWorkingTerminal(),
    unsavedFiles: unsavedFiles.count()
  }
}

function showMainWindow(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const deepLinkRouter = windowDeepLinkRouter(() => win ?? undefined, showMainWindow)

app.on('open-url', (event, url) => {
  event.preventDefault()
  deepLinkRouter.handleOpenUrl(url)
})

const CONTROL_KEYS: Readonly<Record<string, string>> = {
  esc: 'ESC',
  escape: 'ESC',
  enter: 'RETURN',
  return: 'RETURN',
  tab: 'TAB',
  backspace: 'BACKSPACE',
  delete: 'DELETE',
  up: 'UP',
  arrowup: 'UP',
  down: 'DOWN',
  arrowdown: 'DOWN',
  left: 'LEFT',
  arrowleft: 'LEFT',
  right: 'RIGHT',
  arrowright: 'RIGHT',
  space: 'SPACE'
}

function controlStatus(): Record<string, unknown> {
  if (!win || win.isDestroyed()) {
    return { ready: false, agentRunning: ac()?.running === true }
  }
  const [contentWidth, contentHeight] = win.getContentSize()
  return {
    ready: true,
    title: win.getTitle(),
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    bounds: win.getBounds(),
    contentSize: { width: contentWidth, height: contentHeight },
    agentRunning: ac()?.running === true
  }
}


const transcribeVoice = voiceTranscriber({ plugins: bundledPlugins, settings: async () => (await getSettings()).voiceInput })

async function startRemoteServer(): Promise<void> {
  if (!remoteAccess) {
    remoteAccess = new RemoteAccess(
      YAN_DIR,
      {
        snapshot: remoteSnapshot,
        history: remoteHistory,
        models: remoteModels,
        subagents: async (sessionId) => remoteSubagents(sessionId, (await subagentService.get()).list()),
        insight: remoteInsight,
        sessionFlags: remoteSetSessionFlag,
        deleteSession: remoteDeleteSession,
        compact: remoteCompact,
        branches: remoteBranches,
        switchBranch: remoteSwitchBranch,
        search: remoteSearch,
        stopSubagent: async (sessionId, runId) => {
          const subagents = await subagentService.get()
          return remoteStopSubagent(sessionId, runId, subagents.list(), (id) => subagents.stop(id))
        },
        image: remoteMessageImage,
        command: executeRemoteCommand,
        questions: remoteQuestions,
        answer: remoteAnswer,
        humanApproval: remoteHumanApproval,
        artifact: remoteArtifact,
        transcribe: async (wav) => {
          const result = await transcribeVoice(wav)
          return result.ok ? { ok: true, data: { text: result.text } } : { ok: false, status: 409, error: result.error }
        }
      },
      (text, level) => {
        if (level === 'error') console.error(`[remote] ${text}`)
        else console.log(`[remote] ${text}`)
      }
    )
  }
  try {
    await remoteAccess.apply((await getSettings()).remoteAccess)
  } catch (error) {
    reportMainError('remote-server', error)
  }
}

async function executeControlCommand(command: ControlCommand): Promise<ControlResponse> {
  try {
    if (command.action === 'status') {
      return { ok: true, action: command.action, data: controlStatus() }
    }

    if (!win || win.isDestroyed()) {
      return { ok: false, action: command.action, error: pick('砚主窗口尚未就绪', 'Main window is not ready') }
    }

    if (command.action === 'focus') {
      showMainWindow()
      return { ok: true, action: command.action, data: controlStatus() }
    }

    if ((command.action === 'click' || command.action === 'type' || command.action === 'key') && (approvals.list().length > 0 || pendingUiReplay().length > 0)) {
      return { ok: false, action: command.action, error: pick('有待处理的审批时不接受遥控输入，请在砚窗口里手动处理审批', 'Remote input is blocked while an approval is pending; handle it in the window') }
    }

    if (command.action === 'click') {
      const [width, height] = win.getContentSize()
      const x = command.x ?? -1
      const y = command.y ?? -1
      if (x < 0 || y < 0 || x >= width || y >= height) {
        return { ok: false, action: command.action, error: pick(`坐标超出内容区域：${width}×${height}`, `Coordinates outside the content area: ${width}×${height}`) }
      }
      showMainWindow()
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      return { ok: true, action: command.action, data: { x, y } }
    }

    if (command.action === 'type') {
      showMainWindow()
      await win.webContents.insertText(command.text ?? '')
      return { ok: true, action: command.action, data: { length: command.text?.length ?? 0 } }
    }

    if (command.action === 'key') {
      const keyCode = CONTROL_KEYS[(command.key ?? '').toLowerCase()]
      if (!keyCode) return { ok: false, action: command.action, error: pick('只支持受限导航键', 'Only restricted navigation keys are supported') }
      showMainWindow()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      return { ok: true, action: command.action, data: { key: command.key } }
    }

    if (command.action === 'send') {
      showMainWindow()
      const active = runners?.activeRunner()
      if (active) {
        const guard = runners!.guardExecute(active.id)
        if (!guard.ok) return { ok: false, action: command.action, error: guard.error }
      }
      const result = (active?.id ? await runners?.agentOf(active.id)?.send(command.text ?? '') : undefined) ?? { ok: false, error: piDown() }
      return result.ok
        ? { ok: true, action: command.action, data: { length: command.text?.length ?? 0 } }
        : { ok: false, action: command.action, error: result.error ?? piDown() }
    }

    return { ok: false, action: command.action, error: pick('未知控制动作', 'Unknown control action') }
  } catch (error) {
    return {
      ok: false,
      action: command.action,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function dispatchControlCommand(command: ControlCommand): Promise<void> {
  const response = await executeControlCommand(command)
  try {
    await writeControlResponse(command.requestId, response)
  } catch (error) {
    reportMainError('control-response', error)
  }
}

function requestExit(options: { relaunch?: boolean; source?: string } = {}): Promise<ExitResult> {
  if (isQuitting) return Promise.resolve({ action: 'already-exiting' })
  if (exitRequestInFlight) return exitRequestInFlight
  exitSource = options.source ?? 'unknown'

  const task: Promise<ExitResult> = (async (): Promise<ExitResult> => {
    const activity = quitActivity()
    const reasons = quitReasons(activity)
    let choice = probeExitChoice()
    if (!choice && reasons.length > 0 && win && !win.isDestroyed()) {
      const prompt = quitPrompt(activity, reasons)
      try {
        const response = await dialog.showMessageBox(win, {
          type: 'warning',
          title: pick('退出砚', 'Quit Inkstone'),
          message: prompt.message,
          detail: prompt.detail,
          buttons: prompt.buttons,
          defaultId: 1,
          cancelId: 0,
          noLink: true
        })
        choice = choiceFromResponse(response.response)
      } catch (error) {
        reportMainError('quit-dialog', error)
      }
    }
    if (!choice) choice = 'save'
    if (choice === 'cancel') return { action: 'cancelled' }

    isQuitting = true
    exitReason = choice === 'save' ? 'user-save-and-exit' : 'user-interrupt-exit'
    const mode = choice === 'save' ? 'save' : 'interrupt'
    await writeExitSnapshot(mode, runners?.statuses() ?? []).catch((error) => {
      console.error('[exit-snapshot] 写入失败：', error)
    })
    const action: 'save-and-exit' | 'interrupt-exit' = choice === 'save' ? 'save-and-exit' : 'interrupt-exit'
    if (options.relaunch) app.relaunch()
    void shutdown().then(() => app.quit())
    return { action }
  })()

  exitRequestInFlight = task
  void task.then(
    () => {
      if (exitRequestInFlight === task) exitRequestInFlight = null
    },
    () => {
      if (exitRequestInFlight === task) exitRequestInFlight = null
    }
  )
  return task
}

function shellIconPath(): string | undefined {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconCandidates = [
    join(app.getAppPath(), 'build', file),
    join(__dirname_, '..', '..', 'build', file),
    join(app.getAppPath(), 'build', 'icon.png')
  ]
  return iconCandidates.find((candidate) => existsSync(candidate))
}

function trayTheme(): TrayTheme {
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'on-dark' : 'on-light'
}

function trayDirs(): string[] {
  return [join(app.getAppPath(), 'build', 'tray'), join(__dirname_, '..', '..', 'build', 'tray')]
}

function trayImage(): Electron.NativeImage {
  const name = trayTheme() === 'on-dark' ? 'tray-on-dark.png' : 'tray-on-light.png'
  const candidates = trayDirs().map((dir) => join(dir, name))
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return nativeImage.createFromPath(found)
  const iconPath = shellIconPath()
  return iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
}

function ensureTrayAssets(): void {
  if (!trayAssets) {
    trayAssets = createTrayAssetStore({
      dirs: trayDirs(),
      createImage: (path) => nativeImage.createFromPath(path),
      readFile: (path) => readFileSync(path, 'utf8'),
      exists: (path) => existsSync(path),
      onWarn: (message) => push({ ch: 'log', payload: { text: `[托盘] ${message}` } })
    })
  }
  trayAssets.load()
}

function projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return settings.projects.find((project) => normalize(project.cwd) === normalize(cwd))?.id
}

function capabilityProjectId(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string {
  const registered = projectIdForCwd(settings, cwd)
  if (registered) return registered
  return deriveProjectId(cwd, (id) => settings.projects.some((project) => project.id === id))
}

async function relocateMissingCwd(missing: string): Promise<string | null> {
  if (!win) return null
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    title: pick('项目文件夹找不到了', 'Project folder not found'),
    message: pick('这个会话原来的项目文件夹不在了', 'This session’s project folder is gone'),
    detail: `${missing}\n\n${pick('可能被改名、移动或删除。重新指定后，这个会话会在新文件夹里继续。', 'It may have been renamed, moved, or deleted. After choosing a new folder, the session continues there.')}`,
    buttons: [pick('重新指定文件夹', 'Choose folder'), pick('取消', 'Cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (choice.response !== 0) return null
  let near = dirname(resolve(missing))
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near)
  const picked = await dialog.showOpenDialog(win, { title: pick('选择这个会话的项目文件夹', 'Choose the project folder for this session'), defaultPath: near, properties: ['openDirectory'] })
  return picked.canceled ? null : picked.filePaths[0] ?? null
}

async function validateCwd(cwd: unknown): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { ok: false, error: pick('工作目录不能为空', 'Working folder is required') }
  }
  const raw = cwd.trim()
  const absolute = resolve(raw)
  try {
    const info = await stat(absolute)
    if (!info.isDirectory()) {
      return { ok: false, error: pick(`工作目录不是文件夹：${raw}`, `Working folder is not a folder: ${raw}`) }
    }
    await access(absolute, fsConstants.R_OK)
    return { ok: true, cwd: absolute }
  } catch {
    return { ok: false, error: pick(`工作目录不存在或不可访问：${raw}`, `Working folder does not exist or is inaccessible: ${raw}`) }
  }
}

interface SessionMoveJob {
  sessionId: string
  sessionFile: string
  target: string
  registry: RunnerRegistry
  origin: PinnedSendTarget
  continuation: (afterHostStop?: boolean) => boolean
  claimed?: boolean
}

const pendingSessionMoves = new Map<string, SessionMoveJob>()

async function requestSessionMove(request: SessionMovePrompt): Promise<SessionMoveAnswer> {
  const key = normalizeCwdForIdentity(request.sessionFile)
  const registry = runners
  const hit = registry?.statuses().find(status => !!status.sessionFile && normalizeCwdForIdentity(status.sessionFile) === key)
  const origin = hit ? pinSendTarget(hit.id) : null
  if (!registry || !origin || origin.sessionId !== request.sessionId) return { decision: 'invalid', message: '来源会话已变化，没有移动。' }
  if (pendingSessionMoves.has(key)) return { decision: 'invalid', message: '这条会话已有待完成的移动，请勿重复请求。' }
  const job: SessionMoveJob = { sessionId: request.sessionId, sessionFile: request.sessionFile, target: request.dir, registry, origin, continuation: origin.agent.captureSessionMoveContinuation() }
  pendingSessionMoves.set(key, job)
  let scheduled = false
  try {
    const checked = await validateCwd(isAbsolute(request.dir) ? request.dir : resolve(request.cwd || process.cwd(), request.dir))
    if (!checked.ok) return { decision: 'invalid', message: `${checked.error}。会话留在当前文件夹。` }
    const target = job.target = checked.cwd
    if (normalizeCwdForIdentity(target) === normalizeCwdForIdentity(request.cwd)) {
      return { decision: 'same', target, message: '会话已经在这个文件夹里，不需要移动。' }
    }
    const choice = await approvals.ask({
      kind: 'move', tool: 'session', title: '允许把这次会话移到另一个文件夹？', detail: target,
      reasons: [
        ...(request.reason ? [request.reason] : []),
        '本轮正常结束后切换并继续尚未完成的原任务：对话保留，后续命令在新目录运行；人工停止或失败时不自动继续。'
      ],
      cwd: request.cwd, canRemember: false
    })
    if (choice?.choice !== 'once' && choice?.choice !== 'remember') {
      return { decision: choice?.choice === 'deny' ? 'denied' : 'no-answer', target,
        ...(choice?.feedback ? { feedback: choice.feedback } : {}),
        message: choice?.choice === 'deny' ? withDenyFeedback('用户拒绝移动，继续在当前文件夹工作。', choice.feedback) : '没有得到答复，会话留在当前文件夹。' }
    }
    if (runners !== registry || !pinnedTargetMatches(origin)) return { decision: 'invalid', target, message: '批准期间来源会话已变化，没有移动。' }
    scheduled = true
    void moveSessionWhenIdle(job).catch(error => reportMainError('session-move', error)).finally(() => {
      if (pendingSessionMoves.get(key) === job) pendingSessionMoves.delete(key)
    })
    return { decision: 'approved', target,
      message: `已批准：本轮结束后，会话的工作目录切换到 ${target}。请用一两句话说明下一步并结束本轮；正常收尾后宿主会在新目录自动续接一次，不要在当前目录继续操作。人工停止或失败时不会自动续接。` }
  } finally {
    if (!scheduled && pendingSessionMoves.get(key) === job) pendingSessionMoves.delete(key)
  }
}

async function continueMovedSession(job: SessionMoveJob, projectId?: string): Promise<{ continued: boolean; continuationError?: string }> {
  try {
    if (shuttingDown || runners !== job.registry || !job.continuation(true)) throw new Error('原回合已停止、失败或失效，未自动继续')
    const scope = projectId ? 'project' : 'global'
    const selected = await job.registry.select({ sessionFile: job.sessionFile, sessionId: job.sessionId, cwd: job.target, projectId, scope, activate: false })
    if (!selected.ok || !selected.id) throw new Error(selected.error ?? '无法在新目录恢复会话')
    const pin = pinSendTarget(selected.id)
    const fresh = pin?.agent.captureSessionMoveContinuation()
    const selectedRuntime = { runId: selected.runId ?? selected.id, generation: selected.generation, sessionId: selected.sessionId }
    const current = () => !shuttingDown && runners === job.registry && !!pin && pinnedTargetMatches(pin) &&
      RuntimeRef.matches(pin, selectedRuntime, 'envelope') && pin.sessionId === job.sessionId &&
      normalizeCwdForIdentity(pin.agent.getState()?.cwd ?? '') === normalizeCwdForIdentity(job.target) &&
      job.continuation(true) && fresh?.() === true
    if (!pin || !current()) throw new Error('恢复目标已变化，未自动继续')
    await sessionHost.rememberRunnerSession(selected, { cwd: job.target, projectId, scope })
    if (!current()) throw new Error('恢复期间会话已停止或变化，未自动继续')
    const guard = job.registry.guardExecute(selected.id)
    if (!guard.ok) throw new Error(guard.error)
    const sent = await pin.agent.send(movedSessionContinuationPrompt(job.target))
    if (!sent.ok) throw new Error(sent.error ?? '续接指令没有发出')
    void sessionHost.pushRunnerSnapshot(selected.id)
    return { continued: true }
  } catch (error) {
    return { continued: false, continuationError: error instanceof Error ? error.message : String(error) }
  }
}

async function moveSessionWhenIdle(job: SessionMoveJob): Promise<void> {
  const key = normalizeCwdForIdentity(job.sessionFile)
  if (pendingSessionMoves.get(key) !== job || job.claimed) return
  job.claimed = true
  let lease: SessionMoveLease | null = null
  let stopped = false
  let headerCwd: string | undefined
  let failure: string | undefined
  try {
    const deadline = Date.now() + 30 * 60_000
    for (;;) {
      if (shuttingDown || runners !== job.registry || !pinnedTargetMatches(job.origin)) throw new Error('来源会话已关闭或变化，没有移动')
      const state = job.origin.agent.getState()
      if (!state?.isAgentRunning && !state?.isStreaming && !state?.isCompacting && job.origin.agent.getPendingUiCount() === 0) break
      if (Date.now() > deadline) throw new Error('等这一轮结束超时，会话没有移动')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    const resume = job.continuation()
    lease = beginSessionMove(job.sessionFile)
    if (!lease) throw new Error(pick('这条会话已有正在进行的移动，没有移动', 'This session is already being moved; nothing was moved'))
    await job.registry.stopOne(job.origin.runId)
    stopped = !job.origin.agent.running
    if (shuttingDown || job.origin.agent.running) throw new Error('原会话进程未安全关闭，没有改写会话文件')
    const { previousCwd } = await rewriteSessionCwd(job.sessionFile, job.target, lease)
    headerCwd = previousCwd
    let settings = await getSettings()
    const before = settings
    const projectOf = (current: typeof settings) => current.projects.find(p => !p.archived && normalizeCwdForIdentity(p.cwd) === normalizeCwdForIdentity(job.target))
    const previousProjectId = before.projects.find(p => normalizeCwdForIdentity(p.cwd) === normalizeCwdForIdentity(headerCwd ?? ''))?.id ?? null
    try {
      if (!projectOf(settings)) settings = await patchSettings({ recentCwds: [job.target, ...(settings.recentCwds ?? [])] })
      await moveSessionLayout({ sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: job.target }, projectOf(settings)?.id ?? null)
    } catch (error) {
      const rollbackCwd = headerCwd ?? job.origin.agent.getState()?.cwd ?? ''
      const restored = await restoreSessionHeaderCwd(job.sessionFile, rollbackCwd, lease)
      if (settings !== before) await patchSettings({ recentCwds: before.recentCwds }).catch(() => undefined)
      await moveSessionLayout({ sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: rollbackCwd }, previousProjectId).catch(() => undefined)
      headerCwd = rollbackCwd
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(restored
        ? pick(`保存会话位置失败，已回滚会话文件：${reason}`, `Could not save the session location; the session file was rolled back: ${reason}`)
        : pick(`保存会话位置失败，会话文件回滚失败：${reason}`, `Could not save the session location, and rolling the session file back failed: ${reason}`))
    }
    const continuation = resume ? await continueMovedSession(job, projectOf(settings)?.id) :
      { continued: false, continuationError: '原回合已停止、失败或有新的输入，未自动继续' }
    push({ ch: 'session-moved', payload: { sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: job.target, ok: true, ...continuation } })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    if (stopped && !shuttingDown && runners === job.registry) {
      const reopened = await job.registry.select({ sessionFile: job.sessionFile, cwd: headerCwd ?? job.origin.agent.getState()?.cwd ?? '' })
      if (!reopened.ok && reopened.error) failure = pick(`${failure}；重新打开原会话失败：${reopened.error}`, `${failure}; reopening the original session failed: ${reopened.error}`)
    }
    push({ ch: 'session-moved', payload: { sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: job.target, ok: false, error: failure } })
  } finally {
    lease?.release()
    pushRunners()
  }
}

type FileContextResult =
  | { ok: true; context: FileRequestContext }
  | { ok: false; context: FileRequestContext; error: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCwdForIdentity(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

async function resolveFileContext(
  settings: Awaited<ReturnType<typeof getSettings>>,
  fallbackCwd: string,
  rawContext: unknown
): Promise<FileContextResult> {
  const raw = isObject(rawContext) ? rawContext : {}
  const requestedCwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd : fallbackCwd
  const generation = typeof raw.generation === 'number' && Number.isFinite(raw.generation)
    ? Math.max(0, Math.floor(raw.generation))
    : 0
  const projectId = typeof raw.projectId === 'string' && raw.projectId.trim()
    ? raw.projectId.trim().slice(0, 160)
    : undefined
  const provisional: FileRequestContext = {
    cwd: requestedCwd,
    generation,
    ...(projectId ? { projectId } : {})
  }
  const allowedCwds = [
    settings.cwd,
    ...settings.projects.filter((project) => !project.archived).map((project) => project.cwd),
    ...(runners?.statuses().map((runner) => runner.cwd) ?? [])
  ]
  if (!await isAuthorizedFileCwd(requestedCwd, allowedCwds)) {
    return { ok: false, context: provisional, error: pick('工作目录不属于已授权的项目或会话', 'Working folder is not in an authorized project or session') }
  }
  const checked = await validateCwd(requestedCwd)
  if (!checked.ok) return { ok: false, context: provisional, error: checked.error }

  if (projectId) {
    const project = settings.projects.find((item) => item.id === projectId)
    if (!project) return { ok: false, context: { ...provisional, cwd: checked.cwd }, error: pick('项目不存在或已被移除', 'Project not found or removed') }
    if (normalizeCwdForIdentity(project.cwd) !== normalizeCwdForIdentity(checked.cwd)) {
      if (await isRunnerProjectCwd(checked.cwd, projectId, runners?.statuses() ?? [])) {
        return { ok: true, context: { ...provisional, cwd: checked.cwd } }
      }
      const byCwd = settings.projects.find(
        (item) => normalizeCwdForIdentity(item.cwd) === normalizeCwdForIdentity(checked.cwd)
      )
      if (!byCwd) {
        return { ok: false, context: { ...provisional, cwd: checked.cwd }, error: pick('项目与工作目录不匹配', 'Project and working folder do not match') }
      }
      return { ok: true, context: { ...provisional, cwd: checked.cwd, projectId: byCwd.id } }
    }
  }

  return { ok: true, context: { ...provisional, cwd: checked.cwd } }
}

async function openSessionWorktree(cwd: string): Promise<{ ok: true; cwd: string; branch: string } | { ok: false; error: string }> {
  const outcome = await isolateCwdForConflict(cwd)
  if (!outcome.ok) return { ok: false, error: outcome.reason }
  await autoIsolations.add(outcome.record).catch(() => undefined)
  const target = isolatedSessionCwd(outcome.record)
  setIsolationView(target, { state: 'waiting', branch: outcome.record.branch })
  return { ok: true, cwd: target, branch: outcome.record.branch }
}

async function sessionWorktrees(): Promise<{ cwd: string; branch: string }[]> {
  return (await autoIsolations.all()).map((record) => ({ cwd: isolatedSessionCwd(record), branch: record.branch }))
}

async function isolatedSessionOwner(cwd: string, sessionId: string): Promise<{ projectId?: string; scope: 'global' | 'project' | 'pending' } | undefined> {
  const record = await autoIsolations.byWorktree(cwd).catch(() => null)
  if (!record) return undefined
  const previous = (await getSessionLayout()).entries.find((entry) => entry.sessionId === sessionId)
  if (previous) return { ...(previous.projectId ? { projectId: previous.projectId } : {}), scope: previous.scope }
  const projectId = projectIdForCwd(await getSettings(), record.mainCwd)
  return projectId ? { projectId, scope: 'project' } : undefined
}

async function rememberRunnerSession(
  result: { ok: boolean; id?: string; sessionId?: string },
  target: { sessionFile?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }
): Promise<void> {
  if (!result.ok || !result.sessionId) return
  const state = result.id ? runners?.agentOf(result.id)?.getState() : undefined
  if (result.sessionId) {
    void autoIsolations.bindSession(state?.cwd ?? target.cwd, result.sessionId).catch(() => undefined)
  }
  const cwd = state?.cwd ?? target.cwd
  const owner = target.projectId ? undefined : await isolatedSessionOwner(cwd, result.sessionId)
  const projectId = owner ? owner.projectId : target.projectId
  const scope = owner ? owner.scope : target.scope
  await rememberSession({
    sessionId: result.sessionId,
    sessionFile: state?.sessionFile ?? target.sessionFile,
    cwd,
    ...(projectId ? { projectId } : {}),
    ...(scope ? { scope } : {})
  }).catch((error) => {
    console.error('[session-layout] 记录会话归属失败：', error)
  })
}

let starting: Promise<{ ok: boolean; error?: string }> | null = null
let agentResponseDetail: 'brief' | 'standard' | 'detailed' = 'standard'
let launchSettings: Awaited<ReturnType<typeof getSettings>> | null = null

async function refreshLaunchContext(): Promise<Awaited<ReturnType<typeof getSettings>>> {
  const settings = await getSettings()
  await refreshManagedGit().catch(() => undefined)
  applyBundledSearchTools()
  agentResponseDetail = settings.responseDetail
  launchSettings = settings
  return settings
}

interface SessionRestore {
  sessionFile: string
  interrupted: boolean
}

let restoreNotice: string | undefined

async function turnsWereInterrupted(sessionFile: string): Promise<boolean> {
  const bucket = timingKey(sessionFile)
  const records = bucket ? await readTurnTimings(YAN_DIR, bucket).catch(() => []) : []
  const last = [...records].sort((a, b) => a.endedAt - b.endedAt).at(-1)
  if (last && effectiveTerminalReason(last) === 'interrupted') return true
  const tail = await readSessionTail(sessionFile).catch(() => ({}))
  return tailTurnInterrupted(tail, last?.endedAt)
}

async function usableSessionFile(sessionFile: string | undefined): Promise<string | undefined> {
  if (!sessionFile) return undefined
  if (!existsSync(sessionFile)) return undefined
  if (!(await isSessionFileInSessionsDir(sessionFile).catch(() => false))) return undefined
  return sessionFile
}

async function restoreFromExitSnapshot(): Promise<SessionRestore | undefined> {
  const snapshot = await readExitSnapshot().catch(() => null)
  if (!snapshot) return undefined
  const runner = pickRestoreRunner(snapshot)
  await clearExitSnapshot().catch(() => undefined)
  const sessionFile = await usableSessionFile(runner?.sessionFile)
  if (!sessionFile) return undefined
  return { sessionFile, interrupted: runner?.running === true || (await turnsWereInterrupted(sessionFile)) }
}

async function restoreLastSession(): Promise<SessionRestore | undefined> {
  const layout = await getSessionLayout().catch(() => null)
  const candidates = (layout?.entries ?? []).filter((entry) => !!entry.sessionFile && !entry.archivedAt)
  const pick = candidates.sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))[0]
  const sessionFile = await usableSessionFile(pick?.sessionFile)
  if (!sessionFile) return undefined
  return { sessionFile, interrupted: await turnsWereInterrupted(sessionFile) }
}

async function restorePreviousSession(): Promise<SessionRestore | undefined> {
  const restored = (await restoreFromExitSnapshot().catch(() => undefined)) ?? (await restoreLastSession().catch(() => undefined))
  if (restored?.interrupted) restoreNotice = pick('上次退出时这一回合没有结束，已恢复该会话；已生成的内容保留在会话里。', 'The last turn did not finish before exit. The session was restored and generated content is kept.')
  return restored
}

async function whenAgentStarted(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
}

function flushRestoreNotice(): void {
  const message = restoreNotice
  if (!message) return
  restoreNotice = undefined
  push({ ch: 'notify', payload: { id: 'session-restore', method: 'notify', notifyType: 'info', message } })
}

const pendingSubagentRuns = new Map<string, Extract<MainPush, { ch: 'subagent' }>['payload']>()
let subagentFlushTimer: ReturnType<typeof setTimeout> | null = null

function flushSubagentRuns(): void {
  if (subagentFlushTimer) {
    clearTimeout(subagentFlushTimer)
    subagentFlushTimer = null
  }
  if (pendingSubagentRuns.size === 0) return
  const runs = [...pendingSubagentRuns.values()]
  pendingSubagentRuns.clear()
  for (const run of runs) push({ ch: 'subagent', payload: run })
}

function queueSubagentRun(run: Extract<MainPush, { ch: 'subagent' }>['payload']): void {
  pendingSubagentRuns.set(run.id, run)
  if (run.status !== 'starting' && run.status !== 'running') {
    flushSubagentRuns()
    return
  }
  if (subagentFlushTimer) return
  subagentFlushTimer = setTimeout(flushSubagentRuns, 150)
  subagentFlushTimer.unref?.()
}

async function reclaimQueuedMessages(): Promise<void> {
  void pruneReclaimedQueues().catch(() => undefined)
  const pending = await readdir(QUEUE_RECOVERY_DIR).catch(() => [] as string[])
  if (!pending.some((name) => name.endsWith('.json'))) return
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (starting) await starting.catch(() => undefined)
    const agent = ac()
    if (agent?.getState()?.sessionId) {
      await agent.reclaimSavedQueue().catch(() => undefined)
      return
    }
    await new Promise((done) => setTimeout(done, 250))
  }
}

let extensionSourcesReported = false

async function reportExtensionSources(): Promise<void> {
  if (extensionSourcesReported) return
  extensionSourcesReported = true
  const thin = yanThinExtensionPaths()
  const settings = await getSettings()
  const probe = resolvePi({ override: settings.piBin })
  const version = probe.home ? await readFile(join(probe.home, 'package.json'), 'utf8').then(text => JSON.parse(text).version as string).catch(() => undefined) : undefined
  for (const text of extensionDiagnostics({ piDir: PI_AGENT_DIR, yanThinPaths: thin, nativeDiscovery: nativePiToolsSupported(version) })) {
    push({ ch: 'log', payload: { text } })
  }
}

function startAgent(restore?: { sessionFile?: string }): Promise<{ ok: boolean; error?: string }> {
  if (starting) return starting
  starting = doStartAgent(restore).finally(() => {
    starting = null
  })
  return starting
}

async function doStartAgent(restore?: { sessionFile?: string }): Promise<{ ok: boolean; error?: string }> {
  if (runners?.active()?.running) return { ok: true }
  if (restore?.sessionFile) void readHistoryWithArtifacts(restore.sessionFile).catch(() => undefined)
  const crashedId = runners?.activeRunnerId
  const crashedFile = crashedId ? runners?.agentOf(crashedId)?.getState()?.sessionFile : undefined
  const othersWorking = !!crashedId && (
    (runners?.hasPendingWorkExcept(crashedId) ?? false) ||
    (subagentService.current()?.list() ?? []).some((run) => run.status === 'running' || run.status === 'starting')
  )
  if (runners && crashedId && othersWorking && (!restore?.sessionFile || restore.sessionFile === crashedFile)) {
    const restarted = await runners.restartOne(crashedId)
    if (restarted.ok) return { ok: true }
    return { ok: false, error: pick(`重启这个会话失败：${restarted.error ?? '未知原因'}。其他会话或子 Agent还在运行，没有把它们一起重启；等它们停下后再试。`, `Failed to restart this session: ${restarted.error ?? 'unknown reason'}. Other sessions or subagents are still running and were not restarted; try again after they stop.`) }
  }
  await runners?.stopAll()

  const settings = await refreshLaunchContext()

  runners = new RunnerRegistry({
    isSessionVisible: (state) => runnerVisibility.includes(state),
    isParentProtected: (sessionId, runId) => subagentService.current()?.hasParentRun(sessionId, runId) ?? false,
    hasRunningSubagents: (sessionId) => (subagentService.current()?.runningSiblings({ parentSessionId: sessionId }) ?? 0) > 0,
    onReclaimed: ({ id, sessionId, idleMs, remaining }) => {
      mcpAppViewService?.invalidateRunnerId(id)
      const text = `[运行实例回收] ${id} (${sessionId ?? 'unknown'}) 空闲 ${Math.floor(idleMs / 1000)} 秒，释放1个 pi 实例，剩余 ${remaining} 个`
      console.log(text)
      push({ ch: 'log', payload: { text } })
      void discardUnusedIsolations()
    },
    prepareNewSession: async agent => {
      return applyRememberedModel(agent, (await getSettings()).lastMainModel)
    },
    isolationOf,
    launchSignature: () => launchResources().signature,
    createAgent: (id, cwd, generation) => {
      const agent: AgentController = new AgentController({
        push: (m) => {
          if (runners?.agentOf(id) === agent) pushFrom(id, m)
        },
        observeRun: runsHost?.observerFor({ generation }) ?? undefined,
        cwd,
        piBin: (launchSettings ?? settings).piBin,
        ...yanThinExtensions(),
        getResponseDetail: () => agentResponseDetail,
        browserHost: () => browser,
        subagentHost: { run: (command, params, context) => command.startsWith('workflow.') ? workflowService.run(command, params, context) : subagentService.capabilityHost.run(command, params, context) },
        switchSpareAccount: switchToSpareAccount,
        mcpAppToolsSnapshot: mcpAppProxyService().snapshotPath(),
        providerExtensions: launchResources().providers,
        bundledSkills: launchResources().skills,
        userSkills: () => userSkillPaths(),
        readHistory: (sessionFile, liveRunId) => readHistoryWithArtifacts(sessionFile, liveRunId),
        capability: {
          sessionId: id ?? 'primary',
          runnerGeneration: generation ?? 1,
          projectId: capabilityProjectId(launchSettings ?? settings, cwd),
          opsDir: join(YAN_DIR, 'ops'),
          preserveResult: (command: string, operationId: string, data: unknown) => preserveSearchOp(join(YAN_DIR, 'ops'), command, operationId, data),
          binDir: join(YAN_DIR, 'bin'),
          artifactDir: join(YAN_DIR, 'artifacts'),
          devResourcesDir: join(app.getAppPath(), 'resources'),
          ...(id
            ? {
                execution: runners?.executionPort(id) ?? {
                  claim: () => ({ ok: false as const, error: pick('运行实例注册表尚未就绪', 'Runtime registry is not ready') }),
                  confirm: () => false,
                  release: () => {}
                }
              }
            : {}),
          onBashSettled: () => requestPiPackageActivationTick(),
          trashItem: (path: string) => shell.trashItem(path),
          previewHtml: (htmlPath: string, root: string, options?: { at?: number[] }) =>
            captureHtmlPreviewShots({ previews: htmlArtifactPreviews, htmlPath, root, outDir: join(YAN_DIR, 'artifact-previews'), ...(options?.at ? { at: options.at } : {}) }),
          exportVideo: (htmlPath: string, root: string, request: { fps?: number; scale?: number; outPath?: string }) =>
            exportVideo({ htmlPath, root, ...request }),
          exportImage: (htmlPath: string, root: string, request: { width?: number; height?: number; scale?: number; selector?: string; outPath?: string }) =>
            exportHtmlImage({ previews: htmlArtifactPreviews, htmlPath, root, ...request })
        },
        confirmCapabilityAuthorization: async (
          request: CapabilityAuthorizationPrompt
        ): Promise<CapabilityAuthorizationChoice> => {
          if (!win || win.isDestroyed()) return 'deny'
          const isRemote = request.kind === 'remote-mcp'
          const trust = isRemote ? null : await trustStatus(request.cwd)
          const buttons = isRemote
            ? [pick('拒绝', 'Deny'), pick('允许此项目连接该 host', 'Allow this project to connect to the host')]
            : trust?.trusted
              ? [pick('拒绝', 'Deny'), pick('允许（禁用 lifecycle scripts）', 'Allow (lifecycle scripts disabled)'), pick('允许（包含 lifecycle scripts）', 'Allow (with lifecycle scripts)')]
              : [
                  pick('拒绝', 'Deny'),
                  pick('允许并信任此项目（禁用 lifecycle scripts）', 'Allow and trust this project (lifecycle scripts disabled)'),
                  pick('允许并信任此项目（包含 lifecycle scripts）', 'Allow and trust this project (with lifecycle scripts)')
                ]
          const response = await dialog.showMessageBox(win, {
            type: 'warning',
            title: isRemote ? pick('授权远程 MCP 服务', 'Authorize remote MCP service') : pick('授权本地能力包', 'Authorize local capability package'),
            message: isRemote
              ? pick(`是否允许当前项目连接「${request.title}」？`, `Allow this project to connect to "${request.title}"?`)
              : pick(`是否允许当前项目接入「${request.title}」并运行其本机代码？`, `Allow this project to use "${request.title}" and run its local code?`),
            detail: [
              pick(`候选：${request.source}`, `Candidate: ${request.source}`),
              pick(`项目：${request.projectId}`, `Project: ${request.projectId}`),
              pick(`内容指纹：${request.digest}`, `Digest: ${request.digest}`),
              ...(request.endpoint ? [pick(`远程端点：${request.endpoint}`, `Remote endpoint: ${request.endpoint}`), pick('该服务会收到本任务发送给它的请求内容。', 'The service receives the request content sent to it by this task.')] : []),
              ...(!isRemote
                ? [
                    pick(
                      '安装前的临时环境加载验证（smoke）会实际加载候选扩展并执行代码，pi 重载时也会运行扩展。代码以当前桌面用户权限执行，可读写该用户的文件并联网；临时目录和清空继承环境不是操作系统沙箱。',
                      'The pre-install smoke check loads the candidate extension and runs its code in a temporary environment, and pi runs extensions on reload. Code runs with the current desktop user’s permissions and can read and write that user’s files and use the network; a temp directory and cleared environment are not an OS sandbox.'
                    ),
                    pick(
                      '禁用 npm lifecycle scripts 只关闭安装生命周期脚本，不会阻止扩展代码运行，也不会隔离其运行时权限。',
                      'Disabling npm lifecycle scripts only turns off install-time scripts; it does not stop extension code from running or isolate its runtime permissions.'
                    ),
                    ...(trust?.trusted
                      ? [pick('此项目已经在 trust.json 中显式信任；本次不会改写信任设置。', 'This project is already trusted in trust.json; trust settings will not be changed.')]
                      : [
                          pick(
                            '此项目尚未信任。允许后会把当前目录写入 Pi 的 trust.json；该项目现有及未来的 .pi 设置、扩展、技能等资源都将允许加载，不只限于本候选。请仅对你信任的项目允许。',
                            'This project is not trusted yet. Allowing writes the current folder to Pi’s trust.json; its existing and future .pi settings, extensions, and skills will all be allowed to load, not just this candidate. Allow only projects you trust.'
                          )
                        ])
                  ]
                : []),
              pick('授权仅绑定此候选 / host 与当前项目；拒绝时不会登记或执行。', 'Authorization applies only to this candidate / host and this project; if denied, nothing is registered or run.')
            ].join('\n'),
            buttons,
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
          if (isRemote) return response.response === 1 ? 'allow' : 'deny'
          const choice = response.response === 2
            ? 'allow-with-lifecycle-scripts'
            : response.response === 1
              ? 'allow'
              : 'deny'
          if (choice !== 'deny' && trust && !trust.trusted) {
            const saved = await allowTrust(request.cwd)
            if (!saved.ok) {
              await dialog.showMessageBox(win, {
                type: 'error',
                title: pick('无法信任项目', 'Cannot trust project'),
                message: pick('项目包授权未保存', 'Package authorization was not saved'),
                detail: saved.error ?? pick('写入 Pi trust.json 失败。没有保存候选授权。', 'Failed to write Pi trust.json. The authorization was not saved.'),
                buttons: [pick('确定', 'OK')],
                noLink: true
              })
              return 'deny'
            }
          }
          return choice
        },
        confirmExternalApi: async (request: ExternalApiConfirmationRequest): Promise<boolean> => {
          if (!win || win.isDestroyed()) return false
          const endpoint = request.endpoint || pick('未配置的 OpenAI-compatible endpoint', 'Unconfigured OpenAI-compatible endpoint')
          const response = await dialog.showMessageBox(win, {
            type: 'warning',
            title: pick('确认外部图像 API 请求', 'Confirm external image API request'),
            message: pick(
              `即将通过 ${({ compatible: 'OpenAI-compatible API', openai: 'OpenAI API', google: 'Google Gemini API', doubao: '火山方舟（豆包）API', local: '远程 SD WebUI' } as const)[request.provider]} 生成图片`,
              `About to generate an image via ${({ compatible: 'OpenAI-compatible API', openai: 'OpenAI API', google: 'Google Gemini API', doubao: 'Volcano Ark (Doubao) API', local: 'remote SD WebUI' } as const)[request.provider]}`
            ),
            detail: [
              pick(`端点：${endpoint}`, `Endpoint: ${endpoint}`),
              pick(`模型：${request.model}`, `Model: ${request.model}`),
              pick(`项目：${request.cwd}`, `Project: ${request.cwd}`),
              pick(`提示词：${request.prompt.slice(0, 800)}${request.prompt.length > 800 ? '…' : ''}`, `Prompt: ${request.prompt.slice(0, 800)}${request.prompt.length > 800 ? '…' : ''}`),
              '',
              pick('这会把提示词（以及将来接入的参考图片）发送到外部服务，并可能产生 API 费用。拒绝后不会发送请求，也不会自动切换到其他供应商。', 'This sends the prompt (and any future reference images) to an external service and may incur API costs. If denied, no request is sent and no other provider is tried.')
            ].join('\n'),
            buttons: [pick('取消', 'Cancel'), pick('继续发送', 'Send')],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
          return response.response === 1
        },
        getPermissionMode: async () => (await getSettings()).permissionMode ?? 'danger',
        confirmDanger: async (request): Promise<ApprovalDecision | null> => {
          const outsideDirs = [...new Set((request.outsideDirs ?? []).filter((p) => typeof p === 'string' && isAbsolute(p)).map((p) => dirname(resolve(p))))]
          const rememberDirs = request.outsideTruncated ? [] : outsideDirs.filter((dir) => !isBroadAllowRoot(dir))
          const isPermission = request.kind === 'permission'
          const isDelete = request.kind === 'delete'
          const isShell = request.tool === 'bash' || request.tool === 'powershell'
          const ask = (input: Parameters<typeof approvals.ask>[0]) => request.timeoutMs ? approvals.askTimed(input, request.timeoutMs, request.signal) : approvals.ask(input, request.signal)
          const choice = await ask({
            runId: id, sessionId: runners?.agentOf(id)?.getState()?.sessionId,
            ...(request.owner ? { owner: request.owner } : {}),
            ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
            kind: isDelete ? 'delete' : isPermission ? 'permission' : outsideDirs.length ? 'outside' : 'danger',
            tool: request.tool,
            title: isDelete
              ? 'Agent 想删除文件'
              : isPermission
              ? isShell ? 'Agent 想运行一条命令' : 'Agent 想修改文件'
              : outsideDirs.length ? 'Agent 想写入项目之外的位置' : 'Agent 想执行一个难以撤销的操作',
            detail: request.detail,
            reasons: request.reasons,
            cwd: request.cwd,
            ...(rememberDirs.length ? { rememberDirs } : {}),
            canRemember: rememberDirs.length > 0,
            ...(request.timeoutMs && request.onTimeout ? { onTimeout: request.onTimeout } : {})
          })
          if (choice === 'timeout') return { decision: 'timeout' }
          if (choice?.choice === 'remember') {
            if (rememberDirs.length) {
              const current = await getSettings()
              await patchSettings({ guardAllowRoots: [...(current.guardAllowRoots ?? []), ...rememberDirs] })
            }
          }
          if (!choice) return null
          const allowed = choice.choice === 'once' || choice.choice === 'remember'
          return choice.feedback ? { decision: allowed ? 'allow' : 'deny', feedback: choice.feedback } : { decision: allowed ? 'allow' : 'deny' }
        },
        recordDangerReview: (sessionId, review) => recordDangerReview(sessionId, review),
        cancelApprovals: (owner) => {
          approvals.cancelRun(id, owner)
        },
        activateApprovals: (owner) => {
          approvals.activate(id, owner)
        },
        retireApprovals: (owner) => {
          approvals.retire(id, owner)
        },
        requestSessionMove,
        confirmToolConsent: async (request: ToolConsentPrompt): Promise<ConsentAnswer | null> => {
          const { parts, verdict } = request
          const choice = await approvals.ask({
            runId: id, sessionId: runners?.agentOf(id)?.getState()?.sessionId,
            ...(request.owner ? { owner: request.owner } : {}),
            kind: 'consent',
            tool: parts.capability,
            title: `Agent 想使用「${parts.capability}」执行「${parts.action}」`,
            detail: parts.resource,
            reasons: [
              ...(request.purpose ? [`用途：${request.purpose}`] : []),
              verdict.reason
            ],
            cwd: request.cwd,
            canRemember: false,
            ...(verdict.danger ? { danger: verdict.danger } : {})
          })
          if (choice?.choice === 'once' || choice?.choice === 'remember') return { decision: 'allow' }
          if (choice?.choice !== 'deny') return null
          return choice.feedback ? { decision: 'deny', feedback: choice.feedback } : { decision: 'deny' }
        }
      })
      return agent
    },
    onChanged: () => {
      pushRunners()
      scheduleEpochSnapshots()
      requestPiPackageActivationTick()
    },
    onRefreshed: (id) => {
      push({ ch: 'log', payload: { text: `[运行实例刷新] ${id} 已空闲，按最新配置重启` } })
    },
    onRefreshFailed: (id, error) => reportMainError('刷新运行实例', new Error(`${id}：${error}`))
  })

  runners.startIdleReclaim()

  void initializeIsolationView()

  const piProbe = resolvePi(settings.piBin ? { override: settings.piBin } : {})
  const piBin = piProbe.args.at(-1)
  configurePackageContext({
    bin: () => piBin ?? null,
    agentDir: () => PI_AGENT_DIR,
    hasRunningTask: (projectCwd) => runners?.hasBusyCwd(projectCwd) === true,
    isProjectTrusted: async (projectCwd) => (await trustStatus(projectCwd)).trusted
  })
  const acquisitions = acquisitionServiceFor(YAN_DIR)
  const packageAuthorizations = new PackageAuthorizationService(YAN_DIR)
  piPackageActivationScheduler = new PiPackageActivationScheduler(
    acquisitions,
    createPiPackageActivationHostPorts({
      root: YAN_DIR,
      agentDir: PI_AGENT_DIR,
      service: acquisitions,
      authorizations: packageAuthorizations,
      runners: {
        activationSnapshot: (target) => runners?.activationSnapshot(target) ?? null,
        agentOf: (id) => runners?.agentOf(id) ?? null,
        restartOne: async (id) => {
          mcpAppViewService?.invalidateRunnerId(id)
          return (await runners?.restartOne(id)) ?? { ok: false, error: pick('运行实例注册表尚未就绪', 'Runtime registry is not ready') }
        },
        hasBusyCwd: (cwd) => runners?.hasBusyCwd(cwd) ?? false
      },
      isTrusted: async (cwd) => (await trustStatus(cwd)).trusted,
      sourceHead: async (cwd) => (await readRepoState(cwd, { withRefs: false }))?.head ?? null,
      listPackages,
      install: installManagedPiPackage,
      smoke: (tx) => smokeStagedPiPackage({
        root: YAN_DIR,
        operationId: tx.operationId,
        ...(piBin ? { piBin } : {})
      })
    })
  )

  const openTarget = await resolveSessionOpenTarget({
    ...(restore?.sessionFile ? { sessionFile: restore.sessionFile } : {}),
    fallbackCwd: settings.cwd,
    usable: (cwd) => validateCwd(cwd),
    projectIdForCwd: (cwd) => projectIdForCwd(settings, cwd)
  })
  const restoreFile = openTarget.missingCwd ? undefined : restore?.sessionFile
  const startTarget = openTarget.missingCwd
    ? { cwd: settings.cwd, ...((id) => id ? { projectId: id, scope: 'project' as const } : { scope: 'global' as const })(projectIdForCwd(settings, settings.cwd)) }
    : openTarget
  if (openTarget.missingCwd) {
    push({ ch: 'notify', payload: { id: `missing-cwd-${Date.now()}`, method: 'notify', notifyType: 'warning', message: pick(`上次会话的项目文件夹不在了：${openTarget.missingCwd}。这次没有恢复它；从侧栏打开该会话时可以重新指定文件夹。`, `The last session’s project folder is gone: ${openTarget.missingCwd}. It was not restored; choose a new folder when opening it from the sidebar.`) } })
  }
  const res = await runners.startPrimary(startTarget.cwd, restoreFile, startTarget.projectId)
  await rememberRunnerSession(res, {
    cwd: startTarget.cwd,
    projectId: startTarget.projectId,
    scope: startTarget.scope,
    ...(restoreFile ? { sessionFile: restoreFile } : {})
  })
  pushRunners()
  if (res.ok && res.id) await pushRunnerSnapshot(res.id)
  requestPiPackageActivationTick()
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

let agentRestarting = false
let agentRestartQueued: string | null = null

let hotkeyGuardPaused = false
async function restartAgent(reason: string): Promise<void> {
  if (shuttingDown) return
  if (agentRestarting) {
    agentRestartQueued = reason
    return
  }
  if (starting) await starting
  if (shuttingDown || !runners) return
  if (agentRestarting) {
    agentRestartQueued = reason
    return
  }
  agentRestarting = true
  const file = ac()?.getState()?.sessionFile
  try {
    await refreshLaunchContext()
    const registry = runners
    if (shuttingDown || !registry) return
    if (registry.size === 0) {
      await registry.stopAll()
      const res = await startAgent(file ? { sessionFile: file } : undefined)
      if (!res.ok) reportMainError('refresh-runners', new Error(res.error ?? 'pi did not start'))
      return
    }
    const outcome = await registry.refreshInstances()
    for (const failure of outcome.failed) reportMainError('refresh-runners', new Error(`${failure.id}：${failure.error}`))
    if (outcome.deferred.length > 0) {
      const count = outcome.deferred.length
      push({
        ch: 'notify',
        payload: {
          id: 'runners-refresh-deferred',
          method: 'notify',
          notifyType: 'info',
          message: pick(`配置已保存，${count} 个运行中的会话将在空闲后刷新`, `Settings saved. ${count} running session${count === 1 ? '' : 's'} will refresh once idle`)
        }
      })
    }
  } catch (error) {
    reportMainError(reason, error)
  } finally {
    agentRestarting = false
    const queued = agentRestartQueued
    agentRestartQueued = null
    if (queued) void restartAgent(queued).catch((error) => reportMainError('刷新运行实例', error))
  }
}

function registerIpc(): void {
  configureWriteContext({
    hasRunningTask: (cwd) => {
      const root = resolve(cwd)
      const runnerBusy = (runners?.statuses() ?? []).some((st) => {
        if (!isWithin(root, resolve(st.cwd))) return false
        const agent = runners?.agentOf(st.id)
        return runners?.hasExecutionAdmission(st.cwd) === true || (!!agent && executionBusy(
          agent.getState(),
          () => agent.hasRunningBash(),
          () => agent.getPendingUiCount()
        ))
      })
      return runnerBusy || (subagentService.current()?.list() ?? []).some((run) =>
        (run.status === 'running' || run.status === 'starting') && isWithin(root, resolve(run.cwd))
      )
    }
  })


  const isTrustedIpc = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  const ipc = createIpcRegistrar(isTrustedIpc)

  const syncCompactionLines = async (models: LineModel[]): Promise<void> => {
    const cap = (await getSettings()).autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
    await syncNativeCompactionLines(models, cap).catch((e) => reportMainError('压缩线', e))
  }
  registerAgentIpc(ipc, {
    runners: () => runners,
    ac,
    startAgent,
    whenAgentStarted,
    flushRestoreNotice,
    piDown,
    push,
    isObject,
    normalizeExpectedRuntime,
    resolveExpectedTarget,
    targetMatchesExpected,
    runnerForExpected,
    pinSendTarget,
    pinnedTargetMatches,
    warnSharedCwdOnce,
    stopRunner,
    applyToAllAgents,
    syncCompactionLines,
    runnerVisibility,
    approvals,
    pendingUiReplay,
    resyncActiveView
  })
  registerSessionIpc(ipc, sessionHost)
  registerNativeSessionIpc(ipc, sessionHost, {
    confirm: (agent, prompt) => agent.confirmNativeOperation(prompt),
    win: () => win,
    runtime: async (agent, request) => {
      if (request.action === 'navigate') return agent.nativeNavigate(request.entryId!, { summarize: request.summarize === true })
      if (request.action === 'set-label') return agent.nativeSetLabel(request.entryId!, request.label ?? '')
      if (request.action === 'reload') {
        await agent.nativeReload()
        await agent.listCommands()
        return { ok: true }
      }
      if (request.action === 'scoped-models') {
        const [snapshot, models] = await Promise.all([agent.nativeScopedModels(), agent.listModels()])
        return {
          ok: true, models,
          scopedModelIds: snapshot.scopedModels.map(item => item.key)
        }
      }
      if (request.action === 'trust') {
        const snapshot = await agent.nativeProjectTrust()
        return { ok: true, cwd: snapshot.cwd, trusted: snapshot.effectiveTrusted, trustEntry: snapshot.entry }
      }
      if (request.action === 'set-scoped-models' || request.action === 'set-trust') {
        if (request.action === 'set-scoped-models') {
          const models = await agent.listModels()
          const available = new Set(models.map(model => `${model.provider}/${model.id}`))
          if (request.modelIds!.some(id => !available.has(id))) return { ok: false, error: pick('所选模型已不可用，请刷新面板', 'Selected model is no longer available; refresh the panel') }
          await agent.nativeSetScopedModels(request.modelIds!)
        } else {
          await agent.nativeSetProjectTrust(request.trusted!)
        }
        const runnerId = runners?.idOf(agent)
        const sessionFile = agent.getState()?.sessionFile
        if (!runnerId || !sessionFile || !existsSync(sessionFile)) return { ok: true, requiresReload: true }
        const restarted = await runners!.restartOne(runnerId)
        if (!restarted.ok) return { ok: false, error: pick(`原生设置已保存，但应用失败：${restarted.error ?? '请重新打开会话'}`, `Native settings saved, but applying them failed: ${restarted.error ?? 'reopen the session'}`) }
        const current = runners!.agentOf(runnerId)
        await pushRunnerSnapshot(runnerId)
        if (request.action === 'set-scoped-models' && current) {
          const applied = await current.nativeScopedModels()
          const keys = new Set(applied.scopedModels.map(item => item.key))
          const wanted = new Set(request.modelIds!)
          if (keys.size !== wanted.size || [...wanted].some(key => !keys.has(key))) return { ok: false, error: pick('用户级模型范围已保存，但当前项目的 pi 设置或启动范围覆盖了它；请检查项目 enabledModels', 'User-level model scope saved, but the project’s pi settings or launch scope override it; check the project enabledModels') }
        }
        return { ok: true }
      }
      return { ok: false, error: pick('不支持的原生操作', 'Unsupported native action') }
    }
  })
  registerCheckpointIpc(
    ipc,
    sessionHost,
    (cwd) => subagentService.current()?.hasActiveWriter(cwd) === true,
    {
      activeWriterRoots: () =>
        subagentService.current()?.list()
          .filter((run) => run.isolation === 'shared-cwd' && (run.status === 'starting' || run.status === 'running'))
          .map((run) => run.cwd) ?? [],
      busyRoots: () => {
        const registry = runners
        if (!registry) return []
        const provider: { busyRoots?: () => readonly string[] } = registry
        return provider.busyRoots ? provider.busyRoots() : registry.statuses().filter((status) => status.running || status.waiting).map((status) => status.cwd)
      }
    }
  )
  setTimeout(() => void pruneCheckpoints().catch(() => undefined), 60_000).unref?.()

  registerRunsIpc(ipc, {
    snapshot: () => runsHost?.snapshot() ?? { revision: 0, runs: [] },
    markSeen: (runId) => runsHost?.markSeen(runId) ?? { ok: false },
    stopSessionRun: async ({ sessionId }) => {
      const agent = runners?.agentForSession(sessionId) ?? null
      if (!agent) return { ok: false, error: pick('找不到这次运行对应的会话实例', 'No session runtime found for this run') }
      const { error, ...cleared } = await agent.abort()
      return error ? { ok: false, error } : { ok: true, recovered: cleared }
    },
    stopSubagentRun: async (runId) => {
      const service = subagentService.current()
      if (!service) return { ok: false, error: pick('子 Agent 宿主未就绪', 'Subagent host is not ready') }
      const result = await service.stop(runId)
      return result.ok ? { ok: true } : { ok: false, ...(result.error ? { error: result.error } : {}) }
    }
  })

  registerSessionTransferIpc(ipc, {
    sessionsDir: SESSIONS_DIR,
    pickExportPath: async (suggested) => {
      if (!win) return null
      const r = await dialog.showSaveDialog(win, {
        title: pick('导出会话', 'Export session'),
        defaultPath: join(app.getPath('documents'), suggested),
        filters: [{ name: pick('砚会话包', 'Inkstone session bundle'), extensions: ['json'] }]
      })
      return r.canceled ? null : r.filePath ?? null
    },
    pickImportFile: async () => {
      if (!win) return null
      const r = await dialog.showOpenDialog(win, {
        title: pick('选择会话包', 'Choose session bundle'),
        properties: ['openFile'],
        filters: [{ name: pick('砚会话包', 'Inkstone session bundle'), extensions: ['json'] }]
      })
      return r.canceled ? null : r.filePaths[0] ?? null
    },
    currentSessionPath: () => ac()?.getState()?.sessionFile
  })

  registerAuthIpc(ipc, {
    restartAgent: (reason: string) => restartAgent(reason),
    sendOAuthEvent: (event) => {
      if (win && !win.isDestroyed()) win.webContents.send('yan:oauth', event)
    }
  })

  registerGitRuntimeIpc(ipc, {
    restartAgent: (reason: string) => restartAgent(reason),
    push: (msg) => push(msg),
    preferMirror: async () => (await getSettings()).lang === 'zh-CN'
  })

  registerFilesIpc(ipc, { resolveFileContext, isSessionBusy: () => !runners || runners.statuses().some((runner) => runner.running || runner.waiting) })

  registerSettingsIpc(ipc, {
    win: () => win,
    runners: () => runners,
    ac,
    starting: () => starting,
    push,
    isObject,
    validateCwd,
    normalizeCwdForIdentity,
    reportMainError,
    refreshPackageProjectRoots,
    syncNativeThemeSource,
    setTrayLanguage: (lang) => { trayLanguage = lang },
    refreshTrayMenu,
    setResponseDetail: (detail) => { agentResponseDetail = detail },
    syncCompactionLines,
    syncKeepAwake,
    requestExit
  })

  registerShellIpc(ipc, {
    isTrustedIpc,
    win: () => win,
    runners: () => runners,
    ac,
    browser: () => browser,
    mcpAppViewService: () => mcpAppViewService,
    attention: () => attention,
    isQuitting: () => isQuitting,
    setHotkeyGuardPaused: (paused) => { hotkeyGuardPaused = paused },
    setTrayMotionAllowed: (allowed) => { trayMotionAllowed = allowed },
    refreshTaskbar,
    push,
    attentionNotices,
    botNotificationIcon,
    sessionNoticeLink,
    pushRunnerSnapshot,
    pushRunners,
    reclaimQueuedMessages,
    requestExit,
    pushWinState,
    setUiScale
  })

  registerWorkspaceDataIpc(ipc, () => win)

  registerWorkspaceIpc(ipc)



  registerWorkflowsIpc(ipc, workflowService)

  registerSubagentsIpc(ipc, {
    service: subagentService,
    latestMessageId: (parentRunId) => runners?.agentOf(parentRunId)?.latestAssistantMessageId(),
    parentContext: async (owner) => {
      const captured = captureDefaultParent()
      const settings = await getSettings()
      return resolveSubagentParentContext(owner, captured, settings)
    }
  })

  registerGitIpc(ipc, {
    authorizeReadCwd: async (cwd: string) => {
      const st = await getSettings()
      const resolved = await resolveFileContext(st, st.cwd, { cwd })
      return resolved.ok
        ? { ok: true as const, cwd: resolved.context.cwd }
        : { ok: false as const, error: resolved.error }
    }
  })

  registerGithubIpc(ipc, {
    pushCloneProgress: (payload) => push({ ch: 'github-clone', payload }),
    authorizeReadCwd: async (cwd: string) => {
      const st = await getSettings()
      const resolved = await resolveFileContext(st, st.cwd, { cwd })
      return resolved.ok
        ? { ok: true as const, cwd: resolved.context.cwd }
        : { ok: false as const, error: resolved.error }
    }
  })

  registerPackagesIpc(ipc, { hasBusyCwd: (cwd: string) => runners?.hasBusyCwd(cwd) === true, isKnownProject: isKnownPackageProject })
  refreshMinecraftPluginOnStartup()
  ipc.handle('yan:plugins:action', async (id: unknown, action: unknown) => {
    if (typeof id !== 'string' || !['status', 'install', 'remove'].includes(String(action))) return { ok: false, error: pick('无效插件操作', 'Invalid plugin action') }
    launchResourceCache = null
    return bundledPlugins.action(id, String(action)).finally(() => { launchResourceCache = null })
  })
  ipc.handle('yan:plugins:invoke', async (id: unknown, action: unknown, params: unknown) => {
    if (typeof id !== 'string' || typeof action !== 'string') throw new Error(pick('无效插件请求', 'Invalid plugin request'))
    return bundledPlugins.invoke(id, action, params)
  })
  registerCanvasCaptureIpc(ipc)
  registerHtmlEditIpc(ipc, { resolveFileContext })
  registerVideoExportIpc(ipc, { resolveFileContext })
  registerSourcesIpc(ipc)
  registerSearchOpsIpc(ipc, { opsDir: join(YAN_DIR, 'ops') })

  registerCapabilitiesIpc(ipc, {
    currentAgent: () => ac() ?? undefined,
    registry: () => runners,
    thinExtensionPaths: yanThinExtensionPaths,
    settings: () => getSettings(),
    isProjectTrusted: async (cwd) => (await trustStatus(cwd)).trusted
  })

  registerMcpAppViewIpc(ipc, { service: () => mcpAppViewService })

  configureMcpAppHostOwnership(
    createMcpAppRuntimeOwnershipFacts({
      registry: () => runners,
      agentDir: PI_AGENT_DIR,
      projects: async () => (await getSettings()).projects.map((project) => ({ id: project.id, cwd: project.cwd }))
    })
  )



  const previewSites = createPreviewSiteGate({
    confirm: (origin, url) => askBrowserSiteApproval(origin, url),
    store: {
      load: async () => (await getSettings()).browserAllowedSites ?? [],
      save: (list) => void patchSettings({ browserAllowedSites: list }).catch(() => undefined)
    }
  })
  void previewSites.ready()
  const localServerControl = installLocalServerControl(() => [
    ...(runners?.agents() ?? []).map((agent) => agent.processId()),
    ...agentTerminalIds().map(terminalProcessId)
  ].filter((pid): pid is number => typeof pid === 'number'))
  registerBrowserIpc(ipc, () => browser, previewSites, answerBrowserSiteApproval, localServerControl)

  registerOfficeIpc(ipc, async (requestedCwd) => {
    const settings = await getSettings()
    const resolved = await resolveFileContext(settings, settings.cwd, { cwd: requestedCwd ?? settings.cwd })
    if (!resolved.ok) throw new Error(resolved.error)
    return resolved.context.cwd
  })

  updateControl = registerAppUpdate(ipc, () => quitReasons(quitActivity()).length > 0)
  registerVoiceIpc(ipc, {
    plugins: bundledPlugins,
    window: () => win,
    settings: async () => (await getSettings()).voiceInput,
    saveSettings: async (voiceInput) => {
      await patchSettings({ voiceInput })
    }
  })
  registerAndroidIpc(ipc, () => win)

  registerRemoteIpc(ipc, {
    access: () => remoteAccess,
    ensureStarted: startRemoteServer,
    saveSettings: (remote) => patchSettings({ remoteAccess: remote })
  })

  registerTerminalIpc(ipc, () => ac()?.getState()?.cwd)
}

function pushWinState(): void {
  if (!win) return
  push({
    ch: 'win-state',
    payload: { maximized: win.isMaximized(), alwaysOnTop: win.isAlwaysOnTop() }
  })
}

async function setUiScale(v: unknown): Promise<ReturnType<typeof zoomState>> {
  const next = clampScale(v)
  const st = applyZoom(win, next)
  push({ ch: 'ui-scale', payload: st })
  await patchSettings({ uiScale: next })
  return st
}

const WIN11_MATERIAL_MIN_BUILD = 22621

let windowMaterialActive = false

function windowsBuildNumber(): number {
  const build = Number(osRelease().split('.')[2])
  return Number.isFinite(build) ? build : 0
}

function resolveWindowMaterial(): 'acrylic' | 'mica' | 'none' {
  if (process.platform !== 'win32') return 'none'
  const forced = process.env.YAN_WINDOW_MATERIAL
  if (forced === 'acrylic' || forced === 'mica' || forced === 'none') return forced
  return windowsBuildNumber() >= WIN11_MATERIAL_MIN_BUILD ? 'acrylic' : 'none'
}

const WINDOW_BACKGROUND = { dark: '#171717', light: '#fcfcfa' } as const

function syncNativeThemeSource(theme: 'light' | 'dark'): void {
  if (windowMaterialActive) nativeTheme.themeSource = theme
  else if (win && !win.isDestroyed()) win.setBackgroundColor(WINDOW_BACKGROUND[theme])
}

function createWindow(): void {
  const [winW, winH] = (process.env.YAN_WIN ?? '')
    .split("x")
    .map((x) => Number(x))
  const useW = Number.isFinite(winW) && winW > 0 ? winW : 1440
  const useH = Number.isFinite(winH) && winH > 0 ? winH : 900
  const material = resolveWindowMaterial()
  windowMaterialActive = material !== 'none'

  win = new BrowserWindow({
    icon: shellIconPath(),
    width: useW,
    height: useH,
    minWidth: 600,
    minHeight: 600,
    show: false,
    frame: false,
    roundedCorners: true,
    backgroundColor: WINDOW_BACKGROUND.dark,
    webPreferences: {
      preload: join(__dirname_, '../preload/index.cjs'),
      additionalArguments: [
        ...(process.env.YAN_PROBE && !app.isPackaged ? ['--yan-isolated-probe'] : []),
        ...(windowMaterialActive ? [`--yan-window-material=${material}`] : [])
      ],
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })
  if (windowMaterialActive) win.setBackgroundMaterial(material)
  guardHtmlArtifactFrames(win.webContents)
  win.webContents.once('did-finish-load', () => {
    const notice = pendingPinnedGuardNotice
    if (!notice) return
    pendingPinnedGuardNotice = null
    push({
      ch: 'notify',
      payload: { id: 'pinned-network-guard', method: 'notify', notifyType: 'error', message: notice.message }
    })
  })

  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: app.isPackaged ? process.execPath : join(app.getAppPath(), 'build', 'icon.ico'),
      appIconIndex: 0
    })
  }

  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win?.hide()
  })

  void getSettings().then((s) => {
    if (!win) return
    syncNativeThemeSource(s.theme)
    if (s.alwaysOnTop) {
      win.setAlwaysOnTop(true)
      pushWinState()
    }
    applyZoom(win, s.uiScale)
  })

  win.webContents.on('dom-ready', () => {
    void getSettings().then((s) => {
      if (win && !win.isDestroyed()) applyZoom(win, s.uiScale)
    })
  })

  const reapply = (): void => {
    void getSettings().then((s) => {
      if (win && !win.isDestroyed()) applyZoom(win, s.uiScale)
    })
  }
  win.on('moved', reapply)
  screen.on('display-metrics-changed', reapply)
  screen.on('display-added', reapply)
  screen.on('display-removed', reapply)
  win.once('closed', () => {
    screen.removeListener('display-metrics-changed', reapply)
    screen.removeListener('display-added', reapply)
    screen.removeListener('display-removed', reapply)
  })

  win.once('ready-to-show', () => {
    if (process.env.YAN_PROBE) {
      if (process.env.YAN_PROBE_HIDDEN) win?.setSkipTaskbar(true)
      else win?.showInactive()
    } else {
      win?.show()
    }
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      void reportExtensionSources().catch(error => console.error('[来源] 扩展诊断失败', error))
      void getSettings().then((s) => {
        if (win && !win.isDestroyed()) applyZoom(win, s.uiScale)
      })
    }, 1200)

    if (win) armProbeShots(win)
  })

  win.on('maximize', () => pushWinState())
  win.on('unmaximize', () => pushWinState())
  win.on('enter-full-screen', () => pushWinState())
  win.on('leave-full-screen', () => pushWinState())
  win.on('always-on-top-changed', () => pushWinState())

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const ctrl = input.control || input.meta
    const key = String(input.key ?? '').toLowerCase()

    if (!hotkeyGuardPaused && ctrl && input.shift && !input.alt && key === 'p') {
      event.preventDefault()
      win?.webContents.send('yan:hotkey', { action: 'cycleModelBack' })
      return
    }

    if (!hotkeyGuardPaused && ctrl && !input.shift && !input.alt && key === 'p') {
      event.preventDefault()
      win?.webContents.send('yan:hotkey', { action: 'cycleModel' })
      return
    }

    if (!hotkeyGuardPaused && input.shift && !ctrl && !input.alt && input.key === 'Tab') {
      event.preventDefault()
      win?.webContents.send('yan:hotkey', { action: 'cycleThinking' })
      return
    }

    if (ctrl && !input.alt && (key === '=' || key === '+' || key === '-' || key === '_' || key === '0')) {
      event.preventDefault()
      const cur = peekUiScale()
      const next = key === '0' ? 0 : stepScale(win, cur, key === '-' || key === '_' ? -1 : 1)
      void setUiScale(next)
    }
  })

  win.webContents.on('context-menu', (_e, params) => {
    const editable = params.isEditable
    const hasSel = params.selectionText.trim().length > 0
    if (!editable && !hasSel) return
    void getSettings().then((s) => {
      const zh = String(s.lang ?? 'zh-CN').toLowerCase().startsWith('zh')
      const L = zh
        ? { cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选' }
        : { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all' }
      const items: Electron.MenuItemConstructorOptions[] = []
      if (editable && hasSel) items.push({ role: 'cut', label: L.cut })
      if (hasSel) items.push({ role: 'copy', label: L.copy })
      if (editable) {
        if (items.length) items.push({ type: 'separator' })
        items.push({ role: 'paste', label: L.paste })
        items.push({ type: 'separator' })
        items.push({ role: 'selectAll', label: L.selectAll })
      }
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win ?? undefined })
    })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = openableExternalUrl(url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev ? new URL(url).origin === new URL(dev).origin : url.startsWith('file://')) return
    event.preventDefault()
    const external = openableExternalUrl(url)
    if (external) void shell.openExternal(external)
  })

  win.webContents.on('console-message', (...args: unknown[]) => {
    const detail = args.find((x) => x && typeof x === 'object' && 'message' in x) as { level?: string; message?: string; sourceId?: string; lineNumber?: number } | undefined
    if (detail?.level === 'error') console.error('[renderer console]', detail.message, detail.sourceId, detail.lineNumber)
    else if (typeof args[2] === 'string' && Number(args[1]) >= 2) console.error('[renderer console]', args[2], args[4], args[3])
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    runnerVisibility.reset()
    mcpAppViewService?.close()
    trayMotionAllowed = false
    refreshTaskbar()
    reportMainError('render-process-gone', new Error(`${details.reason} code=${details.exitCode}`))
    const crashed = win
    if (isQuitting || shuttingDown || !crashed || !rendererMayReload(details.reason)) return
    setTimeout(() => {
      if (win !== crashed || crashed.isDestroyed() || isQuitting || shuttingDown) return
      crashed.webContents.reload()
    }, 1000)
  })
  win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    runnerVisibility.reset()
    mcpAppViewService?.close()
    trayMotionAllowed = false
    refreshTaskbar()
  })
  win.on('closed', () => {
    runnerVisibility.reset()
    mcpAppViewService?.close()
    trayMotionAllowed = false
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname_, '../renderer/index.html'))
  }

  armProbeRun(win, shutdown)
}

const sessionHost: SessionHost = {
  runners: () => runners,
  ac,
  sessionChains,
  push,
  pushRunners,
  pushRunnerSnapshot,
  validateCwd,
  relocateMissingCwd,
  startAgent,
  rememberRunnerSession,
  openSessionWorktree,
  sessionWorktrees,
  readHistoryWithArtifacts,
  projectIdForCwd
}

configureRemoteHost({
  ...sessionHost,
  approvals,
  win: () => win,
  remoteAccess: () => remoteAccess
})

function rendererPageOrigin(): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!dev) return 'file://'
  try {
    return new URL(dev).origin
  } catch {
    return 'file://'
  }
}

function installDefaultSessionPermissions(): void {
  installSessionPermissionBoundary(session.defaultSession, {
    allow: ['clipboard-sanitized-write', 'media'],
    trust: trustedFrameTrust({
      isTrustedContents: (id) => !!win && !win.isDestroyed() && id === win.webContents.id,
      origins: [rendererPageOrigin()]
    })
  })
}

let packageProjectRoots: string[] = []

function refreshPackageProjectRoots(settings: Awaited<ReturnType<typeof getSettings>>): void {
  packageProjectRoots = [settings.cwd, ...settings.projects.map((project) => project.cwd)].filter(
    (path): path is string => typeof path === 'string' && path.length > 0
  )
}

function isKnownPackageProject(cwd: string): boolean {
  const wanted = normalizeCwdForIdentity(cwd)
  if (!wanted) return false
  if (packageProjectRoots.some((root) => normalizeCwdForIdentity(root) === wanted)) return true
  return (runners?.statuses() ?? []).some((status) => normalizeCwdForIdentity(status.cwd) === wanted)
}

app.whenReady().then(async () => {
  await storageMoveReady
  try { releaseDesktopDataRoot = await lockDataRoot(YAN_DIR) } catch (error) { exitReason = 'data-root-lock'; reportMainError('data-root-writer', error); dialog.showErrorBox(pick('砚无法启动', 'Inkstone failed to start'), error instanceof Error ? error.message : String(error)); app.exit(1); return }
  refreshPackageProjectRoots(await getSettings())
  registerDeepLinkProtocol(app, { isPackaged: app.isPackaged, execPath: process.execPath, appPath: process.argv[1] })
  registerHtmlArtifactProtocol()
  try {
    const guard = await attachPinnedNetworkGuard(session.defaultSession)
    const notice = pinnedGuardNotice(guard)
    if (notice) {
      pendingPinnedGuardNotice = notice
      reportMainError('pinned-network-guard', new Error(notice.message))
    }
  } catch (error) {
    pendingPinnedGuardNotice = { message: error instanceof Error ? error.message : String(error) }
    reportMainError('pinned-network-guard', error)
  }
  void loadModelPricing()
  watchPowerSource()
  browser = new BrowserController(() => win, push, askProfileSyncApproval, askLargeDownloadApproval)
  setUserHandoffRelease((sessionId) => browser?.releaseUserControlFor(sessionId))
  setSessionBrowserCloser((sessionId) => browser?.closeSession(sessionId, { keepExternal: true }) ?? Promise.resolve())
  onTerminalJobs((jobs) => push({ ch: 'terminal-jobs', payload: jobs }))
  setTerminalSink((event) => {
    if (event.kind === 'exit') {
      blockedTerminalNotices.delete(event.id)
    }
    if (event.kind === 'status') {
      notifyBlockedTerminal(event.id, event.status)
      refreshTaskbar()
    }
    push({
      ch: 'terminal',
      payload:
        event.kind === 'data'
          ? { id: event.id, kind: 'data', data: event.data, seq: event.seq }
          : event.kind === 'exit'
            ? { id: event.id, kind: 'exit', exitCode: event.exitCode }
            : event.kind === 'agent'
              ? { id: event.id, kind: 'agent', ...(event.owner ? { owner: event.owner } : {}), agentPhase: event.phase, agentAction: event.action }
              : { id: event.id, kind: 'status', status: event.status }
    })
  })
  registerIpc()
  installDefaultSessionPermissions()
  void primeCachedTitles().catch(() => undefined)
  void bundledPlugins.startInstalled().catch((error) => reportMainError('plugins-startup', error))
  void fillNativeMcpDescriptions(join(PI_AGENT_DIR, 'mcp.json')).catch((error) => reportMainError('mcp-describe', error))
  trayLanguage = (await getSettings()).lang
  ensureTrayAssets()
  attention?.ensureTray()
  createWindow()

  auxWindows = createAuxWindows({
    preloadPath: () => join(__dirname_, '../preload/index.cjs'),
    loadEntry: (target) => {
      const page = 'quick-ask'
      if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}/auxwin/${page}.html`)
      else void target.loadFile(join(__dirname_, `../renderer/auxwin/${page}.html`))
    },
    locale: () => (trayLanguage === 'en-US' ? 'en-US' : 'zh-CN'),
    anchorBounds: () => (win && !win.isDestroyed() ? win.getBounds() : undefined),
    workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    zoomFactor: () => zoomState(win, peekUiScale()).effective,
    listProjects: async () =>
      (await getSettings()).projects.map((project) => ({ id: project.id, name: project.name, path: project.cwd })),
    listModels: async () =>
      ((await ac()?.listModels()) ?? []).map((model) => ({
        key: `${model.provider}::${model.id}`,
        id: model.id,
        label: model.name,
        provider: model.provider
      })),
    currentSession: async () => {
      const status = runners?.statuses().find((item) => item.isActive)
      if (!status) return null
      return {
        ...(status.sessionId ? { sessionId: status.sessionId } : {}),
        ...(status.sessionFile ? { sessionPath: status.sessionFile } : {}),
        ...(status.projectId ? { projectId: status.projectId } : {}),
        cwd: status.cwd
      }
    },
    submitQuickAsk: (payload) =>
      submitQuickAsk(
        {
          activeRunId: () => runners?.activeRunnerId ?? null,
          agentOf: (runId) => runners?.agentOf(runId) ?? null,
          start: () => sessionHost.startAgent(),
          createSession: async ({ projectId }) => {
            const target = quickAskSessionTarget(await getSettings(), projectId)
            if (!target.ok) return { ok: false, error: target.error }
            const project = target.projectId
            const cwdResult = await sessionHost.validateCwd(target.cwd)
            if (!cwdResult.ok) return { ok: false, error: cwdResult.error }
            if (!runners) {
              const started = await sessionHost.startAgent()
              if (!started.ok) return { ok: false, error: started.error }
            }
            const registry = runners
            if (!registry) return { ok: false, error: piDown() }
            const scope = project ? 'project' : 'global'
            const res = await registry.select({ cwd: cwdResult.cwd, projectId: project, scope })
            await sessionHost.rememberRunnerSession(res, {
              cwd: cwdResult.cwd,
              ...(project ? { projectId: project } : {}),
              scope
            })
            if (res.ok && res.id) void sessionHost.pushRunnerSnapshot(res.id)
            sessionHost.pushRunners()
            return res.ok && res.id ? { ok: true, id: res.id } : { ok: false, error: res.error }
          },
          applyModel: async (runId, model) =>
            (await runners?.agentOf(runId)?.setModel(model.provider, model.id)) ?? { ok: false, error: piDown() },
          abandonSession: async (runId, previous) => {
            const registry = runners
            const agent = registry?.agentOf(runId) ?? null
            let restored = false
            if (agent && previous.sessionFile) restored = (await agent.switchSession(previous.sessionFile)).ok
            if (!restored) await registry?.stopOne(runId)
            pushRunners()
          }
        },
        payload
      ),
    openSession: (target) => {
      const status = runners?.statuses().find(
        (item) =>
          (target.sessionId && item.sessionId === target.sessionId) ||
          (target.sessionPath && item.sessionFile === target.sessionPath)
      )
      push({
        ch: 'tray-select-session',
        payload: {
          ...(target.sessionPath ? { sessionFile: target.sessionPath } : {}),
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          ...(target.projectId ? { projectId: target.projectId } : {}),
          cwd: status?.cwd ?? target.cwd ?? ''
        }
      })
    },
    showMainWindow,
    shortcut: () => 'Alt+Shift+Space'
  })
  registerAuxIpc(auxWindows)
  auxWindows.registerShortcut()

  const deliverStartupDeepLinks = (): void => {
    deepLinkRouter.flush()
    deepLinkRouter.handleArgv(process.argv)
  }
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) deliverStartupDeepLinks()
  else win?.webContents.once('did-finish-load', deliverStartupDeepLinks)

  try {
    runsHost = await createRunsHost({ push })
  } catch (error) {
    runsHost = null
    reportMainError('runs-host', error)
    push({
      ch: 'log',
      payload: {
        text: `[runs] 运行注册表初始化失败，运行状态不可用：${error instanceof Error ? error.message : String(error)}`,
        level: 'error'
      }
    })
  }

  const mcpAppViewRuntime = createMcpAppViewRuntime({
    current: () => appViewForegroundFacts(),
    currentProject: (): string | null => appViewForegroundFacts()?.projectId ?? null,
    isActive: (owner: McpAppOwner): boolean => {
      const facts = appViewForegroundFacts()
      if (!facts) return false
      return (
        owner.runnerId === facts.runnerId &&
        owner.sessionId === facts.sessionId &&
        owner.sessionFile === facts.sessionFile &&
        owner.projectId === facts.projectId &&
        owner.generation === facts.generation
      )
    }
  })

  try {
    mcpAppViewService = new McpAppViewService({
      proxy: mcpAppProxyService(),
      host: mcpAppHost(),
      runtime: mcpAppViewRuntime.runtime,
      ownerGuard: mcpAppViewRuntime.ownerGuard,
      ask: (request) => {
        const agent = request.runId ? runners?.agentOf(request.runId) : undefined
        const owner = agent?.approvalOwner()
        const sessionId = request.sessionId ?? agent?.getState()?.sessionId
        return approvals.ask({ ...request, ...(owner ? { owner } : {}), ...(sessionId ? { sessionId } : {}) })
      },
      audit: new McpAppViewAuditStore(),
      serverConfigOf: (serverId) => loadMcpServersCached().servers.find((server) => server.id === serverId) ?? null,
      permissionMode: async () => (await getSettings()).permissionMode ?? 'danger',
      theme: async () => (await getSettings()).theme,
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
      grantsOf: () => [],
      hostRequests: createMcpAppHostRequests(async (text, facts, signal) => {
        const agent = runners?.agentOf(facts.runnerId)
        if (!agent || signal.aborted || agent.getState()?.sessionId !== facts.sessionId) throw new Error('App 所属会话已失效')
        const result = await agent.send(text, undefined, undefined, undefined, facts.generation)
        if (!result.ok) throw new Error(result.error ?? '消息发送失败')
      }),
      fetchResource: createMcpAppResourceLoader(mcpAppHost())
    })
    registerMcpAppProtocol(mcpAppViewService.resourceStore())
  } catch (error) {
    mcpAppViewService = null
    reportMainError('mcp-app-view', error)
  }

  const [, restore] = await Promise.all([
    migrateLegacyPlaybooks().catch((error) => console.error('[yan] 办事模板导出失败：', error)),
    restorePreviousSession()
  ])
  primaryRestoring = true
  primaryRestoreFile = restore?.sessionFile ?? null
  try {
    await Promise.all([
      startAgent(restore ? { sessionFile: restore.sessionFile } : undefined),
      startRemoteServer()
    ])
  } finally {
    primaryRestoring = false
    primaryRestoreFile = null
  }

  const initialControl = decodeControlCommand(process.argv)
  if (initialControl) void dispatchControlCommand(initialControl)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (!ac()?.running) void startAgent()
  })
}).catch((error) => {
  reportMainError('whenReady', error)
  exitReason = 'whenReady'
  dialog.showErrorBox(pick('砚无法启动', 'Inkstone failed to start'), error instanceof Error ? error.message : String(error))
  app.exit(1)
})

app.on('window-all-closed', () => {
  void shutdown().then(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})

app.on('before-quit', (e) => {
  if (!shuttingDown && needsQuitConfirm({ quitting: isQuitting, reasons: quitReasons(quitActivity()), hasWindow: !!win && !win.isDestroyed() })) {
    e.preventDefault()
    void requestExit({ source: 'before-quit' })
    return
  }
  isQuitting = true
  exitReason = exitReason ?? 'app-quit'
  if (shutdownFinished) return
  e.preventDefault()
  if (shuttingDown) return
  void shutdown().then(() => app.quit())
})

app.on('child-process-gone', (_event, details) => {
  reportMainError(`child-process-gone:${details.type}`, new Error(`${details.reason} code=${details.exitCode}`))
})
