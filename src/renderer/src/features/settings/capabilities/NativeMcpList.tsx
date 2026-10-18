import type { ReactElement, ReactNode } from 'react'
import { useT } from '../../../i18n'
import type { NativeMcpServerView } from '../../../../../shared/mcp-native-import'
import type { NativeMcpManageAction } from '../../../../../shared/ipc'
import { Badge, Button, Switch } from '../../../ui'
import { fillCapsText, useCapsText } from './text'
import { Actions, Item, ItemHead, Meta } from './parts'

export type NativeMcpAction = 'login' | 'logout' | 'reconnect'

export function NativeMcpItem({
  server,
  sessionActionable,
  sessionBusy,
  manageBusy,
  onSessionAction,
  onManage,
  children
}: {
  server: NativeMcpServerView
  sessionActionable: boolean
  sessionBusy: boolean
  manageBusy: boolean
  onSessionAction?: (action: NativeMcpAction, server: string) => void
  onManage: (action: NativeMcpManageAction, server: NativeMcpServerView) => void
  children?: ReactNode
}): ReactElement {
  const t = useT()
  const text = useCapsText()
  const sessionCommandsAllowed = !!onSessionAction && server.enabled && !/\s/.test(server.name)
  const sessionDisabled = !sessionActionable || sessionBusy
  return (
    <Item testId="caps-native-mcp-server">
      <ItemHead>
        <span className="caps-name" title={server.path}>
          {server.name}
        </span>
        <Badge>{server.transport}</Badge>
        <Badge>{server.scope === 'project' ? t('cap.nativeScopeProject') : t('cap.nativeScopeGlobal')}</Badge>
        {server.exposure ? <Badge>{server.exposure}</Badge> : null}
        {server.enabled ? null : <Badge tone="stall">{t('cap.nativeDisabled')}</Badge>}
        <span className="caps-spacer" />
        <Switch
          aria-label={fillCapsText(text('mcpToggleLabel'), { name: server.name })}
          isSelected={server.enabled}
          isDisabled={manageBusy}
          onChange={(next) => onManage(next ? 'enable' : 'disable', server)}
          data-testid="caps-native-mcp-toggle"
        />
      </ItemHead>
      {server.command ? (
        <Meta title={server.path}>
          {server.argCount > 0 ? t('cap.nativeCommandArgs', { command: server.command, count: server.argCount }) : server.command}
        </Meta>
      ) : server.endpointOrigin ? (
        <Meta title={server.path}>{server.endpointOrigin}</Meta>
      ) : null}
      <Actions>
        {sessionCommandsAllowed && server.transport === 'http' ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={sessionDisabled}
              title={t('cap.nativeMcpLoginHint')}
              onPress={() => onSessionAction?.('login', server.name)}
              data-testid="caps-native-mcp-login"
            >
              {t('cap.nativeMcpLogin')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={sessionDisabled}
              onPress={() => onSessionAction?.('logout', server.name)}
              data-testid="caps-native-mcp-logout"
            >
              {t('cap.nativeMcpLogout')}
            </Button>
          </>
        ) : null}
        {sessionCommandsAllowed ? (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={sessionDisabled}
            onPress={() => onSessionAction?.('reconnect', server.name)}
            data-testid="caps-native-mcp-reconnect"
          >
            {t('cap.nativeMcpReconnect')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="danger"
          isDisabled={manageBusy}
          onPress={() => onManage('remove', server)}
          data-testid="caps-native-mcp-remove"
        >
          {text('mcpRemove')}
        </Button>
      </Actions>
      {children}
    </Item>
  )
}
