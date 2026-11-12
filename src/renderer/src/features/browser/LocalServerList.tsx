import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Globe, RotateCw } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { Button, CollapsibleChevron, IconButton, Notice, RailRow, SiteIcon, StopButton } from '../../ui'
import type { LocalServerInfo } from '../../../../shared/local-servers'
import { browserText } from './browser-text'
import { groupLocalServers, localServerMarkName } from './local-server-groups'
import './local-server-list.css'

const REFRESH_INTERVAL_MS = 5000

interface LocalServerListProps {
  active: boolean
  compact?: boolean
  iconOnly?: boolean
  onOpen: (url: string) => void
}

function ServerFavicon({ url }: { url: string }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (failed) return <Globe size={14} aria-hidden="true" />
  return (
    <img
      className="v3-local-servers__favicon"
      src={`${url}/favicon.ico`}
      alt=""
      width={16}
      height={16}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

export function LocalServerList({ active, compact, iconOnly, onOpen }: LocalServerListProps): ReactElement | null {
  const t = useT()
  const { lang } = useI18n()
  const text = browserText(lang)
  const [servers, setServers] = useState<LocalServerInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [otherOpen, setOtherOpen] = useState(false)
  const alive = useRef(true)
  const [stopping, setStopping] = useState<number | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    const snapshot = await window.yan.browser.localServers().catch(() => null)
    if (!alive.current) return
    setRefreshing(false)
    if (snapshot) setServers(snapshot.servers ?? [])
  }, [])

  const stop = useCallback(async (port: number) => {
    setStopping(port)
    await window.yan.browser.stopLocalServer(port).catch(() => null)
    if (!alive.current) return
    setStopping(null)
    void load()
  }, [load])

  useEffect(() => {
    alive.current = true
    if (!active) {
      return () => {
        alive.current = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [active, load])

  const groups = groupLocalServers(servers)

  if (iconOnly) {
    if (groups.main.length === 0) return null
    return (
      <ul className="v3-local-servers v3-local-servers__list" data-compact="1" data-icon-only="1" data-testid="browser-local-servers-list">
        {groups.main.map((server) => (
          <RailRow
            key={server.url}
            iconOnly
            label={`${server.title || server.processName || t('browser.localServersListening')} · ${server.host}:${server.port}`}
            icon={<SiteIcon name={localServerMarkName(server)} className="v3-local-servers__mark" />}
            title={server.url}
            data-testid="browser-local-server-row"
            buttonProps={{ 'data-testid': 'browser-local-server-open' }}
            onPress={() => onOpen(server.url)}
          />
        ))}
      </ul>
    )
  }

  const row = (server: LocalServerInfo): ReactElement => (
    <RailRow
      key={server.url}
      label={server.title || server.processName || t('browser.localServersListening')}
      icon={<ServerFavicon url={server.url} />}
      value={compact ? `:${server.port}` : `${server.host}:${server.port}`}
      title={`${server.title || server.processName || ''}\n${server.host}:${server.port}\n${server.url}`.trim()}
      action={
        server.agentStarted ? (
          <StopButton
            aria-label={t('browser.localServerStop')}
            tooltip={t('browser.localServerStop')}
            isPending={stopping === server.port}
            data-testid="browser-local-server-stop"
            onPress={() => void stop(server.port)}
          />
        ) : undefined
      }
      data-testid="browser-local-server-row"
      buttonProps={{ 'data-testid': 'browser-local-server-open' }}
      onPress={() => onOpen(server.url)}
    />
  )

  return (
    <div className="v3-local-servers" data-compact={compact ? '1' : undefined} data-testid="browser-local-servers">
      <div className="v3-local-servers__head">
        <span className="v3-local-servers__title">{t('browser.localServers')}</span>
        <IconButton
          aria-label={t('browser.localServersRefresh')}
          tooltip={t('browser.localServersRefresh')}
          size="sm"
          isPending={refreshing}
          data-testid="browser-local-servers-refresh"
          onPress={() => void load(true)}
        >
          <RotateCw size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {servers.length === 0 ? (
        <Notice variant="hint" data-testid="browser-local-servers-empty">
          {t('browser.localServersEmpty')}
        </Notice>
      ) : (
        <ul className="v3-local-servers__list" data-testid="browser-local-servers-list">
          {groups.main.map(row)}
          {groups.other.length > 0 ? (
            <li className="v3-local-servers__other">
              <Button
                variant="ghost"
                size="sm"
                className="v3-local-servers__other-toggle"
                aria-expanded={otherOpen}
                trailingIcon={<CollapsibleChevron expanded={otherOpen} />}
                onPress={() => setOtherOpen((open) => !open)}
                data-testid="browser-local-servers-other"
              >
                {text.localServersOther(groups.other.length)}
              </Button>
              {otherOpen ? <ul className="v3-local-servers__list">{groups.other.map(row)}</ul> : null}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}
