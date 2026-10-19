import type { ComponentType } from 'react'
import type { PanePopoutTabId } from '../../../../shared/pane-popout'

export type WorkbenchTabId = 'changes' | 'terminal' | 'files' | 'browser' | 'preview' | 'context' | 'branch' | 'logs' | 'quota'

export const WORKBENCH_TABS: readonly WorkbenchTabId[] = ['changes', 'terminal', 'files', 'browser', 'preview', 'context', 'branch', 'logs', 'quota']

export type WorkbenchView = WorkbenchTabId | 'overview'

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
  onPreview?: (path: string) => void
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
