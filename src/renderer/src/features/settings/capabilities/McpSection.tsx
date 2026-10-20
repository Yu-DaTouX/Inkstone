import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type {
  CapabilityMcpServerSettingView,
  CapabilitySettingsSnapshot,
  CapabilityVerificationStatus,
  NativeMcpManageAction
} from '../../../../../shared/ipc'
import type { NativeMcpServerListView, NativeMcpServerView } from '../../../../../shared/mcp-native-import'
import { Badge, Button } from '../../../ui'
import { fillCapsText, useCapsText } from './text'
import { useConfirm } from './confirm'
import { Actions, Group, Item, ItemHead, ListSkeleton, Meta, Panel, StatusBadge, Warn } from './parts'
import { WINDOWS_MCP_SERVER_ID, canImportMcp, mcpStatusTone, verificationTone } from './model'
import { McpAppOwnership } from './McpAppOwnership'
import { McpAppRefresh } from './McpAppRefresh'
import { McpImportControl } from './McpImportControl'
import { NativeMcpItem, type NativeMcpAction } from './NativeMcpList'
import { CodegraphStatusRow } from './CodegraphStatusRow'

const CODEGRAPH_SERVER = 'codegraph'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
}

export function McpSection(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const confirm = useConfirm()
  const sessionId = useStore((s) => s.session?.sessionId)
  const [snapshot, setSnapshot] = useState<CapabilitySettingsSnapshot | null>(null)
  const [nativeList, setNativeList] = useState<NativeMcpServerListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nativeError, setNativeError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [managing, setManaging] = useState<string | null>(null)
  const [codegraphKey, setCodegraphKey] = useState(0)
  const mounted = useRef(true)
  const commands = useNativeMcpCommands(snapshot?.nativeMcpAvailable === true)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [snapshotResult, nativeResult] = await Promise.allSettled([
      window.yan.capabilities.snapshot(),
      window.yan.capabilities.nativeServers()
    ])
    if (!mounted.current) return
    if (snapshotResult.status === 'fulfilled') {
      setSnapshot(snapshotResult.value)
      setError(null)
    } else setError(errorText(snapshotResult.reason))
    if (nativeResult.status === 'fulfilled') {
      setNativeList(nativeResult.value)
      setNativeError(null)
    } else setNativeError(errorText(nativeResult.reason))
    setLoading(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh, sessionId])

  const manage = async (action: NativeMcpManageAction, server: NativeMcpServerView): Promise<void> => {
    const paths = [server.path, ...(server.overriddenBy ? [server.overriddenBy] : [])]
    const target = action === 'remove' ? paths.join(' · ') : (server.overriddenBy ?? server.path)
    if (action === 'remove') {
      const accepted = await confirm({
        title: fillCapsText(text('mcpRemoveTitle'), { name: server.name }),
        body: fillCapsText(text('mcpRemoveBody'), { path: target }),
        confirmLabel: text('mcpRemove'),
        tone: 'danger'
      })
      if (!accepted) return
    }
    setManaging(server.name)
    setNotice(null)
    setNativeError(null)
    try {
      const result = await window.yan.capabilities.manageNativeServer(action, server.name)
      if (!mounted.current) return
      if (result.ok) setNotice(fillCapsText(text('mcpSaved'), { path: target }))
      else setNativeError(result.error ?? t('cap.nativeMcpActionFailed'))
      await refresh()
    } catch (cause) {
      if (mounted.current) setNativeError(errorText(cause))
    } finally {
      if (mounted.current) setManaging(null)
    }
  }

  const addCodegraph = async (): Promise<void> => {
    setManaging(CODEGRAPH_SERVER)
    setNotice(null)
    try {
      const result = await window.yan.packages.addMcp(CODEGRAPH_SERVER)
      if (!mounted.current || result.cancelled) return
      if (result.ok) setNotice(t(result.existed ? 'market.mcpExisted' : 'market.mcpAdded', { path: result.path ?? '' }))
      else setNativeError(result.error ?? t('pkg.failed'))
      setCodegraphKey((value) => value + 1)
      await refresh()
    } catch (cause) {
      if (mounted.current) setNativeError(errorText(cause))
    } finally {
      if (mounted.current) setManaging(null)
    }
  }

  const servers = snapshot?.servers ?? []
  const directServer = servers.find((server) => server.id === WINDOWS_MCP_SERVER_ID)
  const legacyServers = servers.filter((server) => server.id !== WINDOWS_MCP_SERVER_ID)
  const nativeServers = nativeList?.servers ?? []
  const hasCodegraph = nativeServers.some((server) => server.name === CODEGRAPH_SERVER)

  return (
    <Panel label={text('mcpListTitle')}>
      {error ? <Warn>{`${text('loadFailed')}: ${error}`}</Warn> : null}
      {snapshot?.configWarning ? <Warn>{t('cap.configWarning')}</Warn> : null}

      <Group
        title={text('mcpListTitle')}
        desc={text('mcpListDesc')}
        settingId="caps-mcp-servers"
        actions={
          <Button variant="secondary" isPending={loading} onPress={() => void refresh()} data-testid="caps-mcp-reload">
            {text('sectionReload')}
          </Button>
        }
      >
        {nativeError ? <Warn>{nativeError}</Warn> : null}
        {nativeList?.errors?.map((problem) => <Warn key={problem}>{problem}</Warn>)}
        {nativeList?.projectUntrusted ? <Warn>{t('cap.nativeListUntrusted')}</Warn> : null}
        {loading && !nativeList && !snapshot ? (
          <ListSkeleton rows={2} />
        ) : (
          <div className="caps-list" data-testid="caps-native-mcp-servers">
            {nativeServers.map((server) => (
              <NativeMcpItem
                key={server.name}
                server={server}
                sessionActionable={commands.actionable}
                sessionBusy={commands.running !== null}
                manageBusy={managing !== null}
                onSessionAction={commands.available ? (action, name) => void commands.runAction(action, name) : undefined}
                onManage={(action, target) => void manage(action, target)}
              >
                {server.name === CODEGRAPH_SERVER ? (
                  <div data-setting-id="caps-mcp-codegraph">
                    <CodegraphStatusRow refreshKey={String(codegraphKey)} />
                  </div>
                ) : null}
              </NativeMcpItem>
            ))}
            <McpServerRow server={directServer} direct onChanged={refresh} />
            {nativeList && !hasCodegraph ? (
              <Item testId="caps-mcp-codegraph-guide" settingId="caps-mcp-codegraph">
                <ItemHead>
                  <span className="caps-name">{text('codegraphTitle')}</span>
                  <span className="caps-spacer" />
                  <Actions>
                    <Button
                      variant="secondary"
                      isDisabled={managing !== null}
                      onPress={() => void addCodegraph()}
                      data-testid="caps-mcp-codegraph-add"
                    >
                      {t('market.addMcp')}
                    </Button>
                  </Actions>
                </ItemHead>
                <Meta>{text('codegraphGuide')}</Meta>
              </Item>
            ) : null}
          </div>
        )}
        {nativeList && nativeServers.length === 0 ? (
          <Meta>{t('cap.nativeListEmpty', { path: nativeList.globalPath })}</Meta>
        ) : null}
        {notice ? (
          <p className="caps-result" role="status" data-testid="caps-mcp-notice">
            {notice}
          </p>
        ) : null}
        <NativeMcpStatusControl commands={commands} ready={snapshot !== null} />
      </Group>

      {legacyServers.length > 0 ? (
        <Group title={text('mcpLegacyTitle')} desc={text('mcpLegacyDesc')} settingId="caps-mcp-legacy">
          <div className="caps-list" data-testid="caps-mcp-servers">
            {legacyServers.map((server) => (
              <McpServerRow key={server.id} server={server} onChanged={refresh} />
            ))}
          </div>
        </Group>
      ) : null}
      <div data-setting-id="caps-mcp-ownership">
        <McpAppOwnership />
      </div>
      <div data-setting-id="caps-mcp-app-snapshot">
        <McpAppRefresh />
      </div>
    </Panel>
  )
}

