import type { ComponentType } from 'react'
import type { PreviewOpenOptions } from './preview-state'
import type { PanePopoutTabId } from '../../../../shared/pane-popout'

export type WorkbenchTabId = 'changes' | 'terminal' | 'files' | 'browser' | 'preview' | 'context' | 'branch' | 'logs' | 'quota' | 'device' | 'pullRequests'

export const WORKBENCH_TABS: readonly WorkbenchTabId[] = ['changes', 'terminal', 'files', 'browser', 'preview', 'context', 'branch', 'logs', 'quota', 'device', 'pullRequests']

export type WorkbenchView = WorkbenchTabId | 'overview'

export type SubagentPaneId = `subagent:${string}`

export type WorkspacePaneId = WorkbenchTabId | SubagentPaneId

export type WorkspaceView = WorkbenchView | SubagentPaneId

export const WORKBENCH_ACTIVE_TABS: ReadonlySet<string> = new Set<string>(['terminal', 'browser'])

export type WorkbenchPopoutTabId = PanePopoutTabId

export interface WorkspaceOwner {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  readonly active: boolean
}

export interface FilesPaneProps {
  owner: WorkspaceOwner
  onPreview?: (path: string, options?: PreviewOpenOptions) => void
  path?: string
  Preview?: ComponentType<PreviewPaneProps>
}

export interface TerminalPaneProps {
  owner: WorkspaceOwner
  visible?: boolean
}

export interface BrowserPaneProps {
  owner: WorkspaceOwner
  visible?: boolean
}

export interface ChangesPaneProps {
  owner: WorkspaceOwner
}

export interface PreviewPaneProps {
  owner: WorkspaceOwner
  path?: string
  treeShown?: boolean
  onRevealInTree?: (abs: string) => void
}

export interface ContextPaneProps {
  owner: WorkspaceOwner
  visible?: boolean
}

export interface BranchPaneProps {
  owner: WorkspaceOwner
}

export interface LogsPaneProps {
  owner: WorkspaceOwner
}

export interface QuotaPaneProps {
  owner: WorkspaceOwner
}

export interface PullRequestsPaneProps {
  owner: WorkspaceOwner
}

export interface DevicePaneProps {
  owner: WorkspaceOwner
  visible?: boolean
}

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
  device?: ComponentType<DevicePaneProps>
  pullRequests?: ComponentType<PullRequestsPaneProps>
}
