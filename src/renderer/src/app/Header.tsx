import { memo, useMemo, type ReactElement } from 'react'
import { ArrowLeft, Columns3, PanelLeft, Pin, SquarePen } from '../ui/icons'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { shortcutKeysText, shortcutOverridesFromSettings } from './shortcuts'
import { IconButton, TooltipText } from '../ui'
import type { V3RouteName } from '../state/ui-v3'
import type { WorkbenchTabId } from '../features/workbench/types'
import { v3Text, withShortcutKeys } from './v3-text'
import { plainTitleText } from '../../../shared/title-text'
import { sessionProjectLabel } from '../features/sidebar/sidebar-model'

interface Props {
  narrow: boolean
  sidebarOverlay?: boolean
  sidebarOpen: boolean
  route: V3RouteName
  onToggleSidebar: () => void
  onSettings: () => void
  onBack: () => void
  sessionBarOpen: boolean
  sessionBarHidden?: boolean
  onToggleSessionBar: () => void
  sessionBarShown?: boolean
  splitActive?: boolean
  openPanes: ReadonlySet<WorkbenchTabId>
  activePane?: string | null
  changesDirty: boolean
  terminalRunning?: boolean
  onTogglePane: (tab: WorkbenchTabId) => void
}

export const Header = memo(function Header({ sidebarOverlay = false, sidebarOpen, route, onToggleSidebar, onBack, sessionBarOpen, sessionBarHidden, onToggleSessionBar, splitActive = false }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const sessionBarLabel = sessionBarOpen ? (sessionBarHidden ? text.sessionBarNoRoom : text.hideSessionBar) : text.showSessionBar
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const sessionName = useStore((s) => s.session?.sessionName)
  const sessionKey = useStore((s) => s.session?.conversationId ?? s.session?.sessionId)
  const firstUserText = useStore((s) => s.messages.find((message) => message.role === 'user')?.text ?? '')
  const firstUserTitle = useMemo(() => plainTitleText(firstUserText).slice(0, 80), [firstUserText])
  const hasMessages = useStore((s) => s.messages.length > 0)
  const titleId = peekedSessionId ?? sessionKey
  const namedTitle = useStore((s) => (titleId ? s.manualTitles[titleId] || s.titles[titleId] || s.sessions.find((item) => item.id === titleId)?.title || '' : ''))
  const project = useStore((s) => {
    if (route !== 'chat') return ''
    const summary = s.sessions.find((item) => item.id === titleId)
    if (!summary || summary.scope === 'global') return ''
    return sessionProjectLabel(summary, s.settings?.projects ?? [], s.settings?.projectNames ?? {}).label
  })
  const shortcutOverrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)

  const newChatLabel = withShortcutKeys(text.newChatShortcut, shortcutKeysText('newSession', shortcutOverrides))

  const title = useMemo(() => {
    if (route === 'usage') return t('usage.title')
    if (route === 'artifacts') return t('artifactLibrary.title')
    if (namedTitle) return namedTitle
    if (!peekedSessionId && sessionName) return sessionName
    if (firstUserTitle) return firstUserTitle
    return !peekedSessionId && !hasMessages ? text.newSessionTitle : t('rail.untitled')
  }, [route, peekedSessionId, sessionName, namedTitle, firstUserTitle, hasMessages, t, lang, text.newSessionTitle])

  return (
    <header className="v3-head" data-chat={route === 'chat' ? '' : undefined}>
      <div className="v3-head-left">
        {route === 'chat' ? (
          !sidebarOpen || sidebarOverlay ? (
            <IconButton tooltip={text.toggleSidebar} aria-label={text.toggleSidebar} onPress={onToggleSidebar} data-testid="v3-rail-toggle">
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
        <h1 className={route === 'chat' && !splitActive ? 'v3-head-title' : 'v3-head-title v3-visually-hidden'}>
          {project ? (
            <>
              <span className="v3-head-crumb">{project}</span>
              <span className="v3-head-crumb-sep" aria-hidden>/</span>
            </>
          ) : null}
          {route === 'chat' && !splitActive ? (
            <TooltipText tooltip={title} className="v3-head-title__text">
              {title}
            </TooltipText>
          ) : (
            <span className="v3-head-title__text">{title}</span>
          )}
        </h1>
      </div>

      <div className="v3-head-drag" aria-hidden />

      <div className="v3-head-actions">
        <IconButton
          tooltip={text.keepOnTop}
          aria-label={text.keepOnTop}
          aria-pressed={alwaysOnTop}
          onPress={() => void useStore.getState().toggleAlwaysOnTop()}
          data-testid="v3-always-on-top"
        >
          <Pin size={16} />
        </IconButton>
        {route === 'chat' ? (
          <IconButton
            tooltip={sessionBarLabel}
            aria-label={sessionBarLabel}
            aria-pressed={sessionBarOpen && !sessionBarHidden}
            onPress={onToggleSessionBar}
            data-testid="v3-head-sessionbar-toggle"
          >
            <Columns3 size={16} />
          </IconButton>
        ) : null}
      </div>
    </header>
  )
})
