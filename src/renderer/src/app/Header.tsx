import { useMemo, type ReactElement } from 'react'
import { ArrowLeft, FolderOpen, Globe, Minus, MoreHorizontal, PanelLeft, PanelRight, Pin, Settings, Square, SquarePen, Terminal, X } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
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
  sidebarOpen: boolean
  route: V3RouteName
  onToggleSidebar: () => void
  onPreviewSidebar?: () => void
  onSettings: () => void
  onBack: () => void
  sessionBarOpen: boolean
  onToggleSessionBar: () => void
  onOpenTool: (tab: WorkbenchTabId) => void
}

export function Header({ narrow, sidebarOpen, route, onToggleSidebar, onPreviewSidebar, onSettings, onBack, sessionBarOpen, onToggleSessionBar, onOpenTool }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const toolText = workbenchText(lang)
  const sessionBarLabel = sessionBarOpen ? text.hideSessionBar : text.showSessionBar
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const firstUserTitle = useStore((s) => plainTitleText(s.messages.find((message) => message.role === 'user')?.text ?? '').slice(0, 80))
  const manualTitles = useStore((s) => s.manualTitles)
  const titles = useStore((s) => s.titles)
  const sessions = useStore((s) => s.sessions)
  const maximized = useStore((s) => s.maximized)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const win = window.yan.win

  const preview = useHoverDelay(280, () => onPreviewSidebar?.())

  const title = useMemo(() => {
    if (route === 'settings') return text.settingsTitle
    if (route === 'runs') return text.runs
    if (route === 'usage') return t('usage.title')
    if (route === 'schedule') return t('sched.title')
    if (route === 'review') return text.review
    if (route === 'collab') return collabText(lang).nav
    const id = peekedSessionId ?? session?.conversationId ?? session?.sessionId
    if (id && manualTitles[id]) return manualTitles[id]
    if (id && titles[id]) return titles[id]
    const summary = sessions.find((item) => item.id === id)
    if (summary?.title) return summary.title
    if (!peekedSessionId && session?.sessionName) return session.sessionName
    return firstUserTitle || t('rail.untitled')
  }, [route, peekedSessionId, session?.conversationId, session?.sessionId, session?.sessionName, sessions, firstUserTitle, manualTitles, titles, t, lang, text.settingsTitle, text.runs, text.review])

  return (
    <header className="v3-head">
      <div className="v3-head-left">
        {route === 'chat' ? (
          !sidebarOpen || narrow ? (
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
        <h1 className="v3-head-title" title={title}>
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
                data-active={sessionBarOpen ? '1' : '0'}
              >
                <PanelRight size={16} />
              </IconButton>
            </IconTip>
            <Separator orientation="vertical" className="v3-head-sep" />
            <IconTip label={toolText.tabs.terminal}>
              <IconButton aria-label={toolText.tabs.terminal} data-testid="wb-open-terminal" onPress={() => onOpenTool('terminal')}>
                <Terminal size={16} />
              </IconButton>
            </IconTip>
            <IconTip label={toolText.tabs.files}>
              <IconButton aria-label={toolText.tabs.files} data-testid="wb-open-files" onPress={() => onOpenTool('files')}>
                <FolderOpen size={16} />
              </IconButton>
            </IconTip>
            <IconTip label={toolText.tabs.browser}>
              <IconButton aria-label={toolText.tabs.browser} data-testid="wb-open-browser" onPress={() => onOpenTool('browser')}>
                <Globe size={16} />
              </IconButton>
            </IconTip>
            <MenuTrigger>
              <IconButton aria-label={toolText.overview.moreTools} title={toolText.overview.moreTools} data-testid="wb-more-tools">
                <MoreHorizontal size={16} />
              </IconButton>
              <Popover placement="bottom end" offset={6}>
                <Menu aria-label={toolText.overview.moreTools} className="wb-more-menu" data-testid="wb-more-menu">
                  {(['changes', 'preview', 'logs', 'branch', 'quota'] as const).map((tab) => (
                    <MenuItem key={tab} id={tab} textValue={toolText.tabs[tab]} onAction={() => onOpenTool(tab)}>
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
            data-active={route === 'settings' ? '1' : '0'}
          >
            <Settings size={16} />
          </IconButton>
        </IconTip>

        <IconTip label={lang === 'en-US' ? 'Keep window on top' : '窗口置顶'}>
          <IconButton aria-label={lang === 'en-US' ? 'Keep window on top' : '窗口置顶'} aria-pressed={alwaysOnTop} onPress={() => void toggleAlwaysOnTop()} data-testid="v3-always-on-top"><Pin size={16} /></IconButton>
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
