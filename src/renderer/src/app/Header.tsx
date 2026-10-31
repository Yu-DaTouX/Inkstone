import { useMemo, type ReactElement } from 'react'
import { ArrowLeft, Columns3, EllipsisVertical, FileDiff, Folder, PanelLeft, PanelRight, SquarePen, Terminal } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { shortcutKeysText, shortcutOverridesFromSettings, type ShortcutId } from './shortcuts'
import { IconButton, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover, Separator } from '../ui'
import type { V3RouteName } from '../state/ui-v3'
import type { WorkbenchTabId } from '../features/workbench/types'
import { workbenchText } from '../features/workbench/workbench-text'
import { collabText } from '../features/collab/collab-text'
import { useHoverDelay } from '../lib/use-hover-delay'
import { ProjectScriptsControl } from '../features/scripts/ProjectScriptsControl'
import { rightPanelText } from '../features/workbench/right-panel-text'
import { WindowControls } from './WindowControls'
import { v3Text, withShortcutKeys } from './v3-text'
import { plainTitleText } from '../../../shared/title-text'
import { sessionProjectLabel } from '../features/sidebar/sidebar-model'

interface Props {
  narrow: boolean
  sidebarOverlay?: boolean
  sidebarOpen: boolean
  route: V3RouteName
  onToggleSidebar: () => void
  onPreviewSidebar?: () => void
  onSettings: () => void
  onBack: () => void
  sessionBarOpen: boolean
  sessionBarHidden?: boolean
  onToggleSessionBar: () => void
  sessionBarShown?: boolean
  rightPanelOpen: boolean
  onToggleRightPanel: () => void
  windowControls: boolean
  splitActive?: boolean
  openPanes: ReadonlySet<WorkbenchTabId>
  activePane?: string | null
  changesDirty: boolean
  terminalRunning?: boolean
  onTogglePane: (tab: WorkbenchTabId) => void
}

const TITLEBAR_PANES = [
  { tab: 'terminal', Icon: Terminal },
  { tab: 'changes', Icon: FileDiff },
  { tab: 'files', Icon: Folder }
] as const

const HEAD_TEXT = {
  'zh-CN': { changesDirty: '有未提交的改动' },
  'en-US': { changesDirty: 'uncommitted changes' }
} as const

const VIEW_OPTION_PANES: readonly WorkbenchTabId[] = ['browser', 'logs', 'device', 'pullRequests']
const MENU_KEEP_ON_TOP = 'head:keep-on-top'
const MENU_SETTINGS = 'head:settings'
const MENU_SESSION_BAR = 'head:session-bar'

const PANE_SHORTCUTS: Partial<Record<WorkbenchTabId, ShortcutId>> = {
  terminal: 'openTerminal',
  changes: 'workspaceTab1',
  browser: 'workspaceTab4',
  files: 'workspaceTab3'
}

