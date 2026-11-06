import { createElement, Suspense, type JSX } from 'react'
import { preloadable } from '../../lib/preloadable'
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

const terminalPane = preloadable<TerminalPaneProps>(() => import('../terminal/TerminalPane').then((mod) => ({ default: mod.TerminalPane })))
const previewPane = preloadable<PreviewPaneProps>(() => import('../preview/PreviewPane').then((mod) => ({ default: mod.PreviewPane })))
const LazyTerminalPane = terminalPane.Component
const LazyPreviewPane = previewPane.Component

export const preloadTerminalPane = terminalPane.preload
export const preloadPreviewPane = previewPane.preload

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
