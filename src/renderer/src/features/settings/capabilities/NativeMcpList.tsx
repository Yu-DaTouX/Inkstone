import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { NativeMcpServerListView } from '../../../../../shared/mcp-native-import'
import { Empty, Item, ItemHead, ListSkeleton, Meta, StatusBadge, Warn } from './parts'

export function NativeMcpList(): ReactElement {
  const t = useT()
  const sessionId = useStore((s) => s.session?.sessionId)
  const [list, setList] = useState<NativeMcpServerListView | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void window.yan.capabilities
      .nativeServers()
      .then((next) => {
        if (!alive.current) return
        setList(next)
        setError('')
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive.current = false
    }
  }, [sessionId])

  if (error) return <Warn>{error}</Warn>
  if (!list) return <ListSkeleton rows={1} />
  return (
    <>
      {list.errors?.map((problem) => <Warn key={problem}>{problem}</Warn>)}
      {list.projectUntrusted ? <Warn>{t('cap.nativeListUntrusted')}</Warn> : null}
      {list.servers.length === 0 ? (
        <Empty>{t('cap.nativeListEmpty', { path: list.globalPath })}</Empty>
      ) : (
        <div className="caps-list" data-testid="caps-native-mcp-servers">
          {list.servers.map((server) => (
            <Item key={server.name} testId="caps-native-mcp-server">
              <ItemHead>
                <span className="caps-name" title={server.path}>
                  {server.name}
                </span>
                <span className="caps-tag">{server.transport}</span>
                <span className="caps-tag">
                  {server.scope === 'project' ? t('cap.nativeScopeProject') : t('cap.nativeScopeGlobal')}
                </span>
                {server.exposure ? <span className="caps-tag">{server.exposure}</span> : null}
                <StatusBadge tone={server.enabled ? 'neutral' : 'stall'}>
                  {server.enabled ? t('cap.nativeEnabled') : t('cap.nativeDisabled')}
                </StatusBadge>
              </ItemHead>
              {server.command ? (
                <Meta title={server.path}>
                  {server.argCount > 0 ? t('cap.nativeCommandArgs', { command: server.command, count: server.argCount }) : server.command}
                </Meta>
              ) : server.endpointOrigin ? (
                <Meta title={server.path}>{server.endpointOrigin}</Meta>
              ) : null}
            </Item>
          ))}
        </div>
      )}
      <Meta>{t('cap.nativeListNewSession')}</Meta>
    </>
  )
}
