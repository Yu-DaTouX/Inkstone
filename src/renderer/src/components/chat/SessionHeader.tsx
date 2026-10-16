import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { shortTitle } from '../../../../shared/short-title'
import { parseSubagentNotice } from '../../../../shared/subagent-notice'
import { useStore } from '../../state/store'
import { EnvironmentMenu } from '../review/EnvironmentMenu'
import { SessionMenu } from './SessionMenu'

export function SessionHeader({ mapEnabled, mapOpen, onToggleMap, spaceEnabled, spaceOpen, onToggleSpace }: {
  mapEnabled?: boolean
  mapOpen?: boolean
  onToggleMap?: (open: boolean) => void
  spaceEnabled?: boolean
  spaceOpen?: boolean
  onToggleSpace?: (open: boolean) => void
} = {}) {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const peekedPath = useStore((s) => s.peekedPath)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const activeFile = session?.conversationFile ?? session?.sessionFile
  const previewing = !!peekedPath && peekedPath !== activeFile
  const previewed = previewing ? sessions.find((x) => x.path === peekedPath) : undefined

  const fromModel = previewing
    ? (peekedSessionId ? titles[peekedSessionId] : undefined)
    : session?.sessionId
      ? titles[session.conversationId ?? session.sessionId]
      : undefined
  const fromList = previewing ? previewed?.title : sessions.find((x) => x.path === activeFile)?.title
  const firstText = messages.find((m) => m.role === 'user')?.text
  const fromFirst = firstText ? (parseSubagentNotice(firstText)?.headline || firstText) : undefined
  const manualId = previewing ? peekedSessionId : session?.sessionId
  const fromManual = manualId ? manualTitles[manualId] : undefined
  const currentFile = previewing ? peekedPath : activeFile
  const spaceId = previewing
    ? previewed?.spaceId
    : (session?.sessionId ? sessions.find((x) => x.id === session.sessionId)?.spaceId : undefined) ??
      (currentFile ? sessions.find((x) => x.path === currentFile)?.spaceId : undefined)
  const knownInList = Boolean(currentFile) && sessions.some((x) => x.path === currentFile)
  const showSpace = Boolean(spaceId) || !knownInList
  const title =
    fromManual ||
    fromModel ||
    (previewing ? undefined : session?.sessionName) ||
    fromList ||
    (fromFirst ? shortTitle(fromFirst, 60).short : t('header.untitled'))

  return (
    <div className="shead" data-testid="session-header">
      <div className="shead-row">
        <h1 className="shead-title" title={title} data-testid="session-title">
          {title}
        </h1>

        {mapEnabled || spaceEnabled ? (
          <div className="shead-view" role="group" aria-label={t('view.switch')} data-testid="view-switch">
            {mapOpen || spaceOpen ? (
              <button
                className="on"
                onClick={() => {
                  if (spaceOpen) onToggleSpace?.(false)
                  else onToggleMap?.(false)
                }}
                data-testid="view-chat"
              >
                <Icon name="chat-round" size={12} />
                <span>{t('view.chat')}</span>
              </button>
            ) : null}
            {mapEnabled && !mapOpen && messages.length > 0 ? (
              <button
                onClick={() => onToggleMap?.(true)}
                title={t('view.map')}
                data-testid="view-map"
              >
                <Icon name="map" size={12} />
                <span>{t('view.map')}</span>
              </button>
            ) : null}
            {spaceEnabled && !spaceOpen && showSpace ? (
              <button
                onClick={() => onToggleSpace?.(true)}
                title={t('view.space')}
                data-testid="view-space"
              >
                <Icon name="layers" size={12} />
                <span>{t('view.space')}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <EnvironmentMenu />

        {session?.isStreaming && !previewing ? (
          <span className="shead-busy" title={t('chat.working')} data-testid="shead-busy">
            <span className="shead-dot busy" />
          </span>
        ) : null}
        {previewing ? null : <SessionMenu />}
      </div>
    </div>
  )
}

export { SessionHeader as Continuity }
