import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react'
import { Columns2, ExternalLink, Maximize2, Minimize2, Rows2, X } from 'lucide-react'
import { EmptyState, IconButton, Tab, TabList, Tabs } from '../../ui'
import { useI18n } from '../../i18n'
import { useUiV3 } from '../../state/ui-v3'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { emptyMountState, mountedTabs, nextVisited } from './mount-state'
import { previewPathFor } from './preview-state'
import { canTileTool, hasTileRoom, openToolTile, revealToolTile, showPreview, usePreviewBindings, useTiledTools, useTileRoom } from './tool-tiles'
import { trackTileDrag } from './tile-drag'
import { toolTileText } from './tool-tile-text'
import {
  cellForTab,
  extraVisibleTabs,
  nextSplitTab,
  resolvePanelLayout,
  splitTabOnPrimaryChange
} from './panel-layout'
import {
  WORKBENCH_ACTIVE_TABS,
  WORKBENCH_TABS,
  type WorkspaceOwner,
  type WorkbenchPaneComponents,
  type WorkbenchTabId
} from './types'
import './workbench.css'

const POPOUT_TABS: ReadonlySet<WorkbenchTabId> = new Set<WorkbenchTabId>(['context', 'browser', 'terminal'])

function canRequestPopout(tab: WorkbenchTabId): boolean {
  return POPOUT_TABS.has(tab)
}

interface TabStripProps {
  label: string
  selectedKey: string
  open: boolean
  onSelect: (key: string) => void
  onPointerDownCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void
  className?: string
  children: ReactNode
}

