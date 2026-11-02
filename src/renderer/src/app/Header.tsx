import { memo, useMemo, type ReactElement } from 'react'
import { ArrowLeft, Columns3, PanelLeft, PanelRight, Pin, SquarePen } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { shortcutKeysText, shortcutOverridesFromSettings } from './shortcuts'
import { IconButton, Separator, TooltipText } from '../ui'
import type { V3RouteName } from '../state/ui-v3'
import type { WorkbenchTabId } from '../features/workbench/types'
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

export const Header = memo(function Header({ sidebarOverlay = false, sidebarOpen, route, onToggleSidebar, onPreviewSidebar, onBack, sessionBarOpen, sessionBarHidden, onToggleSessionBar, rightPanelOpen, onToggleRightPanel, windowControls, splitActive = false }: Props): ReactElement {
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
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const shortcutOverrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const panelText = rightPanelText(lang)

  const preview = useHoverDelay(280, () => onPreviewSidebar?.())
  const newChatLabel = withShortcutKeys(text.newChatShortcut, shortcutKeysText('newSession', shortcutOverrides))

  const title = useMemo(() => {
    if (route === 'usage') return t('usage.title')
    if (route === 'schedule') return t('sched.title')
    if (route === 'collab') return collabText(lang).nav
    if (route === 'artifacts') return t('artifactLibrary.title')
    if (namedTitle) return namedTitle
    if (!peekedSessionId && sessionName) return sessionName
    if (firstUserTitle) return firstUserTitle
    return !peekedSessionId && !hasMessages ? text.newSessionTitle : t('rail.untitled')
  }, [route, peekedSessionId, sessionName, namedTitle, firstUserTitle, hasMessages, t, lang, text.newSessionTitle])

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
        <h1 className={route === 'chat' && !splitActive ? 'v3-head-title' : 'v3-head-title v3-visually-hidden'}>
          {project ? (
            <>
              <span className="v3-head-crumb">{project}</span>
              <span className="v3-head-crumb-sep" aria-hidden>/</span>
            </>
          ) : null}
          <TooltipText tooltip={title} className="v3-head-title__text">
            {title}
          </TooltipText>
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
              aria-pressed={sessionBarOpen && !sessionBarHidden}
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
        <IconButton
          tooltip={text.keepOnTop}
          aria-label={text.keepOnTop}
          aria-pressed={alwaysOnTop}
          className="v3-head-pane"
          onPress={() => void toggleAlwaysOnTop()}
          data-testid="v3-always-on-top"
        >
          <Pin size={16} />
        </IconButton>
        {windowControls ? (
          <>
            <Separator orientation="vertical" className="v3-head-sep v3-head-sep--win" />
            <WindowControls />
          </>
        ) : null}
      </div>
    </header>
  )
})
