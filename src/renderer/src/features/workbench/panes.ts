import { createElement, lazy, Suspense, type JSX } from 'react'
import { FilesPane } from '../files/FilesPane'
import { BrowserPane } from '../browser/BrowserPane'
import { ChangesPane } from '../changes/ChangesPane'
import { PreviewPane } from '../preview/PreviewPane'
import { ContextPane } from './ContextPane'
import { BranchPane } from './BranchPane'
import { LogsPane } from './LogsPane'
import { QuotaPane } from './QuotaPane'
import type { TerminalPaneProps, WorkbenchPaneComponents } from './types'

const LazyTerminalPane = lazy(() => import('../terminal/TerminalPane').then((mod) => ({ default: mod.TerminalPane })))

function TerminalPane(props: TerminalPaneProps): JSX.Element {
  return createElement(Suspense, { fallback: null }, createElement(LazyTerminalPane, props))
}

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
