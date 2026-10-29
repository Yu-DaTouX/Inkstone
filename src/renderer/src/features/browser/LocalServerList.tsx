import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Globe, RotateCw } from 'lucide-react'
import { useT } from '../../i18n'
import { IconButton, Notice, RailRow } from '../../ui'
import type { LocalServerInfo } from '../../../../shared/local-servers'
import './local-server-list.css'

const REFRESH_INTERVAL_MS = 5000

interface LocalServerListProps {
  active: boolean
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

export function LocalServerList({ active, onOpen }: LocalServerListProps): ReactElement {
  const t = useT()
  const [servers, setServers] = useState<LocalServerInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    const snapshot = await window.yan.browser.localServers().catch(() => null)
    if (!alive.current) return
    setRefreshing(false)
    if (snapshot) setServers(snapshot.servers ?? [])
  }, [])

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

  return (
    <div className="v3-local-servers" data-testid="browser-local-servers">
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
          {servers.map((server) => (
            <RailRow
              key={server.url}
              label={server.title || server.processName || t('browser.localServersListening')}
              icon={<ServerFavicon url={server.url} />}
              value={`${server.host}:${server.port}`}
              title={server.url}
              data-testid="browser-local-server-row"
              buttonProps={{ 'data-testid': 'browser-local-server-open' }}
              onPress={() => onOpen(server.url)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
