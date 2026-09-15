/**
 * 主进程入口：窗口 + IPC + AgentController 的生命周期。
 *
 * 一个窗口可以承载多个按 cwd/session 隔离的 AgentController；
 * 会话切换优先复用已有实例或空闲实例，不停止仍在工作的后台会话。
 */
import { app, shell, BrowserWindow, ipcMain, dialog, screen, Menu, Notification, Tray, nativeImage } from 'electron'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentController } from './agent'
import { RunnerRegistry } from './runners'
import { cachedTitles, generateTitle, manualTitles, setManualTitle } from './title'
import { getSettings, patchSettings } from './settings'
import { listSessions, deleteSession, readTitleSamples, restoreSession } from './sessions'
import { moveSessionLayout, rememberSession } from './session-layout'
import { readSessionMessages } from './session-reader'
import { authFileInfo, clearAuth, completePath, listAuthProviders, setApiKey } from './credentials'
import { cancelCodexLogin, startCodexLogin } from './oauth'
import { listDir, searchFiles } from './files'
import { grantFiles, readGrantedText, readPreview } from './file-refs'
import { SubagentController } from './subagents'
import { compactionInfo } from './compaction'
import { providerQuota } from './quota'
import { resolvePi, piInfo, resetPiVersionCache } from './protocol'
import { applyZoom, clampScale, peekUiScale, stepScale, zoomState } from './zoom'
import { BrowserController } from './browser'
import { localCommandDescriptors } from './command-registry'
import { writeExitSnapshot } from './exit-snapshot'
import { ELECTRON_CRASH_DUMPS_DIR, ELECTRON_USER_DATA_DIR } from './paths'
import type {
  Attachment,
  AttentionNotify,
  FileRequestContext,
  FileSearchRequest,
  MainPush
} from '../shared/ipc'

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

/*
 * Electron 的开发进程经常由 npm / IDE 通过 pipe 启动。启动器退出、重启
 * 或关闭终端后，Node 的 stdout/stderr 仍可能收到 console.error；Windows
 * 会把这次写入报成 EPIPE，并把它升级成“主进程 JavaScript 错误”对话框。
 * 日志管道断开不应该让桌面应用崩溃，真正的异常仍会按原路径处理。
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}

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
 * 同一个 userData 只能有一个桌面窗口。
 * 没有单实例锁时，重复执行 launch / dev 会创建多个 BrowserWindow；每个
 * 窗口都带自己的原生 WebContentsView，用户看到的就可能是不同进程的
 * toolbar、页面层和旧坐标叠在一起。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
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
  action: 'cancelled' | 'save-and-exit' | 'interrupt-exit'
}> | null = null
/**
 * 会话运行实例注册表（N12）。
 *
 * 一个**运行中**的会话 = 一个 pi 子进程（AgentController 实例）。
 * 切换会话不再复用同一个进程，所以「切走」不会把后台任务停掉。
 */
let runners: RunnerRegistry | null = null
let browser: BrowserController | null = null
let subagents: SubagentController | null = null
/** 当前主窗口的全项目文件名搜索；新请求可取消旧请求，退出时自然随进程释放。 */
const activeFileSearches = new Map<string, AbortController>()

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

function browserExtensionPath(): string | undefined {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'pi-extensions', 'browser.js') : '',
    join(__dirname_, '..', '..', 'resources', 'pi-extensions', 'browser.js'),
    join(process.cwd(), 'resources', 'pi-extensions', 'browser.js')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

/**
 * 内置「提问」扩展的路径。
 * 让模型在信息不足时主动问用户；自主模式打开时改为自行决策。
 * 与 browser.js 同一套查找顺序（打包后 / 开发期）。
 */
function questionExtensionPath(): string | undefined {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'pi-extensions', 'question.js') : '',
    join(__dirname_, '..', '..', 'resources', 'pi-extensions', 'question.js'),
    join(process.cwd(), 'resources', 'pi-extensions', 'question.js')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

/**
 * 内置「回复详细程度」扩展的路径（方案 3.1）。
 * 它在 before_agent_start 里按档位注入系统提示；standard 档不注入。
 */
function responseDetailExtensionPath(): string | undefined {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'pi-extensions', 'response-detail.js') : '',
    join(__dirname_, '..', '..', 'resources', 'pi-extensions', 'response-detail.js'),
    join(process.cwd(), 'resources', 'pi-extensions', 'response-detail.js')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

function push(msg: MainPush): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('yan:push', msg)
}

