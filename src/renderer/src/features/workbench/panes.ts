import { createElement, lazy, Suspense, type JSX } from 'react'
import { FilesPane } from '../files/FilesPane'
import { BrowserPane } from '../browser/BrowserPane'
import { ChangesPane } from '../changes/ChangesPane'
import { ContextPane } from './ContextPane'
import { BranchPane } from './BranchPane'
import { LogsPane } from './LogsPane'
import { QuotaPane } from './QuotaPane'
import { DevicePane } from '../device/DevicePane'
import type { PreviewPaneProps, TerminalPaneProps, WorkbenchPaneComponents } from './types'

const LazyTerminalPane = lazy(() => import('../terminal/TerminalPane').then((mod) => ({ default: mod.TerminalPane })))
const LazyPreviewPane = lazy(() => import('../preview/PreviewPane').then((mod) => ({ default: mod.PreviewPane })))

function TerminalPane(props: TerminalPaneProps): JSX.Element {
  return createElement(Suspense, { fallback: null }, createElement(LazyTerminalPane, props))
}

function PreviewPane(props: PreviewPaneProps): JSX.Element {
  return createElement(Suspense, { fallback: null }, createElement(LazyPreviewPane, props))
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
  quota: QuotaPane,
  device: DevicePane
}
