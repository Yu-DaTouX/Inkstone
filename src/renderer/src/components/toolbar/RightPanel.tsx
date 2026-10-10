import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { SubagentPanel } from '../workbench/SubagentPanel'
const LegacyAgentPanel = lazy(() => import('../workbench/AgentWorkspacePanel').then(module => ({ default: module.AgentWorkspacePanel })))
import { type ToolSectionId } from '../../../../shared/ipc'
import { FileTree } from './FileTree'
import { BrowserSurface } from '../browser/BrowserSurface'
import { TerminalSurface } from '../terminal/TerminalSurface'
import { FilePreviewPane } from './FilePreview'
import { fileResourceLabel } from '../../../../shared/file-resource'
import { loadWorkbenchState } from '../../state/workbench'
import { conversationKeyOf } from '../../state/workspace-key'
import { PENDING_SESSION_KEY } from '../../state/workbench'
import { claimResource, reassignOwner, releaseResource, resourceOwner } from '../../state/resource-owners'
import { EmptyState, Menu, MenuItem, MenuSeparator } from '../ui'
import type { IconName } from '../../icons/Icon'
import { ContextSection } from './ContextSection'
import { QuotaSection } from './QuotaSection'
import { AccountQuotaPane } from './AccountQuotaPane'
import { hasTaskTileContent, TodoCount, TodoSection } from './TodoSection'
import { hasVisibleSubagents } from '../../state/subagent-view'
import { LogCount, QueueSection, ExtSection, LogSection, ActionsSection } from './PanelSections'
import { WorkspacePane, useWorkspace, loadWorkspaceLayout, type MenuAnchor } from '../workbench/Workspace'
import { dockGroups } from '../../state/workspace-layout'

const LAUNCH_ITEMS: [string, MessageKey, IconName][] = [
  ['files', 'tile.files', 'folder'], ['browser', 'tile.browser', 'globe'], ['terminal', 'tile.terminal', 'terminal'], ['agents', 'hub.title', 'agent'],
  ['tasks', 'tile.tasks', 'checklist'], ['logs', 'tile.logs', 'activity'], ['accounts', 'tile.accounts', 'dashboard']
]

/** Goal, task list and queued messages; the tile stays useful when the agent has none yet. */
function TasksPane() {
  const t = useT()
  const hasTasks = useStore(s => hasTaskTileContent({
    todos: s.todos, goal: s.goal, hasSubagents: hasVisibleSubagents(s),
    hasMessageOutputs: s.messages.some(m => !!m.artifacts?.length || (m.role === 'user' && !!m.images?.length))
  }))
  return <div className="tile-sections" data-testid="tasks-pane">
    {hasTasks ? <TodoSection /> : <EmptyState icon="checklist" title={t('tile.tasksEmpty')}>{t('tile.tasksEmptyBody')}</EmptyState>}
    <QueueSection />
  </div>
}

/** Extension status and the agent process log. */
function LogsPane() {
  const t = useT()
  const empty = useStore(s => s.logs.length === 0 && !Object.keys(s.statuses).length && !Object.keys(s.widgets).length)
  return <div className="tile-sections" data-testid="logs-pane">
    {empty ? <EmptyState icon="activity" title={t('tile.logsEmpty')}>{t('tile.logsEmptyBody')}</EmptyState> : <><ExtSection /><LogSection /></>}
  </div>
}

/**
 * Resource owners stay unchanged; this controller only opens their workspace panes.
 *
 * One instance per conversation column. `sessionKey` names the conversation the column belongs to
 * (defaults to the active one); terminals and file previews show only beside the conversation that
 * owns them (`resource-owners`). `live` is the focused column: only it answers launch requests and
 * shows tools that read the active conversation (tasks, logs). The native browser stays with its owner.
 */
