import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n, useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { MCP_SETTINGS_CHANGED, notifyMcpSettingsChanged, reloadCurrentMcp } from '../../../state/mcp-settings'
import { Badge, Button, SegmentedControl, Switch } from '../../../ui'
import type { CapabilitySettingsSnapshot } from '../../../../../shared/ipc'
import type { McpSettingsMutation, McpSettingsScope, McpSettingsService, McpSettingsSnapshot } from '../../../../../shared/mcp-settings'
import { useConfirm } from './confirm'
import { Entry, Group, ListSkeleton, Meta, Panel, Warn } from './parts'
import { McpServiceForm } from './McpServiceForm'
import { mcpServicesText } from './mcp-services-text'
import { useCodegraphStatus } from './CodegraphStatusRow'

function viewKey(): string {
  const state = useStore.getState()
  return JSON.stringify([state.activeRunnerId, state.session?.sessionId, state.session?.cwd, state.peekedSessionId, state.peekedPath])
}

export function McpServices({ advanced }: { advanced: ReactNode }) {
  const { lang } = useI18n()
  const t = useT()
  const text = mcpServicesText(lang)
  const confirm = useConfirm()
  const sessionKey = useStore((s) => JSON.stringify([s.activeRunnerId, s.session?.sessionId, s.session?.cwd, s.peekedSessionId, s.peekedPath]))
  const nativeStatus = useStore((s) => s.nativeMcpStatus)
  const runtimeBusy = useStore((s) => s.runners.some((runner) => runner.running) || !!s.session?.isAgentRunning || !!s.session?.isStreaming || !!s.session?.isCompacting)
  const previousBusy = useRef(runtimeBusy)
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | null>(null)
  const [runtime, setRuntime] = useState<CapabilitySettingsSnapshot | null>(null)
  const [scope, setScope] = useState<McpSettingsScope>('global')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const requestId = useRef(0)
  const statusTimer = useRef<number | undefined>(undefined)
  const ownedStatus = useRef<unknown>(null)
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++requestId.current
    const view = viewKey()
    setLoading(true)
    const [services, diagnostics] = await Promise.allSettled([window.yan.capabilities.mcpServices(), window.yan.capabilities.snapshot()])
    if (request !== requestId.current || view !== viewKey()) return
    if (services.status === 'fulfilled') {
      setSnapshot(services.value)
      if (!services.value.project) setScope('global')
      setError('')
    } else setError(services.reason instanceof Error ? services.reason.message : String(services.reason))
    setRuntime(diagnostics.status === 'fulfilled' ? diagnostics.value : null)
    setLoading(false)
  }, [])
  useEffect(() => {
    setSnapshot(null)
    setRuntime(null)
    setAdding(false)
    setNotice('')
    setBusy(false)
    void refresh()
    return () => {
      requestId.current++
      window.clearTimeout(statusTimer.current)
      if (useStore.getState().nativeMcpStatus === ownedStatus.current) useStore.setState({ nativeMcpStatus: null })
    }
  }, [sessionKey, refresh])
  useEffect(() => {
    if (previousBusy.current === runtimeBusy) return
    previousBusy.current = runtimeBusy
    void refresh()
  }, [runtimeBusy, refresh])
  useEffect(() => {
    const changed = (): void => { void refresh() }
    window.addEventListener(MCP_SETTINGS_CHANGED, changed)
    return () => window.removeEventListener(MCP_SETTINGS_CHANGED, changed)
  }, [refresh])

  const change = async (input: McpSettingsMutation): Promise<void> => {
    const view = viewKey()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await window.yan.capabilities.changeMcpService(input)
      if (view !== viewKey()) return
      if (!result.ok) setError(result.error || text.failed)
      else {
        setNotice(result.takesEffect === 'next-call' ? text.nextCall : text.nextSession)
        notifyMcpSettingsChanged()
        if (input.action === 'add') setAdding(false)
        await refresh()
      }
    } catch (cause) { if (view === viewKey()) setError(cause instanceof Error ? cause.message : text.failed) }
    finally { if (view === viewKey()) setBusy(false) }
  }
  const apply = async (): Promise<void> => {
    const sessionId = useStore.getState().session?.sessionId
    if (!sessionId || !snapshot) return
    const view = viewKey()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await reloadCurrentMcp(sessionId, snapshot.context)
      if (view === viewKey()) { setNotice(text.applied); await refresh() }
    } catch (cause) { if (view === viewKey()) setError(cause instanceof Error ? cause.message : text.failed) }
    finally { if (view === viewKey()) setBusy(false) }
  }
  const mutate = async (service: McpSettingsService, action: 'enable' | 'disable' | 'inherit' | 'remove' | 'move', target = scope): Promise<void> => {
    if (!snapshot) return
    if (action === 'remove' || action === 'move') {
      const accepted = await confirm({ title: action === 'remove' ? text.confirmRemove : text.confirmMove,
        body: action === 'remove' ? (scope === 'global' ? text.removeGlobal : text.removeProject) : (target === 'global' ? text.toGlobal : text.toProject),
        confirmLabel: action === 'remove' ? text.remove : text.move, tone: action === 'remove' ? 'danger' : 'default' })
      if (!accepted) return
    }
    await change({ context: snapshot.context, revision: snapshot.revision, scope: target, key: service.key, action })
  }
  const check = async (service: McpSettingsService): Promise<void> => {
    const view = viewKey()
    setBusy(true)
    setNotice('')
    setError('')
    try {
      if (service.backend === 'native') {
        const state = useStore.getState()
        if (!state.session?.sessionId || state.session.isAgentRunning || state.session.isStreaming || state.session.isCompacting || !runtime?.nativeMcpAvailable) throw new Error(text.busy)
        const request = { sessionId: state.session.sessionId, pending: true, text: '' }
        ownedStatus.current = request
        useStore.setState({ nativeMcpStatus: request })
        window.clearTimeout(statusTimer.current)
        statusTimer.current = window.setTimeout(() => {
          if (useStore.getState().nativeMcpStatus === request) useStore.setState({ nativeMcpStatus: { ...request, pending: false, text: t('cap.nativeMcpTimeout') } })
        }, 30_000)
        if (!(await state.send('/mcp')) && useStore.getState().nativeMcpStatus === request) {
          useStore.setState({ nativeMcpStatus: null })
          throw new Error(text.failed)
        }
      } else {
        const start = await window.yan.capabilities.verify(service.name)
        if (!start.ok || !start.operationId) throw new Error(start.error || text.failed)
        for (let attempt = 0; attempt < 70 && view === viewKey(); attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 350))
          const result = await window.yan.capabilities.verification(start.operationId)
          if (result && result.state !== 'connecting') {
            if (view !== viewKey()) return
            setNotice(t(`cap.operation.${result.state}` as 'cap.operation.ready'))
            await refresh()
            return
          }
        }
        if (view === viewKey()) throw new Error(t('cap.nativeMcpTimeout'))
      }
    } catch (cause) { if (view === viewKey()) setError(cause instanceof Error ? cause.message : text.failed) }
    finally { if (view === viewKey()) setBusy(false) }
  }
  const services = snapshot ? scope === 'global' ? snapshot.global : snapshot.projectServices : []
  return <Panel label={text.title}>
    <Group title={text.title} desc={text.description} settingId="caps-mcp-servers" actions={<>
      <Button isDisabled={!snapshot || busy || loading} onPress={() => setAdding((value) => !value)} data-testid="mcp-add">{text.add}</Button>
      <Button isPending={loading} isDisabled={busy} onPress={() => void refresh()} data-testid="caps-mcp-reload">{text.refresh}</Button>
      <Button isDisabled={busy || loading || runtimeBusy || !runtime?.nativeMcpAvailable || !useStore.getState().session?.sessionId || !!useStore.getState().peekedPath || !!useStore.getState().peekedSessionId} onPress={() => void apply()} data-testid="mcp-apply">{text.apply}</Button>
    </>}>
      <SegmentedControl label={text.scopeLabel} value={scope} onChange={(value) => { setScope(value); setAdding(false); setNotice('') }} isDisabled={busy || loading} options={[
        { value: 'global', label: text.global, testId: 'mcp-scope-global' },
        ...(snapshot?.project ? [{ value: 'project' as const, label: `${text.project}：${snapshot.project.name}`, testId: 'mcp-scope-project' }] : [])
      ]} />
      <Meta>{scope === 'global' ? text.globalHint : text.projectHint}</Meta>
      {!snapshot?.project && !loading ? <Meta>{text.noProject}</Meta> : null}
      {scope === 'project' && snapshot && !snapshot.projectTrusted ? <Warn>{text.untrusted}</Warn> : null}
      {error ? <Warn>{error}</Warn> : null}
      {notice ? <Meta>{notice}</Meta> : null}
      {snapshot?.errors.map((problem) => <Warn key={problem}>{problem}</Warn>)}
      {adding && snapshot ? <McpServiceForm snapshot={snapshot} initialScope={scope} onSave={change} onCancel={() => setAdding(false)} busy={busy} /> : null}
      {loading && !snapshot ? <ListSkeleton rows={3} /> : <div className="caps-list" data-testid="mcp-services">
        {services.map((service) => <McpServiceRow key={`${scope}:${service.key}`} service={service} snapshot={snapshot!} scope={scope} runtime={runtime} busy={busy || loading} onMutate={mutate} onCheck={check} />)}
      </div>}
      {snapshot && !services.length ? <Meta>{text.noServices}</Meta> : null}
      <Meta>{text.loaded}</Meta>
      {nativeStatus && nativeStatus.sessionId === useStore.getState().session?.sessionId ? <div className="mcp-session-result" role="status"><Meta>{text.checkResult}</Meta><Meta>{nativeStatus.pending ? text.checking : nativeStatus.text}</Meta></div> : null}
    </Group>
    <div>
      <Button variant="ghost" aria-expanded={showAdvanced} onPress={() => setShowAdvanced((value) => !value)} data-testid="mcp-advanced">{text.advanced}</Button>
      {showAdvanced ? <div className="caps-stack">{advanced}</div> : null}
    </div>
  </Panel>
}

