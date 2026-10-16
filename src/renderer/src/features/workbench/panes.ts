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
