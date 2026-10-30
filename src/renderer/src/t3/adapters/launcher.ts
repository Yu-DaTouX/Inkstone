import { createElement, useCallback, useMemo } from 'react'
import type { LauncherAction } from '../components/right-panel/model'
import { usePanelTexts, LAUNCHER, PANEL_TOOL_ICONS, type LauncherEntry } from '../../features/workbench/use-panel-actions'
import type { WorkspaceOwner } from '../../features/workbench/types'
import type { PanelToolKind } from '../../state/right-panel'
import { usePanelAvailability, type AvailabilityMap, type PanelUnavailableReason } from './availability'

export interface LauncherActionInput {
  entries: readonly LauncherEntry[]
  availability: AvailabilityMap
  label: (kind: PanelToolKind) => string
  reason: (reason: PanelUnavailableReason) => string
  onPick: (kind: PanelToolKind) => void
}

export function launcherActions(input: LauncherActionInput): LauncherAction[] {
  return input.entries.map((entry) => {
    const state = input.availability[entry.kind]
    return {
      kind: entry.kind,
      label: input.label(entry.kind),
      shortcut: entry.shortcut,
      icon: createElement(PANEL_TOOL_ICONS[entry.kind], { size: 16, 'aria-hidden': true }),
      available: state.available,
      disabledReason: state.reason ? input.reason(state.reason) : undefined,
      onPick: () => input.onPick(entry.kind)
    }
  })
}

export function useLauncherActions(owner: WorkspaceOwner | null, onPick: (kind: PanelToolKind) => void): LauncherAction[] {
  const texts = usePanelTexts()
  const availability = usePanelAvailability(owner)
  const label = useCallback((kind: PanelToolKind) => texts.workbench.tabs[kind], [texts])
  const reason = useCallback((code: PanelUnavailableReason) => texts.panel.unavailable[code], [texts])
  return useMemo(() => launcherActions({ entries: LAUNCHER, availability, label, reason, onPick }), [availability, label, reason, onPick])
}

export interface PanelShortcutEvent {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
}

export function launcherActionForKey(actions: readonly LauncherAction[], event: PanelShortcutEvent): LauncherAction | null {
  if (event.defaultPrevented || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  const key = event.key.toLowerCase()
  return actions.find((action) => action.available && action.shortcut.toLowerCase() === key) ?? null
}

export function launcherShortcutTargetsTyping(target: { closest(selectors: string): unknown } | null): boolean {
  return target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') != null
}

export const LAUNCHER_BLOCKING_LAYER_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"],[role="alertdialog"]'
