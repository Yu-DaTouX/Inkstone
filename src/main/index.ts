/**
 * 主进程入口：窗口 + IPC + AgentController 的生命周期。
 *
 * 一个窗口可以承载多个按 cwd/session 隔离的 AgentController；
 * 会话切换优先复用已有实例或空闲实例，不停止仍在工作的后台会话。
 */
import { app, shell, BrowserWindow, ipcMain, dialog, screen, Menu, Notification, Tray, nativeImage } from 'electron'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  AgentController,
  type CapabilityAuthorizationChoice,
  type CapabilityAuthorizationPrompt,
  type ExternalApiConfirmationRequest,
  type GoalCommandHost,
  type SubagentCommandHost
} from './agent'
import { applyTurnTimings, readTurnTimings, timingKey } from './turn-timing-store'
import { RunnerRegistry } from './runners'
import { cachedTitles, generateTitle, manualTitles, setManualTitle } from './title'
import { getSettings, patchSettings } from './settings'
import { listSessions, deleteSession, readTitleSamples, restoreSession } from './sessions'
import { moveSessionLayout, rememberSession } from './session-layout'
import { readChainMessages } from './session-history'
import { ArtifactStore } from './artifacts'
import { authFileInfo, clearAuth, completePath, listAuthProviders, setApiKey } from './credentials'
import { cancelCodexLogin, startCodexLogin } from './oauth'
import { listDir, searchFiles } from './files'
import { grantFiles, readGrantedText, readPreview, statPreview } from './file-refs'
import { SubagentController } from './subagents'
import { fileContent, filePatch, reviewSnapshot } from './git-diff'
import { readExpected, readRepoState, listRefs, resolveRepo } from './git-service'
import { configureWriteContext, listRemotes, remoteWeb, runGitAction } from './git-actions'
import { configurePackageContext, installManagedPiPackage, listPackages, runPackageAction } from './packages'
import { AcquisitionService } from './capabilities/acquisition-service'
import { PackageAuthorizationService } from './capabilities/package-authorization-service'
import { createPiPackageActivationHostPorts } from './capabilities/pi-package-activation-host'
import { PiPackageActivationScheduler } from './capabilities/pi-package-scheduler'
import { smokeStagedPiPackage } from './capabilities/pi-package-smoke'
import { createSkillFilesActivationHostPorts } from './capabilities/skill-files-activation-host'
import { SkillFilesActivationScheduler } from './capabilities/skill-files-scheduler'
import { prStatus } from './hosting'
import { linkSources, listImagesForSession, readImage, removeImage, saveImage, verifyFiles } from './sources'
import { createWorktree, listWorktrees, removeWorktree } from './git-worktree'
import { compactionInfo } from './compaction'
import { allowTrust, trustStatus } from './project-trust'
import { forkContext, forkFileRefs } from './fork-rebind-service'
import { activeContextPolicy, contextPolicySettings, setContextPolicySettings, syncEffectivePolicyFile } from './context-policy'
import { contextBudget } from '../shared/context-policy'
import { modelKeyOf } from '../shared/model-capabilities'
import { providerQuota } from './quota'
import { resolvePi, piInfo, resetPiVersionCache } from './protocol'
import { applyZoom, clampScale, peekUiScale, stepScale, zoomState } from './zoom'
import { BrowserController } from './browser'
import {
  attachTerminal,
  disposeTerminals,
  killTerminal,
  listTerminals,
  resizeTerminal,
  setTerminalSink,
  startTerminal,
  terminalAvailable,
  terminalLoadError,
  writeTerminal
} from './terminal'
import { GoalStore, goalResumeContinuationWasConsumed, writeGoalResumeSnapshot, writeGoalResumeSnapshotIfVacant } from './goal-service'
import { HandoffStore, HandoffRequestStore, buildHandoffRequest } from './handoff-service'
import { HandoffDiagnostics } from './handoff-diagnostics'
import { decideSessionWork, ownsHandoffOperation, EligibilityRejectLog } from '../shared/handoff-schedule'
import { eventsForSession } from '../shared/handoff-diagnostics'
import { HandoffTransactionStore } from './handoff-transaction-service'
import { SessionChainStore } from './session-chain-service'
import { WorktreeLinkStore } from './worktree-links'
import { HandoffRunner, type HandoffSessionHandle, type HandoffSessionTarget } from './handoff-runner'
import { normalizeChainKey, isRepresentative, chainForFile, planHistoryRead } from '../shared/session-chain'
import {
  HANDOFF_AUTO_COMPACT_THRESHOLD,
  handoffCommitEnabled,
  handoffEligibility,
  handoffSummary,
  parseHandoffOutput,
  renderHandoffPrompt,
  sanitizeHandoffPackage,
  type HandoffPackage
} from '../shared/handoff'
import { AutoContinueStore, autoContinueOptionsFromEnv } from './auto-continue-service'
import { AUTO_CONTINUE_LIMIT, retryResumeSummary, type AutoContinuePlan } from '../shared/auto-continue'
import { randomUUID } from 'node:crypto'
import {
  AUTONOMOUS_CONTINUE_LIMIT,
  goalSummary,
  isActiveGoalPhase,
  keepsGoalResumeOnModeChange,
  normalizeReadyParams,
  normalizePursuedBrief,
  normalizeReportParams,
  type BudgetUsage
} from '../shared/goal'
import { CapabilityCommandError } from './capability-server'
import { localCommandDescriptors } from './command-registry'
import { writeExitSnapshot } from './exit-snapshot'
import { installStdioGuard } from './stdio-guard'
import { decodeControlCommand, writeControlResponse, type ControlCommand, type ControlResponse } from './control-protocol'
import { RemoteServer, type RemoteCommand, type RemoteOperationResult } from './remote-server'
import { readContextActions } from './context-actions'
import { DOWNLOADS_DIR, ELECTRON_CRASH_DUMPS_DIR, ELECTRON_USER_DATA_DIR, PI_AGENT_DIR, YAN_DIR } from './paths'
import { builtinCapabilities, extensionDiagnostics } from './extensions-inventory'
import { projectIdForCwd as deriveProjectId } from './project-id'
import {
  WorkModeStore,
  normalizeSessionFileKey,
  pendingWorkModeKey,
  writeWorkModeSnapshot
} from './work-mode-service'
import { DEFAULT_WORK_MODE, normalizeWorkMode, type WorkMode, type WorkModeState } from '../shared/work-mode'
import { commitKnowledge, deleteKnowledge, listKnowledge, readKnowledge } from './project-memory-store'
import { isSafeRelativeRef, type KnowledgeCommitRequest } from '../shared/project-memory'
import {
  countKnowledge,
  knowledgeMarkdown,
  toKnowledgeView,
  toKnowledgeViews,
  type KnowledgeViewContext
} from '../shared/project-knowledge-view'
import type {
  Attachment,
  AttentionNotify,
  CompactionRun,
  FileRequestContext,
  FileSearchRequest,
  GitScopeRequest,
  MainPush,
  RunnerStatus,
  SessionState,
  SessionSummary,
  TerminalStartRequest,
  UIMessage
} from '../shared/ipc'

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
let tray: Tray | null = null
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
let subagents: SubagentController | null = null
/**
 * `yan subagent …` 的能力服务回调。
 *
 * 它必须是动态引用：RunnerRegistry 会在切会话 / 重启 pi 时重建
 * AgentController，但子代理控制器是主进程级的生命周期服务。
 */
let subagentCapabilityHost: SubagentCommandHost | null = null
/** 当前主窗口的全项目文件名搜索；新请求可取消旧请求，退出时自然随进程释放。 */
const activeFileSearches = new Map<string, AbortController>()
/** 安卓远程管理服务；默认关闭，避免升级后意外监听网络端口。 */
let remoteServer: RemoteServer | null = null

type CapabilityVerification = {
  operationId: string
  runnerId: string
  generation: number
  agent: AgentController
  serverId: string
  state: 'connecting' | 'ready' | 'error' | 'cancelled' | 'stale'
  toolCount?: number
  updatedAt: number
}
/** UI 只持有不可预测的 operationId；runner 身份 / generation 始终由主进程绑定。 */
const capabilityVerifications = new Map<string, CapabilityVerification>()

function pruneCapabilityVerifications(): void {
  const cutoff = Date.now() - 5 * 60_000
  for (const [id, operation] of capabilityVerifications) {
    if (operation.updatedAt < cutoff && operation.state !== 'connecting') capabilityVerifications.delete(id)
  }
}

/**
 * 当前**正在查看**的会话实例。
 * 绝大多数据 IPC 命令作用在它身上（发送 / 停止 / 模型切换 …）。
 */
function ac(): AgentController | null {
  return runners?.active() ?? null
}

/**
 * 子代理的系统提示（方案 8.3）。
 * 子代理不该反过来问用户问题 —— 它拿不到桌面端的提问通道，
 * 而且它的职责就是把一件事做完并汇报。
 */
const SUBAGENT_SYSTEM_PROMPT = [
  'You are a subagent working on one focused task inside a larger project.',
  '- Work autonomously: do not ask the user questions; make reasonable assumptions and state them.',
  '- Keep the scope to the task you were given.',
  '- Finish with a concise report: what you changed or found, and how you verified it.'
].join('\n')

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
function repeatGuardExtensionPath(): string | undefined {
  return yanThinResourcePath('repeat-guard.js')
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
    goalResumeExtensionPath(),
    handoffsExtensionPath(),
    responseDetailExtensionPath(),
    languageExtensionPath(),
    capabilityGuideExtensionPath(),
    contextExtensionPath(),
    projectKnowledgeExtensionPath(),
    repeatGuardExtensionPath()
  ].filter((p): p is string => !!p)
}

