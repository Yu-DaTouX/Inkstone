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
