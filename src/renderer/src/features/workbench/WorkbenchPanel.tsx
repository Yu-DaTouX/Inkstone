import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, ExternalLink, FolderOpen, Globe, Maximize2, Minimize2, MoreHorizontal, Rows2, Terminal, X } from 'lucide-react'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Tab, TabList, Tabs } from '../../ui'
import { useI18n } from '../../i18n'
import { useUiV3 } from '../../state/ui-v3'
import { OverviewPane } from './OverviewPane'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { emptyMountState, mountedTabs, nextVisited } from './mount-state'
import { bindPreviewPath, previewPathFor } from './preview-state'
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
  className?: string
  children: ReactNode
}

function TabStrip({ label, selectedKey, open, onSelect, className, children }: TabStripProps): ReactElement {
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
    el.addEventListener('scroll', sync, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(el)
    sync()
    return () => {
      el.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [stripEl, sync])

  return (
    <div
      ref={ref}
      className={className ? `wb-tabstrip ${className}` : 'wb-tabstrip'}
      data-fade-start={edges.start ? '1' : '0'}
      data-fade-end={edges.end ? '1' : '0'}
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
  mode: 'docked' | 'overlay' | 'full'
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

  const mounted = useMemo(() => mountedTabs(visited), [visited])
  const primaryTabs = useMemo(() => mounted.filter((tab) => cellForTab(layout, tab) !== 'secondary'), [mounted, layout])
  const secondaryTabs = useMemo(() => mounted.filter((tab) => cellForTab(layout, tab) === 'secondary'), [mounted, layout])

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
  const [previewBindings, setPreviewBindings] = useState<ReadonlyMap<string, string>>(() => new Map())
  const ownerReady = ownerKey !== null && shownKey === ownerKey && !!owner

  const [displayOwner, setDisplayOwner] = useState<WorkspaceOwner | null>(owner)
  useEffect(() => {
    if (owner && ownerReady) setDisplayOwner(owner)
  }, [owner, ownerReady])

  const handlePreview = (path: string): void => {
    if (displayOwner) setPreviewBindings((prev) => bindPreviewPath(prev, displayOwner.key, path))
    setWorkspaceTab('preview')
    onPreview?.(path)
  }

  const attemptActivation = (tab: WorkbenchTabId): void => {
    if (activating) return
    setActivating(true)
    void onRequestActivation(tab).finally(() => setActivating(false))
  }

  const selectTab = (tab: WorkbenchTabId): void => {
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
      <div className="wb-head">
        {isOverview ? (
          <span className="wb-head-title" data-testid="wb-overview-title">
            {text.overview.title}
          </span>
        ) : (
          <>
            <Button variant="ghost" size="sm" className="wb-back" aria-label={text.overview.backLabel} onPress={() => setWorkspaceTab('overview')} data-testid="wb-back">
              <ArrowLeft size={14} aria-hidden />
              <span>{text.overview.back}</span>
            </Button>
            <TabStrip label={text.title} selectedKey={view} open={open} onSelect={(key) => selectTab(key as WorkbenchTabId)}>
              {WORKBENCH_TABS.filter((tab) => tab === view || visited.has(tab)).map((tab) => (
                <Tab key={tab} id={tab} className="wb-tab" data-testid={`wb-tab-${tab}`}>
                  {text.tabs[tab]}
                </Tab>
              ))}
            </TabStrip>
          </>
        )}
        <div className="wb-actions">
          {isOverview ? (
            <>
              <IconButton aria-label={text.tabs.terminal} title={text.tabs.terminal} data-testid="wb-open-terminal" onPress={() => selectTab('terminal')}>
                <Terminal size={15} />
              </IconButton>
              <IconButton aria-label={text.tabs.files} title={text.tabs.files} data-testid="wb-open-files" onPress={() => selectTab('files')}>
                <FolderOpen size={15} />
              </IconButton>
              <IconButton aria-label={text.tabs.browser} title={text.tabs.browser} data-testid="wb-open-browser" onPress={() => selectTab('browser')}>
                <Globe size={15} />
              </IconButton>
              <MenuTrigger>
                <IconButton aria-label={text.overview.moreTools} title={text.overview.moreTools} data-testid="wb-more-tools">
                  <MoreHorizontal size={15} />
                </IconButton>
                <Popover placement="bottom end" offset={6}>
                  <Menu aria-label={text.overview.moreTools} className="wb-more-menu" data-testid="wb-more-menu">
                    {(['changes', 'preview', 'logs', 'branch'] as const).map((tab) => (
                      <MenuItem key={tab} id={tab} textValue={text.tabs[tab]} onAction={() => selectTab(tab)}>
                        {text.tabs[tab]}
                      </MenuItem>
                    ))}
                  </Menu>
                </Popover>
              </MenuTrigger>
            </>
          ) : (
            <>
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
            </>
          )}
          <IconButton aria-label={text.close} onPress={onClose} data-testid="wb-close" className="wb-close">
            <X size={15} />
          </IconButton>
        </div>
      </div>

      <div className="wb-body">
        {isOverview ? (
          <OverviewPane owner={owner} onOpenView={selectTab} onPreview={handlePreview} />
        ) : null}
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
                    {WORKBENCH_TABS.map((tab) => (
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
          <div className="wb-empty" data-testid="wb-empty">
            {text.inactiveTitle}
          </div>
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
        <div className="wb-nowire">
          <p className="wb-nowire-title">{text.notWired}</p>
          <p className="wb-nowire-hint">{text.notWiredHint}</p>
        </div>
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
