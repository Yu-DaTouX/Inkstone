import { isAgentContextExtension, nativePiToolsSupported } from '../shared/agent-context'
import './storage-move-boot'
import { app, shell, BrowserWindow, ipcMain, dialog, screen, Menu, Notification, Tray, nativeImage, nativeTheme } from 'electron'
import { join, dirname, basename, extname, isAbsolute, resolve } from 'node:path'
import { constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { access, appendFile, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadModelPricing } from './model-pricing'
import { mcpAppProxyToolsEnv, mcpAppProxyService } from './mcp/app-proxy-service'
import { AgentController, type CapabilityAuthorizationChoice, type CapabilityAuthorizationPrompt, type ExternalApiConfirmationRequest, type ToolConsentPrompt } from './agent'
import { applyRememberedModel } from './model-default'
import { applyTurnTimings, readTurnTimings, timingKey } from './turn-timing-store'
import { RunnerRegistry } from './runners'
import { createRunsHost, type RunsHost } from './runs-host'
import { createAttentionService, createTrayAssetStore, summarizeAttention, type AttentionMenuNode, type AttentionService, type AttentionWindowPort, type TrayAnimationState, type TrayFrameSet, type TraySelectTarget, type TrayTheme } from './attention'
import { createAuxWindows, createPaneBrowserTransfer, createPanePopoutController, createPaneTerminalTransfer, registerAuxIpc, registerPaneBrowserIpc, registerPanePopoutIpc, registerPaneTerminalIpc, submitQuickAsk, type AuxWindows, type PaneBrowserTransfer, type PanePopoutController, type PaneTerminalTransfer } from './windows'
import { registerDeepLinkProtocol, windowDeepLinkRouter } from './deeplink'
import { RunnerVisibility } from './runner-reclaim'
import { getSettings, patchSettings, updateSettings, validateRendererSettingsPatch } from './settings'
import { syncNativeCompactionLines, type LineModel } from './native-compaction-line'
import { DEFAULT_AUTO_COMPACT_TOKENS } from '../shared/context-limits'
import { registerWorkspaceDataIpc } from './ipc/workspace-data-ipc'
import { cancelStorageMove, scheduleStorageMove, storageInfo, storageSize } from './storage-move'
import { moveSessionLayout, rememberSession } from './session-layout'
import { disposeKeepAwake, updateKeepAwake, watchPowerSource } from './keep-awake'
import { rewriteSessionCwd, movedSessionContinuationPrompt, type SessionMoveAnswer, type SessionMovePrompt } from './session-move'
import { readChainMessages } from './session-history'
import { ArtifactStore } from './artifacts'
import { registerHtmlArtifactProtocol, guardHtmlArtifactFrames } from './html-artifact-preview'
import './mcp/app-protocol'
import { readRepoState } from './git-service'
import { configureWriteContext } from './git-actions'
import { configurePackageContext, installManagedPiPackage, listPackages } from './packages'
import { AcquisitionService } from './capabilities/acquisition-service'
import { PackageAuthorizationService } from './capabilities/package-authorization-service'
import { createPiPackageActivationHostPorts } from './capabilities/pi-package-activation-host'
import { PiPackageActivationScheduler } from './capabilities/pi-package-scheduler'
import { smokeStagedPiPackage } from './capabilities/pi-package-smoke'
import { allowTrust, trustStatus } from './project-trust'
import { resolvePi, piInfo, resetPiVersionCache } from './protocol'
import { applyZoom, clampScale, peekUiScale, stepScale, zoomState } from './zoom'
import { BrowserController } from './browser'
import { openableExternalUrl } from './external-url'
import { disposeTerminals, hasBlockedTerminal, hasWorkingTerminal, readTerminal, resizeTerminal, setTerminalSink, writeTerminal } from './terminal'
import { createIpcRegistrar } from './ipc/registrar'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerRemoteIpc } from './ipc/remote-ipc'
import { registerOfficeIpc } from './ipc/office-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerSourcesIpc } from './ipc/sources-ipc'
import { registerKnowledgeIpc } from './ipc/knowledge-ipc'
import { registerCapabilitiesIpc } from './ipc/capabilities-ipc'
import { registerMcpAppIpc } from './ipc/mcp-app-ipc'
import { registerMcpAppViewIpc } from './ipc/mcp-app-view-ipc'
import { McpAppViewService, createMcpAppViewRuntime, type McpAppViewRunnerFacts } from './mcp/app-view-service'
import { McpAppViewAuditStore } from './mcp/app-view-audit'
import { createMcpAppResourceLoader, registerMcpAppProtocol } from './mcp/app-protocol'
import { mcpAppHost, closeMcpAppHost, configureMcpAppHostOwnership } from './mcp/app-host'
import { loadMcpServers } from './mcp/config'
import type { McpAppOwner } from '../shared/mcp-app-preview'
import { createMcpAppRuntimeOwnershipFacts } from './mcp/app-runtime-ownership'
import { registerPackagesIpc } from './ipc/packages-ipc'
import { registerSubagentsIpc, type SubagentParentContext } from './ipc/subagents-ipc'
import { registerScheduleIpc } from './ipc/schedule-ipc'
import { ScheduleService } from './schedule-service'
import { SyncService } from './sync'
import { SESSIONS_DIR } from './sessions'
import { registerSessionIpc } from './ipc/session-ipc'
import { registerNativeSessionIpc } from './ipc/native-session-ipc'
import { registerRunsIpc } from './ipc/runs-ipc'
import { registerReviewIpc } from './ipc/review-ipc'
import { ReviewAgentCoordinator, ReviewAnnotationStore, ReviewGitAdapter, ReviewService, createReviewRunProducer, reviewRunModel, type ReviewRunProducer } from './review'
import { registerSyncIpc } from './ipc/sync-ipc'
import { registerCheckpointIpc } from './ipc/checkpoint-ipc'
import { captureCheckpoint, pruneCheckpoints } from './checkpoints'
import type { SessionHost } from './session-host'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerWorkspaceIpc } from './ipc/workspace-ipc'
import { registerWorkModeIpc } from './ipc/work-mode-ipc'
import { registerQuestionFrequencyIpc } from './ipc/question-frequency-ipc'
import { registerFilesIpc } from './ipc/files-ipc'
import { isAuthorizedFileCwd, isRunnerProjectCwd } from './file-context'
import { canOpenDocument } from '../shared/document-open'
import { normalizeQuestionFrequency } from '../shared/question-frequency'
import { lockDataRoot } from '../core/data-root-lock'
import { sameRuntimeEnvelope } from '../core/run-state'
import { registerPeerHostIpc } from './ipc/peer-host-ipc'
import { registerConsentIpc } from './ipc/consent-ipc'
import { SubagentService } from './subagent-service'
import { createSubagentNotifier } from './subagent-notify'
import { configureWorkModeCoordinator, setDefaultWorkMode, workModeKeyFor, resolveWorkMode, pushWorkMode, resolveAgentProfile, pushAgentProfile } from './work-mode-coordinator'
import { configureRemoteHost, remoteSnapshot, remoteHistory, remoteModels, executeRemoteCommand, remoteQuestions, remoteAnswer, remoteHumanApproval, remoteArtifact, remoteMessageImage, peerClient, peerGrants, peerHostHandlers } from './remote-host'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerAppUpdate } from './app-update'
import { VoiceService } from './voice/voice-service'
import { registerPeerIpc } from './ipc/peer-ipc'
import type { ConsentDecision } from '../shared/tool-consent'
import { RemoteAccess } from './remote-access'
import { SessionChainStore } from './session-chain-service'
import { WorktreeLinkStore } from './worktree-links'
import { AutoIsolationStore, isolateCwdForConflict, isolationCwdKey, syncIsolationBack } from './session-isolation'
import { localCommandDescriptors } from './command-registry'
import { writeExitSnapshot } from './exit-snapshot'
import { installStdioGuard } from './stdio-guard'
import { decodeControlCommand, writeControlResponse, type ControlCommand, type ControlResponse } from './control-protocol'
import { DOWNLOADS_DIR, ELECTRON_CRASH_DUMPS_DIR, ELECTRON_USER_DATA_DIR, PI_AGENT_DIR, YAN_DIR } from './paths'
import { migrateLegacyPlaybooks, userSkillPaths } from './user-skills'
import { extensionDiagnostics } from './extensions-inventory'
import { projectIdForCwd as deriveProjectId } from './project-id'
import { WorkModeStore } from './work-mode-service'
import { ApprovalBroker } from './approval-broker'
import { refreshManagedGit } from './git-runtime'
import { registerGitRuntimeIpc } from './ipc/git-runtime-ipc'
import type { Attachment, AttentionNotify, FileRequestContext, MainPush, QueueSnapshot, QueueState, RunnerStatus, RuntimeEnvelope, SessionState, TerminalProgramStatus } from '../shared/ipc'
import { toPaneTerminalSnapshot } from '../shared/pane-terminal'

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

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
}

process.on('uncaughtException', (error) => reportMainError('uncaughtException', error))
process.on('unhandledRejection', (reason) => reportMainError('unhandledRejection', reason))

