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
import { constants as fsConstants, existsSync, readdirSync } from 'node:fs'
import { access, appendFile, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentController, type CapabilityAuthorizationChoice, type CapabilityAuthorizationPrompt, type ExternalApiConfirmationRequest, type ToolConsentPrompt, type GoalCommandHost } from './agent'
import { applyTurnTimings, readTurnTimings, timingKey } from './turn-timing-store'
import { RunnerRegistry } from './runners'
import { getSettings, patchSettings } from './settings'
import { cancelStorageMove, scheduleStorageMove, storageInfo, storageSize } from './storage-move'
import { rememberSession } from './session-layout'
import { readChainMessages } from './session-history'
import { ArtifactStore } from './artifacts'
import { readRepoState } from './git-service'
import { configureWriteContext } from './git-actions'
import { configurePackageContext, installManagedPiPackage, listPackages } from './packages'
import { AcquisitionService } from './capabilities/acquisition-service'
import { PackageAuthorizationService } from './capabilities/package-authorization-service'
import { createPiPackageActivationHostPorts } from './capabilities/pi-package-activation-host'
import { PiPackageActivationScheduler } from './capabilities/pi-package-scheduler'
import { smokeStagedPiPackage } from './capabilities/pi-package-smoke'
import { createSkillFilesActivationHostPorts } from './capabilities/skill-files-activation-host'
import { SkillFilesActivationScheduler } from './capabilities/skill-files-scheduler'
import { allowTrust, trustStatus } from './project-trust'
import { setContextPolicySettings, syncEffectivePolicyFile } from './context-policy'
import { resolvePi, piInfo, resetPiVersionCache } from './protocol'
import { applyZoom, clampScale, peekUiScale, stepScale, zoomState } from './zoom'
import { BrowserController } from './browser'
import { disposeTerminals, setTerminalSink } from './terminal'
import { createIpcRegistrar } from './ipc/registrar'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerRemoteIpc } from './ipc/remote-ipc'
import { registerOfficeIpc } from './ipc/office-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerFollowIpc } from './ipc/follow-ipc'
import { registerArtifactDocIpc } from './ipc/artifact-doc-ipc'
import { registerLibraryIpc } from './ipc/library-ipc'
import { registerSourcesIpc } from './ipc/sources-ipc'
import { registerKnowledgeIpc } from './ipc/knowledge-ipc'
import { registerTaskInboxIpc } from './ipc/task-inbox-ipc'
import { registerCapabilitiesIpc } from './ipc/capabilities-ipc'
import { registerPackagesIpc } from './ipc/packages-ipc'
import { registerActivityModelIpc } from './ipc/activity-model-ipc'
import { registerSubagentsIpc } from './ipc/subagents-ipc'
import { registerSessionIpc } from './ipc/session-ipc'
import type { SessionHost } from './session-host'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerWorkspaceIpc } from './ipc/workspace-ipc'
import { registerGoalIpc } from './ipc/goal-ipc'
import { registerSpaceIpc } from './ipc/space-ipc'
import { registerFilesIpc } from './ipc/files-ipc'
import { registerContextBudgetIpc } from './ipc/context-budget-ipc'
import { registerPeerHostIpc } from './ipc/peer-host-ipc'
import { registerConsentIpc } from './ipc/consent-ipc'
import { SubagentService } from './subagent-service'
import { createSubagentNotifier } from './subagent-notify'
import { configureGoalCoordinator, setDefaultWorkMode, defaultWorkMode, goalBudgetUsage, workModeKeyFor, resolveWorkMode, pushWorkMode, resolveAgentProfile, pushAgentProfile, refreshSessionContext, buildContextRequest, pushGoal, applyGoalResume, cancelGoalResume, consumeRepeatBlocks, goals, maybeArmGoalContinue } from './goal-coordinator'
import { configureRemoteHost, remoteSnapshot, remoteHistory, remoteModels, executeRemoteCommand, remoteQuestions, remoteAnswer, remoteArtifact, remoteMessageImage, peerClient, peerGrants, peerHostHandlers } from './remote-host'
import { configureHandoffCoordinator, handoffRunner, publishHandoffReplacement, handoffPending, handoffIdentities, hasHandoffOperation, tryArmHandoff, abandonHandoff } from './handoff-coordinator'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerAppUpdate } from './app-update'
import { VoiceService } from './voice/voice-service'
import { registerPeerIpc } from './ipc/peer-ipc'
import type { ConsentDecision } from '../shared/tool-consent'
import { RemoteAccess } from './remote-access'
import { GoalStore, goalResumeContinuationWasConsumed, writeGoalResumeSnapshot } from './goal-service'
import { HandoffStore } from './handoff-service'
import { HandoffDiagnostics } from './handoff-diagnostics'
import { HandoffTransactionStore } from './handoff-transaction-service'
import { SessionChainStore } from './session-chain-service'
import { WorktreeLinkStore } from './worktree-links'
import { AutoIsolationStore, isolateCwdForConflict, isolationCwdKey, syncIsolationBack } from './session-isolation'
import { type HandoffSessionHandle, type HandoffSessionTarget } from './handoff-runner'
import { normalizeChainKey } from '../shared/session-chain'
import { AutoContinueStore, autoContinueOptionsFromEnv } from './auto-continue-service'
import { createSessionWorkScheduler } from './session-work-scheduler'
import { AUTO_CONTINUE_LIMIT } from '../shared/auto-continue'
import { AUTONOMOUS_CONTINUE_LIMIT, goalSummary, isActiveGoalPhase, normalizeReadyParams, normalizeReportParams } from '../shared/goal'
import { CapabilityCommandError } from './capability-server'
import { localCommandDescriptors } from './command-registry'
import { writeExitSnapshot } from './exit-snapshot'
import { installStdioGuard } from './stdio-guard'
import { decodeControlCommand, writeControlResponse, type ControlCommand, type ControlResponse } from './control-protocol'
import { DOWNLOADS_DIR, ELECTRON_CRASH_DUMPS_DIR, ELECTRON_USER_DATA_DIR, PI_AGENT_DIR, YAN_DIR } from './paths'
import { migrateLegacyPlaybooks, userSkillPaths } from './user-skills'
import { exportLearningData } from './learning-export'
import { extensionDiagnostics } from './extensions-inventory'
import { projectIdForCwd as deriveProjectId } from './project-id'
import { WorkModeStore, normalizeSessionFileKey } from './work-mode-service'
import { AgentProfileStore } from './agent-profile-store'
import { SpaceStore } from './space-store'
import { LibraryService } from './library-service'
import { ContextAssembler } from './context-assembler'
import { ArtifactDocStore } from './artifact-doc-store'
import { FollowStore } from './follow-store'
import { FOLLOW_APP_ONLY_NOTE, runSummaryText, watchBriefText } from '../shared/follow'
import {
  artifactSourceStatuses,
  excerptReadable,
  excerptText,
  sourceStatus,
  type ResearchExcerpt,
  type SourceRefStatus
} from '../shared/research'
import type { Attachment, AttentionNotify, CompactionRun, FileRequestContext, MainPush, SessionState } from '../shared/ipc'

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

