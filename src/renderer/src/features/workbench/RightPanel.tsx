import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import {
  Bot,
  EllipsisVertical,
  Eye,
  FileDiff,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Globe,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  ScrollText,
  Smartphone,
  SquareStack,
  Terminal,
  type LucideIcon
} from 'lucide-react'
import { Button, EmptyState, IconButton, Kbd, ListRow, Menu, MenuItem, MenuTrigger, PanelTab, PanelTabList, Popover, Separator, Sheet, Spinner, Splitter } from '../../ui'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { createFrameBatch } from '../../app/frame-batch'
import { shortcutKeysText, shortcutOverridesFromSettings } from '../../app/shortcuts'
import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STEP,
  clampPanelWidth,
  fileSurface,
  panelMaxWidth,
  pullRequestSurface,
  toolSurface,
  useRightPanel,
  useRightPanelEntry,
  type PanelToolKind,
  type RightPanelSurface
} from '../../state/right-panel'
import { SubagentTranscriptPane, subagentPaneName } from '../session/SubagentTranscriptPane'
import { PullRequestDetail } from '../github/PullRequestDetail'
import { OverviewPane } from './OverviewPane'
import { PaneChromeContext, paneMenuSignature, type PaneChrome, type PaneMenuItem } from './pane-chrome'
import { previewPathFor, type PreviewOpenOptions } from './preview-state'
import { usePreviewBindings } from './preview-bindings'
import { rightPanelText, type RightPanelText } from './right-panel-text'
import { workbenchText, type WorkbenchText } from './workbench-text'
import { WORKBENCH_ACTIVE_TABS, type PreviewPaneProps, type WorkbenchPaneComponents, type WorkbenchTabId, type WorkspaceOwner } from './types'
import './right-panel.css'

export type RightPanelMode = 'inline' | 'sheet'

export interface RightPanelProps {
  owner: WorkspaceOwner | null
  mode: RightPanelMode
  room: number
  panes: WorkbenchPaneComponents
  onOpenTool: (kind: PanelToolKind) => void
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
}

const TOOL_ICONS: Record<PanelToolKind, LucideIcon> = {
  changes: FileDiff,
  terminal: Terminal,
  files: FolderOpen,
  browser: Globe,
  context: SquareStack,
  branch: GitBranch,
  logs: ScrollText,
  quota: Gauge,
  device: Smartphone,
  pullRequests: GitPullRequest,
  overview: LayoutDashboard
}

interface LauncherAction {
  kind: PanelToolKind
  key: string
}

const LAUNCHER: readonly LauncherAction[] = [
  { kind: 'changes', key: 'D' },
  { kind: 'terminal', key: 'T' },
  { kind: 'files', key: 'F' },
  { kind: 'browser', key: 'B' },
  { kind: 'pullRequests', key: 'P' },
  { kind: 'device', key: 'M' },
  { kind: 'overview', key: 'O' },
  { kind: 'context', key: 'C' },
  { kind: 'branch', key: 'G' },
  { kind: 'logs', key: 'L' },
  { kind: 'quota', key: 'Q' }
]

function launcherFor(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): LauncherAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  return LAUNCHER.find((item) => item.key.toLowerCase() === event.key.toLowerCase()) ?? null
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function toolLabel(kind: PanelToolKind, text: WorkbenchText, panel: RightPanelText): string {
  return kind === 'overview' ? panel.overview : text.tabs[kind]
}

function PrStateIcon({ state }: { state?: string }): ReactElement {
  if (state === 'merged') return <GitMerge data-tone="merged" aria-hidden />
  if (state === 'closed') return <GitPullRequestClosed data-tone="closed" aria-hidden />
  if (state === 'draft') return <GitPullRequestDraft data-tone="draft" aria-hidden />
  return <GitPullRequest data-tone={state === 'open' ? 'open' : undefined} aria-hidden />
}

function SurfaceIcon({ surface }: { surface: RightPanelSurface }): ReactElement {
  if (surface.kind === 'file') return <FileText aria-hidden />
  if (surface.kind === 'pullRequest') return <PrStateIcon state={surface.state} />
  if (surface.kind === 'subagent') return <Bot aria-hidden />
  const Icon = TOOL_ICONS[surface.kind]
  return <Icon aria-hidden />
}

function useSurfaceLabel(): (surface: RightPanelSurface) => string {
  const { lang } = useI18n()
  const text = workbenchText(lang)
  const panel = rightPanelText(lang)
  const subagents = useStore((s) => s.subagents)
  return useCallback(
    (surface) => {
      if (surface.kind === 'file') return baseName(surface.path)
      if (surface.kind === 'pullRequest') return panel.pullRequest(surface.number)
      if (surface.kind === 'subagent') {
        const run = subagents.find((item) => item.id === surface.runId)
        return run ? subagentPaneName(run) : panel.subagent
      }
      return toolLabel(surface.kind, text, panel)
    },
    [text, panel, subagents]
  )
}