function push(msg: MainPush): void {
  remoteServer?.publish(msg)
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
 * 自动交接的开关（**默认开**，用户 2026-09-19 拍板）。
 *
 * 解析在 [shared/handoff.ts] 的 `handoffCommitEnabled`（可单测）：
 * 默认开，`YAN_HANDOFF_COMMIT=0`（`false` / `off` / `no` 同样）显式关闭。
 *
 * §7 原先的「先完成真实长任务验证再开默认值」前置已满足：`handoffcommit`（cost 1）
 * 真的跑通了建目的会话 / 写链 / 发 resume / 消费证据，崩溃恢复有单测全矩阵与磁盘核对。
 *
 * 「打开」只是**允许**交接：实际发生仍要过四条资格（够数 + 目标在推进 + 自主档 + 不忙），
 * 标准档会话不会被它带走。
 */
const HANDOFF_COMMIT_ENABLED = handoffCommitEnabled(process.env)

/** 交接相关的用户可见提示（推给当前视图；没有活动实例就全局推）。 */
function handoffAlert(message: string, notifyType: 'info' | 'warning' | 'error'): void {
  const msg: MainPush = {
    ch: 'notify',
    payload: { id: `handoff-${Date.now()}`, method: 'notify', notifyType, message }
  }
  const active = runners?.activeRunnerId
  if (active) pushFrom(active, msg)
  else push(msg)
}

/**
 * 交接的执行器（§8 第 4–6 步）。
 *
 * 不直接 import runner / agent：全部经依赖注入，单测用假依赖就能覆盖
 * 「先停源再建目的」「链只在会话建好后写」「resumed 只认磁盘证据」三条顺序。
 */
const handoffRunner = new HandoffRunner({
  transactions: handoffTransactions,
  chains: sessionChains,
  stopRunner: async (runId) => (await runners?.stopOne(runId, handoffPending.has(runId))) ?? false,
  openSession: (target) => openHandoffSession(target),
  /*
   * 交接 resume 走薄层的 `custom` 通道（实施-14 F4）：与目标续行共用同一个槽位
   * （`goal-resume/<runnerId>.json`）与同一套防护（消费幂等、先写证据再发、
   * 发送方优先 ctx 后 pi）。宿主只写快照，**不再**用 `agent.send` ——
   * 那是真用户消息，会把交接包冒充成用户说的话，也会多出一个伪逻辑回合。
   */
  send: async (runId, text, resumeId) => {
    await goals.load()
    if (goals.isPaused(workModeKeyFor(runId))) return { ok: false, error: '目标已暂停' }
    const written = await writeGoalResumeSnapshotIfVacant(runId, {
      operationId: resumeId,
      at: Date.now(),
      kind: 'handoff',
      summary: text
    }).catch(() => false)
    if (!written) return { ok: false, error: '续行槽位正被另一个操作占用（等它被消费后重试）' }
    return { ok: true }
  },
  readSessionText: (sessionFile) => readFile(sessionFile, 'utf8'),
  notify: handoffAlert,
  /* 后台交接不抢用户当前视图（实施-14 F3） */
  shouldActivate: (sourceRunId) => runners?.activeRunnerId === sourceRunId,
  /* 目的片段建好、resume 之前：继承模式与用户级目标事实（实施-14 F3） */
  onDestinationReady: async (info) => {
    for (const pending of handoffPending.values()) {
      if (pending.request.sessionKey === normalizeChainKey(info.sourceSession)) pending.destinationRunId = info.runId
    }
    await inheritForHandoff(info)
  },
  onLinked: publishHandoffReplacement
})

async function publishHandoffReplacement(sourceId: string, destId: string): Promise<void> {
  const pending = handoffPending.get(sourceId)
  const source = pending?.sourceState
  const state = runners?.agentOf(destId)?.getState()
  const runtime = runners?.runtimeOf(destId)
  if (!source || !state || !runtime) return
  const identity = {
    sessionId: state.sessionId,
    conversationId: source.conversationId ?? source.sessionId,
    conversationFile: source.conversationFile ?? source.sessionFile
  }
  handoffIdentities.set(destId, identity)
  const active = runners?.publishReplacement(sourceId, destId) ?? false
  push({ ch: 'handoff-rebind', payload: {
    sourceRunId: sourceId, sourceSessionId: source.sessionId, runtime,
    state: { ...state, ...identity }, active
  } })
  pushRunners()
  await rememberRunnerSession({ ok: true, id: destId, sessionId: state.sessionId }, {
    cwd: state.cwd ?? '', projectId: runtime.projectId ?? undefined,
    scope: runtime.projectId ? 'project' : 'global'
  })
  await pushRunnerSnapshot(destId, { chainHistory: true })
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
 * 待发的自动继续（每个 runner 至多一个）。
 *
 * 用 `token` 而不是只存 timer：延时期间用户可能發话 / 按停止，
 * 那会把 map 里的条目换掉或删掉 —— 回调醒来时先验明正身，避免「取消之后还是发了」。
 */
const autoContinueTimers = new Map<string, { timer: NodeJS.Timeout; token: string }>()

function cancelAutoContinue(id: string): void {
  const entry = autoContinueTimers.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  autoContinueTimers.delete(id)
}

/** 用户發言 / 用户停止 / 一轮真的成功 → 计数归零（下一轮错误从第 1 次算）。 */
async function resetAutoContinue(id: string): Promise<void> {
  cancelAutoContinue(id)
  const key = workModeKeyFor(id)
  if (!key) return
  try {
    await autoContinues.load()
    await autoContinues.reset(key)
  } catch {
    /* 归零失败不影响会话：下一次错误会再试 */
  }
}

/**
 * 延时到点后写「待发续行」快照，薄层会在回合空闲时发一条 `custom` 消息（不是用户消息）。
 *
 * 为什么退避在**宿主**而在薄层：薄层的 1.8s 只是「确认回合真的空闲」，
 * 与「上游刚挂了、给它几秒再试」是两件事，混在一起就调不动了。
 */
function scheduleAutoContinue(id: string, plan: Extract<AutoContinuePlan, { action: 'retry' }>): void {
  cancelAutoContinue(id)
  const token = randomUUID()
  const timer = setTimeout(() => {
    const current = autoContinueTimers.get(id)
    if (!current || current.token !== token) return
    autoContinueTimers.delete(id)
    void writeGoalResumeSnapshot(id, {
      operationId: randomUUID(),
      at: Date.now(),
      kind: 'retry',
      summary: retryResumeSummary({
        error: plan.error,
        attempt: plan.attempt,
        limit: AUTO_CONTINUE_LIMIT_EFFECTIVE
      })
    }).catch(() => {
      /* 快照写不进去 → 这一次不继续；下一次错误还会再来（不会静默丢掉整条链） */
    })
  }, plan.delayMs)
  /* 不阻止应用退出：用户关窗口时不该等这个定时器 */
  timer.unref?.()
  autoContinueTimers.set(id, { timer, token })
}

/**
 * 模型报错之后的处置（实施-05 S5c）。
 *
 * 幂等与去重都在 store 里：`auto_retry_end` 与 `stopReason === 'error'` 会同时报同一件事，
 * 第二次到达会拿到 `duplicate: true`（不计数、不通知、不安排）。
 */
async function handleModelError(id: string, payload: { text: string; source: string }): Promise<void> {
  const key = workModeKeyFor(id)
  if (!key) return
  let result: { plan: AutoContinuePlan | null; duplicate: boolean }
  try {
    await autoContinues.load()
    result = await autoContinues.noteFailure(key, payload.text)
  } catch {
    return
  }
  const { plan, duplicate } = result
  if (!plan || duplicate) return

  const notify = (message: string, notifyType: 'info' | 'warning' | 'error'): void => {
    pushFrom(id, {
      ch: 'notify',
      payload: { id: `auto-continue-${Date.now()}`, method: 'notify', notifyType, message }
    })
  }

  if (plan.action === 'stop') {
    notify(plan.note, plan.reason === 'limit' ? 'error' : 'info')
    return
  }
  notify(plan.note, 'warning')
  scheduleAutoContinue(id, plan)
}

/* ────────────────────────────────────────────── 交接包生成（实施-05 S5b-2） */

/*
 * §8 的交接包由**模型写**（用户 2026-09-19 拍板），宿主只给提示与校验。分工：
 *   · 宿主：判资格 → 渲染提示词 → 写请求文件 → 轮询结果 → 解析 / 校验 / 落盘；
 *   · 薄层 `handoffs.js`：在 `agent_settled` 时读请求 → 调一次 completion → 写结果文件。
 *
 * 为什么提示词在**宿主**渲染：`renderHandoffPrompt` 是 TS，扩展用不了它；
 * 让扩展自己拼一份，等于把「交接包该有哪些字段」变成两处真源。
 */
const handoffRequests = new HandoffRequestStore()

/**
 * 阈值覆盖（测试通道）。
 *
 * 真实链路要攒够两次**真实自动压缩**才会触发交接，而那是最贵的场景之一。
 * 把阈值压到 0 就能在不改任何生产逻辑的前提下把「判资格 → 写请求 → 薄层生成 →
 * 校验落盘」整条链跑一遍（`YAN_HANDOFF_THRESHOLD=0` 只在测试里设）。
 */
const HANDOFF_THRESHOLD_EFFECTIVE = (() => {
  const raw = Number(process.env.YAN_HANDOFF_THRESHOLD)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : HANDOFF_AUTO_COMPACT_THRESHOLD
})()

/** 等薄层写包的会话（防重复 arm，也用来停轮询）。`request` 整份留着，校验时要用它的来源字段。 */
/**
 * 等薄层写包的会话（防重复 arm，也用来停轮询）。
 *
 * ⚠️ 每一项都是**一次具体操作**的所有权（实施-14 F2 / H2）：
 * `request.operationId` 是它的身份，`interval` / `timeout` 是它的两条定时器。
 * 回调醒来时必须先核对 `operationId` 仍是当前值 —— 否则一次旧操作
 * （提前完成、被替换、被停止）留下的超时会把**新**操作清掉。
 */
interface HandoffPendingEntry {
  request: ReturnType<typeof buildHandoffRequest>
  interval: NodeJS.Timeout
  timeout: NodeJS.Timeout
  /** 写请求那一刻的目标身份（提交前复核：用户可能已经换了目标） */
  goalId: string
  /**
   * 「结果文件里的 id 与本次生成对不上」只记一条事件（实施-14 F0）。
   * 不设这个闸的话，一份遗留结果文件会让 1 秒一次轮询刷出 90 条同样的诊断。
   */
  mismatchNoted?: boolean
  collecting?: boolean
  settled?: Promise<void>
  settle?: () => void
  cancelled?: boolean
  destinationRunId?: string
  sourceState?: SessionState
}

const handoffPending = new Map<string, HandoffPendingEntry>()
const handoffIdentities = new Map<string, { sessionId: string; conversationId: string; conversationFile?: string }>()

function hasHandoffOperation(id: string): boolean {
  return handoffPending.has(id) || [...handoffPending.values()].some((op) => op.destinationRunId === id)
}


/**
 * 资格评估的节流。
 *
 * `state` 推送很勤（流起停 / 用量刷新都推），而评估要 load 三份 store + 解析模式 ——
 * 每次推送都做一遍不值得。流式期间本来就在“忙”那一步早退了（不碰 IO），
 * 真正会走到这里的只有「回合刚结束」那一两次，1 秒窗口足够。
 */
const handoffLastCheck = new Map<string, number>()
const HANDOFF_CHECK_INTERVAL_MS = 1_000

/**
 * 常态资格拒绝的记账去重（实施-14 F8）—— 逻辑在 `shared/handoff-schedule.ts`，
 * 这里只持有实例。没有它，每次回合收尾都会记一条「还没压够次数」，
 * 很快就把 400 条的诊断环占满。
 */
const handoffEligibilityLog = new EligibilityRejectLog()

/** 写包是一次额外模型调用：给 90 秒，之后放弃（会话该干什么干什么，不卡用户）。 */
const HANDOFF_WAIT_MS = 90_000
const HANDOFF_POLL_MS = 1_000

function handoffNotify(id: string, message: string, notifyType: 'info' | 'warning' | 'error'): void {
  pushFrom(id, {
    ch: 'notify',
    payload: { id: `handoff-${Date.now()}`, method: 'notify', notifyType, message }
  })
}

/**
 * 判一次资格；够格就 arm 一次生成。返回「这次真的启动了生成」。
 *
 * `reason` 只进提示词与排障（哪条路径想起交接的）—— 资格本身按 §7 的四条走，
 * 与触发路径无关（压缩后 / 目标报告后都只是「再看一眼」）。
 *
 * ⚠️ 启动成功就**冻结源续跑**（§5.2「先登记操作所有权并冻结源续跑」）：
 * 既然要换片段，源片段就不该再 arm 一条新的「接着干」——
 * 否则交接与续跑同时在跑，谁先落地都不对。冻结只针对*未发出*的那一条；
 * 交接失败 / 放弃时会用 `maybeArmGoalContinue` 把续跑放回来。
 */
async function tryArmHandoff(id: string, reason: string): Promise<boolean> {
  if (hasHandoffOperation(id)) return false
  const key = workModeKeyFor(id)
  const agent = runners?.agentOf(id)
  if (!key || !agent) return false
  const state = agent.getState()
  if (!state) return false
  /* 忙：§7 的「有未完成子代理 / 长命令先等待，不遗弃后台工作」
   * 这里是**流式期间每份 state 推送都会走到**的热路径，所以不记事件（那是正常等待，不是异常）。
   * 真的等不来安全边界由 `safety-boundary` 事件反映（在提交入口的复核里）。 */
  if (state.isAgentRunning || state.isStreaming) return false
  const now = Date.now()
  if (now - (handoffLastCheck.get(id) ?? 0) < HANDOFF_CHECK_INTERVAL_MS) return false
  handoffLastCheck.set(id, now)
  try {
    await handoffs.load()
    await goals.load()
    if (goals.isPaused(key)) return false
    const tally = handoffs.state(key).tally
    const goal = goals.state(key)
    const mode = await resolveWorkMode(id)
    const verdict = handoffEligibility({
      tally,
      goal,
      mode: mode.mode,
      busy: false,
      threshold: HANDOFF_THRESHOLD_EFFECTIVE
    })
    /*
     * 资格没过曾经是**静默 return** —— 用户看到的就是「压了两次但什么都没发生」。
     * 四种原因的修法完全不同（等够数 / 建目标 / 换自主档 / 等后台工作），
     * 所以每一种都留一条事件 —— 但**同一结论不重复记**（见 `shouldRecordEligibilityReject`）。
     */
    if (!verdict.eligible) {
      if (!handoffEligibilityLog.shouldRecord(id, verdict.reason, verdict.count)) return false
      handoffDiag.record({
        stage: 'eligibility',
        outcome: 'rejected',
        reason: verdict.reason,
        runnerId: id,
        sessionKey: key,
        detail: { count: verdict.count, threshold: verdict.threshold, trigger: reason, mode: mode.mode }
      })
      return false
    }

    let messages: UIMessage[] = []
    try {
      messages = await agent.getMessages()
    } catch {
      /* 拿不到界面历史也照样能写包：提示词里少一段「最近用户消息」，模型会在 notes 里说 */
    }
    const recentUser = messages
      .filter((message) => message.role === 'user' && String(message.text ?? '').trim())
      .slice(-8)
      .map((message) => String(message.text).trim().slice(0, 600))
    const sourceHead = messages.at(-1)?.id ?? null
    const request = buildHandoffRequest({
      handoffId: randomUUID(),
      operationId: randomUUID(),
      sessionKey: key,
      prompt: renderHandoffPrompt({
        goal,
        cwd: state.cwd ?? '',
        recentUser,
        extra: `本次交接由「${reason}」触发；本片段已完成 ${tally.count} 次自动压缩。`
      }),
      sourceHead,
      mode: mode.mode,
      model: state.model?.id ?? null
    })
    const written = await handoffRequests.writeRequest(id, request).catch(() => false)
    if (!written) {
      handoffDiag.record({
        stage: 'generate',
        outcome: 'request-write-failed',
        reason: 'request-file-not-written',
        op: request.operationId,
        handoffId: request.handoffId,
        runnerId: id,
        sessionKey: key
      })
      return false
    }
    if (goals.isPaused(key) || goals.state(key).goalId !== goal.goalId) {
      await handoffRequests.clearRequest(id).catch(() => {})
      return false
    }
    /* 冻结源续跑：换片段之前不许再 arm 新的「接着干」（§5.2） */
    await cancelGoalResume(id).catch(() => {})
    if (goals.isPaused(key) || goals.state(key).goalId !== goal.goalId) {
      await handoffRequests.clearRequest(id).catch(() => {})
      return false
    }
    /* 时间线锚点：排障时用它对比扩展日志里 `check` 行的 `ageMs`（谁晚、晚了多久） */
    console.log(`[handoff] 已写生成请求（${reason}）：${request.operationId}`)
    handoffNotify(id, '正在整理上下文，当前任务将在此继续…', 'info')
    const interval = setInterval(() => void collectHandoffResult(id, request.operationId), HANDOFF_POLL_MS)
    interval.unref?.()
    /* 超时也走同一条出口，但**带着这次操作的 id** —— 它不能清掉后来的操作（H2） */
    const timeout = setTimeout(() => void abandonHandoff(id, 'timeout', request.operationId), HANDOFF_WAIT_MS)
    timeout.unref?.()
    handoffPending.set(id, {
      request,
      interval,
      timeout,
      goalId: goal.goalId ?? ''
    })
    handoffDiag.record({
      stage: 'generate',
      outcome: 'request-written',
      op: request.operationId,
      handoffId: request.handoffId,
      runnerId: id,
      sessionKey: key,
      reason,
      detail: { count: tally.count, threshold: HANDOFF_THRESHOLD_EFFECTIVE, mode: mode.mode }
    })
    return true
  } catch (error) {
    /* 交接是「有更好、没有也能活」的优化：失败不该影响会话本身 —— 但要留得下痕迹 */
    handoffDiag.record({
      stage: 'generate',
      outcome: 'arm-threw',
      reason: error instanceof Error ? error.message : String(error),
      runnerId: id,
      sessionKey: key,
      detail: { trigger: reason }
    })
    return false
  }
}

/**
 * 放弃一次生成（超时 / 用户插话 / 水位过期 / 会话结束）：清请求与结果，别让下一次交接拿到上一份遗物。
 *
 * `operationId` 是所有权校验（H2）：**旧操作的回调不许清理新操作**。
 * 不带它时按当前操作处理（内部调用点都带）。
 */
async function abandonHandoff(id: string, why: string, operationId?: string): Promise<void> {
  const pending = handoffPending.get(id)
  if (!pending) return
  /* 旧操作的回调不许清理新操作（实施-14 H2） */
  if (!ownsHandoffOperation(pending.request.operationId, operationId)) return
  /*
   * 超时前的最后一次收集：薄层的模型调用上限是 60 秒，碰到长输出时
   * 结果可能刚好压线写盘 —— 这一读把「只差几十毫秒」的假超时挡掉
   * （否则用户看到失败提示，而包其实已经落盘了）。
   */
  if (why === 'timeout' && pending.collecting) {
    pending.timeout = setTimeout(() => void abandonHandoff(id, why, operationId), HANDOFF_POLL_MS)
    pending.timeout.unref?.()
    return
  }
  if (why === 'timeout' && (await collectHandoffResult(id, operationId))) return
  if (handoffPending.get(id) !== pending) return
  pending.cancelled = true
  clearInterval(pending.interval)
  clearTimeout(pending.timeout)
  if (!pending.collecting) handoffPending.delete(id)
  await handoffRequests.clearResult(id).catch(() => {})
  await handoffRequests.clearRequest(id).catch(() => {})
  if (why === 'timeout') {
    console.warn(
      `[handoff] 交接包生成超时：宿主等了 ${Math.round(HANDOFF_WAIT_MS / 1000)}s 也没等到结果（请求已清）`
    )
    handoffNotify(id, '交接包生成超时，已放弃（会话不受影响）', 'warning')
  }
  handoffDiag.record({
    stage: 'generate',
    outcome: 'abandoned',
    reason: why,
    op: pending.request.operationId,
    handoffId: pending.request.handoffId,
    runnerId: id,
    sessionKey: pending.request.sessionKey,
    detail: { waitedMs: HANDOFF_WAIT_MS }
  })
  /*
   * 冻结过的源续跑要放回来：交接没成，这一轮还得自己往下走。
   * 只调续跑入口（不再走完整调度）—— 否则会立刻重新判资格、再 arm 一次交接，
   * 形成「失败 → 重试 → 失败」的 90 秒循环。
   */
  void maybeArmGoalContinue(id).catch(() => undefined)
}

/**
 * 取结果：薄层写完结果文件后，这里校验并落盘。
 *
 * 三道闸门（与 §8 的「模型写、宿主校验」一致）：
 *   ① 结果必须是**这次**生成写的（`handoffId` + `operationId` 都对）；
 *   ② 原文要能解析出 JSON 对象；
 *   ③ 清洗必须过（两栏必填、列表形状合法、**来源字段由宿主覆盖**）。
 * 任何一道不过 → 丢掉这份包并告知用户，**不把半份包写进事务**。
 *
 * 返回值：是否「收到并处理了」这次生成的结果。`abandonHandoff` 超时前会再调一次 ——
 * 薄层可能刚好在边界写完（它自己也有 60 秒的模型时限），这一读能把
 * 「只差几十毫秒」的假超时挡掉。
 */
async function collectHandoffResult(id: string, operationId?: string): Promise<boolean> {
  const pending = handoffPending.get(id)
  if (!pending) return false
  /*
   * 所有权校验（H2）：轮询与超时两条定时器都带自己的 `operationId`。
   * 旧操作的回调（比如上一次生成遗留的 interval）不能碰这一次的现场。
   */
  if (!ownsHandoffOperation(pending.request.operationId, operationId)) return false
  if (pending.collecting || pending.cancelled) return false
  pending.collecting = true
  pending.settled = new Promise<void>((resolve) => { pending.settle = resolve })
  let handled = false
  try {
    let result
    try {
      result = await handoffRequests.readResult(id)
    } catch {
      return false
    }
    if (handoffPending.get(id) !== pending || pending.cancelled) return false
    if (!result) return false
    if (result.handoffId !== pending.request.handoffId || result.operationId !== pending.request.operationId) {
      /*
       * 对不上就是「这份结果不是这次生成写的」：留在磁盘上等下次覆盖（不删别人的文件）。
       * 只在第一次记事件 —— 轮询每秒一次，不设闸会把一份遗留结果刷成几十条。
       */
      if (!pending.mismatchNoted) {
        pending.mismatchNoted = true
        handoffDiag.record({
          stage: 'generate',
          outcome: 'result-mismatch',
          reason: 'result-not-for-this-operation',
          op: pending.request.operationId,
          handoffId: pending.request.handoffId,
          runnerId: id,
          sessionKey: pending.request.sessionKey,
          detail: {
            gotHandoffId: result.handoffId,
            gotOperationId: result.operationId,
            ms: result.ms
          }
        })
      }
      return false
    }

    clearInterval(pending.interval)
    clearTimeout(pending.timeout)
    handled = true
    await handoffRequests.clearResult(id).catch(() => {})
    await handoffRequests.clearRequest(id).catch(() => {})

    const base = {
      op: pending.request.operationId,
      handoffId: pending.request.handoffId,
      runnerId: id,
      sessionKey: pending.request.sessionKey
    }

    if (result.error) {
      handoffDiag.record({ stage: 'generate', outcome: 'failed', reason: result.error, ...base, detail: { ms: result.ms } })
      handoffNotify(id, `交接包生成失败：${result.error.slice(0, 120)}`, 'error')
      return true
    }
    const parsed = parseHandoffOutput(result.text)
    if (!parsed.ok) {
      handoffDiag.record({
        stage: 'generate',
        outcome: 'unparsable',
        reason: parsed.reason,
        ...base,
        /* 只留长度，不留原文 —— 模型输出可能含用户内容 */
        detail: { chars: result.text.length, ms: result.ms }
      })
      handoffNotify(id, `交接包不能用（${parsed.reason}），已丢弃这份`, 'error')
      return true
    }
    const pkg = sanitizeHandoffPackage(parsed.value, {
      sourceSession: pending.request.sessionKey,
      sourceHead: pending.request.sourceHead,
      mode: pending.request.mode,
      model: pending.request.model
    })
    if (!pkg) {
      handoffDiag.record({ stage: 'generate', outcome: 'incomplete', reason: 'missing-required-fields', ...base })
      handoffNotify(id, '交接包缺必填栏（目标 / 交付物），已丢弃这份', 'error')
      return true
    }
    try {
      await handoffs.setPackage(pending.request.sessionKey, pkg)
    } catch (error) {
      handoffDiag.record({
        stage: 'generate',
        outcome: 'persist-failed',
        reason: error instanceof Error ? error.message : String(error),
        ...base
      })
      handoffNotify(id, '交接包落盘失败，已放弃（下一次压缩后再试）', 'error')
      return true
    }
    handoffDiag.record({ stage: 'generate', outcome: 'package-ready', ...base })
    handoffNotify(id, `交接包已生成：${handoffSummary(pkg)}`, 'info')
    /* 开关打开时才真的往下走（§7：默认不自动交接，需用户拍板） */
    if (HANDOFF_COMMIT_ENABLED) {
      /*
       * `await`（不是 `void`）：提交完成前保留 pending，调度器据此冻结续行——
       * 提交的同时再跑一次调度决策，就会出现「一边停源建目的、一边 arm 续跑」。
       */
      await commitHandoff({
        runnerId: id,
        handoffId: pending.request.handoffId,
        operationId: pending.request.operationId,
        sessionKey: pending.request.sessionKey,
        goalId: pending.goalId,
        sourceHead: pending.request.sourceHead,
        pkg
      })
    }
    return true
  } finally {
    pending.collecting = false
    if ((handled || pending.cancelled) && handoffPending.get(id) === pending) {
      handoffPending.delete(id)
      if (!pending.cancelled) await maybeArmGoalContinue(pending.destinationRunId ?? id).catch(() => undefined)
    }
    pending.settle?.()
  }
}

/**
 * 提交前的复核（实施-14 F2 / §5.2）。
 *
 * 为什么不能把「写包那一刻的结论」当成立：写包是一次额外模型调用（最长 90 秒），
 * 这期间用户完全可能插话、按停止、改档、换目标，或切到别的会话。
 * 拿一个过期的包去停源换段，轻则把用户新输入留在旧片段，
 * 重则停掉刚被用户接管的实例。
 *
 * 五个条件（任一不成立就放弃这一次交接，保留包与源会话）：
 *   ① 操作身份没被替换（新的生成没有顶替它）；
 *   ② 实例存在且真的空闲（安全边界）；
 *   ③ 实例仍指向源会话（没被切走）；
 *   ④ 目标仍是在推进的那一个，且档位仍允许自己跑（自主档或 pursue）——用户意图未变；
 *   ⑤ 源会话水位未前进（用户没插话）。
 */
async function revalidateHandoff(input: {
  runnerId: string
  operationId: string
  sessionKey: string
  goalId: string
  sourceHead: string | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pending = handoffPending.get(input.runnerId)
  if (!pending || pending.cancelled) return { ok: false, reason: 'operation-cancelled' }
  if (pending.request.operationId !== input.operationId) return { ok: false, reason: 'operation-replaced' }
  const agent = runners?.agentOf(input.runnerId)
  const state = agent?.getState()
  if (!agent || !state) return { ok: false, reason: 'runner-gone' }
  if (state.isAgentRunning || state.isStreaming) return { ok: false, reason: 'not-idle' }
  /* 源会话键：`workModeKeyFor` 读的就是实例当前段落，比对即可看出“用户切走了” */
  if (workModeKeyFor(input.runnerId) !== input.sessionKey) return { ok: false, reason: 'source-session-changed' }
  await goals.load()
  if (goals.isPaused(input.sessionKey)) return { ok: false, reason: 'user-paused' }
  const goal = goals.state(input.sessionKey)
  if (!isActiveGoalPhase(goal.phase) || (goal.goalId ?? '') !== input.goalId) {
    return { ok: false, reason: 'goal-changed' }
  }
  const mode = await resolveWorkMode(input.runnerId)
  if (!keepsGoalResumeOnModeChange(mode.mode, goal.pursue === true)) return { ok: false, reason: 'mode-changed' }
  let head: string | null
  try {
    head = (await agent.getMessages()).at(-1)?.id ?? null
  } catch {
    /* 拿不到历史就不断水位判（宁可放过，不因为读失败而卡住交接） */
    return { ok: true }
  }
  if ((input.sourceHead ?? null) !== head) return { ok: false, reason: 'source-watermark-moved' }
  return { ok: true }
}

/**
 * 把一份刚生成的交接包推入事务（§8 第 3–6 步）。
 *
 * 触发点与「生成」同一处（包落盘之后）：生成是资格判定的结果，而
 * 「够格」与「愿意真的换会话」是两件事 —— 后者由开关控制。
 *
 * cwd / projectId 从**源实例当时的状态**取：交接的意思是「同一个项目继续」，
 * 不是「在当前设置的项目里继续」。
 */
async function commitHandoff(input: {
  runnerId: string
  handoffId: string
  operationId: string
  sessionKey: string
  goalId: string
  sourceHead: string | null
  pkg: HandoffPackage
}): Promise<void> {
  const agent = runners?.agentOf(input.runnerId)
  const state = agent?.getState()
  if (!agent || !state) return
  const operation = handoffPending.get(input.runnerId)
  if (operation) operation.sourceState = { ...state, ...handoffIdentities.get(input.runnerId) }
  const verdict = await revalidateHandoff(input)
  if (!verdict.ok) {
    handoffDiag.record({
      stage: 'safety-boundary',
      outcome: 'rejected',
      reason: verdict.reason,
      op: input.operationId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey
    })
    /* 过期的包不提交：放弃这次操作（保留包，下次判定再看）并把续跑放回来 */
    await abandonHandoff(input.runnerId, verdict.reason, input.operationId)
    return
  }
  const cwd = state.cwd ?? ''
  const settings = await getSettings()
  const projectId = projectIdForCwd(settings, cwd)
  handoffDiag.record({
    stage: 'commit',
    outcome: 'started',
    op: input.handoffId,
    handoffId: input.handoffId,
    runnerId: input.runnerId,
    sessionKey: input.sessionKey,
    detail: { cwd, projectId: projectId ?? null }
  })
  try {
    const result = await handoffRunner.commit({
      handoffId: input.handoffId,
      sourceRunId: input.runnerId,
      sourceSession: input.sessionKey,
      cwd,
      ...(projectId ? { projectId } : {}),
      pkg: input.pkg,
      canContinue: () => {
        const op = handoffPending.get(input.runnerId)
        return !!op && op.request.operationId === input.operationId && !op.cancelled && !goals.isPaused(input.sessionKey)
      }
    })
    if (operation?.cancelled && operation.destinationRunId) {
      await goals.setPaused(workModeKeyFor(operation.destinationRunId), true)
      await cancelGoalResume(operation.destinationRunId)
    }
    if (!result.ok) {
      console.log(`[handoff] 交接停在 ${result.stage}：${result.error ?? ''}`)
      /*
       * `committed` 不是失败：resume 已发出但磁盘证据未到（或发送失败），
       * 下次启动恢复会按证据补记 / 重发。这个区别必须在诊断里看得出来。
       */
      handoffDiag.record({
        stage: result.stage === 'committed' ? 'resume' : 'commit',
        outcome: result.stage === 'committed' ? 'unconfirmed' : 'halted',
        reason: result.error ?? result.stage,
        op: input.handoffId,
        handoffId: input.handoffId,
        runnerId: input.runnerId,
        sessionKey: input.sessionKey,
        detail: { stage: result.stage, destination: result.destinationSession ?? null }
      })
      return
    }
    handoffDiag.record({
      stage: 'commit',
      outcome: 'ok',
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey,
      detail: { stage: result.stage, destination: result.destinationSession ?? null }
    })
    /* 用户级状态（模式 / 目标 / 暂停）已在 `onDestinationReady` 继承过 —— 比 resume 早 */
    handoffDiag.record({
      stage: 'resume',
      outcome: 'resume-confirmed',
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey,
      detail: { destination: result.destinationSession ?? null }
    })
  } catch (error) {
    console.error('[handoff] 交接执行失败：', error)
    handoffDiag.record({
      stage: 'commit',
      outcome: 'threw',
      reason: error instanceof Error ? error.message : String(error),
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey
    })
  }
}

/**
 * 交接之后把**工作模式**带到目的会话（实施-05 S6 联调）。
 *
 * 为什么模式继承、而目标状态（goal）不继承：
 *   · 模式是**用户对这条会话的意图**（「这个长任务让它自己往下跑」），
 *     交接的是同一条会话的下一段 —— 掉回默认档会让自主续接（S3c）当场失效；
 *   · goal 是「这一轮做到哪」的**事实**，§8 明写不能把旧总结升级成事实，
 *     所以由模型按交接包重新登记（resume 正文里有明确要求，也有单测钉着）。
 */
/**
 * 交接后把**用户级状态**带到目的片段（实施-14 F3）。
 *
 * 时机是硬要求：由 `HandoffRunner` 在 `destination-created` 之后、**发 resume 之前**调用。
 * 旧实现在 `commit()` 返回之后才做，而且写的是**当前 active runner** 的快照 ——
 * 于是目的片段第一轮按默认档 / 空目标启动，后台交接时还会把模式写到别的实例上。
 *
 * 继承两件事：
 *   · 工作模式（用户对这条会话的意图：自主档不能被交接降级）；
 *   · 宿主级目标事实（目标 / 验收标准 / pursue / 暂停）—— 见 `GoalStore.inheritTo`。
 * 模型写的 done/remaining 不进宿主事实，由交接包按摘要交给下一个片段。
 */
async function inheritForHandoff(info: {
  sessionFile: string
  runId: string
  sourceSession: string
}): Promise<void> {
  const destKey = normalizeChainKey(info.sessionFile)
  const sourceKey = normalizeChainKey(info.sourceSession)
  if (!destKey || !sourceKey || sourceKey === destKey) return
  let modeInherited = false
  try {
    await workModes.load()
    const source = workModes.state(sourceKey, agentDefaultWorkMode)
    /* 源本来就是默认档（无记录）→ 目的不必落键，保持「默认态不写盘」的约定 */
    if (!(source.revision === 0 && source.mode === agentDefaultWorkMode)) {
      modeInherited = (await workModes.set(destKey, source.mode)).ok
    }
  } catch {
    /* 继承失败不阻断交接：下一轮按默认档起步也能继续 */
  }
  let goalInherited = false
  try {
    goalInherited = await goals.inheritTo(sourceKey, destKey)
  } catch {
    /* 同上 */
  }
  /*
   * 快照必须写给**目的 runner**：薄层只认 `work-mode/<runnerId>.json` 与
   * `goal-resume/<runnerId>.json`，写给 active runner 时后台交接会串到别人身上。
   */
  try {
    const state = await resolveWorkMode(info.runId)
    await writeWorkModeSnapshot(info.runId, state)
    /* 目的段的续行由交接那条 resume 驱动，源片段残留的「接着干」不许跟过来 */
    await applyGoalResume(info.runId)
  } catch {
    /* 快照写失败时扩展会回退到默认档；不能让继承失败把交接拖死 */
  }
  handoffDiag.record({
    stage: 'resume',
    outcome: 'state-inherited',
    runnerId: info.runId,
    sessionKey: destKey,
    detail: { modeInherited, goalInherited, source: sourceKey }
  })
}

/* ────────────────────────────── 同一会话的单一调度（实施-14 F2 / H1） */

/**
 * 每个会话的「下一步动作」串行决定。
 *
 * 旧实现是两个 `void` 并发：同一份 `state` 推送里 `maybeArmHandoff` 与
 * `maybeArmGoalContinue` 各自起跑 —— 交接在准备包的同时，续跑也可能被 arm 出去。
 * 现在只有**一个**决定器，按固定优先级挑一件事做：
 *
 *   0. 已安排模型错误重试 → 什么都不做（它有自己的退避与上限）；
 *   1. 交接正在准备包 → 冻结源续跑，等它提交或放弃；
 *   2. 实例不空闲 → 不做决策（安全边界还没到，交给下一次收尾）；
 *   3. 重复拦下先计入（可能把目标打成 blocked，那就不该再 arm）；
 *   4. 交接资格够 → 只做交接；
 *   5. 否则 → 普通续跑。
 *
 * 串行链按 runnerId 分开：不同会话之间没有共享状态，没必要互相阻塞。
 */
const sessionWorkTails = new Map<string, Promise<void>>()

function scheduleSessionWork(id: string, reason: string): Promise<void> {
  const previous = sessionWorkTails.get(id) ?? Promise.resolve()
  const next = previous.then(
    () => runScheduledWork(id, reason),
    () => runScheduledWork(id, reason)
  )
  sessionWorkTails.set(id, next)
  void next.finally(() => {
    if (sessionWorkTails.get(id) === next) sessionWorkTails.delete(id)
  })
  return next.catch(() => undefined)
}

async function runScheduledWork(id: string, reason: string): Promise<void> {
  const agent = runners?.agentOf(id)
  const state = agent?.getState()
  if (!agent || !state) return
  const decision = decideSessionWork({
    busy: state.isAgentRunning === true || state.isStreaming === true,
    handoffPending: hasHandoffOperation(id),
    errorRetryPending: autoContinueTimers.has(id),
    handoffAllowed: true
  })
  /* 三个 `wait-*` 都是「现在不做决定」（安全边界未到 / 已有更高优先级的事） */
  if (decision === 'wait-busy' || decision === 'wait-error-retry' || decision === 'wait-handoff') return
  /* 重复拦下先计入：它可能把目标打成 blocked（终态），那就不能 arm 任何东西 */
  await consumeRepeatBlocks(id).catch(() => undefined)
  /* consumeRepeatBlocks 可能改掉交接现场（目标终态会清续行），再核一次 */
  if (handoffPending.has(id)) return
  if (await tryArmHandoff(id, reason)) return
  await maybeArmGoalContinue(id).catch(() => undefined)
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
  if (msg.ch === 'state' && (msg.payload as SessionState)?.isAgentRunning === false) {
    /*
     * 单一调度（实施-14 F2 / H1）：交接、普通续跑、重复拦下这三件事
     * 都在同一条串行链里决定，不再各自 `void` 起跑。
     * 单轮重复动作兜底也在这里（拦下发生于回合中途，而目标状态的落盘
     * 已由 `report` 串行化了 —— 这里只需在真正空下来时补记一次，幂等）。
     */
    void scheduleSessionWork(runnerId, 'settled')
  }
  /*
   * 模型报错 → 自动继续（实施-05 S5c）。
   * 单开一条通道而不是复用 `notify`：拿提示文案做判据太脆（改一句话就静默失效）。
   */
  if (msg.ch === 'agent-error') void handleModelError(runnerId, msg.payload)
  /*
   * 一轮真的产出了（assistant 有文本或工具调用、且没标错）→ 连续失败计数归零。
   * 流式期间会反复推 `msg-update`，但归零只在真的变过时落盘（store 里判），
   * 所以这里不必自己节流。
   */
  if (
    msg.ch === 'msg-update' &&
    msg.payload?.patch?.role === 'assistant' &&
    !msg.payload.patch.error &&
    (msg.payload.patch.text || msg.payload.patch.toolCalls?.length)
  ) {
    void resetAutoContinue(runnerId)
  }
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
 * 新会话的默认工作模式（`desktop.json.defaultWorkMode`）。
 *
 * 缓存一份的理由与 `agentResponseDetail` 相同：读取路径里不能到处 await
 * `getSettings()`；两个写入点（启动 / 改设置）会同步它。
 */
let agentDefaultWorkMode: WorkMode = DEFAULT_WORK_MODE

/**
 * 运行实例当前该读哪个键。
 *
 * ⚠️ 优先**会话文件路径**，不用 `state.sessionId`：实测切走再切回同一份
 * 会话文件时，pi 报回的 sessionId 会变（文件还是那个文件）—— 用 sessionId 作
 * 键会让用户刚设的模式在切换后当场丢回默认值（真实链路抽到的，见探针第 5 节）。
 * 文件路径在 pi 给出之前用 `pending:<runnerId>` 占位，拿到后再迁移。
 */
/**
 * 目标到目前为止的用量（A-2）。
 *
 * 口径写在这里，免得以后被当成「总共花了多少」：
 *   · 只算**目标开始之后**的回合（`GoalStore.startOf`）——同一个会话可以先后
 *     做多个目标；
 *   · 只累加模型真报出来的 output token（H-6b 的 `usage.output`）；输入侧没有
 *     可靠来源，**不估算、不编数字**；
 *   · 一条 usage 都没有 → `tokens: null`，界面显示“未知”而不是 0。
 *
 * 拿不到会话文件时返回 `undefined` —— 装配方明确说“我无法判定”，
 * 而不是给一个看着像 0 的数字（0 会让预算永不触发）。
 */
async function goalBudgetUsage(id: string, startedAt: number): Promise<BudgetUsage | undefined> {
  const sessionFile = runners?.agentOf(id)?.getState()?.sessionFile
  const bucket = timingKey(sessionFile)
  if (!bucket) return undefined
  const records = await readTurnTimings(YAN_DIR, bucket).catch(() => [])
  if (!records.length) return undefined
  const since = startedAt > 0 ? startedAt : 0
  /*
   * 只算**目标开始之后**的回合，并且只累加 provider 真的报了的 output token（H-6b 已落盘）。
   * 一条都没报 → `tokens: null`（未知），让界面显示未知、判定也不因此停。
   */
  const inGoal = records.filter((r) => (r.startedAt ?? 0) >= since)
  const reported = inGoal.filter((r) => typeof r.outputTokens === 'number')
  return {
    tokens: reported.length ? reported.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0) : null,
    elapsedMs: since > 0 ? Date.now() - since : 0
  }
}

function workModeKeyFor(id: string): string {
  const file = normalizeSessionFileKey(runners?.agentOf(id)?.getState()?.sessionFile)
  return file ?? pendingWorkModeKey(id)
}

/**
 * 解析一个运行实例当前会话的模式，并顺手把 pending 键迁到稳定键。
 *
 * 迁移放在这里而不是「会话建立事件」里：稳定键何时出现由 pi 决定，
 * 而读模式的所有调用点都已经拿到过实例 —— 在这里做能保证「第一次读」
 * 就一定是对的键，不会出现“刚答完的会话又被当成新会话”。
 */
async function resolveWorkMode(id: string): Promise<WorkModeState> {
  await workModes.load()
  const stable = normalizeSessionFileKey(runners?.agentOf(id)?.getState()?.sessionFile)
  const pendingKey = pendingWorkModeKey(id)
  if (!stable) return workModes.state(pendingKey, agentDefaultWorkMode)
  if (workModes.snapshot().entries[pendingKey]) await workModes.adopt(pendingKey, stable)
  return workModes.state(stable, agentDefaultWorkMode)
}

/**
 * 把该实例的当前模式写给模型侧并推给界面。
 *
 * 两个出口一次做完，否则会出现「界面已自主而扩展仍标准」：
 *   · `work-mode/<runnerId>.json` —— 薄层扩展只认 `YAN_SESSION_ID`（= runner id），
 *     文件缺失 / 读不到时它回退到旧 `autonomous` 或标准模式；
 *   · `work-mode` 推送 —— 带 `runtime` 封套，后台会话切模式不会串到当前视图。
 */
async function pushWorkMode(id: string): Promise<WorkModeState> {
  const state = await resolveWorkMode(id)
  await writeWorkModeSnapshot(id, state).catch(() => {})
  pushFrom(id, { ch: 'work-mode', payload: state })
  return state
}

/** 把该实例当前会话的目标 / 计划事实快照推给右栏。 */
async function pushGoal(id: string): Promise<void> {
  await goals.load()
  const state = goals.state(workModeKeyFor(id))
  pushFrom(id, { ch: 'goal', payload: state })
}

/**
 * 把该实例的「待发续行」写给薄层（实施-05 S3b）。
 *
 * 与模式快照同一个理由：`goals.json` 按**会话文件路径**索引，
 * 而扩展只认自己是哪个 runner（`YAN_SESSION_ID`）。
 */
async function applyGoalResume(id: string): Promise<void> {
  await goals.load()
  await writeGoalResumeSnapshot(id, goals.resumeOf(workModeKeyFor(id))).catch(() => {})
}

/**
 * 抦销未发续行（用户停止 / 用户改档）。
 *
 * ⚠️ 必须连**快照**一起清：扩展只读快照，不读 `goals.json` ——
 * 只清后者等于没清，下一轮它照发。
 */
async function cancelGoalResume(id: string): Promise<void> {
  await goals.load()
  await goals.clearResume(workModeKeyFor(id)).catch(() => {})
  await writeGoalResumeSnapshot(id, null).catch(() => {})
}

/**
 * 把薄层「重复动作被拦下」的计数计入目标失败签名（2026-09-22）。
 *
 * 薄层只写得到计数文件（没有 `yan` CLI，也不该知道目标存储），所以这一步在宿主：
 * 读 `<YAN_DATA_DIR>/repeat-guard/<runnerId>.json` → 对差值各记一次固定签名失败。
 * 同一签名连续两次 → `blocked`（与 §5 的失败签名同一套阈值，见 `shared/goal.ts`）。
 *
 * 失败不影响回合收尾（没有计数文件 / 目标不在推进期都是正常的）。
 */
async function consumeRepeatBlocks(id: string): Promise<void> {
  const key = workModeKeyFor(id)
  const changed = await goals.consumeRepeatBlocks(id, key).catch((err: unknown) => {
    console.error('[goal] 重复动作计数计入失败签名失败：', err)
    handoffDiag.record({
      stage: 'goal-continue',
      outcome: 'repeat-guard-failed',
      reason: err instanceof Error ? err.message : String(err),
      runnerId: id,
      sessionKey: key
    })
    return false
  })
  if (!changed) return
  const goal = goals.state(key)
  console.log(
    `[goal] 重复动作被拦下已计入失败签名（会话 ${id}）：phase=${goal.phase} failure=${goal.failure?.count ?? 0}`
  )
  handoffDiag.record({
    stage: 'goal-continue',
    outcome: isActiveGoalPhase(goal.phase) ? 'repeat-counted' : 'blocked-by-repeat',
    runnerId: id,
    sessionKey: key,
    detail: { phase: goal.phase, failures: goal.failure?.count ?? 0 }
  })
  /*
   * 进终态就把薄层可见的续行一并清掉（实施-14 A1）：
   * 只清 `goals.json` 不够 —— 快照里那条「接着干」会照样发出去，
   * 把模型重新叫起来干刚被拦下的那件事。
   */
  if (!isActiveGoalPhase(goal.phase)) await applyGoalResume(id)
  pushFrom(id, { ch: 'goal', payload: goal })
}

/**
 * 目标状态（实施-05 S3）的存储。
 *
 * 为什么与模式分两份文件：模式是「用户选什么」（低频、界面驱动），目标是
 * 「这一轮做到哪」（高频、模型驱动、带幂等记录）—— 混在一份里会让
 * 模式那份承担两个写者的并发语义。
 */
const goals = new GoalStore()

/*
 * 自主档的兜底续接（S3c）。
 *
 * 模型通常会在工具回合里调用 `yan goal report`，但这不是可靠的唯一出口：
 * 它可能只给出一段普通文本，或因同一个 reportId 重试而让旧实现返回
 * `autoContinueArmed: false`。回合真正空闲后，如果目标仍在推进、模式仍是
 * 自主、且上一条续行已经被消费，就再补 arm 一次。串行闸门避免多条 state
 * 推送把同一轮 arm 两次；用户停止 / 改档仍通过上面的取消路径优先生效。
 */
const autonomousArmInFlight = new Set<string>()

async function maybeArmGoalContinue(id: string): Promise<void> {
  if (autonomousArmInFlight.has(id)) return
  /* 交接正在准备包：源续跑已被冻结（H1）——即便有人绕过调度器直接调这里，也不能破 */
  if (hasHandoffOperation(id)) return
  autonomousArmInFlight.add(id)
  try {
    const mode = await resolveWorkMode(id)

    await goals.load()
    const key = workModeKeyFor(id)
    const goal = goals.state(key)
    if (!goal.goalId || !isActiveGoalPhase(goal.phase) || goal.revision <= 0) return
    /*
     * 谁有资格被自动叫醒（2026-09-22）：
     *   · 自主档 —— 档位本身就意味着「接着干」；
     *   · 或者目标带 `pursue`（用户在 `+` 菜单里明确设定的持续目标）——
     *     那是**目标**语义，与档位正交，所以标准 / 计划档下也要继续推进。
     */
    if (mode.mode !== 'autonomous' && !goal.pursue) return

    const resume = goals.resumeOf(key)
    if (resume) {
      /* 还没消费的续行仍交给 goal-resume 扩展，不能覆盖它。 */
      if (resume.kind !== 'continue') return
      if (!(await goalResumeContinuationWasConsumed(id, resume.operationId))) return
      /* 旧的 continue 已消费，当前空闲回合需要一个新的 operationId。 */
    }

    /*
     * `paused`（用户按过停止）与 `pending`（已有未消费的续行）都在这一层取。
     * 两者都是「本次不 arm」的正常状态，不记事件（每次回合收尾都会走到，记了只会刷屏）。
     * 用户停止那一次由 `yan:abort` 的 `goal-continue:cancelled` 负责留痕。
     */
    if (hasHandoffOperation(id)) return
    const armed = await goals.armContinue(key, {
      consumed: (operationId) => goalResumeContinuationWasConsumed(id, operationId),
      usage: await goalBudgetUsage(id, goals.startOf(key))
    })
    if (armed.armed) {
      await applyGoalResume(id)
      await pushGoal(id)
      handoffDiag.record({
        stage: 'goal-continue',
        outcome: 'armed',
        reason: 'settled-fallback',
        runnerId: id,
        sessionKey: key,
        detail: { round: armed.round, mode: mode.mode, pursue: goal.pursue === true }
      })
    } else if (armed.reason === 'limit') {
      /* 到上限是**要让用户看见**的暂停原因（A6）：arm 不会再发生，所以每次收尾都记 */
      handoffDiag.record({
        stage: 'goal-continue',
        outcome: 'limit',
        reason: 'autonomous-continue-limit',
        runnerId: id,
        sessionKey: key,
        detail: { round: armed.round, limit: AUTONOMOUS_CONTINUE_LIMIT }
      })
    }
  } catch (error) {
    /* 自动兜底是增强路径；失败时保留目标状态，不让它影响当前会话 —— 但要留痕 */
    handoffDiag.record({
      stage: 'goal-continue',
      outcome: 'arm-threw',
      reason: error instanceof Error ? error.message : String(error),
      runnerId: id
    })
  } finally {
    autonomousArmInFlight.delete(id)
  }
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
const goalCapabilityHost: GoalCommandHost = {
  async run(command, params, context) {
    await goals.load()
    const key = workModeKeyFor(context.sessionId)
    const modeState = await resolveWorkMode(context.sessionId)
    const goal = goals.state(key)

    if (command === 'goal.ready') {
      const res = await goals.commitReady(
        key,
        normalizeReadyParams(params),
        { modeRevision: modeState.revision, goalRevision: goal.revision },
        goal.goalId || `goal-${context.sessionId}`
      )
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
    await remoteServer?.stop()
  } catch {
    /* 远程客户端已断开；退出流程不能被监听器关闭失败阻塞 */
  }
  remoteServer = null
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
    await subagents?.stopAll()
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

/* -------------------------------------------------------------------------- */
/* Android 远程管理                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 远程 API 不返回会话文件绝对路径：手机只需要稳定 id 和展示信息，
 * 路径解析始终由主进程按 id 查找，避免网络请求变成任意文件读取入口。
 */
function remoteSessionSummary(summary: SessionSummary): Record<string, unknown> {
  return {
    id: summary.id,
    title: summary.title,
    named: summary.named,
    ...(summary.parentSession ? { parentSession: summary.parentSession } : {}),
    ...(summary.branchOrigin ? { branchOrigin: summary.branchOrigin } : {}),
    ...(summary.lastActivityAt !== undefined ? { lastActivityAt: summary.lastActivityAt } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.projectId ? { projectId: summary.projectId } : {}),
    ...(summary.scope ? { scope: summary.scope } : {}),
    ...(summary.lastOpenedAt !== undefined ? { lastOpenedAt: summary.lastOpenedAt } : {}),
    ...(summary.projectCandidates?.length ? { projectCandidates: summary.projectCandidates } : {}),
    cwdName: basename(summary.cwd) || summary.cwd
  }
}

/** SessionState 的远程降敏版本；cwd 只留目录名，sessionFile 不出进程。 */
function remoteSessionState(state: SessionState | null): Record<string, unknown> | null {
  if (!state) return null
  return {
    sessionId: state.sessionId,
    ...(state.sessionName ? { sessionName: state.sessionName } : {}),
    ...(state.model ? { model: state.model } : {}),
    thinkingLevel: state.thinkingLevel,
    availableThinkingLevels: state.availableThinkingLevels,
    ...(state.thinkingLevelsStatus ? { thinkingLevelsStatus: state.thinkingLevelsStatus } : {}),
    ...(state.capabilities ? { capabilities: state.capabilities } : {}),
    isStreaming: state.isStreaming,
    ...(state.isAgentRunning !== undefined ? { isAgentRunning: state.isAgentRunning } : {}),
    isCompacting: state.isCompacting,
    ...(state.compaction ? { compaction: state.compaction } : {}),
    ...(state.lastCompaction ? { lastCompaction: state.lastCompaction } : {}),
    messageCount: state.messageCount,
    pendingMessageCount: state.pendingMessageCount,
    cwdName: basename(state.cwd) || state.cwd,
    ...(state.autoCompactionEnabled !== undefined ? { autoCompactionEnabled: state.autoCompactionEnabled } : {}),
    ...(state.contextPolicy ? { contextPolicy: state.contextPolicy } : {}),
    ...(state.steeringMode ? { steeringMode: state.steeringMode } : {}),
    ...(state.followUpMode ? { followUpMode: state.followUpMode } : {})
  }
}

function remoteRunnerStatus(status: RunnerStatus): Record<string, unknown> {
  return {
    id: status.id,
    runId: status.runId,
    ...(status.sessionId ? { sessionId: status.sessionId } : {}),
    ...(status.projectId ? { projectId: status.projectId } : {}),
    generation: status.generation,
    cwdName: basename(status.cwd) || status.cwd,
    running: status.running,
    waiting: status.waiting,
    failed: status.failed,
    conn: status.conn,
    createdAt: status.createdAt,
    lastActiveAt: status.lastActiveAt,
    isActive: status.isActive
  }
}

async function remoteSnapshot(): Promise<Record<string, unknown>> {
  const settings = await getSettings()
  const summaries = await listSessions(200, settings.projects)
  const state = ac()?.getState() ?? null
  const connection = ac()?.getConn() ?? { state: 'exited' as const, detail: 'pi 未运行' }
  const windowReady = !!win && !win.isDestroyed()
  return {
    apiVersion: 1,
    generatedAt: Date.now(),
    desktop: {
      ready: windowReady,
      visible: windowReady && win!.isVisible(),
      minimized: windowReady && win!.isMinimized()
    },
    agent: {
      connection,
      activeSessionId: state?.sessionId ?? null,
      state: remoteSessionState(state),
      runners: (runners?.statuses() ?? []).map(remoteRunnerStatus)
    },
    sessions: summaries.map(remoteSessionSummary)
  }
}

/**
 * 侧栏列表只显示**代表段**（实施-05 S5b-4）。
 *
 * 交接后磁盘上确实是两份 JSONL，但用户看到的是**同一条会话** —— 把旧段也列出来
 * 会让用户以为凭空多了两条。规则：
 *   · 不在任何链上 / 是链的最后一段 → 显示；
 *   · 是链上的旧段 → 隐藏；
 *   · 代表段的标题为空（新段往往还没标题）→ 用**链首段**的标题顶上，
 *     否则侧栏上那条会话会变成一行「未命名」（用户看到自己的会话“换了名字”）。
 *
 * 路径与 id 仍是代表段的：打开 / 发送都落在当前活动段。
 */
async function filterChainRepresentatives(list: SessionSummary[]): Promise<SessionSummary[]> {
  await sessionChains.load()
  const chains = sessionChains.chains()
  if (!chains.length) return list
  const out: SessionSummary[] = []
  for (const item of list) {
    if (!isRepresentative(chains, item.path)) continue
    const chain = chainForFile(chains, item.path)
    if (chain && chain.segments.length > 1 && !String(item.title ?? '').trim()) {
      const headPath = normalizeChainKey(chain.segments[0].sessionFile)
      const head = list.find((session) => normalizeChainKey(session.path) === headPath)
      out.push(head?.title ? { ...item, title: head.title } : item)
      continue
    }
    out.push(item)
  }
  return out
}

async function remoteHistory(sessionId: string, limit: number): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }

  /* 链感知：远程端看到的也是「一条会话」（与桌面端口径一致） */
  const result = await readHistoryWithArtifacts(summary.path)
  if (!result) return { ok: false, status: 502, error: '无法读取该会话历史' }
  const messages = result.messages.slice(-limit)
  return {
    ok: true,
    data: {
      session: remoteSessionSummary(summary),
      messages,
      total: result.total,
      returned: messages.length,
      truncated: result.truncated,
      bytes: result.bytes
    }
  }
}

/** 通过稳定 sessionId 切换当前桌面查看实例，并复用现有 runner 规则。 */
async function remoteSelectSession(sessionId: string): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }

  if (!runners) {
    const started = await startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await validateCwd(summary.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = summary.scope === 'global'
    ? undefined
    : (summary.projectId ?? projectIdForCwd(settings, cwdResult.cwd))
  const result = await runners!.select({
    sessionFile: summary.path,
    sessionId: summary.id,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  await rememberRunnerSession(result, {
    sessionFile: summary.path,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  if (result.ok && result.id) void pushRunnerSnapshot(result.id)
  pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

async function remoteNewSession(): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  if (!runners) {
    const started = await startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await validateCwd(settings.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = projectIdForCwd(settings, cwdResult.cwd)
  const scope = projectId ? 'project' as const : 'global' as const
  const result = await runners!.select({ cwd: cwdResult.cwd, projectId, scope })
  await rememberRunnerSession(result, { cwd: cwdResult.cwd, projectId, scope })
  if (result.ok && result.id) void pushRunnerSnapshot(result.id)
  pushRunners()
  return result.ok ? { ok: true, data: result } : { ok: false, status: 409, error: result.error }
}

/** 直接向目标会话发送，不改变桌面当前视图；必要时创建后台 runner。 */
async function remoteSendToSession(sessionId: string, text: string): Promise<RemoteOperationResult> {
  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }

  if (!runners) {
    const started = await startAgent()
    if (!started.ok) return { ok: false, status: 503, error: started.error ?? 'pi 未运行' }
  }
  const cwdResult = await validateCwd(summary.cwd)
  if (!cwdResult.ok) return { ok: false, status: 409, error: cwdResult.error }
  const projectId = summary.scope === 'global'
    ? undefined
    : (summary.projectId ?? projectIdForCwd(settings, cwdResult.cwd))
  const selected = await runners!.select({
    sessionFile: summary.path,
    sessionId: summary.id,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope,
    activate: false
  })
  if (!selected.ok || !selected.id) {
    return { ok: false, status: 409, error: selected.error ?? '无法为目标会话准备后台运行实例' }
  }
  if (runners!.hasBusyCwd(cwdResult.cwd, selected.id)) {
    return { ok: false, status: 409, error: '同一工作目录的另一个运行实例正在工作，暂不向目标会话发送以避免并发写入' }
  }
  await rememberRunnerSession(selected, {
    sessionFile: summary.path,
    cwd: cwdResult.cwd,
    projectId,
    scope: summary.scope
  })
  const agent = runners!.agentOf(selected.id)
  if (!agent) return { ok: false, status: 503, error: '目标运行实例已退出' }
  pushRunners()
  const result = await agent.send(text)
  return result.ok
    ? { ok: true, data: { ...result, runId: selected.runId, sessionId } }
    : { ok: false, status: 409, error: result.error ?? '目标会话未能接收消息' }
}

async function executeRemoteCommand(command: RemoteCommand): Promise<RemoteOperationResult> {
  if (command.action === 'select') return remoteSelectSession(command.sessionId)
  if (command.action === 'new') return remoteNewSession()

  if (command.action === 'send') {
    return remoteSendToSession(command.sessionId, command.text)
  }

  if (command.action === 'abort') {
    const agent = runners?.agentOf(command.runId)
    if (!agent) return { ok: false, status: 404, error: '找不到目标运行实例' }
    const state = agent.getState()
    if (!state?.isAgentRunning && !state?.isStreaming && !state?.isCompacting && !agent.hasRunningBash()) {
      return { ok: false, status: 409, error: '目标 runId 当前没有正在运行的任务' }
    }
    return { ok: true, data: { runId: command.runId, ...(await agent.abort()) } }
  }

  const settings = await getSettings()
  const summary = (await listSessions(500, settings.projects)).find((item) => item.id === command.sessionId)
  if (!summary) return { ok: false, status: 404, error: '找不到目标会话，可能已被删除' }
  const saved = await setManualTitle(command.sessionId, command.name)
  if (!saved.ok) return { ok: false, status: 500, error: saved.error ?? '保存会话名称失败' }
  if (ac()?.getState()?.sessionId === command.sessionId) {
    const renamed = await ac()!.renameSession(command.name)
    if (!renamed.ok) return { ok: false, status: 409, error: renamed.error ?? '当前会话名称未能同步到 pi' }
  }
  push({ ch: 'session-title', payload: { sessionId: command.sessionId, title: command.name } })
  return { ok: true, data: { sessionId: command.sessionId, name: command.name } }
}

function remoteServerEnabled(): boolean {
  const configuredPort = process.env.YAN_REMOTE_PORT?.trim()
  return process.env.YAN_REMOTE_ENABLE === '1' || !!configuredPort
}

async function startRemoteServer(): Promise<void> {
  if (!remoteServerEnabled() || remoteServer) return
  const host = process.env.YAN_REMOTE_HOST?.trim() || '127.0.0.1'
  const rawPort = process.env.YAN_REMOTE_PORT?.trim()
  const port = rawPort ? Number(rawPort) : 37892
  try {
    remoteServer = new RemoteServer({
      host,
      port,
      token: process.env.YAN_REMOTE_TOKEN,
      handlers: {
        snapshot: remoteSnapshot,
        history: remoteHistory,
        command: executeRemoteCommand
      },
      onLog: (text, level) => {
        if (level === 'error') console.error(`[remote] ${text}`)
        else console.log(`[remote] ${text}`)
      }
    })
    const info = await remoteServer.start()
    console.log(`[remote] Android 端使用 Bearer token 连接；token=${info.token}`)
    console.log(`[remote] health: http://${info.host}:${info.port}/remote/v1/health`)
  } catch (error) {
    remoteServer = null
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

async function createTray(): Promise<void> {
  if (tray) return
  const iconCandidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(__dirname_, '..', '..', 'build', 'icon.png')
  ]
  const iconPath = iconCandidates.find((candidate) => existsSync(candidate))
  tray = new Tray(iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty())
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
  await subagents?.stopAll()

  const settings = await getSettings()
  agentResponseDetail = settings.responseDetail
  /* 工作模式（实施-05）：新会话的初值；已存过的会话仍用会话自己的值 */
  agentDefaultWorkMode = settings.defaultWorkMode
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
    /* 每个实例自己一个 pi 子进程；事件带上实例 id（N12） */
    createAgent: (id, cwd, generation) =>
      new AgentController({
        push: (m) => pushFrom(id, m),
        cwd,
        piBin: settings.piBin,
        questionExtension: questionExtensionPath(),
        workModeExtension: workModeExtensionPath(),
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
        subagentHost: {
          run: (command, params, context) => {
            if (!subagentCapabilityHost) {
              return Promise.reject(new Error('子代理能力服务尚未注册'))
            }
            return subagentCapabilityHost.run(command, params, context)
          }
        },
        /* 目标状态（实施-05 S3）：会话键与模式 store 都在本文件一侧。 */
        goalHost: goalCapabilityHost,
        languageExtension: languageExtensionPath(),
        capabilityGuideExtension: capabilityGuideExtensionPath(),
        contextExtension: contextExtensionPath(),
        /* 项目知识注入（实施-03 S3）：检索在宿主，扩展只负责放到用户消息之前 */
        projectKnowledgeExtension: projectKnowledgeExtensionPath(),
        /* 单轮重复动作兜底（2026-09-22）：拦下在薄层，计入目标失败签名在宿主 */
        repeatGuardExtension: repeatGuardExtensionPath(),
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
        }
      }),
    onChanged: () => {
      pushRunners()
      requestPiPackageActivationTick()
    }
  })

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
 * 审查范围来自渲染端，一律当**不可信输入**校验。
 *
 * 参数数组已经挡住了 shell 注入，但 `--` 之前的**选项注入**还挡不住：
 * 一个形如 `--upload-pack=…` 的「ref」会被 git 当成选项。所以这里
 * 只放行 git ref 的合法字符集，并且**不以 `-` 开头**。
 * 任何不合法 / 缺失的范围都退回「工作区全部改动」—— 它是纯只读的，
 * 退到它不会造成任何破坏，而报错会让整个审查面板打不开。
 */
function normalizeScope(raw: unknown): GitScopeRequest {
  const rec = (raw ?? {}) as Record<string, unknown>
  const clean = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s || s.startsWith('-') || s.length > 250) return undefined
    if (!/^[\w./@^~{}+-]+$/.test(s)) return undefined
    return s
  }
  if (rec.kind === 'working' || rec.kind === 'unstaged' || rec.kind === 'staged') return { kind: rec.kind }
  if (rec.kind === 'range') {
    const base = clean(rec.base)
    const target = clean(rec.target)
    if (base && target) return { kind: 'range', base, target }
  }
  return { kind: 'working' }
}

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
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    !!win && !win.isDestroyed() && event.sender === win.webContents

  const guard = (event: Electron.IpcMainInvokeEvent): void => {
    if (!trusted(event)) throw new Error('拒绝来自非主窗口的 IPC 调用')
  }

  const handle = <T>(ch: string, fn: (...a: never[]) => Promise<T> | T): void => {
    ipcMain.handle(ch, async (event, ...args) => {
      guard(event)
      return fn(...(args as never[]))
    })
  }

  /** 与 handle 同一套校验，只是给「没有外层 helper」的那些通道用 */
  const rawHandle = (
    ch: string,
    fn: (event: Electron.IpcMainInvokeEvent, ...a: never[]) => unknown
  ): void => {
    ipcMain.handle(ch, async (event, ...args) => {
      guard(event)
      return fn(event, ...(args as never[]))
    })
  }

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

  /* ---- 会话管理 ---- */
  handle('yan:fork', async (entryId: string) => ac()?.fork(entryId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:clone', async () => ac()?.clone() ?? { ok: false, error: 'pi 未运行' })
  handle('yan:forkPoints', async () => ac()?.forkPoints() ?? [])
  handle('yan:exportHtml', async () => {
    const res = (await ac()?.exportHtml()) ?? { ok: false, error: 'pi 未运行' }
    if (res.ok && res.path) await shell.openPath(res.path)
    return res
  })
  handle('yan:deleteSession', async (path: string) => {
    try {
      await sessionChains.load()
      const chain = sessionChains.chainOf(path)
      /*
       * 删除按**链**整体处理（实施-05 S5b-4）：交接过的会话在磁盘上是两份 JSONL，
       * 只删其中一份会让历史拼接断成两截（看上去像内容丢了）。
       * 顺序仍是「先停实例、再删文件」，与单段删除同一条路。
       */
      const targets = chain && chain.segments.length > 1 ? planHistoryRead(chain) : [path]
      const current = ac()?.getState()?.sessionFile
      /* 当前正在用的会话在链上任何一段都算“在用”（防止把正在看的会话删掉） */
      for (const target of targets) await runners?.stopBySessionFile(target)
      const tokens: string[] = []
      for (const target of targets) {
        tokens.push(await deleteSession(target, current))
      }
      /* 段都进回收站了，链记录再留着就会指向不存在的文件（侧栏会把另一段也藏起来） */
      await sessionChains.forget(path).catch(() => false)
      pushRunners()
      /* 多个 token 用 `|` 拼成一个（IPC 形状不变）：撤销时要整链一起恢复 */
      return { ok: true, undoToken: tokens.join('|') }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('yan:restoreSession', async (undoToken: string) => {
    try {
      /* 链删除返回的是多个 token（`|` 分隔）：整链一起恢复，否则历史又会断 */
      const tokens = String(undoToken ?? '')
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)
      if (!tokens.length) return { ok: false, error: '没有可撤销的删除' }
      for (const token of tokens) await restoreSession(token)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /**
   * 移动项目语义归属：只写 session-layout.json，不移动 JSONL，也不停止 runner。
   * null 表示 Yan 默认全局位置；目标项目必须是设置里的稳定 projectId。
   */
  handle('yan:moveSession', async (sessionId: string, projectId: string | null) => {
    const settings = await getSettings()
    if (projectId !== null && !settings.projects.some((project) => project.id === projectId)) {
      return { ok: false, error: '目标项目不存在或已被移除' }
    }
    const summaries = await listSessions(500, settings.projects)
    const summary = summaries.find((item) => item.id === sessionId)
    if (!summary) return { ok: false, error: '找不到要移动的会话' }
    try {
      const entry = await moveSessionLayout(
        { sessionId: summary.id, sessionFile: summary.path, cwd: summary.cwd },
        projectId
      )
      return { ok: true, entry }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:newSession', async (target?: { cwd?: string; projectId?: string; scope?: 'global' | 'project' | 'pending' }) => {
    const settings = await getSettings()
    const cwdResult = await validateCwd(target?.cwd ?? settings.cwd)
    if (!cwdResult.ok) return cwdResult
    if (!runners) {
      const r = await startAgent()
      if (!r.ok) return r
    }
    if (target?.projectId && !settings.projects.some((project) => project.id === target.projectId)) {
      return { ok: false, error: '目标项目不存在或已被移除' }
    }
    const cwd = cwdResult.cwd
    const projectId = target?.scope === 'global'
      ? undefined
      : (target?.projectId ?? (target?.scope === 'pending' ? undefined : projectIdForCwd(settings, cwd)))
    const scope = target?.scope ?? (projectId ? 'project' : 'global')
    const res = await runners!.select({ cwd, projectId, scope })
    await rememberRunnerSession(res, { cwd, projectId, scope })
    if (res.ok && res.id) void pushRunnerSnapshot(res.id)
    pushRunners()
    return res.ok
      ? {
          ok: true,
          id: res.id,
          runId: res.runId,
          sessionId: res.sessionId,
          generation: res.generation
        }
      : { ok: false, error: res.error }
  })

  /**
   * 切到某个会话（N12）。
   *
   * 命中已有实例 → 只改视图（后台会话继续跑）；
   * 空闲实例 → 复用；到并发上限 → 明确报错。
   */
  handle(
    'yan:selectSession',
    async (target: { sessionFile?: string; sessionId?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }) => {
      const cwdResult = await validateCwd(target.cwd)
      if (!cwdResult.ok) return cwdResult
      if (!runners) {
        const r = await startAgent()
        if (!r.ok) return r
      }
      const settings = await getSettings()
      /* global 是显式产品归属，不能因为物理 cwd 恰好落在项目里就被重新吸回。 */
      const projectId = target.scope === 'global'
        ? undefined
        : (target.projectId ?? (target.scope === 'pending' ? undefined : projectIdForCwd(settings, cwdResult.cwd)))
      const res = await runners!.select({
        ...target,
        cwd: cwdResult.cwd,
        projectId
      })
      await rememberRunnerSession(res, {
        ...target,
        cwd: cwdResult.cwd,
        projectId,
        scope: target.scope ?? (projectId ? 'project' : 'global')
      })
      if (res.ok && res.id) void pushRunnerSnapshot(res.id)
      pushRunners()
      return res
    }
  )

  /** 所有运行实例的状态（左栏状态槽；也用于补上错过的 runners 推送） */
  handle('yan:runnerStatuses', async () => runners?.statuses() ?? [])

  /** 停掉某一个运行实例 —— 作用域只到它（单独停 B 不影响 A） */
  handle('yan:stopRunner', async (id: string) => {
    const done = (await runners?.stopOne(id)) ?? false
    pushRunners()
    return done
  })

  /* 兼容旧调用：与 selectSession 同一套逻辑（cwd 取当前项目） */
  handle('yan:switchSession', async (path: string) => {
    if (!runners) return { ok: false, error: 'pi 未运行' }
    const settings = await getSettings()
    const cwdResult = await validateCwd(settings.cwd)
    if (!cwdResult.ok) return cwdResult
    const res = await runners.select({ sessionFile: path, cwd: cwdResult.cwd })
    await rememberRunnerSession(res, {
      sessionFile: path,
      cwd: cwdResult.cwd,
      projectId: projectIdForCwd(settings, cwdResult.cwd),
      scope: 'project'
    })
    if (res.ok && res.id) void pushRunnerSnapshot(res.id)
    pushRunners()
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  handle('yan:compact', async () => ac()?.compact() ?? { ok: false, error: 'pi 未运行' })

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

  /*
   * 工作模式（实施-05）。
   *
   * 读写都针对**当前实例所在的会话**（不是全局设置）：A 会话切自主不得
   * 改变 B 会话的提问行为。界面提交时带 `expectedRevision`，不一致就拒绝
   * 并回传当前值 —— 界面据此恢复显示，不会出现「UI 已自主而扩展仍标准」。
   */
  handle('yan:getWorkMode', async () => {
    const id = runners?.activeRunner()?.id
    if (!id) return { mode: agentDefaultWorkMode, revision: 0 } satisfies WorkModeState
    return resolveWorkMode(id)
  })
  /**
   * 当前会话的目标状态（实施-05 S3，只读）。
   *
   * 与模式同一个键（会话文件路径）：目标也是**按会话**的 ——
   * 切会话后界面看到的是那个会话自己的进度，不是刚离开那个。
   */
  handle('yan:getGoal', async () => {
    const id = runners?.activeRunner()?.id
    if (!id) return { goal: goals.state(''), mode: { mode: agentDefaultWorkMode, revision: 0 } }
    await goals.load()
    return { goal: goals.state(workModeKeyFor(id)), mode: await resolveWorkMode(id) }
  })

  /**
   * 用户设定持续目标（`+` 菜单 → 目标）：目标 + 可衡量的成果。
   *
   * 身份只取宿主绑定的当前会话键（与 `yan:getGoal` 同一表达式）：请求里带
   * 别的会话 id 一律不看 —— 否则渲染端一个笔误就能把目标写到别的会话上。
   *
   * 这里**不**预写续行：用户接着还要把这条消息发出去，续行会在那一轮收尾时
   * 由 `maybeArmGoalContinue` 统一 arm（早 arm 会多跑一轮空转）。
   */
  handle('yan:setGoal', async (brief: unknown) => {
    const id = runners?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const }
    /*
     * 表单 / IPC / 读盘共用同一归一化（G-1）：
     * 必填的「目标 + 可衡量的成果」缺任一则拒收（允许缺等于造一个无法验收的目标），
     * 交付物 / 范围 / 约束是可选补充，只 trim、空即不落字段。
     */
    const normalized = normalizePursuedBrief(brief)
    if (!normalized) return { ok: false as const, error: 'incomplete' as const }
    await goals.load()
    const goal = await goals.startPursued(workModeKeyFor(id), normalized)
    await pushGoal(id)
    return { ok: true as const, goal }
  })
  /*
   * 交接状态（实施-05 S5b-2）——**只读**。
   *
   * 写入通道只有一条：宿主自己（薄层只产原文，校验与落盘都在主进程）。
   * 界面（与探针）要看的是「压了几次、包写了没有、这一次在不在生成中」——
   * 没有这个入口，带模型的真实取证就只能靠读文件，
   * 而「包已经写好」这件事在界面上永远是看不见的（§9 的 UI 与观测）。
   */
  handle('yan:getHandoff', async () => {
    await handoffDiag.load()
    const id = runners?.activeRunner()?.id
    if (!id) {
      return {
        sessionKey: '',
        tally: null,
        segmentTally: null,
        chainSegments: 0,
        package: null,
        pending: false,
        threshold: HANDOFF_THRESHOLD_EFFECTIVE,
        transaction: null,
        events: handoffDiag.recent(40),
        autoCommit: HANDOFF_COMMIT_ENABLED
      }
    }
    const key = workModeKeyFor(id)
    await handoffs.load()
    await handoffTransactions.load()
    /*
     * 交接之后当前实例跑在**目的段**上，而计数与包是按**源段**（片段键）存的。
     * 前端口径是「一条会话」，所以这里沿链回到首段去取 —— 否则交接一完成，
     * 界面上的「已压 N 次 / 包写好了没有」当场归零（看上去像功能坏了）。
     */
    await sessionChains.load()
    const chain = sessionChains.chainOf(key)
    const head = chain?.segments?.[0]?.sessionFile ?? key
    const entry = handoffs.state(head)
    const tx = handoffTransactions.latestForSession(key)
    /*
     * 诊断流水是**全局**的：不过滤就会把别的会话的整理失败也渲染到这条会话里
     *（用户 2026-09-23 报「这个提示在每个对话内都显示」）。
     * 一条会话 = 一条链，所以按链上的键筛（交接后的旧段仍属于它）；
     * 先筛再取最近 40 条 —— 反过来会被别处的噪音把本条挤掉。
     */
    const chainKeys = new Set<string>([key])
    for (const segment of chain?.segments ?? []) chainKeys.add(segment.sessionFile)
    const events = eventsForSession(handoffDiag.recent(), { keys: chainKeys, runnerId: id }).slice(-40)
    return {
      sessionKey: key,
      tally: entry.tally,
      /* 阈值看的是**本片段**又压了几次；`tally` 是链首的历史口径（实施-14 F5） */
      segmentTally: handoffs.state(key).tally,
      chainSegments: chain?.segments.length ?? 1,
      package: entry.package,
      pending: handoffPending.has(id),
      threshold: HANDOFF_THRESHOLD_EFFECTIVE,
      transaction: tx
        ? {
            handoffId: tx.handoffId,
            stage: tx.stage,
            /*
             * 归一化后回传：与 `sessionKey` 同一口径。
             * pi 给的会话文件路径在 Windows 上是反斜杠，直接回传会让前端
             * 「当前段 === 目的段」永远不相等（看上去像视图没切过去）。
             */
            destinationSession: normalizeChainKey(tx.destinationSession),
            receipts: tx.receipts ?? {},
            steps: tx.steps.slice(-4),
            resumeAttempts: tx.resumeAttempts
          }
        : null,
      /* 最近的过程事件（实施-14 F0）：界面 / 探针据此区分「没资格 / 没生成 / 没提交 / 没确认」 */
      events,
      autoCommit: HANDOFF_COMMIT_ENABLED
    }
  })
  /*
   * 人工确认「续接确实已经在跑」（实施-15 A-3）。
   *
   * 为什么需要这个出口：`resumed` 一直靠「会话文件里有标记」判，而标记只能证明
   * **已投递**（那段正文是本地拼的）。用户去看了一眼目的会话、确认模型真在跑了
   * 之后，需要一个**不重发**的了结 —— 否则 `resumeAttempts` 到 2 以后就只剩干等。
   *
   * 只允许在「已经发过」之后确认：没发过就跳过发送直接标完成是假的。
   */
  handle('yan:confirmHandoff', async (handoffId: string) => {
    await handoffTransactions.load()
    const tx = handoffTransactions.snapshot().transactions[String(handoffId ?? '')]
    if (!tx) return { ok: false, error: 'not-found' }
    if (typeof tx.receipts?.sentAt !== 'number') return { ok: false, error: 'not-sent' }
    const done = await handoffTransactions.step(tx.handoffId, 'resumed', 'manual-confirmed')
    handoffDiag.record({
      stage: 'commit',
      outcome: 'manual-confirmed',
      reason: 'user-verified',
      runnerId: runners?.activeRunner()?.id ?? '',
      sessionKey: tx.sourceSession
    })
    return { ok: done.advanced || done.tx?.stage === 'resumed' }
  })

  /*
   * 用户点「重试」（实施-14 F5）：清掉残留的生成现场，再走一遍单一调度。
   * 它不是「强行交接」—— 资格不够时照旧如实拒绝，只在诊断里多一条 `manual-retry`。
   */
  handle('yan:retryHandoff', async () => {
    const id = runners?.activeRunner()?.id
    if (!id) return { ok: false, error: 'pi 未运行' }
    await handoffDiag.load()
    handoffDiag.record({
      stage: 'generate',
      outcome: 'manual-retry',
      runnerId: id,
      sessionKey: workModeKeyFor(id)
    })
    /* 清掉可能残留的现场（没有就不做） */
    await abandonHandoff(id, 'manual-retry')
    /* 资格评估有 1 秒节流；用户明确要求重试，就让它现在真的判一次 */
    handoffLastCheck.delete(id)
    void scheduleSessionWork(id, 'manual-retry')
    return { ok: true }
  })
  handle('yan:setWorkMode', async (mode: WorkMode, expectedRevision?: number) => {
    const id = runners?.activeRunner()?.id
    if (!id) {
      return { ok: false, state: { mode: normalizeWorkMode(mode), revision: 0 }, error: 'pi 未运行' }
    }
    await workModes.load()
    const res = await workModes.set(workModeKeyFor(id), mode, expectedRevision)
    /*
     * 档位是用户对这条会话的明确意图（实施-14 A3）：
     *   · 新档仍然会「接着干」→ 保留未消费的续行（自主档，或 pursue 目标 —— 与档位正交）；
     *   · 其余情况（切到标准 / 计划）→ 作废未消费续行。
     * 旧实现只在 `mode !== 'standard'` 时清，于是**切回标准档**时自主档留下的
     * 续行仍然有效，下一轮它自己又跑起来。
     * ⚠️ 就绪转移不走这里（宿主内部直接调 `workModes.set`），所以不会误伤自己。
     */
    if (res.ok) {
      await goals.load()
      const key = workModeKeyFor(id)
      const pursue = goals.state(key).pursue === true
      /* 改档是明确动作：解除“用户按过停止”留下的暂停（A2） */
      await goals.setPaused(key, false).catch(() => {})
      const stillRuns = keepsGoalResumeOnModeChange(mode, pursue)
      if (!stillRuns) {
        await cancelGoalResume(id).catch(() => {})
        handoffDiag.record({
          stage: 'goal-continue',
          outcome: 'cancelled',
          reason: 'work-mode-changed',
          runnerId: id,
          sessionKey: key,
          detail: { mode, pursue }
        })
      }
    }
    /* 失败也要写 + 推：界面要拿当前值恢复，扩展也不能继续读旧值 */
    await writeWorkModeSnapshot(id, res.state).catch(() => {})
    pushFrom(id, { ch: 'work-mode', payload: res.state })
    return res
  })

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
  handle('yan:cachedTitles', async () => cachedTitles())
  /*
   * 手动重命名。比“自动标题”更松一点：写一个独立的粘性名。
   * 两条通路：
   *   · 当前会话也调一次 pi 的 set_session_name（TUI / 其它客户端能看到）
   *   · 无论哪个会话都写 manual-titles.json（桌面端左栏立刻生效、且不被重生标题盖掉）
   */
  handle('yan:renameSession', async (name: string) => ac()?.renameSession(name) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:manualTitles', async () => manualTitles())
  handle('yan:setManualTitle', async (sessionId: string, name: string) =>
    setManualTitle(String(sessionId ?? ''), String(name ?? ''))
  )
  handle('yan:regenerateTitle', async (sessionId: string) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, error: '缺少目标会话' }

    /*
     * 运行中的目标交给它自己的 AgentController：不能切当前视图，也不能把
     * 标题请求塞进主对话。非运行会话则只读 JSONL 的首尾用户消息，起一个
     * --no-session 的独立归纳进程；两条路径都按稳定 sessionId 归属结果。
     */
    const live = runners?.agentForSession(sid)
    if (live) return live.regenerateTitle()

    const settings = await getSettings()
    const session = (await listSessions(500, settings.projects)).find((item) => item.id === sid)
    if (!session) return { ok: false, error: '找不到目标会话，可能已被删除' }

    const samples = await readTitleSamples(session.path)
    if (!samples.length) return { ok: false, error: '该会话没有可用的用户文字，已保留原标题' }

    const manual = (await manualTitles())[sid]
    const result = await generateTitle({
      sessionId: sid,
      samples,
      cwd: session.cwd || process.cwd(),
      piBin: settings.piBin,
      force: true,
      allowManual: !!manual,
      persist: !manual
    })
    if (!result?.title) return { ok: false, error: '标题生成失败，已保留原标题' }
    if (!manual) push({ ch: 'session-title', payload: { sessionId: sid, title: result.title } })
    return { ok: true, title: result.title }
  })
  handle('yan:getCustomEntries', async () => ac()?.getCustomEntries() ?? [])
  handle('yan:refreshTodos', async () => ac()?.refreshTodos() ?? [])
  handle('yan:listSessions', async () => {
    const settings = await getSettings()
    /*
     * 生产端保持 200 条的桌面快照边界。隔离 live 回归会在一个批次里
     * 生成大量临时会话；它们只是测试夹具，不应把批次开始时种下的
     * 目标会话挤出列表，所以允许测试进程显式提高这一次 IPC 快照上限。
     */
    const requested = Number(process.env.YAN_TEST_SESSION_LIST_LIMIT)
    const limit = Number.isInteger(requested) && requested > 200 && requested <= 1000 ? requested : 200
    return filterChainRepresentatives(await listSessions(limit, settings.projects))
  })

  /**
   * 快速预览一个会话的消息 —— **直接读文件，不问 pi**。
   *
   * 为什么需要（实测）：打开一个 17MB 的会话，
   *   pi 的 switch_session + get_messages = **2780ms**
   *   直接解析 JSONL               = **59ms**
   * 而且 pi 的 get_messages 不含压缩前历史（docs/rpc.md 写了），
   * 所以大会话在界面上只剩当前窗口 —— 用户感觉是「又卡又少内容」。
   *
   * 调用方应该：先拿这个把内容锦上（瞬间），再让 pi 在后台切过去。
   * 返回 null 表示读不出来（格式不认 / 文件不在）—— 调用方回退到等 pi。
   */
  handle('yan:peekSession', async (path: string) => {
    if (typeof path !== 'string' || !path) return null
    /* 链感知：切到交接过的会话时，锦上的历史也必须是完整的一条时间线 */
    return readHistoryWithArtifacts(path)
  })

  /* ---- 模型接入（凭证） ---- */
  handle('yan:authProviders', async (deep?: boolean) => {
    const s = await getSettings()
    const probe = resolvePi({ override: s.piBin })
    return listAuthProviders({ cmd: probe.cmd, args: probe.args }, !!deep)
  })
  handle('yan:setApiKey', async (provider: string, key: string) => setApiKey(provider, key))
  handle('yan:clearAuth', async (provider: string) => clearAuth(provider))
  handle('yan:authFileInfo', async () => authFileInfo())

  /*
   * 应用内登录 ChatGPT 订阅（Codex）。
   *
   * 为什么登录后要重启 agent：pi 在**启动时**读 auth.json，正在跑的那个子进程
   * 不会因为文件变了就重新读。不重启的话用户会看到「登录成功但模型还是旧的 /
   * 依然报没凭证」—— 这与语言切换需要重启是同一个原因，所以复用那条路。
   *
   * 重启是**非阻塞**的（fire and forget）：登录结果要立刻回给界面，而重启要等
   * 当前这一轮跑完（见 restartAgent 里的空闲等待），不能让设置页转圈等它。
   */
  handle('yan:codexLogin', async () => {
    const r = await startCodexLogin()
    if (r.ok) void restartAgent('ChatGPT 登录')
    return r
  })
  handle('yan:codexLoginCancel', async () => {
    cancelCodexLogin()
  })

  /**
   *  文件引用补全 —— 只读一层目录（不递归扫项目）。
   * 以 cwd 为根；拒绝跳出 cwd 的路径。
   */
  handle('yan:completePath', async (prefix: string, requestedCwd?: string, rawContext?: unknown) => {
    const st = await getSettings()
    const resolved = await resolveFileContext(st, typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : st.cwd, rawContext)
    if (!resolved.ok) {
      return { paths: [], truncated: false, status: 'invalid' as const, request: resolved.context }
    }
    return completePath(resolved.context.cwd, String(prefix ?? ''), resolved.context)
  })

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
    if (patch.defaultWorkMode !== undefined) agentDefaultWorkMode = next.defaultWorkMode
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
  ipcMain.on('yan:respondUi', (_e, res) => ac()?.respondUi(res))

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

  /*
   * 拖入的普通文件：主进程校验 + 登记授权（方案 5.1）。
   * ⚠️ 这是安全边界：渲染端只能传路径，能不能读、是不是普通文件、
   *    有没有超出大小上限，全部在这里定，而且只认已登记的路径。
   */
  handle('yan:describeFiles', async (paths: string[]) => grantFiles(paths))
  handle('yan:readFileText', async (p: string) => readGrantedText(String(p ?? '')))
  /* 只读预览（消息里的文件链接）：相对路径按**当前会话 cwd** 解析 */
  handle('yan:readPreview', async (p: string, line?: number, requestedCwd?: string, lineEnd?: number) => {
    const s = await getSettings()
    const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    return readPreview(
      String(p ?? ''),
      cwd,
      typeof line === 'number' ? line : undefined,
      typeof lineEnd === 'number' ? lineEnd : undefined
    )
  })
  /* 变化提示：只 stat（不读内容），与 readPreview 同一条越界校验链 */
  handle('yan:statPreview', async (p: string, requestedCwd?: string) => {
    const s = await getSettings()
    const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    return statPreview(String(p ?? ''), cwd)
  })

  /* ---- 文件树 ---- */
  rawHandle('yan:listDir', async (_e, rel: unknown, showHidden: unknown, rawContext: unknown) => {
    const s = await getSettings()
    const context = isObject(rawContext) ? rawContext : undefined
    const requestedCwd = context && typeof context.cwd === 'string' ? context.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, context)
    if (!resolved.ok) {
      return {
        path: typeof rel === 'string' ? rel : '',
        abs: '',
        entries: [],
        skipped: [],
        truncated: false,
        status: 'invalid' as const,
        error: resolved.error,
        request: resolved.context
      }
    }
    return listDir(resolved.context.cwd, typeof rel === 'string' ? rel : '', showHidden === true, resolved.context)
  })
  rawHandle('yan:searchFiles', async (_e, rawRequest: unknown) => {
    const s = await getSettings()
    const input = isObject(rawRequest) ? rawRequest : {}
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim().slice(0, 160) : ''
    const query = typeof input.query === 'string' ? input.query.slice(0, 240) : ''
    const requestedCwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, input)
    const request: FileSearchRequest = {
      ...resolved.context,
      requestId,
      query,
      ...(typeof input.limit === 'number' && Number.isFinite(input.limit) ? { limit: input.limit } : {})
    }
    if (!resolved.ok) {
      return { request, entries: [], status: 'invalid' as const, truncated: false, scannedDirs: 0, skippedDirs: 0 }
    }
    if (!requestId) {
      return { request, entries: [], status: 'invalid' as const, truncated: false, scannedDirs: 0, skippedDirs: 0 }
    }
    activeFileSearches.get(requestId)?.abort()
    const controller = new AbortController()
    activeFileSearches.set(requestId, controller)
    try {
      return await searchFiles(request, controller.signal)
    } finally {
      if (activeFileSearches.get(requestId) === controller) activeFileSearches.delete(requestId)
    }
  })
  rawHandle('yan:cancelFileSearch', async (_e, rawRequestId: unknown) => {
    if (typeof rawRequestId !== 'string') return
    activeFileSearches.get(rawRequestId)?.abort()
  })

  /* ---- 自动压缩设置（只读 pi 的 settings.json）---- */
  rawHandle('yan:compactionInfo', async (_e, win: unknown) => {
    const s = await getSettings()
    return compactionInfo(s.cwd, typeof win === 'number' ? win : 0)
  })

  /*
   * 项目信任（实施-07 S2b-2）。
   *
   * 为何只给「读」与「用户显式信任一个目录」两件事：
   * 工作树目录通常在仓库旁边（不在主仓库路径之下），所以「源目录被信任」不等于
   * 「工作树目录被信任」—— 而 RPC 模式没有信任弹窗，用户不改 trust.json 就永远
   * 看不到项目级设置生效。**不做自动继承**（形态决策里的反模式之一）。
   *
   * ⚠️ 这两个句柄**故意不读 settings**（调用方必须把目录传进来）：
   *   `getSettings()` 与 `patchSettings()` 的读-改-写不是原子的（见 settings.ts 的
   *   `writeQueue` 注释），多一个“顺手读一下设置”的调用方就多一次交错机会 ——
   *   2026-09-19 真实踩到：这两个句柄原本会 fallback 到 `settings.cwd`，
   *   于是工作树创建后「登记为项目」的写入被并发读盘缓存盖掉（项目从列表里消失）。
   */
  rawHandle('yan:trust:status', async (_e, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir) return { cwd: '', trusted: false, entry: null }
    return trustStatus(dir)
  })
  rawHandle('yan:trust:allow', async (_e, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir) return { ok: false, entry: '', error: '缺少目录' }
    return allowTrust(dir)
  })

  /*
   * 工作树 Fork 的文件引用重绑定（实施-07 S2b-3）。
   *
   * 渲然端给「目标工作树 + 当前会话文件与 cwd」，主进程把源会话里 `@` 过的
   * 仓库内文件拿到目标仓库根下重新解析 —— 一律用**仓库相对路径**，
   * 仓库外的路径报 `outside`（不迁移）。这里的 `explicitRefs` 只给测试与将来的
   * 显式交接用（写死一份引用比伪造会话文件诚实）。
   */
  rawHandle('yan:fork:fileRefs', async (_e, arg: unknown) =>
    forkFileRefs((arg ?? {}) as Parameters<typeof forkFileRefs>[0])
  )

  /*
   * Fork 的语义注入正文（实施-07 S2b-4）。
   *
   * 渲染端在「派生新会话」成功后调它，拿到的文本作为**输入框草稿**注入（不自动发送）：
   * 用户能看一眼、补一句、也可以直接删掉。正文里只有「接手必须知道的」：
   * 在**目标工作树重算过的**分支 / HEAD / 变更数、源会话的文件引用对照、以及
   * 源会话**交接包里可迁移的知识**（没有就明说没有）。
   */
  rawHandle('yan:fork:context', async (_e, arg: unknown) => {
    const req = (arg ?? {}) as Parameters<typeof forkContext>[0]
    await handoffs.load()
    const packageOf = (sessionFile: string): HandoffPackage | null => {
      try {
        const key = normalizeSessionFileKey(sessionFile)
        return key ? handoffs.state(key).package : null
      } catch {
        return null
      }
    }
    return forkContext(req, packageOf)
  })
  /*
   * 工作集预算（N21-3）：**只算不决策**。
   * 界面上显示的工作集与砚真正用来判断过线的是同一份预算（同一个策略对象），
   * 测试也用它对照参考值（64k → 40k、128k → 88k、256k → 179k、1M → 240k）。
   */
  rawHandle('yan:contextBudget', (_e, win: unknown) => {
    /*
     * 用**当前会话模型**查表（N21-7）：模型级覆盖生效时，界面看到的预算
     * 必须与 agent 真正用的那份一致 —— 探针的“界面数 = 主进程数”靠这条。
     */
    const modelKey = modelKeyOf(ac()?.getState()?.model)
    const resolved = activeContextPolicy(process.env, modelKey)
    /* 与 `AgentController.contextPolicyView()` 同口径：档位名要靠精确模型层原文判断 */
    const modelOverrides = modelKey ? contextPolicySettings().byModel?.[modelKey] : undefined
    return {
      policy: resolved.policy,
      budget: contextBudget(typeof win === 'number' ? win : 0, resolved.policy),
      source: resolved.source,
      ...(resolved.sourceKey ? { sourceKey: resolved.sourceKey } : {}),
      overridden: resolved.overridden,
      ...(modelOverrides ? { modelOverrides } : {})
    }
  })
  rawHandle('yan:providerQuota', (_e, provider: unknown, budget: unknown) => providerQuota(String(provider ?? ''), Number(budget) || undefined))

  /*
   * 三类整理动作账本（实施-11 C-2b）：`tool-sweep` / `episode-fold`
   * 不产生 pi 的 `compaction_*` 事件，界面只能从这里读到它们真实发生过。
   * 读不到就返回空统计 —— 诊断读数不该让界面报错。
   */
  rawHandle('yan:contextActions', () => readContextActions(ac()?.getState()?.sessionId ?? null))

  /* ---- 子代理（方案第 8 节）---- */
  const subagentCtrl = async (): Promise<SubagentController> => {
    if (subagents) return subagents
    const s = await getSettings()
    subagents = new SubagentController({
      cwd: s.cwd,
      piBin: s.piBin,
      appendSystemPrompt: SUBAGENT_SYSTEM_PROMPT,
      onChange: (run) => push({ ch: 'subagent', payload: run }),
      onRemove: (id) => push({ ch: 'subagent-remove', payload: id })
    })
    return subagents
  }

  /*
   * 模型调用与 UI 调用必须共用同一个控制器：这样模型启动的任务也会
   * 通过 `onChange` 推到输入区上方的列表和右侧详情，而不是变成“后台黑盒”。
   * 这里不暴露 merge/discard —— worktree 结果仍由用户在详情面板审阅。
   */
  subagentCapabilityHost = {
    async run(command, params, context) {
      const ctrl = await subagentCtrl()
      ctrl.setContext(context)

      if (command === 'subagent.start') {
        const task = typeof params.task === 'string' ? params.task.trim() : ''
        if (!task) {
          throw new CapabilityCommandError(
            'subagent_task_required',
            'subagent start 需要 task'
          )
        }
        if (task.length > 12_000) {
          throw new CapabilityCommandError(
            'subagent_task_too_long',
            '子代理任务不能超过 12000 个字符'
          )
        }
        const model = typeof params.model === 'string' && params.model.length <= 200 ? params.model : undefined
        const readOnly = params.readOnly === true || params['read-only'] === true
        const result = await ctrl.start(task, model, readOnly ? 'controlled-cwd' : 'worktree')
        if (!result.ok || !result.run) {
          throw new CapabilityCommandError(
            'subagent_start_failed',
            result.error ?? '子代理启动失败'
          )
        }
        const run = result.run
        return {
          data: run,
          summary: {
            kind: 'subagent',
            action: 'start',
            id: run.id,
            status: run.status,
            isolation: run.isolation,
            task: run.task,
            latestActivity: run.latestActivity
          }
        }
      }

      if (command === 'subagent.list') {
        const runs = ctrl.list()
        const active = runs.filter((run) => run.status === 'running' || run.status === 'starting')
        return {
          data: runs,
          summary: {
            kind: 'subagent',
            action: 'list',
            count: runs.length,
            active: active.length,
            ids: runs.map((run) => run.id)
          }
        }
      }

      const id = typeof params.id === 'string' ? params.id.trim() : ''
      if (!/^sub-[0-9a-f]+$/.test(id)) {
        throw new CapabilityCommandError(
          'subagent_id_required',
          '该子代理动作需要合法的 id（例如 sub-a1b2c3d4）'
        )
      }

      if (command === 'subagent.get') {
        const run = ctrl.get(id)
        if (!run) {
          throw new CapabilityCommandError(
            'subagent_not_found',
            `找不到子代理：${id}`
          )
        }
        return {
          data: run,
          summary: {
            kind: 'subagent',
            action: 'get',
            id: run.id,
            status: run.status,
            latestActivity: run.latestActivity,
            transcript: run.transcript.length,
            review: run.review
          }
        }
      }

      if (command === 'subagent.stop') {
        const result = await ctrl.stop(id)
        if (!result.ok) {
          throw new CapabilityCommandError(
            'subagent_stop_failed',
            result.error ?? `停止子代理失败：${id}`
          )
        }
        const run = ctrl.get(id)
        return {
          data: run,
          summary: {
            kind: 'subagent',
            action: 'stop',
            id,
            status: run?.status ?? 'stopped'
          }
        }
      }

      throw new CapabilityCommandError(
        'not_implemented',
        `命令已登记但尚未实现：${command}`
      )
    }
  }
  handle('yan:subagents:list', async () => (await subagentCtrl()).list())
  handle('yan:subagents:start', async (task: string, model?: string, isolation?: string) => {
    const ctrl = await subagentCtrl()
    const settings = await getSettings()
    const state = ac()?.getState()
    const active = runners?.activeRunner()
    const runtime = active?.id ? runners?.runtimeOf(active.id) : null
    const projectId = state?.cwd ? projectIdForCwd(settings, state.cwd) : undefined
    ctrl.setContext({
      cwd: state?.cwd ?? active?.cwd ?? settings.cwd,
      /* 空白新会话在 pi 首次写入前可能还没有 sessionId；runtime 的
       * pending:<runId> 是可追踪的明确占位，不把父子关系丢掉。 */
      parentSessionId: state?.sessionId || runtime?.sessionId,
      parentRunId: active?.id,
      projectId
    })
    const mode = isolation === 'controlled-cwd' ? 'controlled-cwd' : 'worktree'
    return ctrl.start(String(task ?? ''), typeof model === 'string' ? model : undefined, mode)
  })
  handle('yan:subagents:stop', async (id: string) => (await subagentCtrl()).stop(String(id ?? '')))
  handle('yan:subagents:stopAll', async () => {
    await (await subagentCtrl()).stopAll()
  })
  handle('yan:subagents:clear', async () => {
    ;(await subagentCtrl()).clearFinished()
  })
  handle('yan:subagents:merge', async (id: string) => (await subagentCtrl()).merge(String(id ?? '')))
  handle('yan:subagents:discard', async (id: string) => (await subagentCtrl()).discard(String(id ?? '')))

  /*
   * ---- Git 审查（只读，方案 G1）----
   *
   * 渲染端只能传 cwd / 范围 / 路径，**不能传 git 命令**（方案 §11）：
   * 命令形状全部在主进程里固定，路径与 ref 在 git-service 里单独校验。
   * 每个响应带回 requestId，用户切项目后渲染端靠它丢弃迟到结果。
   */
  handle('yan:git:state', async (cwd: string) => {
    try {
      const dir = String(cwd ?? '')
      const repo = await resolveRepo(dir)
      if (!repo) return { repo: null }
      /*
       * 一起把「预期版本」带回去：环境菜单里的写操作（切分支 / 拉取 / 推送）
       * 同样要带上用户看到的那个版本，而菜单没有审查快照可用。
       * 两次读取与菜单显示的内容是**同一个时刻**的（差几毫秒），
       * 而且先读版本更安全（见 git-diff.ts 里 reviewSnapshot 的同一段说明）。
       */
      const expected = await readExpected(repo.root)
      return { repo: await readRepoState(repo.root), expected }
    } catch (error) {
      return { repo: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('yan:git:refs', async (cwd: string) => {
    try {
      const repo = await readRepoState(String(cwd ?? ''), { withRefs: false })
      if (!repo) return { ok: false, refs: [], busyBranches: [], error: '这个目录不在 Git 仓库里' }
      const listing = await listRefs(repo.root)
      return { ok: true, refs: listing.refs, busyBranches: listing.busyBranches }
    } catch (error) {
      return {
        ok: false,
        refs: [],
        busyBranches: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  handle('yan:git:snapshot', async (req: { cwd?: string; scope?: unknown; requestId?: string }) =>
    reviewSnapshot({
      cwd: String(req?.cwd ?? ''),
      scope: normalizeScope(req?.scope),
      requestId: String(req?.requestId ?? '')
    })
  )
  handle(
    'yan:git:patch',
    async (req: {
      cwd?: string
      scope?: unknown
      requestId?: string
      path?: string
      oldPath?: string
      untracked?: boolean
    }) =>
      filePatch({
        cwd: String(req?.cwd ?? ''),
        scope: normalizeScope(req?.scope),
        requestId: String(req?.requestId ?? ''),
        path: String(req?.path ?? ''),
        oldPath: req?.oldPath ? String(req.oldPath) : undefined,
        untracked: !!req?.untracked
      })
  )
  handle(
    'yan:git:content',
    async (req: {
      cwd?: string
      scope?: unknown
      requestId?: string
      path?: string
      side?: string
    }) =>
      fileContent({
        cwd: String(req?.cwd ?? ''),
        scope: normalizeScope(req?.scope),
        requestId: String(req?.requestId ?? ''),
        path: String(req?.path ?? ''),
        /* side 只认 old / new，别的一律当 old（宁可少给一侧也不给错一侧） */
        side: req?.side === 'new' ? 'new' : 'old'
      })
  )

  /*
   * ---- Git 写操作（方案 §5，G2）----
   *
   * 这是整个应用里**唯一**会改用户 Git 状态的入口。防护在 git-actions.ts 里
   * （按仓库串行、执行前复核预期版本、不 stash/reset/force），这里只做三件事：
   *   · 剥掉渲染端不该决定的东西（命令形状一律由主进程构造）
   *   · 把「这个目录有没有在跑的任务」注入进去 —— 切分支前必须问（方案 §5.1）
   *   · 兜异常，保证渲染端**永远**能拿到一个结果（否则界面会一直转圈）
   */
  handle('yan:git:action', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    const cwd = String(raw.cwd ?? '')
    const expected = (raw.expected ?? {}) as Record<string, unknown>
    const base = {
      requestId: String(raw.requestId ?? ''),
      cwd,
      expected: {
        head: typeof expected.head === 'string' ? expected.head : null,
        indexDigest: String(expected.indexDigest ?? ''),
        statusDigest: String(expected.statusDigest ?? '')
      }
    }
    const kind = String(raw.kind ?? '')
    const paths = Array.isArray(raw.paths) ? raw.paths.map((v) => String(v ?? '')) : []
    const message = typeof raw.message === 'string' ? raw.message : ''
    const branch = typeof raw.branch === 'string' ? raw.branch : ''
    const startPoint = typeof raw.startPoint === 'string' && raw.startPoint ? raw.startPoint : null
    const remote = typeof raw.remote === 'string' && raw.remote ? raw.remote : null

    let action: Parameters<typeof runGitAction>[0]
    switch (kind) {
      case 'stage':
      case 'unstage':
        action = { ...base, kind, paths }
        break
      case 'stage-all':
      case 'unstage-all':
        action = { ...base, kind }
        break
      case 'commit':
        action = { ...base, kind, message }
        break
      case 'switch-branch':
        action = { ...base, kind, branch }
        break
      case 'create-branch':
        action = { ...base, kind, branch, startPoint, checkout: !!raw.checkout }
        break
      case 'fetch':
        action = { requestId: base.requestId, cwd, kind, remote }
        break
      case 'push':
        action = {
          ...base,
          kind,
          remote,
          setUpstream: !!raw.setUpstream,
          branch: branch || null
        }
        break
      default:
        return {
          ok: false,
          failure: { code: 'unknown', message: `不支持的操作：${kind}`, retrySafe: false }
        }
    }
    try {
      return await runGitAction(action)
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false
        }
      }
    }
  })
  /*
   * ---- 用户工作树（方案 §6.2，W1）----
   *
   * 注意与子代理隔离工作树的区别：那条路径是「一次性容器 + --force 清理」，
   * 这里建的会被用户长期使用，所以删除前逐项检查，且**没有** force 入口。
   * 「有任务在跑」的判据与切分支同一个（注入的 runner 状态）。
   */
  handle('yan:git:worktrees', async (cwd: string) => {
    try {
      return await listWorktrees(String(cwd ?? ''))
    } catch (error) {
      return {
        ok: false,
        repoRoot: '',
        worktrees: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  handle('yan:git:worktreeCreate', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return await createWorktree(
        {
          cwd: String(raw.cwd ?? ''),
          branch: String(raw.branch ?? ''),
          startPoint: typeof raw.startPoint === 'string' && raw.startPoint ? raw.startPoint : null,
          targetPath: typeof raw.targetPath === 'string' && raw.targetPath ? raw.targetPath : null,
          /*
           * 携带未提交改动（W2a）。这里**逐字段取值**而不是把 raw 直接传下去：
           * 渲染端来的东西是不可信输入，多传一个字段就可能多一条能改用户仓库的路径。
           * untracked 只收字符串，且由主进程再跟 `git ls-files --others` 对一遍。
           */
          carry: (() => {
            const c = raw.carry as Record<string, unknown> | null | undefined
            if (!c || typeof c !== 'object') return null
            return {
              staged: c.staged === true,
              unstaged: c.unstaged === true,
              untracked: Array.isArray(c.untracked) ? c.untracked.filter((x): x is string => typeof x === 'string') : []
            }
          })()
        },
        (dir) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, dir))
      )
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false
        }
      }
    }
  })
  handle('yan:git:worktreeRemove', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return await removeWorktree(
        {
          cwd: String(raw.cwd ?? ''),
          path: String(raw.path ?? ''),
          deleteBranch: !!raw.deleteBranch
        },
        (dir) => (runners?.statuses() ?? []).some((st) => st.running && samePathKind(st.cwd, dir))
      )
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false
        }
      }
    }
  })

  /*
   * 「会话 ↔ 工作树」的来源关系（实施-07 S2）。
   *
   * 登记发生在渲染端：「开新会话」是在**新目录**里开一条新会话，
   * 而主进程这边 `newSession` / `select` 并不知道用户是从哪个工作树按钮点过来的。
   * 读回是全量的 —— 界面要回答「这个会话从哪来」，而列表本身很小。
   */
  handle('yan:git:worktreeLink', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return await worktreeOrigins.link({
        sessionId: String(raw.sessionId ?? ''),
        sessionFile: typeof raw.sessionFile === 'string' ? raw.sessionFile : undefined,
        worktree: String(raw.worktree ?? ''),
        branch: typeof raw.branch === 'string' ? raw.branch : undefined,
        fromSessionId: typeof raw.fromSessionId === 'string' ? raw.fromSessionId : undefined,
        fromSessionFile: typeof raw.fromSessionFile === 'string' ? raw.fromSessionFile : undefined,
        fromCwd: typeof raw.fromCwd === 'string' ? raw.fromCwd : undefined
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('yan:git:worktreeLinks', async () => {
    try {
      await worktreeOrigins.load()
      return worktreeOrigins.links()
    } catch {
      return []
    }
  })

  /*
   * remote 的托管网页地址（方案 §7 的托管网页比较，只读）。
   * 渲染端拿到的只是一个 https 链接 —— 它**不能**让主进程跑任意 git 命令，
   * 这条通道也一样（remote 名字由主进程自己挑）。
   */
  /*
   * 关联 PR 的状态（§7）。**只读** —— 不创建、不合并、不评论。
   *
   * token 只从环境变量读（GITHUB_TOKEN / GH_TOKEN）：不落盘、不进设置，
   * 也不去翻用户的 ~/.config/gh（那是 gh 自己的东西）。没有 token 时
   * GitHub 允许匿名读公开仓库，私有仓库会返回 404/403，那时界面如实显示
   * 「需要认证」—— 不编状态。
   */
  handle('yan:git:prStatus', async (cwd: string) => {
    try {
      const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || null
      return await prStatus(String(cwd ?? ''), token)
    } catch (error) {
      return {
        ok: false,
        state: 'none' as const,
        checks: 'none' as const,
        error: 'unknown' as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  handle('yan:git:remoteWeb', async (cwd: string) => {
    try {
      return await remoteWeb(String(cwd ?? ''))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /*
   * pi 插件包管理（§9 的 P2）。
   *
   * 注入两样东西（都只有这里才拿得到）：
   *   · **bin** —— 必须走 resolvePi()，用户可能用设置项 piBin 覆盖或用系统安装。
   *     自己拼内置路径会出现「装到 A、跑的是 B」这种最难查的问题。
   *   · **hasRunningTask** —— 扩展是 pi 启动时加载的，正在跑的回合与磁盘上的
   *     包集合必须一致，所以有任务时直接拒绝。
   */
  /*
   * 会话来源（§8 的 S1）。
   *
   * 只有 addImage / removeImage 会写磁盘，而且只写数据目录下属于这个会话的副本 ——
   * 文件引用（用户的原文件）**永远不写也不删**，removeImage 那边还有一道
   * 「拼出来的路径必须还在 sources 目录里」的兜底。
   */
  handle('yan:sources:list', async (sessionId: string) => {
    try {
      return listImagesForSession(String(sessionId ?? ''))
    } catch (error) {
      return { ok: false, images: [], dir: '', error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:sources:addImage', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return saveImage({
        sessionId: String(raw.sessionId ?? ''),
        name: String(raw.name ?? ''),
        mimeType: String(raw.mimeType ?? ''),
        base64: String(raw.base64 ?? '')
      })
    } catch {
      return null
    }
  })

  handle('yan:sources:verifyFiles', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      const entries = Array.isArray(raw.entries)
        ? raw.entries
            .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
            .map((x) => ({
              path: String(x.path ?? ''),
              name: typeof x.name === 'string' ? x.name : undefined,
              addedAt: typeof x.addedAt === 'number' ? x.addedAt : undefined
            }))
            .filter((x) => x.path)
        : []
      return verifyFiles(String(raw.sessionId ?? ''), entries)
    } catch {
      return []
    }
  })

  handle('yan:sources:link', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return linkSources({
        sessionId: String(raw.sessionId ?? ''),
        sourceIds: Array.isArray(raw.sourceIds) ? raw.sourceIds.map((x) => String(x)) : [],
        messageId: String(raw.messageId ?? '')
      })
    } catch (error) {
      return { ok: false, added: 0, skipped: 0, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:sources:removeImage', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return removeImage(String(raw.sessionId ?? ''), String(raw.sourceId ?? ''))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:sources:readImage', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return readImage(String(raw.sessionId ?? ''), String(raw.sourceId ?? ''))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /*
   * 来源搜索入口的可用性（实施-07 S4）。只读查询：不装、不连、不搜。
   * 没发现兼容搜索能力时如实回 `available:false`，界面据此**隐藏**入口
   *（方案：网页搜索只在已发现兼容搜索能力时启用，且不自造私有搜索后端）。
   */
  handle('yan:sources:webSearch', async () => (await ac()?.webSearchAvailability()) ?? { available: false })

  handle('yan:packages:list', async (cwd: string) => {
    try {
      return listPackages(String(cwd ?? ''))
    } catch (error) {
      return { ok: false, agentDir: '', userSettings: '', projectSettings: '', entries: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  /*
   * 受信内置能力清单（实施-02 S4）：设置页要用它与「用户装的插件」分开。
   * 只读，且与 pi 实际加载的路径同源 —— 不缓存，免得用户换了安装形态
   *（开发态 ↔ 打包态）后看到一份过期的清单。
   */
  handle('yan:capabilities:builtin', async () => builtinCapabilities(yanThinExtensionPaths()))

  /*
   * 能力页初次打开只取 pi 已加载的 Skill 与本 runner 可见的 MCP 配置；不握手、不启动 stdio。
   * 验证操作由主进程分配 operationId 并固定到 runnerId + generation，渲染端不能指定项目。
   */
  handle('yan:capabilities:settings', async () => {
    const agent = ac()
    return agent ? agent.capabilitySettingsSnapshot() : { skills: [], servers: [], configWarning: false }
  })
  handle('yan:capabilities:discover', async (value: unknown) => {
    const queryText = typeof value === 'string' ? value.slice(0, 500) : ''
    const agent = ac()
    if (!agent) return { query: '', reason: '当前没有可用的运行实例', sources: [], candidates: [] }
    try {
      return await agent.discoverCapabilitiesForSettings(queryText)
    } catch {
      return {
        query: '',
        reason: 'unavailable',
        sources: [],
        candidates: []
      }
    }
  })
  handle('yan:capabilities:verify', async (value: unknown) => {
    const serverId = typeof value === 'string' ? value.trim() : ''
    if (!serverId) return { ok: false, error: '缺少 MCP 服务 ID' }
    const agent = ac()
    const runner = runners?.activeRunner()
    const runtime = runner ? runners?.runtimeOf(runner.id) : null
    if (!agent || !runner || !runtime) return { ok: false, error: '当前没有可验证的运行实例' }
    pruneCapabilityVerifications()
    if ([...capabilityVerifications.values()].filter((op) => op.state === 'connecting').length >= 8) {
      return { ok: false, error: '同时验证的 MCP 服务过多，请稍后再试' }
    }
    const operationId = randomUUID()
    const operation: CapabilityVerification = {
      operationId,
      runnerId: runner.id,
      generation: runtime.generation,
      agent,
      serverId,
      state: 'connecting',
      updatedAt: Date.now()
    }
    capabilityVerifications.set(operationId, operation)
    void agent.verifyCapabilityMcp(serverId).then(
      (result) => {
        if (operation.state === 'cancelled') return
        const current = runners?.runtimeOf(operation.runnerId)
        if (!current || current.generation !== operation.generation || runners?.agentOf(operation.runnerId) !== agent) {
          operation.state = 'stale'
        } else {
          operation.state = result.status === 'ready' ? 'ready' : 'error'
          operation.toolCount = result.toolCount
        }
        operation.updatedAt = Date.now()
      },
      () => {
        if (operation.state !== 'cancelled') operation.state = 'error'
        operation.updatedAt = Date.now()
      }
    )
    return { ok: true, operationId }
  })
  handle('yan:capabilities:verification', async (value: unknown) => {
    const operationId = typeof value === 'string' ? value : ''
    pruneCapabilityVerifications()
    const operation = capabilityVerifications.get(operationId)
    if (!operation) return null
    const current = runners?.runtimeOf(operation.runnerId)
    if (operation.state === 'connecting' && (!current || current.generation !== operation.generation || runners?.agentOf(operation.runnerId) !== operation.agent)) {
      operation.state = 'stale'
      operation.updatedAt = Date.now()
    }
    return {
      operationId,
      state: operation.state,
      ...(operation.toolCount !== undefined ? { toolCount: operation.toolCount } : {})
    }
  })
  handle('yan:capabilities:cancelVerification', async (value: unknown) => {
    const operation = capabilityVerifications.get(typeof value === 'string' ? value : '')
    if (!operation || operation.state !== 'connecting') return { ok: false, error: '验证已结束或不存在' }
    const current = runners?.runtimeOf(operation.runnerId)
    if (!current || current.generation !== operation.generation || runners?.agentOf(operation.runnerId) !== operation.agent) {
      operation.state = 'stale'
      operation.updatedAt = Date.now()
      return { ok: false, error: '运行实例已切换，未对新实例执行断开操作' }
    }
    const disconnected = await operation.agent.disconnectCapabilityMcp(operation.serverId)
    operation.state = disconnected ? 'cancelled' : 'stale'
    operation.updatedAt = Date.now()
    return { ok: disconnected, ...(disconnected ? {} : { error: 'MCP 服务已不存在' }) }
  })

  handle('yan:packages:action', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      const kind = raw.kind === 'install' || raw.kind === 'remove' || raw.kind === 'update' ? raw.kind : null
      if (!kind) return { ok: false, error: '未知的操作' }
      /*
       * 这里注入 bin：它是**异步**才知道的（settings 的 piBin 覆盖项），
       * 而 resolvePi() 必须与真正启动 pi 时是同一个解析 —— 否则会出现
       * 「装到 A、跑的是 B」这种最难查的问题。
       */
      const st = await getSettings()
      configurePackageContext({
        bin: () => resolvePi(st.piBin ? { override: st.piBin } : {}).args.at(-1) ?? null,
        agentDir: () => PI_AGENT_DIR,
        hasRunningTask: (projectCwd) => runners?.hasBusyCwd(projectCwd) === true,
        isProjectTrusted: async (projectCwd) => (await trustStatus(projectCwd)).trusted
      })
      return await runPackageAction({
        kind,
        source: String(raw.source ?? ''),
        local: raw.local === true,
        cwd: String(raw.cwd ?? '')
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ---- 项目知识（实施-03 S5）---- */
  /*
   * 设置页「项目知识」页的一组通道。四条边界：
   *   ① **身份不由渲染端给**：一律按当前会话推导（同一处 `projectIdForCwd`，与 `yan knowledge` 同源），
   *      所以界面永远只能看到「当前项目」的知识；
   *   ② 「需复核」是**派生**状态（分支漂移 / 路径没了 / 来源会话被删）：
   *      文件系统与 git 由宿主查，判定交给纯函数（`shared/project-knowledge-view.ts`）；
   *   ③ 写操作全部带 `expectedRevision`（CAS）—— 界面上看到的版本变了就报错，**不静默覆盖**；
   *   ④ 「确认」是**用户动作**：只有这条路径能把条目升为 active（hostCheck.userConfirmed），
   *      模型那条（`yan knowledge propose`）不传 hostCheck，走不通。
   */
  const knowledgeIdentity = async (): Promise<{ projectId: string; cwd: string } | null> => {
    const settings = await getSettings()
    const state = ac()?.getState()
    const cwd = state?.cwd
    if (!cwd) return null
    /*
     * 与能力服务（`capability.projectId`，见 startAgent 那里）**同一个表达式**：
     * 不一致会出现最难查的一类 bug —— 模型 `yan knowledge propose` 写的条目
     * 用户在设置页看不到（反之亦然）。未登记目录用 cwd 派生的稳定 id，
     * 它仍只属于这棵树，不是跨项目共享。
     */
    const projectId = knowledgeProjectId(settings, cwd)
    return projectId ? { projectId, cwd } : null
  }

  const knowledgeQueryOf = async (cwd: string): Promise<KnowledgeViewContext> => {
    const repo = await readRepoState(cwd).catch(() => null)
    const sessions = await listSessions(500).catch(() => [])
    const ids = new Set(sessions.map((session) => session.id))
    return {
      branch: repo?.branch ?? null,
      /* 只判「在不在」，不读内容；路径先过 `isSafeRelativeRef` 挡越界（文本引用不授读取权） */
      pathExists: (rel: string) => isSafeRelativeRef(rel) && existsSync(resolve(cwd, rel)),
      sessionReadable: (id: string) => ids.has(id)
    }
  }

  const knowledgeSnapshot = async () => {
    const settings = await getSettings()
    const enabled = settings.projectKnowledge?.enabled === true
    const identity = await knowledgeIdentity()
    const empty = { all: 0, active: 0, candidate: 0, review: 0 }
    if (!identity) return { ok: true, enabled, entries: [], counts: empty }
    try {
      const views = await knowledgeQueryOf(identity.cwd).then((query) =>
        listKnowledge(identity).then((entries) => toKnowledgeViews(entries, query))
      )
      return { ok: true, projectId: identity.projectId, enabled, entries: views, counts: countKnowledge(views) }
    } catch (error) {
      return {
        ok: false,
        projectId: identity.projectId,
        enabled,
        entries: [],
        counts: empty,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  handle('yan:knowledge:list', () => knowledgeSnapshot())

  handle('yan:knowledge:action', async (req: unknown) => {
    const raw = (req ?? {}) as { action?: unknown; id?: unknown; expectedRevision?: unknown; expectedProjectId?: unknown; text?: unknown; tags?: unknown; kind?: unknown; permanent?: unknown }
    const identity = await knowledgeIdentity()
    if (!identity) return { ok: false, error: '当前会话没有绑定项目（先选一个项目工作目录）' }
    /*
     * 项目身份 CAS（R10）：界面上的列表属于某个项目，而这里按「此刻的当前会话」
     * 选项目 —— 用户在设置页开着的时候切了会话，点确认就会打到别的项目上。
     * 带了期望身份就严格校验；缺省接受（旧调用/CLI 不受影响）。
     */
    if (typeof raw.expectedProjectId === 'string' && raw.expectedProjectId && raw.expectedProjectId !== identity.projectId) {
      return { ok: false, error: '项目已切换，刷新后再改' }
    }
    const id = typeof raw.id === 'string' ? raw.id : ''
    const expectedRevision = Number(raw.expectedRevision)
    if (!id || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return { ok: false, error: '缺少条目 id 或版本号（先刷新列表）' }
    }
    const query = await knowledgeQueryOf(identity.cwd)
    try {
      if (raw.action === 'delete') {
        /* 永久删除是**另一个动作**（墓碑之外的正文也清），需要明确用户凭据 —— 不靠一个布尔切换 */
        const permanent = raw.permanent === true
        const out = await deleteKnowledge({
          identity,
          request: {
            id,
            expectedRevision,
            mode: permanent ? 'permanent' : 'logical',
            ...(permanent ? { userAction: { by: 'user' as const } } : {})
          }
        })
        if (!out.ok) return { ok: false, error: out.message, latestRevision: out.latest?.revision }
        return { ok: true, entry: toKnowledgeView(out.entry, query) }
      }
      const current = await readKnowledge(identity, id)
      if (!current) return { ok: false, error: '条目不存在（可能已被删除）' }
      /*
       * 三种写操作都是「以**磁盘上的当前版**为底稿改字段」，
       * 底稿一律重新读，不信渲染端回传的内容 —— 否则界面上的旧副本
       * 会覆盖掉别处（例如模型在会话里）刚写进去的字段。
       */
      const draft: KnowledgeCommitRequest = {
        id,
        kind: current.kind,
        text: current.text,
        tags: current.tags,
        evidence: current.evidence,
        confidenceClass: current.confidenceClass,
        ...(current.validFor ? { validFor: current.validFor } : {}),
        ...(current.supersedes?.length ? { supersedes: current.supersedes } : {}),
        expectedRevision
      }
      if (raw.action === 'update') {
        if (typeof raw.text === 'string') draft.text = raw.text
        if (Array.isArray(raw.tags)) draft.tags = raw.tags
        if (raw.kind) draft.kind = raw.kind
        if (!String(draft.text ?? '').trim()) return { ok: false, error: '正文不能为空' }
      } else if (raw.action === 'confirm') {
        /* 用户点了确认 → 就是「用户确认」这一类，而不是仍标成模型推断 */
        draft.confidenceClass = 'user-confirmed'
      } else if (raw.action === 'supersede') {
        if (typeof raw.text !== 'string' || !raw.text.trim()) return { ok: false, error: '替代需要新正文' }
        delete draft.id
        draft.expectedRevision = 0
        draft.text = raw.text
        if (Array.isArray(raw.tags)) draft.tags = raw.tags
        if (raw.kind) draft.kind = raw.kind
        draft.confidenceClass = 'user-confirmed'
        draft.supersedes = [id]
      } else {
        return { ok: false, error: '未知的操作' }
      }
      const out = await commitKnowledge({
        identity,
        request: draft,
        /* 这是「用户动作」的凭据：模型构造不出来（它那条路不传 hostCheck） */
        hostCheck: { userConfirmed: { quote: '用户在项目知识页确认' } }
      })
      if (!out.ok) return { ok: false, error: out.message, latestRevision: out.latest?.revision }
      return {
        ok: true,
        entry: toKnowledgeView(out.entry, query),
        ...(out.superseded.length ? { superseded: out.superseded.map((entry) => toKnowledgeView(entry, query)) } : {})
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:knowledge:export', async (mode: 'copy' | 'save') => {
    const identity = await knowledgeIdentity()
    if (!identity) return { ok: false, error: '当前会话没有绑定项目（先选一个项目工作目录）' }
    try {
      const settings = await getSettings()
      const views = toKnowledgeViews(await listKnowledge(identity), await knowledgeQueryOf(identity.cwd))
      const markdown = knowledgeMarkdown(views, {
        projectId: identity.projectId,
        exportedAt: new Date().toISOString(),
        enabled: settings.projectKnowledge?.enabled === true
      })
      if (mode !== 'save') return { ok: true, markdown }
      /*
       * 「保存到文件」只写用户在选择框里点的地方，**不自动改写仓库文档**
       *（§6：「导出到项目文档」必须展示目标文件与 diff，属于单独动作）。
       */
      const picked = win
        ? await dialog.showSaveDialog(win, {
            title: '导出项目知识',
            defaultPath: join(identity.cwd, 'project-knowledge.md'),
            filters: [{ name: 'Markdown', extensions: ['md'] }]
          })
        : await dialog.showSaveDialog({
            title: '导出项目知识',
            defaultPath: join(identity.cwd, 'project-knowledge.md'),
            filters: [{ name: 'Markdown', extensions: ['md'] }]
          })
      if (picked.canceled || !picked.filePath) return { ok: true, markdown, canceled: true }
      await writeFile(picked.filePath, markdown, 'utf8')
      return { ok: true, markdown, path: picked.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /*
   * 来源跳转（§6「来源跳转」）：渲染端只知道 sessionId，文件路径只有主进程知道。
   * 返回 `ok:false` 时界面显示「不可回读」——**不伪造证据**（§4）。
   */
  handle('yan:knowledge:sourceSession', async (sessionId: string) => {
    const id = String(sessionId ?? '')
    if (!id) return { ok: false, error: '缺少会话 id' }
    try {
      const sessions = await listSessions(500)
      const hit = sessions.find((session) => session.id === id)
      if (!hit) return { ok: false, error: '来源会话已被删除，无法回读' }
      return { ok: true, path: hit.path, ...(hit.title ? { title: hit.title } : {}) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:git:remotes', async (cwd: string) => {
    try {
      const repo = await resolveRepo(String(cwd ?? ''))
      return repo ? await listRemotes(repo.root) : []
    } catch {
      return []
    }
  })

  /* ---- 内置浏览器 ---- */
  rawHandle('yan:browser:getState', () => browser?.getState() ?? {
    open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false
  })
  rawHandle('yan:browser:open', async (_e, url?: string) => browser?.open(url) ?? {
    open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false
  })
  rawHandle('yan:browser:observe', async () => browser?.observe() ?? {
    generationId: '', url: '', title: '', text: '', elements: [], accessibilityNodeCount: 0, domSnapshotCaptured: false
  })
  rawHandle('yan:browser:newTab', async (_e, url?: string) => browser?.newTab(url))
  rawHandle('yan:browser:switchTab', async (_e, id: string) => browser?.switchTab(id))
  rawHandle('yan:browser:closeTab', async (_e, id?: string) => browser?.closeTab(id))
  rawHandle('yan:browser:close', async () => browser?.close())
  rawHandle('yan:browser:navigate', async (_e, url: string) => browser?.navigate(url) ?? { ok: false, error: '浏览器未初始化' })
  rawHandle('yan:browser:back', () => browser?.back() ?? { ok: false, error: '浏览器未初始化' })
  rawHandle('yan:browser:forward', () => browser?.forward() ?? { ok: false, error: '浏览器未初始化' })
  rawHandle('yan:browser:reload', () => browser?.reload() ?? { ok: false, error: '浏览器未初始化' })
  rawHandle('yan:browser:openExternal', (_e, url?: string) => browser?.openExternal(url) ?? { ok: false, error: '浏览器未初始化' })
  rawHandle('yan:browser:openExternalChrome', (_e, url?: string) =>
    browser?.openExternalChrome(url) ?? { ok: false, error: '浏览器未初始化' }
  )
  rawHandle('yan:browser:closeExternalChrome', () => browser?.closeExternalChrome())
  rawHandle('yan:browser:syncLocalProfile', () =>
    browser?.syncLocalProfile() ?? { found: false, copied: [], failed: [], chromeRunning: false, cookiesSynced: false }
  )
  rawHandle('yan:browser:syncPageStorage', () => browser?.syncPageStorage() ?? Promise.reject(new Error('浏览器未初始化')))
  rawHandle('yan:browser:setPermission', (_e, permission: string, origin: string, allowed: boolean) =>
    browser?.setPermission(String(permission ?? ''), String(origin ?? ''), Boolean(allowed)) ?? {
      ok: false,
      error: '浏览器未初始化'
    }
  )
  rawHandle('yan:browser:setUserControl', (_e, value: boolean) => browser?.setUserControl(Boolean(value)))
  rawHandle('yan:browser:setBounds', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
    browser?.setBounds(bounds)
  })
  /* 文件预览占用同一区域时，把原生视图临时藏起来（方案 5.2） */
  rawHandle('yan:browser:setVisible', (_e, visible: unknown) => {
    browser?.setViewVisible(visible !== false)
  })

  /* ---- 交互终端（实施-11 H-11） ---- */
  rawHandle('yan:terminal:available', () => ({ available: terminalAvailable(), error: terminalLoadError() ?? undefined }))
  rawHandle('yan:terminal:list', () => listTerminals())
  rawHandle('yan:terminal:start', (_e, request?: TerminalStartRequest) =>
    startTerminal({
      cwd: request?.cwd,
      /* 兜底用当前活动会话的工作目录：终端默认就开在项目里 */
      fallbackCwd: ac()?.getState()?.cwd,
      cols: request?.cols,
      rows: request?.rows
    })
  )
  rawHandle('yan:terminal:write', (_e, id: string, data: string) => writeTerminal(String(id ?? ''), String(data ?? '')))
  rawHandle('yan:terminal:resize', (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(String(id ?? ''), Number(cols), Number(rows))
  )
  rawHandle('yan:terminal:kill', (_e, id: string) => killTerminal(String(id ?? '')))
  rawHandle('yan:terminal:attach', (_e, id: string) => attachTerminal(String(id ?? '')))
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
    width: useW,
    height: useH,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0b0b0d',
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
