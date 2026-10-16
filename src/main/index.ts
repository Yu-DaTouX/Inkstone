import { AGENT_CONTEXT_ERROR, isAgentContextExtension, nativePiToolsSupported } from '../shared/agent-context'
/**
 * 主进程入口：窗口 + IPC + AgentController 的生命周期。
 *
 * 一个窗口可以承载多个按 cwd/session 隔离的 AgentController；
 * 会话切换优先复用已有实例或空闲实例，不停止仍在工作的后台会话。
 */
/* 数据目录迁移必须先于一切文件访问（见 storage-move.ts） */
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
/* MCP App 资源协议：import 即早注册 `inkstone-app:` scheme（协议处理器等 A6 接线）。 */
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
import { setContextPolicySettings, syncEffectivePolicyFile } from './context-policy'
import { resolvePi, piInfo, resetPiVersionCache } from './protocol'
import { applyZoom, clampScale, peekUiScale, stepScale, zoomState } from './zoom'
import { BrowserController } from './browser'
import { openableExternalUrl } from './external-url'
import { disposeTerminals, hasBlockedTerminal, hasWorkingTerminal, readTerminal, resizeTerminal, setTerminalSink, writeTerminal } from './terminal'
import { createIpcRegistrar } from './ipc/registrar'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { AgentHubService } from './agent-hub/service'
import { registerAgentHubIpc } from './ipc/agent-hub-ipc'
import { registerRemoteIpc } from './ipc/remote-ipc'
import { registerOfficeIpc } from './ipc/office-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerLibraryIpc } from './ipc/library-ipc'
import { registerSourcesIpc } from './ipc/sources-ipc'
import { registerKnowledgeIpc } from './ipc/knowledge-ipc'
import { registerTaskInboxIpc } from './ipc/task-inbox-ipc'
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
import { registerActivityModelIpc } from './ipc/activity-model-ipc'
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
import { registerGoalIpc } from './ipc/goal-ipc'
import { registerQuestionFrequencyIpc } from './ipc/question-frequency-ipc'
import { registerSpaceIpc } from './ipc/space-ipc'
import { registerFilesIpc } from './ipc/files-ipc'
import { isAuthorizedFileCwd, isRunnerProjectCwd } from './file-context'
import { canOpenDocument } from '../shared/document-open'
import { normalizeQuestionFrequency } from '../shared/question-frequency'
import { registerAgentServiceIpc, closeAgentService } from './ipc/agent-service-ipc'
import { lockDataRoot } from '../core/data-root-lock'
import { sameRuntimeEnvelope } from '../core/run-state'
import { registerContextBudgetIpc } from './ipc/context-budget-ipc'
import { registerPeerHostIpc } from './ipc/peer-host-ipc'
import { registerConsentIpc } from './ipc/consent-ipc'
import { SubagentService } from './subagent-service'
import { createSubagentNotifier } from './subagent-notify'
import { configureGoalCoordinator, setDefaultWorkMode, defaultWorkMode, workModeKeyFor, resolveWorkMode, pushWorkMode, resolveAgentProfile, pushAgentProfile, refreshSessionContext, pushGoal, applyGoalResume, cancelGoalResume, consumeRepeatBlocks, goals, maybeArmGoalContinue } from './goal-coordinator'
import { configureRemoteHost, remoteSnapshot, remoteHistory, remoteModels, executeRemoteCommand, remoteQuestions, remoteAnswer, remoteHumanApproval, remoteArtifact, remoteMessageImage, peerClient, peerGrants, peerHostHandlers } from './remote-host'
import { configureHandoffCoordinator, handoffRunner, publishHandoffReplacement, handoffPending, handoffIdentities, hasHandoffOperation, abandonHandoff } from './handoff-coordinator'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerAppUpdate } from './app-update'
import { VoiceService } from './voice/voice-service'
import { registerPeerIpc } from './ipc/peer-ipc'
import type { ConsentDecision } from '../shared/tool-consent'
import { RemoteAccess } from './remote-access'
import { HandoffStore } from './handoff-service'
import { HandoffDiagnostics } from './handoff-diagnostics'
import { HandoffTransactionStore } from './handoff-transaction-service'
import { SessionChainStore } from './session-chain-service'
import { WorktreeLinkStore } from './worktree-links'
import { AutoIsolationStore, isolateCwdForConflict, isolationCwdKey, syncIsolationBack } from './session-isolation'
import { type HandoffSessionHandle, type HandoffSessionTarget } from './handoff-runner'
import { normalizeChainKey } from '../shared/session-chain'
import { createSessionWorkScheduler } from './session-work-scheduler'
import { emptyGoal } from '../shared/goal'
import { localCommandDescriptors } from './command-registry'
import { writeExitSnapshot } from './exit-snapshot'
import { installStdioGuard } from './stdio-guard'
import { decodeControlCommand, writeControlResponse, type ControlCommand, type ControlResponse } from './control-protocol'
import { DOWNLOADS_DIR, ELECTRON_CRASH_DUMPS_DIR, ELECTRON_USER_DATA_DIR, PI_AGENT_DIR, YAN_DIR } from './paths'
import { migrateLegacyPlaybooks, userSkillPaths } from './user-skills'
import { extensionDiagnostics } from './extensions-inventory'
import { projectIdForCwd as deriveProjectId } from './project-id'
import { WorkModeStore, normalizeSessionFileKey } from './work-mode-service'
import { ApprovalBroker } from './approval-broker'
import { refreshManagedGit } from './git-runtime'
import { registerGitRuntimeIpc } from './ipc/git-runtime-ipc'
import { AgentProfileStore } from './agent-profile-store'
import { SpaceStore } from './space-store'
import { LibraryService } from './library-service'
import { ContextAssembler } from './context-assembler'
import type { Attachment, AttentionNotify, CompactionRun, FileRequestContext, MainPush, QueueSnapshot, QueueState, RunnerStatus, RuntimeEnvelope, SessionState, TerminalProgramStatus } from '../shared/ipc'
import { toPaneTerminalSnapshot } from '../shared/pane-terminal'

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

/*
 * Electron 的开发/验收进程经常由 npm / IDE / agent 的 bash 会话通过 pipe 启动。
 * 启动器退出、重启或关闭终端后，Node 的 stdout/stderr 仍可能收到 console.error；
 * Windows 会把这次写入报成 EPIPE。
 *
 * ⚠️ 这里**不能**在监听里 throw：从 `'error'` 监听抛出来会变成 uncaughtException，
 * 而 Electron 主进程的默认处理是弹一个**模态**框（标题「Error」）—— 弹框挡住
 * 事件循环之后，app.exit() 永远不会执行，父进程（spawnSync）于是等一辈子。
 * 2026-09-16 实测过这条链路（脚本侧同类问题见 `scripts/lib/stdio-guard.mjs`），
 * 所以非 EPIPE 只**上报**，不抛（详见 `main/stdio-guard.ts`）。
 */
installStdioGuard(
  { stdout: process.stdout, stderr: process.stderr },
  { onError: (stream, error) => reportMainError(`stdio/${stream}`, error) }
)

/*
 * 主进程未捕获异常 → UI 日志，而不是原生错误弹框。
 *
 * Electron 默认会为 uncaughtException 弹「A JavaScript error occurred in
 * the main process」，它是模态式打断，关掉就再也看不到内容。这里注册
 * 处理器把信息推进右栏日志抽屉（与 pi 的 stderr 同一条），保留可回看性。
 *
 * 注意：function 声明会提升，所以这里引用后面定义的 push 是安全的；
 * 窗口还没建好时 push 会自己丢弃。
 */
function reportMainError(kind: string, error: unknown): void {
  const detail =
    error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
      : String(error)
  const text = `[主进程/${kind}] ${detail}`
  try {
    push({ ch: 'log', payload: { text, level: 'error' } })
  } catch {
    /* 窗口/管道已死，不能因为记录日志再抛一次 */
  }
  try {
    console.error(text)
  } catch {
    /* EPIPE 已在上面吞掉；这里只是双重保险 */
  }
}

process.on('uncaughtException', (error) => reportMainError('uncaughtException', error))
process.on('unhandledRejection', (reason) => reportMainError('unhandledRejection', reason))

/*
 * 测试隔离：YAN_USER_DATA 指向临时目录时，把 Electron 的 userData
 * （localStorage / sessionData / cache）也搬过去。
 *
 * 为什么需要：右栏分区顺序、主题、语言都存在 localStorage 里。
 * 验收测试会改这些 —— 共用一个 userData 就会把用户的设置改掉
 * （已经踩过一次：测试把右栏顺序弄成了 status 开头）。
 *
 * ⚠️ 必须在 requestSingleInstanceLock **之前**设置：单实例锁是按
 *    userData 路径命名的。放在锁后面会让所有隔离实例共抢同一把锁，
 *    用户开着应用时就再也跑不了探针（进程直接静默 app.exit(0)）。
 *    必须放在 app.whenReady() 之前。
 */
if (ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', ELECTRON_USER_DATA_DIR)
}
if (ELECTRON_CRASH_DUMPS_DIR) {
  app.setPath('crashDumps', ELECTRON_CRASH_DUMPS_DIR)
}
/*
 * 下载目录同理（浏览器内置 / 本机 Chrome 都读 `app.getPath('downloads')`）：
 * 验收测试会真的下载文件，不能把它们丢进用户真实的下载目录 ——
 * 那个目录里的东西用户会当成自己的文件。
 */
if (DOWNLOADS_DIR) {
  app.setPath('downloads', DOWNLOADS_DIR)
}

/*
 * 同一个 userData 只能有一个桌面窗口。
 * 没有单实例锁时，重复执行 launch / dev 会创建多个 BrowserWindow；每个
 * 窗口都带自己的原生 WebContentsView，用户看到的就可能是不同进程的
 * toolbar、页面层和旧坐标叠在一起。
 */
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
    /* `inkstone://` 链接先于「显示窗口」处理；不是深链接（或已被拒绝）才回落到常规聚焦。 */
    if (deepLinkRouter.handleArgv(commandLine)) return
    showMainWindow()
  })
}

/*
 * 探针运行时关掉 Chromium 的**后台节流**。
 *
 * 为什么必需：为了不抢用户焦点，探针窗口用 `showInactive()`（见下面
 * ready-to-show 处的注释）。代价是窗口**不是 active** 的，Chromium 会对
 * 未聚焦/被遮住的窗口做后台节流：
 *   · 定时器被拉到 ≥1s（setTimeout / rAF 驱动的滚动与动画变慢）
 *   · 渲染被降频
 * 后果是探针偶发假失败（实测：outline 的滚动跳转、resize 的宽度应用
 * 偶尔「没生效」——单跑必过、连着跑才挂）。
 *
 * 这三个开只用开关就是为这种场景准备的，而且**只在有 YAN_PROBE 时加**，
 * 不影响用户实际使用的行为（他们本来就是聚焦窗口）。
 */
/*
 * electron-builder 的 portable 单文件 wrapper 在部分版本 / 启动方式下不会把
 * 父进程的环境变量完整地带到解压后的 GUI 子进程。验收脚本因此同时传一组
 * 明确的命令行参数；它们只恢复已有的测试探针开关，不改变正常启动路径。
 * 环境变量仍是首选，命令行只在对应变量缺失时兜底。
 */
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
  /* 性能排查：仅测试探针下、显式给端口时才开调试口，用 CDP 抓 CPU profile */
  if (/^\d{4,5}$/.test(process.env.YAN_PROBE_DEBUG_PORT ?? '')) app.commandLine.appendSwitch('remote-debugging-port', process.env.YAN_PROBE_DEBUG_PORT as string)
}

/*
 * 声音提示：允许在没有用户手势的情况下播放音频。
 *
 * Chromium 默认的自动播放策略要求页面先收到过点击/按键，否则 AudioContext
 * 一直是 suspended。桌面端「回合完成/报错」的提示音往往发生在用户没碰键盘时，
 * 所以必须放开。渲染端还留了一层手势解锁兜底（见 lib/sound.ts）。
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/*
 * Windows 通知标识。
 *
 * Windows 的 toast 必须用 AppUserModelID 归属到一个「应用」，否则静默不弹。
 * 打包后 electron-builder 会按 electron-builder.yml 的 appId 建开始菜单快捷方式，
 * 这里用同一个 id 才能对上；开发期没有快捷方式，至少让主进程不要再默认成
 * electron.exe（那样通知会以“Electron”之名发出，或干脆不显示）。
 */
const APP_ID = 'com.yudatoux.yan'


try {
  app.setAppUserModelId(APP_ID)
} catch {
  /* 极早期/平台差异，失败不影响其它功能 */
}

/* 全局状态 */
let win: BrowserWindow | null = null
let trayLanguage: string | undefined
/*
 * 托盘品牌素材与运动偏好（L12）：启动时预载 build/tray/manifest.json + 全部帧。
 * 减少动态效果由渲染端 matchMedia 上报；默认 false（未明确前保持静态）。
 */
let trayAssets: ReturnType<typeof createTrayAssetStore> | null = null
let trayMotionAllowed = false
/** 应用外注意投影（WP-12）：任务栏进度 / 覆盖图标 / 托盘。 */
let attention: AttentionService | null = null
/** 辅助小窗（WP-25d 快速提问 / WP-12 迷你小窗）。 */
let auxWindows: AuxWindows | null = null
/** 工作区页签弹出窗（WP-30 弹出）。 */
let panePopout: PanePopoutController | null = null
/** 终端页签同 PTY 弹出（WP-30 终端 transfer）：只 attach 既有 PTY，不 start/kill。 */
let paneTerminal: PaneTerminalTransfer | null = null
/** 浏览器页签原生视图转移端口（WP-30 弹出 · browser）。 */
let paneBrowserTransfer: PaneBrowserTransfer | null = null
let isQuitting = false
let exitRequestInFlight: Promise<{
  action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting'
}> | null = null
/**
 * 会话运行实例注册表（N12）。
 *
 * 一个**运行中**的会话 = 一个 pi 子进程（AgentController 实例）。
 * 切换会话不再复用同一个进程，所以「切走」不会把后台任务停掉。
 */
let runners: RunnerRegistry | null = null

/**
 * `yan:send` / 定时 `run` 在**第一个 `await` 之前**同步钉住的真实实例身份。
 *
 * 渲染端可以只给 runId / sessionId，或完全不传 `expectedRuntime`（旧调用）。这些
 * 输入只核调用方给的维度，识别不了 await 期间同一 runId 被复用：复用只把
 * generation / 真实 sessionId 往前推，runId 不变。入口额外钉住**当时运行实例的
 * 真实代次与 Agent 对象**，之后所有 await 都用它复核。
 */
interface PinnedSendTarget {
  runId: string
  generation: number
  sessionId?: string
  /** 原始 Agent 引用：跨 cwd 复用会替换对象，同 cwd 复用看代次 / 真实 SID。 */
  agent: AgentController
}

/** 同步钉住目标实例当时的真实身份；实例不存在返回 null（调用方明确失败）。 */
function pinSendTarget(id: string): PinnedSendTarget | null {
  const agent = runners?.agentOf(id)
  const runtime = runners?.runtimeOf(id)
  if (!agent || !runtime) return null
  return { runId: runtime.runId, generation: runtime.generation, sessionId: runtime.sessionId, agent }
}

/** await 之后复核钉住的实例没被复用：Agent 对象、代次、SID 迁移方向都要一致。 */
function pinnedTargetMatches(pin: PinnedSendTarget): boolean {
  if (runners?.agentOf(pin.runId) !== pin.agent) return false
  return sameRuntimeEnvelope(runners?.runtimeOf(pin.runId), pin)
}

/** 运行注册表（v3 WP-10）；初始化失败时为 null，其它功能照常。 */
let runsHost: RunsHost | null = null
/**
 * 评审运行的 R 号 producer（§10.2 / WP-50）。跟 runsHost 一起建；
 * 只读评审子运行的 pi 事件经它按 runId 投影成 `kind:'review'` 的运行。
 */
let reviewRuns: ReviewRunProducer | null = null
/**
 * MCP App 视图桥（v3 §12）。renderer 只传 callId/instanceId/JSON-RPC；
 * owner/授权从实际前台 runner 派生。未就绪时为 null，IPC 返回明确未就绪。
 */
let mcpAppViewService: McpAppViewService | null = null
/**
 * App 视图的前台归属快照（会话切换 / 运行实例重启时旧视图立即失效）。
 * 只存最小事实：这样一个模块级变量就能清掉旧会话的实例与在途调用。
 */
let appViewForeground: { runnerId: string; sessionId: string; sessionFile: string; generation: number } | null = null
/** 同步控制器；`registerSyncIpc` 返回，就绪后调 `runStartupSync()`。 */
let syncController: ReturnType<typeof registerSyncIpc> | null = null
const runnerVisibility = new RunnerVisibility()
let piPackageActivationScheduler: PiPackageActivationScheduler | null = null
let piPackageActivationTimer: ReturnType<typeof setTimeout> | null = null
let piPackageActivationRetryTimer: ReturnType<typeof setTimeout> | null = null
let piPackageActivationInFlight = false
let piPackageActivationAgain = false
/** Same deferred reason is quiet; a changed reason remains visible for diagnosis. */
const piPackageActivationDeferred = new Map<string, string>()

/**
 * `goal-resume` 会先写消费证据再调用 `sendMessage`；某些 pi 版本不会为这
 * 个 custom 消息再推一帧宿主可见的 `state/proc` 事件。只对「等待消费证据」
 * 的结果安排一次有界复核，不能靠它重新触发 runner 重载。
 */