export function RightPanel({ owner, mode, room, panes, onOpenTool, onRequestActivation }: RightPanelProps): ReactElement | null {
  const { lang } = useI18n()
  const text = workbenchText(lang)
  const panel = rightPanelText(lang)
  const entry = useRightPanelEntry()
  const width = useRightPanel((s) => s.width)
  const labelOf = useSurfaceLabel()
  const open = entry.open
  const active = entry.surfaces.find((item) => item.id === entry.active) ?? null
  const maximized = mode === 'inline' && entry.maximized
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [adding, setAdding] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  anchorRef.current = menu?.anchor ?? null
  const shortcutOverrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const ownerKey = owner?.key ?? ''
  const [visited, setVisited] = useState<{ owner: string; ids: ReadonlySet<string> }>({ owner: ownerKey, ids: new Set() })
  const visitedIds = visited.owner === ownerKey ? visited.ids : new Set<string>()

  useEffect(() => {
    if (!open || !active) return
    setVisited((prev) => (prev.owner === ownerKey && prev.ids.has(active.id) ? prev : { owner: ownerKey, ids: new Set([...(prev.owner === ownerKey ? prev.ids : []), active.id]) }))
  }, [open, active, ownerKey])

  const barRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open || !entry.active) return
    const tab = barRef.current?.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(entry.active)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [open, entry.active, entry.surfaces.length])

  const mounted = entry.surfaces.filter((item) => visitedIds.has(item.id) || item.id === active?.id)
  const shownWidth = clampPanelWidth(width, room)
  const axis = 4000
  const resize = useMemo(() => createFrameBatch<number>((next) => useRightPanel.getState().setWidth(next)), [])
  useEffect(() => () => resize.flush(), [resize])

  const closeTab = (id: string): void => useRightPanel.getState().close(id)

  const runLauncher = (action: LauncherAction): void => {
    setAdding(false)
    onOpenTool(action.kind)
  }

  const onPanelKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'PageDown' || event.key === 'PageUp')) {
      event.preventDefault()
      useRightPanel.getState().step(event.key === 'PageDown' ? 1 : -1)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.rp-tabs [role="tab"][aria-selected="true"]')?.focus())
    }
  }

  const closeShortcut = shortcutKeysText('workspaceClosePane', shortcutOverrides)
  const maximizeShortcut = shortcutKeysText('workspaceToggleMaximize', shortcutOverrides)
  const withKeys = (label: string, keys: string): string => (keys ? `${label} · ${keys}` : label)
  const shortcutOrNone = (keys: string): string | undefined => keys || undefined

  const menuSurface = menu ? entry.surfaces.find((item) => item.id === menu.id) : undefined
  const menuIndex = menuSurface ? entry.surfaces.indexOf(menuSurface) : -1

  const single = entry.surfaces.length === 1
  const addTab = (
    <MenuTrigger isOpen={adding} onOpenChange={setAdding}>
      <IconButton size="sm" aria-label={panel.newTab} tooltip={panel.newTab} data-testid="rp-new-tab" className="rp-bar-add">
        <Plus size={14} />
      </IconButton>
      <Popover placement="bottom start" offset={4}>
        <div
          className="rp-launch-menu"
          onKeyDownCapture={(event) => {
            const action = launcherFor(event)
            if (!action) return
            event.preventDefault()
            event.stopPropagation()
            runLauncher(action)
          }}
        >
          <Menu aria-label={panel.newTab} data-testid="rp-new-tab-menu" onAction={(key) => {
            const action = LAUNCHER.find((item) => item.kind === key)
            if (action) runLauncher(action)
          }}>
            {LAUNCHER.map((action) => {
              const Icon = TOOL_ICONS[action.kind]
              const label = toolLabel(action.kind, text, panel)
              return (
                <MenuItem key={action.kind} id={action.kind} textValue={label} aria-keyshortcuts={action.key} icon={<Icon size={14} />} shortcut={action.key}>
                  {label}
                </MenuItem>
              )
            })}
          </Menu>
        </div>
      </Popover>
    </MenuTrigger>
  )

  const content = (
    <section
      className="rp"
      role="region"
      aria-label={panel.panel}
      data-mode={mode}
      data-maximized={maximized ? '1' : undefined}
      data-testid="rp"
      style={mode === 'inline' && !maximized ? ({ width: shownWidth, '--rp-w': `${shownWidth}px` } as CSSProperties) : undefined}
      onKeyDown={onPanelKey}
    >
      {mode === 'inline' && !maximized ? (
        <Splitter
          className="rp-resizer ui-splitter--edge"
          orientation="vertical"
          value={axis - shownWidth}
          min={axis - panelMaxWidth(room)}
          max={axis - PANEL_WIDTH_MIN}
          step={PANEL_WIDTH_STEP}
          aria-label={panel.resize}
          title={panel.resize}
          data-testid="rp-resizer"
          onChange={(left) => resize.schedule(axis - left)}
          onReset={() => {
            resize.cancel()
            useRightPanel.getState().setWidth(PANEL_WIDTH_DEFAULT)
          }}
        />
      ) : null}
      <div className="rp-bar" data-testid="rp-bar" data-single={single ? '1' : undefined} ref={barRef}>
        <PanelTabList
          label={panel.tabs}
          plain={single}
          className="rp-tabs"
          onCloseFocused={closeTab}
          onContextMenuFocused={(id, anchor) => setMenu({ id, anchor })}
        >
          {entry.surfaces.map((surface) => {
            const label = labelOf(surface)
            return (
              <PanelTab
                key={surface.id}
                id={surface.id}
                label={label}
                title={surface.kind === 'file' ? surface.path : surface.kind === 'pullRequest' && surface.title ? `#${surface.number} ${surface.title}` : label}
                icon={<SurfaceIcon surface={surface} />}
                active={surface.id === entry.active}
                controls={`rp-surface-${surface.id}`}
                closeLabel={panel.closeTab(label)}
                testId={`rp-tab-${surface.id}`}
                onSelect={() => useRightPanel.getState().activate(surface.id)}
                onClose={() => closeTab(surface.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ id: surface.id, anchor: event.currentTarget })
                }}
              />
            )
          })}
        </PanelTabList>
        {single ? null : addTab}
        <span className="rp-bar-actions">
          {single ? addTab : null}
          {mode === 'inline' ? (
            <IconButton
              size="sm"
              aria-label={maximized ? panel.restore : panel.maximize}
              tooltip={maximized ? panel.restore : panel.maximize}
              tooltipShortcut={shortcutOrNone(maximizeShortcut)}
              aria-pressed={maximized}
              isDisabled={!entry.surfaces.length}
              data-testid="rp-maximize"
              onPress={() => useRightPanel.getState().setMaximized(!maximized)}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
          ) : null}
          <IconButton size="sm" aria-label={panel.hidePanel} tooltip={panel.hidePanel} data-testid="rp-hide" onPress={() => useRightPanel.getState().setOpen(false)}>
            <PanelRightClose size={14} />
          </IconButton>
        </span>
      </div>
      <div className="rp-body">
        {!owner ? (
          <EmptyState className="rp-empty" data-testid="rp-inactive" title={text.inactiveTitle} />
        ) : !entry.surfaces.length ? (
          <Launcher text={text} panel={panel} onPick={runLauncher} />
        ) : (
          <div className="rp-surfaces" key={owner.key}>
            {mounted.map((surface) => (
              <SurfaceView
                key={surface.id}
                surface={surface}
                shown={open && surface.id === entry.active}
                owner={owner}
                panes={panes}
                text={text}
                panel={panel}
                closeTip={withKeys(panel.closeTab(labelOf(surface)), closeShortcut)}
                onRequestActivation={onRequestActivation}
              />
            ))}
          </div>
        )}
      </div>
      <Popover triggerRef={anchorRef} isOpen={!!menu && !!menuSurface} onOpenChange={(next) => (next ? undefined : setMenu(null))} placement="bottom start" offset={4}>
        <Menu
          aria-label={menuSurface ? panel.tabMenu(labelOf(menuSurface)) : panel.tabs}
          autoFocus="first"
          data-testid="rp-tab-menu"
          disabledKeys={[...(entry.surfaces.length <= 1 ? ['others'] : []), ...(menuIndex >= entry.surfaces.length - 1 ? ['right'] : [])]}
          onAction={(key) => {
            const id = menu?.id
            setMenu(null)
            if (!id) return
            const store = useRightPanel.getState()
            if (key === 'close') store.close(id)
            else if (key === 'others') store.closeOthers(id)
            else if (key === 'right') store.closeRight(id)
            else if (key === 'all') store.closeAll()
          }}
        >
          <MenuItem id="close" textValue={panel.close}>{panel.close}</MenuItem>
          <MenuItem id="others" textValue={panel.closeOthers}>{panel.closeOthers}</MenuItem>
          <MenuItem id="right" textValue={panel.closeRight}>{panel.closeRight}</MenuItem>
          <Separator />
          <MenuItem id="all" textValue={panel.closeAll}>{panel.closeAll}</MenuItem>
        </Menu>
      </Popover>
    </section>
  )

  if (mode === 'sheet') {
    return (
      <Sheet isOpen={open} onOpenChange={(next) => useRightPanel.getState().setOpen(next)} label={panel.panel} className="rp-sheet" testId="rp-sheet">
        {content}
      </Sheet>
    )
  }
  return open ? content : null
}