function McpServiceRow({ service, snapshot, scope, runtime, busy, onMutate, onCheck }: {
  service: McpSettingsService; snapshot: McpSettingsSnapshot; scope: McpSettingsScope; runtime: CapabilitySettingsSnapshot | null; busy: boolean
  onMutate(service: McpSettingsService, action: 'enable' | 'disable' | 'inherit' | 'remove' | 'move', target?: McpSettingsScope): Promise<void>
  onCheck(service: McpSettingsService): Promise<void>
}) {
  const { lang } = useI18n()
  const t = useT()
  const text = mcpServicesText(lang)
  const [details, setDetails] = useState(false)
  const sessionBusy = useStore((s) => !!s.session?.isAgentRunning || !!s.session?.isStreaming || !!s.session?.isCompacting)
  const pendingStatus = useStore((s) => !!s.nativeMcpStatus?.pending)
  const actual = runtime?.servers.find((item) => item.id === service.name && !item.migratedToNative)
  const status = service.backend === 'native'
    ? service.scope === 'project' && !snapshot.projectTrusted ? text.untrusted : snapshot.nativeConfigChanged === true ? text.configChanged : snapshot.nativeConfigChanged === false ? text.configRead : text.configUnknown
    : actual ? t(`cap.status.${actual.status}` as 'cap.status.ready') : text.configUnknown
  const locked = busy || !!service.conflict || scope === 'project' && !snapshot.projectTrusted || service.backend === 'host' && snapshot.busy
  const checkDisabled = busy || !!service.conflict || !service.enabled || sessionBusy || (service.scope === 'project' && !snapshot.projectTrusted) || (service.backend === 'native' && (!runtime?.nativeMcpAvailable || pendingStatus))
  return <Entry testId="mcp-service" name={service.special ? text.computer : service.title} badge={<Badge>{service.scope === 'project' ? text.projectOnly : service.inherited ? text.inherited : text.allSessions}</Badge>}
    control={service.special ? undefined : <Switch aria-label={`${service.title} · ${scope === 'global' ? text.allSessions : text.projectOnly}`} isSelected={service.enabled} isDisabled={locked} onChange={(value) => void onMutate(service, value ? 'enable' : 'disable')} data-testid="mcp-service-toggle" />}
    meta={[service.enabled ? text.enabled : text.disabled, service.overridden ? service.enabled ? text.projectOn : text.projectOff : null]}
    actions={service.special ? <Button onPress={() => useStore.getState().openSettings('tools')}>{text.openTools}</Button> : <>
      <Button isDisabled={checkDisabled} onPress={() => void onCheck(service)}>{service.backend === 'native' ? text.checkSession : text.check}</Button>
      {scope === 'project' && service.inherited && service.overridden ? <Button isDisabled={locked} onPress={() => void onMutate(service, 'inherit')}>{text.inherit}</Button> : null}
      <Button variant="ghost" aria-expanded={details} onPress={() => setDetails((value) => !value)}>{text.details}</Button>
    </>}>
    <Meta>{service.special ? text.computerHint : service.conflict ? text.conflict : status}</Meta>
    {service.backend === 'host' && snapshot.busy && !service.special ? <Meta>{text.busy}</Meta> : null}
    {service.name === 'codegraph' ? <CodegraphDetails revision={snapshot.revision} /> : null}
    {details ? <div className="caps-stack mcp-service-details">
      <Meta>{service.owner === 'pi' ? text.piNote : text.hostNote}</Meta>
      <Meta>{text.source}：{service.source}</Meta>
      <Meta>{text.connection}：{service.connection || service.transport}</Meta>
      <div className="caps-actions">
        {snapshot.project && snapshot.projectTrusted ? <Button isDisabled={locked} onPress={() => void onMutate(service, 'move', service.scope === 'global' ? 'project' : 'global')}>{service.scope === 'global' ? text.moveProject : text.moveGlobal}</Button> : null}
        {!service.inherited ? <Button variant="danger" isDisabled={locked} onPress={() => void onMutate(service, 'remove')}>{text.remove}</Button> : null}
      </div>
    </div> : null}
  </Entry>
}

function CodegraphDetails({ revision }: { revision: string }) {
  const status = useCodegraphStatus(revision)
  return <>{status?.meta.slice(1).map((value) => <Meta key={value}>{value}</Meta>)}{status?.action}{status?.result}</>
}