/** 双击链接时不直接启动的类型（可执行、脚本、快捷方式）：只在文件管理器里定位 */
const RUNNABLE_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msix', '.appx', '.scr', '.pif', '.cpl', '.lnk', '.url',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.reg', '.dll',
  '.sys', '.appref-ms', '.application', '.gadget', '.inf', '.msc', '.sh', '.py', '.pyw', '.pyz',
  '.docm', '.xlsm', '.pptm', '.dotm', '.xlam', '.chm', '.ws', '.pl', '.rb', '.iso', '.vhd', '.vhdx'
])
try {
  app.setAppUserModelId(APP_ID)
} catch {
  /* 极早期/平台差异，失败不影响其它功能 */
}

/* 全局状态 */
let win: BrowserWindow | null = null
let tray: Tray | null = null
let trayThemeListening = false
let trayLanguage: string | undefined
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
let piPackageActivationScheduler: PiPackageActivationScheduler | null = null
let skillFilesActivationScheduler: SkillFilesActivationScheduler | null = null
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
/**
 * 子代理：主进程级的生命周期服务。界面与模型（`yan subagent …`）共用同一个控制器，
 * RunnerRegistry 切会话 / 重启 pi 时重建 AgentController，但这个服务不跟着重建。
 */
const subagentService = new SubagentService({
  onChange: (run) => push({ ch: 'subagent', payload: run }),
  onRemove: (id) => push({ ch: 'subagent-remove', payload: id }),
  resolveAgentProfile: (id) => resolveAgentProfile(id),
  /* 结束后叫醒发起它的会话：按稳定会话 id 找实例，找不到（会话已关）就不投 */
  onFinished: createSubagentNotifier({
    enabled: async () => (await getSettings()).subagentNotify !== false,
    find: (run) =>
      (run.parentSessionId ? runners?.agentForSession(run.parentSessionId) : null) ??
      (run.parentRunId ? runners?.agentOf(run.parentRunId) : null) ??
      null
  })
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

/**
 * 工作模式的工具策略扩展的路径（实施-05 S3）。
 *
 * 只有它能在运行中收紧工具表（RPC 没有工具面），所以计划档的门禁靠它执行。
 */
function workModeExtensionPath(): string | undefined {
  return yanThinResourcePath('work-mode.js')
}

/**
 * 活动档案的角色与工具策略扩展的路径（实施-25 P01）。
 *
 * 它只做注入：角色文本与禁用工具由宿主渲染好写进快照，扩展不抄文案。
 * 加载顺序在 `work-mode.js` 之后（两者各自收紧工具，互不恢复对方）。
 */
function agentProfileExtensionPath(): string | undefined {
  return yanThinResourcePath('profile.js')
}

/**
 * 就绪转移之后的内部续行扩展（实施-05 S3b）。
 *
 * 只有扩展 API 能发 `custom` 角色消息并触发回合，所以这段必须留在薄层。
 */
function goalResumeExtensionPath(): string | undefined {
  return yanThinResourcePath('goal-resume.js')
}

/**
 * 交接包生成扩展的路径（实施-05 S5b-2）。
 *
 * 只有扩展 API 能调 `ctx.modelRegistry.complete`（RPC 面没有），所以这段必须留在薄层；
 * 但提示词与校验都在宿主 —— 它只负责「把这一次调用发出去并把原文写回来」。
 */
function handoffsExtensionPath(): string | undefined {
  return yanThinResourcePath('handoffs.js')
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
 * inside pi, …"）换成砚的中文开场白，只动这一句。**不用** `--system-prompt`：
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

/**
 * 内置「能力入口说明」扩展的路径。
 *
 * 它把「有 `yan` 这个入口、输出是摘要 + 结果文件」这段短说明追加到系统提示，
 * 否则模型根本不会去用它（见 resources/pi-extensions/capability-guide.js）。
 */
function capabilityGuideExtensionPath(): string | undefined {
  return yanThinResourcePath('capability-guide.js')
}

/**
 * 内置「上下文状态化压缩」扩展的路径（N21-4 / S2–S6）。
 *
 * 它做 Tool Sweep（旧工具输出 → 墓碑 + `ctx://` 引用）、Task State 前置注入、
 * Recall 工具与结构化压缩的接管闸门。默认接管 `tool-sweep` + `recall` + `compaction`
 * （用户 2026-09-17 拍板：清理默认开，但必须保留可召回引用）；`episode-fold`
 * 仍要等状态生成器。`kinds` 的唯一真源是主进程的 `ContextPolicy`，扩展从环境变量读到同一份。
 * 与 language.js 同一套查找顺序（打包后 / 开发期）。
 */
function contextExtensionPath(): string | undefined {
  return yanThinResourcePath('context.js')
}

/**
 * 内置「项目知识注入」扩展的路径（实施-03 S3）。
 *
 * 它与其它薄层成员一样只做「宿主无法用 CLI / RPC 表达」的那一步：
 * 在 `before_provider_request` 把宿主准备好的材料块放进上下文。
 * 检索与预算全在宿主（见 `main/project-knowledge.ts`）。
 */
function projectKnowledgeExtensionPath(): string | undefined {
  return yanThinResourcePath('project-knowledge.js')
}

/**
 * 单轮重复动作兜底的薄层路径（2026-09-22）。
 *
 * 只有它能在运行时拦下一次工具调用（`tool_call` 钩子），RPC 面没有这个事件。
 */
/** 高危操作确认（薄层 tool_call 钩子；确认框在宿主）。 */
function dangerGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('danger-guard.js')
}
function repeatGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('repeat-guard.js')
}

/** Context budget V1 observes the final post-extension payload for host reconciliation. */
function contextBudgetObserverExtensionPath(): string | undefined {
  return yanThinResourcePath('context-budget-observer.js')
}

/** Budget V1's host-authorized maintenance command and committed context projection. */
function contextBudgetMaintenanceExtensionPath(): string | undefined {
  return yanThinResourcePath('context-budget-maintenance.js')
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
    questionExtensionPath(),
    workModeExtensionPath(),
    agentProfileExtensionPath(),
    goalResumeExtensionPath(),
    handoffsExtensionPath(),
    responseDetailExtensionPath(),
    preambleExtensionPath(),
    languageExtensionPath(),
    capabilityGuideExtensionPath(),
    contextExtensionPath(),
    projectKnowledgeExtensionPath(),
    repeatGuardExtensionPath(),
    dangerGuardExtensionPath(),
    contextBudgetMaintenanceExtensionPath(),
    contextBudgetObserverExtensionPath()
  ].filter((p): p is string => !!p)
}