function TabStrip({ label, selectedKey, open, onSelect, onPointerDownCapture, className, children }: TabStripProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const stripEl = useCallback((): HTMLElement | null => ref.current?.querySelector<HTMLElement>('.wb-tablist') ?? null, [])

  const sync = useCallback((): void => {
    const el = stripEl()
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    const next = { start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 }
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [stripEl])

  useLayoutEffect(() => {
    if (!open) return
    stripEl()?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    sync()
  }, [selectedKey, open, stripEl, sync])

  useEffect(() => {
    const el = stripEl()
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      if (el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += event.deltaY
      event.preventDefault()
    }
    el.addEventListener('scroll', sync, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(el)
    sync()
    return () => {
      el.removeEventListener('scroll', sync)
      el.removeEventListener('wheel', onWheel)
      observer?.disconnect()
    }
  }, [stripEl, sync])

  return (
    <div
      ref={ref}
      className={className ? `wb-tabstrip ${className}` : 'wb-tabstrip'}
      data-fade-start={edges.start ? '1' : '0'}
      data-fade-end={edges.end ? '1' : '0'}
      onPointerDownCapture={onPointerDownCapture}
    >
      <Tabs selectedKey={selectedKey} onSelectionChange={(key) => onSelect(String(key))}>
        <TabList aria-label={label} className="wb-tablist">
          {children}
        </TabList>
      </Tabs>
    </div>
  )
}

export interface WorkbenchPanelProps {
  owner: WorkspaceOwner | null
  open: boolean
  mode: 'docked' | 'full'
  panes: WorkbenchPaneComponents
  onClose: () => void
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
  onPreview?: (path: string) => void
  onPopout?: (tab: WorkbenchTabId) => void
}

export function WorkbenchPanel({
  owner,
  open,
  mode,
  panes,
  onClose,
  onRequestActivation,
  onPreview,
  onPopout
}: WorkbenchPanelProps): ReactElement {
  const { lang } = useI18n()
  const text = useMemo(() => workbenchText(lang), [lang])
  const view = useUiV3((s) => s.workspaceTab)
  const setWorkspaceTab = useUiV3((s) => s.setWorkspaceTab)
  const isOverview = view === 'overview'
  const lastToolRef = useRef<WorkbenchTabId>(view === 'overview' ? 'changes' : view)
  if (!isOverview) lastToolRef.current = view
  const activeTab = lastToolRef.current
  const split = useUiV3((s) => s.workspaceSplit)
  const splitTab = useUiV3((s) => s.workspaceSplitTab)
  const focus = useUiV3((s) => s.workspaceFocus)
  const setWorkspaceSplitTab = useUiV3((s) => s.setWorkspaceSplitTab)
  const toggleWorkspaceSplit = useUiV3((s) => s.toggleWorkspaceSplit)
  const setWorkspaceFocus = useUiV3((s) => s.setWorkspaceFocus)
  const toggleWorkspaceFocus = useUiV3((s) => s.toggleWorkspaceFocus)

  const layout = useMemo(
    () => resolvePanelLayout({ split, focus, activeTab, splitTab }),
    [split, focus, activeTab, splitTab]
  )

  const [visited, setVisited] = useState<ReadonlySet<WorkbenchTabId>>(emptyMountState)
  const extraTabs = useMemo(() => extraVisibleTabs(layout), [layout.secondary])
  useEffect(() => {
    setVisited((prev) => nextVisited(prev, { open: open && !isOverview, activeTab, extra: isOverview ? [] : extraTabs }))
  }, [open, isOverview, activeTab, extraTabs])

  useEffect(() => {
    if (!open && focus) setWorkspaceFocus(false)
  }, [open, focus, setWorkspaceFocus])

  const tiled = useTiledTools()
  const tileText = useMemo(() => toolTileText(lang), [lang])
  useEffect(() => {
    if (!isOverview && tiled.has(view)) {
      const rest = WORKBENCH_TABS.find((tab) => visited.has(tab) && !tiled.has(tab))
      setWorkspaceTab(rest ?? 'overview')
      if (!rest) onClose()
    }
    if (split && tiled.has(splitTab)) {
      const next = WORKBENCH_TABS.find((tab) => tab !== activeTab && !tiled.has(tab))
      if (next) setWorkspaceSplitTab(next)
    }
  }, [isOverview, view, split, splitTab, activeTab, visited, tiled, setWorkspaceTab, setWorkspaceSplitTab, onClose])

  const mounted = useMemo(() => mountedTabs(visited).filter((tab) => !tiled.has(tab)), [visited, tiled])
  const primaryTabs = useMemo(() => mounted.filter((tab) => cellForTab(layout, tab) !== 'secondary'), [mounted, layout])
  const secondaryTabs = useMemo(() => mounted.filter((tab) => cellForTab(layout, tab) === 'secondary'), [mounted, layout])
  const emptiesToolbar = (tab: WorkbenchTabId): boolean => mounted.every((other) => other === tab)
  const tileRoom = useTileRoom(open && mode !== 'full', activeTab, emptiesToolbar(activeTab))

  const ownerKey = owner?.key ?? null
  const [shownKey, setShownKey] = useState<string | null>(ownerKey)
  const prevKeyRef = useRef<string | null>(ownerKey)
  useLayoutEffect(() => {
    const next = owner?.key ?? null
    if (prevKeyRef.current === next) return
    setShownKey(null)
  }, [owner?.key])
  useEffect(() => {
    const next = owner?.key ?? null
    if (shownKey !== null || prevKeyRef.current === next) return
    prevKeyRef.current = next
    setShownKey(next)
  }, [owner?.key, shownKey])

  const [activating, setActivating] = useState(false)
  const previewBindings = usePreviewBindings((s) => s.bindings)
  const ownerReady = ownerKey !== null && shownKey === ownerKey && !!owner

  const [displayOwner, setDisplayOwner] = useState<WorkspaceOwner | null>(owner)
  useEffect(() => {
    if (owner && ownerReady) setDisplayOwner(owner)
  }, [owner, ownerReady])

  const handlePreview = (path: string): void => {
    showPreview(displayOwner?.key ?? null, path)
    onPreview?.(path)
  }

  const tileOut = (tab: WorkbenchTabId, at?: number): void => {
    const current = owner?.sessionId || owner?.sessionFile ? { sessionId: owner.sessionId ?? undefined, path: owner.sessionFile } : null
    const empties = emptiesToolbar(tab)
    if (!openToolTile(tab, current, at, empties)) return
    setWorkspaceFocus(false)
    if (!empties) return
    setWorkspaceTab('overview')
    onClose()
  }

  const dragTabOut = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-tool]')?.dataset.tool
    if (mode === 'full' || !tab || !canTileTool(tab) || !hasTileRoom(emptiesToolbar(tab))) return
    trackTileDrag(event, { id: `tool:${tab}`, title: text.tabs[tab] }, (at) => tileOut(tab, at))
  }

  const attemptActivation = (tab: WorkbenchTabId): void => {
    if (activating) return
    setActivating(true)
    void onRequestActivation(tab).finally(() => setActivating(false))
  }

  const selectTab = (tab: WorkbenchTabId): void => {
    if (tiled.has(tab) && revealToolTile(tab)) return
    const swap = splitTabOnPrimaryChange({ split, splitTab, prevActive: activeTab, nextActive: tab })
    if (swap) setWorkspaceSplitTab(swap)
    setWorkspaceTab(tab)
    if (!owner || owner.active || !WORKBENCH_ACTIVE_TABS.has(tab)) return
    attemptActivation(tab)
  }

  const selectSecondary = (tab: WorkbenchTabId): void => {
    const next = nextSplitTab(splitTab, activeTab, tab)
    if (next) setWorkspaceSplitTab(next)
    if (!owner || owner.active || !WORKBENCH_ACTIVE_TABS.has(tab)) return
    attemptActivation(tab)
  }

  const renderPane = (tab: WorkbenchTabId, cell: 'primary' | 'secondary', ownerForPane: WorkspaceOwner): ReactElement => (
    <PaneSlot
      key={tab}
      tab={tab}
      containerVisible={open && !isOverview && ownerReady && cellForTab(layout, tab) === cell}
      blocked={!ownerForPane.active && WORKBENCH_ACTIVE_TABS.has(tab)}
      owner={ownerForPane}
      panes={panes}
      text={text}
      previewPath={previewPathFor(previewBindings, ownerForPane.key)}
      activating={activating}
      onActivate={() => attemptActivation(tab)}
      onPreview={handlePreview}
    />
  )

  return (
    <section
      className="wb-panel"
      data-open={open ? '1' : '0'}
      data-mode={mode}
      data-focus={focus ? '1' : '0'}
      role="region"
      aria-label={text.title}
      hidden={!open}
    >
      {isOverview ? null : (
        <div className="wb-head">
          <TabStrip label={text.title} selectedKey={view} open={open} onSelect={(key) => selectTab(key as WorkbenchTabId)} onPointerDownCapture={dragTabOut}>
            {WORKBENCH_TABS.filter((tab) => (tab === view || visited.has(tab)) && !tiled.has(tab)).map((tab) => (
              <Tab key={tab} id={tab} className="wb-tab" data-testid={`wb-tab-${tab}`} data-tool={tab}>
                {text.tabs[tab]}
              </Tab>
            ))}
          </TabStrip>
          <div className="wb-actions">
            {mode === 'full' ? null : (
              <IconButton
                aria-label={tileRoom ? tileText.tileOut : tileText.noRoom}
                title={tileRoom ? tileText.tileOut : tileText.noRoom}
                isDisabled={!canTileTool(activeTab) || !tileRoom}
                data-testid="wb-tile-out"
                onPress={() => tileOut(activeTab)}
              >
                <Columns2 size={15} />
              </IconButton>
            )}
            <IconButton
              aria-label={split ? text.unsplit : text.split}
              title={split ? text.unsplit : text.split}
              isDisabled={focus}
              data-active={split ? '1' : '0'}
              data-testid="wb-split"
              onPress={toggleWorkspaceSplit}
            >
              <Rows2 size={15} />
            </IconButton>
            <IconButton
              aria-label={focus ? text.unfocus : text.focus}
              title={focus ? text.unfocus : text.focus}
              data-active={focus ? '1' : '0'}
              data-testid="wb-focus"
              onPress={toggleWorkspaceFocus}
            >
              {focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
            <IconButton
              aria-label={canRequestPopout(activeTab) ? text.popout : `${text.popout}（${text.unmigrated}）`}
              title={canRequestPopout(activeTab) ? text.popout : `${text.popout} · ${text.unmigrated}`}
              isDisabled={!canRequestPopout(activeTab) || !onPopout}
              data-testid="wb-popout"
              onPress={() => onPopout?.(activeTab)}
            >
              <ExternalLink size={15} />
            </IconButton>
            <IconButton aria-label={text.close} onPress={onClose} data-testid="wb-close" className="wb-close">
              <X size={15} />
            </IconButton>
          </div>
        </div>
      )}

      <div className="wb-body">
        <div className="wb-view" hidden={isOverview}>
        {displayOwner ? (
          <div className="wb-cells" data-split={layout.secondary ? '1' : '0'}>
            <div className="wb-cell">
              <div className="wb-panes">{primaryTabs.map((tab) => renderPane(tab, 'primary', displayOwner))}</div>
            </div>
            {layout.secondary ? (
              <div className="wb-cell wb-cell-secondary" data-testid="wb-split-secondary">
                <div className="wb-cell-head">
                  <TabStrip
                    label={text.secondaryPane}
                    selectedKey={layout.secondary}
                    open={open}
                    onSelect={(key) => selectSecondary(key as WorkbenchTabId)}
                  >
                    {WORKBENCH_TABS.filter((tab) => !tiled.has(tab)).map((tab) => (
                      <Tab
                        key={tab}
                        id={tab}
                        className="wb-tab"
                        isDisabled={tab === layout.primary}
                        data-testid={`wb-split-tab-${tab}`}
                      >
                        {text.tabs[tab]}
                      </Tab>
                    ))}
                  </TabStrip>
                </div>
                <div className="wb-panes">
                  {secondaryTabs.map((tab) => renderPane(tab, 'secondary', displayOwner))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState className="wb-empty" data-testid="wb-empty" title={text.inactiveTitle} />
        )}
        </div>
      </div>
    </section>
  )
}

interface LeafProps {
  owner: WorkspaceOwner
  visible?: boolean
  onPreview?: (path: string) => void
  path?: string
}

interface PaneSlotProps {
  tab: WorkbenchTabId
  containerVisible: boolean
  blocked: boolean
  owner: WorkspaceOwner
  panes: WorkbenchPaneComponents
  text: WorkbenchText
  previewPath?: string
  activating: boolean
  onActivate: () => void
  onPreview?: (path: string) => void
}

function PaneSlot({ tab, containerVisible, blocked, owner, panes, text, previewPath, activating, onActivate, onPreview }: PaneSlotProps): ReactElement {
  const Body = panes[tab] as ComponentType<LeafProps> | undefined
  const leafVisible = containerVisible && !blocked
  return (
    <div className="wb-pane" data-tab={tab} data-visible={containerVisible ? '1' : '0'} hidden={!containerVisible} data-testid={`wb-pane-${tab}`}>
      {Body ? <Body owner={owner} visible={leafVisible} onPreview={onPreview} path={previewPath} /> : (
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
  )
}
