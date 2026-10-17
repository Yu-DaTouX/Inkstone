import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type {
  CapabilityMcpServerSettingView,
  CapabilitySettingsSnapshot,
  CapabilityVerificationStatus
} from '../../../../../shared/ipc'
import type {
  NativeMcpImportCommitResult,
  NativeMcpImportPreview
} from '../../../../../shared/mcp-native-import'
import { Button } from '../../../ui'
import { useCapsText } from './text'
import { useConfirm } from './confirm'
import { formatImportPreviewDetail, type ImportPreviewLabels } from './native-preview'
import { Actions, Empty, Group, Item, ItemHead, ListSkeleton, Meta, Note, Panel, StatusBadge, Warn } from './parts'
import { canImportMcp, mcpStatusTone, verificationTone } from './model'
import { McpAppOwnership } from './McpAppOwnership'
import { McpAppRefresh } from './McpAppRefresh'
import { NativeMcpList, type NativeMcpAction } from './NativeMcpList'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const MANUAL_CODES = new Set([
  'needs_reauth',
  'needs_auth',
  'needs-auth',
  'unsupported',
  'not_trusted',
  'unavailable'
])

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
}

export function McpSection(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const [snapshot, setSnapshot] = useState<CapabilitySettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.yan.capabilities.snapshot()
      if (!mounted.current) return
      setSnapshot(next)
      setError(null)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  return (
    <Panel label={t('cap.mcpTitle')}>
      <Note>{text('mcpHostNote')}</Note>
      {error ? <Warn>{`${text('loadFailed')}: ${error}`}</Warn> : null}
      {snapshot?.configWarning ? <Warn>{t('cap.configWarning')}</Warn> : null}

      <Group
        title={t('cap.mcpTitle')}
        desc={t('cap.mcpDesc')}
        actions={
          <Button size="sm" variant="ghost" isPending={loading} onPress={() => void refresh()} data-testid="caps-mcp-reload">
            {text('sectionReload')}
          </Button>
        }
      >
        {loading && !snapshot ? (
          <ListSkeleton />
        ) : !snapshot || snapshot.servers.length === 0 ? (
          <Empty>{t('cap.emptyMcp')}</Empty>
        ) : (
          <div className="caps-list" data-testid="caps-mcp-servers">
            {snapshot.servers.map((server) => (
              <McpServerRow key={server.id} server={server} onChanged={refresh} />
            ))}
          </div>
        )}
      </Group>

      <NativeMcpGroup available={snapshot?.nativeMcpAvailable === true} />

      <McpAppOwnership />
      <McpAppRefresh />
    </Panel>
  )
}

function McpServerRow({
  server,
  onChanged
}: {
  server: CapabilityMcpServerSettingView
  onChanged: () => Promise<void>
}): ReactElement {
  const t = useT()
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
  const imported = server.migratedToNative

  return (
    <Item testId="caps-mcp-server">
      <ItemHead>
        <span className="caps-name" title={server.title}>
          {server.title}
        </span>
        <span className="caps-tag">{server.transport}</span>
        <StatusBadge tone={mcpStatusTone(server.status)}>{t(`cap.status.${server.status}` as 'cap.status.ready')}</StatusBadge>
        {server.projectScoped ? <span className="caps-tag">{t('cap.projectScoped')}</span> : null}
        {!server.enabled ? <span className="caps-tag">{t('cap.disabled')}</span> : null}
        {imported ? <StatusBadge tone="accent">{t('cap.importMigratedBadge')}</StatusBadge> : null}
        <span className="caps-spacer" />
        <Actions>
          {connecting && operation ? (
            <Button size="sm" variant="secondary" onPress={() => void cancel(operation.operationId)} data-testid="caps-mcp-cancel">
              {t('cap.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!server.enabled}
              onPress={() => void verify()}
              data-testid="caps-mcp-verify"
            >
              {t('cap.verify')}
            </Button>
          )}
        </Actions>
      </ItemHead>
      <Meta>
        {server.endpointOrigin ? `${server.endpointOrigin} · ` : ''}
        {t(`cap.effect.${server.effect}` as 'cap.effect.unknown')}
        {server.toolCount !== null ? ` · ${t('cap.toolCount', { count: server.toolCount })}` : ''}
      </Meta>

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
      ) : canImportMcp(server) ? (
        <McpImportControl server={server} onChanged={onChanged} />
      ) : null}
    </Item>
  )
}

