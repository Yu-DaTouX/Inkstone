import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { ArrowRight, Check, Columns2, EllipsisVertical, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react'
import { EmptyState, Focusable, IconButton, Menu, MenuItem, MenuTrigger, Popover, Separator, Tooltip, TooltipTrigger } from '../../ui'
import { TileLayoutView, type TileHandle } from './TileLayout'
import { CHAT_EMPTY_TILE_ID, CHAT_TILE_ID, chatFlexOf, columnLayout, foldChat, layoutWithChat, layoutsEqual, panesOnlyLayout, type TileLayout } from './tile-tree'
import { fitOpenedLayout, withChatMinimum } from './tile-fit'
import { PaneChromeContext, paneMenuSignature, type PaneChrome, type PaneMenuItem } from './pane-chrome'
import { useI18n } from '../../i18n'
import { useUiV3, workspaceLayoutFor } from '../../state/ui-v3'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { previewPathFor, type PreviewOpenOptions } from './preview-state'
import { canTileTool, hasTileRoom, openToolTile, showPreview, usePreviewBindings, useTiledTools } from './tool-tiles'
import { toolTileText } from './tool-tile-text'
import { toolTileRef } from './tool-tile-refs'
import { dropToolInSplit } from '../split/split-actions'
import type { SplitDropTarget } from '../split/split-drop-model'
import { useWorkspaceBranch } from './use-workspace-branch'
import { isSubagentPaneId, isToolPane, subagentRunOfPane } from './subagent-panes'
import { useStore } from '../../state/store'
import { shortcutKeysText, shortcutOverridesFromSettings } from '../../app/shortcuts'
import { SubagentTranscriptPane, subagentPaneName } from '../session/SubagentTranscriptPane'
import {
  WORKBENCH_ACTIVE_TABS,
  WORKBENCH_TABS,
  type PreviewPaneProps,
  type WorkspaceOwner,
  type WorkbenchPaneComponents,
  type WorkbenchTabId,
  type WorkspacePaneId
} from './types'
import './workbench.css'

function subagentPaneTitle(id: string): string {
  const runId = subagentRunOfPane(id)
  const run = runId ? useStore.getState().subagents.find((item) => item.id === runId) : undefined
  return run ? subagentPaneName(run) : ''
}

const POPOUT_TABS: ReadonlySet<WorkbenchTabId> = new Set<WorkbenchTabId>(['context', 'browser', 'terminal'])

export interface WorkbenchPanelProps {
  owner: WorkspaceOwner | null
  open: boolean
  mode: 'docked' | 'full'
  panes: WorkbenchPaneComponents
  chat?: ReactNode
  onClose: () => void
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
  onPreview?: (path: string, options?: PreviewOpenOptions) => void
  onPopout?: (tab: WorkbenchTabId) => void
}

export function WorkbenchPanel({
  owner,
  open,
  mode,
  panes,
  chat,
  onClose,
  onRequestActivation,
  onPreview,
  onPopout
}: WorkbenchPanelProps): ReactElement {
  const { lang } = useI18n()
  const text = useMemo(() => workbenchText(lang), [lang])
  const tileText2 = useMemo(() => toolTileText(lang), [lang])
  const openPanes = useUiV3((s) => s.workspacePanes)
  const expandedPane = useUiV3((s) => s.workspaceExpandedTile)
  const focus = useUiV3((s) => s.workspaceFocus)
  const closeWorkspacePane = useUiV3((s) => s.closeWorkspacePane)
  const setWorkspaceFocus = useUiV3((s) => s.setWorkspaceFocus)
  const storedLayout = useUiV3((s) => s.workspaceLayout)
  const setWorkspaceLayout = useUiV3((s) => s.setWorkspaceLayout)
  const tiled = useTiledTools()
  const [dragging, setDragging] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(0)

  const shownPanes = useMemo(() => openPanes.filter((tab) => !(isToolPane(tab) && tiled.has(tab))), [openPanes, tiled])
  const [visited, setVisited] = useState<ReadonlySet<WorkspacePaneId>>(() => new Set())
  useEffect(() => {
    if (!open) return
    setVisited((prev) =>
      prev.size === shownPanes.length && shownPanes.every((tab) => prev.has(tab)) ? prev : new Set(shownPanes)
    )
  }, [open, shownPanes])

  useEffect(() => {
    for (const tab of openPanes) if (isToolPane(tab) && tiled.has(tab)) closeWorkspacePane(tab)
  }, [openPanes, tiled, closeWorkspacePane])

  useEffect(() => {
    if (!open && focus) setWorkspaceFocus(false)
  }, [open, focus, setWorkspaceFocus])

  const expanded = expandedPane && (shownPanes as readonly string[]).includes(expandedPane) ? (expandedPane as WorkspacePaneId) : null
  const visiblePanes: readonly WorkspacePaneId[] = expanded ? [expanded] : shownPanes

  const liveSessionId = useStore((s) => s.session?.sessionId ?? null)
  useEffect(() => {
    useUiV3.getState().loadLayoutSession(liveSessionId)
  }, [liveSessionId])

  const ownerKey = owner?.key ?? null
  const [shownKey, setShownKey] = useState<string | null>(ownerKey)
  const [prevKey, setPrevKey] = useState<string | null>(ownerKey)
  useLayoutEffect(() => {
    if (prevKey === ownerKey) return
    setShownKey(null)
  }, [ownerKey, prevKey])
  useEffect(() => {
    if (shownKey !== null || prevKey === ownerKey) return
    setPrevKey(ownerKey)
    setShownKey(ownerKey)
  }, [ownerKey, prevKey, shownKey])

  const [activating, setActivating] = useState(false)
  const previewBindings = usePreviewBindings((s) => s.bindings)
  const ownerReady = ownerKey !== null && shownKey === ownerKey && !!owner
  const [displayOwner, setDisplayOwner] = useState<WorkspaceOwner | null>(owner)
  useEffect(() => {
    if (owner && ownerReady) setDisplayOwner(owner)
  }, [owner, ownerReady])

  const activeOwner = displayOwner
  const chatShown = mode === 'docked' && !expanded
  const mounted = useMemo<string[]>(
    () => [
      CHAT_TILE_ID,
      ...(activeOwner || !open ? [] : [CHAT_EMPTY_TILE_ID]),
      ...WORKBENCH_TABS.filter((tab) => visited.has(tab) && !tiled.has(tab)),
      ...openPanes.filter((tab) => isSubagentPaneId(tab) && visited.has(tab))
    ],
    [activeOwner, open, visited, tiled, openPanes]
  )
  const layout = useMemo<TileLayout>(() => {
    const chatFlex = chatFlexOf(storedLayout)
    if (!activeOwner) {
      const idle = layoutWithChat(columnLayout([CHAT_EMPTY_TILE_ID]), chatFlex)
      return open && chatShown ? idle : foldChat(idle)
    }
    if (!open) return layoutWithChat(null, chatFlex)
    const tree = workspaceLayoutFor(storedLayout, shownPanes)
    if (expanded) return foldChat(layoutWithChat(columnLayout([expanded]), chatFlex))
    return chatShown ? tree : foldChat(tree)
  }, [activeOwner, open, expanded, chatShown, storedLayout, shownPanes])

  const branch = useWorkspaceBranch(displayOwner?.cwd ?? null, open && shownPanes.includes('changes'))

  useEffect(() => {
    const element = bodyRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const read = (): void => setBodyWidth(element.clientWidth)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const openedPanes = useRef<readonly WorkspacePaneId[] | null>(null)
  useLayoutEffect(() => {
    const previous = openedPanes.current
    openedPanes.current = shownPanes
    if (!open || !activeOwner || expanded || previous === null || bodyWidth <= 0) return
    if (!shownPanes.some((tab) => !previous.includes(tab))) return
    const next = fitOpenedLayout(storedLayout, bodyWidth)
    if (layoutsEqual(next, storedLayout)) return
    setWorkspaceLayout(next, [])
  }, [shownPanes, open, activeOwner, bodyWidth, storedLayout, setWorkspaceLayout])

  const restoredFor = useRef<string | null>(null)
  const lastWidth = useRef(0)
  useLayoutEffect(() => {
    if (!open || !activeOwner || expanded || bodyWidth <= 0) return
    const grew = bodyWidth > lastWidth.current + 1
    lastWidth.current = bodyWidth
    const restore = restoredFor.current !== activeOwner.key
    if (!restore && !grew) return
    if (restore) restoredFor.current = activeOwner.key
    if (shownPanes.length === 0) return
    const next = withChatMinimum(storedLayout, bodyWidth)
    if (layoutsEqual(next, storedLayout)) return
    setWorkspaceLayout(next, [CHAT_TILE_ID])
  }, [activeOwner, open, bodyWidth, storedLayout, shownPanes, setWorkspaceLayout])

  const handlePreview = (path: string, options?: PreviewOpenOptions): void => {
    showPreview(displayOwner?.key ?? null, path, options)
    onPreview?.(path)
  }

  const emptiesPanel = (tab: WorkspacePaneId): boolean => shownPanes.every((other) => other === tab)

  const moveBesideChat = (tab: WorkbenchTabId, target?: SplitDropTarget): void => {
    const current = owner?.sessionId || owner?.sessionFile ? { sessionId: owner.sessionId ?? undefined, path: owner.sessionFile } : null
    const placed = target ? dropToolInSplit(toolTileRef(tab), target, current) : openToolTile(tab, current, undefined, emptiesPanel(tab))
    if (!placed) return
    setWorkspaceFocus(false)
    closeWorkspacePane(tab)
  }

  const tileText = useMemo(
    () => ({
      move: text.move,
      moveSide: text.moveSide,
      moveSideHint: text.moveSideHint,
      moveInstructions: text.moveInstructions,
      movedTo: text.movedTo,
      moveCancelled: text.moveCancelled,
      resize: text.resize
    }),
    [text]
  )

  const attemptActivation = (tab: WorkbenchTabId): void => {
    if (activating) return
    setActivating(true)
    void onRequestActivation(tab)
      .catch(() => useStore.getState().notify('error', text.activateFailed))
      .finally(() => setActivating(false))
  }

  const toggleExpand = (tab: WorkspacePaneId): void => {
    useUiV3.getState().toggleWorkspaceExpanded(tab)
  }

  const closePane = (tab: WorkspacePaneId): void => {
    if (shownPanes.length <= 1) {
      closeWorkspacePane(tab)
      onClose()
      return
    }
    closeWorkspacePane(tab)
  }

  const inactive = !activeOwner && open

  return (
    <section
      className="wb-panel"
      data-open={open ? '1' : '0'}
      data-mode={mode}
      data-focus={expanded ? '1' : '0'}
      data-dragging={dragging ? '1' : undefined}
      hidden={!open && !chat}
      role="region"
      aria-label={text.title}
    >
      <div className="wb-body" data-chat={chatShown ? '1' : undefined} ref={bodyRef}>
        <TileLayoutView
          layout={layout}
          mounted={mounted}
          dragDisabled={!!expanded || inactive}
          text={tileText}
          tileName={(id) => (id === CHAT_TILE_ID ? text.chatName : isToolPane(id) ? text.tabs[id] : subagentPaneTitle(id))}
          onLayoutChange={(next) => {
            if (expanded || inactive) return
            if (chatShown) {
              setWorkspaceLayout(next)
              return
            }
            setWorkspaceLayout(layoutWithChat(panesOnlyLayout(next), chatFlexOf(storedLayout)), [])
          }}
          canMoveOut={(id) => mode !== 'full' && canTileTool(id) && hasTileRoom(emptiesPanel(id))}
          onMoveOut={(id, target) => {
            if (canTileTool(id)) moveBesideChat(id, target)
          }}
          onDraggingChange={setDragging}
          renderTile={(id, handle) => {
            if (id === CHAT_TILE_ID) return chat ?? null
            if (id === CHAT_EMPTY_TILE_ID) return <EmptyState className="wb-empty" data-testid="wb-empty" title={text.inactiveTitle} />
            if (!activeOwner) return null
            const tab = id as WorkspacePaneId
            const tool = isToolPane(tab) ? tab : null
            const shown = open && ownerReady && visiblePanes.includes(tab)
            return (
              <PaneCard
                tab={tab}
                shown={shown}
                expanded={expanded === tab}
                suppress={dragging}
                blocked={!activeOwner.active && WORKBENCH_ACTIVE_TABS.has(tab)}
                owner={activeOwner}
                panes={panes}
                text={text}
                title={tab === 'changes' && branch ? `${branch}` : tool ? text.tabs[tool] : ''}
                scope={tab === 'changes' && branch ? text.changesScope : undefined}
                previewPath={previewPathFor(previewBindings, activeOwner.key)}
                activating={activating}
                canPopout={!!tool && POPOUT_TABS.has(tool) && !!onPopout}
                canMoveBeside={mode !== 'full' && canTileTool(tab)}
                moveBesideLabel={tileText2.tileOut}
                onActivate={() => tool && attemptActivation(tool)}
                onPreview={handlePreview}
                onToggleExpand={() => toggleExpand(tab)}
                onClose={() => closePane(tab)}
                onPopout={() => tool && onPopout?.(tool)}
                onMoveBeside={() => tool && moveBesideChat(tool)}
                handle={handle}
              />
            )
          }}
        />
      </div>
    </section>
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

interface PaneCardProps {
  tab: WorkspacePaneId
  shown: boolean
  expanded: boolean
  suppress: boolean
  blocked: boolean
  owner: WorkspaceOwner
  panes: WorkbenchPaneComponents
  text: WorkbenchText
  title: string
  scope?: string
  previewPath?: string
  activating: boolean
  canPopout: boolean
  canMoveBeside: boolean
  moveBesideLabel: string
  onActivate: () => void
  onPreview?: (path: string, options?: PreviewOpenOptions) => void
  onToggleExpand: () => void
  onClose: () => void
  onPopout: () => void
  onMoveBeside: () => void
  handle: TileHandle
}

function PaneCard({
  tab,
  shown,
  expanded,
  suppress,
  blocked,
  owner,
  panes,
  text,
  title,
  scope,
  previewPath,
  activating,
  canPopout,
  canMoveBeside,
  moveBesideLabel,
  onActivate,
  onPreview,
  onToggleExpand,
  onClose,
  onPopout,
  onMoveBeside,
  handle
}: PaneCardProps): ReactElement {
  const [gripTip, setGripTip] = useState(false)
  const shortcutOverrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const closeTip = `${text.closePane} · ${shortcutKeysText('workspaceClosePane', shortcutOverrides)}`
  const expandTip = `${expanded ? text.collapse : text.expand} · ${shortcutKeysText('workspaceToggleMaximize', shortcutOverrides)}`
  const dragging = handle.dragging
  const tool = isToolPane(tab) ? tab : null
  const agentRunId = tool ? null : subagentRunOfPane(tab)
  const Body = tool ? (panes[tool] as ComponentType<LeafProps> | undefined) : undefined
  const agentName = useStore((s) => {
    const run = agentRunId ? s.subagents.find((item) => item.id === agentRunId) : undefined
    return run ? subagentPaneName(run) : ''
  })
  const name = tool ? text.tabs[tool] : agentName
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null)
  const [toolsEl, setToolsEl] = useState<HTMLElement | null>(null)
  const [menuGroups, setMenuGroups] = useState<ReadonlyMap<string, readonly PaneMenuItem[]>>(() => new Map())
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
  const paneGroups = [...menuGroups.entries()].sort(([a], [b]) => menuSourceRank(a) - menuSourceRank(b)).map(([, items]) => items)
  const paneMenu = paneGroups.flat()
  const chrome = useMemo<PaneChrome>(() => ({ title: titleEl, tools: toolsEl, setMenu }), [titleEl, toolsEl, setMenu])
  const menuItems: PaneMenuItem[] = [
    ...(canMoveBeside ? [{ id: 'card:beside', label: moveBesideLabel, icon: <Columns2 size={14} aria-hidden />, onAction: onMoveBeside }] : []),
    ...(canPopout ? [{ id: 'card:popout', label: text.popout, icon: <ExternalLink size={14} aria-hidden />, onAction: onPopout }] : [])
  ]
  const allItems = [...paneMenu, ...menuItems]
  return (
    <div
      className="wb-card"
      data-tab={tab}
      data-expanded={expanded ? '1' : '0'}
      data-dragging={dragging ? '1' : undefined}
      hidden={!shown}
      data-testid={`wb-card-${tab}`}
    >
      <div className="wb-card-head" data-testid={`wb-card-head-${tab}`}>
        <TooltipTrigger delay={300} isOpen={handle.previewing || (gripTip && !dragging)} onOpenChange={setGripTip}>
          <Focusable>
            <button
              type="button"
              className="wb-card-grip"
              aria-label={handle.label}
              aria-describedby={handle.describedBy}
              data-tile-handle={tab}
              data-active={dragging ? '1' : undefined}
              data-testid={`wb-card-grip-${tab}`}
              onPointerDown={handle.onPointerDown}
              onMouseDown={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                setGripTip(false)
                handle.onKeyDown(event)
              }}
              onBlur={handle.onBlur}
            >
              <span className="wb-card-grip-bar" aria-hidden />
            </button>
          </Focusable>
          <Tooltip placement="bottom">{handle.tooltip}</Tooltip>
        </TooltipTrigger>
        <span className="wb-card-titleslot" ref={setTitleEl} />
        <span className="wb-card-title" title={scope ? `${title} → ${scope}` : title}>
          <span className="wb-card-name">{title}</span>
          {scope ? (
            <>
              <ArrowRight size={12} className="wb-card-arrow" aria-hidden />
              <span className="wb-card-name">{scope}</span>
            </>
          ) : null}
        </span>
        <span className="wb-card-actions">
          <span className="wb-card-tools" ref={setToolsEl} />
          {allItems.length > 0 ? (
            <MenuTrigger>
              <IconButton size="sm" aria-label={text.paneMenu(name)} title={text.paneMenu(name)} data-testid={`wb-card-menu-${tab}`}>
                <EllipsisVertical size={14} />
              </IconButton>
              <Popover placement="bottom end" offset={4}>
                <Menu
                  aria-label={text.paneMenu(name)}
                  disabledKeys={allItems.filter((item) => item.disabled).map((item) => item.id)}
                  onAction={(key) => allItems.find((item) => item.id === key)?.onAction()}
                >
                  {paneGroups.flatMap((items, index) => [
                    ...(index > 0 ? [<Separator key={`sep:${index}`} />] : []),
                    ...items.map((item) => (
                      <MenuItem key={item.id} id={item.id} textValue={item.label} aria-checked={item.checked}>
                        {item.checked === undefined ? item.icon : <span className="wb-card-check" aria-hidden>{item.checked ? <Check size={14} /> : null}</span>}
                        {item.label}
                      </MenuItem>
                    ))
                  ])}
                  {paneMenu.length > 0 && menuItems.length > 0 ? <Separator /> : null}
                  {menuItems.map((item) => (
                    <MenuItem key={item.id} id={item.id} textValue={item.label}>
                      {item.icon}
                      {item.label}
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
          ) : null}
          <IconButton
            size="sm"
            aria-label={expanded ? text.collapse : text.expand}
            title={expandTip}
            aria-pressed={expanded}
            data-testid={`wb-card-expand-${tab}`}
            onPress={onToggleExpand}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          <IconButton size="sm" aria-label={text.closePane} title={closeTip} data-testid={`wb-card-close-${tab}`} onPress={onClose}>
            <X size={14} />
          </IconButton>
        </span>
      </div>
      <div className="wb-card-body">
        <div className="wb-pane" data-tab={tab} data-visible={shown ? '1' : '0'} data-testid={`wb-pane-${tab}`}>
          {agentRunId ? (
            <PaneChromeContext.Provider value={chrome}><SubagentTranscriptPane runId={agentRunId} /></PaneChromeContext.Provider>
          ) : Body ? <PaneChromeContext.Provider value={chrome}><Body owner={owner} visible={shown && !blocked && !(suppress && tab === 'browser')} onPreview={onPreview} path={previewPath} Preview={tab === 'files' ? panes.preview : undefined} /></PaneChromeContext.Provider> : (
            <EmptyState className="wb-nowire" title={text.notWired} description={text.notWiredHint} />
          )}
          {blocked ? (
            <div className="wb-pane-block">
              <p>{text.activateHint}</p>
              <button type="button" onClick={onActivate} disabled={activating} data-testid="wb-pane-activate">
                {text.activate}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
