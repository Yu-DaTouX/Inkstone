import { useMemo, type ReactElement } from 'react'
import { ArrowLeft, Copy, EllipsisVertical, FileDiff, Folder, Minus, PanelLeft, Square, SquareMenu, SquarePen, Terminal, X } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { shortcutKeysText, shortcutOverridesFromSettings, type ShortcutId } from './shortcuts'
import { IconButton, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover } from '../ui'
import type { V3RouteName } from '../state/ui-v3'
import type { WorkbenchTabId } from '../features/workbench/types'
import { workbenchText } from '../features/workbench/workbench-text'
import { collabText } from '../features/collab/collab-text'
import { useHoverDelay } from '../lib/use-hover-delay'
import { ProjectScriptsControl } from '../features/scripts/ProjectScriptsControl'
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
  openPanes: ReadonlySet<WorkbenchTabId>
  changesDirty: boolean
  terminalRunning?: boolean
  onTogglePane: (tab: WorkbenchTabId) => void
}

const TITLEBAR_PANES = [
  { tab: 'terminal', Icon: Terminal },
  { tab: 'changes', Icon: FileDiff },
  { tab: 'files', Icon: Folder }
] as const

const VIEW_OPTION_PANES: readonly WorkbenchTabId[] = ['browser', 'logs', 'device', 'pullRequests']
const MENU_KEEP_ON_TOP = 'head:keep-on-top'
const MENU_SETTINGS = 'head:settings'

const PANE_SHORTCUTS: Partial<Record<WorkbenchTabId, ShortcutId>> = {
  terminal: 'openTerminal',
  changes: 'workspaceTab1',
  browser: 'workspaceTab4',
  files: 'workspaceTab3'
}

export function Header({ narrow, sidebarOverlay = false, terminalRunning = false, sidebarOpen, route, onToggleSidebar, onPreviewSidebar, onSettings, onBack, sessionBarOpen, sessionBarHidden, onToggleSessionBar, openPanes, changesDirty, onTogglePane }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const toolText = workbenchText(lang)
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
  const maximized = useStore((s) => s.maximized)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const shortcutOverrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const win = window.yan.win

  const preview = useHoverDelay(280, () => onPreviewSidebar?.())
  const paneActive = (tab: WorkbenchTabId): boolean => (tab === 'changes' && changesDirty) || (tab === 'terminal' && terminalRunning)
  const activeLabel = (tab: WorkbenchTabId): string => (tab === 'terminal' && terminalRunning ? `${toolText.tabs[tab]} · ${text.terminalRunning}` : toolText.tabs[tab])
  const withShortcut = (label: string, tab: WorkbenchTabId): string => {
    const id = PANE_SHORTCUTS[tab]
    if (!id) return label
    const keys = shortcutKeysText(id, shortcutOverrides)
    if (!keys) return label
    return lang === 'en-US' ? `${label} (${keys})` : `${label}（${keys}）`
  }
  const paneLabel = (tab: WorkbenchTabId): string => withShortcut(activeLabel(tab), tab)
  const paneShortcut = (tab: WorkbenchTabId): string | undefined => {
    const id = PANE_SHORTCUTS[tab]
    return (id && shortcutKeysText(id, shortcutOverrides)) || undefined
  }
  const newChatLabel = withShortcutKeys(text.newChatShortcut, shortcutKeysText('newSession', shortcutOverrides))
  const menuPanes: readonly WorkbenchTabId[] = route === 'chat' ? [...(narrow ? TITLEBAR_PANES.map((item) => item.tab) : []), ...VIEW_OPTION_PANES] : []
  const menuDot = route === 'chat' && narrow && TITLEBAR_PANES.some(({ tab }) => paneActive(tab))

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
        <h1 className={route === 'chat' ? 'v3-head-title' : 'v3-head-title v3-visually-hidden'} title={project ? `${project} / ${title}` : title}>
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

      <div className="v3-head-actions">
        {route === 'chat' ? (
          <>
            <ProjectScriptsControl />
            <div className="v3-head-toggles" role="group" aria-label={text.panelToggles}>
              <IconButton
                tooltip={sessionBarLabel}
                aria-label={sessionBarLabel}
                aria-pressed={sessionBarOpen}
                pressedTone="neutral"
                onPress={onToggleSessionBar}
                data-testid="v3-header-sessionbar"
                data-active={sessionBarOpen ? (sessionBarHidden ? 'partial' : '1') : '0'}
              >
                <SquareMenu size={16} />
              </IconButton>
              {narrow
                ? null
                : TITLEBAR_PANES.map(({ tab, Icon }) => (
                    <IconButton
                      key={tab}
                      tooltip={paneLabel(tab)}
                      aria-label={paneLabel(tab)}
                      aria-pressed={openPanes.has(tab)}
                      pressedTone="neutral"
                      className="v3-head-pane"
                      data-testid={`wb-open-${tab}`}
                      onPress={() => onTogglePane(tab)}
                    >
                      <Icon size={16} />
                      {paneActive(tab) ? <span className="v3-head-pane-dot" aria-hidden data-testid={`wb-dot-${tab}`} /> : null}
                    </IconButton>
                  ))}
            </div>
          </>
        ) : null}
        <MenuTrigger>
          <IconButton aria-label={text.more} tooltip={text.more} className="v3-head-pane" data-testid="wb-more-tools">
            <EllipsisVertical size={16} />
            {menuDot ? <span className="v3-head-pane-dot" aria-hidden /> : null}
          </IconButton>
          <Popover placement="bottom end" offset={6}>
            <Menu
              aria-label={text.more}
              className="wb-more-menu"
              data-testid="wb-more-menu"
              onAction={(key) => {
                if (key === MENU_KEEP_ON_TOP) void toggleAlwaysOnTop()
                else if (key === MENU_SETTINGS) onSettings()
                else onTogglePane(key as WorkbenchTabId)
              }}
            >
              {menuPanes.map((tab) => (
                <MenuItem key={tab} id={tab} textValue={toolText.tabs[tab]} checked={openPanes.has(tab)} aria-checked={openPanes.has(tab)} shortcut={paneShortcut(tab)} data-testid={`wb-view-${tab}`}>
                  {toolText.tabs[tab]}
                </MenuItem>
              ))}
              {menuPanes.length > 0 ? <MenuSeparator /> : null}
              <MenuItem id={MENU_KEEP_ON_TOP} textValue={text.keepOnTop} checked={alwaysOnTop} aria-checked={alwaysOnTop} data-testid="v3-always-on-top">
                {text.keepOnTop}
              </MenuItem>
              <MenuItem id={MENU_SETTINGS} textValue={text.settings} checked={false} data-testid="v3-menu-settings">
                {text.settings}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
        <div className="v3-win">
          <button type="button" className="v3-winbtn v3-winbtn-min" aria-label={t('tb.minimize')} title={t('tb.minimize')} onClick={() => win.minimize()} data-testid="v3-min">
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="v3-winbtn v3-winbtn-max"
            aria-label={maximized ? t('tb.restore') : t('tb.maximize')}
            title={maximized ? t('tb.restore') : t('tb.maximize')}
            onClick={() => win.maximize()}
            data-testid="v3-max"
          >
            {maximized ? <Copy size={13} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} />}
          </button>
          <button type="button" className="v3-winbtn v3-winbtn-close" aria-label={t('tb.hide')} title={t('tb.hide')} onClick={() => win.close()} data-testid="v3-close">
            <X size={14} />
          </button>
        </div>
      </div>
    </header>
  )
}