function McpImportControl({
  server,
  onChanged
}: {
  server: CapabilityMcpServerSettingView
  onChanged: () => Promise<void>
}): ReactElement {
  const t = useT()
  const text = useCapsText()
  const confirm = useConfirm()
  const running = useStore(
    (s) =>
      s.runners.some((runner) => runner.running) ||
      !!s.session?.isAgentRunning ||
      !!s.session?.isStreaming ||
      !!s.session?.isCompacting
  )
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<
    | { phase: 'cancelled' }
    | { phase: 'scope-changed' }
    | { phase: 'failed'; code: string; error?: string; manual: boolean }
    | { phase: 'done'; result: NativeMcpImportCommitResult }
    | null
  >(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const captureScope = (): { activeRunnerId: string | null; sessionId: string; projectKey: string } => {
    const state = useStore.getState()
    const runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
    return {
      activeRunnerId: state.activeRunnerId,
      sessionId: state.session?.sessionId ?? '',
      projectKey: runner?.projectId ?? state.session?.cwd ?? state.settings?.cwd ?? ''
    }
  }

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    const before = captureScope()
    try {
      const prepared = await window.yan.capabilities.prepareNativeImport(server.id)
      if (!prepared.ok || !prepared.preview) {
        setOutcome({
          phase: 'failed',
          code: prepared.code ?? 'prepare_failed',
          error: prepared.error,
          manual: MANUAL_CODES.has(prepared.code ?? '')
        })
        return
      }
      const preview: NativeMcpImportPreview = prepared.preview
      const labels: ImportPreviewLabels = {
        sourceTitle: t('cap.importSourceTitle'),
        nativeName: t('cap.importNativeName'),
        scope: preview.scope === 'project' ? t('cap.importScope.project') : t('cap.importScope.global'),
        targetPath: t('cap.importTargetPath'),
        entry: t('cap.importEntry'),
        warnings: t('cap.importWarnings'),
        description: text('importFieldDescription'),
        transport: text('importFieldTransport'),
        command: text('importFieldCommand'),
        args: text('importFieldArgs'),
        envKeys: text('importFieldEnvKeys'),
        url: text('importFieldUrl')
      }
      const accepted = await confirm({
        title: t('cap.importConfirmTitle', { name: server.title }),
        body: `${t('cap.importConfirmBody')}\n${t('cap.importConfirmLocalWarning')}`,
        detail: formatImportPreviewDetail(preview, server.title, labels),
        confirmLabel: t('cap.importConfirmLabel')
      })
      if (!accepted) {
        if (mounted.current) setOutcome({ phase: 'cancelled' })
        return
      }
      const after = captureScope()
      if (
        after.activeRunnerId !== before.activeRunnerId ||
        after.sessionId !== before.sessionId ||
        after.projectKey !== before.projectKey
      ) {
        setOutcome({ phase: 'scope-changed' })
        return
      }
      const committed = await window.yan.capabilities.commitNativeImport(preview.token)
      if (committed.ok && committed.result) {
        if (mounted.current) setOutcome({ phase: 'done', result: committed.result })
      } else {
        setOutcome({
          phase: 'failed',
          code: committed.code ?? 'commit_failed',
          error: committed.error,
          manual: MANUAL_CODES.has(committed.code ?? '')
        })
      }
      try {
        await onChanged()
      } catch {
      }
    } catch (cause) {
      if (mounted.current) setOutcome({ phase: 'failed', code: 'exception', error: errorText(cause), manual: false })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const blocked = running

  return (
    <div className="caps-import" data-testid="caps-mcp-import">
      <ItemHead>
        <span className="caps-spacer" />
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy || blocked}
          onPress={() => void start()}
          data-testid="caps-mcp-import-btn"
        >
          {busy ? t('cap.importing') : t('cap.importAction')}
        </Button>
      </ItemHead>
      {blocked ? <Meta>{text('mcpRunningBlock')}</Meta> : null}
      <McpImportOutcome outcome={outcome} />
    </div>
  )
}

function McpImportOutcome({
  outcome
}: {
  outcome:
    | { phase: 'cancelled' }
    | { phase: 'scope-changed' }
    | { phase: 'failed'; code: string; error?: string; manual: boolean }
    | { phase: 'done'; result: NativeMcpImportCommitResult }
    | null
}): ReactElement | null {
  const t = useT()
  if (!outcome) return null
  if (outcome.phase === 'cancelled') {
    return (
      <Meta>
        <span role="status">{t('cap.importCancelled')}</span>
      </Meta>
    )
  }
  if (outcome.phase === 'scope-changed') {
    return <Warn>{t('cap.importScopeChanged')}</Warn>
  }
  if (outcome.phase === 'failed') {
    return (
      <div className="caps-result" role="status" data-testid="caps-mcp-import-failed">
        <Warn>
          {t('cap.importFailed')} · {t('cap.importCode', { code: outcome.code })}
        </Warn>
        {outcome.error ? <Meta>{outcome.error}</Meta> : null}
        {outcome.manual ? <Meta>{t('cap.importManualHint')}</Meta> : null}
        <Meta>{t('cap.importPreservedNotice')}</Meta>
      </div>
    )
  }
  const { result } = outcome
  return (
    <div className="caps-result" role="status" data-testid="caps-mcp-import-result">
      <Meta>{t('cap.importResultTitle')}</Meta>
      <Meta>
        {t('cap.importStep.nativeWrite')}: {t(`cap.importState.${result.steps.nativeWrite}` as 'cap.importState.written')}
      </Meta>
      <Meta>
        {t('cap.importStep.verify')}: {t(`cap.importState.${result.steps.verify}` as 'cap.importState.passed')}
      </Meta>
      <Meta>
        {t('cap.importStep.hostDisable')}: {t(`cap.importState.${result.steps.hostDisable}` as 'cap.importState.disabled')}
      </Meta>
      {result.ok ? <Meta>{t('cap.importSuccess')}</Meta> : null}
      {!result.deactivated ? <Meta>{t('cap.importPreservedNotice')}</Meta> : null}
      {result.notice ? <Meta>{result.notice}</Meta> : null}
      {result.warnings.map((warning) => (
        <Meta key={warning}>{warning}</Meta>
      ))}
      <Meta>{t('cap.importRunnerNotice')}</Meta>
    </div>
  )
}

function NativeMcpGroup({ available }: { available: boolean }): ReactElement {
  const t = useT()
  const text = useCapsText()
  const session = useStore((s) => s.session)
  const send = useStore((s) => s.send)
  const ensureActivated = useStore((s) => s.ensureActivated)
  const nativeMcpStatus = useStore((s) => s.nativeMcpStatus)
  const busySession = useStore(
    (s) => !!s.session?.isAgentRunning || !!s.session?.isStreaming || !!s.session?.isCompacting
  )
  const [busy, setBusy] = useState(false)
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
    }
  }

  return (
    <Group title={t('cap.nativeMcpTitle')} desc={t('cap.nativeMcpDesc')}>
      <Note>{text('mcpNativeNote')}</Note>
      <NativeMcpList
        actionable={available && !busy && !busySession && !!session?.sessionId && !nativeMcpStatus?.pending}
        onAction={available ? runAction : undefined}
      />
      {available ? (
        <>
          <IndividualAction>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy || busySession || !session?.sessionId}
              onPress={() => void query()}
              data-testid="caps-native-mcp"
            >
              {t('cap.nativeMcpOpen')}
            </Button>
          </IndividualAction>
          {nativeMcpStatus && nativeMcpStatus.sessionId === session?.sessionId ? (
            <p className="caps-result" role="status" data-testid="caps-native-mcp-status">
              {nativeMcpStatus.text || (nativeMcpStatus.action ? t('cap.nativeMcpActionRunning') : t('cap.nativeMcpLoading'))}
            </p>
          ) : null}
        </>
      ) : (
        <Meta>{text('mcpNativeUnavailable')}</Meta>
      )}
      {error ? <Warn>{error}</Warn> : null}
    </Group>
  )
}

function IndividualAction({ children }: { children: ReactElement }): ReactElement {
  return <div className="caps-actions caps-actions--start">{children}</div>
}
