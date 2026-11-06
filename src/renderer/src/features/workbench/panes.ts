import { createElement, lazy, Suspense, type JSX } from 'react'
import { FilesPane } from '../files/FilesPane'
import { BrowserPane } from '../browser/BrowserPane'
import { ChangesPane } from '../changes/ChangesPane'
import { ContextPane } from './ContextPane'
import { BranchPane } from './BranchPane'
import { LogsPane } from './LogsPane'
import { QuotaPane } from './QuotaPane'
import { DevicePane } from '../device/DevicePane'
import { PullRequestsPane } from '../github/PullRequestsPane'
import type { PreviewPaneProps, TerminalPaneProps, WorkbenchPaneComponents } from './types'

const loadTerminalPane = (): Promise<typeof import('../terminal/TerminalPane')> => import('../terminal/TerminalPane')
const loadPreviewPane = (): Promise<typeof import('../preview/PreviewPane')> => import('../preview/PreviewPane')
const LazyTerminalPane = lazy(() => loadTerminalPane().then((mod) => ({ default: mod.TerminalPane })))
const LazyPreviewPane = lazy(() => loadPreviewPane().then((mod) => ({ default: mod.PreviewPane })))

const PRELOAD_DELAY_MS = 2500

if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    void loadTerminalPane().catch(() => undefined)
    void loadPreviewPane().catch(() => undefined)
  }, PRELOAD_DELAY_MS)
}

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
  device: DevicePane,
  pullRequests: PullRequestsPane
}