if (ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', ELECTRON_USER_DATA_DIR)
}
if (ELECTRON_CRASH_DUMPS_DIR) {
  app.setPath('crashDumps', ELECTRON_CRASH_DUMPS_DIR)
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

const APP_ID = 'com.yudatoux.yan'


try {
  app.setAppUserModelId(APP_ID)
} catch {
}

let win: BrowserWindow | null = null
let trayLanguage: string | undefined
let trayAssets: ReturnType<typeof createTrayAssetStore> | null = null
let trayMotionAllowed = false
let attention: AttentionService | null = null
let auxWindows: AuxWindows | null = null
let panePopout: PanePopoutController | null = null
let paneTerminal: PaneTerminalTransfer | null = null
let paneBrowserTransfer: PaneBrowserTransfer | null = null
let isQuitting = false
let exitRequestInFlight: Promise<{
  action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting'
}> | null = null
let runners: RunnerRegistry | null = null

interface PinnedSendTarget {
  runId: string
  generation: number
  sessionId?: string
  agent: AgentController
}

function pinSendTarget(id: string): PinnedSendTarget | null {
  const agent = runners?.agentOf(id)
  const runtime = runners?.runtimeOf(id)
  if (!agent || !runtime) return null
  return { runId: runtime.runId, generation: runtime.generation, sessionId: runtime.sessionId, agent }
}

function pinnedTargetMatches(pin: PinnedSendTarget): boolean {
  if (runners?.agentOf(pin.runId) !== pin.agent) return false
  return sameRuntimeEnvelope(runners?.runtimeOf(pin.runId), pin)
}

let runsHost: RunsHost | null = null
let reviewRuns: ReviewRunProducer | null = null
let mcpAppViewService: McpAppViewService | null = null
let appViewForeground: { runnerId: string; sessionId: string; sessionFile: string; generation: number } | null = null
let syncController: ReturnType<typeof registerSyncIpc> | null = null
const runnerVisibility = new RunnerVisibility()
let piPackageActivationScheduler: PiPackageActivationScheduler | null = null
let piPackageActivationTimer: ReturnType<typeof setTimeout> | null = null
let piPackageActivationRetryTimer: ReturnType<typeof setTimeout> | null = null
let piPackageActivationInFlight = false
let piPackageActivationAgain = false
const piPackageActivationDeferred = new Map<string, string>()

function schedulePiPackageActivationRetry(): void {
  if (piPackageActivationRetryTimer) return
  piPackageActivationRetryTimer = setTimeout(() => {
    piPackageActivationRetryTimer = null
    requestPiPackageActivationTick()
  }, 2_500)
  piPackageActivationRetryTimer.unref?.()
}
let browser: BrowserController | null = null
const scheduleService = new ScheduleService({
  file: join(YAN_DIR, 'schedules.json'),
  run: async (task) => {
    const settings = await getSettings()
    const cwdResult = await sessionHost.validateCwd(task.cwd || settings.cwd)
    if (!cwdResult.ok) throw new Error(cwdResult.error)
    if (!runners) {
      const started = await sessionHost.startAgent()
      if (!started.ok) throw new Error(started.error ?? 'pi 未运行')
    }
    const cwd = cwdResult.cwd
    const projectId = sessionHost.projectIdForCwd(settings, cwd)
    const scope = projectId ? 'project' : 'global'
    const registry = runners!
    const res = await registry.select({ cwd, projectId, scope, activate: false, origin: { kind: 'scheduled', scopeId: task.id } })
    if (!res.ok || !res.id) throw new Error(res.error ?? '无法新建会话（运行实例已满？）')
    const pin = pinSendTarget(res.id)
    const selectedRuntime = { runId: res.runId ?? res.id, sessionId: res.sessionId, generation: res.generation }
    const current = () => runners === registry && !!pin && pinnedTargetMatches(pin) && sameRuntimeEnvelope(pin, selectedRuntime)
    if (!pin || !current()) throw new Error('定时任务的目标会话已变化，未发送指令')
    await sessionHost.rememberRunnerSession(res, { cwd, projectId, scope })
    if (!current()) throw new Error('定时任务的目标会话已变化，未发送指令')
    const agent = pin.agent
    const sessionId = res.sessionId ?? agent.getState()?.sessionId
    const sessionFile = agent.getState()?.sessionFile
    const scheduled = runsHost && sessionId
      ? await runsHost.openScheduled({
          scopeId: task.id,
          sessionId,
          ...(res.generation !== undefined ? { generation: res.generation } : {}),
          ...(sessionFile ? { sessionPath: sessionFile } : {}),
          title: task.name
        })
      : null
    try {
      if (task.model) {
        const at = task.model.indexOf('/')
        const set = await agent.setModel(task.model.slice(0, at), task.model.slice(at + 1))
        if (!current()) throw new Error('定时任务的目标会话已变化，未发送指令')
        if (!set.ok) throw new Error(set.error ?? '指定的模型不可用')
      }
      const guard = registry.guardExecute(res.id)
      if (!guard.ok) throw new Error(guard.error)
      const sent = await agent.send(`[定时任务 · ${task.name}]\n${task.prompt}`)
      if (!sent.ok) throw new Error(sent.error ?? '指令没有发出')
    } catch (error) {
      if (scheduled && runsHost) runsHost.failScheduled(scheduled, error instanceof Error ? error.message : String(error))
      throw error
    }
    if (current()) void sessionHost.pushRunnerSnapshot(res.id)
    sessionHost.pushRunners()
    return { sessionId: res.sessionId }
  }
})
const notifySubagentFinished = createSubagentNotifier({
  enabled: async () => (await getSettings()).subagentNotify !== false,
  find: (run) =>
    (run.parentSessionId ? runners?.agentForSession(run.parentSessionId) : null) ??
    (run.parentRunId ? runners?.agentOf(run.parentRunId) : null) ??
    null,
  runningSiblings: (run) => subagentService.current()?.runningSiblings({ parentSessionId: run.parentSessionId, parentRunId: run.parentRunId }) ?? 0
})
const subagentService: SubagentService = new SubagentService({
  codemodeExtension: codemodeExtensionPath,
  providerExtensions: providerExtensionPaths,
  guardExtension: dangerGuardExtensionPath,
  shellExtension: shellFallbackExtensionPath,
  resolveModelApi: async (label, origin) => {
    const parent = (origin.runId ? runners?.agentOf(origin.runId) : null) ??
      (origin.sessionId ? runners?.agentForSession(origin.sessionId) : null) ?? null
    if (!parent) throw new Error('来源会话已关闭，无法核对指定模型')
    const selected = (await parent.listModels()).find(model => `${model.provider}/${model.id}` === label)
    if (!selected) throw new Error(`来源会话中指定模型 ${label} 已不可用`)
    return selected.api
  },
  confirmDanger: async (params, cwd, origin) => {
    if ((await getSettings()).permissionMode === 'all') return true
    const detail = String(params.detail ?? '')
    if (detail.length > 20000) return false
    const answer = await approvals.ask({
      ...(origin?.sessionId ? { sessionId: origin.sessionId } : {}),
      ...(origin?.runId ? { runId: origin.runId } : {}),
      ...(origin?.subagentId ? { subagentId: origin.subagentId } : {}),
      kind: 'danger', tool: String(params.tool ?? 'tool').slice(0, 40),
      title: '子 Agent 想执行一个难以撤销的操作',
      detail,
      reasons: Array.isArray(params.reasons) ? params.reasons.filter((item): item is string => typeof item === 'string').slice(0, 6).map(item => item.slice(0, 200)) : [],
      cwd, canRemember: false
    })
    return answer === 'once'
  },
  onChange: (run) => {
    push({ ch: 'subagent', payload: run })
    refreshTaskbar()
  },
  onPatch: ({ id, run, transcriptFrom }) => {
    push({ ch: 'subagent-patch', payload: { id, run, transcriptFrom } })
    refreshTaskbar()
  },
  onRemove: (id) => {
    push({ ch: 'subagent-remove', payload: id })
    refreshTaskbar()
  },
  onEvent: (runId, evt) => {
    reviewRuns?.observe(runId, evt)
  },
  resolveAgentProfile: (id) => resolveAgentProfile(id),
  onFinished: (run) => {
    reviewRuns?.settle(
      run.id,
      run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'stopped' : 'failed',
      run.error
    )
    notifySubagentFinished(run)
  }
})
let remoteAccess: RemoteAccess | null = null

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

function yanThinResourcePath(file: string): string | undefined {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'yan-thin', file) : '',
    join(__dirname_, '..', '..', 'resources', 'pi-extensions', file),
    join(process.cwd(), 'resources', 'pi-extensions', file)
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

function questionExtensionPath(): string | undefined {
  return yanThinResourcePath('question.js')
}

function shellFallbackExtensionPath(): string | undefined {
  return yanThinResourcePath('shell-fallback.js')
}

function codemodeExtensionPath(): string | undefined {
  return yanThinResourcePath('codemode-policy.js')
}

function responseDetailExtensionPath(): string | undefined {
  return yanThinResourcePath('response-detail.js')
}

function preambleExtensionPath(): string | undefined {
  return yanThinResourcePath('preamble.js')
}

function languageExtensionPath(): string | undefined {
  return yanThinResourcePath('language.js')
}

function temperatureExtensionPath(): string | undefined {
  return yanThinResourcePath('temperature.js')
}

function capabilityGuideExtensionPath(): string | undefined {
  return yanThinResourcePath('capability-guide.js')
}

function contextTrimExtensionPath(): string | undefined {
  return yanThinResourcePath('context-trim.js')
}

function nativeSessionExtensionPath(): string | undefined {
  return yanThinResourcePath('native-session-bridge.js')
}

function repeatGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('repeat-guard.js')
}
function mcpAppProxyExtensionPath(): string | undefined {
  return yanThinResourcePath('mcp-app-proxy.js')
}
function dangerGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('danger-guard.js')
}
function providerExtensionPaths(): string[] {
  return [yanThinResourcePath('commandcode.js'), yanThinResourcePath('provider-diagnostics.js')].filter((p): p is string => !!p)
}
function yanThinExtensionPaths(): string[] {
  return [
    codemodeExtensionPath(),
    questionExtensionPath(),
    shellFallbackExtensionPath(),
    responseDetailExtensionPath(),
    preambleExtensionPath(),
    languageExtensionPath(),
    temperatureExtensionPath(),
    capabilityGuideExtensionPath(),
    mcpAppProxyExtensionPath(),
    contextTrimExtensionPath(),
    nativeSessionExtensionPath(),
    repeatGuardExtensionPath(),
    dangerGuardExtensionPath(),
    ...providerExtensionPaths(),
  ].filter((p): p is string => !!p && isAgentContextExtension(p))
}

function push(msg: MainPush): void {
  remoteAccess?.publish(msg)
  if (msg.ch === 'runs') attention?.refreshTaskbar()
  if (msg.ch === 'runs') auxWindows?.notifyRuns()
  if (!win || win.isDestroyed()) return
  win.webContents.send('yan:push', msg)
}

const approvals = new ApprovalBroker({
  canAsk: () => !!win && !win.isDestroyed(),
  open: (request) => {
    runsHost?.observeApproval(request)
    push({ ch: 'approval', payload: request })
    if (win && !win.isDestroyed() && !win.isFocused()) {
      attention?.flash()
      void getSettings().then((settings) => {
        if (settings.sound?.notifications === false || !Notification.isSupported()) return
        const notice = new Notification({ title: '砚需要你确认', body: request.title })
        notice.on('click', () => {
          if (!win || win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        })
        notice.show()
      }).catch(() => undefined)
    }
    refreshTaskbar()
  },
  close: (id) => {
    runsHost?.resolveApproval(id)
    push({ ch: 'approval-close', payload: { id } })
    refreshTaskbar()
  }
})

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
  statuses: () => runners?.statuses() ?? [],
  showMainWindow,
  newSession: () => push({ ch: 'tray-new-session', payload: null }),
  selectSession: (target: TraySelectTarget) => {
    showMainWindow()
    push({ ch: 'tray-select-session', payload: target })
  },
  quit: () => void requestExit(),
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
    if (settings.sound?.notifications === false || !Notification.isSupported()) return
    const title = status.kind === 'permission'
      ? '终端在等你批准'
      : status.kind === 'question'
        ? '终端在等你回答'
        : status.kind === 'auth'
          ? '终端在等你登录'
          : '终端在等你'
    const notice = new Notification({ title, body: status.title || '切到该终端查看' })
    notice.on('click', () => {
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notice.show()
  }).catch(() => undefined)
}

const sessionChains = new SessionChainStore()

const artifactStore = new ArtifactStore(join(YAN_DIR, 'artifacts'))

function readHistoryWithArtifacts(sessionFile: string) {
  return readChainMessages(sessionFile, sessionChains, (file, messages) =>
    artifactStore.hydrateMessages(file, messages)
  ).then(async (result) => {
    if (!result) return result
    const bucket = timingKey(sessionFile)
    if (!bucket) return result
    const records = await readTurnTimings(YAN_DIR, bucket).catch(() => [])
    if (!records.length) return result
    return { ...result, messages: applyTurnTimings(result.messages, records) }
  })
}
const worktreeOrigins = new WorktreeLinkStore()

const autoIsolations = new AutoIsolationStore()

let isolationSweepAt = 0
const ISOLATION_SYNC_MIN_INTERVAL = 3000
const isolationBlockedReason = new Map<string, string>()

const isolationView = new Map<string, { state: 'waiting' | 'blocked'; branch: string }>()

function isolationOf(cwd: string): { state: 'waiting' | 'blocked'; branch: string } | undefined {
  return isolationView.get(isolationCwdKey(cwd))
}

