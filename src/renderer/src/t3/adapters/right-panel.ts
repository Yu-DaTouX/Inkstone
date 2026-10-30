import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import type { LauncherAction, PanelMode, T3Surface } from '../components/right-panel/model'
import { shortcutKeysText, shortcutOverridesFromSettings } from '../../app/shortcuts'
import type { WorkspaceOwner } from '../../features/workbench/types'
import { panelToolLabel, usePanelTexts } from '../../features/workbench/use-panel-actions'
import { subagentPaneName } from '../../features/session/SubagentTranscriptPane'
import { useTerminalTabTitle } from '../../state/terminal-tabs'
import { clampPanelWidth, currentPanelEntry, useRightPanel, useRightPanelEntry, type PanelToolKind, type RightPanelSurface } from '../../state/right-panel'
import { reopenLastClosed } from '../../state/right-panel-reopen'
import { useStore } from '../../state/store'
import { useLauncherActions } from './launcher'
import { blockedKindsOf, t3SurfaceOf, type SurfaceLabelContext } from './surfaces'

export interface PanelMenuItem {
  id: string
  label: string
  disabled?: boolean
  onSelect: () => void
}

export interface PanelMenu {
  id: string
  anchor: HTMLElement | null
  items: readonly PanelMenuItem[]
}

export type PanelShortcutCommand = 'newPanel' | 'reopenPanel'

export interface PanelShortcutText {
  closePane: string
  maximize: string
  newPanel: string
  reopenPanel: string
  closeTab: (label: string) => string
}

export interface RightPanelAdapterProps {
  mode: PanelMode
  open: boolean
  maximized: boolean
  room: number
  width: number
  tabs: readonly T3Surface[]
  activeId: string | null
  actions: LauncherAction[]
  blockedIds: readonly string[]
  shortcuts: PanelShortcutText
  menu: PanelMenu | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onCloseAll: () => void
  onMove: (id: string, toIndex: number) => void
  onPick: (action: LauncherAction) => void
  onContextMenu: (id: string, anchor: HTMLElement | null) => void
  onCloseMenu: () => void
  onCopyPath: (id: string) => void
  onReopenLast: () => void
  onWidth: (width: number) => void
  onToggleMaximized: () => void
  onHide: () => void
}

export interface RightPanelAdapterInput {
  owner: WorkspaceOwner | null
  mode: PanelMode
  room: number
  onPick: (kind: PanelToolKind) => void
  shortcutText?: Partial<Record<PanelShortcutCommand, string>>
}

interface PanelMenuState {
  menu: PanelMenu | null
  open: (menu: PanelMenu) => void
  close: () => void
}

const usePanelMenuStore = create<PanelMenuState>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set((state) => (state.menu ? { menu: null } : state))
}))

export function usePanelMenu(): PanelMenu | null {
  return usePanelMenuStore((state) => state.menu)
}

export function closePanelMenu(): void {
  usePanelMenuStore.getState().close()
}

function withKeys(label: string, keys: string): string {
  return keys ? `${label} · ${keys}` : label
}

function copyPathOf(surface: RightPanelSurface, done: string): void {
  if (surface.kind !== 'file') return
  void navigator.clipboard.writeText(surface.path).then(
    () => useStore.getState().notify('info', done),
    () => undefined
  )
}

export function useSurfaceLabelContext(owner: WorkspaceOwner | null): SurfaceLabelContext {
  const texts = usePanelTexts()
  const subagents = useStore((state) => state.subagents)
  const terminalLabel = useTerminalTabTitle(owner?.key ?? null)
  const blocked = !!owner && !owner.active
  const blockedKinds = useMemo(() => blockedKindsOf(blocked), [blocked])
  const toolLabel = useCallback((kind: PanelToolKind) => panelToolLabel(kind, texts.workbench, texts.panel), [texts])
  const pullRequestLabel = useCallback((number: number) => texts.panel.pullRequest(number), [texts])
  const subagentLabel = useCallback(
    (runId: string) => {
      const run = subagents.find((item) => item.id === runId)
      return run ? subagentPaneName(run) : texts.panel.subagent
    },
    [subagents, texts]
  )
  return useMemo(
    () => ({ toolLabel, pullRequestLabel, subagentLabel, terminalLabel, blockedKinds }),
    [toolLabel, pullRequestLabel, subagentLabel, terminalLabel, blockedKinds]
  )
}

