import { useCallback, useEffect, useMemo, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { EllipsisVertical, Eye, Maximize2, Minimize2, PanelRightClose } from 'lucide-react'
import { create } from 'zustand'
import { Button, EmptyState, IconButton, Spinner, motionAllowed, useReducedMotion } from '../../ui'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { fileSurface, pullRequestSurface, useRightPanel, useRightPanelEntry, type PanelToolKind, type RightPanelSurface } from '../../state/right-panel'
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
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../../t3/components/ui/menu'
import { Button as T3Button } from '../../t3/components/ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../t3/components/ui/tooltip'
import { closePanelMenu, useRightPanelAdapter } from '../../t3/adapters/right-panel'
import './right-panel.css'

export type RightPanelMode = 'inline' | 'sheet'

export interface RightPanelProps {
  owner: WorkspaceOwner | null
  mode: RightPanelMode
  room: number
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

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function RightPanelT3({ owner, mode, room, panes, windowControls, onOpenTool, onRequestActivation }: RightPanelProps): ReactElement | null {
  const { lang } = useI18n()
  const text = workbenchText(lang)
  const panel = rightPanelText(lang)
  const reducedMotion = useReducedMotion()
  const entry = useRightPanelEntry()
  const adapter = useRightPanelAdapter({ owner, mode, room, onPick: onOpenTool })
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const pendingNewPanel = useNewPanelRequest((state) => state.pending)
  const ownerKey = owner?.key ?? ''
  const [visited, setVisited] = useState<{ owner: string; ids: ReadonlySet<string> }>({ owner: ownerKey, ids: new Set() })
  const visitedIds = visited.owner === ownerKey ? visited.ids : new Set<string>()
  const active = entry.surfaces.find((item) => item.id === entry.active) ?? null

  useEffect(() => {
    if (!pendingNewPanel) return
    if (useNewPanelRequest.getState().take()) setAddMenuOpen(true)
  }, [pendingNewPanel])

  useEffect(() => {
    if (!addMenuOpen) return
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="rp-new-tab"]')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [addMenuOpen])

  useEffect(() => {
    if (!entry.open || !active) return
    setVisited((prev) => (prev.owner === ownerKey && prev.ids.has(active.id) ? prev : { owner: ownerKey, ids: new Set([...(prev.owner === ownerKey ? prev.ids : []), active.id]) }))
  }, [entry.open, active, ownerKey])

  const onPanelKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    if (!event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key !== 'PageDown' && event.key !== 'PageUp') return
    event.preventDefault()
    useRightPanel.getState().step(event.key === 'PageDown' ? 1 : -1)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-right-panel-tab-list] [role="tab"][aria-selected="true"]')?.focus())
  }

  const menuItems = useMemo<TabContextMenuItem[]>(
    () =>
      (adapter.menu?.items ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        disabled: item.disabled,
        separatorBefore: item.id === 'close-all',
        onSelect: () => {
          item.onSelect()
          closePanelMenu()
        }
      })),
    [adapter.menu]
  )

  const mounted = entry.surfaces.filter((item) => visitedIds.has(item.id) || item.id === active?.id)
  const closeShortcut = adapter.shortcuts.closePane

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
        {mode === 'inline' ? (
          <IconButton
            size="sm"
            aria-label={adapter.maximized ? panel.restore : panel.maximize}
            tooltip={adapter.maximized ? panel.restore : panel.maximize}
            aria-pressed={adapter.maximized}
            isDisabled={!entry.surfaces.length}
            data-testid="rp-maximize"
            onPress={adapter.onToggleMaximized}
          >
            {adapter.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
        ) : null}
        <IconButton size="sm" aria-label={panel.hidePanel} tooltip={panel.hidePanel} data-testid="rp-hide" onPress={adapter.onHide}>
          <PanelRightClose size={14} />
        </IconButton>
      </span>
      {windowControls ? <WindowControls /> : null}
    </>
  )

  const content = !entry.surfaces.length ? (
    <Launcher actions={adapter.actions} title={panel.launcherTitle} />
  ) : owner ? (
    <div className="rp-surfaces" key={owner.key}>
      {mounted.map((surface) => (
        <SurfaceView
          key={surface.id}
          surface={surface}
          shown={entry.open && surface.id === entry.active}
          live={entry.open}
          owner={owner}
          panes={panes}
          text={text}
          panel={panel}
          closeTip={closeShortcut ? `${panel.closeTab(baseName(surface.id))} · ${closeShortcut}` : panel.closeTab(baseName(surface.id))}
          onRequestActivation={onRequestActivation}
        />
      ))}
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
        label={panel.panel}
        onWidth={adapter.onWidth}
        tabbar={tabbar}
        tabbarClassName={windowControls ? 'pr-0' : undefined}
        toggleSelector='[data-right-panel-toggle]'
        sheet={{ onClose: adapter.onHide, transitionMs: reducedMotion ? 0 : motionMs('sheet') }}
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

interface LeafProps {
  owner: WorkspaceOwner
  visible?: boolean
  onPreview?: (path: string, options?: PreviewOpenOptions) => void
  path?: string
  Preview?: ComponentType<PreviewPaneProps>
}

const MENU_SOURCE_ORDER = ['preview', 'preview-view', 'files']

function menuSourceRank(source: string): number {
  const index = MENU_SOURCE_ORDER.indexOf(source)
  return index < 0 ? MENU_SOURCE_ORDER.length : index
}

interface SurfaceViewProps {
  surface: RightPanelSurface
  shown: boolean
  live: boolean
  owner: WorkspaceOwner
  panes: WorkbenchPaneComponents
  text: WorkbenchText
  panel: RightPanelText
  closeTip: string
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
}

function SurfaceView({ surface, shown, live, owner, panes, text, panel, onRequestActivation }: SurfaceViewProps): ReactElement {
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
        onTabChange={(tab) => useRightPanel.getState().open(pullRequestSurface(surface.number, { title: surface.title, state: surface.state, tab }))}
        onState={(state, title) => {
          if (state !== surface.state || (title && title !== surface.title)) useRightPanel.getState().open(pullRequestSurface(surface.number, { state, title: title ?? surface.title, tab: surface.tab }))
        }}
      />
    )
  } else if (surface.kind === 'subagent') {
    body = <SubagentTranscriptPane runId={surface.runId} />
  } else if (surface.kind === 'file') {
    const Preview = panes.preview
    body = Preview ? <Preview owner={owner} path={surface.path} treeShown={false} standalone /> : null
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
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <T3Button
                          type="button"
                          variant="ghost-muted"
                          size="icon-xs"
                          className="rp-sub-menu"
                          aria-label={text.paneMenu(name || panel.file)}
                          data-testid={`rp-menu-${surface.id}`}
                        />
                      }
                    />
                  }
                >
                  <EllipsisVertical />
                </TooltipTrigger>
                <TooltipPopup>{text.paneMenu(name || panel.file)}</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" side="bottom" sideOffset={6}>
                {groups.flatMap((items, index) => [
                  ...(index > 0 ? [<MenuSeparator key={`sep:${index}`} />] : []),
                  ...items.map((item) =>
                    item.checked === undefined ? (
                      <MenuItem key={item.id} disabled={item.disabled} onClick={() => item.onAction()}>
                        {item.icon}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      </MenuItem>
                    ) : (
                      <MenuCheckboxItem key={item.id} checked={item.checked} disabled={item.disabled} onCheckedChange={() => item.onAction()}>
                        {item.label}
                      </MenuCheckboxItem>
                    )
                  )
                ])}
              </MenuPopup>
            </Menu>
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
                <Button size="sm" variant="primary" onPress={activate} isDisabled={activating} icon={activating ? <Spinner size="xs" /> : undefined} data-testid="rp-activate">
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