function setIsolationView(worktree: string, view: { state: 'waiting' | 'blocked'; branch: string } | null): void {
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

function pushIsolationStatus(): void {
  const items = [...isolationView.values()]
  const waiting = items.filter((x) => x.state === 'waiting').length
  const blocked = items.filter((x) => x.state === 'blocked').length
  const text =
    items.length === 0
      ? undefined
      : blocked > 0
        ? `隔离工作树：${blocked} 个合回被挡，${waiting} 个等主干空闲`
        : `隔离工作树：${waiting} 个等主干空闲后自动合回`
  push({ ch: 'status', payload: { key: 'isolation', text } })
}

async function initializeIsolationView(): Promise<void> {
  const records = await autoIsolations.all().catch(() => [])
  for (const record of records) setIsolationView(record.worktree, { state: 'waiting', branch: record.branch })
}

async function syncPendingIsolations(): Promise<void> {
  if (!runners || !win || win.isDestroyed()) return
  if (Date.now() - isolationSweepAt < ISOLATION_SYNC_MIN_INTERVAL) return
  isolationSweepAt = Date.now()
  const records = await autoIsolations.all().catch(() => [])
  for (const record of records) {
    if (runners.hasBusyCwd(record.mainCwd)) {
      setIsolationView(record.worktree, { state: 'waiting', branch: record.branch })
      continue
    }
    const result = await syncIsolationBack(record)
    if (result.ok && result.action === 'merged') {
      isolationBlockedReason.delete(record.worktree)
      setIsolationView(record.worktree, null)
      await autoIsolations.markSynced(record.worktree).catch(() => undefined)
      push({
        ch: 'notify',
        payload: {
          id: `iso-merged-${Date.now()}`,
          method: 'notify',
          notifyType: 'info',
          message: `隔离工作树 ${record.branch} 的改动已自动合回主干。`
        }
      })
      continue
    }
    if (!result.ok && result.action === 'blocked') {
      setIsolationView(record.worktree, { state: 'blocked', branch: record.branch })
      if (isolationBlockedReason.get(record.worktree) === result.detail) continue
      isolationBlockedReason.set(record.worktree, result.detail)
      push({
        ch: 'notify',
        payload: {
          id: `iso-blocked-${Date.now()}`,
          method: 'notify',
          notifyType: 'warning',
          message: `自动合回暂缓（${record.branch}）：${result.detail}。改动仍在隔离工作树里，没有丢；在隔离工作树里并入主干、把冲突解掉后，后续轮次会自动接着合回。`
        }
      })
    }
  }
  const alive = new Set(records.map((record) => isolationCwdKey(record.worktree)))
  for (const key of [...isolationView.keys()]) {
    if (!alive.has(key)) setIsolationView(key, null)
  }
}

function pushFrom(runnerId: string, msg: MainPush, expectedRuntime?: RuntimeEnvelope | null): void {
  const runtime = runners?.runtimeOf(runnerId)
  if (!runtime) {
    if (msg.ch === 'ui-request') console.warn(`[ui-request] 实例 ${runnerId} 已摘登记，问题推送被丢弃：${msg.payload.id}`)
    return
  }
  if (expectedRuntime && !sameRuntimeEnvelope(runtime, expectedRuntime)) return
  runners?.noteActivity(runnerId)
  push({
    ...msg,
    ...(runtime ? { runtime } : {}),
    sessionKey: runnerId
  })
  if (msg.ch === 'state' || msg.ch === 'proc') refreshTrayMenu()
  if (msg.ch === 'state' || msg.ch === 'proc') requestPiPackageActivationTick()
  if (msg.ch === 'state' && (msg.payload as SessionState)?.isAgentRunning === false) void syncPendingIsolations()
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
    const schedulers = [piPackageActivationScheduler].filter(
      (scheduler): scheduler is NonNullable<typeof scheduler> => scheduler !== null
    )
    if (schedulers.length === 0) return
    if (piPackageActivationInFlight) {
      piPackageActivationAgain = true
      return
    }
    piPackageActivationInFlight = true
    void Promise.all(schedulers.map((scheduler) => scheduler.tick())).then((groups) => {
      const results = groups.flat()
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
      if (results.some((result) =>
        result.state === 'deferred' && result.detail.includes('等待薄层一次性续接消费证据')
      )) {
        schedulePiPackageActivationRetry()
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

type ExpectedRuntimeInput = { sessionId?: string; runId?: string; generation?: number }

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
  const runtime = runners?.runtimeOf(id)
  if (!runtime) return false
  if (expected.runId !== undefined && runtime.runId !== expected.runId) return false
  if (expected.generation !== undefined && runtime.generation !== expected.generation) return false
  if (expected.sessionId !== undefined && runtime.sessionId !== expected.sessionId) {
    if (!expected.sessionId.startsWith('pending:')) return false
  }
  return true
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
  if (!runtime || !sameRuntimeEnvelope(runtime, captured)) throw new Error('子代理父会话已不可用，未派发')
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

const workModes = new WorkModeStore()

async function pushRunnerSnapshot(id: string, opts: { chainHistory?: boolean } = {}): Promise<void> {
  const ag = runners?.agentOf(id)
  if (!ag) return
  const expected = runners?.runtimeOf(id)
  if (!expected) return
  const st = ag.getState()
  if (st) pushFrom(id, { ch: 'state', payload: st }, expected)
  try {
    let payload = await ag.getMessages()
    if (runners?.agentOf(id) !== ag || !sameRuntimeEnvelope(runners?.runtimeOf(id), expected)) return
    if (opts.chainHistory && st?.sessionFile) {
      const chain = await readHistoryWithArtifacts(st.sessionFile).catch(() => null)
      if (runners?.agentOf(id) !== ag || !sameRuntimeEnvelope(runners?.runtimeOf(id), expected)) return
      if (chain?.messages?.length && chain.messages.length >= payload.length) payload = chain.messages
    }
    pushFrom(id, { ch: 'sync', payload }, expected)
  } catch {
  }
  void ag
    .refreshStats({ expectGeneration: expected.generation })
    .then((stats) => {
      if (stats) pushFrom(id, { ch: 'stats', payload: stats }, expected)
    })
    .catch(() => {})
  void ag.refreshTodos().catch(() => {})
  await pushWorkMode(id)
  await pushAgentProfile(id)
  pushRunners()
}

let shuttingDown = false
let releaseDesktopDataRoot: (() => Promise<void>) | undefined
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  scheduleService.stop()
  disposeKeepAwake()
  attention?.dispose()
  auxWindows?.dispose()
  panePopout?.dispose()
  paneTerminal?.dispose()
  paneBrowserTransfer?.dispose()
  try {
    await remoteAccess?.stop()
  } catch {
  }
  remoteAccess = null
  try {
    await runners?.stopAll()
  } catch {
  }
  try {
    mcpAppViewService?.close()
  } catch (error) {
    reportMainError('mcp-app-view-shutdown', error)
  }
  mcpAppViewService = null
  appViewForeground = null
  try {
    await closeMcpAppHost()
  } catch {
  }
  try {
    await subagentService.current()?.stopAll()
  } catch {
  }
  try {
    await runsHost?.dispose()
  } catch (error) {
    reportMainError('runs-host-shutdown', error)
  }
  runsHost = null
  reviewRuns = null
  try {
    await browser?.dispose()
  } catch {
  }
  try {
    disposeTerminals()
  } catch {
  }
  await releaseDesktopDataRoot?.().catch((error) => reportMainError('data-root-unlock', error))
}

type ExitChoice = 'cancel' | 'save' | 'interrupt'
type ExitResult = { action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }

function probeExitChoice(): ExitChoice | undefined {
  if (!process.env.YAN_PROBE) return undefined
  const value = process.env.YAN_EXIT_CHOICE
  return value === 'cancel' || value === 'save' || value === 'interrupt' ? value : undefined
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


async function startRemoteServer(): Promise<void> {
  if (!remoteAccess) {
    remoteAccess = new RemoteAccess(
      YAN_DIR,
      {
        snapshot: remoteSnapshot,
        history: remoteHistory,
        models: remoteModels,
        image: remoteMessageImage,
        command: executeRemoteCommand,
        questions: remoteQuestions,
        answer: remoteAnswer,
        humanApproval: remoteHumanApproval,
        artifact: remoteArtifact
      },
      (text, level) => {
        if (level === 'error') console.error(`[remote] ${text}`)
        else console.log(`[remote] ${text}`)
      },
      { grants: peerGrants, handlers: peerHostHandlers }
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
      return { ok: false, action: command.action, error: '砚主窗口尚未就绪' }
    }

    if (command.action === 'focus') {
      showMainWindow()
      return { ok: true, action: command.action, data: controlStatus() }
    }

    if (command.action === 'click') {
      const [width, height] = win.getContentSize()
      const x = command.x ?? -1
      const y = command.y ?? -1
      if (x < 0 || y < 0 || x >= width || y >= height) {
        return { ok: false, action: command.action, error: `坐标超出内容区域：${width}×${height}` }
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
      if (!keyCode) return { ok: false, action: command.action, error: '只支持受限导航键' }
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
      const result = (active?.id ? await runners?.agentOf(active.id)?.send(command.text ?? '') : undefined) ?? { ok: false, error: 'pi 未运行' }
      return result.ok
        ? { ok: true, action: command.action, data: { length: command.text?.length ?? 0 } }
        : { ok: false, action: command.action, error: result.error ?? 'pi 未运行' }
    }

    return { ok: false, action: command.action, error: '未知控制动作' }
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

function requestExit(): Promise<ExitResult> {
  if (isQuitting) return Promise.resolve({ action: 'already-exiting' })
  if (exitRequestInFlight) return exitRequestInFlight

  const task: Promise<ExitResult> = (async (): Promise<ExitResult> => {
    const busy = runners?.hasBusy() === true
    let choice = probeExitChoice()
    if (!choice && busy && win && !win.isDestroyed()) {
      const response = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '退出砚',
        message: '仍有会话正在运行。请选择退出方式。',
        detail: '保存并退出会记录运行实例快照；中断退出会立即停止当前任务。取消会继续把窗口留在托盘。',
        buttons: ['取消', '保存并退出', '中断退出'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      })
      choice = response.response === 2 ? 'interrupt' : response.response === 1 ? 'save' : 'cancel'
    }
    if (!choice) choice = 'save'
    if (choice === 'cancel') return { action: 'cancelled' }

    isQuitting = true
    const mode = choice === 'save' ? 'save' : 'interrupt'
    await writeExitSnapshot(mode, runners?.statuses() ?? []).catch((error) => {
      console.error('[exit-snapshot] 写入失败：', error)
    })
    const action: 'save-and-exit' | 'interrupt-exit' = choice === 'save' ? 'save-and-exit' : 'interrupt-exit'
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

function knowledgeProjectId(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string {
  const registered = projectIdForCwd(settings, cwd)
  if (registered) return registered
  return deriveProjectId(cwd, (id) => settings.projects.some((project) => project.id === id))
}

async function validateCwd(cwd: unknown): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { ok: false, error: '工作目录不能为空' }
  }
  const raw = cwd.trim()
  const absolute = resolve(raw)
  try {
    const info = await stat(absolute)
    if (!info.isDirectory()) {
      return { ok: false, error: `工作目录不是文件夹：${raw}` }
    }
    await access(absolute, fsConstants.R_OK)
    return { ok: true, cwd: absolute }
  } catch {
    return { ok: false, error: `工作目录不存在或不可访问：${raw}` }
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
    if (choice !== 'once' && choice !== 'remember') {
      return { decision: choice === 'deny' ? 'denied' : 'no-answer', target,
        message: choice === 'deny' ? '用户拒绝移动，继续在当前文件夹工作。' : '没有得到答复，会话留在当前文件夹。' }
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
      sameRuntimeEnvelope(pin, selectedRuntime) && pin.sessionId === job.sessionId &&
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
    await job.registry.stopOne(job.origin.runId)
    if (shuttingDown || job.origin.agent.running) throw new Error('原会话进程未安全关闭，没有改写会话文件')
    await rewriteSessionCwd(job.sessionFile, job.target)
    let settings = await getSettings()
    const projectOf = () => settings.projects.find(p => !p.archived && normalizeCwdForIdentity(p.cwd) === normalizeCwdForIdentity(job.target))
    if (!projectOf()) settings = await patchSettings({ recentCwds: [job.target, ...(settings.recentCwds ?? [])] })
    await moveSessionLayout({ sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: job.target }, projectOf()?.id ?? null)
    const continuation = resume ? await continueMovedSession(job, projectOf()?.id) :
      { continued: false, continuationError: '原回合已停止、失败或有新的输入，未自动继续' }
    push({ ch: 'session-moved', payload: { sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: job.target, ok: true, ...continuation } })
  } catch (error) {
    push({ ch: 'session-moved', payload: { sessionId: job.sessionId, sessionFile: job.sessionFile, cwd: job.target, ok: false, error: error instanceof Error ? error.message : String(error) } })
  } finally {
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
    return { ok: false, context: provisional, error: '工作目录不属于已授权的项目或会话' }
  }
  const checked = await validateCwd(requestedCwd)
  if (!checked.ok) return { ok: false, context: provisional, error: checked.error }

  if (projectId) {
    const project = settings.projects.find((item) => item.id === projectId)
    if (!project) return { ok: false, context: { ...provisional, cwd: checked.cwd }, error: '项目不存在或已被移除' }
    if (normalizeCwdForIdentity(project.cwd) !== normalizeCwdForIdentity(checked.cwd)) {
      if (await isRunnerProjectCwd(checked.cwd, projectId, runners?.statuses() ?? [])) {
        return { ok: true, context: { ...provisional, cwd: checked.cwd } }
      }
      const byCwd = settings.projects.find(
        (item) => normalizeCwdForIdentity(item.cwd) === normalizeCwdForIdentity(checked.cwd)
      )
      if (!byCwd) {
        return { ok: false, context: { ...provisional, cwd: checked.cwd }, error: '项目与工作目录不匹配' }
      }
      return { ok: true, context: { ...provisional, cwd: checked.cwd, projectId: byCwd.id } }
    }
  }

  return { ok: true, context: { ...provisional, cwd: checked.cwd } }
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
  await rememberSession({
    sessionId: result.sessionId,
    sessionFile: state?.sessionFile ?? target.sessionFile,
    cwd: state?.cwd ?? target.cwd,
    ...(target.projectId ? { projectId: target.projectId } : {}),
    ...(target.scope ? { scope: target.scope } : {})
  }).catch((error) => {
    console.error('[session-layout] 记录会话归属失败：', error)
  })
}

let starting: Promise<{ ok: boolean; error?: string }> | null = null
let agentResponseDetail: 'brief' | 'standard' | 'detailed' = 'standard'

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
  await runners?.stopAll()
  await subagentService.current()?.stopAll()

  const settings = await getSettings()
  await refreshManagedGit().catch(() => undefined)
  agentResponseDetail = settings.responseDetail
  setDefaultWorkMode(settings.defaultWorkMode)

  runners = new RunnerRegistry({
    isSessionVisible: (state) => runnerVisibility.includes(state),
    isParentProtected: (sessionId, runId) => subagentService.current()?.hasParentRun(sessionId, runId) ?? false,
    onRunnerOrigin: ({ sessionId, generation, origin }) => {
      if (!runsHost) return
      if (origin) {
        runsHost.bindScheduledOrigin({
          scopeId: origin.scopeId,
          ...(sessionId ? { sessionId } : {}),
          generation
        })
      } else if (sessionId) {
        runsHost.clearScheduledOrigin({ sessionId, generation })
      }
    },
    onReclaimed: ({ id, sessionId, idleMs, remaining }) => {
      mcpAppViewService?.invalidateRunnerId(id)
      const text = `[运行实例回收] ${id} (${sessionId ?? 'unknown'}) 空闲 ${Math.floor(idleMs / 1000)} 秒，释放1个 pi 实例，剩余 ${remaining} 个`
      console.log(text)
      push({ ch: 'log', payload: { text } })
    },
    prepareNewSession: async agent => {
      return applyRememberedModel(agent, (await getSettings()).lastMainModel)
    },
    isolationOf,
    resolveCwdConflict: async (target) => {
      if (target.activate === false || target.hidden) return null
      if (runners && runners.size >= runners.limit) return null
      const existing = target.sessionId ? await autoIsolations.bySession(target.sessionId).catch(() => null) : null
      if (existing) return { cwd: existing.worktree }
      const outcome = await isolateCwdForConflict(target.cwd, { sessionId: target.sessionId })
      if (!outcome.ok) return { reason: outcome.reason }
      await autoIsolations.add(outcome.record).catch(() => undefined)
      setIsolationView(outcome.record.worktree, { state: 'waiting', branch: outcome.record.branch })
      return { cwd: outcome.record.worktree }
    },
    createAgent: (id, cwd, generation) =>
      new AgentController({
        push: (m) => pushFrom(id, m),
        observeRun: runsHost?.observerFor({ generation }) ?? undefined,
        cwd,
        piBin: settings.piBin,
        codemodeExtension: codemodeExtensionPath(),
        questionExtension: questionExtensionPath(),
        shellFallbackExtension: shellFallbackExtensionPath(),
        responseDetailExtension: responseDetailExtensionPath(),
        getResponseDetail: () => agentResponseDetail,
        browserHost: () => browser,
        subagentHost: subagentService.capabilityHost,
        scheduleHost: scheduleService,
        preambleExtension: preambleExtensionPath(),
        languageExtension: languageExtensionPath(),
        temperatureExtension: temperatureExtensionPath(),
        capabilityGuideExtension: capabilityGuideExtensionPath(),
        contextTrimExtension: contextTrimExtensionPath(),
        nativeSessionExtension: nativeSessionExtensionPath(),
        mcpAppProxyExtension: mcpAppProxyExtensionPath(),
        mcpAppToolsSnapshot: mcpAppProxyToolsEnv().YAN_MCP_APP_TOOLS,
        repeatGuardExtension: repeatGuardExtensionPath(),
        dangerGuardExtension: dangerGuardExtensionPath(),
        providerExtensions: providerExtensionPaths(),
        bundledSkills: bundledSkillPaths(),
        userSkills: () => userSkillPaths(),
        readHistory: (sessionFile) => readHistoryWithArtifacts(sessionFile),
        capability: {
          sessionId: id ?? 'primary',
          runnerGeneration: generation ?? 1,
          projectId: knowledgeProjectId(settings, cwd),
          opsDir: join(YAN_DIR, 'ops'),
          binDir: join(YAN_DIR, 'bin'),
          artifactDir: join(YAN_DIR, 'artifacts'),
          devResourcesDir: join(app.getAppPath(), 'resources'),
          getWorkMode: async () => (await resolveWorkMode(id ?? 'primary')).mode,
          getCapabilityStrategy: async () => (await getSettings()).capabilityStrategy,
          ...(id
            ? {
                execution: runners?.executionPort(id) ?? {
                  claim: () => ({ ok: false as const, error: '运行实例注册表尚未就绪' }),
                  confirm: () => false,
                  release: () => {}
                }
              }
            : {}),
          onBashSettled: () => requestPiPackageActivationTick(),
          trashItem: (path: string) => shell.trashItem(path)
        },
        confirmCapabilityAuthorization: async (
          request: CapabilityAuthorizationPrompt
        ): Promise<CapabilityAuthorizationChoice> => {
          const endpointUrl = request.endpoint ? new URL(request.endpoint) : null
          const loopback =
            endpointUrl &&
            (endpointUrl.hostname === 'localhost' ||
              endpointUrl.hostname === '127.0.0.1' ||
              endpointUrl.hostname === '[::1]')
          if (
            process.env.YAN_PROBE_HIDDEN === '1' &&
            process.env.YAN_PROBE_AUTO_AUTHORIZE_LOOPBACK_MCP === '1' &&
            request.kind === 'remote-mcp' &&
            request.source === 'mcp-registry:yan/fixture-remote@1.0.0' &&
            loopback
          ) {
            return 'allow'
          }
          if (!win || win.isDestroyed()) return 'deny'
          const isRemote = request.kind === 'remote-mcp'
          const trust = isRemote ? null : await trustStatus(request.cwd)
          const buttons = isRemote
            ? ['拒绝', '允许此项目连接该 host']
            : trust?.trusted
              ? ['拒绝', '允许（禁用 lifecycle scripts）', '允许（包含 lifecycle scripts）']
              : [
                  '拒绝',
                  '允许并信任此项目（禁用 lifecycle scripts）',
                  '允许并信任此项目（包含 lifecycle scripts）'
                ]
          const response = await dialog.showMessageBox(win, {
            type: 'warning',
            title: isRemote ? '授权远程 MCP 服务' : '授权本地能力包',
            message: isRemote
              ? `是否允许当前项目连接「${request.title}」？`
              : `是否允许当前项目接入「${request.title}」并运行其本机代码？`,
            detail: [
              `候选：${request.source}`,
              `项目：${request.projectId}`,
              `内容指纹：${request.digest}`,
              ...(request.endpoint ? [`远程端点：${request.endpoint}`, '该服务会收到本任务发送给它的请求内容。'] : []),
              ...(!isRemote
                ? [
                    '本地包会在安装后的预检（smoke）及 pi 重载时以当前 Windows 用户权限运行，可能访问此用户的本机文件；staging 与离线环境不是操作系统沙箱。',
                    '禁用 lifecycle scripts 只影响安装脚本，不会隔离包的运行时代码。',
                    ...(trust?.trusted
                      ? ['此项目已经在 trust.json 中显式信任；本次不会改写信任设置。']
                      : [
                          '此项目尚未信任。允许后会把当前目录写入 Pi 的 trust.json；该项目现有及未来的 .pi 设置、扩展、技能等资源都将允许加载，不只限于本候选。请仅对你信任的项目允许。'
                        ])
                  ]
                : []),
              '授权仅绑定此候选 / host 与当前项目；拒绝时不会登记或执行。'
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
                title: '无法信任项目',
                message: '项目包授权未保存',
                detail: saved.error ?? '写入 Pi trust.json 失败。没有保存候选授权。',
                buttons: ['确定'],
                noLink: true
              })
              return 'deny'
            }
          }
          return choice
        },
        confirmExternalApi: async (request: ExternalApiConfirmationRequest): Promise<boolean> => {
          if (!win || win.isDestroyed()) return false
          const endpoint = request.endpoint || '未配置的 OpenAI-compatible endpoint'
          const response = await dialog.showMessageBox(win, {
            type: 'warning',
            title: '确认外部图像 API 请求',
            message: `即将通过 ${({ compatible: 'OpenAI-compatible API', openai: 'OpenAI API', google: 'Google Gemini API', doubao: '火山方舟（豆包）API', local: '远程 SD WebUI / ComfyUI' } as const)[request.provider]} 生成图片`,
            detail: [
              `端点：${endpoint}`,
              `模型：${request.model}`,
              `项目：${request.cwd}`,
              `提示词：${request.prompt.slice(0, 800)}${request.prompt.length > 800 ? '…' : ''}`,
              '',
              '这会把提示词（以及将来接入的参考图片）发送到外部服务，并可能产生 API 费用。拒绝后不会发送请求，也不会自动切换到其他供应商。'
            ].join('\n'),
            buttons: ['取消', '继续发送'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
          return response.response === 1
        },
        getPermissionMode: async () => (await getSettings()).permissionMode ?? 'danger',
        confirmDanger: async (request): Promise<ConsentDecision | null> => {
          const rememberDirs = [...new Set((request.outsideDirs ?? []).filter((p) => typeof p === 'string' && isAbsolute(p)).map((p) => dirname(resolve(p))))]
          const isPermission = request.kind === 'permission'
          const isDelete = request.kind === 'delete'
          const isShell = request.tool === 'bash' || request.tool === 'powershell'
          const choice = await approvals.ask({
            runId: id, sessionId: runners?.agentOf(id)?.getState()?.sessionId,
            kind: isDelete ? 'delete' : isPermission ? 'permission' : rememberDirs.length ? 'outside' : 'danger',
            tool: request.tool,
            title: isDelete
              ? 'Agent 想删除文件'
              : isPermission
              ? isShell ? 'Agent 想运行一条命令' : 'Agent 想修改文件'
              : rememberDirs.length ? 'Agent 想写入项目之外的位置' : 'Agent 想执行一个难以撤销的操作',
            detail: request.detail,
            reasons: request.reasons,
            cwd: request.cwd,
            ...(rememberDirs.length ? { rememberDirs } : {}),
            canRemember: rememberDirs.length > 0
          })
          if (choice === 'remember') {
            if (rememberDirs.length) {
              const current = await getSettings()
              await patchSettings({ guardAllowRoots: [...(current.guardAllowRoots ?? []), ...rememberDirs] })
            }
          }
          return choice === 'once' || choice === 'remember' ? 'allow' : choice === 'deny' ? 'deny' : null
        },
        requestSessionMove,
        confirmToolConsent: async (request: ToolConsentPrompt): Promise<ConsentDecision | null> => {
          const { parts, verdict } = request
          const choice = await approvals.ask({
            runId: id, sessionId: runners?.agentOf(id)?.getState()?.sessionId,
            kind: 'consent',
            tool: parts.capability,
            title: `Agent 想使用「${parts.capability}」执行「${parts.action}」`,
            detail: parts.resource,
            reasons: [
              ...(request.purpose ? [`用途：${request.purpose}`] : []),
              verdict.reason,
              verdict.danger ? '危险类别不会因为同意次数多而自动放行。' : '同类操作多次同意后会自动放行；可在「设置 → 能力」里改为始终询问或清空记录。'
            ],
            cwd: request.cwd,
            canRemember: false
          })
          return choice === 'once' || choice === 'remember' ? 'allow' : choice === 'deny' ? 'deny' : null
        }
      }),
    onChanged: () => {
      pushRunners()
      scheduleEpochSnapshots()
      requestPiPackageActivationTick()
    }
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
  const acquisitions = new AcquisitionService({ root: YAN_DIR })
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
          return (await runners?.restartOne(id)) ?? { ok: false, error: '运行实例注册表尚未就绪' }
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

  const projectId = projectIdForCwd(settings, settings.cwd)
  const res = await runners.startPrimary(settings.cwd, restore?.sessionFile, projectId)
  await rememberRunnerSession(res, {
    cwd: settings.cwd,
    projectId,
    scope: 'project',
    ...(restore?.sessionFile ? { sessionFile: restore.sessionFile } : {})
  })
  pushRunners()
  if (res.ok && res.id) await pushRunnerSnapshot(res.id)
  requestPiPackageActivationTick()
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

let agentRestarting = false
let agentRestartQueued: string | null = null

let hotkeyGuardPaused = false
async function restartAgent(reason: string, retries = 150): Promise<void> {
  if (agentRestarting) {
    agentRestartQueued = reason
    return
  }
  if (starting) await starting
  if (!runners) return
  if (runners.hasBusy()) {
    if (retries <= 0) {
      agentRestartQueued = null
      reportMainError('刷新运行实例', new Error(`${reason}：等待空闲超时，配置已保存但未刷新运行实例，请稍后重试`))
      return
    }
    setTimeout(() => void restartAgent(reason, retries - 1).catch((error) => reportMainError('刷新运行实例', error)), 2000)
    return
  }
  agentRestarting = true
  const file = ac()?.getState()?.sessionFile
  try {
    await runners.stopAll()
    const res = await startAgent(file ? { sessionFile: file } : undefined)
    if (res.ok && file && ac()?.getState()?.sessionFile !== file) {
      const sw = await ac()?.switchSession(file)
      if (sw && !sw.ok) {
        push({ ch: 'log', payload: { text: `[会话] 重建 pi 后没能接回原会话：${sw.error ?? '未知原因'}` } })
      }
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

function samePathKind(a: string, b: string): boolean {
  const norm = (v: string): string => String(v ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function registerIpc(): void {
  configureWriteContext({
    hasRunningTask: (cwd) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, cwd))
  })


  const isTrustedIpc = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  const ipc = createIpcRegistrar(isTrustedIpc)
  const { handle, rawHandle } = ipc

  handle('yan:start', async () => {
    const settings = await getSettings()
    const res = await startAgent()
    return { ...res, state: ac()?.getState() ?? undefined, settings }
  })

  handle('yan:send', async (text: string, images?: { data: string; mimeType: string }[], mode?: 'steer' | 'followUp', expectedInput?: unknown) => {
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid') return { ok: false, error: '发送目标身份无效，消息未发送' }
    let targetId = expected ? resolveExpectedTarget(expected) ?? undefined : runners?.activeRunnerId
    if (expected && !targetId) return { ok: false, error: '目标会话已不在或已切换，消息未发送；草稿已保留' }
    let pin = targetId ? pinSendTarget(targetId) : null
    const sendOwnershipChanged = (id: string | null | undefined): boolean =>
      (!!expected && (!id || !targetMatchesExpected(id, expected))) || (!!id && !!pin && !pinnedTargetMatches(pin))
    if (sendOwnershipChanged(targetId)) {
      return { ok: false, error: '目标会话在等待时已变化，消息未发送；草稿已保留' }
    }
    if (!expected && (!targetId || !runners?.agentOf(targetId)?.running)) {
      const r = await startAgent()
      if (!r.ok) return r
      targetId = runners?.activeRunnerId
      pin = targetId ? pinSendTarget(targetId) : null
    }
    if (sendOwnershipChanged(targetId)) {
      return { ok: false, error: '目标会话已不在或已切换，消息未发送；草稿已保留' }
    }
    const id = targetId
    if (id) {
      const guard = runners?.guardExecute(id)
      if (guard && !guard.ok) return guard
    }
    if (id && !mode && text.trim()) {
      const agent = runners?.agentOf(id)
      const state = typeof agent?.getState === 'function' ? agent.getState() : null
      if (agent && state && !state.isAgentRunning && (await getSettings()).checkpointsEnabled !== false) {
        if (sendOwnershipChanged(id)) {
          return { ok: false, error: '目标会话已不在或已切换，消息未发送；草稿已保留' }
        }
        void captureCheckpoint(agent.workingDirectory, state.conversationId ?? state.sessionId, text)
      }
    }
    if (sendOwnershipChanged(id)) {
      return { ok: false, error: '目标会话已不在或已切换，消息未发送；草稿已保留' }
    }
    return (id ? runners?.agentOf(id)?.send(text, images, mode) : undefined) ?? { ok: false, error: 'pi 未运行' }
  })

  handle('yan:steer', async (text: string) => ac()?.steer(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:followUp', async (text: string) => ac()?.followUp(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:steerQueued', async (queueId: string) => ac()?.steerQueued(queueId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:removeQueued', async (queueId: string) => ac()?.removeQueued(queueId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:queueEdit', async (next: QueueState) => ac()?.rewriteQueue(next) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:abort', async () => stopRunner(ac()))

  handle('yan:runBash', async (command: string, options?: { excludeFromContext?: boolean }, expectedInput?: unknown) => {
    if (typeof command !== 'string' || !command.trim() || (options !== undefined && (!options || typeof options !== 'object' || (options.excludeFromContext !== undefined && typeof options.excludeFromContext !== 'boolean')))) return { ok: false, error: '命令参数无效' }
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid') return { ok: false, error: '执行目标身份无效' }
    const id = expected ? resolveExpectedTarget(expected) ?? undefined : runners?.activeRunner()?.id
    if (expected && !id) return { ok: false, error: '目标会话已不在或已切换，命令未执行' }
    if (id) {
      const guard = runners?.guardExecute(id)
      if (guard && !guard.ok) return guard
    }
    return (id ? runners?.agentOf(id)?.runBash(command, options) : undefined) ?? { ok: false, error: 'pi 未运行' }
  })
  handle('yan:abortBash', async () => {
    await ac()?.abortBash()
  })

  handle('yan:setVisibleRunnerSessions', (sessions: unknown) => {
    runners?.noteVisibleActivity()
    return runnerVisibility.update(sessions)
  })
  registerSessionIpc(ipc, sessionHost)
  registerNativeSessionIpc(ipc, sessionHost, {
    confirm: (agent, prompt) => agent.confirmNativeOperation(prompt),
    win: () => win,
    runtime: async (agent, request) => {
      if (request.action === 'navigate') return agent.nativeNavigate(request.entryId!)
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
          if (request.modelIds!.some(id => !available.has(id))) return { ok: false, error: '所选模型已不可用，请刷新面板' }
          await agent.nativeSetScopedModels(request.modelIds!)
        } else {
          await agent.nativeSetProjectTrust(request.trusted!)
        }
        const runnerId = runners?.idOf(agent)
        const sessionFile = agent.getState()?.sessionFile
        if (!runnerId || !sessionFile || !existsSync(sessionFile)) return { ok: true, requiresReload: true }
        const restarted = await runners!.restartOne(runnerId)
        if (!restarted.ok) return { ok: false, error: `原生设置已保存，但应用失败：${restarted.error ?? '请重新打开会话'}` }
        const current = runners!.active()
        if (current) {
          const state = current.getState()
          if (state) push({ ch: 'state', payload: state })
          const currentId = runners!.idOf(current)
          const before = currentId ? runners!.runtimeOf(currentId) : null
          const payload = await current.getMessages()
          const after = currentId ? runners!.runtimeOf(currentId) : null
          if (!before || (after && sameRuntimeEnvelope(after, before))) push({ ch: 'sync', payload })
        }
        pushRunners()
        if (request.action === 'set-scoped-models' && current) {
          const applied = await current.nativeScopedModels()
          const keys = new Set(applied.scopedModels.map(item => item.key))
          const wanted = new Set(request.modelIds!)
          if (keys.size !== wanted.size || [...wanted].some(key => !keys.has(key))) return { ok: false, error: '用户级模型范围已保存，但当前项目的 pi 设置或启动范围覆盖了它；请检查项目 enabledModels' }
        }
        return { ok: true }
      }
      return { ok: false, error: '不支持的原生操作' }
    }
  })
  registerCheckpointIpc(ipc, sessionHost)
  setTimeout(() => void pruneCheckpoints().catch(() => undefined), 60_000).unref?.()

  const syncCompactionLines = async (models: LineModel[]): Promise<void> => {
    const cap = (await getSettings()).autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
    await syncNativeCompactionLines(models, cap).catch((e) => reportMainError('压缩线', e))
  }
  handle('yan:listModels', async () => {
    const models = (await ac()?.listModels()) ?? []
    void syncCompactionLines(models)
    return models
  })
  handle(
    'yan:setModel',
    async (provider: string, modelId: string) => ac()?.setModel(provider, modelId) ?? { ok: false, error: 'pi 未运行' }
  )
  handle('yan:setThinking', async (level: string) => ac()?.setThinking(level) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:listThinkingLevels', async () => ac()?.listThinkingLevels() ?? [])
  handle('yan:listCommands', async () => ac()?.listCommands() ?? localCommandDescriptors())

  handle(
    'yan:setAutoCompaction',
    async (enabled: boolean) => ac()?.setAutoCompaction(enabled) ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:setAutoRetry',
    async (enabled: boolean) => ac()?.setAutoRetry(enabled) ?? { ok: false, error: 'pi 未运行' }
  )

  registerWorkModeIpc(ipc, {
    registry: () => runners,
    workModes,
    pushFrom
  })

  registerQuestionFrequencyIpc(ipc, {
    registry: () => runners,
    workModes,
    workModeKeyFor,
    globalQuestionFrequency: async () => normalizeQuestionFrequency((await getSettings()).questionFrequency),
    pushFrom
  })


  handle(
    'yan:setSteeringMode',
    async (mode: string) => ac()?.setSteeringMode(mode) ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:setFollowUpMode',
    async (mode: string) => ac()?.setFollowUpMode(mode) ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:abortRetry',
    async () => ac()?.abortRetry() ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:cycleModel',
    async () => ac()?.cycleModel() ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:cycleModelBack',
    async () => ac()?.cycleModelBack() ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:cycleThinking',
    async () => ac()?.cycleThinking() ?? { ok: false, error: 'pi 未运行' }
  )
  handle('yan:lastAssistantText', async () => ac()?.lastAssistantText() ?? null)

  handle('yan:approvalAnswer', async (id: string, choice: unknown) => ({ ok: approvals.answer(String(id ?? ''), choice) }))
  handle('yan:approvalPending', async () => approvals.list())
  handle('yan:piInfo', async () => {
    const s = await getSettings()
    return piInfo(s.piBin)
  })

  handle('yan:redetectPi', async () => {
    const s = await getSettings()
    resetPiVersionCache()
    const info = await piInfo(s.piBin, { fresh: true })
    push({ ch: 'pi-info', payload: info })
    if (info.version && !ac()?.running) {
      await startAgent()
    }
    return info
  })

  handle('yan:getState', async () => ac()?.getState() ?? null)
  registerRunsIpc(ipc, {
    snapshot: () => runsHost?.snapshot() ?? { revision: 0, runs: [] },
    markSeen: (runId) => runsHost?.markSeen(runId) ?? { ok: false },
    stopSessionRun: async ({ sessionId }) => {
      const agent = runners?.agentForSession(sessionId) ?? null
      if (!agent) return { ok: false, error: '找不到这次运行对应的会话实例' }
      const cleared = await stopRunner(agent)
      return { ok: true, recovered: cleared }
    },
    stopSubagentRun: async (runId) => {
      const service = subagentService.current()
      if (!service) return { ok: false, error: '子 Agent 宿主未就绪' }
      const result = await service.stop(runId)
      return result.ok ? { ok: true } : { ok: false, ...(result.error ? { error: result.error } : {}) }
    }
  })
  handle('yan:agentStatus', async () =>
    ac()?.getConn() ?? { state: 'starting' as const, detail: '' }
  )
  handle('yan:getMessages', async () => ac()?.getMessages() ?? [])
  handle('yan:getStats', async () => ac()?.refreshStats() ?? null)

  syncController = registerSyncIpc(ipc, {
    dataDir: YAN_DIR,
    sessionsDir: SESSIONS_DIR,
    makeService: (root) => new SyncService({ dataDir: YAN_DIR, syncRoot: root, piAgentDir: PI_AGENT_DIR }),
    pickSyncFolder: async () => {
      if (!win) return null
      const r = await dialog.showOpenDialog(win, {
        title: '选择同步文件夹（建议放在 OneDrive / 坚果云 / Syncthing 管理的目录）',
        properties: ['openDirectory', 'createDirectory']
      })
      return r.canceled ? null : r.filePaths[0] ?? null
    },
    pickExportPath: async (suggested) => {
      if (!win) return null
      const r = await dialog.showSaveDialog(win, {
        title: '导出会话',
        defaultPath: join(app.getPath('documents'), suggested),
        filters: [{ name: '砚会话包', extensions: ['json'] }]
      })
      return r.canceled ? null : r.filePath ?? null
    },
    pickImportFile: async () => {
      if (!win) return null
      const r = await dialog.showOpenDialog(win, {
        title: '选择会话包',
        properties: ['openFile'],
        filters: [{ name: '砚会话包', extensions: ['json'] }]
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

  handle('yan:getSettings', async () => {
    const s = await getSettings()
    return { ...s, lang: s.lang, theme: s.theme }
  })
  handle('yan:patchSettings', async (rawPatch: unknown) => {
    const patch = validateRendererSettingsPatch(rawPatch)
    const before = await getSettings()
    if ('cwd' in patch) {
      const checked = await validateCwd(patch.cwd)
      if (!checked.ok) throw new Error(checked.error)
      patch.cwd = checked.cwd
    }
    if ('projects' in patch) {
      if (!Array.isArray(patch.projects)) throw new Error('项目列表格式无效')
      const ids = new Set<string>()
      for (const project of patch.projects) {
        if (!isObject(project) || typeof project.id !== 'string' || !project.id || typeof project.cwd !== 'string' || !isAbsolute(project.cwd) || ids.has(project.id)) throw new Error('项目标识或目录格式无效')
        ids.add(project.id)
        const previous = before.projects.find((item) => item.id === project.id)
        if (previous && normalizeCwdForIdentity(previous.cwd) !== normalizeCwdForIdentity(project.cwd)) throw new Error('不能将已有项目标识重新绑定到其他目录')
        if (!previous) {
          const checked = await validateCwd(project.cwd)
          if (!checked.ok) throw new Error(checked.error)
          project.cwd = checked.cwd
        }
      }
    }
    let next: Awaited<ReturnType<typeof patchSettings>>
    try {
      next = await updateSettings((current) => {
        for (const project of patch.projects ?? []) {
          const previous = current.projects.find((item) => item.id === project.id)
          if (previous && normalizeCwdForIdentity(previous.cwd) !== normalizeCwdForIdentity(project.cwd)) {
            throw new Error('项目文件夹已变化，请刷新后重试')
          }
        }
        return patch as never
      })
    } catch (e) {
      reportMainError('设置', e)
      return await getSettings()
    }
    if (typeof patch.lang === 'string' && patch.lang !== before.lang) {
      trayLanguage = next.lang
      refreshTrayMenu()
      push({
        ch: 'log',
        payload: {
          text: `[语言] 已切换为 ${next.lang}；下一轮开始，推理与回复都跟随新语言（不重建实例、不中断会话）。`
        }
      })
    }
    if (patch.responseDetail !== undefined) agentResponseDetail = next.responseDetail
    if ('autoCompactTokens' in patch) void ac()?.listModels().then(syncCompactionLines)
    if ('keepAwakeWhileWorking' in patch || 'keepAwakeOnBattery' in patch) void syncKeepAwake((runners?.statuses() ?? []).some((r) => r.running))
    if (patch.defaultWorkMode !== undefined) setDefaultWorkMode(next.defaultWorkMode)
    return next
  })

  ipcMain.on('yan:respondUi', (event, res) => {
    if (!isTrustedIpc(event) || !isObject(res) || typeof res.id !== 'string' || !res.id) return
    if (runners) runners.respondUi(res as never)
    else ac()?.respondUi(res as never)
  })

  handle('yan:extendUi', async (id: string, extraMs?: number) =>
    runners?.extendHostUi(String(id ?? ''), extraMs) ?? { ok: false, error: 'pi 未运行' }
  )

  handle('yan:startUiTimer', async (id: string) =>
    runners?.startHostUiTimer(String(id ?? '')) ?? { ok: false, error: 'pi 未运行' }
  )

  ipcMain.on('yan:hotkey-guard', (event, v) => {
    if (!isTrustedIpc(event) || typeof v !== 'boolean') return
    hotkeyGuardPaused = v
  })

  ipcMain.on('yan:motion-preference', (event, reduced) => {
    if (!isTrustedIpc(event) || typeof reduced !== 'boolean') return
    trayMotionAllowed = !reduced
    refreshTaskbar()
  })

  handle('yan:notifyAttention', async (n: AttentionNotify) => {
    const kind = n?.kind ?? 'done'
    const title = typeof n?.title === 'string' && n.title.trim() ? n.title : '砚'
    const body = typeof n?.body === 'string' && n.body.trim() ? n.body : undefined

    if (process.env.YAN_PROBE) {
      push({ ch: 'log', payload: { text: `[通知] ${kind} | ${title} | ${body ?? ''}` } })
      return { shown: true, simulated: true }
    }

    if (!Notification.isSupported()) return { shown: false, error: '系统不支持通知' }
    try {
      const notification = new Notification({ title, body, silent: true })
      notification.on('click', () => {
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      notification.show()
      return { shown: true }
    } catch (error) {
      return { shown: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.on('yan:renderer-ready', (event) => {
    if (!isTrustedIpc(event)) return
    hotkeyGuardPaused = false
    const rid = runners?.activeRunnerId
    const c = ac()?.getConn()
    if (c) push({ ch: 'proc', payload: { state: c.state, detail: c.detail } })
    const st = ac()?.getState()
    if (st) {
      if (rid) pushFrom(rid, { ch: 'state', payload: st })
      else push({ ch: 'state', payload: st })
    }
    void ac()?.refreshStats()
    void ac()?.refreshTodos()
    if (browser) push({ ch: 'browser-state', payload: browser.getState() })
    pushRunners()
  })

  handle('yan:probePi', async () => {
    const settings = await getSettings()
    const probe = resolvePi({ override: settings.piBin })
    return probe
  })

  handle('yan:openPath', async (p: string) => {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'empty path' }
    if (/^[\\/]{2}/.test(p.trim())) return { ok: false, error: 'network path' }
    if (!existsSync(p)) return { ok: false, error: 'missing' }
    const err = await shell.openPath(existsSync(dirname(p)) ? dirname(p) : p)
    return err ? { ok: false, error: err } : { ok: true }
  })

  handle('yan:openFileDefault', async (p: string, cwd?: string) => {
    const raw = String(p ?? '').trim()
    if (!raw) return { ok: false, error: 'empty path' }
    if (/^[\\/]{2}/.test(raw)) return { ok: false, error: 'network path' }
    const base = typeof cwd === 'string' && cwd.trim() ? cwd : (await getSettings()).cwd
    const target = isAbsolute(raw) ? raw : resolve(base || process.cwd(), raw)
    let st
    try {
      st = await stat(target)
    } catch {
      return { ok: false, error: 'missing' }
    }
    if (!st.isFile()) {
      const err = await shell.openPath(target)
      return err ? { ok: false, error: err } : { ok: true }
    }
    let real = target
    try { real = await realpath(target) } catch { }
    if (!canOpenDocument(target) || !canOpenDocument(real)) {
      shell.showItemInFolder(target)
      return { ok: true, revealed: true }
    }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

  registerWorkspaceDataIpc(ipc, () => win)

  handle('yan:storage:info', async () => {
    const info = storageInfo()
    return { ...info, bytes: await storageSize(info.realDir) }
  })
  handle('yan:storage:pick', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: '选择新的数据位置（建议非系统盘上的空文件夹）', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  handle('yan:storage:schedule', async (target: string, relaunch?: boolean) => {
    const r = await scheduleStorageMove(String(target ?? ''))
    if (r.ok && relaunch) {
      app.relaunch()
      app.quit()
    }
    return r
  })
  handle('yan:storage:cancel', async () => {
    cancelStorageMove()
  })

  handle('yan:revealPath', async (p: string) => {
    if (!p || !existsSync(p)) return { ok: false }
    shell.showItemInFolder(p)
    return { ok: true }
  })

  handle('yan:pickImages', async (): Promise<Attachment[]> => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (r.canceled) return []

    const out: Attachment[] = []
    for (const file of r.filePaths) {
      try {
        const buf = await readFile(file)
        if (buf.byteLength > 12 * 1024 * 1024) continue
        const ext = extname(file).slice(1).toLowerCase()
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`
        const data = buf.toString('base64')
        out.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: basename(file),
          mimeType,
          size: buf.byteLength,
          data,
          preview: data
        })
      } catch (e) {
        console.error('[yan] 读图失败：', file, e)
      }
    }
    return out
  })

  handle('yan:pickFiles', async (): Promise<string[]> => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  handle('yan:pickCwd', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择工作目录'
    })
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })

  handle('yan:setCwd', async (cwd: string) => {
    const cwdResult = await validateCwd(cwd)
    if (!cwdResult.ok) return cwdResult
    await patchSettings({ cwd: cwdResult.cwd })
    if (starting) await starting
    return { ok: true, cwd: cwdResult.cwd }
  })

  ipcMain.on('win:minimize', (event) => { if (isTrustedIpc(event)) win?.minimize() })
  ipcMain.on('win:maximize', (event) => {
    if (!isTrustedIpc(event) || !win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', (event) => { if (isTrustedIpc(event)) win?.close() })
  rawHandle('win:requestExit', async () => requestExit())
  rawHandle('win:lifecycle', () => ({
    tray: attention?.hasTray() ?? false,
    visible: !!win && !win.isDestroyed() && win.isVisible(),
    quitting: isQuitting
  }))

  rawHandle('win:setAlwaysOnTop', async (_e, v: boolean) => {
    const on = !!v
    win?.setAlwaysOnTop(on)
    await patchSettings({ alwaysOnTop: on })
    pushWinState()
    return on
  })

  rawHandle('yan:getZoom', async () => zoomState(win, peekUiScale()))

  rawHandle('yan:setUiScale', async (_e, v: unknown) => setUiScale(v))


  registerWorkspaceIpc(ipc)



  registerScheduleIpc(ipc, scheduleService)
  void scheduleService.start().catch((e) => reportMainError('定时任务', e))
  registerSubagentsIpc(ipc, {
    service: subagentService,
    parentContext: async (owner) => {
      const captured = captureDefaultParent()
      const settings = await getSettings()
      return resolveSubagentParentContext(owner, captured, settings)
    }
  })

  registerGitIpc(ipc, {
    isCwdBusy: (dir: string) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, dir)),
    worktreeOrigins,
    authorizeReadCwd: async (cwd: string) => {
      const st = await getSettings()
      const resolved = await resolveFileContext(st, st.cwd, { cwd })
      return resolved.ok
        ? { ok: true as const, cwd: resolved.context.cwd }
        : { ok: false as const, error: resolved.error }
    }
  })

  const reviewService = new ReviewService({
    authorize: async (cwd: string) => {
      const st = await getSettings()
      const resolved = await resolveFileContext(st, st.cwd, { cwd })
      return resolved.ok
        ? { ok: true as const, cwd: resolved.context.cwd }
        : { ok: false as const, error: resolved.error }
    },
    annotations: new ReviewAnnotationStore(),
    verifySession: async ({ sessionId, cwd }) => {
      const agent = runners?.agentForSession(sessionId)
      const state = agent?.getState()
      const sessionKey = state?.conversationId ?? state?.sessionId
      if (!agent || !state || !sessionKey || !state.sessionFile) {
        return { ok: false as const, error: '会话不属于当前运行实例' }
      }
      const norm = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
      if (!cwd || norm(agent.workingDirectory) !== norm(cwd)) {
        return { ok: false as const, error: '会话与请求的目录不一致' }
      }
      return {
        ok: true as const,
        ownership: { sessionId, sessionKey, cwd: agent.workingDirectory, sessionPath: state.sessionFile }
      }
    },
    git: new ReviewGitAdapter({
      confirm: {
        confirm: async (request) => {
          const answer = await approvals.ask({
            kind: 'danger',
            tool: request.action === 'push' ? 'git push' : 'gh pr create',
            title: request.action === 'push' ? '推送代码到远端' : '创建 Pull Request',
            detail: request.summary,
            reasons: [request.summary],
            cwd: request.cwd,
            canRemember: false
          })
          return answer === 'once' || answer === 'remember'
        }
      }
    }),
    agent: new ReviewAgentCoordinator({
      assignCode: async (scopeId) => {
        if (!runsHost) throw new Error('运行注册表尚未就绪，R 编号暂不可用')
        return runsHost.assignCode(scopeId, 'review')
      },
      port: {
        async startReview(input) {
          const controller = await subagentService.get()
          controller.setContext({
            cwd: input.cwd,
            ...(input.sessionId ? { parentSessionId: input.sessionId } : {}),
            ...(input.projectId ? { projectId: input.projectId } : {})
          })
          const result = await controller.start(input.prompt, input.model, 'controlled-cwd')
          if (!result.ok || !result.run) return { ok: false, error: result.error ?? '评审运行启动失败' }
          const model = reviewRunModel(result.run.model, result.run.thinkingLevel)
          reviewRuns?.begin({
            runId: result.run.id,
            code: input.code,
            ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
            ...(input.projectId ? { projectId: input.projectId } : {}),
            title: `代码评审 ${input.code}`,
            ...(model ? { model } : {})
          })
          return { ok: true, runId: result.run.id }
        }
      }
    })
  })
  registerReviewIpc(ipc, { service: reviewService })

  registerPackagesIpc(ipc, { hasBusyCwd: (cwd: string) => runners?.hasBusyCwd(cwd) === true })
  registerSourcesIpc(ipc, { webSearchAvailability: async () => ac()?.webSearchAvailability() })

  registerCapabilitiesIpc(ipc, {
    currentAgent: () => ac() ?? undefined,
    registry: () => runners,
    thinExtensionPaths: yanThinExtensionPaths,
    settings: () => getSettings(),
    isProjectTrusted: async (cwd) => (await trustStatus(cwd)).trusted
  })

  registerMcpAppIpc(ipc, {
    currentAgent: () => ac() ?? undefined,
    registry: () => runners,
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


  registerKnowledgeIpc(ipc, { currentCwd: () => ac()?.getState()?.cwd, knowledgeProjectId, window: () => win })

  registerBrowserIpc(ipc, () => browser)

  registerPeerIpc(ipc, peerClient, async () => (await getSettings()).projects)

  registerPeerHostIpc(ipc, { grants: peerGrants })

  registerConsentIpc(ipc)

  registerOfficeIpc(ipc, async (requestedCwd) => {
    const settings = await getSettings()
    const resolved = await resolveFileContext(settings, settings.cwd, { cwd: requestedCwd ?? settings.cwd })
    if (!resolved.ok) throw new Error(resolved.error)
    return resolved.context.cwd
  })

  registerAppUpdate(ipc, () => (runners?.statuses() ?? []).some((status) => status.running))
  registerVoiceIpc(ipc, {
    service: new VoiceService(async () => (await getSettings()).voiceInput),
    window: () => win,
    settings: async () => (await getSettings()).voiceInput,
    saveSettings: async (voiceInput) => {
      await patchSettings({ voiceInput })
    }
  })

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

function createWindow(): void {
  const [winW, winH] = (process.env.YAN_WIN ?? '')
    .split("x")
    .map((x) => Number(x))
  const useW = Number.isFinite(winW) && winW > 0 ? winW : 1440
  const useH = Number.isFinite(winH) && winH > 0 ? winH : 900

  win = new BrowserWindow({
    icon: shellIconPath(),
    width: useW,
    height: useH,
    minWidth: 600,
    minHeight: 600,
    show: false,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#151515',
    webPreferences: {
      preload: join(__dirname_, '../preload/index.cjs'),
      additionalArguments: [
        ...(process.env.YAN_PROBE && !app.isPackaged ? ['--yan-isolated-probe'] : [])
      ],
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })
  guardHtmlArtifactFrames(win.webContents)

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
    if (s.theme === 'light') win.setBackgroundColor('#fcfcfa')
    if (s.alwaysOnTop) {
      win.setAlwaysOnTop(true)
      pushWinState()
    }
    applyZoom(win, s.uiScale)
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

    const shotPath = process.env.YAN_PROBE_SHOT
    if (process.env.YAN_PROBE && shotPath) {
      const parsedShotDelay = Number(process.env.YAN_PROBE_SHOT_DELAY ?? 20_000)
      const shotDelay = Number.isFinite(parsedShotDelay) && parsedShotDelay >= 0 ? parsedShotDelay : 20_000
      const shotLog = (m: string): void => {
        void appendFile(`${shotPath}.log`, `${new Date().toISOString()} ${m}\n`).catch(() => {})
      }
      shotLog(`armed delay=${shotDelay} path=${shotPath}`)
      let shotIndex = 0
      const shoot = (): void => {
        if (!win || win.isDestroyed()) return
        if (!win.isVisible()) win.showInactive()
        const target = shotPath.replace(/\.png$/i, `-${++shotIndex}.png`)
        void win.webContents
          .capturePage()
          .then((img) => writeFile(target, img.toPNG()))
          .then(() => shotLog(`saved ${target}`))
          .catch((e) => shotLog(`failed: ${e?.message ?? String(e)}`))
      }
      setTimeout(() => {
        shotLog('burst start')
        shoot()
        const timer = setInterval(() => {
          if (!win || win.isDestroyed()) {
            clearInterval(timer)
            shotLog('burst stop')
            return
          }
          shoot()
        }, Number(process.env.YAN_PROBE_SHOT_INTERVAL ?? 2000))
      }, shotDelay)
    }
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
    console.error('[renderer gone]', details.reason)
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

  const probeFile = process.env.YAN_PROBE
  if (probeFile) {
    const delay = Number(process.env.YAN_PROBE_DELAY ?? 9000)
    win.once('ready-to-show', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const { readFile, writeFile } = await import('node:fs/promises')
            const src = await readFile(probeFile, 'utf8')
            const helper = await readFile(join(dirname(probeFile), 'workspace-helper.js'), 'utf8').catch(() => '')
            if (helper) await win!.webContents.executeJavaScript(helper)
            const mouse = process.env.YAN_PROBE_MOUSE
            if (mouse) {
              const [mx, my] = mouse.split(',').map(Number)
              win!.webContents.sendInputEvent({ type: 'mouseMove', x: mx, y: my })
              await new Promise((r) => setTimeout(r, 700))
            }

            const keys = process.env.YAN_PROBE_KEYS
            let keyTask: Promise<void> | null = null
            if (keys) {
              keyTask = (async () => {
                const delay = Number(process.env.YAN_PROBE_KEYS_DELAY) || 1800
                await new Promise((r) => setTimeout(r, delay))
                for (const combo of keys.split(',').map((s) => s.trim()).filter(Boolean)) {
                  const parts = combo.toLowerCase().split('+')
                  const key = parts.pop() ?? ''
                  const mods = new Set(parts)

                  const keyCode =
                    key === 'tab' ? 'Tab' : key.length === 1 ? key.toUpperCase() : key
                  const modifiers: Electron.InputEvent['modifiers'] = []
                  if (mods.has('ctrl')) modifiers.push('control')
                  if (mods.has('shift')) modifiers.push('shift')
                  if (mods.has('alt')) modifiers.push('alt')
                  if (mods.has('meta')) modifiers.push('meta')

                  win!.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
                  win!.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
                  await new Promise((r) => setTimeout(r, 1600))
                }
              })()
            }

            const result = await win!.webContents.executeJavaScript(src, true)
            if (keyTask) await keyTask.catch(() => undefined)
            const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            console.log('---PROBE-START---')
            console.log(body)
            console.log('---PROBE-END---')
            if (process.env.YAN_PROBE_OUT) {
              await writeFile(
                process.env.YAN_PROBE_OUT,
                `${body}\n`,
                'utf8'
              ).catch(() => undefined)
            }
          } catch (e) {
            console.error('[probe] 失败', e)
          }
          await shutdown()
          app.exit(0)
        })()
      }, delay)
    })
  }

  const shot = process.env.YAN_SHOT
  if (shot) {
    const delay = Number(process.env.YAN_SHOT_DELAY ?? 6000)
    const shotW = Number(process.env.YAN_SHOT_W ?? 0)
    const shotH = Number(process.env.YAN_SHOT_H ?? 0)
    if (shotW && shotH) win.setContentSize(shotW, shotH)
    win.once('ready-to-show', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const setup = process.env.YAN_SHOT_SETUP
            if (setup) {
              const { readFile } = await import('node:fs/promises')
              const src = await readFile(setup, 'utf8')
              await win!.webContents.executeJavaScript(src, true)
              await new Promise((r) => setTimeout(r, 2500))
            }

            const img = await win!.webContents.capturePage()
            const { writeFile, mkdir } = await import('node:fs/promises')
            const { dirname, resolve } = await import('node:path')
            const out = resolve(shot)
            await mkdir(dirname(out), { recursive: true })
            await writeFile(out, img.toPNG())
            console.log(`[shot] ${out}`)
          } catch (e) {
            console.error('[shot] 失败', e)
          }
          await shutdown()
          app.exit(0)
        })()
      }, delay)
    })
  }
}

configureWorkModeCoordinator({
  runners: () => runners,
  workModes,
  pushFrom
})

const sessionHost: SessionHost = {
  runners: () => runners,
  ac,
  sessionChains,
  push,
  pushRunners,
  pushRunnerSnapshot,
  validateCwd,
  startAgent,
  rememberRunnerSession,
  readHistoryWithArtifacts,
  projectIdForCwd
}

configureRemoteHost({
  ...sessionHost,
  approvals,
  win: () => win,
  remoteAccess: () => remoteAccess
})

app.whenReady().then(async () => {
  try { releaseDesktopDataRoot = await lockDataRoot(YAN_DIR) } catch (error) { reportMainError('data-root-writer', error); app.exit(1); return }
  registerDeepLinkProtocol(app, { isPackaged: app.isPackaged, execPath: process.execPath, appPath: process.argv[1] })
  registerHtmlArtifactProtocol()
  void loadModelPricing()
  watchPowerSource()
  browser = new BrowserController(() => win, push)
  setTerminalSink((event) => {
    if (event.kind === 'exit') {
      blockedTerminalNotices.delete(event.id)
    }
    if (event.kind === 'status') {
      notifyBlockedTerminal(event.id, event.status)
      refreshTaskbar()
    }
    if (paneTerminal?.forward(event) && event.kind === 'data') return
    push({
      ch: 'terminal',
      payload:
        event.kind === 'data'
          ? { id: event.id, kind: 'data', data: event.data, seq: event.seq }
          : event.kind === 'exit'
            ? { id: event.id, kind: 'exit', exitCode: event.exitCode }
            : { id: event.id, kind: 'status', status: event.status }
    })
  })
  registerIpc()
  trayLanguage = (await getSettings()).lang
  ensureTrayAssets()
  attention?.ensureTray()
  createWindow()

  auxWindows = createAuxWindows({
    preloadPath: () => join(__dirname_, '../preload/index.cjs'),
    loadEntry: (target, entry) => {
      const page = entry === 'quick-ask' ? 'quick-ask' : 'mini'
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
    attentionSummary: () => attention?.summary() ?? summarizeAttention([]),
    submitQuickAsk: (payload) =>
      submitQuickAsk(
        {
          activeRunId: () => runners?.activeRunnerId ?? null,
          agentOf: (runId) => runners?.agentOf(runId) ?? null,
          start: () => sessionHost.startAgent(),
          createSession: async ({ projectId }) => {
            const settings = await getSettings()
            const cwdResult = await sessionHost.validateCwd(settings.cwd)
            if (!cwdResult.ok) return { ok: false, error: cwdResult.error }
            if (!runners) {
              const started = await sessionHost.startAgent()
              if (!started.ok) return { ok: false, error: started.error }
            }
            const registry = runners
            if (!registry) return { ok: false, error: 'pi 未运行' }
            const scope = projectId ? 'project' : 'global'
            const res = await registry.select({ cwd: cwdResult.cwd, projectId, scope })
            await sessionHost.rememberRunnerSession(res, {
              cwd: cwdResult.cwd,
              ...(projectId ? { projectId } : {}),
              scope
            })
            if (res.ok && res.id) void sessionHost.pushRunnerSnapshot(res.id)
            sessionHost.pushRunners()
            return res.ok && res.id ? { ok: true, id: res.id } : { ok: false, error: res.error }
          },
          applyModel: async (runId, model) =>
            (await runners?.agentOf(runId)?.setModel(model.provider, model.id)) ?? { ok: false, error: 'pi 未运行' }
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
    shortcut: () => 'Alt+Shift+Space',
    miniEnabled: () => process.env.YAN_AUX_MINI === '1'
  })
  registerAuxIpc(auxWindows)
  auxWindows.registerShortcut()
  if (process.env.YAN_AUX_MINI === '1') auxWindows.showMini()

  const browserTransfer = createPaneBrowserTransfer({
    beginHostTransfer: (request) =>
      browser?.beginHostTransfer(request) ?? { ok: false, code: 'not-found', message: '浏览器未初始化' },
    endHostTransfer: (tabId, ownerKey) => browser?.endHostTransfer(tabId, ownerKey) ?? false
  })
  paneBrowserTransfer = browserTransfer

  paneTerminal = createPaneTerminalTransfer(
    {
      preloadPath: () => join(__dirname_, '../preload/index.cjs'),
      loadEntry: (target) => {
        if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}/auxwin/pane.html`)
        else void target.loadFile(join(__dirname_, '../renderer/auxwin/pane.html'))
      },
      anchorBounds: () => (win && !win.isDestroyed() ? win.getBounds() : undefined),
      workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
      zoomFactor: () => zoomState(win, peekUiScale()).effective,
      locale: () => (trayLanguage === 'en-US' ? 'en-US' : 'zh-CN'),
      read: (terminalId) => {
        const snapshot = readTerminal(terminalId)
        return snapshot ? toPaneTerminalSnapshot(snapshot) : null
      },
      write: (terminalId, data) => writeTerminal(terminalId, data),
      resize: (terminalId, cols, rows) => resizeTerminal(terminalId, cols, rows),
      authorize: (owner) => owner.active === true && owner.key.length > 0
    },
    {
      onLeaseChange: (event) => {
        if (win && !win.isDestroyed()) win.webContents.send('yan:pane-terminal:lease', event)
      }
    }
  )

  panePopout = createPanePopoutController(
    {
      preloadPath: () => join(__dirname_, '../preload/index.cjs'),
      loadEntry: (target) => {
        if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}/auxwin/pane.html`)
        else void target.loadFile(join(__dirname_, '../renderer/auxwin/pane.html'))
      },
      anchorBounds: () => (win && !win.isDestroyed() ? win.getBounds() : undefined),
      workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
      zoomFactor: () => zoomState(win, peekUiScale()).effective,
      locale: () => (trayLanguage === 'en-US' ? 'en-US' : 'zh-CN')
    },
    {
      onAction: (event) => {
        if (win && !win.isDestroyed()) win.webContents.send('yan:pane-popout:action-event', event)
      },
      browserTransfer,
      terminalTransfer: paneTerminal
    }
  )
  registerPanePopoutIpc(panePopout, {
    isMainWindow: (contents) => !!win && !win.isDestroyed() && win.webContents === contents
  })
  registerPaneBrowserIpc({ controller: panePopout, transfer: browserTransfer })
  registerPaneTerminalIpc(paneTerminal, {
    isMainWindow: (contents) => !!win && !win.isDestroyed() && win.webContents === contents
  })

  void syncController?.runStartupSync()
  win?.webContents.once('did-finish-load', () => {
    deepLinkRouter.flush()
    deepLinkRouter.handleArgv(process.argv)
  })

  try {
    runsHost = await createRunsHost({ push })
    reviewRuns = createReviewRunProducer({ registry: runsHost.reviewRunPort() })
  } catch (error) {
    runsHost = null
    reviewRuns = null
    reportMainError('runs-host', error)
    push({
      ch: 'log',
      payload: {
        text: `[runs] 运行注册表初始化失败，运行总览不可用：${error instanceof Error ? error.message : String(error)}`,
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
      ask: (request) => approvals.ask(request),
      audit: new McpAppViewAuditStore(),
      serverConfigOf: (serverId) => loadMcpServers().servers.find((server) => server.id === serverId) ?? null,
      permissionMode: async () => (await getSettings()).permissionMode ?? 'danger',
      theme: async () => (await getSettings()).theme,
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
      grantsOf: () => [],
      fetchResource: createMcpAppResourceLoader(mcpAppHost())
    })
    registerMcpAppProtocol(mcpAppViewService.resourceStore())
  } catch (error) {
    mcpAppViewService = null
    reportMainError('mcp-app-view', error)
  }

  await migrateLegacyPlaybooks().catch((error) => console.error('[yan] 办事模板导出失败：', error))

  const started = await startAgent()

  await startRemoteServer()

  const initialControl = decodeControlCommand(process.argv)
  if (initialControl) void dispatchControlCommand(initialControl)

  const prompt = process.env.YAN_PROMPT
  if (prompt && started.ok) {
    let fired = false
    const fire = (): void => {
      if (fired) return
      fired = true
      void ac()?.send(prompt).then((r) => {
        if (!r.ok) console.error('[yan] 自动发送失败：', r.error)
      })
    }
    win?.webContents.once('did-finish-load', () => setTimeout(fire, 600))
    setTimeout(fire, 3000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (!ac()?.running) void startAgent()
  })
})

app.on('window-all-closed', () => {
  void shutdown().then(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})

app.on('before-quit', (e) => {
  if (shuttingDown) return
  e.preventDefault()
  void shutdown().then(() => app.quit())
})