function schedulePiPackageActivationRetry(): void {
  if (piPackageActivationRetryTimer) return
  piPackageActivationRetryTimer = setTimeout(() => {
    piPackageActivationRetryTimer = null
    requestPiPackageActivationTick()
  }, 2_500)
  piPackageActivationRetryTimer.unref?.()
}
let browser: BrowserController | null = null
const agentHub = new AgentHubService({
  dataDir: YAN_DIR, piDir: PI_AGENT_DIR,
  resourcesDir: existsSync(join(process.resourcesPath ?? '', 'yan-cli')) ? process.resourcesPath : join(app.getAppPath(), 'resources'),
  browser: () => browser,
  projects: async () => (await getSettings()).projects.filter((p) => !p.archived),
  piBin: async () => (await getSettings()).piBin,
  sessionProject: (id) => runners?.agentForSession(id)?.capabilityProjectId ?? null,
  notifyEnabled: async () => (await getSettings()).subagentNotify !== false,
  sendToSession: async (id, text) => {
    const target = runners?.agentForSession(id)
    return target ? target.send(text, undefined, 'followUp') : { ok: false, error: '主会话已关闭' }
  },
  openRun: (taskId) => push({ ch: 'hub-open', payload: `hub:${taskId}` }),
  changed: () => refreshTaskbar()
})
/**
 * 子代理：主进程级的生命周期服务。界面与模型（`yan subagent …`）共用同一个控制器，
 * RunnerRegistry 切会话 / 重启 pi 时重建 AgentController，但这个服务不跟着重建。
 */
/**
 * 定时任务：到点新开一条会话并发出指令（只在砚运行时触发）。
 * 会话按当时的设置里的文件夹与项目归属创建，不抢前台；指令前加一行任务名，便于在会话列表里认出来。
 */
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
    /* 选择时就带来源：让 runner 在会话身份一就绪就绑 T 编号来源，早于早期信号。 */
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
    /*
     * 发送前登记这次定时运行：编号作用域是任务 id，T 号由现行 Codes 服务分配一次，
     * 之后 pi 事件沿同一 RunContext 续写；失败 / 取消也走同一注册表终态收口。
     */
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
  /* 流式增量：同一份转录只发变化的那一段（见 subagents.ts 的 emitDelta） */
  onPatch: ({ id, run, transcriptFrom }) => {
    push({ ch: 'subagent-patch', payload: { id, run, transcriptFrom } })
    refreshTaskbar()
  },
  onRemove: (id) => {
    push({ ch: 'subagent-remove', payload: id })
    refreshTaskbar()
  },
  /* 只读原始事件旁路：评审运行的 R 号投影用；未知子运行是空操作，不影响面板与控制。 */
  onEvent: (runId, evt) => {
    reviewRuns?.observe(runId, evt)
  },
  resolveAgentProfile: (id) => resolveAgentProfile(id),
  /*
   * 结束后叫醒发起它的会话：按稳定会话 id 找实例，找不到（会话已关）就不投。
   * 评审子运行额外按 runId 收口一次 R 运行（结束 / 失败 / 停止各一次）；
   * 不是评审运行就是空操作。
   */
  onFinished: (run) => {
    reviewRuns?.settle(
      run.id,
      run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'stopped' : 'failed',
      run.error
    )
    notifySubagentFinished(run)
  }
})
/** 安卓远程管理服务；默认关闭，避免升级后意外监听网络端口。 */
/** 手机接入（远程访问）：按设置启停，见 remote-access.ts */
let remoteAccess: RemoteAccess | null = null

/**
 * 当前**正在查看**的会话实例。
 * 绝大多数据 IPC 命令作用在它身上（发送 / 停止 / 模型切换 …）。
 */
function ac(): AgentController | null {
  return runners?.active() ?? null
}

/**
 * 当前**前台**运行实例的 App 视图事实（v3 §12）。
 *
 * 只从实际前台 runner + AgentController 状态派生 runnerId / generation / sessionFile /
 * projectId / cwd。任一缺失返回 null —— 调用方必须 fail-closed，绝不回退到「旧 runner
 * 还在」或请求自报的归属。
 */
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

/**
 * 前台归属变化时立即失效旧 App 视图（会话切换 / 运行实例重启）。
 *
 * 只在**真实前台**的 runnerId / sessionId / sessionFile / generation 发生变化时动作，
 * 不因为后台实例仍存活就把它们的资源放行；具体拒绝仍由 ownerGuard 按全字段核对。
 */
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
  /* 前台切走、实例重启，或整个前台消失：旧视图立即失效并中止在途调用。 */
  mcpAppViewService.invalidateRunnerId(previous.runnerId)
  mcpAppViewService.invalidateSession(previous.sessionId)
}

/**
 * 停一个运行实例，并先取消挂在它身上的交接（若有）。
 *
 * 「停止」按钮（`yan:abort`）与运行总览的批量停止必须逐字同路：每次停止都
 * 先把 pending 的交接标记取消并 abandon（目的实例不是自己时也要停掉它），
 * 再调 pi 的 `abort()`（内部先 clear_queue）。返回 clear_queue 拿回的排队
 * 文本，调用方负责放回输入框，别让用户白打的那句话静默丢掉。
 */
const stopRunnerWithHandoff = async (runnerId: string | null, agent: AgentController | null): Promise<QueueSnapshot> => {
  if (runnerId) {
    // 仅处理确实存在的历史交接，普通停止不再写旧目标/续行状态。
    for (const [sourceId, pending] of handoffPending) {
      if (sourceId !== runnerId && pending.destinationRunId !== runnerId) continue
      pending.cancelled = true
      if (pending.destinationRunId && pending.destinationRunId !== runnerId) {
        await runners?.agentOf(pending.destinationRunId)?.abort()
      }
      await abandonHandoff(sourceId, 'user-stop', pending.request.operationId)
    }
  }
  return (await agent?.abort()) ?? { steering: [], followUp: [] }
}

/**
 * 砚薄层的资源查找顺序：
 *
 *   · 打包态放在 `resources/yan-thin`，不伪装成 pi 的用户扩展目录；
 *   · 开发态继续从仓库里的 `resources/pi-extensions` 读源码；
 *   · 最后一项给从仓库根目录启动的开发入口兜底。
 *
 * 这些文件仍通过 `--extension` 显式传入；改目录名只收紧随包边界，
 * 不把薄层变成可被 pi 自动发现的第三方扩展集合。
 */
/**
 * 随包技能：`resources/skills/<名称>/SKILL.md`（打包后在 resources/yan-skills）。
 * pi 以 --no-skills 启动，不自动发现；这里列出的技能按 --skill 显式传入。
 */
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

/**
 * 内置「提问」工作模式指引薄层的路径。
 * 真正的交互入口是宿主 `yan question ask`；自主模式会明确禁止调用它。
 * 与其它薄层同一套查找顺序（打包后 / 开发期）。
 */
function questionExtensionPath(): string | undefined {
  return yanThinResourcePath('question.js')
}

/** 没有 Git Bash 时提供 PowerShell 工具。 */
function shellFallbackExtensionPath(): string | undefined {
  return yanThinResourcePath('shell-fallback.js')
}

function codemodeExtensionPath(): string | undefined {
  return yanThinResourcePath('codemode-policy.js')
}

/**
 * 内置「回复详细程度」扩展的路径（方案 3.1）。
 * 它在 before_agent_start 里按档位注入系统提示；standard 档不注入。
 */
function responseDetailExtensionPath(): string | undefined {
  return yanThinResourcePath('response-detail.js')
}

/**
 * 内置「系统提示开场白」扩展的路径。
 *
 * 它把 pi 内置的英文 preamble（"You are an expert coding assistant operating
 * inside pi, …"）换成砚身份，并追加简短进展约定。**不用** `--system-prompt`：
 * 那是整段替换，会把 pi 自己维护的 tools / rules / docs 段落一起丢掉。
 */
function preambleExtensionPath(): string | undefined {
  return yanThinResourcePath('preamble.js')
}

/**
 * 内置「界面语言」扩展的路径。
 *
 * 它在 `before_agent_start` 里读 `desktop.json` 的 `lang`，每轮注入一句
 * 「推理与回复用什么语言」。**不用** `--append-system-prompt`：那个只在进程
 * 启动时生效，切语言就得重建实例（会掐掉后台会话、并让界面短暂失去历史）。
 */
function languageExtensionPath(): string | undefined {
  return yanThinResourcePath('language.js')
}

/** 内置「采样温度」扩展：按 desktop.json 的 temperatureByModel 在请求里写 temperature。 */
function temperatureExtensionPath(): string | undefined {
  return yanThinResourcePath('temperature.js')
}

/**
 * 内置「能力入口说明」扩展的路径。
 *
 * 它把「有 `yan` 这个入口、输出是摘要 + 结果文件」这段短说明追加到系统提示，
 * 否则模型根本不会去用它（见 resources/pi-extensions/capability-guide.js）。
 */
function capabilityGuideExtensionPath(): string | undefined {
  return yanThinResourcePath('capability-guide.js')
}

/** 上下文构成观测薄层：只读上报系统提示分段与工具定义（`context.inspect`）。 */
function contextInspectExtensionPath(): string | undefined {
  return yanThinResourcePath('context-inspect.js')
}

/** 旧工具输出裁剪与自动压缩上限（读设置；压缩调用 pi 原生 compact）。 */
function contextTrimExtensionPath(): string | undefined {
  return yanThinResourcePath('context-trim.js')
}

function nativeSessionExtensionPath(): string | undefined {
  return yanThinResourcePath('native-session-bridge.js')
}

/**
 * 单轮重复动作兜底的薄层路径（2026-09-22）。
 *
 * 只有它能在运行时拦下一次工具调用（`tool_call` 钩子），RPC 面没有这个事件。
 */
function repeatGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('repeat-guard.js')
}
/** 托管 MCP 工具的模型代理薄层（设计 A2）：读快照注册 `mcp__` 工具。 */
function mcpAppProxyExtensionPath(): string | undefined {
  return yanThinResourcePath('mcp-app-proxy.js')
}
/** 高危操作确认（薄层 tool_call 钩子；确认框在宿主）。 */
function dangerGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('danger-guard.js')
}
/** 服务适配与脱敏错误诊断：主会话和子代理共用，不复制 pi 的请求或重试循环。 */
function providerExtensionPaths(): string[] {
  return [yanThinResourcePath('commandcode.js'), yanThinResourcePath('provider-diagnostics.js')].filter((p): p is string => !!p)
}
/**
 * 砚随包薄层扩展的**实际加载路径**（传给 pi 的 `--extension`）。
 *
 * 抽成一个函数是为了只有一份清单：来源诊断（[reportExtensionSources]）与
 * 「受信内置能力」查询（`yan:capabilities:builtin`）都从这里取 ——
 * 否则设置页显示的清单可能与 pi 真正加载的东西不一致。
 * 找不到文件的项直接丢掉（打包漏了资源时，界面不如实列出这些不存在的东西）。
 */
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
    contextInspectExtensionPath(),
    contextTrimExtensionPath(),
    nativeSessionExtensionPath(),
    repeatGuardExtensionPath(),
    dangerGuardExtensionPath(),
    ...providerExtensionPaths(),
  ].filter((p): p is string => !!p && isAgentContextExtension(p))
}

function push(msg: MainPush): void {
  remoteAccess?.publish(msg)
  /* 运行注册表增量一到达就重算注意投影：托盘提示 / 任务栏覆盖只在这里刷新。 */
  if (msg.ch === 'runs') attention?.refreshTaskbar()
  /* 迷你小窗的注意项列表也跟随运行注册表刷新（默认关闭时是空操作）。 */
  if (msg.ch === 'runs') auxWindows?.notifyRuns()
  if (!win || win.isDestroyed()) return
  win.webContents.send('yan:push', msg)
}