function Launcher({ text, panel, onPick }: { text: WorkbenchText; panel: RightPanelText; onPick: (action: LauncherAction) => void }): ReactElement {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const action = launcherFor(event)
    if (action) {
      event.preventDefault()
      onPick(action)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-launch]')]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length]?.focus()
  }
  return (
    <div className="rp-launcher" aria-label={panel.launcherTitle} role="group" onKeyDown={onKeyDown} data-testid="rp-launcher">
      <div className="rp-launcher-inner">
        <h3 className="rp-launcher-title">{panel.launcherTitle}</h3>
        <div className="rp-launcher-list">
          {LAUNCHER.map((action) => {
            const Icon = TOOL_ICONS[action.kind]
            return (
              <ListRow
                key={action.kind}
                icon={<Icon size={14} />}
                trailing={<Kbd>{action.key}</Kbd>}
                aria-keyshortcuts={action.key}
                data-launch
                data-testid={`rp-launch-${action.kind}`}
                onClick={() => onPick(action)}
              >
                {toolLabel(action.kind, text, panel)}
              </ListRow>
            )
          })}
        </div>
      </div>
    </div>
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
  owner: WorkspaceOwner
  panes: WorkbenchPaneComponents
  text: WorkbenchText
  panel: RightPanelText
  closeTip: string
  onRequestActivation: (tab: WorkbenchTabId) => Promise<boolean>
}