export function Header({ narrow, sidebarOverlay = false, terminalRunning = false, sidebarOpen, route, onToggleSidebar, onPreviewSidebar, onSettings, onBack, sessionBarOpen, sessionBarHidden, onToggleSessionBar, rightPanelOpen, onToggleRightPanel, windowControls, splitActive = false, openPanes, activePane = null, changesDirty, onTogglePane }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const toolText = workbenchText(lang)
  const headText = HEAD_TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const sessionBarLabel = sessionBarOpen ? (sessionBarHidden ? text.sessionBarNoRoom : text.hideSessionBar) : text.showSessionBar
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const firstUser = useStore((s) => s.messages.find((message) => message.role === 'user') ?? null)
  const firstUserTitle = useMemo(() => plainTitleText(firstUser?.text ?? '').slice(0, 80), [firstUser])
  const hasMessages = useStore((s) => s.messages.length > 0)
  const manualTitles = useStore((s) => s.manualTitles)
  const titles = useStore((s) => s.titles)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const shortcutOverrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const panelText = rightPanelText(lang)

  const preview = useHoverDelay(280, () => onPreviewSidebar?.())
  const paneActive = (tab: WorkbenchTabId): boolean => (tab === 'changes' && changesDirty) || (tab === 'terminal' && terminalRunning)
  const paneState = (tab: WorkbenchTabId): string => (tab === 'terminal' && terminalRunning ? text.terminalRunning : tab === 'changes' && changesDirty ? headText.changesDirty : '')
  const activeLabel = (tab: WorkbenchTabId): string => {
    const state = paneState(tab)
    return state ? `${toolText.tabs[tab]} · ${state}` : toolText.tabs[tab]
  }
  const paneShortcut = (tab: WorkbenchTabId): string | undefined => {
    const id = PANE_SHORTCUTS[tab]
    return (id && shortcutKeysText(id, shortcutOverrides)) || undefined
  }
  const newChatLabel = withShortcutKeys(text.newChatShortcut, shortcutKeysText('newSession', shortcutOverrides))
  const freshHome = route === 'chat' && !peekedSessionId && !hasMessages && openPanes.size === 0 && !activePane
  const panesInMenu = narrow || freshHome
  const menuPanes: readonly WorkbenchTabId[] = route === 'chat' ? [...(panesInMenu ? TITLEBAR_PANES.map((item) => item.tab) : []), ...VIEW_OPTION_PANES] : []
  const menuDotTab = route === 'chat' && narrow && !freshHome ? TITLEBAR_PANES.find(({ tab }) => paneActive(tab))?.tab : undefined
  const moreLabel = menuDotTab ? `${text.more} · ${activeLabel(menuDotTab)}` : text.more

  const title = useMemo(() => {
    if (route === 'usage') return t('usage.title')
    if (route === 'schedule') return t('sched.title')
    if (route === 'collab') return collabText(lang).nav
    if (route === 'artifacts') return t('artifactLibrary.title')
    const id = peekedSessionId ?? session?.conversationId ?? session?.sessionId
    if (id && manualTitles[id]) return manualTitles[id]
    if (id && titles[id]) return titles[id]
    const summary = sessions.find((item) => item.id === id)
    if (summary?.title) return summary.title
    if (!peekedSessionId && session?.sessionName) return session.sessionName
    if (firstUserTitle) return firstUserTitle
    return !peekedSessionId && !hasMessages ? text.newSessionTitle : t('rail.untitled')
  }, [route, peekedSessionId, session?.conversationId, session?.sessionId, session?.sessionName, sessions, firstUserTitle, hasMessages, manualTitles, titles, t, lang, text.newSessionTitle])

  const project = useMemo(() => {
    if (route !== 'chat') return ''
    const id = peekedSessionId ?? session?.conversationId ?? session?.sessionId
    const summary = sessions.find((item) => item.id === id)
    if (!summary || summary.scope === 'global') return ''
    return sessionProjectLabel(summary, projects ?? [], projectNames ?? {}).label
  }, [route, peekedSessionId, session?.conversationId, session?.sessionId, sessions, projects, projectNames])

  return (
    <header className="v3-head">
      <div className="v3-head-left">
        {route === 'chat' ? (
          !sidebarOpen || sidebarOverlay ? (
            <IconButton tooltip={text.toggleSidebar} aria-label={text.toggleSidebar} onPress={onToggleSidebar} onHoverStart={sidebarOpen ? undefined : preview.start} onHoverEnd={preview.cancel} onPressStart={preview.cancel} data-testid="v3-rail-toggle">
              <PanelLeft size={16} />
            </IconButton>
          ) : null
        ) : (
          <IconButton tooltip={text.back} aria-label={text.back} onPress={onBack} data-testid="v3-back">
            <ArrowLeft size={16} />
          </IconButton>
        )}
        {route === 'chat' && !sidebarOpen ? (
          <IconButton
            tooltip={newChatLabel}
            aria-label={newChatLabel}
            onPress={() => void useStore.getState().newSession({ scope: 'global' })}
            data-testid="v3-head-new-chat"
          >
            <SquarePen size={16} />
          </IconButton>
        ) : null}
        <h1 className={route === 'chat' && !splitActive ? 'v3-head-title' : 'v3-head-title v3-visually-hidden'} title={project ? `${project} / ${title}` : title}>
          {project ? (
            <>
              <span className="v3-head-crumb">{project}</span>
              <span className="v3-head-crumb-sep" aria-hidden>/</span>
            </>
          ) : null}
          <span className="v3-head-title__text">{title}</span>
        </h1>
      </div>

      <div className="v3-head-drag" aria-hidden />

      <div className="v3-head-actions" data-win={windowControls ? '1' : '0'}>
        {route === 'chat' ? (
          <>
            <ProjectScriptsControl />
            <IconButton
              tooltip={sessionBarLabel}
              aria-label={sessionBarLabel}
              aria-pressed={sessionBarOpen}
              className="v3-head-pane"
              onPress={onToggleSessionBar}
              data-testid="v3-head-sessionbar-toggle"
            >
              <Columns3 size={16} />
            </IconButton>
            <IconButton
              tooltip={rightPanelOpen ? panelText.hidePanel : panelText.panel}
              aria-label={rightPanelOpen ? panelText.hidePanel : panelText.panel}
              aria-pressed={rightPanelOpen}
              pressedTone="mark"
              className="v3-head-pane"
              onPress={onToggleRightPanel}
              data-testid="v3-head-panel-toggle"
              data-right-panel-toggle
            >
              <span className="v3-head-pane-glyph">
                <PanelRight size={16} />
              </span>
            </IconButton>
          </>
        ) : null}
        <MenuTrigger>
          <IconButton aria-label={moreLabel} tooltip={moreLabel} className="v3-head-pane v3-head-more" data-testid="wb-more-tools">
            <EllipsisVertical size={16} />
            {menuDotTab ? <span className="v3-head-pane-dot" aria-hidden data-tone={menuDotTab} /> : null}
          </IconButton>
          <Popover placement="bottom end" offset={6}>
            <Menu
              aria-label={text.more}
              className="wb-more-menu"
              data-testid="wb-more-menu"
              onAction={(key) => {
                if (key === MENU_KEEP_ON_TOP) void toggleAlwaysOnTop()
                else if (key === MENU_SETTINGS) onSettings()
                else if (key === MENU_SESSION_BAR) onToggleSessionBar()
                else onTogglePane(key as WorkbenchTabId)
              }}
            >
              {menuPanes.map((tab) => (
                <MenuItem key={tab} id={tab} textValue={toolText.tabs[tab]} checked={openPanes.has(tab)} aria-checked={openPanes.has(tab)} shortcut={paneShortcut(tab)} data-testid={`wb-view-${tab}`}>
                  {paneActive(tab) ? activeLabel(tab) : toolText.tabs[tab]}
                </MenuItem>
              ))}
              {menuPanes.length > 0 ? <MenuSeparator /> : null}
              <MenuItem id={MENU_SESSION_BAR} textValue={sessionBarLabel} checked={sessionBarOpen} aria-checked={sessionBarOpen} data-testid="v3-header-sessionbar">
                {sessionBarLabel}
              </MenuItem>
              <MenuItem id={MENU_KEEP_ON_TOP} textValue={text.keepOnTop} checked={alwaysOnTop} aria-checked={alwaysOnTop} data-testid="v3-always-on-top">
                {text.keepOnTop}
              </MenuItem>
              <MenuItem id={MENU_SETTINGS} textValue={text.settings} checked={false} data-testid="v3-menu-settings">
                {text.settings}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
        {windowControls ? (
          <>
            <Separator orientation="vertical" className="v3-head-sep v3-head-sep--win" />
            <WindowControls />
          </>
        ) : null}
      </div>
    </header>
  )
}