/** 批准卡片的中转：宿主要问用户时挂起，等渲染端在输入框上方答复 */
const approvals = new ApprovalBroker({
  canAsk: () => !!win && !win.isDestroyed(),
  open: (request) => {
    /* 运行注册表：只观察宿主危险确认（正式封套 + id），不另造请求。 */
    runsHost?.observeApproval(request)
    push({ ch: 'approval', payload: request })
    /* 窗口在后台或最小化时卡片看不到：任务栏闪烁并发一条系统通知（不抢焦点），点通知回到窗口 */
    if (win && !win.isDestroyed() && !win.isFocused()) {
      attention?.flash()
      /* 系统通知跟随设置里的「系统通知」开关；任务栏闪烁不受它影响 */
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
    /* 允许 / 拒绝 / 超时 / 无答复都到达这里：一律归还运行态。 */
    runsHost?.resolveApproval(id)
    push({ ch: 'approval-close', payload: { id } })
    refreshTaskbar()
  }
})

/**
 * 应用外注意投影（v3 WP-12）。
 *
 * 迁移自本文件原先内联的 refreshTaskbar / createTray / refreshTrayMenu：
 * 任务栏进度与覆盖图标、托盘提示与菜单改由运行注册表快照 + 宿主事实驱动。
 * Electron 对象在这里构造；投影与菜单内容在 src/main/attention/**。
 */
attention = createAttentionService({
  platform: process.platform,
  snapshot: () => runsHost?.snapshot() ?? { revision: 0, runs: [] },
  /* 尚未进运行注册表的忙碌 / 等待事实：终端、Agent Hub、子代理、批准中转。 */
  hostBusy: () =>
    runners?.hasBusy() === true || agentHub.hasLiveWork() || (subagentService.current()?.runningCount ?? 0) > 0 || hasWorkingTerminal(),
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

/** 把托盘菜单模型翻成 Electron 模板；点击回调只导航，不执行。 */
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

/** 注意投影的薄封装：调用点保持不变，实现移到 src/main/attention/**。 */
function refreshTaskbar(force = false): void {
  attention?.refreshTaskbar(force)
}

function refreshTrayMenu(): void {
  attention?.refreshMenu()
}

const blockedTerminalNotices = new Map<string, { kind: TerminalProgramStatus['kind']; ticket: symbol }>()

/** 只在进入 blocked 或等待类型变化时通知；异步读取设置后再次核对归属与前台状态。 */
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

/**
 * 给某个实例的事件标上身份（N12）。
 *
 * 渲染端靠 `sessionKey` 判断：这条输出是「我在看的这个会话」的，
 * 还是后台另一个会话的 —— 后者不得写进当前视图。
 */
/**
 * 交接计数（实施-05 S5a）：把 `state` 推送里那次压缩并进本会话的计数。
 *
 * 三条边界：
 *   ① 只有 `completed` 的自动压缩值得往下走（其余连 store 都不用碰）；
 *   ② 键用 `workModeKeyFor`（= 会话文件路径），与模式 / 目标同一套 ——
 *      压缩发生在会话进行中，此时稳定键一定已经有了；
 *   ③ 计数失败**不影响会话**（吞掉错误）：它决定的是「要不要交接」，而当前这一轮
 *      该干什么与它无关。
 */
async function observeCompaction(id: string, state: unknown): Promise<void> {
  const run = (state as { lastCompaction?: CompactionRun } | null | undefined)?.lastCompaction
  if (!run || run.status !== 'completed') return
  const key = workModeKeyFor(id)
  if (!key) return
  try {
    await handoffs.load()
    await handoffs.recordCompaction(key, run)
  } catch {
    /* 计不上就计不上：下一次 state 推送还会带着同一份记录重来（幂等） */
  }
  /*
   * 计完顺手看一眼要不要交接（§7）。不在计数里直接 arm 是因为资格还有另外三个条件，
   * 而它们可能在计数之后才成立（目标被报成 executing、模式切到自主档）。
   */
  void scheduleSessionWork(id, 'compaction')
}

/**
 * 交接计数与交接包的存储（实施-05 S5a）。
 *
 * 与目标状态分两份文件：目标是「这一轮做到哪」（模型高频写、带幂等记录），
 * 计数是「这个片段压了几次」（宿主写、阈值只在交接资格判定里用）。
 */
const handoffs = new HandoffStore()

/**
 * 交接 / 目标续接的阶段诊断（实施-14 F0）。
 *
 * 它不是第二份状态：`handoffs.json` 与事务日志回答「现在到哪一步」，
 * 这里回答「过程里发生过什么、为什么停下」—— 资格没过、写请求失败、
 * 结果对不上、提交停在哪个阶段，这些从状态里看不出来。
 * 文本已在下层脱敏（`redactDiagnosticText`），不记提示词全文与凭证。
 */
const handoffDiag = new HandoffDiagnostics()

/* ────────────────────────────────── 交接事务接线（实施-05 S5b-3b） */

/**
 * 会话链（前端「后台两份、前端一条」的关系）与交接事务日志。
 *
 * 两者都由主进程独占写：链决定侧栏显示什么（一个段只属于一条链），
 * 事务日志决定重启后该补记 / 重发还是回源。
 */
const sessionChains = new SessionChainStore()
const handoffTransactions = new HandoffTransactionStore()

const artifactStore = new ArtifactStore(join(YAN_DIR, 'artifacts'))

/** 逐段恢复 artifact manifest，确保链式会话的旧图片 / 文件也能回到原消息。 */
function readHistoryWithArtifacts(sessionFile: string) {
  return readChainMessages(sessionFile, sessionChains, (file, messages) =>
    artifactStore.hydrateMessages(file, messages)
  ).then(async (result) => {
    /*
     * 回合计时元数据（实施-11 H-6）。
     *
     * `agent.hydrate()` 已经挂过一次；peek 是**另一条读历史的路**（切会话时
     * 先拿它铺上内容），不挂就会出现「刚切过去时用时没了、等 pi 推 sync 又
     * 回来了」的闪烁。两条路用同一个纯函数，结果一致。
     */
    if (!result) return result
    const bucket = timingKey(sessionFile)
    if (!bucket) return result
    const records = await readTurnTimings(YAN_DIR, bucket).catch(() => [])
    if (!records.length) return result
    return { ...result, messages: applyTurnTimings(result.messages, records) }
  })
}
/**
 * 「会话 ↔ 工作树」的来源关系（实施-07 S2）。
 * 只用于追溯与展示（「这个会话来自哪个工作树」），**不参与历史拼接** ——
 * 那是会话链的事，两者语义不同（见 `worktree-links.ts` 的头注释）。
 */
const worktreeOrigins = new WorktreeLinkStore()

/**
 * 自动隔离登记表（同一工作目录的会话冲突 → 换目录继续 + 自动合回）。
 *
 * 只记**砚自己建的**那些工作树：用户手动建的工作树里可能有他正在编的东西，
 * 自动合并过去等于替他做决定（见 `session-isolation.ts`）。
 */
const autoIsolations = new AutoIsolationStore()

/**
 * 合回尝试的全局节流。
 *
 * 触发点是「回合收尾的 `state` 推送」，而那个推送一轮里会出现好几次
 * （`isAgentRunning=false` 不只出现在收尾）；不节流会对着同一份没变的提交
 * 反复跑 git。
 */
let isolationSweepAt = 0
const ISOLATION_SYNC_MIN_INTERVAL = 3000
/** 每个隔离工作树最近一次 blocked 的原因：只在**原因变了**的时候打扰用户 */
const isolationBlockedReason = new Map<string, string>()

/**
 * 隔离状态的**展示快照**（cwd 键 → 状态）。
 *
 * 为什么单独存一份、不直接在 `statuses()` 里 await 登记表：
 *   · `statuses()` 是同步的快照构造，而登记表读盘、合并判定都要 await；
 *   · 状态是「等主干空闲 / 被挡 / 已合回」这类**推进过后**的结论，
 *     当场重算每次快照都要跑 git。
 * 所以：写者只有两处（建隔离时、扫一轮合回时），读者是左栏快照与状态条。
 */
const isolationView = new Map<string, { state: 'waiting' | 'blocked'; branch: string }>()

/** 同步查询：给 `RunnerRegistry.statuses()` 按 runner 的 cwd 取隔离状态 */
function isolationOf(cwd: string): { state: 'waiting' | 'blocked'; branch: string } | undefined {
  return isolationView.get(isolationCwdKey(cwd))
}

/**
 * 写隔离状态并同步两处展示：
 *   · 左栏会话行的状态标（走 `runners` 快照）；
 *   · 右栏状态条（常驻一行，见 `statuses` 通道）——「排队等合回」是**等待中**的事实，
 *     不发通知（每轮一条通知会刷屏），但也不能什么都不说。
 */
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

/** 状态条：多个隔离树会同时存在，所以只报一个汇总（不把每棵都铺上去） */
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

/**
 * 启动时先把登记表里的隔离树标成「等待合回」。
 * 真实状态（已合回 / 被挡）由第一轮扫描修正 —— 这里只是先把标记铺上，
 * 不让重启之后那几行会话看起来像「从来没隔离过」。
 */
async function initializeIsolationView(): Promise<void> {
  const records = await autoIsolations.all().catch(() => [])
  for (const record of records) setIsolationView(record.worktree, { state: 'waiting', branch: record.branch })
}

/**
 * 自动合回：把隔离工作树里的提交合回各自的主干（全自动档）。
 *
 * 为什么是「扫一遍」而不是「只看刚刚收尾的那个实例」：被推迟的合并（主目录还忙着）
 * 的收尾信号属于**另一个实例** —— 只看当前实例的话，那份改动要等到隔离会话
 * 自己再跑一轮才会被合回。
 *
 * 三条边界：
 *   ① 主工作目录还有实例在忙就**不动**——合并会改文件，不能塞进别人正在跑的回合；
 *   ② 失败只留下「改动仍在隔离工作树里」，绝不回滚成「两边都没有」；
 *   ③ 同一原因不重复提示（每轮一次报错能刷满通知栏）。
 */
async function syncPendingIsolations(): Promise<void> {
  if (!runners || !win || win.isDestroyed()) return
  if (Date.now() - isolationSweepAt < ISOLATION_SYNC_MIN_INTERVAL) return
  isolationSweepAt = Date.now()
  const records = await autoIsolations.all().catch(() => [])
  for (const record of records) {
    if (runners.hasBusyCwd(record.mainCwd)) {
      /* 主干还忙着：这就是「等待合回」，让左栏与状态条看得见 */
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
  /*
   * 登记表里已经没有的（用户把工作树移除了）：标记也要跟着消失。
   * 不做这一步的话，状态条会永远挂着一条「等主干空闲」。
   */
  const alive = new Set(records.map((record) => isolationCwdKey(record.worktree)))
  for (const key of [...isolationView.keys()]) {
    if (!alive.has(key)) setIsolationView(key, null)
  }
}


/** Observe settled runs without starting retries or automatic handoffs. */
const sessionWork = createSessionWorkScheduler({
  stateOf: (id) => runners?.agentOf(id)?.getState() ?? null,
  hasHandoffOperation: (id) => hasHandoffOperation(id),
  // Native Agent owns continuation; no legacy domain files are polled.
  consumeRepeatBlocks: async () => {}
})


/* ────────────────────────────────────────────── 交接包生成（实施-05 S5b-2） */


/* ────────────────────────────── 同一会话的单一调度（实施-14 F2 / H1） */

/**
 * 每个会话的「下一步动作」串行决定；优先级与判定见 session-work-scheduler.ts。
 * 串行链按 runnerId 分开：不同会话之间没有共享状态，没必要互相阻塞。
 */
function scheduleSessionWork(id: string, reason: string): Promise<void> {
  return sessionWork.schedule(id, reason)
}

function pushFrom(runnerId: string, msg: MainPush, expectedRuntime?: RuntimeEnvelope | null): void {
  const identity = handoffIdentities.get(runnerId)
  if (msg.ch === 'state' && identity && msg.payload.sessionId === identity.sessionId) {
    msg = { ...msg, payload: { ...msg.payload, ...identity } }
  }
  const runtime = runners?.runtimeOf(runnerId)
  // 已摘登记的进程（含回收/交接）的退出事件不能污染当前视图。
  if (!runtime) return
  /*
   * 快照异步采集期间换了会话 / 代次：旧 payload 不能贴上新封套（F03）。
   * 同代次里的 `pending:<runId>` → 真实 uuid 迁移算同一身份，不退。
   */
  if (expectedRuntime && !sameRuntimeEnvelope(runtime, expectedRuntime)) return
  runners?.noteActivity(runnerId)
  push({
    ...msg,
    ...(runtime ? { runtime } : {}),
    /* 旧探针仍读取这个字段；新代码以 runtime.runId 为准。 */
    sessionKey: runnerId
  })
  if (msg.ch === 'state' || msg.ch === 'proc') refreshTrayMenu()
  if (msg.ch === 'state' || msg.ch === 'proc') requestPiPackageActivationTick()
  /*
   * 每一次 `state` 推送都可能是「一次压缩刚结束」（`lastCompaction`）。
   * 交接计数的幂等压在 store 里（同一份记录只会计一次），所以这里可以无条件看它 ——
   * 不在这里做去重，就不会出现「两份去重逻辑想不到一块去」。
   */
  if (msg.ch === 'state') void observeCompaction(runnerId, msg.payload)
  // Observe run completion without creating another model turn.
  sessionWork.observePush(runnerId, msg)
  /* 隔离工作树的回合收尾 → 扫一轮自动合回（没有隔离登记时就是一次空扫） */
  if (msg.ch === 'state' && (msg.payload as SessionState)?.isAgentRunning === false) void syncPendingIsolations()
  /*
   * 每次 `state` 推送都顺带刷一次 `runners` 快照。
   *
   * 为什么必须刷：渲染端把 `runners[active].running` 当作「回合还在跑」的依据之一
   * （`Composer` 的待定消息自动投递、`QueueStack` 的「插话 / 排队」二选一）。
   * 而这个快照原先只在**实例生命周期**事件里推（起停 / 切会话 / 删除），
   * 回合结束（`agent_settled` → `setAgentRunning(false)`）只走 `state` 通道 ——
   * 快照会一直停在 `running: true`：待定消息永远等不到自动投递，
   * 卡片也一直给着「插话」（2026-09-19 用户报的 bug）。
   *
   * 为什么不比对变化再推：`pushFrom` 里 `agent.state` **已经是新值**，
   * 现算比对必然相等（`runners.statuses()` 读的就是它），除非再维护一份影子状态。
   * 而 `state` 推送全库只有几处（回合起停、流起停、模型 / 压缩状态变化），
   * 快照又很小 —— 多推这几条的代价远低于再引入一份需要同步的影子状态。
   */
  if (msg.ch === 'state') pushRunners()
}

/** Debounced safe-boundary activation; all trust/authorization decisions remain in the scheduler. */
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

/**
 * 运行实例的会话身份落定后的子代理父归属迁移。
 *
 * 空白新会话在 pi 写入前父身份是 `pending:<runId>`；拿到真实 SID 后，挂在这个
 * 父实例下、同代次、且当时确实是该 pending 占位的子任务要把 `parentSessionId`
 * 换成真实 SID，否则渲染端按真实 SID 过滤时会看不见它们。
 * 只认现成控制器（`current()`，不 instantiate）；代次未知 / 不符、或已复用成别的
 * 真实 SID 的记录都由 `SubagentController.adoptParentSession` 拒绝，绝不猜。
 */
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

/** 把所有运行实例的状态推给渲染端（左栏状态槽） */
function pushRunners(): void {
  const statuses = runners?.statuses() ?? []
  push({ ch: 'runners', payload: statuses })
  /* 前台会话变化（切换 / 重启 / 回收）就作废旧 App 视图，不只等 iframe 卸载。 */
  syncAppViewForeground()
  refreshTrayMenu()
  refreshTaskbar()
  void syncKeepAwake(statuses.some((r) => r.running))
  /* 这条通知链由 state 推送 / 实例变更触发，顺带把落定身份的父子归属接上。 */
  adoptSubagentParentSessions(statuses)
}

/**
 * 代次前进后的兜底完整快照（F07）。
 *
 * 实例在同一 cwd 复用失败时会用**新代次**恢复到旧会话；渲染端可能缓存着更高的
 * 中间代次，只有用新代次重推一份权威快照（state + messages + stats）才能续上。
 * onChanged 在实例身份变化时触发，这里只对「代次比上次发布更高」的实例补一帧；
 * `pushRunnerSnapshot` 只读、不再触发 onChanged，所以不会递归。
 */
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

/** 渲染端提交时钉住的归属；老调用方不传时为 null。 */
type ExpectedRuntimeInput = { sessionId?: string; runId?: string; generation?: number }

/**
 * 校验渲染端传入的 `expectedRuntime`。
 *
 * 前端已按 `RuntimeEnvelope` 声明类型，但宿主不能只信 IPC 形状：传了非对象、空字段
 * 或非法代次时返回 `'invalid'`，宁可明确失败也不退回「猜当前 active」。
 * 不传（旧 CLI / 内部调用）返回 null，由调用方在入口同步钉住当前目标。
 */
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

/** 目标实例当前是否仍匹配钉住的归属（所有 await 之后都复核）。 */
function targetMatchesExpected(id: string, expected: ExpectedRuntimeInput | null): boolean {
  if (!expected) return true
  const runtime = runners?.runtimeOf(id)
  if (!runtime) return false
  if (expected.runId !== undefined && runtime.runId !== expected.runId) return false
  if (expected.generation !== undefined && runtime.generation !== expected.generation) return false
  if (expected.sessionId !== undefined && runtime.sessionId !== expected.sessionId) {
    /*
     * 只允许「提交时是 pending → 现在变真实 uuid」这一个方向；提交时已是真实 SID、
     * 现在却变成 pending（换了会话）必须判为不一致。
     */
    if (!expected.sessionId.startsWith('pending:')) return false
  }
  return true
}

/** 用 expected runtime 精确定位运行实例；定位不到或身份不符返回 null（不 activate）。 */
function resolveExpectedTarget(expected: ExpectedRuntimeInput | null): string | null {
  if (!expected) return null
  const id = runners?.resolveExpectedRunner(expected) ?? null
  if (!id || !targetMatchesExpected(id, expected)) return null
  return id
}

/**
 * 界面在后台查看某条会话时钉住的父运行实例 → 父上下文。
 *
 * 只认**已经存在**的实例：owner 非法 / 缺目标、或实例已被复用成别的会话
 * （代次或真实 sessionId 不符）都返回 null，由调用方明确失败 —— 绝不退回
 * `active`，否则「看 B 却在 A 上派活」会静默把父归属挂到 A。
 * 这里同步读取，调用方已在 `getSettings()` 之后调用，跨 await 的复用由
 * `targetMatchesExpected` 按 generation / sessionId 复核。
 */
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

/** 默认父（无 owner）在第一个 await 之前同步捕获的原始实例身份。 */
interface CapturedParent {
  runId: string
  generation: number
  sessionId?: string
  cwd?: string
  /** 原始 Agent 引用：await 之后用来证明实例没有被换掉。 */
  agent: AgentController
}

/**
 * 在**第一个 `await` 之前**同步捕获当前 active 运行实例的原始身份。
 *
 * 为什么要快照而不是等到 await 之后再读 `ac()` / `activeRunner()`：`getSettings()`
 * 与 `service.get()` 都会让出事件循环，期间用户可能切到 B；之后再读 active 就会
 * 把 A 的任务挂到 B 上。没有 active 实例时返回 `null`（启动早期），调用方不得
 * 事后补认后来出现的父。
 */
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

/**
 * 把捕获的默认父落成父上下文；await 之后复核实例没被换、同代次。
 *
 * 同代次里的 `pending:<runId>` → 真实 SID 属于同一身份，放行；换了实例、代次前进、
 * 或真实 SID 变成另一条会话都明确抛错，绝不落到当时 active 的 B。没有捕获到父
 * （启动早期）保持旧的 cwd-only 兼容，不冒认之后出现的实例。
 */
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

/**
 * 选择父上下文：带 owner（含显式 null）一律走严格定位，定位不到就抛错；
 * 只有完全没传（`undefined`，老调用 / CLI）才用同步捕获的默认父。
 */
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

/** 有会话在跑时按设置保持唤醒；读设置失败就按「没有设置」处理。 */
async function syncKeepAwake(working: boolean): Promise<void> {
  const s = await getSettings().catch(() => null)
  updateKeepAwake({ working, whileWorking: s?.keepAwakeWhileWorking, onBatteryAllowed: s?.keepAwakeOnBattery })
}

/**
 * 工作模式（实施-05）的存储。
 *
 * 按会话保存；新会话在 pi 给出稳定 sessionId 之前用 `pending:<runnerId>` 占位。
 * 单例：它自己缓存整份文档，多处各建一个会互相覆盖。
 */
const workModes = new WorkModeStore()

/**
 * 活动档案（实施-25 P01）的存储。
 *
 * 与工作模式同一套键与交接口径：按会话保存，`pending:<runnerId>` 占位，
 * 每轮把当前值写给薄层扩展（它只能从文件知道自己是哪个会话）。
 */
const agentProfiles = new AgentProfileStore()

/**
 * 主题空间（实施-25 P02）的存储。
 *
 * 与工作模式 / 活动档案的差别：空间**不属于某个会话**，它是全局的组织维度；
 * 会话只是通过 `spaceId` 指向它（归属写在 session-layout 里）。
 */
const spaces = new SpaceStore()

/**
 * 资料库（实施-25 P03）的服务实例。
 *
 * 与 spaces / agentProfiles 不同，它同时握有存储与解析调度 ——
 * 「导入 → 解析 → 登记引用」是一条链，拆两个单例只会让调用方漏掉中间一步。
 */
const library = new LibraryService()

/**
 * 上下文装配器（实施-25 P05 / T05-3）。
 *
 * 与资料库共用同一个 service 实例：装配要读的就是「这个会话引用了哪些资料」
 * 以及它们的正文，另起一个 store 只会让两份文档不一致。
 */
const contextAssembler = new ContextAssembler({ library })

/**
 * 切完视图后把目标实例的现状推给渲染端（N12）。
 *
 * 为什么必须做：渲染端对**非当前实例**的事件是直接丢弃的，切过去之后
 * 必须有一份完整快照（状态 + 消息 + 统计）作为新视图的起点。
 *
 * `chainHistory` 只给「刚完成一次交接」那一步用：
 *   §5.3 要求交接后前端**不清空旧消息**。而 `agent.getMessages()` 是 pi
 *   **当前片段**的上下文（交接后的新片段只含摘要 + 最近几轮），拿它当界面
 *   历史会把源段整段“变没”（实测：交接后时间线只剩最后一段）。界面历史的
 *   权威来源一直是链上的 JSONL（AGENTS.md：历史就是会话文件），所以这一步
 *   改读链历史；拿不到时回到原行为，不把“读盘失败”变成空时间线。
 */
async function pushRunnerSnapshot(id: string, opts: { chainHistory?: boolean } = {}): Promise<void> {
  const ag = runners?.agentOf(id)
  if (!ag) return
  /*
   * 采集开始前钉住一次身份：getState / messages / chainHistory / stats 都按它核。
   * 中间一旦换实例或换代次，旧 payload 直接丢弃，不晚贴当前会话封套。
   */
  const expected = runners?.runtimeOf(id)
  if (!expected) return
  const st = ag.getState()
  if (st) pushFrom(id, { ch: 'state', payload: st }, expected)
  try {
    let payload = await ag.getMessages()
    if (runners?.agentOf(id) !== ag || !sameRuntimeEnvelope(runners?.runtimeOf(id), expected)) return
    if (opts.chainHistory && st?.sessionFile) {
      const chain = await readHistoryWithArtifacts(st.sessionFile).catch(() => null)
      /* 读盘期间也要复核：不一致就整帧退场，绝不把旧链历史贴到新会话。 */
      if (runners?.agentOf(id) !== ag || !sameRuntimeEnvelope(runners?.runtimeOf(id), expected)) return
      /* 只接受“真的不更短”的链历史：读盘给空时不能把界面清空 */
      if (chain?.messages?.length && chain.messages.length >= payload.length) payload = chain.messages
    }
    pushFrom(id, { ch: 'sync', payload }, expected)
  } catch {
    /* 拿不到就当空会话，下一次事件会补 */
  }
  void ag
    .refreshStats({ expectGeneration: expected.generation })
    .then((stats) => {
      if (stats) pushFrom(id, { ch: 'stats', payload: stats }, expected)
    })
    .catch(() => {})
  void ag.refreshTodos().catch(() => {})
  /* 工作模式跟随实例推送：切会话 / 新建 / 启动都经这里，一处覆盖所有路径 */
  await pushWorkMode(id)
  await pushAgentProfile(id)
  if (runners?.agentOf(id) === ag && sameRuntimeEnvelope(runners?.runtimeOf(id), expected)) {
    pushFrom(id, { ch: 'goal', payload: emptyGoal() }, expected)
  }
  pushRunners()
}

/**
 * 退出前的清理：收好 pi 子进程 —— 否则会留下孤儿 node 进程。
 */
let shuttingDown = false
let releaseDesktopDataRoot: (() => Promise<void>) | undefined
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  scheduleService.stop()
  await closeAgentService().catch((error) => reportMainError('agent-service-shutdown', error))
  disposeKeepAwake()
  attention?.dispose()
  auxWindows?.dispose()
  panePopout?.dispose()
  paneTerminal?.dispose()
  paneBrowserTransfer?.dispose()
  try {
    await remoteAccess?.stop()
  } catch {
    /* 远程客户端已断开；退出流程不能被监听器关闭失败阻塞 */
  }
  remoteAccess = null
  /*
   * 退出时必须收掉**所有**运行实例（N12）：现在可能同时有好几个
   * pi 子进程在跑，只停当前视图那个会留下孤儿进程。
   */
  try {
    await runners?.stopAll()
  } catch {
    /* 已死 */
  }
  /* A7：实例已停，启动见证作废；同时关掉 MCP Apps 宿主连接池，不留连接。 */
  /* MCP App 视图：先清实例与 store，再关宿主连接池（避免残留 iframe 读旧快照）。 */
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
    /* 连接池已关 */
  }
  /* 退出前把子代理一起收掉（方案 8.3：主任务停了，它的子任务不该变孤儿） */
  await agentHub.shutdown().catch((error) => reportMainError('agent-hub-shutdown', error))
  try {
    await subagentService.current()?.stopAll()
  } catch {
    /* 忽略 */
  }
  /*
   * 运行注册表：停监测与推送，并等编号 / 运行历史写盘结束。
   * 放在 runners.stopAll 之后 —— 进程退出信号已经归约进去，不会漏掉最后一轮。
   */
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
    /* 浏览器视图已死 */
  }
  /* 交互终端：杀掉所有 PTY，不留孤儿子壳（与 pi 子进程同一条边界） */
  try {
    disposeTerminals()
  } catch {
    /* 已经退出的会话 kill 会抛，忽略 */
  }
  await releaseDesktopDataRoot?.().catch((error) => reportMainError('data-root-unlock', error))
}

type ExitChoice = 'cancel' | 'save' | 'interrupt'
type ExitResult = { action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }

/** live 探针用环境变量选择退出分支，真实用户仍走原生对话框。 */
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

/**
 * `inkstone://` 只导航：把已校验意图投给渲染端，窗口未就绪时缓存最后一条等 flush()。
 */
const deepLinkRouter = windowDeepLinkRouter(() => win ?? undefined, showMainWindow)

/* macOS：协议可能在应用 ready 之前唤醒，必须在 ready 之前监听。 */
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


/**
 * 按设置（或旧的 YAN_REMOTE_* 环境变量）启动手机接入。
 * 默认关闭；设置变化时由 IPC 处理器再次调用 applyRemoteAccess。
 */
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
        artifact: remoteArtifact,
        hubSnapshot: () => agentHub.snapshot(true),
        hubAttention: () => agentHub.attention(),
        hubCommand: async (command, actor) => {
          try { return { ok: true, data: await agentHub.remoteCommand(command, actor) } }
          catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
        }
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

/**
 * 执行来自本机控制页的有限动作。
 *
 * 这条边界不开放任意 Electron/Node API：窗口输入只允许落在当前内容区域，
 * 按键只接受明确的导航键；会话消息另走显式的 `send` 动作，不隐式触发。
 */
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
      /* 控制通道发送也是「实际开始执行」的入口，同样先复核同 cwd 冲突。 */
      const active = runners?.activeRunner()
      if (active) {
        const guard = runners!.guardExecute(active.id)
        if (!guard.ok) return { ok: false, action: command.action, error: guard.error }
      }
      /* 控制通道在入口钉住目标实例，发送用 agentOf(id)，不再全局 ac() 重读。 */
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

/** 真正退出应用；关闭按钮不进入这里，只负责隐藏到托盘。 */
function requestExit(): Promise<ExitResult> {
  /*
   * 已经进入退出流程：如实告诉调用方「不用再请求了」。
   * 这里以前返回 `interrupt-exit` —— 但它不是**这次请求**的结果，
   * 界面上会把「重复点击」显示成「已按中断退出」（preload 的类型里
   * 本来就有 `already-exiting` 这一档，只是主进程从没返回过）。
   */
  if (isQuitting) return Promise.resolve({ action: 'already-exiting' })
  if (exitRequestInFlight) return exitRequestInFlight

  const task: Promise<ExitResult> = (async (): Promise<ExitResult> => {
    const busy = runners?.hasBusy() === true || agentHub.hasLiveWork()
    let choice = probeExitChoice()
    if (!choice && busy && win && !win.isDestroyed()) {
      const response = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '退出砚',
        message: '仍有会话正在运行。请选择退出方式。',
        detail: ['保存并退出会记录运行实例快照；中断退出会立即停止当前任务。取消会继续把窗口留在托盘。', agentHub.exitDetail()].filter(Boolean).join('\n\n'),
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
  /* Windows 用多尺寸 ICO：任务栏 24px 等小尺寸取像素对齐的那一档，而不是把 512 缩下来 */
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconCandidates = [
    join(app.getAppPath(), 'build', file),
    join(__dirname_, '..', '..', 'build', file),
    join(app.getAppPath(), 'build', 'icon.png')
  ]
  return iconCandidates.find((candidate) => existsSync(candidate))
}

/**
 * 托盘字形（设计规范 §3.4.1）：无底砖的单色标志，按**系统任务栏**的深浅选浅色或深色字形。
 * 砖形应用图标缩到托盘尺寸会糊成一块，所以托盘单独一套；@1.5x/@2x 由 nativeImage 按文件名自动挑。
 */
/** 系统任务栏深浅 → 托盘字形主题。 */
function trayTheme(): TrayTheme {
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'on-dark' : 'on-light'
}

/** 托盘 build 目录候选（dev 与 packaged 都要能命中；packaged 走 app.asar 内 build/tray）。 */
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

/*
 * 预载托盘动画素材（L12）。缺 manifest / 坏 manifest 由 store 失败封闭，
 * 托盘保持上面的静态精修标志。预载之后 timer 回调不再触达这里。
 */
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

/* Agent 生命周期 */
function projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return settings.projects.find((project) => normalize(project.cwd) === normalize(cwd))?.id
}

/**
 * 知识身份 / 能力面用的 projectId —— **未登记时也一定返回一个稳定值**。
 *
 * 两个入口（`AgentController.capability.projectId` 与设置页的 `yan:knowledge:*`）
 * 必须用**同一个表达式**：否则会出现最难查的那类 bug —— 模型 `yan knowledge propose`
 * 写进去的条目，用户在设置页看不到（或反过来）。
 *
 * 未登记时不能直接回退到裸 `legacyProjectId`：旧算法只取路径前 **27 字节**，
 * 而工作树通常就建在仓库旁边（`<repo>` 与 `<repo>-worktrees/feat`），前 27 字节
 * 完全相同 —— 于是**工作树与主仓库共用一个 id**，工作树会话直接读到主仓库的知识，
 * 而实施-03 §4 要求「工作树默认是独立项目知识空间」。
 *
 * 所以这里与 `settings.sanitizeProjects` 给登记项目选 id 的规则保持一致：
 * cwd 派生的 id 已被**别的** cwd 占着时，改用整条路径的哈希（`projectIdForCwd` 的碰撞退路）。
 */
function knowledgeProjectId(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string {
  const registered = projectIdForCwd(settings, cwd)
  if (registered) return registered
  return deriveProjectId(cwd, (id) => settings.projects.some((project) => project.id === id))
}

/**
 * 所有会话入口共用的 cwd 边界（N05）。
 *
 * 不能只在设置页校验：会话列表、项目切换和旧版 switchSession 都能
 * 直接把路径送到主进程。统一在这里确认目录存在且可访问，并返回绝对
 * 路径，避免后续 runner 以相对路径启动到意外位置。
 */
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

/** 批准后仅为原会话移动一次；正常结束时由宿主续接，不依赖当前前台或重复用户请求。 */
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

/** 等原实例空闲后移动；重复通知不重入，人工停止/模型失败只能移动，不能自动续跑。 */
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
    // 停止的是批准时捕获的实例，不能按当前前台重新寻找执行目标。
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

/**
 * 文件树 / @ 补全 / 全项目搜索共用的主进程边界。
 *
 * renderer 可以传入迟到的旧 cwd，所以不能只相信 settings.cwd；同时也不能
 * 只相信 projectId，因为产品归属与 JSONL 的物理 cwd 允许暂时不同。这里把
 * cwd 先验证成真实存在的目录，再检查显式 projectId 是否确实指向这棵目录。
 */
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
      /*
       * 旧设置里可能存在两个 cwd 共用一个 id（同前缀目录 + 旧的项目 id
       * 截断算法，见 project-id.ts 的 D14 说明），按 id `find` 命中的是
       * 另一条记录。这里按 cwd 再确认一次：确实存在匹配这个 cwd 的项目
       * 记录才继续（并且把它的 id 回带），否则仍然拒绝。
       */
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

/** 运行实例切换成功后记录产品归属；物理会话文件仍由 pi 管理。 */
async function rememberRunnerSession(
  result: { ok: boolean; id?: string; sessionId?: string },
  target: { sessionFile?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }
): Promise<void> {
  if (!result.ok || !result.sessionId) return
  const state = result.id ? runners?.agentOf(result.id)?.getState() : undefined
  /*
   * 这条会话是不是跑在**自动隔离**的工作树里：跑在的话把稳定 sessionId 补登记。
   * 建树时新会话还没有 id（pi 异步落盘），只有这里能把两者绑上；
   * 绑上之后同一条会话再撞冲突就能复用同一个工作树，不会越建越多。
   */
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

/**
 * 等 pi 报出会话文件（新建会话的路径由 pi 决定，异步落地）。
 *
 * 不能拿「select 成功了」当「文件有了」：交接要把它写进会话链与事务日志，
 * 写一个不存在的路径会让侧栏指向一个没人能打开的东西。
 */
async function waitForSessionFile(runId: string, timeoutMs = 10_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const file = runners?.agentOf(runId)?.getState()?.sessionFile
    if (file && normalizeSessionFileKey(file)) return file
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * 交接专用的「打开会话」实现（§8 第 4 步）。
 *
 * 与界面切会话走同一条路（`runners.select`），所以同 cwd 防线、实例上限、
 * cwd 更换要重建进程这些既有规则一条也不会绕过 —— 交接不是特权路径。
 * `cwd` 为空 = 崩溃恢复路径，用当前项目目录兜底（恢复只是把实例接回来）。
 */
async function openHandoffSession(target: HandoffSessionTarget): Promise<HandoffSessionHandle> {
  if (!runners) return { ok: false, error: 'pi 未运行' }
  const settings = await getSettings()
  const cwdResult = await validateCwd(target.cwd || settings.cwd)
  if (!cwdResult.ok) return { ok: false, error: cwdResult.error }
  const projectId = target.projectId ?? projectIdForCwd(settings, cwdResult.cwd)
  const rollback = target.sessionFile ? [...handoffPending.entries()].find(([, op]) => op.request.sessionKey === normalizeChainKey(target.sessionFile!)) : undefined
  const res = await runners.select({
    cwd: cwdResult.cwd,
    ...(projectId ? { projectId } : {}),
    ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}),
    ...(!target.sessionFile ? { activate: false, hidden: true } : rollback ? { activate: false } : target.activate === false ? { activate: false } : {})
  })
  if (!res.ok || !res.id) return { ok: false, error: res.error ?? '打开会话失败' }
  if (rollback) rollback[1].destinationRunId = res.id
  if (target.sessionFile) await rememberRunnerSession(res, {
    ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}),
    ...(projectId ? { projectId } : {}),
    cwd: cwdResult.cwd,
    scope: projectId ? 'project' : 'global'
  })
  pushRunners()
  const sessionFile = await waitForSessionFile(res.id)
  if (!sessionFile) {
    if (!target.sessionFile) await runners.stopOne(res.id)
    return { ok: false, error: '新会话文件还没落地' }
  }
  if (rollback) await publishHandoffReplacement(rollback[0], res.id)
  else void pushRunnerSnapshot(res.id)
  return { ok: true, runId: res.id, sessionFile }
}

/**
 * 启动时的交接崩溃恢复（§8 第 6/7 条）。
 *
 * **不受提交开关影响**：开关只决定「要不要开始新的交接」，而磁盘上已有的
 * 未终结事务（上一次开着的时候产生的）必须收尾 —— 否则重启后会出现
 * 「日志说已提交、但没人接着干」的静默停住。
 */
async function recoverHandoffs(): Promise<void> {
  try {
    const actions = await handoffRunner.recover()
    for (const item of actions) {
      console.log(`[handoff] 恢复 ${item.handoffId}: ${item.action} → ${item.stage}`)
    }
  } catch (error) {
    console.error('[handoff] 恢复交接事务失败：', error)
  }
}

/**
 * 启动 pi 的**单飞**（single-flight）锁。
 *
 * 为什么需要：应用启动（app.whenReady）与「界面语言变了要重启」都会调
 * startAgent；两者可能交叠 —— 后一个会把 agent 换成新实例，而前一个的开始
 * 流程还在跑，等它超时后会拿一个已经作废的实例去 setConn('error')，
 * 把新实例的 ready 覆盖掉（旧连接状态推给了同一个界面）。
 * 串行化后同一时刻只会有一个启动流程，旧实例不会再反过来污染状态。
 */
let starting: Promise<{ ok: boolean; error?: string }> | null = null
/** 当前设置的回复详细程度；每个 Agent 回合自己在 agent_start 时取快照。 */
let agentResponseDetail: 'brief' | 'standard' | 'detailed' = 'standard'

/**
 * 「扩展来源」诊断只报一次。
 *
 * 扩展目录在应用运行期间不会变，而 `startAgent` 会被语言切换 / 重连等路径
 * 反复调到 —— 每次重启都刷一遍会让日志分区变成噪声。
 */
let extensionSourcesReported = false

/**
 * 把「谁在给这个 pi 实例加东西」写进日志（实施-02 S1 的诊断出口）。
 *
 * 为什么必须有一份：任务工具迁移的过渡期里，用户扩展与砚薄层可能同时存在，
 * 出问题时（清单跳变 / 历史对不上）第一件事就是分辨是谁写的。
 * 这里只**如实列举**，不做修复、不禁用、不删（判据见 extensions-inventory.ts 头注释）。
 */
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
  /* 重新建立主 runner 集合时，所有新进程都读取当前设置。 */
  await runners?.stopAll()
  await subagentService.current()?.stopAll()

  const settings = await getSettings()
  /* 受管 Git：系统没有 git / bash 时把已装的那份接进本进程的 PATH（砚与 pi 子进程都继承） */
  await refreshManagedGit().catch(() => undefined)
  agentResponseDetail = settings.responseDetail
  /* 工作模式（实施-05）：新会话的初值；已存过的会话仍用会话自己的值 */
  setDefaultWorkMode(settings.defaultWorkMode)
  /* 上下文策略的设置层（N21-7）：新起的 pi 实例直接按这份策略跑 */
  setContextPolicySettings({
    user: settings.contextPolicy,
    byModel: settings.contextPolicyByModel,
    /* `undefined` 语义留在设置层里（= 没改过 = 按默认开），所以这里先归一成布尔 */
    foldEnabled: settings.contextFold?.enabled !== false
  })
  /* 把同一份覆盖交给薄层（C-4）：扩展按它算阈值，与界面说的同一个数 */
  void syncEffectivePolicyFile(YAN_DIR, {
    user: settings.contextPolicy,
    byModel: settings.contextPolicyByModel,
    foldEnabled: settings.contextFold?.enabled !== false
  })

  runners = new RunnerRegistry({
    isSessionVisible: (state) => runnerVisibility.includes(state),
    isParentProtected: (sessionId, runId) => subagentService.current()?.hasParentRun(sessionId, runId) ?? false,
    /* 选择 / 复用 runner 后同步绑定定时来源，早于早期标题 / 状态信号。 */
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
      /* 实例被回收：清掉绑定它的 App 视图实例并 abort 迟到请求，不伤其它实例。 */
      mcpAppViewService?.invalidateRunnerId(id)
      const text = `[运行实例回收] ${id} (${sessionId ?? 'unknown'}) 空闲 ${Math.floor(idleMs / 1000)} 秒，释放1个 pi 实例，剩余 ${remaining} 个`
      console.log(text)
      push({ ch: 'log', payload: { text } })
    },
    prepareNewSession: async agent => {
      return applyRememberedModel(agent, (await getSettings()).lastMainModel)
    },
    /*
     * 同一工作目录冲突 → 自动隔离（用户 2026-09-25 拍板的全自动档）。
     * 建树失败**不**改变原来的冲突报错，只把原因并进去 —— 防线本身不降级。
     */
    isolationOf,
    resolveCwdConflict: async (target) => {
      /* 后台 / 隐藏实例（交接、远程定向）不是「用户要开第二份工作」，不擅自换目录 */
      if (target.activate === false || target.hidden) return null
      /*
       * 实例已经到上限：**先别建工作树**。
       * 隔离在底下那道上限判断之前发生，建完才发现开不了实例，磁盘上就白多一个目录。
       */
      if (runners && runners.size >= runners.limit) return null
      /* 同一条会话再次撞上冲突：复用它已有的隔离工作树，别越建越多 */
      const existing = target.sessionId ? await autoIsolations.bySession(target.sessionId).catch(() => null) : null
      if (existing) return { cwd: existing.worktree }
      const outcome = await isolateCwdForConflict(target.cwd, { sessionId: target.sessionId })
      if (!outcome.ok) return { reason: outcome.reason }
      await autoIsolations.add(outcome.record).catch(() => undefined)
      /* 刚建出来的隔离树一定是「等主干空闲」（主干正忙着才走到这里） */
      setIsolationView(outcome.record.worktree, { state: 'waiting', branch: outcome.record.branch })
      return { cwd: outcome.record.worktree }
    },
    /* 每个实例自己一个 pi 子进程；事件带上实例 id（N12） */
    createAgent: (id, cwd, generation) =>
      new AgentController({
        push: (m) => pushFrom(id, m),
        /* 运行注册表旁路（v3 WP-10）：只收压缩后 run signals，不影响 pi 循环。 */
        observeRun: runsHost?.observerFor({ generation }) ?? undefined,
        cwd,
        piBin: settings.piBin,
        codemodeExtension: codemodeExtensionPath(),
        questionExtension: questionExtensionPath(),
        shellFallbackExtension: shellFallbackExtensionPath(),
        responseDetailExtension: responseDetailExtensionPath(),
        getResponseDetail: () => agentResponseDetail,
        /*
         * `yan browser …` 的实现入口（01-S4b）。
         *
         * 传 getter 而不是实例：agent 实例会随切会话反复重建，
         * 而浏览器控制器是模块级单例 —— 每次取当时那个。
         */
        browserHost: () => browser,
        /* 模型通过 `yan subagent …` 进入同一套全局控制器。 */
        subagentHost: subagentService.capabilityHost,
        scheduleHost: scheduleService,
        /* 目标状态（实施-05 S3）：会话键与模式 store 都在本文件一侧。 */
        preambleExtension: preambleExtensionPath(),
        languageExtension: languageExtensionPath(),
        temperatureExtension: temperatureExtensionPath(),
        capabilityGuideExtension: capabilityGuideExtensionPath(),
        contextInspectExtension: contextInspectExtensionPath(),
        contextTrimExtension: contextTrimExtensionPath(),
        nativeSessionExtension: nativeSessionExtensionPath(),
        /*
         * 托管 MCP 工具的模型代理：薄层路径 + 新鲜快照路径。
         * 快照缺失 / 过期时 mcpAppProxyToolsEnv() 返回空对象 → 不注入 env，
         * 薄层不注册任何托管工具，等用户在设置里刷新（不默认连接服务器）。
         */
        mcpAppProxyExtension: mcpAppProxyExtensionPath(),
        mcpAppToolsSnapshot: mcpAppProxyToolsEnv().YAN_MCP_APP_TOOLS,
        /* 单轮重复动作兜底（2026-09-22）：拦下在薄层，计入目标失败签名在宿主 */
        repeatGuardExtension: repeatGuardExtensionPath(),
        dangerGuardExtension: dangerGuardExtensionPath(),
        providerExtensions: providerExtensionPaths(),
        bundledSkills: bundledSkillPaths(),
        /* 用户技能（YAN_DIR/skills）：每次启动会话时重新列出 */
        userSkills: () => userSkillPaths(),
        /*
         * 界面历史（实施-05 S5b-4）：交接过的会话在链上，按段从旧到新拼成
         * **一条时间线**。agent 不认识「链」—— 那是宿主的关系。
         */
        readHistory: (sessionFile) => readHistoryWithArtifacts(sessionFile),
        /*
         * 宿主能力服务：模型经 `yan` CLI 触达砚的能力（见 capability-server.ts）。
         *
         * `sessionId` 用 runner 实例 id：端点与它绑定，切会话 / 重建 pi 就换一份 token。
         * `projectId` 按该实例的 cwd 算，所以不同项目跑的主实例互相看不到对方的数据。
         */
        capability: {
          sessionId: id ?? 'primary',
          runnerGeneration: generation ?? 1,
          /*
           * 项目 id 必须存在（要与 CLI 回传的值逐一比对）。
           * 设置里查不到时用 cwd 派生一个稳定的：
           * 能力服务宁可绑一个「未登记但唯一」的 id，也不能绑空值 ——
           * 空值会让校验退化成「只要格式对就放行」。
           */
          projectId: knowledgeProjectId(settings, cwd),
          opsDir: join(YAN_DIR, 'ops'),
          binDir: join(YAN_DIR, 'bin'),
          artifactDir: join(YAN_DIR, 'artifacts'),
          devResourcesDir: join(app.getAppPath(), 'resources'),
          getWorkMode: async () => (await resolveWorkMode(id ?? 'primary')).mode,
          getCapabilityStrategy: async () => (await getSettings()).capabilityStrategy,
          /*
           * 同步执行入场：Agent 在 send / steer / followUp / runBash 入口 claim，
           * 真正入队前 confirm，失败 / 回合结束时 release。它只保障同一物理 cwd 不
           * 同时开始执行，不是文件级锁。
           */
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
        /*
         * `--authorize` 只能请求显示这条主进程对话框，本身不构成同意。
         * 远程 host 授权与本地代码执行授权分开；后者还单独选择是否允许运行
         * npm lifecycle scripts。若 Pi 项目尚未信任，允许本地包也会明确说明
         * 并持久写入 cwd 到 trust.json（这是加载项目资源所必需的宽权限）。
         * 对话框没有可用窗口时一律拒绝。
         */
        confirmCapabilityAuthorization: async (
          request: CapabilityAuthorizationPrompt
        ): Promise<CapabilityAuthorizationChoice> => {
          const endpointUrl = request.endpoint ? new URL(request.endpoint) : null
          const loopback =
            endpointUrl &&
            (endpointUrl.hostname === 'localhost' ||
              endpointUrl.hostname === '127.0.0.1' ||
              endpointUrl.hostname === '[::1]')
          /*
           * cost-0 `mcpregister` 的隔离 fixture 不能点原生 UI。仅在隐藏 live 探针、
           * 显式 test flag、精确 fixture 候选与 loopback 端点四项同时满足时模拟允许；
           * 生产 UI 不读这个 flag，也不允许任意远程 host 走该分支。
           */
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
        /*
         * 高危操作确认（danger-guard 薄层发起）：走输入框上方的批准卡片；高危每次都问、
         * 不记忆，关不掉的卡片超时按拒绝。只有项目外写入可「记住目录」。
         */
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
        /*
         * 普通工具使用前的询问（需求稿 4.3）。没有答复不记录（返回 null）；
         * 只有点「允许」或「拒绝」才写进同意记录。
         */
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

  /* 重启后先把登记表里的隔离标记铺上；真实状态（已合回 / 被挡）由第一轮扫描修正 */
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
      goals,
      runners: {
        activationSnapshot: (target) => runners?.activationSnapshot(target) ?? null,
        agentOf: (id) => runners?.agentOf(id) ?? null,
        restartOne: async (id) => {
          /* 重启前主动作废绑定该实例的 App 视图；完成后 gate 还会按新 generation 复核。 */
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
  /*
   * 主实例直接建在「要接回来的那个会话」上（restartAgent 传进来）。
   * 不能先建一条新会话再 switch：那样界面会先收到一次**空会话**的 sync，
   * 当前会话的历史当场就被清掉（D37）。
   */
  const res = await runners.startPrimary(settings.cwd, restore?.sessionFile, projectId)
  await rememberRunnerSession(res, {
    cwd: settings.cwd,
    projectId,
    scope: 'project',
    ...(restore?.sessionFile ? { sessionFile: restore.sessionFile } : {})
  })
  pushRunners()
  /* 接回来的会话要把内容推给渲染端（switch 路径自己会推，start 路径不会） */
  if (res.ok && res.id) await pushRunnerSnapshot(res.id)
  /*
   * 未终结的交接事务在启动时收尾（§8 第 6 条）。
   * 放在推快照**之后**：恢复可能把视图切到目的会话，那一次切换自己会再推一帧。
   */
  if (res.ok) await recoverHandoffs()
  requestPiPackageActivationTick()
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/**
 * 重启 pi 子进程，并把当前会话接回来（不丢历史）。
 *
 * 触发场景：应用内登录 ChatGPT —— pi 只在**启动时**读 `auth.json`，
 * 长跑的进程不会因为文件变了就重读，所以登录成功后必须重建。
 * （界面语言**不再**走这条路：语言由扩展每轮注入，见
 *  `resources/pi-extensions/language.js`。）
 *
 * ⚠️ 一定要等**这一轮跑完**再重启：跑的时候重启会直接掐断正在生成的内容。
 *    所以忙的时候每隔一会儿再试，直到空闲（最多等 ~5 分钟）。
 *
 * ⚠️ 重启会把主实例重建到一条**新会话**上，所以必须把当前会话文件带上
 *    （`startAgent(restore)`），否则界面会停在一条空会话上（D37）。
 */
let agentRestarting = false
/* 重启期间又来了新的变更（例如连续保存两个 key）：本轮结束后必须再重启一次 */
let agentRestartQueued: string | null = null

/**
 * 模态层守卫（渲染端上报）。
 *
 * true = 有弹窗/对话框打开，`before-input-event` 里**不再**拦 Shift+Tab /
 * Ctrl+P —— 否则设置面板里的表单做不了反向焦点导航（Shift+Tab 被抢走
 * 去切思考强度）。缩放快捷键不受此影响。
 *
 * 放在模块级而不是 createWindow 里：IPC 监听在 registerIpc 注册，
 * 与窗口生命周期无关；窗口重载时由 yan:renderer-ready 重置。
 */
let hotkeyGuardPaused = false
async function restartAgent(reason: string, retries = 150): Promise<void> {
  if (agentRestarting) {
    agentRestartQueued = reason
    return
  }
  /* 启动还没跑完就别动它 —— 等它落定再判断要不要重启 */
  if (starting) await starting
  if (!runners) return
  /*
   * 只要有**任何一个**实例在干活就不能重启（N12）：重启会抦断的不只是
   * 眼前这个会话，后台会话的流也会一起断。一直等到全部空闲。
   */
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
    /* 带上当前会话文件重建：主实例直接落在它上面，不停在空会话（D37） */
    const res = await startAgent(file ? { sessionFile: file } : undefined)
    /*
     * 双保险：startPrimary 已经切过会话了，但那条路径失败时（例如会话文件
     * 刚被删）不能让界面停在别处 —— 再试一次显式 switch，并把结果说出来。
     */
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

/* IPC */

/**
 * 路径比较用的归一化（Windows 大小写不敏感，且分隔符混用）。
 * 只为「是不是同一个目录」服务，不做解析。
 */
function samePathKind(a: string, b: string): boolean {
  const norm = (v: string): string => String(v ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function registerIpc(): void {
  /*
   * 切分支前必须知道「这个目录有没有在跑的任务」（方案 §5.1）。
   *
   * 判据用 runner 的 cwd + running：正在跑的回合可能正在读写工作区文件，
   * 中途把分支换掉，它会读到一半新一半旧的代码 —— 表现成「模型把代码改坏了」。
   * 渲染端也会拦一道（给出更早的提示），但**真判据在这里**：界面路径可以被绕过，
   * 主进程是最后一道。
   */
  configureWriteContext({
    hasRunningTask: (cwd) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, cwd))
  })


  /**
   * IPC 来源校验（方案 9.2）。
   *
   * 只接受**主窗口渲染进程**的调用：浏览器视图是另一个 webContents
   * （而且没有挂 preload），远程网页无法伪造这条通道。
   * 显式比较 `sender === win.webContents` 比信任 `senderFrame.url`
   * 更直接 —— 后者只是字符串，而这里比的是真实的进程对象。
   */
  /* 所有处理器共用来源校验：只接受主窗口的调用（见 ipc/registrar.ts） */
  const isTrustedIpc = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  const ipc = createIpcRegistrar(isTrustedIpc)
  const { handle, rawHandle } = ipc

  /* ---- 会话 ---- */
  handle('yan:start', async () => {
    const settings = await getSettings()
    const res = await startAgent()
    return { ...res, state: ac()?.getState() ?? undefined, settings }
  })

  handle('yan:send', async (text: string, images?: { data: string; mimeType: string }[], mode?: 'steer' | 'followUp', expectedInput?: unknown) => {
    /*
     * 归属检查在入口同步完成：有 expectedRuntime 就精确按 run/gen 定位（不盲用
     * active、不改视图、不切 cwd）；旧调用不传时也在入口钉住当时的 active，
     * 后面的 await 不再全局读 active 猜目标。
     */
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid') return { ok: false, error: '发送目标身份无效，消息未发送' }
    let targetId = expected ? resolveExpectedTarget(expected) ?? undefined : runners?.activeRunnerId
    if (expected && !targetId) return { ok: false, error: '目标会话已不在或已切换，消息未发送；草稿已保留' }
    const handoffEntry = targetId ? [...handoffPending.entries()].find(([sourceId, op]) => sourceId === targetId || op.destinationRunId === targetId) : undefined
    const handoff = handoffEntry?.[1]
    /*
     * 入口同步钉住目标**当时的真实身份**：partial（只有 runId / sessionId）与
     * 缺省 expected 的旧调用只核调用方给的维度，识别不了 await 期间同 runId
     * 的复用；补上入口 pin 后，这些输入也按完整 tuple 复核。
     */
    let pin = targetId ? pinSendTarget(targetId) : null
    /* await 之后复核：调用方给的维度 + 入口钉住的真实身份，任一不符都算换身份。 */
    const sendOwnershipChanged = (id: string | null | undefined): boolean =>
      (!!expected && (!id || !targetMatchesExpected(id, expected))) || (!!id && !!pin && !pinnedTargetMatches(pin))
    /*
     * 需要迁移到 handoff 目的时，入口也同步钉住**目的当时**的真实身份；settled
     * 后先拿它复核目的没被复用，再按目的重新钉住供后续 await 复核。不能只钉
     * source、settled 后把 source 的 pin 盲套到 dest 上。
     */
    const handoffDestPin = handoff?.destinationRunId && handoff.destinationRunId !== targetId
      ? pinSendTarget(handoff.destinationRunId)
      : null
    if (handoff?.collecting) {
      await handoff.settled
      if (expected && (!targetId || !targetMatchesExpected(targetId, expected))) {
        return { ok: false, error: '目标会话在等待交接时已变化，消息未发送；草稿已保留' }
      }
      if (handoff.cancelled) return { ok: false, error: '交接已停止，请重新发送' }
      const destinationId = handoff.destinationRunId
      if (destinationId) {
        /* 目的在入口钉住后到 settled 之间被复用 → 明确失败，不把消息发给别的会话 */
        if (handoffDestPin && !pinnedTargetMatches(handoffDestPin)) {
          return { ok: false, error: '目标会话在等待交接时已变化，消息未发送；草稿已保留' }
        }
        /*
         * 合法迁移：目的身份可能与入口 source 不同，必须按**目的此刻**的真实身份
         * 重新钉住，后续 await 再核目的；不能拿 source 的 pin 盲套 dest。
         */
        targetId = destinationId
        pin = pinSendTarget(targetId)
        if (!pin) return { ok: false, error: '目标会话在等待交接时已变化，消息未发送；草稿已保留' }
      } else if (pin && !pinnedTargetMatches(pin)) {
        /* 没有目的可迁移：原目标必须保持原身份 */
        return { ok: false, error: '目标会话在等待交接时已变化，消息未发送；草稿已保留' }
      }
      if (targetId && handoffPending.get(targetId) === handoff) {
        await abandonHandoff(targetId, 'user-message', handoff.request.operationId)
      }
    } else if (handoff && targetId) {
      await abandonHandoff(handoffEntry![0], 'user-message', handoff.request.operationId)
    }
    if (sendOwnershipChanged(targetId)) {
      return { ok: false, error: '目标会话在等待时已变化，消息未发送；草稿已保留' }
    }
    if (handoff && targetId && !runners?.agentOf(targetId)?.running) {
      return { ok: false, error: '会话正在恢复，请稍后重新发送' }
    }
    if (!expected && (!targetId || !runners?.agentOf(targetId)?.running)) {
      /*
       * 旧调用：入口没钉住目标且当前没有运行实例时，走原有启动兜底。
       * 钉住 expectedRuntime 的调用不复用这段 —— 目标实例即使暂时空闲也是有效目标，
       * 直接对它 send 即可，不能因此被换成别的 active。
       */
      const r = await startAgent()
      if (!r.ok) return r
      targetId = runners?.activeRunnerId
      /* 启动兜底后的目标同样要在下一个 await 前钉住真实身份 */
      pin = targetId ? pinSendTarget(targetId) : null
    }
    if (sendOwnershipChanged(targetId)) {
      return { ok: false, error: '目标会话已不在或已切换，消息未发送；草稿已保留' }
    }
    const id = targetId
    /*
     * 命中已有实例（hit）时 select 不经过同 cwd 冲突扫描，发送前在这里补一次只读复核：
     * 同 cwd 另有忙碌实例就拒绝本次发送，避免开第二个写者。发起者自己的插话 / 排队由
     * `guardExecute` 放行；只拒绝，不停别的会话、不把消息转投别的会话。
     */
    if (id) {
      const guard = runners?.guardExecute(id)
      if (guard && !guard.ok) return guard
    }
    /*
     * 检查点：新一轮开始前给项目目录存一份快照（排队、插话不算新一轮）。
     * 快照在后台拍，发送不等它：用户消息上屏与模型开始都不被项目大小拖慢。
     * 先于 send 启动，小项目在模型首包（至少数百毫秒）之前就已拍完；
     * 大项目的 git add 可达数秒，则与首次改文件并行，快照可能带上本轮的头几处改动。
     */
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
    /* 最后一次 await 之后再核一遍：目标换了就明确失败，不把消息发到别的实例。 */
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
  handle('yan:abort', async () => {
    // 把 clear_queue 拿回来的排队文本一并返回，客户端应放回输入框
    return stopRunnerWithHandoff(runners?.activeRunnerId ?? null, ac())
  })

  /*
   * 放弃目标（实施-14 A2）：与「按停止」分开的显式入口。
   *
   * 语义区别：`yan:abort` 是「现在别跑了」（paused，可恢复），
   * 这里是「这件事不做了」（phase → stopped，终态）。
   * 界面按钮在 F5 接；先固定宿主与语义，避免只有暂停、没有放弃。
   */
  handle('yan:stopGoal', async () => {
    const id = runners?.activeRunner()?.id
    if (!id) return { ok: false, error: 'pi 未运行' }
    await goals.load()
    const key = workModeKeyFor(id)
    const goal = await goals.stop(key, null)
    /* 目标作废的同时把薄层可见的续行也清掉（只清存储不够，快照照样会被发出去） */
    await applyGoalResume(id)
    await pushGoal(id)
    handoffDiag.record({
      stage: 'goal-continue',
      outcome: 'goal-stopped',
      reason: 'user-stop-goal',
      runnerId: id,
      sessionKey: key,
      detail: { goalId: goal?.goalId ?? null }
    })
    return { ok: true, goal }
  })

  /* ---- 直执行 bash ---- */
  handle('yan:runBash', async (command: string, options?: { excludeFromContext?: boolean }, expectedInput?: unknown) => {
    if (typeof command !== 'string' || !command.trim() || (options !== undefined && (!options || typeof options !== 'object' || (options.excludeFromContext !== undefined && typeof options.excludeFromContext !== 'boolean')))) return { ok: false, error: '命令参数无效' }
    /* 直执行 bash 同样会写工作目录，且按 expectedRuntime 精确定位目标实例。 */
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
          /* 读盘期间切走会话 / 换代次：旧消息不再属于这个视图，不推（F03 同一口径）。 */
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
  /* 启动后空闲时清掉过期的检查点 */
  setTimeout(() => void pruneCheckpoints().catch(() => undefined), 60_000).unref?.()

  /* ---- 模型 / 思考 ---- */
  /* 把自动压缩上限同步给 pi 原生压缩线（说明见 native-compaction-line.ts）；失败只影响长任务中途的压缩线 */
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

  /* ---- 开关 ---- */
  handle(
    'yan:setAutoCompaction',
    async (enabled: boolean) => ac()?.setAutoCompaction(enabled) ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:setAutoRetry',
    async (enabled: boolean) => ac()?.setAutoRetry(enabled) ?? { ok: false, error: 'pi 未运行' }
  )

  registerGoalIpc(ipc, {
    registry: () => runners,
    workModes,
    handoffs,
    handoffTransactions,
    sessionChains,
    handoffDiag,
    pushFrom,
    scheduleSessionWork
  })

  /* 会话级提问频率覆盖：与工作模式共用存储 / 快照，独立注册以便单独核对身份 */
  registerQuestionFrequencyIpc(ipc, {
    registry: () => runners,
    workModes,
    workModeKeyFor,
    globalQuestionFrequency: async () => normalizeQuestionFrequency((await getSettings()).questionFrequency),
    pushFrom
  })

  registerSpaceIpc(ipc, { registry: () => runners, agentProfiles, spaces })

  /* ---- 队列模式 / 轮换（pi 自带能力，TUI 里都有对应快捷键） ---- */
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

  /* ---- pi 环境（版本 / 入口） ---- */
  handle('yan:approvalAnswer', async (id: string, choice: unknown) => ({ ok: approvals.answer(String(id ?? ''), choice) }))
  handle('yan:approvalPending', async () => approvals.list())
  handle('yan:piInfo', async () => {
    const s = await getSettings()
    return piInfo(s.piBin)
  })

  /**
   * 重新探测 pi。
   *
   * 除了刷新展示，还有一个实际作用：如果 pi 在一开始没找到（agent 启动失败），
   * 用户装好后点重新检测，这里把 agent 拉起来 —— 不用重启应用。
   * agent 已经在跑时只刷新信息，不动正在进行的会话。
   */
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

  /* ---- 状态 ---- */
  handle('yan:getState', async () => ac()?.getState() ?? null)
  /*
   * 运行注册表（v3 WP-10 / WP-54）。
   *
   * snapshot 必须**先 flush** 待发增量再返回，使返回的 revision 与刚推送的
   * 那一帧一致；渲染端先订阅、再取快照，随后只回放 revision 更大的增量。
   * runsHost 此时可能还没初始化（registerIpc 在 whenReady 里早于它执行），
   * 所以 deps 惰性读取：未就绪时 snapshot 返回空表，stop 一律不命中。
   */
  registerRunsIpc(ipc, {
    snapshot: () => runsHost?.snapshot() ?? { revision: 0, runs: [] },
    markSeen: (runId) => runsHost?.markSeen(runId) ?? { ok: false },
    /*
     * 会话运行的停止就是界面停止按钮那条路：按稳定 sessionId 找实例，
     * 调同一个 AgentController.abort()（先 clear_queue 再 abort），不新造循环。
     */
    stopSessionRun: async ({ sessionId }) => {
      const agent = runners?.agentForSession(sessionId) ?? null
      if (!agent) return { ok: false, error: '找不到这次运行对应的会话实例' }
      /*
       * 与界面停止按钮逐字同路：先按实例反查 runner id（含隐藏实例），
       * 取消挂在该运行上的交接，再 abort，并把 clear_queue 排队文本交回
       * 渲染端放回输入框。
       */
      const cleared = await stopRunnerWithHandoff(runners?.idOf(agent) ?? null, agent)
      return { ok: true, recovered: cleared }
    },
    /* 子 Agent 运行复用现有子代理 stop；运行 id 与子代理 id 同源。 */
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
  registerAgentServiceIpc(ipc, { currentAgent: ac })

  /* ---- 设置 ---- */  handle('yan:getSettings', async () => {
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
        // 目录更改与普通项目编辑共用写入队列，迟到的旧快照不能把目录改回去。
        for (const project of patch.projects ?? []) {
          const previous = current.projects.find((item) => item.id === project.id)
          if (previous && normalizeCwdForIdentity(previous.cwd) !== normalizeCwdForIdentity(project.cwd)) {
            throw new Error('项目文件夹已变化，请刷新后重试')
          }
        }
        return patch as never
      })
    } catch (e) {
      /*
       * 写盘失败（目录不可写、磁盘满、同名文件占住路径）：
       * 推一条错误到日志抽屉，并返回**磁盘上的旧设置**。
       * 旧实现只打日志、仍返回新设置 —— 界面显示“已保存”，重启后发现变回旧值。
       */
      reportMainError('设置', e)
      return await getSettings()
    }
    /*
     * 语言切换**不重建实例**：语言要求由内置扩展在每一轮读 desktop.json 注入，
     * 所以下一轮就生效 —— 现有会话、后备会话、新建会话一视同仁
     * （早期做法是重启 pi 实例，代价是抢掉后台会话、还会让界面短暂失去历史：D37）。
     */
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
    /* 工作模式（实施-05）：新会话默认模式改完立即生效（已存过的会话不受影响） */
    if (patch.defaultWorkMode !== undefined) setDefaultWorkMode(next.defaultWorkMode)
    /*
     * 上下文策略数值改了就当场生效（N21-7）：登记设置层 + 让所有实例重推一帧。
     * 不能等下一次回合：用户改完设置回头看右栏，工作集与“下一步”必须已经是新值，
     * 否则看起来像“改了没存”（D21/D22 同类）。
     */
    if ('contextPolicy' in patch || 'contextPolicyByModel' in patch || 'contextFold' in patch) {
      setContextPolicySettings({
        user: next.contextPolicy,
        byModel: next.contextPolicyByModel,
        foldEnabled: next.contextFold?.enabled !== false
      })
      /* 设置一改就重写交给薄层的那份（C-4），扩展下一轮就读到新值 */
      void syncEffectivePolicyFile(YAN_DIR, {
        user: next.contextPolicy,
        byModel: next.contextPolicyByModel,
        foldEnabled: next.contextFold?.enabled !== false
      })
      runners?.refreshPolicyViews()
    }
    return next
  })

  /* ---- 扩展 UI 应答（不需要返回值） ---- */
  ipcMain.on('yan:respondUi', (event, res) => {
    if (!isTrustedIpc(event) || !isObject(res) || typeof res.id !== 'string' || !res.id) return
    if (runners) runners.respondUi(res as never)
    else ac()?.respondUi(res as never)
  })

  /*
   * 延长待回答问题：倒计时在主进程抱，渲染端点「加时间」必须走到这里。
   * 不取 `ac()`（当前视图实例）：面板可能属于后台实例，按 request id 全局找。
   */
  handle('yan:extendUi', async (id: string, extraMs?: number) =>
    runners?.extendHostUi(String(id ?? ''), extraMs) ?? { ok: false, error: 'pi 未运行' }
  )

  /*
   * 「这条问题已经显示给用户了」→ 开始计时（幂等）。
   * 多条问题分页显示时，每条从**被翻到**那一刻起算，不再「还没看到就快超时」。
   */
  handle('yan:startUiTimer', async (id: string) =>
    runners?.startHostUiTimer(String(id ?? '')) ?? { ok: false, error: 'pi 未运行' }
  )

  /*
   * 模态层守卫：渲染端有弹窗时暂停全局快捷键（cycleModel / cycleThinking）。
   *
   * ⚠️ 为什么不能只在渲染端判断：Shift+Tab / Ctrl+P 是在主进程的
   *    `before-input-event` 里 preventDefault 的，**先于**渲染端。
   *    渲染端那条 window keydown 只是兑底，改它拦不住已经吃掉按键的主进程。
   *    所以必须由渲染端上报状态、主进程据此放行。
   */
  ipcMain.on('yan:hotkey-guard', (event, v) => {
    if (!isTrustedIpc(event) || typeof v !== 'boolean') return
    hotkeyGuardPaused = v
  })

  /*
   * 减少动态效果（L12）：渲染端 matchMedia('(prefers-reduced-motion: reduce)') 是
   * 系统偏好的真实通路 —— 主进程没有等价原生 API（不作为 nativeTheme 或
   * isAccessibilitySupportEnabled 的近似）。来源必须是主窗口主 frame；未收到上报前
   * trayMotionAllowed=false，托盘保持静态。
   */
  ipcMain.on('yan:motion-preference', (event, reduced) => {
    if (!isTrustedIpc(event) || typeof reduced !== 'boolean') return
    trayMotionAllowed = !reduced
    refreshTaskbar()
  })

  /*
   * 系统通知（「声音提示」里的通知开关）。
   *
   * 为什么由主进程弹：
   *   · 点击通知要把窗口拉回前台（restore + show + focus），主进程拿得到 win；
   *   · Windows toast 需要 AppUserModelID，已在启动时设好；
   *   · 探针（YAN_PROBE）下不真弹系统通知，改为写日志 —— 不然跑一轮回归
   *     会给用户弹一堆通知，且无头环境也无法断言。
   */
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
      // silent: 声音由渲染端自己合成播放，系统通知再响一次会双重出声
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
  /* ---- 渲染端握手：重发当前全部状态 ----
     单向 push 不可靠 —— 主进程可能在 webContents 还没能力接收时
     就把 `proc: ready` 发出去（那条消息就丢了，界面永远停在「正在启动 pi」）。
     所以渲染端一订阅就发这个，我们把当前状态补一遍。 */
  ipcMain.on('yan:renderer-ready', (event) => {
    if (!isTrustedIpc(event)) return
    /* 渲染端刚加载完 —— 它还没有任何模态层，守卫必须归零。
       否则（比如窗口崩溃/热重载后）会永久卡在 paused=true。 */
    hotkeyGuardPaused = false
    const rid = runners?.activeRunnerId
    const c = ac()?.getConn()
    if (c) push({ ch: 'proc', payload: { state: c.state, detail: c.detail } })
    const st = ac()?.getState()
    if (st) {
      /* 初始化时也带身份：渲染端还没有 activeRunnerId，会把第一条当成当前会话 */
      if (rid) pushFrom(rid, { ch: 'state', payload: st })
      else push({ ch: 'state', payload: st })
    }
    void ac()?.refreshStats()
    void ac()?.refreshTodos()
    if (browser) push({ ch: 'browser-state', payload: browser.getState() })
    /* 左栏状态槽：把所有运行实例的状态一次性交给渲染端 */
    pushRunners()
  })

  /* ---- 诊断 ---- */
  handle('yan:probePi', async () => {
    const settings = await getSettings()
    const probe = resolvePi({ override: settings.piBin })
    return probe
  })

  handle('yan:openPath', async (p: string) => {
    /*
     * 失败要能说出来（2026-09-23，U-3b）：以前目标不存在就静默什么都不做，
     * 界面无法区分「已打开」与「文件已经不在了」。
     * 「打开所在目录」的语义保留，只补上目标存在性校验与错误回传。
     */
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'empty path' }
    /* 在任何文件系统查询前拒绝 UNC，避免链接触发远端认证。 */
    if (/^[\\/]{2}/.test(p.trim())) return { ok: false, error: 'network path' }
    if (!existsSync(p)) return { ok: false, error: 'missing' }
    const err = await shell.openPath(existsSync(dirname(p)) ? dirname(p) : p)
    return err ? { ok: false, error: err } : { ok: true }
  })

  /*
   * 用系统默认程序打开文件（对话里双击文件链接）。
   * 链接是模型写的，所以能直接「运行」的类型一律不启动，只在文件管理器里选中 ——
   * 双击一个链接不应该等于执行一段程序。
   */
  handle('yan:openFileDefault', async (p: string, cwd?: string) => {
    const raw = String(p ?? '').trim()
    if (!raw) return { ok: false, error: 'empty path' }
    /* UNC 路径会让系统向远端主机发起认证，链接不该指向网络共享 */
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
    /* 链接名可能是 foo.txt、真实目标却是 bar.exe：两个扩展名都要判 */
    let real = target
    try { real = await realpath(target) } catch { /* 取不到就按链接名判 */ }
    if (!canOpenDocument(target) || !canOpenDocument(real)) {
      shell.showItemInFolder(target)
      return { ok: true, revealed: true }
    }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

  registerWorkspaceDataIpc(ipc, () => win)

  /* ---- 数据位置（迁移到非系统盘，见 storage-move.ts） ---- */
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

  /** 在系统文件管理器里选中某个文件（比 openPath 精确） */
  handle('yan:revealPath', async (p: string) => {
    /* 返回是否真的打开了：界面在源文件已被删除/移动时要能回退到受控副本。 */
    if (!p || !existsSync(p)) return { ok: false }
    shell.showItemInFolder(p)
    return { ok: true }
  })

  /* ---- 附件：选图 → 读成 base64 ---- */
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
        // 12MB 上限：pi 会把 base64 塞进 JSONL，太大既慢又没必要
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

  /*
   * ---- 附件：选文件 / 文件夹 → 只回路径 ----
   *
   * 与 `yan:pickImages` 分开：图片要读成 base64（视觉模型靠它看图），
   * 而普通文件/目录只登记路径 —— 内容由模型按需 read。
   * 这里**不做**校验：路径回到渲染端后会走 `yan:describeFiles`，
   * 与拖入、文件树拖拽完全同一条审查链路（否则就多出一套口径）。
   */
  handle('yan:pickFiles', async (): Promise<string[]> => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件或文件夹',
      /* 目录与文件一起选：pi 的文件引用本来就接受目录 */
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  /* ---- 选目录（换工作目录） ---- */
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
    /*
     * N05：换项目**不再**停掉正在跑的会话。
     *
     * 旧实现是把当前 pi 子进程停掉重启（cwd 是子进程级的），代价是
     * 「点一下别的项目 = 后台任务全没」。现在每个运行实例自己带 cwd，
     * 所以这里只更新设置里的当前项目；视图切换由渲染端显式调
     * `yan:selectSession`（它知道该项目最近访问的会话）。
     */
    const cwdResult = await validateCwd(cwd)
    if (!cwdResult.ok) return cwdResult
    await patchSettings({ cwd: cwdResult.cwd })
    if (starting) await starting
    return { ok: true, cwd: cwdResult.cwd }
  })

  /* ---- 窗口 ---- */
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

  /**
   * 置顶开关。
   *
   * ⚠️ 这是个会“粘住”的状态：开了之后窗口会挡住所有其它应用，
   *   很多人会忘记自己开过。所以：
   *   ① 默认关（见 settings.ts 的 DEFAULTS）
   *   ② 按钮有明确的选中态
   *   ③ 状态变更**同时**推到界面（不靠调用方自己推断）
   */
  rawHandle('win:setAlwaysOnTop', async (_e, v: boolean) => {
    const on = !!v
    win?.setAlwaysOnTop(on)
    await patchSettings({ alwaysOnTop: on })
    pushWinState()
    return on
  })

  /** 读界面缩放现状（设置面板要显示「自动 = 1.15×，屏幕 125%」） */
  rawHandle('yan:getZoom', async () => zoomState(win, peekUiScale()))

  /** 设界面缩放（0 = 自动）。落盘 + 应用 + 回推 */
  rawHandle('yan:setUiScale', async (_e, v: unknown) => setUiScale(v))


  registerWorkspaceIpc(ipc, { handoffs })
  registerContextBudgetIpc(ipc, { currentAgent: () => ac() ?? undefined })



  /* ---- 子代理（方案第 8 节）---- */
  registerScheduleIpc(ipc, scheduleService)
  void scheduleService.start().catch((e) => reportMainError('定时任务', e))
  registerSubagentsIpc(ipc, {
    service: subagentService,
    parentContext: async (owner) => {
      /*
       * 父身份必须在**任何 await 之前**同步捕获：显式 owner 由渲染端自带身份；
       * 默认（CLI / 正常派活）捕获当前 active 的原始实例引用。
       */
      const captured = captureDefaultParent()
      const settings = await getSettings()
      return resolveSubagentParentContext(owner, captured, settings)
    }
  })

  registerGitIpc(ipc, {
    isCwdBusy: (dir: string) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, dir)),
    worktreeOrigins,
    /*
     * 只读改动 / 差异读取的目录授权：复用文件树 / @ 补全用的同一套
     * `resolveFileContext`。渲染端只能传 cwd，成不成、规范 cwd 是什么
     * 全在这里定；仓库根会在 git-inspect 里再授权一次。
     */
    authorizeReadCwd: async (cwd: string) => {
      const st = await getSettings()
      const resolved = await resolveFileContext(st, st.cwd, { cwd })
      return resolved.ok
        ? { ok: true as const, cwd: resolved.context.cwd }
        : { ok: false as const, error: resolved.error }
    }
  })

  /*
   * 代码评审（v3 WP-50，§10.2）。数据 / 批注 / 安全 Git 适配在 src/main/review/，
   * 这里只做装配，四条线各接既有的唯一入口：
   *   · 目录授权复用文件树同一套 `resolveFileContext`（同 `yan:git:changes` 的口径）；
   *   · R 编号走运行注册表的正式编号存储（`runsHost.assignCode` → SessionCodeStore）；
   *   · 推送 / 创建 PR 的窄目标确认接现有批准通道；
   *   · 评审执行交既有 `SubagentService` 的只读子运行，不复制 pi 循环。
   *
   * 评审子运行经 `reviewRuns` 按 runId 一对一登记成 `kind:'review'` 的运行
   * （R 号）：开始 / 进度 / 结束都投影到该运行，事件不回流到会话事件通道。
   * 评审技能 `resources/skills/review/SKILL.md` 供交互式 `/skill:review` 使用；
   * 只读子运行走 `--no-skills`，评审约束由 `shared/review.buildReviewPrompt`
   * 写进任务文本。
   */
  const reviewService = new ReviewService({
    authorize: async (cwd: string) => {
      const st = await getSettings()
      const resolved = await resolveFileContext(st, st.cwd, { cwd })
      return resolved.ok
        ? { ok: true as const, cwd: resolved.context.cwd }
        : { ok: false as const, error: resolved.error }
    },
    annotations: new ReviewAnnotationStore(),
    /*
     * 会话归属验证：评审的「本会话改动」必须绑定到**真实运行实例**的会话，
     * 渲染端自报的 sessionId 不构成授权。这里只认：
     *   · 该 sessionId 对应一个 live runner，且拿到稳定的会话键；
     *   · 请求目录与 runner 的 workingDirectory 一致（不能拿 A 目录配 B 会话）；
     *   · 返回目录取 runner 的可信工作目录，不采用渲染端送来的 cwd。
     * 任一不满足即 fail-closed，service 返回 unavailable，界面提示改看「未提交改动」。
     */
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
        /* 推送与建 PR 是对外动作：每次都必须过窄目标确认，不因权限档自动放行。 */
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
          /* 只读子运行的父会话归属：与子代理面板同一套 setContext 入口。 */
          controller.setContext({
            cwd: input.cwd,
            ...(input.sessionId ? { parentSessionId: input.sessionId } : {}),
            ...(input.projectId ? { projectId: input.projectId } : {})
          })
          const result = await controller.start(input.prompt, input.model, 'controlled-cwd')
          if (!result.ok || !result.run) return { ok: false, error: result.error ?? '评审运行启动失败' }
          /*
           * 只读子运行按 runId 映射为 `kind:'review'` 的 R 运行。登记失败只说明
           * 运行总览里看不到这次评审（编号 / 注册表降级），不影响子运行本身。
           */
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

  registerLibraryIpc(ipc, {
    library,
    spaces,
    refreshActiveSessionContext: async (sessionId) => {
      const activeId = runners?.activeRunner()?.id
      if (activeId && runners?.agentOf(activeId)?.getState()?.sessionId === sessionId) {
        await refreshSessionContext(activeId, await resolveAgentProfile(activeId))
      }
    }
  })

  /*
   * 本轮上下文（实施-25 P05 / T05-3）：**只读**。
   *
   * 返回的是「真的会注入给模型的那份内容」（与扩展读的快照同源），
   * 引用带 sourceId + version + 字符区间，界面与探针据此核对、跳回原文。
   * 这里不写盘、不改任何状态。
   */
  handle('yan:context:current', async () => ({ ok: false, error: AGENT_CONTEXT_ERROR }))


  registerActivityModelIpc(ipc)


  registerTaskInboxIpc(ipc, { runnerStatuses: () => runners?.statuses() ?? [] })

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

  /* MCP App 视图桥：service 在 ready 后装配，未就绪时 IPC 明确报未就绪。 */
  registerMcpAppViewIpc(ipc, { service: () => mcpAppViewService })

  /*
   * A7：把**真实运行时事实**接进 MCP Apps 宿主归属守卫。
   * - agentDir 用真实的 PI_AGENT_DIR（与传给 pi 的 PI_CODING_AGENT_DIR 同源）；
   * - 项目登记从受信设置动态取；
   * - registry 用当前 RunnerRegistry，holdersFor 走内部窄快照（含 hidden）+
   *   启动见证 + legacy 连接事实；
   * - 缺任何一项 / 读取异常都 fail-closed（守卫折算成 runtime-unknown 拒绝），
   *   绝不在别处补一个空数组当「无人持有」。
   */
  configureMcpAppHostOwnership(
    createMcpAppRuntimeOwnershipFacts({
      registry: () => runners,
      agentDir: PI_AGENT_DIR,
      projects: async () => (await getSettings()).projects.map((project) => ({ id: project.id, cwd: project.cwd }))
    })
  )


  registerKnowledgeIpc(ipc, { currentCwd: () => ac()?.getState()?.cwd, knowledgeProjectId, window: () => win })

  /* ---- 内置浏览器 ---- */
  registerBrowserIpc(ipc, () => browser)

  /* ---- 砚对砚：这台电脑去连接别的砚 ---- */
  registerPeerIpc(ipc, peerClient, async () => (await getSettings()).projects)

  registerPeerHostIpc(ipc, { grants: peerGrants })

  registerConsentIpc(ipc)

  /* ---- 办公文件：预览与修改对比 ---- */
  registerOfficeIpc(ipc, async (requestedCwd) => {
    const settings = await getSettings()
    const resolved = await resolveFileContext(settings, settings.cwd, { cwd: requestedCwd ?? settings.cwd })
    if (!resolved.ok) throw new Error(resolved.error)
    return resolved.context.cwd
  })

  /* ---- 语音输入：本地转写（下载须经界面确认） ---- */
  registerAppUpdate(ipc, () => (runners?.statuses() ?? []).some((status) => status.running))
  registerVoiceIpc(ipc, {
    service: new VoiceService(async () => (await getSettings()).voiceInput),
    window: () => win,
    settings: async () => (await getSettings()).voiceInput,
    saveSettings: async (voiceInput) => {
      await patchSettings({ voiceInput })
    }
  })

  /* ---- 手机接入 ---- */
  registerRemoteIpc(ipc, {
    access: () => remoteAccess,
    ensureStarted: startRemoteServer,
    saveSettings: (remote) => patchSettings({ remoteAccess: remote })
  })

  /* ---- 交互终端（实施-11 H-11） ---- */
  registerTerminalIpc(ipc, () => ac()?.getState()?.cwd, (id) => agentHub.ownsTerminal(id))
  registerAgentHubIpc(ipc, agentHub)
}

/** 推一次窗口状态（最大化 + 置顶） */
function pushWinState(): void {
  if (!win) return
  push({
    ch: 'win-state',
    payload: { maximized: win.isMaximized(), alwaysOnTop: win.isAlwaysOnTop() }
  })
}

/**
 * 设置界面缩放（0 = 自动）。
 *
 * 三件事缺一不可：应用 zoom、落盘、**推给渲染端** ——
 * 不推的话用 Ctrl+= 改完，设置面板里的选中态还是旧值（下不了台）。
 */
async function setUiScale(v: unknown): Promise<ReturnType<typeof zoomState>> {
  const next = clampScale(v)
  // 先同步更新内存值（快捷键要立即看到），再落盘
  const st = applyZoom(win, next)
  push({ ch: 'ui-scale', payload: st })
  await patchSettings({ uiScale: next })
  return st
}

/* 窗口 */
function createWindow(): void {
  /*
   * 窗口初始尺寸。默认 1440×900，但可以用 `YAN_WIN=940x600` 覆盖 ——
   * 探针需要能测**窄窗口**下的布局（侧栏收起 + 窄窗口就出过问题），
   * 而从渲染端改不了窗口尺寸（resizeTo 对非脚本打开的窗口无效）。
   * 这条只是开发用手段，不影响正常启动。
   */
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
    /*
     * 窗口外框圆角交回系统：Windows 11 给无边框窗口画圆角，且窗口最大化 / 贴边时
     * 由 DWM 切回直角，不用自己跟着窗口状态改。Win10 及更早版本无此效果（仍是直角），
     * macOS 与支持客户端装饰的 Linux 桌面按各自规则处理。
     */
    roundedCorners: true,
    /* 与深色 --bg-0 / 启动画面底色一致；浅色主题在读到设置后改（见下方 getSettings） */
    backgroundColor: '#151515',
    webPreferences: {
      preload: join(__dirname_, '../preload/index.cjs'),
      additionalArguments: [
        ...(process.env.YAN_PROBE && !app.isPackaged ? ['--yan-isolated-probe'] : []),
        ...(process.env.YAN_UI === 'v2' || process.env.YAN_UI === 'v3' ? [`--yan-ui=${process.env.YAN_UI}`] : [])
      ],
      /*
       * 主窗口的进程沙盒（方案第 9 节）。
       *
       * 评估结论：preload 只用到 contextBridge / ipcRenderer / webUtils，
       * 这三个在 sandboxed preload 里都是允许的，所以不需要保留 Node 能力。
       * 远程网页视图本来就单独开了 sandbox（见 browser.ts）。
       */
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })
  guardHtmlArtifactFrames(win.webContents)

  if (process.platform === 'win32') {
    // 任务栏按 AppUserModelID 取重启图标；只设置 BrowserWindow.icon 仍可能显示 Electron 默认图标。
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: app.isPackaged ? process.execPath : join(app.getAppPath(), 'build', 'icon.ico'),
      appIconIndex: 0
    })
  }

  // 关闭按钮只收起窗口，托盘菜单才会触发真正的退出流程。
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win?.hide()
  })

  /*
   * 恢复上次的置顶状态。
   *
   * 异步读设置（getSettings 命中缓存后几乎立即返回），所以在 ready-to-show 之前
   * 就能生效 —— 不会出现「先普通层闪一下再跳到置顶层」。
   * 构建期就有 `alwaysOnTop` 选项但那时还不知道值，所以走 setTimeout(0)。
   *
   * 同时应用界面缩放（见 main/zoom.ts）。
   */
  void getSettings().then((s) => {
    if (!win) return
    if (s.theme === 'light') win.setBackgroundColor('#fcfcfa')
    if (s.alwaysOnTop) {
      win.setAlwaysOnTop(true)
      pushWinState()
    }
    applyZoom(win, s.uiScale)
  })

  /*
   * 显示器变化 → 重算缩放。
   *
   * 两种必须重算的情况：
   *   · 窗口被拖到另一块屏（笔记本 150% + 外接 100% 很常见）
   *   · 用户在系统里改了缩放比例（不重启应用也应该跟上）
   * 自动模式（uiScale=0）下这是唯一能跟上变化的时机。
   */
  const reapply = (): void => {
    void getSettings().then((s) => {
      if (win && !win.isDestroyed()) applyZoom(win, s.uiScale)
    })
  }
  win.on('moved', reapply)
  screen.on('display-metrics-changed', reapply)
  screen.on('display-added', reapply)
  screen.on('display-removed', reapply)

  /*
   * 显示窗口。
   *
   * ⚠️ 探针运行时用 `showInactive()`（显示但**不抢焦点**）。
   * 为什么：跑测试会连续开十几次窗口，`show()` 每次都把焦点抢过来 ——
   * 用户在多桌面工作时会被反复打断（实测：测试把焦点从另一个桌面抢走）。
   * 不激活不影响断言：窗口照样渲染、布局、跑动画，只是不在最前面。
   *
   * ⚠️ `YAN_PROBE_HIDDEN=1` 时**完全不上屏**（保持 `show: false`，不进任务栏）。
   * 为什么：即使不抢焦点，窗口仍会出现在屏幕上；批量回归 / agent 在后台跑时
   * 会持续干扰用户。渲染与布局不受影响 —— 上面那三个
   * `disable-*-backgrounding` 开关已经关掉了不可见窗口的节流。
   * 代价：看不到窗口，所以**不能**用这个模式做人工视觉验收。
   */
  win.once('ready-to-show', () => {
    if (process.env.YAN_PROBE) {
      if (process.env.YAN_PROBE_HIDDEN) win?.setSkipTaskbar(true)
      else win?.showInactive()
    } else {
      win?.show()
    }
    /*
     * 窗口显示后再补一次缩放。
     *
     * 为什么需要：上面那次 applyZoom 可能跑在 `loadURL/loadFile` **之前**，
     * 而导航会把 webContents 的 zoom 重置回默认值 —— 自动缩放（如 125%
     * 屏上的 1.152）就“报告了但没生效”（devicePixelRatio 仍是 1.25），
     * 所有 CSS 像素 ↔ DIP 的换算都会跟着错。
     *
     * 为什么延后 1.2s 而不是在 did-finish-load 里：实测在首次提交前后同步
     * 调 setZoomFactor 会让渲染进程 render-process-gone: crashed，
     * 窗口永远停在 ready-to-show 之前。等窗口稳定后就没问题。
     */
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      /*
       * 扩展来源诊断放在这里，而不是 `doStartAgent` / app 启动时：
       * `push` 在窗口还没准备好时会**直接丢掉**（见 push 里的判空），
       * 而这些日志是给用户看的诊断 —— 丢了等于没做（实测第一版就丢在这里）。
       * ready-to-show 表示页面已经画出来了，渲染端的 push 订阅已经就位。
       */
      void reportExtensionSources().catch(error => console.error('[来源] 扩展诊断失败', error))
      void getSettings().then((s) => {
        if (win && !win.isDestroyed()) applyZoom(win, s.uiScale)
      })
    }, 1200)

    /*
     * 测试通道：`YAN_PROBE_SHOT` 给出一个 png 路径时，在窗口出现后延迟
     * `YAN_PROBE_SHOT_DELAY`（默认 20000ms）截一次**真实窗口**。
     * 只服务人工 / agent 视觉验收（例如 H-10 真实子代理过程页）；
     * 没有 `YAN_PROBE` 的正常启动完全不进入这一段。
     *
     * 隐藏窗口只合成一帧，所以截图前先 `showInactive()`（显示但不抢焦点）。
     */
    const shotPath = process.env.YAN_PROBE_SHOT
    if (process.env.YAN_PROBE && shotPath) {
      const parsedShotDelay = Number(process.env.YAN_PROBE_SHOT_DELAY ?? 20_000)
      const shotDelay = Number.isFinite(parsedShotDelay) && parsedShotDelay >= 0 ? parsedShotDelay : 20_000
      const shotLog = (m: string): void => {
        void appendFile(`${shotPath}.log`, `${new Date().toISOString()} ${m}\n`).catch(() => {})
      }
      shotLog(`armed delay=${shotDelay} path=${shotPath}`)
      /*
       * 连续抓：场景从探针开始到退出只有几秒，单次定时很容易落在窗口之外。
       * `shotPath` 是基础名，实际输出 `-1/-2/...` 后缀，事后挑过程页那张。
       */
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

  /*
   * 最大化 / 置顶状态变化 → 推给界面。
   *
   * 为什么必须监听窗口事件而不是只在 IPC 里推：用户会**双击标题栏**最大化、
   * 用 Win+↑ 贴靠、或者从任务栏菜单还原 —— 这些都不经过我们的 IPC，
   * 只在 IPC 里 push 的话图标会与真实状态不同步（之前就是这个 bug）。
   *
   * ⚠️ 必须注册在 createWindow 里而不是 registerIpc 里 ——
   *   启动顺序是 registerIpc() → createWindow()，在那里 `win` 还是 null。
   *
   * ⚠️ 逐个 `on` 而不是循环一个数组：BrowserWindow 的事件名是**重载**的，
   *   循环里的联合类型选不中正确的重载（TS 会拿 26 个重载一个个试都在报错）。
   */
  win.on('maximize', () => pushWinState())
  win.on('unmaximize', () => pushWinState())
  win.on('enter-full-screen', () => pushWinState())
  win.on('leave-full-screen', () => pushWinState())
  // always-on-top 也可能被系统或用户改（任务栏右键），同样同步
  win.on('always-on-top-changed', () => pushWinState())

  /*
   * 全局快捷键 —— 在主进程拦。
   *
   * 为什么不用渲染端的 window.addEventListener('keydown')：
   *   那条路会漏。实测中它可能不触发：
   *     · 输入法（IME）处于组合态时，按键被 IME 吃掉
   *     · 某些平台的菜单 accelerator / 系统级拦截先一步
   *     · 焦点不在 webContents（比如刚从原生对话框回来）
   *   而 before-input-event 是主进程在**按键进入渲染进程之前**的钩子，
   *   不管焦点在哪、输入法什么状态，只要窗口在前台就一定到。
   *   代价是主进程要知道“下一模型/下一强度”这种语义 ——
   *   所以这里只把按键**归一化成动作名**发回渲染端，
   *   具体怎么算下一档仍然由渲染端决定（协议知识不进主进程）。
   *
   * 绑定对齐 pi TUI 的默认：
   *   Ctrl+P        app.model.cycleForward
   *   Ctrl+Shift+P  app.model.cycleBackward
   *   Shift+Tab     app.thinking.cycle
   *
   * 另外接了缩放（Ctrl+= / Ctrl+- / Ctrl+0）—— 这是浏览器/编辑器的通用约定，
   * 用户不用去设置里找。缩放不需要渲染端参与决策，主进程直接改并回推。
   */
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const ctrl = input.control || input.meta
    const key = String(input.key ?? '').toLowerCase()

    /*
     * 模态层守卫（见 hotkeyGuardPaused 的说明）。
     *
     * 三条 cycle 判断都带上 `!hotkeyGuardPaused`：有弹窗时**不
     * preventDefault**、不发动作，把按键原样留给渲染端 —— 设置面板里的
     * 表单才能用 Shift+Tab 反向遍历焦点。下面的缩放照旧（与焦点语义无关）。
     */
    // Ctrl+Shift+P —— 上一个模型（必须排在 Ctrl+P 前，否则会被后者先吃掉）
    if (!hotkeyGuardPaused && ctrl && input.shift && !input.alt && key === 'p') {
      event.preventDefault()
      win?.webContents.send('yan:hotkey', { action: 'cycleModelBack' })
      return
    }

    // Ctrl+P —— 下一个模型
    if (!hotkeyGuardPaused && ctrl && !input.shift && !input.alt && key === 'p') {
      event.preventDefault()
      win?.webContents.send('yan:hotkey', { action: 'cycleModel' })
      return
    }

    // Shift+Tab
    if (!hotkeyGuardPaused && input.shift && !ctrl && !input.alt && input.key === 'Tab') {
      event.preventDefault()
      win?.webContents.send('yan:hotkey', { action: 'cycleThinking' })
      return
    }

    /*
     * 缩放：Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0。
     *
     * ⚠️ 挡在渲染进程之前是必需的 —— 不拦的话 Chromium 会用自己的 zoom
     *   改掉 webContents 的 zoomFactor，与设置里的 uiScale 不同步
     *   （表现为「重启后缩放又变回去了」）。
     * `Ctrl+0` 回到**自动**（而不是 1.0）—— 自动才是默认状态。
     */
    if (ctrl && !input.alt && (key === '=' || key === '+' || key === '-' || key === '_' || key === '0')) {
      event.preventDefault()
      /*
       * ⚠️ 用 `peekUiScale()` 而**不是**异步读设置。
       *    这里曾经是 `getSettings().then(...)`，而它每次都要读盘 ——
       *    连按两次 Ctrl+= 时第二下可能读到写盘之前的旧值，
       *    算出同一个档位（看上去就是按键丢了）。详见 zoom.ts 的注释。
       */
      const cur = peekUiScale()
      const next = key === '0' ? 0 : stepScale(win, cur, key === '-' || key === '_' ? -1 : 1)
      void setUiScale(next)
    }
  })

  /*
   * 右键菜单（复制 / 粘贴 / 剪切 / 全选）。
   *
   * 为什么之前“被隐藏”了：Electron **默认没有**右键菜单（只有浏览器才有），
   * 我们没有自己建，所以输入框和正文里右键什么都不弹。
   *
   * 按上下文给项：可编辑处给剪切/复制/粘贴/全选，只选中文本时给复制。
   * 标签跟随应用语言（role 的默认标签是英文）。
   */
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

  /*
   * 应用窗口只显示自己的界面：开发时是 dev server 的源，打包后是 file://index.html。
   * 其余导航（链接点击、重定向）一律拦下，网页与邮件链接交给系统打开。
   */
  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev ? new URL(url).origin === new URL(dev).origin : url.startsWith('file://')) return
    event.preventDefault()
    const external = openableExternalUrl(url)
    if (external) void shell.openExternal(external)
  })

  // 渲染端异常要有记录，否则 React 启动失败时用户只会看到黑屏。
  win.webContents.on('console-message', (...args: unknown[]) => {
    const detail = args.find((x) => x && typeof x === 'object' && 'message' in x) as { level?: string; message?: string; sourceId?: string; lineNumber?: number } | undefined
    if (detail?.level === 'error') console.error('[renderer console]', detail.message, detail.sourceId, detail.lineNumber)
    else if (typeof args[2] === 'string' && Number(args[1]) >= 2) console.error('[renderer console]', args[2], args[4], args[3])
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    runnerVisibility.reset()
    /* 渲染进程没了：所有 App iframe 失联，立即清实例并中止在途调用；运动偏好回到静态。 */
    mcpAppViewService?.close()
    trayMotionAllowed = false
    refreshTaskbar()
    console.error('[renderer gone]', details.reason)
  })
  win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    runnerVisibility.reset()
    /* 主 frame 重载：旧 iframe 已销毁，主动失效并等新的 motion 上报。 */
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

  // 调试用：YAN_PROBE=<js文件> 时，在渲染端执行它并把结果打到 stdout。
  // 为什么不另开一个裸 BrowserWindow：那测不到 preload/IPC/pi 子进程这条真链路，
  // 断言会“通过”但应用其实是坏的。
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
            // 可选：先发一次**真实**鼠标移动（合成事件不产生 :hover，
            // 所以涉及 CSS hover 的断言必须用 sendInputEvent）
            const mouse = process.env.YAN_PROBE_MOUSE
            if (mouse) {
              const [mx, my] = mouse.split(',').map(Number)
              win!.webContents.sendInputEvent({ type: 'mouseMove', x: mx, y: my })
              await new Promise((r) => setTimeout(r, 700))
            }

            /*
             * 可选：发一批**真实**按键。
             *
             * 为什么必需：全局快捷键是主进程用 `before-input-event` 拦的，
             * 而 `webContents.executeJavaScript` 里的合成 KeyboardEvent
             * **不会**走那条路 —— 断言会“通过”但真实按键可能是坏的。
             * 只有 sendInputEvent 才是从 Chromium 输入栈进去的，与用户手按一致。
             *
             * ⚠️ 顺序很重要：按键是**后台并发**发的（不 await），
             *   因为探针脚本要先跑起来、把自己的 onHotkey 监听器挂上，
             *   否则按键会在监听器注册之前就跑完，断言收到空数组
             *   （本会话真的这么错过一次）。所以：先启动按键序列，再 executeJavaScript。
             *
             * 语法：`ctrl+p,shift+tab`（逗号分隔，支持 ctrl/alt/shift/meta + key）
             */
            const keys = process.env.YAN_PROBE_KEYS
            let keyTask: Promise<void> | null = null
            if (keys) {
              keyTask = (async () => {
                /*
                 * 等探针脚本挂好监听器 / 把界面准备到能收键的状态。
                 *
                 * 默认 1800ms 只够挂监听器；**渲染端**消费的按键
                 *（例如输入框里的 Tab 快切）还需要焦点在输入框上，而探针
                 * 得先把首次引导层关掉 —— 那种场景用 `YAN_PROBE_KEYS_DELAY`
                 * 把第一枚按键往后推（全局快捷键不需要，保持默认即可）。
                 */
                const delay = Number(process.env.YAN_PROBE_KEYS_DELAY) || 1800
                await new Promise((r) => setTimeout(r, delay))
                for (const combo of keys.split(',').map((s) => s.trim()).filter(Boolean)) {
                  const parts = combo.toLowerCase().split('+')
                  const key = parts.pop() ?? ''
                  const mods = new Set(parts)

                  /* Electron 的键盘事件用 keyCode + modifiers（不是 DOM 那套） */
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
            // 按键序列应该已经跑完（探针脚本会等够时间）；保险起见等一下
            if (keyTask) await keyTask.catch(() => undefined)
            const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            console.log('---PROBE-START---')
            console.log(body)
            console.log('---PROBE-END---')
            /*
             * 可选：把结果同时写进文件。
             * 为什么需要：Windows 上的 GUI 应用（尤其 electron-builder 的
             * portable 单文件版）**不保证有可用的 stdout** —— 外层包装进程
             * 不转发子进程的管道，靠 stdout 抓输出会「一个字节都没有」，
             * 看着像启动失败。文件没有这个限制。
             */
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

  // 调试用：YAN_SHOT=<png> 时，等一会儿截图并退出。
  // 为什么要走真实主进程：只有这样才能覆盖 preload / IPC / pi 子进程的完整链路，
  // 在裸 BrowserWindow 里截出来的图只是「长得像」。
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
            // 截图前的前置准备：YAN_SHOT_SETUP=<js 文件>
            // 需要在截图前把界面摆到某个状态（切会话、展开分区…）时用这个。
            // 不写的话截的就是“刚启动”的状态。
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

/* 启动 */
/* 会话级任务状态与目标续跑接上运行注册表与各存储（见 goal-coordinator.ts） */
configureGoalCoordinator({
  runners: () => runners,
  workModes,
  agentProfiles,
  spaces,
  contextAssembler,
  handoffDiag,
  pushFrom
})

/*
 * 桌面会话的宿主能力（见 session-host.ts）：桌面会话 IPC 与远程入口共用这一组，
 * 不各自复制会话规则。
 */
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

/* 远程宿主接上桌面的运行注册表与会话规则（见 remote-host.ts） */
configureRemoteHost({
  ...sessionHost,
  approvals,
  win: () => win,
  remoteAccess: () => remoteAccess
})

/* 自动交接协调器接上宿主能力（见 handoff-coordinator.ts）；所有依赖在这之前都已建好 */
configureHandoffCoordinator({
  runners: () => runners,
  defaultWorkMode,
  goals,
  handoffs,
  workModes,
  sessionChains,
  handoffTransactions,
  handoffDiag,
  workModeKeyFor,
  resolveWorkMode,
  pushFrom,
  push,
  maybeArmGoalContinue,
  cancelGoalResume,
  applyGoalResume,
  consumeRepeatBlocks,
  rememberRunnerSession,
  pushRunners,
  pushRunnerSnapshot,
  openHandoffSession,
  projectIdForCwd
})

app.whenReady().then(async () => {
  try { releaseDesktopDataRoot = await lockDataRoot(YAN_DIR) } catch (error) { reportMainError('data-root-writer', error); app.exit(1); return }
  /* 注册为 `inkstone://` 默认处理器；开发态带入口脚本，打包态只注册 scheme。 */
  registerDeepLinkProtocol(app, { isPackaged: app.isPackaged, execPath: process.execPath, appPath: process.argv[1] })
  registerHtmlArtifactProtocol()
  void loadModelPricing()
  watchPowerSource()
  browser = new BrowserController(() => win, push)
  /* 终端输出转成渲染端可消费的推送（H-11）：只有活动窗口时才有接收方 */
  setTerminalSink((event) => {
    if (event.kind === 'exit') {
      blockedTerminalNotices.delete(event.id)
      void agentHub.terminalExit(event.id, event.exitCode)
    }
    if (event.kind === 'status') {
      notifyBlockedTerminal(event.id, event.status)
      refreshTaskbar()
    }
    /*
     * 终端弹窗持有该 terminalId 的 lease 时，输出只投给它；弹窗关掉后自然回落到主窗口。
     * 状态与退出两边都要知道：主窗口的终端页签在弹出期间仍要显示阻塞/退出，归还后不留旧状态。
     */
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

  /*
   * 辅助小窗（WP-25d 快速提问 / WP-12 迷你小窗）。
   *
   * 窗口 / 状态 / 发送逻辑都在 src/main/windows/**；这里只提供宿主事实：
   * 主窗口边界、项目与模型列表、注意力汇总，以及复用 sessionHost 的新会话路径。
   * 导航复用既有的 `tray-select-session` 推送（只导航，不执行动作）。
   */
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
    /* 默认关闭；用户可见的开关是后续设置项，验收期用 YAN_AUX_MINI=1 打开。 */
    miniEnabled: () => process.env.YAN_AUX_MINI === '1'
  })
  registerAuxIpc(auxWindows)
  auxWindows.registerShortcut()
  if (process.env.YAN_AUX_MINI === '1') auxWindows.showMini()

  /*
   * 浏览器原生视图转移端口：宿主能力来自 BrowserController 的 host-transfer
   * 增量 API；端口本身只做租约、移动与受限端口，不复制浏览器服务。
   */
  const browserTransfer = createPaneBrowserTransfer({
    beginHostTransfer: (request) =>
      browser?.beginHostTransfer(request) ?? { ok: false, code: 'not-found', message: '浏览器未初始化' },
    endHostTransfer: (tabId, ownerKey) => browser?.endHostTransfer(tabId, ownerKey) ?? false
  })
  paneBrowserTransfer = browserTransfer

  /*
   * 终端页签同 PTY 弹出（WP-30 终端 transfer）：只绑定主窗口已经打开的 PTY，
   * 不 start / kill；输出经上面的 setTerminalSink relay 转投，弹窗关闭后回落主窗口。
   */
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
      /* 主窗口是信任边界；owner 只作归属绑定，终端必须真实存在（上面 read 再校验一次）。 */
      authorize: (owner) => owner.active === true && owner.key.length > 0
    },
    {
      onLeaseChange: (event) => {
        if (win && !win.isDestroyed()) win.webContents.send('yan:pane-terminal:lease', event)
      }
    }
  )

  /*
   * 工作区页签弹出窗（WP-30 弹出）。窗口生命周期 / owner+epoch 守卫在
   * windows/pane-popout-*；这里只提供宿主事实（主窗口边界、工作区、缩放、语言）
   * 与动作回投。browser / terminal 走各自的 transfer 适配器，preview 仍被拒绝。
   */
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
      /*
       * 浏览器页签的原生视图转移端口：只把「借出/归还」这一层交出去。
       * 控制器不碰 WebContentsView，适配器不碰控制器内部。
       */
      browserTransfer,
      /* 终端页签的 transfer 端口：控制器只转发 open，窗口与 lease 归 W3T 适配器所有。 */
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

  /*
   * 同步目录已配置时，启动后同步一次；失败只记日志，不阻塞启动、不弹窗。
   */
  void syncController?.runStartupSync()
  /*
   * 冷启动由系统带链接拉起（Windows argv / macOS ready 前的 open-url）：渲染端
   * 订阅要等页面加载完才就位，所以在 did-finish-load 之后补投，早发的链接不丢。
   */
  win?.webContents.once('did-finish-load', () => {
    deepLinkRouter.flush()
    deepLinkRouter.handleArgv(process.argv)
  })

  /*
   * 运行注册表（v3 WP-10）：必须在首个 AgentController 创建（startAgent）之前
   * 初始化，createAgent 才能把旁路接上。初始化失败只降级为 null ——
   * 运行总览 / 侧栏状态点不可用，v2 会话功能照常继续。
   */
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

  /*
   * MCP App 视图桥（v3 §12）：ready 之后注册 `inkstone-app:` 协议处理器。
   *
   * owner 事实只从**实际前台实例**派生（runnerId / generation / sessionFile /
   * projectId / cwd），`current` 与 `currentProject` 同源；任何缺失都 fail-closed，
   * 不造恒 true guard、不从 server.projectScope 自证 caller。`mcpAppHost()` 的连接资格
   * 仍由 A7 的 ownership guard 决定，此处不改它；官方 grant 通道未接入时传 []（只读也逐次询问）。
   */
  const mcpAppViewRuntime = createMcpAppViewRuntime({
    current: () => appViewForegroundFacts(),
    /* A6R：refresh / snapshot 的可信 caller 项目，与 `current` 同口径。 */
    currentProject: (): string | null => appViewForegroundFacts()?.projectId ?? null,
    isActive: (owner: McpAppOwner): boolean => {
      /* 全字段对照**当前前台**：旧 runner 只是还存活不能放行，也不能信 request 自报。 */
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

  /*
   * 旧「办事模板」一次性导出成用户技能：放在首个 pi 实例启动之前，
   * 导出的技能在第一次会话就能加载。失败只跳过，不挡启动；原文件保留。
   */
  await migrateLegacyPlaybooks().catch((error) => console.error('[yan] 办事模板导出失败：', error))

  // 窗口就绪后自动连 pi，用户不用先点「连接」
  const started = await startAgent()

  /*
   * 安卓远程管理是显式 opt-in：默认不监听网络端口。
   * 放在 pi 启动之后，第一次 /status 就能拿到完整连接状态；即使监听失败，
   * 也只记录诊断，不阻止桌面端正常启动。
   */
  await startRemoteServer()

  // 如果控制启动请求本身拉起了首个实例，也要在窗口准备好后执行一次。
  const initialControl = decodeControlCommand(process.argv)
  if (initialControl) void dispatchControlCommand(initialControl)

  // 调试/演示用：YAN_PROMPT=<文本> 时，连上后自动发一条。
  // 配合 YAN_SHOT 就能截到“真实对话”而不是空状态。
  // 只发一次：之前用 did-finish-load + 定时兼底两个入口，结果重复发了好几条。
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

// 退出前收好 pi 子进程，别留孤儿 pi
app.on('before-quit', (e) => {
  if (shuttingDown) return
  e.preventDefault()
  void shutdown().then(() => app.quit())
})