export function useRightPanelAdapter(input: RightPanelAdapterInput): RightPanelAdapterProps {
  const { owner, mode, room } = input
  const entry = useRightPanelEntry()
  const width = useRightPanel((state) => state.width)
  const texts = usePanelTexts()
  const labels = useSurfaceLabelContext(owner)
  const settings = useStore((state) => state.settings)
  const actions = useLauncherActions(owner, input.onPick)
  const menu = usePanelMenu()
  const pickTool = input.onPick
  const shortcutText = input.shortcutText
  const overrides = useMemo(() => shortcutOverridesFromSettings(settings), [settings])

  const tabs = useMemo(() => entry.surfaces.map((surface) => t3SurfaceOf(surface, labels)), [entry.surfaces, labels])
  const blockedIds = useMemo(() => tabs.filter((tab) => tab.badge === 'blocked').map((tab) => tab.id), [tabs])
  const shortcuts = useMemo<PanelShortcutText>(() => {
    const closePane = shortcutKeysText('workspaceClosePane', overrides)
    return {
      closePane,
      maximize: shortcutKeysText('workspaceToggleMaximize', overrides),
      newPanel: shortcutText?.newPanel ?? '',
      reopenPanel: shortcutText?.reopenPanel ?? '',
      closeTab: (label: string) => withKeys(texts.panel.closeTab(label), closePane)
    }
  }, [overrides, texts, shortcutText])

  const onContextMenu = useCallback(
    (id: string, anchor: HTMLElement | null) => {
      const state = useRightPanel.getState()
      const surfaces = state.byKey[state.key]?.surfaces ?? []
      const surface = surfaces.find((item) => item.id === id)
      if (!surface) return
      const index = surfaces.indexOf(surface)
      const text = texts.panel
      const items: PanelMenuItem[] = [
        ...(surface.kind === 'file' ? [{ id: 'copy-path', label: text.copyPath, onSelect: () => copyPathOf(surface, text.copyPath) }] : []),
        { id: 'close', label: text.close, onSelect: () => useRightPanel.getState().close(id) },
        { id: 'close-others', label: text.closeOthers, disabled: surfaces.length <= 1, onSelect: () => useRightPanel.getState().closeOthers(id) },
        { id: 'close-right', label: text.closeRight, disabled: index >= surfaces.length - 1, onSelect: () => useRightPanel.getState().closeRight(id) },
        { id: 'close-all', label: text.closeAll, onSelect: () => useRightPanel.getState().closeAll() }
      ]
      usePanelMenuStore.getState().open({ id, anchor, items })
    },
    [texts]
  )

  const onCopyPath = useCallback(
    (id: string) => {
      const state = useRightPanel.getState()
      const surface = state.byKey[state.key]?.surfaces.find((item) => item.id === id)
      if (surface) copyPathOf(surface, texts.panel.copyPath)
    },
    [texts]
  )

  const activate = useCallback((id: string) => useRightPanel.getState().activate(id), [])
  const close = useCallback((id: string) => useRightPanel.getState().close(id), [])
  const closeOthers = useCallback((id: string) => useRightPanel.getState().closeOthers(id), [])
  const closeRight = useCallback((id: string) => useRightPanel.getState().closeRight(id), [])
  const closeAll = useCallback(() => useRightPanel.getState().closeAll(), [])
  const move = useCallback((id: string, toIndex: number) => useRightPanel.getState().move(id, toIndex), [])
  const pick = useCallback((action: LauncherAction) => pickTool(action.kind as PanelToolKind), [pickTool])
  const closeMenu = useCallback(() => closePanelMenu(), [])
  const reopenLast = useCallback(() => void reopenLastClosed(), [])
  const setWidth = useCallback((next: number) => useRightPanel.getState().setWidth(clampPanelWidth(next, room)), [room])
  const toggleMaximized = useCallback(() => useRightPanel.getState().setMaximized(!currentPanelEntry().maximized), [])
  const hide = useCallback(() => useRightPanel.getState().setOpen(false), [])

  return {
    mode,
    open: entry.open,
    maximized: mode === 'inline' && entry.maximized,
    room,
    width: clampPanelWidth(width, room),
    tabs,
    activeId: entry.active,
    actions,
    blockedIds,
    shortcuts,
    menu,
    onActivate: activate,
    onClose: close,
    onCloseOthers: closeOthers,
    onCloseRight: closeRight,
    onCloseAll: closeAll,
    onMove: move,
    onPick: pick,
    onContextMenu,
    onCloseMenu: closeMenu,
    onCopyPath,
    onReopenLast: reopenLast,
    onWidth: setWidth,
    onToggleMaximized: toggleMaximized,
    onHide: hide
  }
}
