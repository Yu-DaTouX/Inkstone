import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { EllipsisVertical, Eye, Minimize2, PanelRightClose, SquareX } from '../../ui/icons'
import { create } from 'zustand'
import { Button, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover, Spinner, SubmenuTrigger, motionAllowed, useReducedMotion } from '../../ui'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { PANEL_GROUP_MIN_WIDTH, PANEL_WIDTH_MIN, fileSurface, panelFocus, panelGroups, pullRequestSurface, useRightPanel, useRightPanelEntry, type PanelToolKind, type RightPanelGroup, type RightPanelSurface } from '../../state/right-panel'
import { SubagentTranscriptPane } from '../session/SubagentTranscriptPane'
import { PullRequestDetail } from '../github/PullRequestDetail'
import { PaneChromeContext, paneMenuSignature, type PaneChrome, type PaneMenuItem } from './pane-chrome'
import { previewPathFor, type PreviewOpenOptions } from './preview-state'
import { usePreviewBindings } from './preview-bindings'
import { rightPanelText, type RightPanelText } from './right-panel-text'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { WORKBENCH_ACTIVE_TABS, type PreviewPaneProps, type WorkbenchPaneComponents, type WorkbenchTabId, type WorkspaceOwner } from './types'
import { WindowControls } from '../../app/WindowControls'
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
  owner: WorkspaceOwner | null
  mode: RightPanelMode
  room: number
  dock?: number
  span?: number
  panes: WorkbenchPaneComponents
  windowControls: boolean
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

export function RightPanelT3({ owner, mode, room, dock, span, panes, windowControls, onOpenTool, onRequestActivation }: RightPanelProps): ReactElement | null {
  const { lang } = useI18n()
  const text = workbenchText(lang)
  const panel = rightPanelText(lang)
  const reducedMotion = useReducedMotion()
  const entry = useRightPanelEntry()
  const panelKey = useRightPanel((state) => state.key)
  const adapter = useRightPanelAdapter({ owner, mode, room, onPick: onOpenTool })
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
  const columnar = mode === 'inline' && groups.length > 0 && !!owner
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
    const shown = columnar ? groupActives.split('\n').filter(Boolean) : active ? [active.id] : []
    if (!shown.length) return
    setVisited((prev) =>
      prev.owner === ownerKey && shown.every((id) => prev.ids.has(id)) ? prev : { owner: ownerKey, ids: new Set([...(prev.owner === ownerKey ? prev.ids : []), ...shown]) }
    )
  }, [entry.open, active, ownerKey, columnar, groupActives])

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
  const totalSize = groups.reduce((sum, group) => sum + group.size, 0) || 1

  const columnHead = (group: RightPanelGroup, index: number): ReactNode => {
    const last = index === groups.length - 1
    return (
      <div
        data-right-panel-tabbar
        className="rp-column-head"
        data-window-controls={windowControls && last ? '1' : undefined}
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
          {groups.length > 1 ? (
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
        {windowControls && last ? <WindowControls /> : null}
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

  const renderSurface = (surface: RightPanelSurface, shown: boolean): ReactNode =>
    owner ? (
      <SurfaceView
        key={surface.id}
        surface={surface}
        panelKey={panelKey}
        shown={shown}
        live={entry.open}
        owner={owner}
        panes={panes}
        text={text}
        panel={panel}
        closeTip={closeTipOf(surface)}
        onRequestActivation={onRequestActivation}
      />
    ) : null

  const columns = columnar ? (
    <div className="rp-columns" key={owner!.key} data-columns={groups.length}>
      {groups.flatMap((group, index) => [
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
              .map((surface) => renderSurface(surface, entry.open && surface.id === group.active))}
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
      {windowControls ? <WindowControls /> : null}
    </>
  )

  const content = !entry.surfaces.length ? (
    <Launcher actions={adapter.actions} title={panel.launcherTitle} />
  ) : columns ? (
    columns
  ) : owner ? (
    <div className="rp-surfaces" key={owner.key}>
      {mounted.map((surface) => renderSurface(surface, entry.open && surface.id === entry.active))}
    </div>
  ) : null

  return (
    <>
      <RightPanelFrame
        mode={mode}
        open={entry.open}
        maximized={adapter.maximized}
        width={adapter.width}
        room={room}
        dock={dock}
        span={span}
        label={panel.panel}
        onWidth={adapter.onWidth}
        minWidth={columns && groups.length > 1 ? Math.min(room, PANEL_WIDTH_MIN * groups.length) : undefined}
        tabbar={columns ? null : tabbar}
        tabbarClassName={windowControls ? 't3-rp-frame__tabbar--flush' : undefined}
        toggleSelector='[data-right-panel-toggle]'
        sheet={{ onClose: adapter.onHide, transitionMs: reducedMotion || mode !== 'sheet' ? 0 : motionMs('sheet') }}
        onKeyDown={onPanelKey}
        testId="rp"
      >
        {content}
      </RightPanelFrame>
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
  closeTip: string
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
}

function SurfaceView({ surface, panelKey, shown, live, owner, panes, text, panel, onRequestActivation }: SurfaceViewProps): ReactElement {
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
  const chrome = useMemo<PaneChrome>(() => ({ title: titleEl, tools: toolsEl, setMenu }), [titleEl, toolsEl, setMenu])
  const previewPath = usePreviewBindings((s) => previewPathFor(s.bindings, owner.key))
  const tool = surface.kind !== 'file' && surface.kind !== 'pullRequest' && surface.kind !== 'subagent' ? surface.kind : null
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
  } else if (surface.kind === 'file') {
    const Preview = panes.preview
    body = Preview ? <Preview owner={owner} path={surface.path} visible={shown && live} treeShown={false} standalone /> : null
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