/**
 * 给某个实例的事件标上身份（N12）。
 *
 * 渲染端靠 `sessionKey` 判断：这条输出是「我在看的这个会话」的，
 * 还是后台另一个会话的 —— 后者不得写进当前视图。
 */
function pushFrom(runnerId: string, msg: MainPush): void {
  const runtime = runners?.runtimeOf(runnerId)
  push({
    ...msg,
    ...(runtime ? { runtime } : {}),
    /* 旧探针仍读取这个字段；新代码以 runtime.runId 为准。 */
    sessionKey: runnerId
  })
  if (msg.ch === 'state' || msg.ch === 'proc') refreshTrayMenu()
}

/** 把所有运行实例的状态推给渲染端（左栏状态槽） */
function pushRunners(): void {
  push({ ch: 'runners', payload: runners?.statuses() ?? [] })
  refreshTrayMenu()
}

/**
 * 切完视图后把目标实例的现状推给渲染端（N12）。
 *
 * 为什么必须做：渲染端对**非当前实例**的事件是直接丢弃的，切过去之后
 * 必须有一份完整快照（状态 + 消息 + 统计）作为新视图的起点。
 */
async function pushRunnerSnapshot(id: string): Promise<void> {
  const ag = runners?.agentOf(id)
  if (!ag) return
  const st = ag.getState()
  if (st) pushFrom(id, { ch: 'state', payload: st })
  try {
    pushFrom(id, { ch: 'sync', payload: await ag.getMessages() })
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
}

type ExitChoice = 'cancel' | 'save' | 'interrupt'
type ExitResult = { action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' }

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

/** 真正退出应用；关闭按钮不进入这里，只负责隐藏到托盘。 */
function requestExit(): Promise<ExitResult> {
  if (isQuitting) return Promise.resolve({ action: 'interrupt-exit' })
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
/**
 * 系统提示里的语言约束。
 *
 * 用户反馈：模型的**推理内容**仍是英语，没有跟随界面语言。
 * pi 默认不限定语言（模型按用户消息自己选），要它跟着界面走
 * 只能在系统提示里明确要求 —— 这里把界面语言翻成一句指令，
 * 通过 `--append-system-prompt` 追加到 pi 系统提示末尾。
 */
function languageSystemPrompt(lang: string): string {
  return lang === 'zh-CN'
    ? '推理（思考过程）与回复一律使用简体中文，即使用户用其他语言提问也不要切换。'
    : 'Think (reason) and reply in English, even if the user writes in another language.'
}

function projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return settings.projects.find((project) => normalize(project.cwd) === normalize(cwd))?.id
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
      return { ok: false, context: { ...provisional, cwd: checked.cwd }, error: '项目与工作目录不匹配' }
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
 * 启动 pi 的**单飞**（single-flight）锁。
 *
 * 为什么需要：应用启动（app.whenReady）与「界面语言变了要重启」都会调
 * startAgent；两者可能交叠 —— 后一个会把 agent 换成新实例，而前一个的开始
 * 流程还在跑，等它超时后会拿一个已经作废的实例去 setConn('error')，
 * 把新实例的 ready 覆盖掉（旧连接状态推给了同一个界面）。
 * 串行化后同一时刻只会有一个启动流程，旧实例不会再反过来污染状态。
 */
let starting: Promise<{ ok: boolean; error?: string }> | null = null
/**
 * 一个 pi 进程的系统提示在启动时固定。语言切换不重启现有 runner：
 * 它们继续完成当前任务；之后创建的新 runner 使用这个最新值。
 */
let agentLanguage: string | undefined
/** 当前设置的回复详细程度；每个 Agent 回合自己在 agent_start 时取快照。 */
let agentResponseDetail: 'brief' | 'standard' | 'detailed' = 'standard'

function startAgent(): Promise<{ ok: boolean; error?: string }> {
  if (starting) return starting
  starting = doStartAgent().finally(() => {
    starting = null
  })
  return starting
}

async function doStartAgent(): Promise<{ ok: boolean; error?: string }> {
  if (runners?.active()?.running) return { ok: true }
  /* 重新建立主 runner 集合时，所有新进程都读取当前设置。 */
  await runners?.stopAll()
  await subagents?.stopAll()

  const settings = await getSettings()
  agentLanguage = settings.lang
  agentResponseDetail = settings.responseDetail

  runners = new RunnerRegistry({
    /* 每个实例自己一个 pi 子进程；事件带上实例 id（N12） */
    createAgent: (id, cwd) =>
      new AgentController({
        push: (m) => pushFrom(id, m),
        cwd,
        piBin: settings.piBin,
        browserExtension: browserExtensionPath(),
        questionExtension: questionExtensionPath(),
        responseDetailExtension: responseDetailExtensionPath(),
        getResponseDetail: () => agentResponseDetail,
        browserEnv: browser?.bridgeEnv(),
        appendSystemPrompt: languageSystemPrompt(agentLanguage ?? settings.lang)
      }),
    onChanged: () => pushRunners()
  })

  const projectId = projectIdForCwd(settings, settings.cwd)
  const res = await runners.startPrimary(settings.cwd, undefined, projectId)
  await rememberRunnerSession(res, { cwd: settings.cwd, projectId, scope: 'project' })
  pushRunners()
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/**
 * 重启 pi 子进程，并把当前会话接回来（不丢历史）。
 *
 * 触发场景：应用内登录 ChatGPT（pi 只在**启动时**读 auth.json，长跑的进程
 * 不会因为文件变了就重读）。语言切换不走这条路径，因为它不应为刷新提示
 * 重建或中断其它会话；新 runner 会从 `agentLanguage` 读取最新语言。
 *
 * ⚠️ 一定要等**这一轮跑完**再重启：跑的时候重启会直接掐断正在生成的内容。
 *    所以忙的时候每隔一会儿再试，直到空闲（最多等 ~5 分钟）。
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
    const res = await startAgent()
    if (res.ok && file) await ac()?.switchSession(file)
  } catch (error) {
    reportMainError(reason, error)
  } finally {
    agentRestarting = false
  }
}

/* IPC */
function registerIpc(): void {
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

  handle('yan:send', async (text: string, images?: { data: string; mimeType: string }[]) => {
    if (!ac()?.running) {
      const r = await startAgent()
      if (!r.ok) return r
    }
    return ac()!.send(text, images)
  })

  handle('yan:steer', async (text: string) => ac()?.steer(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:followUp', async (text: string) => ac()?.followUp(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:steerQueued', async (queueId: string) => ac()?.steerQueued(queueId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:removeQueued', async (queueId: string) => ac()?.removeQueued(queueId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:abort', async () => {
    // 把 clear_queue 拿回来的排队文本一并返回，客户端应放回输入框
    const cleared = (await ac()?.abort()) ?? { steering: [], followUp: [] }
    return cleared
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
      /* 删之前先把跑在它上面的实例停掉（N12：作用域只到这一个会话） */
      await runners?.stopBySessionFile(path)
      const undoToken = await deleteSession(path, ac()?.getState()?.sessionFile)
      pushRunners()
      return { ok: true, undoToken }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('yan:restoreSession', async (undoToken: string) => {
    try {
      await restoreSession(undoToken)
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
  handle('yan:setManualTitle', async (sessionId: string, name: string) => {
    await setManualTitle(String(sessionId ?? ''), String(name ?? ''))
    return { ok: true }
  })
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
    return listSessions(200, settings.projects)
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
    return readSessionMessages(path)
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
     * 语言提示在 pi 启动时固定。只更新新建实例的工厂值，已有 runner
     * 继续完成自己的回合；这样不会为了设置变化中断后台会话。
     */
    if (typeof patch.lang === 'string' && patch.lang !== before.lang) {
      agentLanguage = next.lang
      trayLanguage = next.lang
      refreshTrayMenu()
      push({
        ch: 'log',
        payload: {
          text: `[语言] 已切换为 ${next.lang}；现有会话不中断，新建运行实例将使用新语言提示。`
        }
      })
    }
    if (patch.responseDetail !== undefined) agentResponseDetail = next.responseDetail
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
    if (p && existsSync(dirname(p))) await shell.openPath(dirname(p))
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
  handle('yan:readPreview', async (p: string, line?: number, requestedCwd?: string) => {
    const s = await getSettings()
    const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    return readPreview(String(p ?? ''), cwd, typeof line === 'number' ? line : undefined)
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
  rawHandle('yan:providerQuota', (_e, provider: unknown, budget: unknown) => providerQuota(String(provider ?? ''), Number(budget) || undefined))

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
   */
  win.once('ready-to-show', () => {
    if (process.env.YAN_PROBE) win?.showInactive()
    else win?.show()
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
                // 等探针脚本挂好监听器
                await new Promise((r) => setTimeout(r, 1800))
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
  await browser.startBridge()
  registerIpc()
  await createTray()
  createWindow()

  // 窗口就绪后自动连 pi，用户不用先点「连接」
  const started = await startAgent()

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