function SurfaceView({ surface, shown, owner, panes, text, panel, onRequestActivation }: SurfaceViewProps): ReactElement {
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null)
  const [toolsEl, setToolsEl] = useState<HTMLElement | null>(null)
  const [menuGroups, setMenuGroups] = useState<ReadonlyMap<string, readonly PaneMenuItem[]>>(() => new Map())
  const [activating, setActivating] = useState(false)
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
  const tool = surface.kind !== 'file' && surface.kind !== 'pullRequest' && surface.kind !== 'subagent' && surface.kind !== 'overview' ? surface.kind : null
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
        onTabChange={(tab) => useRightPanel.getState().open(pullRequestSurface(surface.number, { tab }))}
        onState={(state, title) => {
          if (state !== surface.state || (title && title !== surface.title)) useRightPanel.getState().open(pullRequestSurface(surface.number, { state, title }))
        }}
      />
    )
  } else if (surface.kind === 'subagent') {
    body = <SubagentTranscriptPane runId={surface.runId} />
  } else if (surface.kind === 'overview') {
    body = <OverviewPane owner={owner} onOpenView={(tab) => useRightPanel.getState().open(toolSurface(tab))} />
  } else if (surface.kind === 'file') {
    const Preview = panes.preview
    body = Preview ? <Preview owner={owner} path={surface.path} treeShown={false} standalone /> : null
  } else if (tool) {
    const Body = panes[tool] as ComponentType<LeafProps> | undefined
    body = Body ? (
      <Body
        owner={owner}
        visible={shown && !blocked}
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
      aria-labelledby={`ptab-${surface.id}`}
      hidden={!shown}
      data-kind={surface.kind}
      data-testid={`rp-surface-${surface.id}`}
    >
      {subHeader ? (
        <div className="rp-sub" data-testid={`rp-sub-${surface.id}`}>
          <span className="rp-sub-title" ref={setTitleEl} />
          <span className="rp-sub-tools" ref={setToolsEl} />
          {allItems.length ? (
            <MenuTrigger>
              <IconButton size="sm" aria-label={text.paneMenu(name || panel.file)} tooltip={text.paneMenu(name || panel.file)} data-testid={`rp-menu-${surface.id}`} className="rp-sub-menu">
                <EllipsisVertical size={14} />
              </IconButton>
              <Popover placement="bottom end" offset={4}>
                <Menu
                  aria-label={text.paneMenu(name || panel.file)}
                  disabledKeys={allItems.filter((item) => item.disabled).map((item) => item.id)}
                  onAction={(key) => allItems.find((item) => item.id === key)?.onAction()}
                >
                  {groups.flatMap((items, index) => [
                    ...(index > 0 ? [<Separator key={`sep:${index}`} />] : []),
                    ...items.map((item) => (
                      <MenuItem
                        key={item.id}
                        id={item.id}
                        textValue={item.label}
                        aria-checked={item.checked}
                        checked={item.checked}
                        icon={item.checked === undefined ? item.icon : undefined}
                      >
                        {item.label}
                      </MenuItem>
                    ))
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
