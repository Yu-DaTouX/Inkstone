/**
 * P3 右侧工作区的共享契约（R0 唯一真源）。
 *
 * 这是各叶子面板（改动 / 终端 / 文件 / 浏览器 / 预览 / 上下文 / 分支）与宿主外壳之间的唯一接口面。
 * 叶子目录只读这里的类型，**不修改本文件**；确需扩展 props 时由父会话统一接线。
 *
 * 归属规则（`WorkspaceOwner`）：
 *   · `key` 来自既有的 `workspaceKeyFor` / `workbenchSessionKey`，不是可绕权的授权：
 *     它只表达「这块资源挂在哪条会话旁边」，真正的权限边界仍在主进程与宿主授权。
 *   · `active=false` 表示「正在查看、但还没在 pi 侧激活」。此时叶子里**不得**新建或执行
 *     PTY、导航原生浏览器；只读文件按正式宿主授权边界办理。面板对这类页签只显示
 *     「先激活」的提示。
 *   · owner 由**正式当前视图 + 运行实例/会话摘要**推导（见 `ownership.ts`），
 *     不从旧会话投影盲取 cwd，也不拿别的会话的 runtime 给当前视图执行。
 */
import type { ComponentType } from 'react'
import type { PanePopoutTabId } from '../../../../shared/pane-popout'

/** 面板的固定页签；顺序即展示顺序。 */
export type WorkbenchTabId = 'changes' | 'terminal' | 'files' | 'browser' | 'preview' | 'context' | 'branch' | 'logs' | 'quota'

export const WORKBENCH_TABS: readonly WorkbenchTabId[] = ['changes', 'terminal', 'files', 'browser', 'preview', 'context', 'branch', 'logs', 'quota']

/**
 * 面板的视图：概览（磁贴列）或某个工具页签。头部与持久化偏好记的是视图；
 * 磁贴的「›」与头部工具图标都只是切换到对应视图。
 */
export type WorkbenchView = WorkbenchTabId | 'overview'

/** 需要「会话已在 pi 侧激活」才能动手的页签：终端与原生浏览器。按字符串判断，便于直接传入视图值。 */
export const WORKBENCH_ACTIVE_TABS: ReadonlySet<string> = new Set<string>(['terminal', 'browser'])

/**
 * 本批可弹出独立窗口的 DOM-only 页签；真源在 `shared/pane-popout.ts` 的
 * `PANE_TRANSFER_MATRIX`，这里只做类型别名，不再维护第二份支持判断。
 */
export type WorkbenchPopoutTabId = PanePopoutTabId

/**
 * 工作区资源归属。
 *
 * 与主进程 / 宿主正式协议对齐后由外壳生成，传给每一个叶子。
 */
export interface WorkspaceOwner {
  /** 稳定会话键（`workbenchSessionKey` 形态）；同一条会话在单会话与分屏里是同一把。 */
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  /** 正式 cwd：优先取当前视图对应运行实例，其次待激活目标，最后会话摘要；不盲取旧投影。 */
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  /** 当前视图是否已在 pi 侧激活；false 时叶子不得新建/执行 PTY 或浏览器操作。 */
  readonly active: boolean
}

/* ── 叶子面板的 props 契约（R1–R5 按此实现导出） ─────────────────── */

/** R1 `features/files` */
export interface FilesPaneProps {
  owner: WorkspaceOwner
  onPreview?: (path: string) => void
}

/** R2 `features/terminal`：`visible=false` 只是隐藏，不杀 PTY。 */
export interface TerminalPaneProps {
  owner: WorkspaceOwner
  visible?: boolean
}

/** R3 `features/browser`：`visible=false` 只是隐藏原生视图，不改导航。 */
export interface BrowserPaneProps {
  owner: WorkspaceOwner
  visible?: boolean
}

/** R4 `features/changes`：首版只读。 */
export interface ChangesPaneProps {
  owner: WorkspaceOwner
}

/** R5 `features/preview`：离线 HTML 预览协议与 CSP 不变。 */
export interface PreviewPaneProps {
  owner: WorkspaceOwner
  path?: string
}

/** 上下文页签：只读展示当前会话用量与构成，不新建资源、不需要激活。 */
export interface ContextPaneProps {
  owner: WorkspaceOwner
}

/** 分支页签：只投影并切换 pi 原生会话树；不新建资源、不需要激活。 */
export interface BranchPaneProps {
  owner: WorkspaceOwner
}

/** 日志页签：只读投影扩展状态与 pi 日志尾部，不新建资源、不需要激活。 */
export interface LogsPaneProps {
  owner: WorkspaceOwner
}

/** 额度页签：只读投影服务商账号额度窗口（不是本机 Token 用量），不需要激活。 */
export interface QuotaPaneProps {
  owner: WorkspaceOwner
}

/**
 * 叶子组件注册表。
 *
 * 由外壳把各叶子的导组装起来后注入面板；叶子尚未就位时对应项缺省，
 * 面板显示「未接入」而不是伪造一个可用的假资源。
 */
export interface WorkbenchPaneComponents {
  changes?: ComponentType<ChangesPaneProps>
  terminal?: ComponentType<TerminalPaneProps>
  files?: ComponentType<FilesPaneProps>
  browser?: ComponentType<BrowserPaneProps>
  preview?: ComponentType<PreviewPaneProps>
  context?: ComponentType<ContextPaneProps>
  branch?: ComponentType<BranchPaneProps>
  logs?: ComponentType<LogsPaneProps>
  quota?: ComponentType<QuotaPaneProps>
}
