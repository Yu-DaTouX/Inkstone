import { useMemo, type ReactElement } from 'react'
import { ArrowLeft, Check, EllipsisVertical, FileDiff, Folder, Globe, Minus, PanelLeft, Pin, Settings, Square, SquareMenu, SquarePen, Terminal, X } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { SHORTCUTS, type ShortcutId } from './shortcuts'
import { IconButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from '../ui'
import type { V3RouteName } from '../state/ui-v3'
import type { WorkbenchTabId } from '../features/workbench/types'
import { workbenchText } from '../features/workbench/workbench-text'
import { collabText } from '../features/collab/collab-text'
import { useHoverDelay } from '../lib/use-hover-delay'
import { IconTip } from './IconTip'
import { v3Text } from './v3-text'
import { plainTitleText } from '../../../shared/title-text'

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
  { tab: 'browser', Icon: Globe },
  { tab: 'files', Icon: Folder }
] as const

const VIEW_OPTION_PANES: readonly WorkbenchTabId[] = ['logs']

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
  const firstUserTitle = useStore((s) => plainTitleText(s.messages.find((message) => message.role === 'user')?.text ?? '').slice(0, 80))
  const hasMessages = useStore((s) => s.messages.length > 0)
  const manualTitles = useStore((s) => s.manualTitles)
  const titles = useStore((s) => s.titles)
  const sessions = useStore((s) => s.sessions)
  const maximized = useStore((s) => s.maximized)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const win = window.yan.win

  const preview = useHoverDelay(280, () => onPreviewSidebar?.())
  const paneActive = (tab: WorkbenchTabId): boolean => (tab === 'changes' && changesDirty) || (tab === 'terminal' && terminalRunning)
  const activeLabel = (tab: WorkbenchTabId): string => (tab === 'terminal' && terminalRunning ? `${toolText.tabs[tab]} · ${text.terminalRunning}` : toolText.tabs[tab])
  const withShortcut = (label: string, tab: WorkbenchTabId): string => {
    const id = PANE_SHORTCUTS[tab]
    if (!id) return label
    const keys = SHORTCUTS.find((def) => def.id === id)?.keys
    if (!keys?.length) return label
    return lang === 'en-US' ? `${label} (${keys.join('+')})` : `${label}（${keys.join('+')}）`
  }
  const paneLabel = (tab: WorkbenchTabId): string => withShortcut(activeLabel(tab), tab)

  const title = useMemo(() => {
    if (route === 'usage') return t('usage.title')
    if (route === 'schedule') return t('sched.title')
    if (route === 'collab') return collabText(lang).nav
    const id = peekedSessionId ?? session?.conversationId ?? session?.sessionId
    if (id && manualTitles[id]) return manualTitles[id]
    if (id && titles[id]) return titles[id]
    const summary = sessions.find((item) => item.id === id)
    if (summary?.title) return summary.title
    if (!peekedSessionId && session?.sessionName) return session.sessionName
    if (firstUserTitle) return firstUserTitle
    return !peekedSessionId && !hasMessages ? text.newSessionTitle : t('rail.untitled')
  }, [route, peekedSessionId, session?.conversationId, session?.sessionId, session?.sessionName, sessions, firstUserTitle, hasMessages, manualTitles, titles, t, lang, text.newSessionTitle])

  return (
    <header className="v3-head">
      <div className="v3-head-left">
        {route === 'chat' ? (
          !sidebarOpen || sidebarOverlay ? (
            <IconTip label={text.toggleSidebar}>
              <IconButton aria-label={text.toggleSidebar} onPress={onToggleSidebar} onHoverStart={sidebarOpen ? undefined : preview.start} onHoverEnd={preview.cancel} onPressStart={preview.cancel} data-testid="v3-rail-toggle">
                <PanelLeft size={16} />
              </IconButton>
            </IconTip>
          ) : null
        ) : (
          <IconTip label={text.back}>
            <IconButton aria-label={text.back} onPress={onBack} data-testid="v3-back">
              <ArrowLeft size={16} />
            </IconButton>
          </IconTip>
        )}
        {route === 'chat' && !sidebarOpen ? (
          <IconTip label={text.newChatShortcut}>
            <IconButton
              aria-label={text.newChatShortcut}
              onPress={() => void useStore.getState().newSession({ scope: 'global' })}
              data-testid="v3-head-new-chat"
            >
              <SquarePen size={16} />
            </IconButton>
          </IconTip>
        ) : null}
        <h1 className={route === 'chat' ? 'v3-head-title' : 'v3-head-title v3-visually-hidden'} title={title}>
          {title}
        </h1>
      </div>

      <div className="v3-head-actions">
        {route === 'chat' ? (
          <>
            <IconTip label={sessionBarLabel}>
              <IconButton
                aria-label={sessionBarLabel}
                aria-pressed={sessionBarOpen}
                onPress={onToggleSessionBar}
                data-testid="v3-header-sessionbar"
                data-active={sessionBarOpen ? (sessionBarHidden ? 'partial' : '1') : '0'}
              >
                <SquareMenu size={16} />
              </IconButton>
            </IconTip>
            <Separator orientation="vertical" className="v3-head-sep" />
            {narrow
              ? null
              : TITLEBAR_PANES.map(({ tab, Icon }) => (
                  <IconTip key={tab} label={paneLabel(tab)}>
                    <IconButton
                      aria-label={paneLabel(tab)}
                      aria-pressed={openPanes.has(tab)}
                      className="v3-head-pane"
                      data-testid={`wb-open-${tab}`}
                      onPress={() => onTogglePane(tab)}
                    >
                      <Icon size={16} />
                      {paneActive(tab) ? <span className="v3-head-pane-dot" aria-hidden data-testid={`wb-dot-${tab}`} /> : null}
                    </IconButton>
                  </IconTip>
                ))}
            <MenuTrigger>
              <IconButton aria-label={toolText.viewOptions} title={toolText.viewOptions} className="v3-head-pane" data-testid="wb-more-tools">
                <EllipsisVertical size={16} />
                {narrow && TITLEBAR_PANES.some(({ tab }) => paneActive(tab)) ? <span className="v3-head-pane-dot" aria-hidden /> : null}
              </IconButton>
              <Popover placement="bottom end" offset={6}>
                <Menu
                  aria-label={toolText.viewOptions}
                  className="wb-more-menu"
                  data-testid="wb-more-menu"
                  onAction={(key) => onTogglePane(key as WorkbenchTabId)}
                >
                  {[...(narrow ? TITLEBAR_PANES.map((item) => item.tab) : []), ...VIEW_OPTION_PANES].map((tab) => (
                    <MenuItem key={tab} id={tab} textValue={toolText.tabs[tab]} aria-checked={openPanes.has(tab)} data-testid={`wb-view-${tab}`}>
                      <span className="v3-head-check" aria-hidden>{openPanes.has(tab) ? <Check size={14} /> : null}</span>
                      {toolText.tabs[tab]}
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
            <Separator orientation="vertical" className="v3-head-sep" />
          </>
        ) : null}
        <IconTip label={text.settingsEntryHint}>
          <IconButton
            aria-label={text.settings}
            onPress={onSettings}
            data-testid="v3-header-settings"
            data-active={settingsOpen ? '1' : '0'}
          >
            <Settings size={16} />
          </IconButton>
        </IconTip>

        <IconTip label={text.keepOnTop}>
          <IconButton aria-label={text.keepOnTop} aria-pressed={alwaysOnTop} data-active={alwaysOnTop ? '1' : '0'} onPress={() => void toggleAlwaysOnTop()} data-testid="v3-always-on-top"><Pin size={16} /></IconButton>
        </IconTip>
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
            <Square size={maximized ? 12 : 13} />
          </button>
          <button type="button" className="v3-winbtn v3-winbtn-close" aria-label={t('tb.hide')} title={t('tb.hide')} onClick={() => win.close()} data-testid="v3-close">
            <X size={14} />
          </button>
        </div>
      </div>
    </header>
  )
}
