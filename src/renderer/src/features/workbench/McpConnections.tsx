import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { MCP_SETTINGS_CHANGED, mcpViewKey, notifyMcpSettingsChanged, reloadCurrentMcp } from '../../state/mcp-settings'
import { Button, Notice, RailRow, RailValue, Switch, type StatusDotKind } from '../../ui'
import type { McpSettingsService, McpSettingsSnapshot } from '../../../../shared/mcp-settings'
import type { CapabilitySettingsSnapshot } from '../../../../shared/ipc'
import type { WorkspaceOwner } from './types'

export function useMcpConnections(owner: WorkspaceOwner | null, running: boolean) {
  const { lang } = useI18n()
  const t = useT()
  const en = lang === 'en-US'
  const sessionKey = useStore((s) => JSON.stringify([s.activeRunnerId, s.session?.sessionId, s.peekedSessionId, s.peekedPath]))
  const sessionBusy = useStore((s) => !!s.session?.isAgentRunning || !!s.session?.isStreaming || !!s.session?.isCompacting || !!s.session?.pendingMessageCount || s.conn !== 'ready')
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | null>(null)
  const [runtime, setRuntime] = useState<CapabilitySettingsSnapshot | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const requestId = useRef(0)
  const current = (): boolean => {
    const state = useStore.getState()
    return !!owner?.active && !!owner.sessionId && owner.sessionId === state.session?.sessionId && !state.peekedSessionId && !state.peekedPath
  }
  const active = current()
  const refresh = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    const view = mcpViewKey()
    const [services, status] = await Promise.allSettled([window.yan.capabilities.mcpServices(), window.yan.capabilities.snapshot()])
    if (id !== requestId.current || view !== mcpViewKey()) return
    if (services.status === 'fulfilled') { setSnapshot(services.value); setError('') }
    else setError(services.reason instanceof Error ? services.reason.message : String(services.reason))
    setRuntime(status.status === 'fulfilled' ? status.value : null)
  }, [])
  useEffect(() => {
    setSnapshot(null)
    setRuntime(null)
    setNotice('')
    setError('')
    setPending(false)
    if (active) void refresh()
    return () => { requestId.current++ }
  }, [sessionKey, owner?.key, active, refresh])
  useEffect(() => {
    if (active) void refresh()
  }, [active, running, sessionBusy, refresh])
  useEffect(() => {
    const changed = (): void => { if (active) void refresh() }
    window.addEventListener(MCP_SETTINGS_CHANGED, changed)
    return () => window.removeEventListener(MCP_SETTINGS_CHANGED, changed)
  }, [active, refresh])
  const services = (snapshot?.project ? snapshot.projectServices : snapshot?.global ?? []).filter((service) => !service.special)
  const scopeLabel = snapshot?.project ? (en ? `This project: ${snapshot.project.name}` : `本项目：${snapshot.project.name}`) : en ? 'Global defaults' : '全局默认'
  const busyText = en ? 'Wait until this conversation is idle.' : '当前会话运行中，空闲后可切换。'
  const apply = async (): Promise<void> => {
    if (!current() || !owner?.sessionId || !snapshot) return
    const view = mcpViewKey()
    setPending(true)
    setError('')
    try {
      await reloadCurrentMcp(owner.sessionId, snapshot.context)
      if (view !== mcpViewKey()) return
      setNotice(en ? 'Tools reloaded. Chat history preserved.' : '工具已重新加载，聊天记录保留。')
      await refresh()
    } catch (cause) { if (view === mcpViewKey()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (view === mcpViewKey()) setPending(false) }
  }
  const toggle = async (service: McpSettingsService, enabled: boolean): Promise<void> => {
    if (!snapshot || !current() || !owner?.sessionId) return
    const view = mcpViewKey()
    setPending(true)
    setError('')
    setNotice('')
    let saved = false
    let problem = ''
    try {
      const result = await window.yan.capabilities.changeMcpService({ context: snapshot.context, revision: snapshot.revision, scope: snapshot.project ? 'project' : 'global', action: enabled ? 'enable' : 'disable', key: service.key })
      if (!result.ok) throw new Error(result.error)
      saved = true
      notifyMcpSettingsChanged()
      if (view !== mcpViewKey() || !current()) return
      await reloadCurrentMcp(owner.sessionId, snapshot.context)
      if (view !== mcpViewKey()) return
      setNotice(en ? 'Saved and applied to this conversation.' : '已保存并应用到当前会话。')
    } catch (cause) {
      problem = `${saved ? en ? 'Saved, but not applied: ' : '已保存，当前会话应用失败：' : ''}${cause instanceof Error ? cause.message : String(cause)}`
    } finally {
      if (view === mcpViewKey()) { await refresh(); if (view === mcpViewKey()) { if (problem) setError(problem); setPending(false) } }
    }
  }
  const enabled = services.filter((service) => service.enabled).length
  const summary = services.length ? <RailValue value={en ? `${enabled} / ${services.length} enabled` : `${enabled} / ${services.length} 已启用`} /> : error ? <RailValue value={en ? 'Read failed' : '读取失败'} error /> : undefined
  const body = <>
    {!active ? <p className="wb-ov-note">{en ? 'Open this conversation to manage MCP.' : '进入此会话后可管理 MCP。'}</p> : <>
      <p className="wb-ov-note" data-testid="rail-mcp-scope">{scopeLabel}</p>
      {sessionBusy ? <Notice variant="hint" tone="ask">{busyText}</Notice> : null}
      {error ? <Notice tone="fail" compact>{error}</Notice> : null}
      {notice ? <Notice variant="hint" tone="ok">{notice}</Notice> : null}
      {snapshot?.errors.map((problem) => <Notice key={problem} tone="fail" compact>{problem}</Notice>)}
      <ul className="wb-ov-items" data-testid="rail-mcp-services">
        {services.map((service) => {
          const actual = runtime?.servers.find((item) => item.id === service.name && !item.migratedToNative)
          const loaded = snapshot?.nativeConfigChanged === false
          const untrusted = service.scope === 'project' && !snapshot?.projectTrusted
          const status = untrusted ? en ? 'Not trusted' : '项目未信任' : !service.enabled ? en ? 'Disabled' : '已关闭' : service.backend === 'native' ? loaded ? en ? 'Config loaded' : '配置已加载' : en ? 'Needs reload' : '待应用' : actual ? t(`cap.status.${actual.status}` as 'cap.status.ready') : en ? 'Not connected' : '未连接'
          const dot: StatusDotKind = !service.enabled ? 'idle' : service.backend === 'native' ? 'idle' : actual?.status === 'ready' ? 'ok' : actual?.status === 'error' ? 'fail' : actual?.status === 'connecting' ? 'running' : actual?.status === 'needs-auth' ? 'awaiting' : 'idle'
          const disabled = pending || sessionBusy || !!service.conflict || !!snapshot?.project && !snapshot.projectTrusted || service.backend === 'host' && !!snapshot?.busy || service.backend === 'native' && !runtime?.nativeMcpAvailable
          return <RailRow key={service.key} label={service.title} title={`${service.title} · ${scopeLabel} · ${status}`} dot={dot} value={status} action={<Switch aria-label={`${service.title} · ${scopeLabel}`} isSelected={service.enabled} isDisabled={disabled} onChange={(value) => void toggle(service, value)} data-testid="rail-mcp-toggle" />} />
        })}
      </ul>
      {snapshot?.nativeConfigChanged !== false && services.some((service) => service.backend === 'native') ? <Button size="sm" isDisabled={pending || sessionBusy || !runtime?.nativeMcpAvailable} onPress={() => void apply()}>{en ? 'Apply to this conversation' : '应用到当前会话'}</Button> : null}
      <Button variant="ghost" size="sm" onPress={() => useStore.getState().openSettings('mcp')}>{en ? 'Manage MCP services' : '管理 MCP 服务'}</Button>
    </>}
  </>
  return { visible: !!owner && (!active || !!error || services.length > 0), summary, body }
}
