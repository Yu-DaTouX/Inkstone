import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { HubAgent, HubCommand, HubMode, HubSnapshot, HubTask } from '../../../../shared/agent-hub'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button, EmptyState, IconButton, Input, ListRow, Segmented, Select, Tab, Textarea } from '../ui'
import { installImeFallback, installTerminalRenderer, terminalAppearance, terminalFontReady } from '../terminal/terminal-appearance'
import { APPEARANCE_EVENT } from '../../lib/appearance'

const statusText: Record<HubTask['status'], MessageKey> = { queued: 'hub.status.queued', preparing: 'hubp.status.preparing', running: 'hub.status.running', waiting_input: 'hubp.status.waitingInput', needs_review: 'hub.status.needsReview', completed: 'hub.status.completed', failed: 'hub.status.failed', cancelled: 'hub.status.stopped', uncertain: 'hub.uncertain.title' }

export function AgentHubPanel({ onBack, initialTaskId }: { onBack: () => void; initialTaskId?: string }) {
  const tr = useT()
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null)
  const [error, setError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('')
  const [agent, setAgent] = useState<HubAgent>('codex')
  const [mode, setMode] = useState<HubMode>('terminal')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high' | ''>('')
  const [reviewOf, setReviewOf] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({})
  const requestId = useRef<string | null>(null)
  const [selected, setSelected] = useState(initialTaskId ?? '')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [packetTarget, setPacketTarget] = useState('')
  const [packetSummary, setPacketSummary] = useState('')
  const [packetRequest, setPacketRequest] = useState('')
  const [packetContext, setPacketContext] = useState('')
  const packetId = useRef<string | null>(null)
  const [view, setView] = useState<'list' | 'windows'>(initialTaskId ? 'list' : 'windows')
  const [creating, setCreating] = useState(false)
  const [panels, setPanels] = useState<string[]>([])
  const restoredWindows = useRef(false)
  const refresh = useCallback(async () => {
    const next = await window.yan.hub.snapshot()
    setSnapshot(next)
    setProjectId((current) => current || next.projects[0]?.id || '')
  }, [])
  useEffect(() => {
    let alive = true
    const read = async () => { try { if (alive) await refresh() } catch (failure) { if (alive) setError(String(failure)) } }
    void read(); const timer = setInterval(() => void read(), 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    if (!snapshot || restoredWindows.current) return
    restoredWindows.current = true
    setPanels(current => current.length ? current : snapshot.tasks.filter(task => task.mode === 'terminal' && task.terminalId && task.status === 'running').slice(0, 4).map(task => task.id))
  }, [snapshot])
  const act = async (command: HubCommand) => {
    setBusy(true); setError('')
    try { await window.yan.hub.command(command); await refresh() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const create = async () => {
    setBusy(true); setError('')
    const id = requestId.current ?? crypto.randomUUID(); requestId.current = id
    try {
      const result = await window.yan.hub.command({ action: 'create', request: { agent, mode, projectId, prompt, model: model || undefined, reasoningEffort: agent === 'codex' ? reasoningEffort || undefined : undefined, reviewOf: reviewOf || undefined, requestId: id } }) as { taskId: string }
      requestId.current = null; setPrompt(''); setSelected(result.taskId); setCreating(false)
      if (mode === 'terminal' && panels.length < 4) { setPanels(current => [...current, result.taskId]); setView('windows') }
      else setView('list')
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const sendPacket = async () => {
    setBusy(true); setError('')
    const id = packetId.current ?? crypto.randomUUID(); packetId.current = id
    try {
      await window.yan.hub.command({ action: 'send-packet', requestId: id, toTaskId: packetTarget, summary: packetSummary, request: packetRequest || undefined, context: packetContext || undefined })
      packetId.current = null; setPacketSummary(''); setPacketRequest(''); setPacketContext(''); await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const task = snapshot?.tasks.find((item) => item.id === selected)
  const availableModes = snapshot?.adapters.find((item) => item.agent === agent)?.modes ?? ['terminal']
  const visibleTasks = snapshot?.tasks.filter((t) => !attentionOnly || ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)) ?? []
  return <section className={`hub-panel ${view === 'windows' && !creating ? 'hub-terminal-workspace' : ''}`} data-testid="agent-hub">
    <div className="hub-heading"><IconButton size="sm" icon="back" label={tr('hubp.back')} onClick={onBack} /><strong>{tr('hubp.title')}</strong><Button size="sm" variant={creating ? 'secondary' : 'primary'} icon={creating ? 'close' : 'plus'} onClick={() => setCreating(!creating)} data-testid="hub-new-task">{creating ? tr('hub.collapse') : tr('hubp.new')}</Button></div>
    <Segmented size="sm" label={tr('hubp.view')} value={view} onChange={setView} options={[{ value: 'windows', label: `${tr('hubp.view.terminals')}${panels.length ? ` · ${panels.length}` : ''}` }, { value: 'list', label: tr('hubp.view.tasks') }]} />
    {error ? <p role="alert">{error}</p> : null}
    {creating ? <form className="hub-form" data-testid="hub-create-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <details className="hub-options"><summary>{tr('hubp.templates')}</summary><div className="hub-form">
      <label>{tr('hubp.userTemplate')}<Select value={templateId} onChange={(e) => {
        const id = e.target.value; setTemplateId(id); requestId.current = null
        const template = snapshot?.templates?.find((t) => t.id === id)
        if (!template) { setTemplateName(''); return }
        setTemplateName(template.name); setAgent(template.agent); setMode(template.mode); setPrompt(template.prompt); setModel(template.model || ''); setReasoningEffort(template.reasoningEffort || ''); setReviewOf('')
      }}><option value="">{tr('hubp.newTemplate')}</option>{snapshot?.templates?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
      <label>{tr('hubp.templateName')}<Input maxLength={80} value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder={tr('hubp.templateNamePlaceholder')} /></label>
      <div className="hub-row"><Button size="sm" disabled={busy || !templateName.trim() || !prompt.trim()} onClick={() => { const id = templateId || crypto.randomUUID(); setTemplateId(id); void act({ action: 'save-template', template: { id, name: templateName, agent, mode, prompt, model: model || undefined, reasoningEffort: reasoningEffort || undefined } }) }}>{tr('hubp.saveTemplate')}</Button>{templateId && snapshot?.templates?.some((t) => t.id === templateId) ? <Button size="sm" disabled={busy} onClick={() => { void act({ action: 'delete-template', id: templateId }); setTemplateId(''); setTemplateName('') }}>{tr('hubp.deleteTemplate')}</Button> : null}</div>
      </div></details>
      <label>{tr('hub.project')}<Select value={projectId} onChange={(e) => { setProjectId(e.target.value); requestId.current = null }}><option value="">{tr('hubp.chooseProject')}</option>{snapshot?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
      <label>Agent<Select value={agent} onChange={(e) => { const next = e.target.value as HubAgent; setAgent(next); const modes = snapshot?.adapters.find((a) => a.agent === next)?.modes; setMode(modes?.includes('terminal') ? 'terminal' : modes?.[0] ?? 'terminal'); requestId.current = null }}>{snapshot?.adapters.map((a) => <option key={a.agent} value={a.agent} disabled={!a.available}>{a.agent} · {a.available ? a.version || tr('hubp.native') : tr('hub.notInstalled')}</option>)}</Select></label>
      <label>{tr('hub.mode')}<Select value={mode} onChange={(e) => { setMode(e.target.value as HubMode); requestId.current = null }}>{availableModes.map((value) => <option key={value} value={value}>{value === 'managed' ? tr('hubp.managed') : tr('hub.mode.terminal')}</option>)}</Select></label>
      <details className="hub-options"><summary>{tr('hubp.modelReview')}</summary><div className="hub-form">
      <label>{tr('hubp.model')}<Input value={model} placeholder={tr('hubp.modelPlaceholder')} onChange={(e) => { setModel(e.target.value); requestId.current = null }} /></label>
      {agent === 'codex' && mode === 'managed' ? <label>{tr('hubp.effort')}<Select value={reasoningEffort} onChange={(e) => { setReasoningEffort(e.target.value as typeof reasoningEffort); requestId.current = null }}><option value="">{tr('hubp.effort.default')}</option><option value="low">{tr('hubp.effort.low')}</option><option value="medium">{tr('hubp.effort.medium')}</option><option value="high">{tr('hubp.effort.high')}</option></Select></label> : null}
      <label>{tr('hubp.reviewOf')}<Select value={reviewOf} onChange={(e) => { setReviewOf(e.target.value); requestId.current = null }}><option value="">{tr('hubp.reviewOf.new')}</option>{snapshot?.tasks.filter((t) => t.projectId === projectId && t.artifact && ['needs_review', 'completed'].includes(t.status)).map((t) => <option key={t.id} value={t.id}>{t.title} · {t.artifact!.sha256.slice(0, 8)}</option>)}</Select></label>
      </div></details>
      <label>{mode === 'terminal' ? tr('hubp.promptTerminal') : tr('hubp.promptTask')}<Textarea value={prompt} rows={3} maxLength={32000} placeholder={mode === 'terminal' ? tr('hubp.promptTerminalPlaceholder') : tr('hubp.promptTaskPlaceholder')} onChange={(e) => { setPrompt(e.target.value); requestId.current = null }} /></label>
      <details className="hub-options"><summary>{tr('hubp.boundary')}</summary><p>{mode === 'managed' ? tr('hubp.boundary.managed') : tr('hubp.boundary.terminal')}</p></details>
      <Button variant="primary" type="submit" disabled={busy || !projectId || (mode !== 'terminal' && !prompt.trim())}>{mode === 'terminal' ? tr('hub.openTerminal') : tr('hubp.startTask')}</Button>
    </form> : null}
    {snapshot?.resources.filter((r) => r.owner || r.waiting || r.uncertain || r.paused).map((r) => <div key={r.resourceId}><p>{r.resourceId} · {r.uncertain ? tr('hubp.res.uncertain') : r.paused ? tr('hubp.res.paused') : tr('hubp.res.inUse', { owner: r.owner ?? '' })} · {tr('hubp.res.waiting', { n: r.waiting })}</p>{r.uncertain ? <Button disabled={busy} onClick={() => { if (window.confirm(tr('hubp.res.recoverConfirm'))) void act({ action: 'recover-resource', resourceId: r.resourceId, epoch: r.epoch }) }}>{tr('hubp.res.recover')}</Button> : null}</div>)}
    {view === 'windows' ? <AgentWindows snapshot={snapshot} panels={panels} setPanels={setPanels} onRefresh={refresh} onError={setError} /> : <>
    <div className="hub-row"><Segmented size="sm" label={tr('hubp.filter')} value={attentionOnly ? 'attention' : 'all'} onChange={(value) => setAttentionOnly(value === 'attention')} options={[{ value: 'all', label: tr('hubp.filter.all') }, { value: 'attention', label: `${tr('hubp.filter.attention')} · ${snapshot?.tasks.filter((t) => ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).length ?? 0}` }]} /></div>
    <div className="hub-task-list">{visibleTasks.map((t) => <ListRow key={t.id} className="hub-task" current={t.id === selected} onClick={() => setSelected(t.id)}><span className="hub-task-title">{t.title}</span><span className="hub-task-meta"><span>{t.agent}</span><Badge tone={t.status === 'failed' ? 'err' : ['waiting_input', 'needs_review', 'uncertain'].includes(t.status) ? 'warn' : 'neutral'}>{tr(statusText[t.status])}</Badge></span></ListRow>)}</div>
    {!visibleTasks.length ? <EmptyState icon="agent" title={snapshot ? attentionOnly ? tr('hubp.empty.attention') : tr('hubp.empty.tasks') : tr('hubp.loading')} /> : null}
    {task ? <div className="hub-detail">
      <strong>{task.title} · {tr(statusText[task.status])}</strong>
      <p>{task.agent} · {task.mode === 'managed' ? tr('hubp.managed') : tr('hub.mode.terminal')} · {tr('hubp.baseline', { sha: task.baseline?.slice(0, 8) || tr('hub.status.preparing') })}{task.artifact ? ` · ${tr('hubp.artifact', { sha: task.artifact.sha256.slice(0, 8) })}` : ''}</p>
      {task.workspace ? <p className="hub-path">{task.workspace}</p> : null}
      {task.parentTaskId ? <p>{tr('hubp.parent')}<Button size="sm" onClick={() => setSelected(task.parentTaskId!)}>{snapshot?.tasks.find((t) => t.id === task.parentTaskId)?.title || task.parentTaskId}</Button></p> : null}
      {snapshot?.tasks.filter((t) => t.parentTaskId === task.id).map((child) => <Button key={child.id} size="sm" onClick={() => setSelected(child.id)}>{tr('hubp.child', { title: child.title, status: tr(statusText[child.status]) })}</Button>)}
      {task.error ? <p role="alert">{task.error}</p> : null}
      <div className="hub-row">
        {['queued', 'preparing', 'running', 'waiting_input'].includes(task.status) ? <Button disabled={busy} onClick={() => void act({ action: 'cancel', taskId: task.id })}>{tr('hubp.stopTask')}</Button> : null}
        {task.status === 'needs_review' ? <Button disabled={busy} onClick={() => void act({ action: 'accept', taskId: task.id })}>{tr('hubp.accept')}</Button> : null}
        {['uncertain', 'failed', 'cancelled'].includes(task.status) ? <Button disabled={busy} onClick={() => { if (window.confirm(tr('hubp.resumeConfirm'))) void act({ action: 'resume', taskId: task.id }) }}>{tr('hubp.resume')}</Button> : null}
      </div>
      {snapshot?.approvals.filter((a) => a.taskId === task.id).map((approval) => <div key={approval.id} className="hub-approval"><strong>{approval.title}</strong><pre>{approval.detail}</pre>{approval.questions?.map((q) => <label key={q.id}>{q.question}{q.options?.length ? <p>{q.options.join(' / ')}</p> : null}<Input disabled={approval.status !== 'pending'} value={answers[approval.id]?.[q.id] ?? ''} onChange={(e) => setAnswers((old) => ({ ...old, [approval.id]: { ...old[approval.id], [q.id]: e.target.value } }))} /></label>)}<p>{approval.status === 'pending' ? tr('hubp.approval.pending', { time: new Date(approval.expiresAt).toLocaleTimeString() }) : approval.status === 'sent' ? tr('hubp.approval.sent') : approval.status === 'resolved' ? tr('hubp.approval.resolved') : tr('hubp.approval.stale')}</p>{approval.status === 'pending' ? <div className="hub-row"><Button disabled={busy} onClick={() => void act({ action: 'answer', approvalId: approval.id, answer: 'accept', answers: answers[approval.id] })}>{approval.kind === 'question' ? tr('hubp.approval.reply') : tr('hubp.approval.allow')}</Button><Button disabled={busy} onClick={() => void act({ action: 'answer', approvalId: approval.id, answer: 'decline' })}>{tr('hub.ask.decline')}</Button></div> : null}</div>)}
      {task.terminalId ? <HubTerminal task={task} onError={setError} onRefresh={refresh} /> : null}
      <div className="hub-messages">
        <strong>{tr('hubp.timeline')}</strong>
        {snapshot?.messages?.filter((m) => m.taskId === task.id).slice(-20).map((m) => <div key={m.id} className="hub-message">
          <p>{m.fromTaskId ? tr('hubp.from', { title: snapshot.tasks.find((t) => t.id === m.fromTaskId)?.title ?? m.fromTaskId }) : tr('hubp.user')} · {new Date(m.createdAt).toLocaleTimeString()} · {m.delivery === 'injected' ? tr('hubp.delivery.injected') : m.delivery === 'typed' ? tr('hub.delivery.typed') : m.delivery === 'queued' ? tr('hub.status.queued') : tr('hub.delivery.failed')}</p>
          <pre>{m.packet ? `${m.packet.summary}${m.packet.request ? `\n${tr('hubp.packet.requestLine', { text: m.packet.request })}` : ''}${m.packet.context ? `\n${tr('hubp.packet.contextLine', { text: m.packet.context })}` : ''}` : m.text}</pre>
        </div>)}
        <label>{tr('hubp.packet.to')}<Select value={packetTarget} onChange={(e) => setPacketTarget(e.target.value)}><option value="">{tr('hubp.packet.chooseRun')}</option>{snapshot?.tasks.filter((t) => t.id !== task.id && t.projectId === task.projectId && ['preparing', 'running', 'waiting_input'].includes(t.status) && (t.mode === 'terminal' || (snapshot?.adapters.find((a) => a.agent === t.agent)?.capabilities?.includes('handoff') ?? false))).map((t) => <option key={t.id} value={t.id}>{t.title} · {t.agent}{t.mode === 'terminal' ? ` · ${tr('hubp.terminal')}` : ''}</option>)}</Select></label>
        <label>{tr('hubp.packet.summary')}<Input value={packetSummary} maxLength={4000} onChange={(e) => setPacketSummary(e.target.value)} placeholder={tr('hubp.packet.summaryPlaceholder')} /></label>
        <label>{tr('hubp.packet.request')}<Input value={packetRequest} maxLength={8000} onChange={(e) => setPacketRequest(e.target.value)} placeholder={tr('hubp.packet.requestPlaceholder')} /></label>
        <label>{tr('hubp.packet.context')}<Input value={packetContext} maxLength={8000} onChange={(e) => setPacketContext(e.target.value)} placeholder={tr('hubp.packet.contextPlaceholder')} /></label>
        <Button disabled={busy || !packetTarget || !packetSummary.trim()} onClick={() => void sendPacket()}>{tr('hubp.packet.send')}</Button>
      </div>
      {task.report ? <pre className="hub-report">{task.report}</pre> : null}
      {snapshot?.runs?.some((r) => r.taskId === task.id) ? <div><strong>{tr('hubp.history')}</strong>{snapshot.runs.filter((r) => r.taskId === task.id).map((r) => <details key={r.id}><summary>{new Date(r.startedAt).toLocaleString()} · {tr(statusText[r.status])} · {r.model || r.agent}{r.artifact ? ` · ${r.artifact.sha256.slice(0, 8)}` : ''}</summary><p>{tr('hubp.run', { id: r.id })}{r.externalSessionId ? ` · ${tr('hubp.externalSession', { id: r.externalSessionId })}` : ''}</p>{r.error ? <p>{r.error}</p> : null}{r.report ? <pre className="hub-report">{r.report}</pre> : null}</details>)}</div> : null}
    </div> : null}
    </>}
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void window.yan.hub.detect().then(setSnapshot).catch((e) => setError(String(e)))}>{tr('hubp.detect')}</Button>
  </section>
}

function AgentWindows({ snapshot, panels, setPanels, onRefresh, onError }: { snapshot: HubSnapshot | null; panels: string[]; setPanels: (next: string[]) => void; onRefresh: () => Promise<void>; onError: (error: string) => void }) {
  const tr = useT()
  const [active, setActive] = useState('')
  const [split, setSplit] = useState(false)
  const previousPanels = useRef<string[]>([])
  useEffect(() => {
    const added = panels.find(id => !previousPanels.current.includes(id))
    if (added) setActive(added)
    previousPanels.current = panels
  }, [panels])
  const tasks = snapshot?.tasks ?? []
  const opened = panels.map((id) => tasks.find((t) => t.id === id)).filter(Boolean) as HubTask[]
  const activeId = opened.some(t => t.id === active) ? active : opened[0]?.id
  const candidates = tasks.filter((t) => t.mode === 'terminal' && !panels.includes(t.id)).slice(0, 50)
  return <div className="hub-windows">
    {opened.length ? <div className="hub-row"><div className="ui-tabs hub-terminal-tabs" role="tablist" aria-label={tr('hubp.terminals')}>{opened.map(task => <Tab key={task.id} icon="terminal" selected={task.id === activeId} title={task.title} onClick={() => setActive(task.id)} onClose={() => setPanels(panels.filter(id => id !== task.id))} closeLabel={tr('hubp.hideTerminal', { name: task.agent })}>{task.agent}</Tab>)}</div><Button size="sm" active={split} onClick={() => setSplit(!split)} data-testid="hub-split">{tr('hubp.split')}</Button></div> : null}
    <div className="hub-row">
      {candidates.length ? <Select aria-label={tr('hubp.openExisting')} value="" disabled={panels.length >= 4} onChange={(e) => { if (e.target.value && panels.length < 4) { setPanels([...panels, e.target.value]); setActive(e.target.value) } }}><option value="">{tr('hubp.openExisting')}</option>{candidates.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.agent} · {tr(statusText[t.status])}</option>)}</Select> : null}
    </div>
    {opened.length ? <div className={`hub-window-grid ${split ? '' : 'hub-window-single'}`}>{opened.filter(task => split || task.id === activeId).map((task) => <AgentWindow key={task.id} task={task} onClose={() => setPanels(panels.filter((id) => id !== task.id))} onError={onError} onRefresh={onRefresh} />)}</div> : <EmptyState icon="terminal" title={tr('hubp.noTerminals')}>{tr('hubp.noTerminalsBody')}</EmptyState>}
  </div>
}

function AgentWindow({ task, onClose, onError, onRefresh }: { task: HubTask; onClose: () => void; onError: (error: string) => void; onRefresh: () => Promise<void> }) {
  const tr = useT()
  return <div className="hub-window">
    <div className="hub-window-head">
      <span className="nm">{task.title}</span>
      <span className="sub">{task.agent} · {tr(statusText[task.status])}</span>
      <span className="grow" />
      {['queued', 'preparing', 'running', 'waiting_input'].includes(task.status) ? <Button size="sm" icon="stop" onClick={() => void window.yan.hub.command({ action: 'cancel', taskId: task.id }).then(onRefresh).catch(error => onError(String(error)))}>{tr('hubp.stop')}</Button> : null}
      <IconButton size="sm" icon="close" label={tr('hubp.hideWindow')} onClick={onClose} />
    </div>
    {task.terminalId ? <HubTerminal task={task} onError={onError} onRefresh={onRefresh} /> : task.mode === 'terminal' ? <EmptyState title={task.error || (['queued', 'preparing'].includes(task.status) ? tr('hubp.preparingTerminal') : tr('hubp.terminalDisconnected'))} /> : <div className="hub-window-note">
      {task.activity?.length ? task.activity.slice(-80).map((item) => item.kind === 'say'
        ? <p key={item.id} className="hub-act-say">{item.text}</p>
        : <details key={item.id} className="hub-act-tool"><summary>{(item.kind === 'patch' ? '✎ ' : '❯ ') + (item.title ?? '') + (item.status === 'done' ? ' ✓' : item.status === 'failed' ? ' ✗' : ' …')}</summary><pre>{item.text}{item.detail ? `\n${item.detail}` : ''}</pre></details>)
        : <p>{tr('hubp.managedNoScreen')}</p>}
    </div>}
  </div>
}

export function HubTerminal({ task, onError, onRefresh }: { task: HubTask; onError: (error: string) => void; onRefresh: () => Promise<void> }) {
  const tr = useT()
  const element = useRef<HTMLDivElement>(null)
  const current = useRef(task); current.current = task
  /* 宿主重启或终端被关闭后，宿主已没有这个终端的画面：明说，而不是留一块空白。 */
  const [gone, setGone] = useState(false)
  const [saved, setSaved] = useState('')
  /* 终端没了：取砚上次保存的屏幕文本，只读展示。 */
  useEffect(() => {
    if (!gone) return
    let alive = true
    void window.yan.hub.command({ action: 'last-screen', taskId: task.id }).then((r) => { if (alive) setSaved((r as { text?: string }).text ?? '') }).catch(() => undefined)
    return () => { alive = false }
  }, [gone, task.id])
  useEffect(() => {
    if (!element.current || !task.terminalId) return
    let disposed = false
    let release = () => {}
    const appearance = terminalAppearance()
    void terminalFontReady(appearance).then(() => {
      if (disposed || !element.current) return
      const term = new Terminal({ ...appearance, scrollback: 3000 })
      const fit = new FitAddon(); term.loadAddon(fit); term.open(element.current)
      installTerminalRenderer(term, element.current)
      const imeOff = installImeFallback(term)
      let alive = true; let seq: number | undefined; let reading = false; let quietSince = Date.now()
      const read = async () => {
        if (!alive || reading) return
        reading = true
        try {
          const result = await window.yan.hub.command({ action: 'inspect', taskId: task.id, sinceSeq: seq }) as { terminal: { kind: string; data: string; seq: number; cols: number; rows: number } | null }
          if (!alive) return
          setGone(!result.terminal)
          if (!result.terminal) return
          const update = result.terminal
          if (update.kind === 'snapshot') term.reset()
          if (term.cols !== update.cols || term.rows !== update.rows) term.resize(update.cols, update.rows)
          if (update.data) { quietSince = Date.now(); await new Promise<void>((done) => term.write(update.data, done)) }
          seq = update.seq
        } catch (error) { if (alive) onError(String(error)) }
        finally { reading = false }
      }
      /* 有输出时 150ms 跟随；安静后逐步放慢，隐藏窗口时更慢，避免空闲终端持续占用主进程。 */
      let timer: ReturnType<typeof setTimeout> | undefined
      const schedule = (ms: number) => { clearTimeout(timer); if (alive) timer = setTimeout(() => void loop(), ms) }
      const loop = async () => {
        await read()
        const quiet = Date.now() - quietSince
        schedule(document.hidden ? 1000 : quiet < 3000 ? 150 : quiet < 20000 ? 400 : 1000)
      }
      void loop()
      let pending = Promise.resolve()
      const send = (command: HubCommand) => { pending = pending.then(async () => { if (alive) await window.yan.hub.command(command) }).catch((error) => onError(String(error))) }
      /* 输入（含滚轮产生的鼠标序列）合并后再发：逐条串行往返会让滚动排起长队。 */
      let inputBuf = ''
      let inputTimer: ReturnType<typeof setTimeout> | undefined
      const flushInput = () => {
        inputTimer = undefined
        const data = inputBuf; inputBuf = ''
        const t = current.current
        if (data && t.inputOwner === 'desktop') send({ action: 'input', taskId: t.id, epoch: t.inputEpoch ?? 0, data })
      }
      const queueInput = (data: string) => {
        quietSince = Date.now(); schedule(30)
        inputBuf += data
        if (inputBuf.length > 8000) { clearTimeout(inputTimer); flushInput() } else if (!inputTimer) inputTimer = setTimeout(flushInput, 8)
      }
      const sub = term.onData(queueInput)
      /* 全屏应用（备用屏幕）没有开启鼠标上报时，滚轮改成上下方向键，和常见终端一致。 */
      term.attachCustomWheelEventHandler((e) => {
        if (term.buffer.active.type !== 'alternate' || term.modes.mouseTrackingMode !== 'none') return true
        const lines = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40)))
        queueInput((e.deltaY < 0 ? '\u001b[A' : '\u001b[B').repeat(lines))
        return false
      })
      const observer = new ResizeObserver(() => { if (!element.current || element.current.clientWidth < 16 || element.current.clientHeight < 16) return; fit.fit(); const t = current.current; if (t.inputOwner === 'desktop') send({ action: 'resize', taskId: t.id, epoch: t.inputEpoch ?? 0, cols: term.cols, rows: term.rows }) })
      observer.observe(element.current)
      /* 只跟主题切换与外观事件：观察根元素 style 会在拖动列宽等每一帧都重读计算样式 */
      const syncAppearance = () => {
        const next = terminalAppearance()
        term.options.theme = next.theme
        if (next.fontFamily && next.fontFamily !== term.options.fontFamily) {
          void terminalFontReady(next).then(() => { if (alive) { term.options.fontFamily = next.fontFamily; fit.fit() } })
        }
      }
      const theme = new MutationObserver(syncAppearance)
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
      window.addEventListener(APPEARANCE_EVENT, syncAppearance)
      release = () => { alive = false; imeOff(); clearTimeout(timer); clearTimeout(inputTimer); sub.dispose(); observer.disconnect(); theme.disconnect(); window.removeEventListener(APPEARANCE_EVENT, syncAppearance); term.dispose() }
    })
    return () => { disposed = true; release() }
  }, [task.terminalId, onError])
  return <>{task.inputOwner !== 'desktop' ? <div className="hub-row"><span>{task.inputOwner?.startsWith('phone:') ? tr('hubp.phoneTyping') : tr('hubp.readonlyTerminal')}</span>{task.status === 'running' ? <Button onClick={() => void window.yan.hub.command({ action: 'claim-input', taskId: task.id, epoch: task.inputEpoch ?? 0 }).then(onRefresh).catch((error) => onError(String(error)))}>{tr('hubp.claim')}</Button> : null}</div> : null}{gone ? <p className="agent-terminal-gone" role="status">{tr('hubp.gone')}{saved ? tr('hubp.goneSaved') : ''}</p> : null}{gone && saved ? <pre className="agent-last-screen" data-testid="agent-last-screen">{saved}</pre> : null}<div ref={element} className="hub-terminal" /></>
}
