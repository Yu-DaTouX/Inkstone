import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { CapabilityMcpServerSettingView, CapabilitySettingsSnapshot, CapabilityVerificationStatus } from '../../../../../shared/ipc'
import { Badge, Button } from '../../../ui'
import { useCapsText } from './text'
import { Entry, Group, Meta, Panel, StatusBadge, Warn } from './parts'
import { WINDOWS_MCP_SERVER_ID, canImportMcp, verificationTone } from './model'
import { McpAppOwnership } from './McpAppOwnership'
import { McpAppRefresh } from './McpAppRefresh'
import { McpImportControl } from './McpImportControl'
import type { NativeMcpAction } from './NativeMcpList'
import { McpServices } from './McpServices'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function McpSection(): ReactElement {
  return <McpServices advanced={<McpAdvancedSettings />} />
}

function McpAdvancedSettings(): ReactElement {
  const text = useCapsText()
  const sessionId = useStore((s) => s.session?.sessionId)
  const [snapshot, setSnapshot] = useState<CapabilitySettingsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const refresh = useCallback(async (): Promise<void> => {
    try { const result = await window.yan.capabilities.snapshot(); if (mounted.current) { setSnapshot(result); setError(null) } }
    catch (cause) { if (mounted.current) setError(errorText(cause)) }
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh, sessionId])
  const commands = useNativeMcpCommands(snapshot?.nativeMcpAvailable === true)
  const legacy = snapshot?.servers.filter((server) => server.id !== WINDOWS_MCP_SERVER_ID && !server.migratedToNative) ?? []
  return <Panel label={text('mcpLegacyTitle')}>
    {error ? <Warn>{error}</Warn> : null}
    {legacy.length ? <Group title={text('mcpLegacyTitle')} desc={text('mcpLegacyDesc')}>
      {legacy.map((server) => <McpServerRow key={server.id} server={server} onChanged={refresh} />)}
    </Group> : null}
    <NativeMcpStatusControl commands={commands} ready={snapshot !== null} />
    <McpAppOwnership />
    <McpAppRefresh />
  </Panel>
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

  const metaParts = [
    direct ? text('mcpDirectBadge') : null,
    server ? t(`cap.status.${server.status}` as 'cap.status.ready') : text('mcpDirectOff'),
    server?.projectScoped ? t('cap.projectScoped') : null,
    server && !server.enabled ? t('cap.disabled') : null,
    imported ? t('cap.importMigratedBadge') : null,
    server?.endpointOrigin,
    server ? t(`cap.effect.${server.effect}` as 'cap.effect.unknown') : null,
    server && server.toolCount !== null ? t('cap.toolCount', { count: server.toolCount }) : null,
    direct ? text('mcpDirectNote') : null
  ]

  return (
    <Entry
      testId={direct ? 'caps-mcp-direct' : 'caps-mcp-server'}
      settingId={direct ? 'caps-mcp-computer-use' : undefined}
      name={direct ? `${t('cu.title')} · ${WINDOWS_MCP_SERVER_ID}` : server?.title}
      nameTitle={server?.title ?? WINDOWS_MCP_SERVER_ID}
      badge={server ? <Badge>{server.transport}</Badge> : null}
      meta={metaParts}
      actions={
        server ? (
          connecting && operation ? (
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
          )
        ) : null
      }
    >
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
    </Entry>
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