function McpServerRow({
  server,
  direct = false,
  onChanged
}: {
  server: CapabilityMcpServerSettingView | undefined
  direct?: boolean
  onChanged: () => Promise<void>
}): ReactElement {
  const t = useT()
  const text = useCapsText()
  const mounted = useRef(true)
  const [operation, setOperation] = useState<CapabilityVerificationStatus | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const verify = async (): Promise<void> => {
    if (!server) return
    setVerifyError(null)
    try {
      const started = await window.yan.capabilities.verify(server.id)
      if (!started.ok || !started.operationId) {
        setVerifyError(started.error ?? t('cap.verifyFailed'))
        return
      }
      const operationId = started.operationId
      setOperation({ operationId, state: 'connecting' })
      for (let attempt = 0; attempt < 70 && mounted.current; attempt++) {
        await sleep(350)
        const state = await window.yan.capabilities.verification(operationId)
        if (!state || state.state !== 'connecting') {
          if (mounted.current && state) setOperation(state)
          await onChanged()
          return
        }
      }
      if (mounted.current) setOperation({ operationId, state: 'error' })
    } catch (cause) {
      if (mounted.current) setVerifyError(errorText(cause))
    }
  }

  const cancel = async (operationId: string): Promise<void> => {
    try {
      const result = await window.yan.capabilities.cancelVerification(operationId)
      if (!result.ok) setVerifyError(result.error ?? t('cap.cancelFailed'))
      const state = await window.yan.capabilities.verification(operationId)
      if (state) setOperation(state)
      await onChanged()
    } catch (cause) {
      setVerifyError(errorText(cause))
    }
  }

  const connecting = operation?.state === 'connecting'
  const imported = server?.migratedToNative

  return (
    <Item testId={direct ? 'caps-mcp-direct' : 'caps-mcp-server'} settingId={direct ? 'caps-mcp-computer-use' : undefined}>
      <ItemHead>
        <span className="caps-name" title={server?.title ?? WINDOWS_MCP_SERVER_ID}>
          {direct ? `${t('cu.title')} · ${WINDOWS_MCP_SERVER_ID}` : server?.title}
        </span>
        {direct ? <Badge tone="accent">{text('mcpDirectBadge')}</Badge> : null}
        {server ? <Badge>{server.transport}</Badge> : null}
        {server ? (
          <StatusBadge tone={mcpStatusTone(server.status)}>{t(`cap.status.${server.status}` as 'cap.status.ready')}</StatusBadge>
        ) : (
          <Badge>{text('mcpDirectOff')}</Badge>
        )}
        {server?.projectScoped ? <Badge>{t('cap.projectScoped')}</Badge> : null}
        {server && !server.enabled ? <Badge>{t('cap.disabled')}</Badge> : null}
        {imported ? <StatusBadge tone="accent">{t('cap.importMigratedBadge')}</StatusBadge> : null}
        <span className="caps-spacer" />
        {server ? (
          <Actions>
            {connecting && operation ? (
              <Button variant="secondary" onPress={() => void cancel(operation.operationId)} data-testid="caps-mcp-cancel">
                {t('cap.cancel')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                isDisabled={!server.enabled}
                onPress={() => void verify()}
                data-testid="caps-mcp-verify"
              >
                {t('cap.verify')}
              </Button>
            )}
          </Actions>
        ) : null}
      </ItemHead>
      {direct ? <Meta>{text('mcpDirectNote')}</Meta> : null}
      {server ? (
        <Meta>
          {server.endpointOrigin ? `${server.endpointOrigin} · ` : ''}
          {t(`cap.effect.${server.effect}` as 'cap.effect.unknown')}
          {server.toolCount !== null ? ` · ${t('cap.toolCount', { count: server.toolCount })}` : ''}
        </Meta>
      ) : null}

      {verifyError ? <Warn>{verifyError}</Warn> : null}
      {operation && operation.state !== 'connecting' ? (
        <p className="caps-result" role="status" data-testid="caps-mcp-operation">
          <StatusBadge tone={verificationTone(operation.state)}>{t(`cap.operation.${operation.state}` as 'cap.operation.ready')}</StatusBadge>
          {operation.toolCount !== undefined ? <span> · {t('cap.toolCount', { count: operation.toolCount })}</span> : null}
        </p>
      ) : null}

      {imported ? (
        <div className="caps-import" data-testid="caps-mcp-migrated">
          <Meta>{t('cap.importMigratedNotice')}</Meta>
        </div>
      ) : server && !direct && canImportMcp(server) ? (
        <McpImportControl server={server} onChanged={onChanged} />
      ) : null}
    </Item>
  )
}

interface NativeMcpCommands {
  available: boolean
  actionable: boolean
  running: string | null
  busy: boolean
  error: string | null
  query: () => Promise<void>
  runAction: (action: NativeMcpAction, server: string) => Promise<void>
}

function useNativeMcpCommands(available: boolean): NativeMcpCommands {
  const t = useT()
  const session = useStore((s) => s.session)
  const send = useStore((s) => s.send)
  const ensureActivated = useStore((s) => s.ensureActivated)
  const nativeMcpStatus = useStore((s) => s.nativeMcpStatus)
  const busySession = useStore(
    (s) => !!s.session?.isAgentRunning || !!s.session?.isStreaming || !!s.session?.isCompacting
  )
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(timer.current)
      useStore.setState({ nativeMcpStatus: null })
    }
  }, [session?.sessionId])

  const query = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (!(await ensureActivated()) || !mounted.current) return
      const sessionId = useStore.getState().session?.sessionId
      if (!sessionId) return
      const request = { sessionId, pending: true, text: '' }
      useStore.setState({ nativeMcpStatus: request })
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (useStore.getState().nativeMcpStatus === request) {
          useStore.setState({ nativeMcpStatus: { ...request, pending: false, text: t('cap.nativeMcpTimeout') } })
        }
      }, 30_000)
      if (!(await send('/mcp'))) {
        if (useStore.getState().nativeMcpStatus === request) useStore.setState({ nativeMcpStatus: null })
        if (mounted.current) setError(t('cap.loadFailed'))
      }
    } catch (cause) {
      if (useStore.getState().nativeMcpStatus?.pending) useStore.setState({ nativeMcpStatus: null })
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const runAction = async (action: NativeMcpAction, server: string): Promise<void> => {
    if (running) return
    setRunning(`${action}:${server}`)
    setError(null)
    try {
      if (!(await ensureActivated()) || !mounted.current) return
      const sessionId = useStore.getState().session?.sessionId
      if (!sessionId) return
      const request = { sessionId, pending: true, text: '', action }
      useStore.setState({ nativeMcpStatus: request })
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        const current = useStore.getState().nativeMcpStatus
        if (current?.pending && current.sessionId === sessionId && current.action === action) {
          useStore.setState({ nativeMcpStatus: { ...current, pending: false, text: current.text || t('cap.nativeMcpActionTimeout') } })
        }
      }, action === 'login' ? 300_000 : 90_000)
      if (!(await send(`/mcp ${action} ${server}`))) {
        if (useStore.getState().nativeMcpStatus === request) useStore.setState({ nativeMcpStatus: null })
        if (mounted.current) setError(t('cap.nativeMcpActionFailed'))
      }
    } catch (cause) {
      if (useStore.getState().nativeMcpStatus?.pending) useStore.setState({ nativeMcpStatus: null })
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setRunning(null)
    }
  }

  return {
    available,
    actionable: available && !busy && !busySession && !!session?.sessionId && !nativeMcpStatus?.pending,
    running,
    busy: busy || busySession || !session?.sessionId,
    error,
    query,
    runAction
  }
}

function NativeMcpStatusControl({ commands, ready }: { commands: NativeMcpCommands; ready: boolean }): ReactElement {
  const t = useT()
  const text = useCapsText()
  const sessionId = useStore((s) => s.session?.sessionId)
  const nativeMcpStatus = useStore((s) => s.nativeMcpStatus)
  return (
    <div data-setting-id="caps-mcp-native-status">
      {!ready ? null : commands.available ? (
        <>
          <div className="caps-actions caps-actions--start">
            <Button
              variant="secondary"
              isDisabled={commands.busy}
              onPress={() => void commands.query()}
              data-testid="caps-native-mcp"
            >
              {t('cap.nativeMcpOpen')}
            </Button>
          </div>
          {nativeMcpStatus && nativeMcpStatus.sessionId === sessionId ? (
            <p className="caps-result" role="status" data-testid="caps-native-mcp-status">
              {nativeMcpStatus.text || (nativeMcpStatus.action ? t('cap.nativeMcpActionRunning') : t('cap.nativeMcpLoading'))}
            </p>
          ) : null}
        </>
      ) : (
        <Meta>{text('mcpNativeUnavailable')}</Meta>
      )}
      {commands.error ? <Warn>{commands.error}</Warn> : null}
    </div>
  )
}
