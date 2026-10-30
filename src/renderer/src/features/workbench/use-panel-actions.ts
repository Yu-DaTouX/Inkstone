import { useMemo } from 'react'
import { FileDiff, FolderOpen, Gauge, GitBranch, GitPullRequest, Globe, ScrollText, Smartphone, SquareStack, Terminal, type LucideIcon } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { PanelToolKind } from '../../state/right-panel'
import { rightPanelText, type RightPanelText } from './right-panel-text'
import { workbenchText, type WorkbenchText } from './workbench-text'

export interface LauncherEntry {
  kind: PanelToolKind
  shortcut: string
}

export const LAUNCHER: readonly LauncherEntry[] = [
  { kind: 'browser', shortcut: 'B' },
  { kind: 'terminal', shortcut: 'T' },
  { kind: 'files', shortcut: 'F' },
  { kind: 'changes', shortcut: 'D' },
  { kind: 'pullRequests', shortcut: 'P' },
  { kind: 'device', shortcut: 'M' },
  { kind: 'context', shortcut: 'C' },
  { kind: 'branch', shortcut: 'G' },
  { kind: 'logs', shortcut: 'L' },
  { kind: 'quota', shortcut: 'Q' }
]

export const PANEL_TOOL_ICONS: Record<PanelToolKind, LucideIcon> = {
  changes: FileDiff,
  terminal: Terminal,
  files: FolderOpen,
  browser: Globe,
  context: SquareStack,
  branch: GitBranch,
  logs: ScrollText,
  quota: Gauge,
  device: Smartphone,
  pullRequests: GitPullRequest
}

export function panelToolLabel(kind: PanelToolKind, text: WorkbenchText): string {
  return text.tabs[kind]
}

export function launcherEntryForEvent(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): LauncherEntry | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const key = event.key.toLowerCase()
  return LAUNCHER.find((entry) => entry.shortcut.toLowerCase() === key) ?? null
}

export function usePanelTexts(): { workbench: WorkbenchText; panel: RightPanelText } {
  const { lang } = useI18n()
  return useMemo(() => ({ workbench: workbenchText(lang), panel: rightPanelText(lang) }), [lang])
}
