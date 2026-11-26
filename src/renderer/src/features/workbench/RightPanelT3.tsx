import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type KeyboardEventHandler, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { EllipsisVertical, Eye, Minimize2, PanelRight, PanelRightClose, SquareX, X } from '../../ui/icons'
import { SurfaceIcon } from '../../t3/components/right-panel/TabChip'
import { create } from 'zustand'
import { Button, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover, Spinner, Splitter, SubmenuTrigger, motionAllowed, useReducedMotion } from '../../ui'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { DOCK_BOTTOM_DEFAULT, DOCK_BOTTOM_MIN, DOCK_LEFT_DEFAULT, DOCK_LEFT_MIN, PANEL_GROUP_MIN_WIDTH, PANEL_WIDTH_MIN, fileSurface, panelFocus, panelGroups, pullRequestSurface, rightGroupCount, toolSurface, useRightPanel, useRightPanelEntry, type PanelEdgeDock, type PanelToolKind, type RightPanelGroup, type RightPanelSurface } from '../../state/right-panel'
import { SubagentTranscriptPane } from '../session/SubagentTranscriptPane'
import { WatchPane } from '../watch/WatchPane'
import { PullRequestDetail } from '../github/PullRequestDetail'
import { PaneChromeContext, paneMenuSignature, type PaneChrome, type PaneMenuItem } from './pane-chrome'
import { previewPathFor, type PreviewOpenOptions } from './preview-state'
import { usePreviewBindings } from './preview-bindings'
import { rightPanelText, type RightPanelText } from './right-panel-text'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { WORKBENCH_ACTIVE_TABS, type PreviewPaneProps, type WorkbenchPaneComponents, type WorkbenchTabId, type WorkspaceOwner } from './types'
import { motionMs } from '../../ui/motion-hooks'
import { RightPanelFrame } from '../../t3/components/right-panel/RightPanelFrame'
import { TabStrip } from '../../t3/components/right-panel/TabStrip'
import { Launcher } from '../../t3/components/right-panel/Launcher'
import { TabContextMenu, type TabContextMenuItem } from '../../t3/components/right-panel/TabContextMenu'
import { closePanelMenu, useRightPanelAdapter } from '../../t3/adapters/right-panel'
import { startPanelTabDrag } from './panel-tab-drag'
import './right-panel.css'
import { baseName } from '../../t3/adapters/surfaces'

export type RightPanelMode = 'inline' | 'sheet'

export interface RightPanelProps {
  panelMotionMs: number
  owner: WorkspaceOwner | null
  mode: RightPanelMode
  room: number
  dock?: number
  span?: number
  panes: WorkbenchPaneComponents
  leftSlot?: HTMLElement | null
  bottomSlot?: HTMLElement | null
  onOpenTool: (kind: PanelToolKind) => void
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
}

interface NewPanelRequest {
  pending: boolean
  request: () => void
  take: () => boolean
}

const useNewPanelRequest = create<NewPanelRequest>((set, get) => ({
  pending: false,
  request: () => set({ pending: true }),
  take: () => {
    if (!get().pending) return false
    set({ pending: false })
    return true
  }
}))

export function requestNewPanelMenu(): void {
  useNewPanelRequest.getState().request()
}