function push(msg: MainPush): void {
  remoteAccess?.publish(msg)
  if (!win || win.isDestroyed()) return
  win.webContents.send('yan:push', msg)
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


/*
 * 模型出错后的自动继续（实施-05 S5c）。
 *
 * 与交接计数同因：状态要落盘（重启不忘记连续失败了几次），判定要单测。
 * `YAN_AUTO_CONTINUE` 是测试通道（`{limit, delays}`）—— 真实验证时用它把退避压短。
 */
const autoContinueOptions = autoContinueOptionsFromEnv(process.env.YAN_AUTO_CONTINUE)
const autoContinues = new AutoContinueStore(autoContinueOptions)
const AUTO_CONTINUE_LIMIT_EFFECTIVE = autoContinueOptions.limit ?? AUTO_CONTINUE_LIMIT


/**
 * 会话后台工作的调度服务（src/main/session-work-scheduler.ts）：
 * 回合收尾后的交接 / 目标续跑 / 重复拦下补记，以及模型报错后的自动继续，都只在这里决定。
 * 入口（桌面 IPC、远程控制）只调用它，不各自复制调度规则。
 */
const sessionWork = createSessionWorkScheduler({
  stateOf: (id) => runners?.agentOf(id)?.getState() ?? null,
  hasHandoffOperation: (id) => hasHandoffOperation(id),
  handoffPending: (id) => handoffPending.has(id),
  consumeRepeatBlocks: (id) => consumeRepeatBlocks(id),
  tryArmHandoff: (id, reason) => tryArmHandoff(id, reason),
  maybeArmGoalContinue: (id) => maybeArmGoalContinue(id),
  workModeKeyFor: (id) => workModeKeyFor(id),
  autoContinues,
  autoContinueLimit: AUTO_CONTINUE_LIMIT_EFFECTIVE,
  writeRetrySnapshot: (id, snapshot) => writeGoalResumeSnapshot(id, snapshot),
  notify: (id, message, notifyType, idPrefix) => {
    pushFrom(id, {
      ch: 'notify',
      payload: { id: `${idPrefix}-${Date.now()}`, method: 'notify', notifyType, message }
    })
  }
})

/** 用户发言 / 用户停止 / 一轮真的成功 → 计数归零（下一轮错误从第 1 次算）。 */
function resetAutoContinue(id: string): Promise<void> {
  return sessionWork.resetAutoContinue(id)
}

/* ────────────────────────────────────────────── 交接包生成（实施-05 S5b-2） */


/* ────────────────────────────── 同一会话的单一调度（实施-14 F2 / H1） */

/**
 * 每个会话的「下一步动作」串行决定；优先级与判定见 session-work-scheduler.ts。
 * 串行链按 runnerId 分开：不同会话之间没有共享状态，没必要互相阻塞。
 */
function scheduleSessionWork(id: string, reason: string): Promise<void> {
  return sessionWork.schedule(id, reason)
}

function pushFrom(runnerId: string, msg: MainPush): void {
  const identity = handoffIdentities.get(runnerId)
  if (msg.ch === 'state' && identity && msg.payload.sessionId === identity.sessionId) {
    msg = { ...msg, payload: { ...msg.payload, ...identity } }
  }
  const runtime = runners?.runtimeOf(runnerId)
  // 停源是后台换段的一部分；旧进程的退出事件不能把当前聊天变成断线状态。
  if (!runtime && handoffPending.get(runnerId)?.sourceState) return
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
  /*
   * 交接资格第二个评估时机（实施-05 S5b-2）：**回合刚结束**。
   *
   * 为什么需要它：`goal report` 发生在回合**中途**（工具调用），那一刻实例是忙的，
   * 资格判定会正确地拒掉；而「目标在推进 + 自主档 + 不忙」三条同时成立的真实时刻，
   * 恰恰是这一轮收尾之后。`maybeArmHandoff` 自己是幂等 + 节流的，
   * 所以这里可以无条件看一眼（忙的时候它内部直接早退，不碰 IO）。
   */
  /*
   * 调度时机（回合结束 → 排后台工作；模型报错 → 自动继续；一轮真的产出 → 失败计数归零）
   * 统一交给调度服务判定，见 session-work-scheduler.ts。
   */
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
  if (!piPackageActivationScheduler && !skillFilesActivationScheduler) return
  if (piPackageActivationInFlight) {
    piPackageActivationAgain = true
    return
  }
  if (piPackageActivationTimer) clearTimeout(piPackageActivationTimer)
  piPackageActivationTimer = setTimeout(() => {
    piPackageActivationTimer = null
    const schedulers = [piPackageActivationScheduler, skillFilesActivationScheduler].filter(
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

/** 把所有运行实例的状态推给渲染端（左栏状态槽） */
function pushRunners(): void {
  push({ ch: 'runners', payload: runners?.statuses() ?? [] })
  refreshTrayMenu()
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
 * 可编辑成果（实施-25 P06a）的存储。
 *
 * 与 `artifacts.ts`（消息里的文件产物，按会话隔离）不同：这里是用户与 agent
 * 都要改的文档对象。版本推进规则全在 `shared/artifact-doc.ts` 的纯函数里，
 * 这一层只做 I/O。
 */
const artifactDocs = new ArtifactDocStore()

/**
 * 持续关注（实施-25 P16）。
 *
 * 这个 store 里**没有调度器**：宿主不主动调模型（会变成后台花钱），
 * 它只回答「谁到点了」并把模型回报的结果记下来。
 */
const follows = new FollowStore()

/**
 * 成果引用的资料现在怎么样了（P13 T13-4）：只回报状态，**不改引用**。
 */
async function runSourceStatus(artifactId: string) {
  await library.store.load()
  await artifactDocs.load()
  const doc = artifactDocs.find(artifactId)
  if (!doc) return { ok: false as const, error: '找不到这份成果', statuses: [] }
  return { ok: true as const, statuses: artifactSourceStatuses(library.store.document(), doc.sources) }
}

interface ResearchReadInput {
  refs?: { sourceId: string; version: number; locator?: { start: number; end: number } }[]
  maxChars?: number
}

/**
 * 按版本读资料片段：读**当时那一版**的正文，不跟着资料更新走。
 *
 * 读不到的来源如实放进 `skipped`，不混进片段 —— 否则「三份资料都支持」
 * 可能实际只有两份读得到。怎么对照、怎么下结论由 research 技能说明。
 */
async function runResearchRead(input: ResearchReadInput) {
  await library.store.load()
  const doc = library.store.document()
  const maxChars = Math.max(200, Math.min(Math.trunc(input?.maxChars ?? 600), 4000))
  const excerpts: ResearchExcerpt[] = []
  const skipped: { sourceId: string; version: number; status: SourceRefStatus }[] = []
  for (const ref of input?.refs ?? []) {
    if (!ref?.sourceId || !Number.isFinite(ref.version)) continue
    const version = Math.trunc(ref.version)
    const status = sourceStatus(doc, { sourceId: ref.sourceId, version }, ref.locator)
    if (!excerptReadable(status.status)) {
      skipped.push({ sourceId: ref.sourceId, version, status: status.status })
      continue
    }
    const opened = await library.openRef({ sourceId: ref.sourceId, version })
    const cut = excerptText(opened.text ?? '', ref.locator, maxChars)
    if (!cut.text.trim()) {
      skipped.push({ sourceId: ref.sourceId, version, status: 'unreadable' })
      continue
    }
    excerpts.push({
      sourceId: ref.sourceId,
      version,
      title: status.title ?? opened.source?.title ?? `资料 ${ref.sourceId}`,
      text: cut.text,
      truncated: cut.truncated,
      status: status.status,
      ...(status.latestVersion ? { latestVersion: status.latestVersion } : {}),
      ...(ref.locator ? { locator: ref.locator } : {})
    })
  }
  return { ok: true as const, excerpts, skipped }
}


/**
 * `yan goal …` 的实现点（实施-05 S3）。
 *
 * 三条规则落在这里：
 *   ① **身份来自宿主**：会话键用 `workModeKeyFor`（= 会话文件路径），
 *      不接受请求里的会话 / 项目 id；
 *   ② **就绪转移是原子的**：先把目标推进到 executing（落盘），再切模式；
 *      模式写失败就不报成功（否则会出现「目标说已开工、模式还是计划」）；
 *   ③ **校验在纯函数里**（`shared/goal.ts`）：五栏 / 置信度 / revision 过期。
 *
 * ⚠️ 模式切到标准**不会**改写本轮已经生效的工具表（工具集按轮次生效，
 *    S1 实测）：本轮仍是计划档的只读集，所以回执里要明说
 *    「本轮收尾，下一轮开始执行」——不然模型会以为现在就能写文件。
 */
/**
 * 资料引用：按版本读片段，以及成果引用的资料现在怎么样了。
 * 对照与下结论的做法在 research 技能里。
 */
const researchCapabilityHost: GoalCommandHost = {
  async run(command, params) {
    switch (command) {
      case 'research.read': {
        const res = await runResearchRead({
          refs: Array.isArray(params.refs) ? (params.refs as ResearchReadInput['refs']) : [],
          ...(Number.isFinite(Number(params.maxChars)) ? { maxChars: Number(params.maxChars) } : {})
        })
        return {
          data: { excerpts: res.excerpts, skipped: res.skipped },
          summary: {
            ok: true,
            excerpts: res.excerpts.length,
            outdated: res.excerpts.filter((e) => e.status === 'outdated').length,
            skipped: res.skipped.length
          }
        }
      }
      case 'research.status': {
        const res = await runSourceStatus(String(params.artifactId ?? params.id ?? ''))
        return {
          data: { statuses: res.statuses },
          summary: {
            ok: res.ok,
            changed: res.statuses.filter((s) => s.status !== 'current').length,
            total: res.statuses.length
          }
        }
      }
      default:
        return { summary: { ok: false, error: `未知的研究动作：${command}` } }
    }
  }
}

/**
 * 持续关注（实施-25 P16）。
 *
 * 模型能做的：看有哪些关注、看谁到点了、**提议**一个新关注、
 * 看完之后**回报**结果。
 *
 * 三件它做不到（都是故意的）：
 *   · 不能启用关注 —— 提议存下来就是未启用（T16-3），只有用户点过才会跑；
 *   · 不能删关注 —— 那是用户的东西；
 *   · 不能让宿主自己去查 —— 没有这种命令（不然就成了后台花钱）。
 */
const followCapabilityHost: GoalCommandHost = {
  async run(command, params) {
    switch (command) {
      case 'follow.list': {
        const spaceId = typeof params.spaceId === 'string' ? params.spaceId : null
        const views = follows.views(spaceId).map((view) => ({
          id: view.watch.id,
          title: view.watch.title,
          kind: view.watch.kind,
          enabled: view.watch.enabled,
          status: view.status,
          proposed: view.proposed,
          resultPlace: view.watch.resultPlace,
          ...(view.lastRun ? { lastRun: runSummaryText(view.lastRun) } : {})
        }))
        return {
          data: { watches: views },
          summary: {
            ok: true,
            count: views.length,
            enabled: views.filter((v) => v.enabled).length,
            proposals: views.filter((v) => v.proposed).length
          }
        }
      }
      case 'follow.due': {
        const due = follows.due()
        return {
          data: {
            due: due.map((watch) => ({
              id: watch.id,
              title: watch.title,
              lastCheckedAt: watch.lastCheckedAt ?? null,
              brief: watchBriefText(watch, follows.runs(watch.id, 3))
            }))
          },
          summary: {
            ok: true,
            count: due.length,
            note: FOLLOW_APP_ONLY_NOTE
          }
        }
      }
      case 'follow.save': {
        /*
         * 模型只能**提议**：强制 `origin: 'agent'` 与 `enabled: false`，
         * 无论它传了什么 —— 「用户未启用的关注不自行建立任务」不能靠模型自觉（T16-3）。
         */
        const raw = (params.watch && typeof params.watch === 'object' ? params.watch : params) as Record<string, unknown>
        const res = await follows.save({ ...raw, origin: 'agent', enabled: false })
        if (!res.ok) return { summary: { ok: false, error: res.error, code: res.code } }
        return {
          data: { id: res.value.id, title: res.value.title, status: 'proposed' },
          summary: {
            ok: true,
            /** 如实告知：这是提议，等用户点才生效 */
            note: '已存成提议（未启用）：用户点「开始关注」之后才会出现在到点提醒里。',
            cadence: res.value.cadence,
            intervalMinutes: res.value.intervalMinutes ?? null
          }
        }
      }
      case 'follow.report': {
        const res = await follows.report({
          watchId: params.watchId ?? params.id,
          outcome: params.outcome,
          summary: params.summary,
          changed: params.changed,
          decisions: params.decisions
        })
        if (!res.ok) return { summary: { ok: false, error: res.error, code: res.code } }
        return {
          data: { runId: res.value.run.id, text: runSummaryText(res.value.run) },
          summary: {
            ok: true,
            outcome: res.value.run.outcome,
            changed: res.value.run.changed.length,
            decisions: res.value.run.decisions.length,
            nextDueAt: res.value.watch.nextDueAt ?? null
          }
        }
      }
      default:
        return { summary: { ok: false, error: `未知的关注动作：${command}` } }
    }
  }
}

const goalCapabilityHost: GoalCommandHost = {
  async run(command, params, context) {
    await goals.load()
    const key = workModeKeyFor(context.sessionId)
    const modeState = await resolveWorkMode(context.sessionId)
    const goal = goals.state(key)

    if (command === 'goal.ready') {
      const submission = normalizeReadyParams(params)
      let res: Awaited<ReturnType<GoalStore['commitReady']>>
      if (goal.readyApproval === 'review') {
        const review = await goals.prepareReadyReview(
          key,
          submission,
          { modeRevision: modeState.revision, goalRevision: goal.revision },
          goal.goalId || `goal-${context.sessionId}`
        )
        if (!review.ok) {
          throw new CapabilityCommandError(review.code, review.message, {
            goal: review.goal,
            mode: modeState.mode,
            modeRevision: modeState.revision
          })
        }
        if ('pending' in review && review.pending) {
          await pushGoal(context.sessionId)
          await pushWorkMode(context.sessionId)
          return {
            data: {
              replayed: review.replayed,
              pendingApproval: true,
              goal: review.goal,
              note: '计划已保存，等待用户审阅。当前仍是只读计划档；不要调用写工具或提交目标进度。'
            },
            summary: {
              kind: 'goal',
              action: 'ready-review',
              replayed: review.replayed,
              goalId: review.goal.pendingReady?.goalId ?? review.goal.goalId,
              goalRevision: review.goal.revision,
              phase: review.goal.phase,
              mode: modeState.mode
            }
          }
        }
        res = review as Awaited<ReturnType<GoalStore['commitReady']>>
      } else {
        res = await goals.commitReady(
          key,
          submission,
          { modeRevision: modeState.revision, goalRevision: goal.revision },
          goal.goalId || `goal-${context.sessionId}`
        )
      }
      if (!res.ok) {
        throw new CapabilityCommandError(res.code, res.message, {
          goal: res.goal,
          mode: modeState.mode,
          modeRevision: modeState.revision
        })
      }
      if (!res.replayed) {
        const switched = await workModes.set(key, 'standard', modeState.revision)
        if (!switched.ok) {
          throw new CapabilityCommandError(
            'mode_switch_failed',
            `就绪已提交，但模式切换失败（${switched.error ?? 'unknown'}）；重试时带同一个 transitionId 就会回放已提交结果`,
            { goal: res.goal, currentMode: switched.state }
          )
        }
        await pushWorkMode(context.sessionId)
        /* 先落盘（commitReady 里已做）再告诉薄层可以开工：顺序不能反（§4） */
        await applyGoalResume(context.sessionId)
      }
      await pushGoal(context.sessionId)
      return {
        data: {
          replayed: res.replayed,
          goal: res.goal,
          transition: res.result,
          note: res.replayed
            ? '这次是重放：就绪转移已经提交过，不会重复切换模式'
            : '模式已切标准（下一轮生效）。本轮工具集仍是只读：先收尾，不要在这一轮里改文件。'
        },
        summary: {
          kind: 'goal',
          action: 'ready',
          replayed: res.replayed,
          goalId: res.result.goalId,
          goalRevision: res.goal.revision,
          phase: res.goal.phase,
          mode: 'standard'
        }
      }
    }

    if (command === 'goal.report') {
      const res = await goals.report(key, normalizeReportParams(params))
      if (!res.ok) {
        throw new CapabilityCommandError(res.code, res.message, {
          goal: res.goal,
          mode: modeState.mode,
          modeRevision: modeState.revision
        })
      }
      /*
       * 目标进终态（completed / blocked / stopped）→ **立刻**把薄层可见的续行清掉。
       *
       * `GoalStore.report` 已经在同一次落盘里把 `entry.resume` 置空了，但那只是
       * `goals.json`；薄层读的是 `goal-resume/<runnerId>.json` 快照（实施-14 A1）。
       * 两份不同步时，停在 executing 时 arm 的那条「接着干」会在目标已经交付之后
       * 才发出去，把模型重新叫起来干一件已经完的事。
       */
      if (!isActiveGoalPhase(res.goal.phase)) {
        await applyGoalResume(context.sessionId)
        handoffDiag.record({
          stage: 'goal-continue',
          outcome: 'terminal-cleared',
          reason: res.goal.phase,
          runnerId: context.sessionId,
          sessionKey: key,
          detail: { goalId: res.goal.goalId }
        })
      }
      /*
       * 顺路看一眼要不要开始交接（S5b-2）：资格四条里「目标在推进」正是在这里才可能成立 ——
       * 只靠压缩事件驱动会在「先报告、后压缩」的顺序下漏掉。
       * 生产上阈值没到就什么都不会发生（阈值覆盖只在测试里设）。
       */
      if (!res.replayed) void scheduleSessionWork(context.sessionId, 'goal-report')
      /*
       * 自主档（或带 pursue 的持续目标）的「接着干」（S3c）：报完进展就安排下一次续接，
       * 让模型在**没有人再发消息**的情况下自己一轮轮往下推。
       *
       * 为什么标准档默认不 arm：用户就在旁边看着，自己往下跑会抢他的话；
       * 而 `pursue` 是**目标**语义（用户在 `+` 菜单里明确要求持续推进），与档位正交。
       * 能不能真发出去由薄层的空闲判定决定（本轮没结束就留着，见 goal-resume.js）。
       */
      let continueNote: string | null = null
      let continueRound: number | null = null
      if (!res.replayed && !hasHandoffOperation(context.sessionId) && (modeState.mode === 'autonomous' || res.goal.pursue)) {
        const armed = await goals.armContinue(key, {
          consumed: (operationId) => goalResumeContinuationWasConsumed(context.sessionId, operationId),
          usage: await goalBudgetUsage(context.sessionId, goals.startOf(key))
        })
        if (armed.armed) {
          continueRound = armed.round
          /* 先落盘（armContinue 已 await persist）再告诉薄层 —— 顺序不能反（§4） */
          await applyGoalResume(context.sessionId)
          handoffDiag.record({
            stage: 'goal-continue',
            outcome: 'armed',
            runnerId: context.sessionId,
            sessionKey: key,
            detail: { round: armed.round, mode: modeState.mode, pursue: res.goal.pursue === true }
          })
          continueNote =
            `已安排第 ${armed.round} 次自动续接：本轮的活干完就收尾，` +
            '之后会有一条控制消息把你叫回来继续，不要停下来等用户确认。'
        } else if (armed.reason === 'limit') {
          continueNote =
            `已达自动续接上限（${AUTONOMOUS_CONTINUE_LIMIT} 次），不再自动叫你：` +
            '请在本轮里把进展、结论与需要用户决定的事写清楚。'
        } else if (armed.reason === 'pending') {
          /*
           * A6：同一条待发操作还在（模型重复 report，或上一轮还没发出），
           * **不新建也不递增轮数** —— 如实复述已有的那一条。
           */
          continueRound = goals.autoContinueCount(key)
          continueNote = `第 ${continueRound} 次自动续接已经安排，等待当前回合收尾后继续。`
        } else if (armed.reason === 'paused') {
          /*
           * A2：用户按过停止。不自动继续，也不装作“已经安排”——
           * 让模型在本轮里把现场交代清楚，等用户明确发话再恢复。
           */
          continueNote = '用户已暂停自动推进：本轮收尾后不会自动继续，需要用户明确发话或恢复档位。'
        }
      } else if (res.replayed && modeState.mode === 'autonomous' && isActiveGoalPhase(res.goal.phase)) {
        /*
         * reportId 重放是正常的 RPC / 模型重试，不应把已经存在的续行说成
         * 没有安排。这里只复述仍待消费的那一条，不再重复 arm，避免多启动一轮。
         */
        const existing = goals.resumeOf(key)
        if (existing?.kind === 'continue' && !(await goalResumeContinuationWasConsumed(context.sessionId, existing.operationId))) {
          continueRound = goals.autoContinueCount(key)
          continueNote = `第 ${continueRound} 次自动续接已经安排，等待当前回合收尾后继续。`
        }
      }
      await pushGoal(context.sessionId)
      return {
        data: {
          replayed: res.replayed,
          goal: res.goal,
          summary: goalSummary(res.goal),
          ...(continueNote ? { note: continueNote } : {}),
          ...(continueRound ? { autoContinueRound: continueRound } : {})
        },
        summary: {
          kind: 'goal',
          action: 'report',
          replayed: res.replayed,
          phase: res.goal.phase,
          goalRevision: res.goal.revision,
          stepsDone: res.goal.steps.filter((step) => step.status === 'done').length,
          stepsTotal: res.goal.steps.length,
          blocked: res.goal.phase === 'blocked',
          autoContinueArmed: continueRound != null
        }
      }
    }

    if (command === 'goal.status') {
      return {
        data: { goal, mode: modeState, modeRevision: modeState.revision, summary: goalSummary(goal) },
        summary: {
          kind: 'goal',
          action: 'status',
          phase: goal.phase,
          goalRevision: goal.revision,
          mode: modeState.mode,
          modeRevision: modeState.revision
        }
      }
    }

    throw new CapabilityCommandError('unknown_command', `未知的 goal 动作：${command}`)
  }
}

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
  const st = ag.getState()
  if (st) pushFrom(id, { ch: 'state', payload: st })
  try {
    let payload = await ag.getMessages()
    if (opts.chainHistory && st?.sessionFile) {
      const chain = await readHistoryWithArtifacts(st.sessionFile).catch(() => null)
      /* 只接受“真的不更短”的链历史：读盘给空时不能把界面清空 */
      if (chain?.messages?.length && chain.messages.length >= payload.length) payload = chain.messages
    }
    pushFrom(id, { ch: 'sync', payload })
  } catch {
    /* 拿不到就当空会话，下一次事件会补 */
  }
  void ag
    .refreshStats()
    .then((stats) => {
      if (stats) pushFrom(id, { ch: 'stats', payload: stats })
    })
    .catch(() => {})
  void ag.refreshTodos().catch(() => {})
  /* 工作模式跟随实例推送：切会话 / 新建 / 启动都经这里，一处覆盖所有路径 */
  await pushWorkMode(id)
  await pushAgentProfile(id)
  await pushGoal(id)
  pushRunners()
}

/**
 * 退出前的清理：收好 pi 子进程 —— 否则会留下孤儿 node 进程。
 */
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  tray?.destroy()
  tray = null
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
  /* 退出前把子代理一起收掉（方案 8.3：主任务停了，它的子任务不该变孤儿） */
  try {
    await subagentService.current()?.stopAll()
  } catch {
    /* 忽略 */
  }
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
      const result = await ac()?.send(command.text ?? '')
      return result?.ok
        ? { ok: true, action: command.action, data: { length: command.text?.length ?? 0 } }
        : { ok: false, action: command.action, error: result?.error ?? 'pi 未运行' }
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
function trayImage(): Electron.NativeImage {
  const name = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'tray-on-dark.png' : 'tray-on-light.png'
  const candidates = [join(app.getAppPath(), 'build', 'tray', name), join(__dirname_, '..', '..', 'build', 'tray', name)]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return nativeImage.createFromPath(found)
  const iconPath = shellIconPath()
  return iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
}

async function createTray(): Promise<void> {
  if (tray) return
  tray = new Tray(trayImage())
  /* 用户切换任务栏深浅时跟着换字形 */
  if (!trayThemeListening) {
    trayThemeListening = true
    nativeTheme.on('updated', () => tray?.setImage(trayImage()))
  }
  tray.setToolTip('砚 · Yan')
  const settings = await getSettings()
  trayLanguage = settings.lang
  refreshTrayMenu()
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

/**
 * 重建托盘菜单（阶段 3）。
 *
 * Electron 的 Tray 菜单不是 DOM，不能让 renderer 的左栏直接复用；每次
 * 运行实例快照变化时重建一份很小的原生菜单，保证“查看运行中的会话”
 * 不会停留在旧状态。菜单项只携带 sessionId/cwd，不把消息正文或 token
 * 放进系统菜单。
 */
function refreshTrayMenu(): void {
  if (!tray) return
  const zh = trayLanguage !== 'en-US'
  const statuses = runners?.statuses() ?? []
  const live = statuses.filter((status) => status.running || status.waiting || status.conn === 'starting')
  const sessionItems: Electron.MenuItemConstructorOptions[] = live.length
    ? live.map((status) => {
        const name = status.sessionFile
          ? basename(status.sessionFile)
          : status.sessionId || status.id
        const state = status.waiting
          ? (zh ? '等待回答' : 'Waiting')
          : status.running
            ? (zh ? '运行中' : 'Running')
            : (zh ? '启动中' : 'Starting')
        return {
          label: `${status.isActive ? '● ' : ''}${name} · ${state}`,
          click: () => {
            showMainWindow()
            push({
              ch: 'tray-select-session',
              payload: {
                ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
                ...(status.sessionId ? { sessionId: status.sessionId } : {}),
                ...(status.projectId ? { projectId: status.projectId } : {}),
                cwd: status.cwd
              }
            })
          }
        }
      })
    : [{ label: zh ? '暂无运行中的会话' : 'No running sessions', enabled: false }]

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: zh ? '显示砚' : 'Show Yan', click: showMainWindow },
    {
      label: zh ? '新建会话' : 'New session',
      click: () => {
        showMainWindow()
        push({ ch: 'tray-new-session', payload: null })
      }
    },
    {
      label: zh ? '查看运行中的会话' : 'Running sessions',
      submenu: sessionItems
    },
    { type: 'separator' },
    { label: zh ? '退出砚' : 'Quit Yan', click: () => void requestExit() }
  ]))
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
  const checked = await validateCwd(requestedCwd)
  if (!checked.ok) return { ok: false, context: provisional, error: checked.error }

  if (projectId) {
    const project = settings.projects.find((item) => item.id === projectId)
    if (!project) return { ok: false, context: { ...provisional, cwd: checked.cwd }, error: '项目不存在或已被移除' }
    if (normalizeCwdForIdentity(project.cwd) !== normalizeCwdForIdentity(checked.cwd)) {
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
function reportExtensionSources(): void {
  if (extensionSourcesReported) return
  extensionSourcesReported = true
  const thin = yanThinExtensionPaths()
  for (const text of extensionDiagnostics({ piDir: PI_AGENT_DIR, yanThinPaths: thin })) {
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
      push({
        ch: 'notify',
        payload: {
          id: `iso-${Date.now()}`,
          method: 'notify',
          notifyType: 'info',
          message:
            `同一工作目录已有会话在运行：已在隔离工作树 ${outcome.record.worktree}（分支 ${outcome.record.branch}）中打开这条会话。` +
            `两边都空闲时会把它的提交自动合回 ${outcome.record.baseBranch}。`
        }
      })
      return { cwd: outcome.record.worktree }
    },
    /* 每个实例自己一个 pi 子进程；事件带上实例 id（N12） */
    createAgent: (id, cwd, generation) =>
      new AgentController({
        push: (m) => pushFrom(id, m),
        cwd,
        piBin: settings.piBin,
        questionExtension: questionExtensionPath(),
        workModeExtension: workModeExtensionPath(),
        agentProfileExtension: agentProfileExtensionPath(),
        goalResumeExtension: goalResumeExtensionPath(),
        handoffsExtension: handoffsExtensionPath(),
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
        /* 目标状态（实施-05 S3）：会话键与模式 store 都在本文件一侧。 */
        goalHost: goalCapabilityHost,
        /* 资料引用：按版本读片段与引用状态。 */
        researchHost: researchCapabilityHost,
        /* 持续关注（实施-25 P16）：到点提醒与结果记录，没有后台调度器。 */
        followHost: followCapabilityHost,
        preambleExtension: preambleExtensionPath(),
        languageExtension: languageExtensionPath(),
        capabilityGuideExtension: capabilityGuideExtensionPath(),
        contextExtension: contextExtensionPath(),
        /* 项目知识注入（实施-03 S3）：检索在宿主，扩展只负责放到用户消息之前 */
        projectKnowledgeExtension: projectKnowledgeExtensionPath(),
        /* 单轮重复动作兜底（2026-09-22）：拦下在薄层，计入目标失败签名在宿主 */
        repeatGuardExtension: repeatGuardExtensionPath(),
        dangerGuardExtension: dangerGuardExtensionPath(),
        bundledSkills: bundledSkillPaths(),
        /* 用户技能（YAN_DIR/skills）：每次启动会话时重新列出 */
        userSkills: () => userSkillPaths(),
        contextBudgetObserverExtension: contextBudgetObserverExtensionPath(),
        contextBudgetMaintenanceExtension: contextBudgetMaintenanceExtensionPath(),
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
          onBashSettled: () => requestPiPackageActivationTick()
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
                    '本地包可在 pi 重载后以当前 Windows 用户权限运行；staging 不是沙箱。',
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
            message: `即将通过 ${request.provider === 'compatible' ? 'OpenAI-compatible API' : 'OpenAI API'} 生成图片`,
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
        /* 高危操作确认（danger-guard 薄层发起）：每次都弹框，不记忆；关掉框按拒绝。 */
        confirmDanger: async (request): Promise<ConsentDecision | null> => {
          if (!win || win.isDestroyed()) return null
          const response = await dialog.showMessageBox(win, {
            type: 'warning',
            title: '高危操作，需要你确认',
            message: 'Agent 想执行一个难以撤销的操作',
            detail: [
              ...request.reasons.map((r) => `· ${r}`),
              '',
              request.tool === 'bash' ? `命令：${request.detail}` : `文件：${request.detail}`,
              `项目：${request.cwd}`,
              '',
              '拒绝后模型会收到说明并改用别的做法。每次都会询问，不会记住你的选择。'
            ].join('\n'),
            buttons: ['拒绝', '允许这一次'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
          return response.response === 1 ? 'allow' : 'deny'
        },
        /*
         * 普通工具使用前的询问（需求稿 4.3）。关掉对话框不算答复（返回 null，不记录）；
         * 只有点「允许」或「拒绝」才写进同意记录。
         */
        confirmToolConsent: async (request: ToolConsentPrompt): Promise<ConsentDecision | null> => {
          if (!win || win.isDestroyed()) return null
          const { parts, verdict } = request
          const response = await dialog.showMessageBox(win, {
            type: verdict.danger ? 'warning' : 'question',
            title: '允许使用这个工具吗？',
            message: `Agent 想使用「${parts.capability}」执行「${parts.action}」`,
            detail: [
              `资源：${parts.resource}`,
              ...(request.purpose ? [`用途：${request.purpose}`] : []),
              `项目：${request.cwd}`,
              '',
              verdict.reason,
              verdict.danger
                ? '危险类别不会因为同意次数多而自动放行。'
                : '同类操作多次同意后会自动放行；可在「设置 → 能力」里改为始终询问或清空记录。'
            ].join('\n'),
            buttons: ['拒绝', '允许'],
            defaultId: 0,
            cancelId: 2,
            noLink: true
          })
          return response.response === 1 ? 'allow' : response.response === 0 ? 'deny' : null
        }
      }),
    onChanged: () => {
      pushRunners()
      requestPiPackageActivationTick()
    }
  })

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
        restartOne: (id) => runners?.restartOne(id) ?? Promise.resolve({ ok: false, error: '运行实例注册表尚未就绪' }),
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
  skillFilesActivationScheduler = new SkillFilesActivationScheduler(
    acquisitions,
    createSkillFilesActivationHostPorts({
      root: YAN_DIR,
      service: acquisitions,
      authorizations: packageAuthorizations,
      goals,
      runners: {
        activationSnapshot: (target) => runners?.activationSnapshot(target) ?? null,
        agentOf: (id) => runners?.agentOf(id) ?? null,
        restartOne: (id) => runners?.restartOne(id) ?? Promise.resolve({ ok: false, error: '运行实例注册表尚未就绪' }),
        hasBusyCwd: (cwd) => runners?.hasBusyCwd(cwd) ?? false
      },
      isTrusted: async (cwd) => (await trustStatus(cwd)).trusted,
      sourceHead: async (cwd) => (await readRepoState(cwd, { withRefs: false }))?.head ?? null
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
  if (agentRestarting) return
  /* 启动还没跑完就别动它 —— 等它落定再判断要不要重启 */
  if (starting) await starting
  if (!runners) return
  /*
   * 只要有**任何一个**实例在干活就不能重启（N12）：重启会抦断的不只是
   * 眼前这个会话，后台会话的流也会一起断。一直等到全部空闲。
   */
  if (runners.hasBusy()) {
    if (retries <= 0) return
    setTimeout(() => void restartAgent(reason, retries - 1), 2000)
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
  const ipc = createIpcRegistrar((event) => !!win && !win.isDestroyed() && event.sender === win.webContents)
  const { handle, rawHandle } = ipc

  /* ---- 会话 ---- */
  handle('yan:start', async () => {
    const settings = await getSettings()
    const res = await startAgent()
    return { ...res, state: ac()?.getState() ?? undefined, settings }
  })

  handle('yan:send', async (text: string, images?: { data: string; mimeType: string }[], mode?: 'steer' | 'followUp') => {
    let targetId = runners?.activeRunnerId
    const handoffEntry = targetId ? [...handoffPending.entries()].find(([sourceId, op]) => sourceId === targetId || op.destinationRunId === targetId) : undefined
    const handoff = handoffEntry?.[1]
    if (handoff?.collecting) {
      await handoff.settled
      if (handoff.cancelled) return { ok: false, error: '交接已停止，请重新发送' }
      targetId = handoff.destinationRunId ?? targetId
      if (targetId && handoffPending.get(targetId) === handoff) {
        await abandonHandoff(targetId, 'user-message', handoff.request.operationId)
      }
    } else if (handoff && targetId) {
      await abandonHandoff(handoffEntry![0], 'user-message', handoff.request.operationId)
    }
    if (handoff && targetId && !runners?.agentOf(targetId)?.running) {
      return { ok: false, error: '会话正在恢复，请稍后重新发送' }
    }
    if (!targetId || !runners?.agentOf(targetId)?.running) {
      const r = await startAgent()
      if (!r.ok) return r
      targetId = runners?.activeRunnerId
    }
    /*
     * 用户发话了：自主档的**连续**自动续接计数归零（S3c）。
     * 上限只约束「无人看管的连续自动轮」—— 有人参与就重新给满额度。
     */
    const id = targetId
    if (id) {
      await goals.load()
      const mode = await resolveWorkMode(id)
      const key = workModeKeyFor(id)
      const goal = goals.state(key)
      const pending = goals.resumeOf(key)
      /*
       * 用户发言 = 明确接管（实施-14 A2/A3）：旧自动续行作废、**暂停解除**。
       * 不再只看自主档 —— `pursue` 目标在标准档下同样会自己往下跑，
       * 而用户这一句话就是「我来接手」的意思。
       */
      if (mode.mode === 'autonomous' || goal.pursue === true || pending !== null || goals.isPaused(key)) {
        await cancelGoalResume(id)
      }
      await goals.setPaused(key, false).catch(() => {})
      /* await：用户发言必须先于模型接下来的 arm 落地，否则竞态下计数不会被归零 */
      await goals.resetAutoContinues(key).catch(() => {})
      /* 用户发话了 = 他接手了：自动继续作废、连续失败计数归零（S5c） */
      await resetAutoContinue(id)
      if (mode.mode === 'autonomous') {
        if (text.trim()) await goals.ensureAutonomousGoal(key, text)
        await pushGoal(id)
      }
    }
    return (id ? runners?.agentOf(id)?.send(text, images, mode) : undefined) ?? { ok: false, error: 'pi 未运行' }
  })

  handle('yan:steer', async (text: string) => ac()?.steer(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:followUp', async (text: string) => ac()?.followUp(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:steerQueued', async (queueId: string) => ac()?.steerQueued(queueId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:removeQueued', async (queueId: string) => ac()?.removeQueued(queueId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:abort', async () => {
    /*
     * 用户停止优先（实施-14 A2）：**先失效续接资格，再停当前回合**。
     *
     * 顺序反过来会留一个窗口：`abort()` 期间实例已经空闲，一次 `state` 推送
     * 就能让 `maybeArmGoalContinue` 重新 arm 一条续行 —— 用户按了停止，
     * 下一轮却自己跑起来。所以这里是「登记暂停（代次失效）→ 清快照 → 停回合」，
     * 而且**同步 awaited**：不能让异步清理跑到后面去。
     */
    const id = runners?.activeRunnerId
    if (id) {
      await goals.load()
      for (const [sourceId, pending] of handoffPending) {
        if (sourceId !== id && pending.destinationRunId !== id) continue
        pending.cancelled = true
        await goals.setPaused(pending.request.sessionKey, true)
        if (pending.destinationRunId) {
          await goals.setPaused(workModeKeyFor(pending.destinationRunId), true)
          await cancelGoalResume(pending.destinationRunId)
          await runners?.agentOf(pending.destinationRunId)?.abort()
        }
        await abandonHandoff(sourceId, 'user-stop', pending.request.operationId)
      }
      const key = workModeKeyFor(id)
      await goals.setPaused(key, true).catch(() => {})
      await cancelGoalResume(id).catch(() => {})
      handoffDiag.record({
        stage: 'goal-continue',
        outcome: 'cancelled',
        reason: 'user-stop',
        runnerId: id,
        sessionKey: key,
        detail: { paused: true }
      })
    }
    // 把 clear_queue 拿回来的排队文本一并返回，客户端应放回输入框
    const cleared = (await ac()?.abort()) ?? { steering: [], followUp: [] }
    /* 用户停止 = 立刻停手：未到点的自动继续也要撤掉，并归零（S5c） */
    if (id) void resetAutoContinue(id)
    /* 停止只是暂停，不是放弃目标 —— 目标级 `stopped` 走 `yan:stopGoal` */
    return cleared
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
  handle('yan:runBash', async (command: string) => ac()?.runBash(command) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:abortBash', async () => {
    await ac()?.abortBash()
  })

  registerSessionIpc(ipc, sessionHost)

  /* ---- 模型 / 思考 ---- */
  handle('yan:listModels', async () => ac()?.listModels() ?? [])
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
  handle('yan:agentStatus', async () =>
    ac()?.getConn() ?? { state: 'starting' as const, detail: '' }
  )
  handle('yan:getMessages', async () => ac()?.getMessages() ?? [])
  handle('yan:getStats', async () => ac()?.refreshStats() ?? null)

  registerAuthIpc(ipc, {
    restartAgent: (reason: string) => restartAgent(reason),
    sendOAuthEvent: (event) => {
      if (win && !win.isDestroyed()) win.webContents.send('yan:oauth', event)
    }
  })

  registerFilesIpc(ipc, { resolveFileContext })

  /* ---- 设置 ---- */  handle('yan:getSettings', async () => {
    const s = await getSettings()
    return { ...s, lang: s.lang, theme: s.theme }
  })
  handle('yan:patchSettings', async (patch: Record<string, unknown>) => {
    const before = await getSettings()
    const next = await patchSettings(patch as never)
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
  ipcMain.on('yan:respondUi', (_e, res) => (runners ? runners.respondUi(res) : ac()?.respondUi(res)))

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
  ipcMain.on('yan:hotkey-guard', (_e, v) => {
    hotkeyGuardPaused = Boolean(v)
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
  ipcMain.on('yan:renderer-ready', () => {
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
    if (!p) return { ok: false, error: 'empty path' }
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
    if (RUNNABLE_EXT.has(extname(target).toLowerCase()) || RUNNABLE_EXT.has(extname(real).toLowerCase())) {
      shell.showItemInFolder(target)
      return { ok: true, revealed: true }
    }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

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
    if (p && existsSync(p)) shell.showItemInFolder(p)
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
  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:maximize', () => {
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', () => win?.close())
  rawHandle('win:requestExit', async () => requestExit())
  rawHandle('win:lifecycle', () => ({
    tray: tray !== null,
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
  registerSubagentsIpc(ipc, {
    service: subagentService,
    parentContext: async () => {
      const settings = await getSettings()
      const state = ac()?.getState()
      const active = runners?.activeRunner()
      const runtime = active?.id ? runners?.runtimeOf(active.id) : null
      return {
        cwd: state?.cwd ?? active?.cwd ?? settings.cwd,
        /* 空白新会话在 pi 首次写入前可能还没有 sessionId；runtime 的
         * pending:<runId> 是可追踪的明确占位，不把父子关系丢掉。 */
        parentSessionId: state?.sessionId || runtime?.sessionId,
        parentRunId: active?.id,
        projectId: state?.cwd ? projectIdForCwd(settings, state.cwd) : undefined
      }
    }
  })

  registerGitIpc(ipc, { isCwdBusy: (dir: string) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, dir)), worktreeOrigins })

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
  handle('yan:context:current', async () => {
    const id = runners?.activeRunner()?.id
    if (!id) return { ok: false, error: 'no_session' }
    const state = await resolveAgentProfile(id)
    const assembly = await contextAssembler.assemble(await buildContextRequest(id, state))
    return { ok: true, assembly }
  })

  registerArtifactDocIpc(ipc, { artifactDocs, library, sourceStatus: runSourceStatus, window: () => win })

  registerFollowIpc(ipc, { follows })

  registerActivityModelIpc(ipc)


  registerTaskInboxIpc(ipc, { runnerStatuses: () => runners?.statuses() ?? [] })

  registerCapabilitiesIpc(ipc, { currentAgent: () => ac() ?? undefined, registry: () => runners, thinExtensionPaths: yanThinExtensionPaths })


  registerKnowledgeIpc(ipc, { currentCwd: () => ac()?.getState()?.cwd, knowledgeProjectId, window: () => win })

  /* ---- 内置浏览器 ---- */
  registerBrowserIpc(ipc, () => browser)

  /* ---- 砚对砚：这台电脑去连接别的砚 ---- */
  registerPeerIpc(ipc, peerClient, async () => (await getSettings()).projects)

  registerPeerHostIpc(ipc, { grants: peerGrants })

  registerConsentIpc(ipc)

  /* ---- 办公文件：预览与修改对比 ---- */
  registerOfficeIpc(ipc, async () => (await getSettings()).cwd)

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
  registerTerminalIpc(ipc, () => ac()?.getState()?.cwd)
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
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    /* 与深色 --bg-0 / 启动画面底色一致；浅色主题在读到设置后改（见下方 getSettings） */
    backgroundColor: '#151515',
    webPreferences: {
      preload: join(__dirname_, '../preload/index.cjs'),
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
      reportExtensionSources()
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
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染端异常要有记录，否则 React 启动失败时用户只会看到黑屏。
  win.webContents.on('console-message', (...args: unknown[]) => {
    const detail = args.find((x) => x && typeof x === 'object' && 'message' in x) as { level?: string; message?: string; sourceId?: string; lineNumber?: number } | undefined
    if (detail?.level === 'error') console.error('[renderer console]', detail.message, detail.sourceId, detail.lineNumber)
    else if (typeof args[2] === 'string' && Number(args[1]) >= 2) console.error('[renderer console]', args[2], args[4], args[3])
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason)
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
  browser = new BrowserController(() => win, push)
  /* 终端输出转成渲染端可消费的推送（H-11）：只有活动窗口时才有接收方 */
  setTerminalSink((event) => {
    push({
      ch: 'terminal',
      payload:
        event.kind === 'data'
          ? { id: event.id, kind: 'data', data: event.data, seq: event.seq }
          : { id: event.id, kind: 'exit', exitCode: event.exitCode }
    })
  })
  registerIpc()
  await createTray()
  createWindow()

  /*
   * 旧「办事模板」一次性导出成用户技能：放在首个 pi 实例启动之前，
   * 导出的技能在第一次会话就能加载。失败只跳过，不挡启动；原文件保留。
   */
  await migrateLegacyPlaybooks().catch((error) => console.error('[yan] 办事模板导出失败：', error))
  /* 学习记录的可读副本（YAN_DIR/learning-export）：派生文件，每次启动重写，原数据不动 */
  void exportLearningData().catch((error) => console.error('[yan] 学习记录导出失败：', error))

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
