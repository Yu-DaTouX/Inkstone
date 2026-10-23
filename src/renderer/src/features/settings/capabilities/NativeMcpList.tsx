import type { ReactElement, ReactNode } from 'react'
import { useT } from '../../../i18n'
import type { NativeMcpServerView } from '../../../../../shared/mcp-native-import'
import type { NativeMcpManageAction } from '../../../../../shared/ipc'
import { Button, Switch } from '../../../ui'
import { fillCapsText, useCapsText } from './text'
import { Entry } from './parts'
import { useCodegraphStatus } from './CodegraphStatusRow'

export type NativeMcpAction = 'login' | 'logout' | 'reconnect'

interface NativeMcpItemProps {
  server: NativeMcpServerView
  sessionActionable: boolean
  sessionBusy: boolean
  manageBusy: boolean
  onSessionAction?: (action: NativeMcpAction, server: string) => void
  onManage: (action: NativeMcpManageAction, server: NativeMcpServerView) => void
  settingId?: string
  extraMeta?: readonly string[]
  extraMetaTitle?: string
  extraAction?: ReactNode
  children?: ReactNode
}

export function NativeMcpItem({
  server,
  sessionActionable,
  sessionBusy,
  manageBusy,
  onSessionAction,
  onManage,
  settingId,
  extraMeta,
  extraMetaTitle,
  extraAction,
  children
}: NativeMcpItemProps): ReactElement {
  const t = useT()
  const text = useCapsText()
  const sessionCommandsAllowed = !!onSessionAction && server.enabled && !/\s/.test(server.name)
  const sessionDisabled = !sessionActionable || sessionBusy
  const command = server.command
    ? server.argCount > 0
      ? t('cap.nativeCommandArgs', { command: server.command, count: server.argCount })
      : server.command
    : server.endpointOrigin
  return (
    <Entry
      testId="caps-native-mcp-server"
      settingId={settingId}
      name={server.name}
      nameTitle={server.path}
      control={
        <Switch
          aria-label={fillCapsText(text('mcpToggleLabel'), { name: server.name })}
          isSelected={server.enabled}
          isDisabled={manageBusy}
          onChange={(next) => onManage(next ? 'enable' : 'disable', server)}
          data-testid="caps-native-mcp-toggle"
        />
      }
      meta={[
        server.transport,
        server.scope === 'project' ? t('cap.nativeScopeProject') : t('cap.nativeScopeGlobal'),
        server.exposure,
        server.enabled ? null : t('cap.nativeDisabled'),
        ...(extraMeta ?? []),
        command
      ]}
      metaTitle={[extraMetaTitle, server.path].filter(Boolean).join('\n') || undefined}
      actions={
        <>
          {extraAction}
          {sessionCommandsAllowed && server.transport === 'http' ? (
            <>
              <Button
                variant="secondary"
                isDisabled={sessionDisabled}
                title={t('cap.nativeMcpLoginHint')}
                onPress={() => onSessionAction?.('login', server.name)}
                data-testid="caps-native-mcp-login"
              >
                {t('cap.nativeMcpLogin')}
              </Button>
              <Button
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
              variant="secondary"
              isDisabled={sessionDisabled}
              onPress={() => onSessionAction?.('reconnect', server.name)}
              data-testid="caps-native-mcp-reconnect"
            >
              {t('cap.nativeMcpReconnect')}
            </Button>
          ) : null}
          <Button
            variant="danger"
            isDisabled={manageBusy}
            onPress={() => onManage('remove', server)}
            data-testid="caps-native-mcp-remove"
          >
            {text('mcpRemove')}
          </Button>
        </>
      }
    >
      {children}
    </Entry>
  )
}

export function CodegraphMcpItem({ refreshKey, ...props }: Omit<NativeMcpItemProps, 'extraMeta' | 'extraMetaTitle' | 'extraAction' | 'children'> & { refreshKey: string }): ReactElement {
  const status = useCodegraphStatus(refreshKey)
  return (
    <NativeMcpItem {...props} extraMeta={status?.meta} extraMetaTitle={status?.metaTitle} extraAction={status?.action}>
      {status?.result}
    </NativeMcpItem>
  )
}
