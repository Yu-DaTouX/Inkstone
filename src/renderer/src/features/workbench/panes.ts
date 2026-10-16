/**
 * 叶子面板注册表。
 *
 * R0 只负责把 R1–R5 的导出按契约装进来；本文件是工作区与其它组唯一的静态接线点。
 * 叶子尚未落地时，这些 import 会解析失败 —— 这是预期的「缺依赖」边界，由父会话
 * 在 R1–R5 就位后统一集成，不在 R0 里造 stub 冒充可用资源。
 *
 * 契约导出（见同目录 `types.ts`）：
 *   features/files/FilesPane        → FilesPane({ owner, onPreview? })
 *   features/terminal/TerminalPane  → TerminalPane({ owner, visible? })
 *   features/browser/BrowserPane    → BrowserPane({ owner, visible? })
 *   features/changes/ChangesPane    → ChangesPane({ owner })
 *   features/preview/PreviewPane    → PreviewPane({ owner, path? })
 *   features/workbench/ContextPane  → ContextPane({ owner })
 *   features/workbench/BranchPane   → BranchPane({ owner })
 */
import { FilesPane } from '../files/FilesPane'
import { TerminalPane } from '../terminal/TerminalPane'
import { BrowserPane } from '../browser/BrowserPane'
import { ChangesPane } from '../changes/ChangesPane'
import { PreviewPane } from '../preview/PreviewPane'
import { ContextPane } from './ContextPane'
import { BranchPane } from './BranchPane'
import { LogsPane } from './LogsPane'
import { QuotaPane } from './QuotaPane'
import type { WorkbenchPaneComponents } from './types'

export const WORKBENCH_PANES: WorkbenchPaneComponents = {
  changes: ChangesPane,
  terminal: TerminalPane,
  files: FilesPane,
  browser: BrowserPane,
  preview: PreviewPane,
  context: ContextPane,
  branch: BranchPane,
  logs: LogsPane,
  quota: QuotaPane
}