export function RightPanel({ sessionKey, live = true }: { sessionKey?: string; live?: boolean } = {}) {
  const t = useT()
  const workspace = useWorkspace()
  const session = useStore(s => s.session)
  const key = sessionKey ?? conversationKeyOf(session)
  const liveRef = useRef(live)
  liveRef.current = live
  /* 新对话还没有会话文件时的键是占位的：会话建好后，这一列里开的终端与文件跟到真键下 */
  const previousKey = useRef(key)
  if (previousKey.current !== key) {
    if (previousKey.current === PENDING_SESSION_KEY) reassignOwner(PENDING_SESSION_KEY, key)
    previousKey.current = key
  }
  const browser = useStore(s => s.browserState)
  // 旧版本/宿主直接打开的浏览器只认领一次；切焦点不能改它的归属。
  if (live && browser.open) claimResource('browser', key)
  const ownsBrowser = browser.open && resourceOwner('browser') === key
  const filePreview = useStore(s => s.filePreview)
  const allFiles = useStore(s => s.filePreviews)
  const closeFileTab = useStore(s => s.closeFileTab)
  const allTerminals = useStore(s => s.terminals)
  /* The focused column also adopts resources nobody owns yet (opened by the host or an older version). */
  const mine = (resource: string): boolean => { const owner = resourceOwner(resource); return owner === key || (live && !owner) }
  const terminals = allTerminals.filter(term => mine('terminal:' + term.id))
  const files = Object.fromEntries(Object.entries(allFiles).filter(([id]) => mine('file:' + id)))
  useEffect(() => {
    if (!live) return
    for (const term of allTerminals) claimResource('terminal:' + term.id, key)
    for (const id of Object.keys(allFiles)) claimResource('file:' + id, key)
  }, [live, key, allTerminals, allFiles])
  const setBrowserSurfaceActive = useStore(s => s.setBrowserSurfaceActive)
  const [agents, setAgents] = useState<string[]>([])
  const [agentManager, setAgentManager] = useState(false)
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  /* Simple tools mount once opened, and again when the saved layout still references them. */
  const [tasksOpen, setTasksOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [agentTitles, setAgentTitles] = useState<Record<string, string>>({})
  const [ownerKey, setOwnerKey] = useState(key)
  const request = useRef(0)
  const currentKey = useRef(key)
  currentKey.current = key
  const { open, hide } = workspace
  const openAgent = useCallback((id: string) => {
    setOwnerKey(key)
    setAgents(ids => ownerKey !== key ? [id] : ids.includes(id) ? ids : [...ids, id])
    open('agent:' + id)
    void useStore.getState().setRightPanelOpen(true)
  }, [open, key, ownerKey])
  useEffect(() => {
    const references = dockGroups(loadWorkspaceLayout(key).root).flatMap(group => group.panes)
    setOwnerKey(key)
    setAgents(references.filter(id => id.startsWith('agent:')).map(id => id.slice(6)))
    setAgentManager(references.includes('agents'))
    setTasksOpen(references.includes('tasks')); setLogsOpen(references.includes('logs')); setAccountsOpen(references.includes('accounts')); setAgentTitles({}); setMenu(null)
    const stored = loadWorkbenchState(key)
    setFileTreeOpen(references.includes('files') || stored.tabs.some(tab => tab.kind === 'file' && !tab.resourceKey))
  }, [key])
  useEffect(() => {
    const show = (e: Event) => {
      if (!liveRef.current) return
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string' && /^(hub|subagent):[A-Za-z0-9-]+$/.test(id)) openAgent(id)
    }
    window.addEventListener('inkstone-agent-open', show)
    return () => window.removeEventListener('inkstone-agent-open', show)
  }, [openAgent])
  useEffect(() => {
    const show = (e: Event) => { if (liveRef.current) setMenu((e as CustomEvent<MenuAnchor | undefined>).detail ?? { top: 44, right: 16 }) }
    window.addEventListener('inkstone-workspace-open-tool', show)
    return () => window.removeEventListener('inkstone-workspace-open-tool', show)
  }, [])
  /* Other surfaces (status bar, cards) ask for a tool by kind; the launcher decides how it opens. */
  const launchRef = useRef<(kind: string) => Promise<void>>(async () => {})
  useEffect(() => {
    const run = (e: Event) => { const kind = (e as CustomEvent<string>).detail; if (liveRef.current && typeof kind === 'string') void launchRef.current(kind) }
    window.addEventListener('inkstone-workspace-launch', run)
    return () => window.removeEventListener('inkstone-workspace-launch', run)
  }, [])
  // 别的列的文件不在这一列开窗格
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (live && filePreview?.key && mine('file:' + filePreview.key)) open('file:' + filePreview.key) }, [live, filePreview?.key, filePreview?.line, open])
  useEffect(() => { if (ownsBrowser) open('browser') }, [ownsBrowser, open])
  /* "New" is judged against every terminal, not just this conversation's: switching back to a conversation must not reopen its terminals. */
  const previousTerminals = useRef(new Set(allTerminals.map(t => t.id)))
  useEffect(() => {
    if (live) for (const terminal of allTerminals) if (!previousTerminals.current.has(terminal.id) && mine('terminal:' + terminal.id)) open('terminal:' + terminal.id)
    previousTerminals.current = new Set(allTerminals.map(t => t.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, allTerminals, open])
  useEffect(() => {
    if (!menu) return
    const release = useStore.getState().acquireOverlayBlocker('workspace-launcher')
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('keydown', close)
    return () => { release(); document.removeEventListener('keydown', close) }
  }, [menu])
  const newTerminal = async () => {
    const identity = key, serial = ++request.current
    const terminal = await useStore.getState().startTerminal({ cols: 80, rows: 24, owner: identity })
    if (terminal && currentKey.current === identity && request.current === serial) open('terminal:' + terminal.id)
  }
  const launch = async (kind: string) => {
    setMenu(null)
    const state = useStore.getState(), identity = key, serial = ++request.current
    void state.setRightPanelOpen(true)
    if (kind === 'tasks' || kind === 'tools') { setTasksOpen(true); open('tasks') }
    if (kind === 'logs') { setLogsOpen(true); open('logs') }
    if (kind === 'accounts') { setAccountsOpen(true); open('accounts') }
    if (kind === 'files') { setFileTreeOpen(true); open('files') }
    if (kind === 'agents') { setAgentManager(true); open('agents') }
    if (kind === 'browser') {
      /* 浏览器已被别的会话占着时，用户在这里明确点开就把它移过来，否则菜单点了没反应 */
      const holder = resourceOwner('browser')
      if (state.browserState.open && holder && holder !== identity) { releaseResource('browser'); claimResource('browser', identity) }
      await state.openBrowser(); if (resourceOwner('browser') === identity && currentKey.current === identity && request.current === serial) open('browser') }
    if (kind === 'terminal') {
      const existing = terminals.find(t => t.alive)
      if (existing) open('terminal:' + existing.id)
      else {
        const terminal = await state.startTerminal({ cols: 80, rows: 24, owner: identity })
        if (terminal && currentKey.current === identity && request.current === serial) open('terminal:' + terminal.id)
      }
    }
  }
  launchRef.current = launch
  return <>
    {live && tasksOpen ? <WorkspacePane id="tasks" title={t('tile.tasks')} icon="checklist"><TasksPane /></WorkspacePane> : null}
    {live && logsOpen ? <WorkspacePane id="logs" title={t('tile.logs')} icon="activity"><LogsPane /></WorkspacePane> : null}
    {live && accountsOpen ? <WorkspacePane id="accounts" title={t('tile.accounts')} icon="dashboard"><AccountQuotaPane /></WorkspacePane> : null}
    {ownsBrowser ? <WorkspacePane id="browser" title={t('tile.browser')} icon="globe" onVisibleChange={setBrowserSurfaceActive}><BrowserSurface /></WorkspacePane> : null}
    {live && fileTreeOpen ? <WorkspacePane id="files" title={t('tile.files')} icon="folder"><div className="tile-file-tree"><FileTree /></div></WorkspacePane> : null}
    {Object.entries(files).map(([id, preview]) => <WorkspacePane key={id} id={'file:' + id} title={preview.data?.name || fileResourceLabel(id) || t('tile.file')} icon="file" closeLabel={t('tile.closeFile')} onClose={() => closeFileTab(id)}><FilePreviewPane resourceKey={id} /></WorkspacePane>)}
    {terminals.map((terminal, index) => <WorkspacePane key={terminal.id} id={'terminal:' + terminal.id} title={t('tile.terminalN', { n: index + 1 })} hint={[terminal.title, terminal.alive ? '' : t('tile.exited')].filter(Boolean).join(' · ')} addLabel={t('term.new')} onAdd={() => void newTerminal()} closeLabel={terminal.alive ? t('tile.endTerminal') : t('term.close')} onClose={() => void useStore.getState().closeTerminal(terminal.id)} actions={[{ label: t('term.new'), icon: 'plus', run: () => void newTerminal() }, { label: terminal.alive ? t('tile.endTerminal') : t('term.close'), icon: 'stop', danger: terminal.alive, run: () => void useStore.getState().closeTerminal(terminal.id) }]}><TerminalSurface terminalId={terminal.id} bare /></WorkspacePane>)}
    {ownerKey === key && agentManager ? <WorkspacePane id="agents" title={t('hub.title')} icon="agent"><SubagentPanel onOpenRun={openAgent} /></WorkspacePane> : null}
    {(ownerKey === key ? agents : []).map(id => <WorkspacePane key={key + id} id={'agent:' + id} title={agentTitles[id] || (id.startsWith('subagent:') ? t('hub.kind.subtask') : 'Agent · ' + id.slice(-6))} icon="agent">{id.startsWith('subagent:') ? <SubagentPanel initialRun={id} onTitleChange={title => { if (currentKey.current === key) setAgentTitles(old => old[id] === title ? old : { ...old, [id]: title }) }} /> : <Suspense fallback={null}><LegacyAgentPanel initialRun={id} onlyRun onBack={() => hide('agent:' + id)} /></Suspense>}</WorkspacePane>)}
    {menu ? <div className="tile-menu-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setMenu(null) }}><Menu className="tile-layout-menu" label={t('tb.openTools')} data-testid="right-tool-menu-popover" style={{ top: menu.top, right: menu.right }}>
      {LAUNCH_ITEMS.map(([id, title, icon], i) => <MenuItem key={id} icon={icon} className="rp-tool-menu-item" autoFocus={i === 0} onClick={() => void launch(id)}>{t(title)}</MenuItem>)}
      <MenuSeparator />
      <MenuItem icon="tile" onClick={() => { const at = menu; setMenu(null); window.dispatchEvent(new CustomEvent('inkstone-workspace-arrange', { detail: at })) }}>{t('tile.arrange')}</MenuItem>
    </Menu></div> : null}
  </>
}

/**
 * 指针 Y 落在哪个分区的上半 / 下半（拖放插入位置）。
 *
 * ⚠️ 用 `.rp-slot` 上的 data-tool-id（**不带 rp- 前缀的原始 id**）来比，
 *    不能读 `.rp-sec` 的 data-sec（那是 `rp-queue` 这种 testid 形态）——
 *    顺序数组里存的是 `queue`，拿 testid 去 indexOf 会得到 -1，
 *    于是整个拖放静默失效（实测就错在这里）。
 *
 * 导出给 FloatingTiles 用：浮窗拖回工具页时也要显示同一条插入线，
 * 而它那里的指针事件根本不在这些 slot 上。
 */
export function resolveToolDrop(
  clientY: number,
  excludeId?: string
): { id: ToolSectionId; after: boolean } | null {
  const slots = [...document.querySelectorAll('.rp-body > .rp-slot')] as HTMLElement[]
  for (const el of slots) {
    const r = el.getBoundingClientRect()
    if (clientY < r.top || clientY > r.bottom) continue
    const id = el.dataset.toolId as ToolSectionId | undefined
    if (!id || id === excludeId) return null
    return { id, after: clientY >= r.top + r.height / 2 }
  }
  return null
}

/** 每个分区自己的内容与头部声明（与 SectionFrame 分开，避免把顺序逻辑重复七遍） */
export const SECTION_REGISTRY: Record<
  ToolSectionId,
  {
    /** 这个分区自己的内容 */
    Body: () => React.ReactElement | null
    /** 头部右侧的附加信息（如任务的 2/4、日志行数） */
    Extra?: () => React.ReactElement | null
    /** 返回 true 则整个分区不渲染（而不是渲染一个空的） */
    isEmpty?: (s: ToolPanelProbe) => boolean
    /**
     * 内容会滚动、高度值得调（文件树 / 日志）。
     * 其余分区就几行，给它们加把手只是噪声。
     */
    resizable?: boolean
  }
> = {
  context: { Body: () => <ContextSection /> },
  quota: { Body: () => <QuotaSection /> },
  todo: {
    Extra: () => <TodoCount />,
    resizable: true,
    isEmpty: (s) => !hasTaskTileContent(s),
    Body: () => <TodoSection />
  },
  queue: { Body: () => <QueueSection /> },
  files: { resizable: true, Body: () => <FileTree /> },
  ext: {
    isEmpty: (s) => Object.keys(s.statuses).length === 0 && Object.keys(s.widgets).length === 0,
    Body: () => <ExtSection />
  },
  log: {
    isEmpty: (s) => s.logs.length === 0,
    Extra: () => <LogCount />,
    resizable: true,
    Body: () => <LogSection />
  },
  actions: { Body: () => <ActionsSection /> }
}

/** 空判据只投影所需字段，消息正文不进入分区注册表。 */
type ToolPanelProbe = Pick<ReturnType<typeof useStore.getState>, 'todos' | 'goal' | 'logs' | 'statuses' | 'widgets'> & {
  hasMessageOutputs: boolean
  hasSubagents?: boolean
}
