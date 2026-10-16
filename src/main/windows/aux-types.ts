/**
 * 辅助小窗（WP-25d / WP-12）的类型契约。
 *
 * 主进程的窗口工厂、控制器、IPC 与渲染端 aux 入口都从这里取同一套形状；
 * 本文件不 import Electron，也不 import 主进程入口，保证主进程与渲染端的
 * 类型边界清晰，且能被单测直接编译。
 */

/** 与 i18n 的 `Lang` 同形；辅助小窗只需要这两个字面量，不引入 i18n 运行时。 */
export type AuxLocale = 'zh-CN' | 'en-US'

/** 快速提问的发送目标：新会话 / 当前会话。 */
export type AuxTarget = 'new' | 'current'

/** 迷你小窗条目的状态键；文案由渲染端按语言翻译。 */
export type MiniStatusKey = 'needs-you' | 'stalled' | 'failed' | 'done' | 'queued' | 'running'

export interface AuxProjectOption {
  id: string
  name: string
  path: string
}

export interface AuxModelOption {
  /** 下拉选择键：`provider::id`，仅用于 UI 选中态。 */
  key: string
  id: string
  label: string
  provider: string
}

/** 打开会话 / 定位主窗口时使用的最小会话引用（与 `TraySelectTarget` 同形）。 */
export interface AuxSessionRef {
  sessionId?: string
  sessionPath?: string
  projectId?: string
  cwd?: string
  title?: string
}

export interface QuickAskStateView {
  locale: AuxLocale
  projects: AuxProjectOption[]
  models: AuxModelOption[]
  currentSession: AuxSessionRef | null
  defaultTarget: AuxTarget
  defaultProjectId: string | null
  defaultModelId: string | null
  /** 全局快捷键的显示串（例如 `Alt+Shift+Space`）；空串表示未注册。 */
  accelerator: string
}

export interface QuickAskSubmit {
  prompt: string
  target: AuxTarget
  projectId?: string | null
  /** 选择的模型；null / 缺省 = 沿用会话默认。 */
  model?: { provider: string; id: string } | null
  /** 发送后把结果在主窗口展开（Ctrl/Cmd+Enter）。 */
  expand?: boolean
}

export type QuickAskErrorCode =
  | 'empty'
  | 'no-current'
  | 'start-failed'
  | 'create-failed'
  | 'model-failed'
  | 'send-failed'
  | 'unavailable'

export interface QuickAskResult {
  ok: boolean
  /** 稳定错误码，渲染端负责翻译；`message` 只是宿主细节。 */
  code?: QuickAskErrorCode
  message?: string
  sessionId?: string
  sessionPath?: string
  runId?: string
}

export interface MiniItem {
  runId: string
  code: string
  title: string
  statusKey: MiniStatusKey
  /** 进入当前阶段的时间（毫秒），用于排序与“用时”。 */
  since: number
  /** 完成 / 失败但用户还没看过。 */
  unread: boolean
  sessionId: string
  sessionPath?: string
  projectId?: string
}

export interface MiniStateView {
  locale: AuxLocale
  enabled: boolean
  items: MiniItem[]
}

/** 主进程通过 `yan:aux:push` 发给辅助窗的推送。 */
export type AuxPush = { ch: 'quick-ask' | 'mini'; payload: unknown }