export function RightPanelT3({ owner, mode, room, dock, span, panes, leftSlot, bottomSlot, panelMotionMs, onOpenTool, onRequestActivation }: RightPanelProps): ReactElement | null {
  const { lang } = useI18n()
  const text = workbenchText(lang)
  const panel = rightPanelText(lang)
  const reducedMotion = useReducedMotion()
  const entry = useRightPanelEntry()
  const panelKey = useRightPanel((state) => state.key)
  const adapter = useRightPanelAdapter({ owner, mode, room, onPick: onOpenTool })
  const dockLeftStored = useRightPanel((state) => state.dockLeft)
  const [addMenuFor, setAddMenuFor] = useState<number | null>(null)
  const addMenuOpen = addMenuFor !== null
  const setAddMenuOpen = (open: boolean): void => setAddMenuFor(open ? 0 : null)
  const pendingNewPanel = useNewPanelRequest((state) => state.pending)
  const ownerKey = owner?.key ?? ''
  const [visited, setVisited] = useState<{ owner: string; ids: ReadonlySet<string> }>({ owner: ownerKey, ids: new Set() })
  const visitedIds = visited.owner === ownerKey ? visited.ids : new Set<string>()
  const active = entry.surfaces.find((item) => item.id === entry.active) ?? null
  const groups = panelGroups(entry)
  const focus = panelFocus(entry)
  const rightCount = rightGroupCount(groups)
  const rightGroups = groups.slice(0, rightCount)
  const columnar = mode === 'inline' && rightCount > 0 && !!owner
  const dockedOnly = mode === 'inline' && !!owner && entry.surfaces.length > 0 && rightCount === 0
  const groupActives = groups.map((group) => group.active ?? '').join('\n')

  useEffect(() => {
    if (!pendingNewPanel) return
    if (useNewPanelRequest.getState().take()) setAddMenuFor(columnar ? focus : 0)
  }, [pendingNewPanel, columnar, focus])

  useEffect(() => {
    if (addMenuFor === null) return
    const scope = columnar ? `[data-rp-column="${addMenuFor}"] ` : ''
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`${scope}[data-testid="rp-new-tab"]`)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [addMenuFor, columnar])

  useEffect(() => {
    if (!entry.open) return
    const shown = columnar || dockedOnly ? groupActives.split('\n').filter(Boolean) : active ? [active.id] : []
    if (!shown.length) return
    setVisited((prev) =>
      prev.owner === ownerKey && shown.every((id) => prev.ids.has(id)) ? prev : { owner: ownerKey, ids: new Set([...(prev.owner === ownerKey ? prev.ids : []), ...shown]) }
    )
  }, [entry.open, active, ownerKey, columnar, dockedOnly, groupActives])

  const onPanelKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    if (!event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key !== 'PageDown' && event.key !== 'PageUp') return
    event.preventDefault()
    useRightPanel.getState().step(event.key === 'PageDown' ? 1 : -1)
    const scope = columnar ? `[data-rp-column="${focus}"] ` : ''
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`${scope}[data-right-panel-tab-list] [role="tab"][aria-selected="true"]`)?.focus())
  }

  const menuItems = useMemo<TabContextMenuItem[]>(
    () =>
      (adapter.menu?.items ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        disabled: item.disabled,
        danger: item.danger,
        separatorBefore: item.id === 'close-column' || (item.id === 'close-all' && !adapter.menu?.items.some((entry) => entry.id === 'close-column')),
        onSelect: () => {
          item.onSelect()
          closePanelMenu()
        }
      })),
    [adapter.menu]
  )

  const mounted = entry.surfaces.filter((item) => visitedIds.has(item.id) || item.id === active?.id)
  const closeShortcut = adapter.shortcuts.closePane
  const closeTipOf = (surface: RightPanelSurface): string =>
    closeShortcut ? `${panel.closeTab(baseName(surface.id))} · ${closeShortcut}` : panel.closeTab(baseName(surface.id))
  const tabById = new Map(adapter.tabs.map((tab) => [tab.id, tab]))
  const totalSize = rightGroups.reduce((sum, group) => sum + group.size, 0) || 1

  const columnHead = (group: RightPanelGroup, index: number): ReactNode => {
    const last = index === rightCount - 1
    return (
      <div
        data-right-panel-tabbar
        className="rp-column-head"
        data-window-controls={last ? '1' : undefined}
      >
        <TabStrip
          tabs={group.surfaces.flatMap((surface) => tabById.get(surface.id) ?? [])}
          activeId={group.active}
          actions={adapter.actions}
          listLabel={panel.tabs}
          addLabel={panel.newTab}
          addMenuOpen={addMenuFor === index}
          onAddMenuOpenChange={(open) => setAddMenuFor(open ? index : null)}
          onActivate={adapter.onActivate}
          onClose={adapter.onClose}
          onContextMenu={adapter.onContextMenu}
          onMove={adapter.onMove}
          onDragOut={(id, start) => startPanelTabDrag(start, id, tabById.get(id)?.label ?? '', room, panel)}
        />
        <span className="rp-tabbar-actions">
          {rightCount > 1 ? (
            <IconButton data-t3-btn size="sm" className="rp-close-column" aria-label={panel.closeColumn} tooltip={panel.closeColumn} data-testid={`rp-close-column-${index}`} onPress={() => useRightPanel.getState().closeGroup(index)}>
              <SquareX size={14} />
            </IconButton>
          ) : null}
          {last && adapter.maximized ? (
            <IconButton data-t3-btn size="sm" aria-label={panel.restore} tooltip={panel.restore} aria-pressed data-testid="rp-maximize" onPress={adapter.onToggleMaximized}>
              <Minimize2 size={14} />
            </IconButton>
          ) : null}
        </span>
      </div>
    )
  }

  const tileHead = (group: RightPanelGroup): ReactNode => {
    const surface = group.surfaces[0]
    const tab = surface ? tabById.get(surface.id) : undefined
    if (!surface || !tab) return null
    return (
      <div
        className="rp-tile-head"
        data-testid={`rp-tile-head-${group.side}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
          startPanelTabDrag({ button: 0, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }, surface.id, tab.label, room, panel)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          adapter.onContextMenu(surface.id, event.currentTarget)
        }}
      >
        <span className="rp-tile-icon" aria-hidden>
          <SurfaceIcon surface={tab} />
        </span>
        <span className="rp-tile-title">{tab.label}</span>
        <span className="rp-tabbar-actions">
          <IconButton data-t3-btn size="sm" aria-label={panel.toRightPanel} tooltip={panel.toRightPanel} data-testid={`rp-tile-back-${group.side}`} onPress={() => useRightPanel.getState().moveToRight(surface.id)}>
            <PanelRight size={14} />
          </IconButton>
          <IconButton data-t3-btn size="sm" aria-label={closeTipOf(surface)} tooltip={closeTipOf(surface)} data-testid={`rp-tile-close-${group.side}`} onPress={() => adapter.onClose(surface.id)}>
            <X size={14} />
          </IconButton>
        </span>
      </div>
    )
  }

  const columnSplitter = (index: number): ReactNode => (
    <ColumnSplitter
      key={`split:${index}`}
      index={index}
      share={groups[index - 1].size / (groups[index - 1].size + groups[index].size)}
      pairGrow={(groups[index - 1].size + groups[index].size) / totalSize}
      label={panel.resizeColumns}
    />
  )

  const renderSurface = (surface: RightPanelSurface, shown: boolean, live = entry.open): ReactNode =>
    owner ? (
      <SurfaceView
        key={surface.id}
        surface={surface}
        panelKey={panelKey}
        shown={shown}
        live={live}
        owner={owner}
        panes={panes}
        text={text}
        panel={panel}
        room={room}
        closeTip={closeTipOf(surface)}
        onRequestActivation={onRequestActivation}
      />
    ) : null

  const columns = columnar ? (
    <div className="rp-columns" key={owner!.key} data-columns={rightCount}>
      {rightGroups.flatMap((group, index) => [
        ...(index > 0 ? [columnSplitter(index)] : []),
        <section
          key={`col:${index}`}
          className="rp-column"
          data-rp-column={index}
          data-focused={groups.length > 1 && index === focus ? '1' : undefined}
          data-testid={`rp-column-${index}`}
          style={{ flexGrow: group.size / totalSize }}
          onPointerDownCapture={() => useRightPanel.getState().focusGroup(index)}
          onFocusCapture={() => useRightPanel.getState().focusGroup(index)}
        >
          {columnHead(group, index)}
          <div className="rp-surfaces">
            {group.surfaces
              .filter((item) => visitedIds.has(item.id) || item.id === group.active)
              .map((surface) => renderSurface(surface, surface.id === group.active))}
          </div>
        </section>
      ])}
    </div>
  ) : null

  const tabbar = (
    <>
      <TabStrip
        tabs={adapter.tabs}
        activeId={adapter.activeId}
        actions={adapter.actions}
        listLabel={panel.tabs}
        addLabel={panel.newTab}
        addMenuOpen={addMenuOpen}
        onAddMenuOpenChange={setAddMenuOpen}
        onActivate={adapter.onActivate}
        onClose={adapter.onClose}
        onContextMenu={adapter.onContextMenu}
        onMove={adapter.onMove}
      />
      <span className="rp-tabbar-actions">
        {mode === 'inline' && adapter.maximized ? (
          <IconButton data-t3-btn size="sm" aria-label={panel.restore} tooltip={panel.restore} aria-pressed data-testid="rp-maximize" onPress={adapter.onToggleMaximized}>
            <Minimize2 size={14} />
          </IconButton>
        ) : null}
        {mode === 'inline' ? null : (
          <IconButton data-t3-btn size="sm" aria-label={panel.hidePanel} tooltip={panel.hidePanel} data-testid="rp-hide" onPress={adapter.onHide}>
            <PanelRightClose size={14} />
          </IconButton>
        )}
      </span>
    </>
  )

  const dockShown = mode === 'inline' && !adapter.maximized && !!owner
  const rightShownWidth = columnar && entry.open && !adapter.maximized ? Math.min(adapter.width, dock ?? Number.POSITIVE_INFINITY) : 0
  const leftRoom = (span ?? window.innerWidth) - rightShownWidth - DOCK_CHAT_ROOM_PX
  const leftWidth = dockShown && groups.some((group) => group.side === 'left') && leftSlot ? Math.max(DOCK_LEFT_MIN, Math.min(dockLeftStored, leftRoom)) : 0
  const dockArea = (side: PanelEdgeDock, slot: HTMLElement | null | undefined): ReactNode => {
    const index = groups.findIndex((group) => group.side === side)
    if (!dockShown || index < 0 || !slot) return null
    const group = groups[index]
    return createPortal(
      <DockFrame key={`${owner!.key}:${side}`} side={side} room={side === 'left' ? leftRoom : window.innerHeight * DOCK_HEIGHT_FRACTION} label={side === 'left' ? panel.dockLeft : panel.dockBottom} resizeLabel={panel.resizeDock} onKeyDown={onPanelKey}>
        <section
          className="rp-column rp-tile"
          data-rp-column={index}
          data-rp-dock={side}
          data-testid={`rp-dock-column-${side}`}
          onPointerDownCapture={() => useRightPanel.getState().focusGroup(index)}
          onFocusCapture={() => useRightPanel.getState().focusGroup(index)}
        >
          {tileHead(group)}
          <div className="rp-surfaces">
            {group.surfaces
              .filter((item) => visitedIds.has(item.id) || item.id === group.active)
              .map((surface) => renderSurface(surface, surface.id === group.active, true))}
          </div>
        </section>
      </DockFrame>,
      slot,
      `rp-dock-${side}`
    )
  }

  const content = dockedOnly || !entry.surfaces.length ? (
    <Launcher actions={adapter.actions} title={panel.launcherTitle} />
  ) : columns ? (
    columns
  ) : owner ? (
    <div className="rp-surfaces" key={owner.key}>
      {mounted.map((surface) => renderSurface(surface, (mode === 'inline' || entry.open) && surface.id === entry.active))}
    </div>
  ) : null

  return (
    <>
      <RightPanelFrame
        inlineExitMs={panelMotionMs}
        mode={mode}
        open={entry.open}
        maximized={adapter.maximized}
        width={adapter.width}
        room={room}
        dock={dock !== undefined && leftWidth ? Math.max(PANEL_WIDTH_MIN, dock - leftWidth) : dock}
        span={span}
        label={panel.panel}
        onWidth={adapter.onWidth}
        minWidth={columns && rightCount > 1 ? Math.min(room, PANEL_WIDTH_MIN * rightCount) : undefined}
        tabbar={columns ? null : tabbar}
        tabbarClassName={mode === 'inline' ? 't3-rp-frame__tabbar--desktop' : undefined}
        toggleSelector='[data-right-panel-toggle]'
        sheet={{ onClose: adapter.onHide, transitionMs: reducedMotion || mode !== 'sheet' ? 0 : motionMs('sheet') }}
        onKeyDown={onPanelKey}
        testId="rp"
      >
        {content}
      </RightPanelFrame>
      {dockArea('left', leftSlot)}
      {dockArea('bottom', bottomSlot)}
      <TabContextMenu
        anchor={adapter.menu?.anchor ?? null}
        open={!!adapter.menu}
        label={panel.tabs}
        items={menuItems}
        onOpenChange={(next) => {
          if (!next) closePanelMenu()
        }}
      />
    </>
  )
}

const COLUMN_KEY_STEP_PX = 16
const DOCK_KEY_STEP_PX = 16
const DOCK_CHAT_ROOM_PX = 480
const DOCK_HEIGHT_FRACTION = 0.6

interface DockFrameProps {
  side: PanelEdgeDock
  room: number
  label: string
  resizeLabel: string
  onKeyDown: KeyboardEventHandler<HTMLElement>
  children: ReactNode
}

function DockFrame({ side, room, label, resizeLabel, onKeyDown, children }: DockFrameProps): ReactElement {
  const stored = useRightPanel((state) => (side === 'left' ? state.dockLeft : state.dockBottom))
  const min = side === 'left' ? DOCK_LEFT_MIN : DOCK_BOTTOM_MIN
  const max = Math.max(min, Math.floor(room))
  const size = Math.max(min, Math.min(stored, max))
  const axis = min + max
  const setSize = (next: number): void => useRightPanel.getState().setDockSize(side, next)
  return (
    <aside
      className={`rp-dock rp-dock--${side}`}
      aria-label={label}
      data-native-clip=""
      data-testid={`rp-dock-${side}`}
      style={side === 'left' ? { width: `${size}px` } : { height: `${size}px` }}
      onKeyDown={onKeyDown}
    >
      {children}
      <Splitter
        className="rp-dock-resizer"
        orientation={side === 'left' ? 'vertical' : 'horizontal'}
        value={side === 'left' ? size : axis - size}
        min={side === 'left' ? min : axis - max}
        max={side === 'left' ? max : axis - min}
        step={DOCK_KEY_STEP_PX}
        aria-label={resizeLabel}
        data-testid={`rp-dock-resizer-${side}`}
        onChange={(value) => setSize(side === 'left' ? value : axis - value)}
        onReset={() => setSize(side === 'left' ? DOCK_LEFT_DEFAULT : DOCK_BOTTOM_DEFAULT)}
      />
    </aside>
  )
}

function ColumnSplitter({ index, share, pairGrow, label }: { index: number; share: number; pairGrow: number; label: string }): ReactElement {
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number; pair: number; left: HTMLElement; right: HTMLElement; share: number } | null>(null)
  const frame = useRef(0)
  const [dragging, setDragging] = useState(false)
  const columnsOf = (host: HTMLElement): [HTMLElement, HTMLElement] | null => {
    const root = host.closest('.rp-columns')
    const left = root?.querySelector<HTMLElement>(`:scope > [data-rp-column="${index - 1}"]`)
    const right = root?.querySelector<HTMLElement>(`:scope > [data-rp-column="${index}"]`)
    return left && right ? [left, right] : null
  }
  const clampShare = (leftPx: number, pair: number, fromPx: number): number => {
    const min = Math.min(pair / 2, PANEL_GROUP_MIN_WIDTH)
    const low = Math.min(min, fromPx)
    const high = Math.max(pair - min, fromPx)
    return Math.min(high, Math.max(low, leftPx)) / pair
  }
  const commit = (next: number): void => useRightPanel.getState().resizeGroups(index - 1, next)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      data-dragging={dragging || undefined}
      data-testid={`rp-column-splitter-${index}`}
      className="ui-splitter ui-splitter--vertical ui-splitter--edge rp-column-splitter"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const pairEls = columnsOf(event.currentTarget)
        if (!pairEls) return
        const [left, right] = pairEls
        const startLeft = left.getBoundingClientRect().width
        const pair = startLeft + right.getBoundingClientRect().width
        if (pair <= 0) return
        event.preventDefault()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          return
        }
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startLeft, pair, left, right, share: startLeft / pair }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const session = drag.current
        if (!session || session.pointerId !== event.pointerId) return
        session.share = clampShare(session.startLeft + event.clientX - session.startX, session.pair, session.startLeft)
        if (frame.current) return
        frame.current = requestAnimationFrame(() => {
          frame.current = 0
          const live = drag.current
          if (!live) return
          live.left.style.flexGrow = String(live.share * pairGrow)
          live.right.style.flexGrow = String((1 - live.share) * pairGrow)
        })
      }}
      onPointerUp={(event) => {
        const session = drag.current
        if (!session || session.pointerId !== event.pointerId) return
        drag.current = null
        setDragging(false)
        cancelAnimationFrame(frame.current)
        frame.current = 0
        commit(session.share)
      }}
      onLostPointerCapture={() => {
        const session = drag.current
        if (!session) return
        drag.current = null
        setDragging(false)
        commit(session.share)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const pairEls = columnsOf(event.currentTarget)
        if (!pairEls) return
        event.preventDefault()
        const leftPx = pairEls[0].getBoundingClientRect().width
        const pair = leftPx + pairEls[1].getBoundingClientRect().width
        commit(clampShare(leftPx + (event.key === 'ArrowLeft' ? -COLUMN_KEY_STEP_PX : COLUMN_KEY_STEP_PX), pair, leftPx))
      }}
      onDoubleClick={() => commit(0.5)}
    />
  )
}

interface LeafProps {
  owner: WorkspaceOwner
  visible?: boolean
  onPreview?: (path: string, options?: PreviewOpenOptions) => void
  path?: string
  Preview?: ComponentType<PreviewPaneProps>
}

const MENU_SOURCE_ORDER = ['preview', 'preview-view', 'files']

function paneMenuEntry(item: PaneMenuItem): ReactElement {
  if (item.items?.length) {
    return (
      <SubmenuTrigger key={item.id}>
        <MenuItem id={item.id} textValue={item.label} icon={item.icon} isDisabled={item.disabled}>
          {item.label}
        </MenuItem>
        <Popover placement="end top" offset={2}>
          <Menu aria-label={item.label}>{item.items.map(paneMenuEntry)}</Menu>
        </Popover>
      </SubmenuTrigger>
    )
  }
  return (
    <MenuItem
      key={item.id}
      id={item.id}
      textValue={item.label}
      icon={item.checked === undefined ? item.icon : undefined}
      checked={item.checked}
      isDisabled={item.disabled}
      onAction={() => item.onAction()}
    >
      {item.label}
    </MenuItem>
  )
}

function menuSourceRank(source: string): number {
  const index = MENU_SOURCE_ORDER.indexOf(source)
  return index < 0 ? MENU_SOURCE_ORDER.length : index
}

interface SurfaceViewProps {
  surface: RightPanelSurface
  panelKey: string
  shown: boolean
  live: boolean
  owner: WorkspaceOwner
  panes: WorkbenchPaneComponents
  text: WorkbenchText
  panel: RightPanelText
  room: number
  closeTip: string
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
}

function SurfaceView({ surface, panelKey, shown, live, owner, panes, text, panel, room, onRequestActivation }: SurfaceViewProps): ReactElement {
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null)
  const [toolsEl, setToolsEl] = useState<HTMLElement | null>(null)
  const [menuGroups, setMenuGroups] = useState<ReadonlyMap<string, readonly PaneMenuItem[]>>(() => new Map())
  const [activating, setActivating] = useState(false)
  const [seenShown, setSeenShown] = useState(shown)
  const [entering, setEntering] = useState(false)
  if (seenShown !== shown) {
    setSeenShown(shown)
    setEntering(shown && motionAllowed())
  }
  const setMenu = useCallback((source: string, items: readonly PaneMenuItem[]): void => {
    setMenuGroups((prev) => {
      const current = prev.get(source) ?? []
      if (paneMenuSignature(current) === paneMenuSignature(items)) return prev
      const next = new Map(prev)
      if (items.length) next.set(source, items)
      else next.delete(source)
      return next
    })
  }, [])
  const chrome = useMemo<PaneChrome>(
    () => ({
      title: titleEl,
      tools: toolsEl,
      setMenu,
      detach: (start, seed, label) => startPanelTabDrag(start, seed.id, label, room, panel, { surface: seed, near: surface.id })
    }),
    [titleEl, toolsEl, setMenu, room, panel, surface.id]
  )
  const previewPath = usePreviewBindings((s) => previewPathFor(s.bindings, owner.key))
  const tool = surface.kind !== 'file' && surface.kind !== 'pullRequest' && surface.kind !== 'subagent' && surface.kind !== 'terminalTab' && surface.kind !== 'watch' ? surface.kind : null
  const blocked = !!tool && !owner.active && WORKBENCH_ACTIVE_TABS.has(tool)
  const extraItems: PaneMenuItem[] =
    tool === 'files' && previewPath
      ? [{ id: 'rp:own-tab', label: panel.openInOwnTab(baseName(previewPath)), icon: <Eye size={14} aria-hidden />, onAction: () => useRightPanel.getState().open(fileSurface(previewPath)) }]
      : []
  const groups = [...[...menuGroups.entries()].sort(([a], [b]) => menuSourceRank(a) - menuSourceRank(b)).map(([, items]) => items), ...(extraItems.length ? [extraItems] : [])]
  const allItems = groups.flat()
  const name = tool ? text.tabs[tool] : ''

  const activate = (): void => {
    if (!tool || activating) return
    setActivating(true)
    void onRequestActivation(tool)
      .catch(() => useStore.getState().notify('error', text.activateFailed))
      .finally(() => setActivating(false))
  }

  let body: ReactNode = null
  if (surface.kind === 'pullRequest') {
    body = (
      <PullRequestDetail
        cwd={owner.cwd}
        number={surface.number}
        seedTitle={surface.title}
        tab={surface.tab ?? 'summary'}
        onTabChange={(tab) => useRightPanel.getState().updateSurface(panelKey, pullRequestSurface(surface.number, { tab }))}
        onState={(state, title) => {
          useRightPanel.getState().updateSurface(panelKey, pullRequestSurface(surface.number, { state, title }))
        }}
      />
    )
  } else if (surface.kind === 'subagent') {
    body = <SubagentTranscriptPane runId={surface.runId} />
  } else if (surface.kind === 'watch') {
    body = <WatchPane watchId={surface.watchId} />
  } else if (surface.kind === 'terminalTab') {
    const Terminal = panes.terminal
    body = Terminal ? <Terminal owner={owner} visible={shown && live} only={surface.terminalId} /> : null
  } else if (surface.kind === 'file') {
    const Preview = panes.preview
    body = Preview ? (
      <Preview
        owner={owner}
        path={surface.path}
        visible={shown && live}
        treeShown={false}
        standalone
        onRevealInTree={(abs, options) => {
          usePreviewBindings.getState().requestReveal(owner.key, abs, options?.directory)
          useRightPanel.getState().open(toolSurface('files'))
        }}
      />
    ) : null
  } else if (tool) {
    const Body = panes[tool] as ComponentType<LeafProps> | undefined
    body = Body ? (
      <Body
        owner={owner}
        visible={shown && live && !blocked}
        onPreview={(path, options) => usePreviewBindings.getState().bind(owner.key, path, options)}
        path={previewPath}
        Preview={tool === 'files' ? panes.preview : undefined}
      />
    ) : (
      <EmptyState className="rp-empty" title={text.notWired} description={text.notWiredHint} />
    )
  }

  const subHeader = surface.kind !== 'pullRequest'
  return (
    <div
      className="rp-surface"
      id={`rp-surface-${surface.id}`}
      role="tabpanel"
      aria-labelledby={`rp-tab-${surface.id}`}
      hidden={!shown}
      data-motion={entering ? 'in' : undefined}
      data-kind={surface.kind}
      data-testid={`rp-surface-${surface.id}`}
    >
      {subHeader ? (
        <div className="rp-sub" data-testid={`rp-sub-${surface.id}`}>
          <span className="rp-sub-title" ref={setTitleEl} />
          <span className="rp-sub-tools" ref={setToolsEl} />
          {allItems.length ? (
            <MenuTrigger>
              <IconButton data-t3-btn variant="ghost" size="md" className="rp-sub-menu" aria-label={text.paneMenu(name || panel.file)} tooltip={text.paneMenu(name || panel.file)} data-testid={`rp-menu-${surface.id}`}>
                <EllipsisVertical />
              </IconButton>
              <Popover placement="bottom end" offset={6}>
                <Menu autoFocus="first" aria-label={text.paneMenu(name || panel.file)}>
                  {groups.flatMap((items, index) => [
                    ...(index > 0 ? [<MenuSeparator key={`sep:${index}`} />] : []),
                    ...items.map(paneMenuEntry)
                  ])}
                </Menu>
              </Popover>
            </MenuTrigger>
          ) : null}
        </div>
      ) : null}
      <div className="rp-surface-body">
        <PaneChromeContext.Provider value={chrome}>{body}</PaneChromeContext.Provider>
        {blocked ? (
          <div className="rp-block">
            <EmptyState
              size="sm"
              title={text.activateHint}
              action={
                <Button data-t3-btn size="sm" variant="primary" onPress={activate} isDisabled={activating} icon={activating ? <Spinner size="xs" /> : undefined} data-testid="rp-activate">
                  {text.activate}
                </Button>
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
