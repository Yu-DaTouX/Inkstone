import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { HubAgent, HubCommand, HubMode, HubSnapshot, HubTask } from '../../../../shared/agent-hub'
import { Button, Input, Select, Textarea } from '../ui'

const statusText: Record<HubTask['status'], string> = { queued: '排队中', preparing: '准备工作区', running: '运行中', waiting_input: '等你答复', needs_review: '待审阅', completed: '已验收', failed: '失败', cancelled: '已停止', uncertain: '结果待核实' }

export function AgentHubPanel({ onBack }: { onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null)
  const [error, setError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('')
  const [agent, setAgent] = useState<HubAgent>('codex')
  const [mode, setMode] = useState<HubMode>('managed')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high' | ''>('')
  const [reviewOf, setReviewOf] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({})
  const requestId = useRef<string | null>(null)
  const [selected, setSelected] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [packetTarget, setPacketTarget] = useState('')
  const [packetSummary, setPacketSummary] = useState('')
  const [packetRequest, setPacketRequest] = useState('')
  const [packetContext, setPacketContext] = useState('')
  const packetId = useRef<string | null>(null)
  const [view, setView] = useState<'list' | 'windows'>('list')
  const [panels, setPanels] = useState<string[]>([])
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
      requestId.current = null; setPrompt(''); setSelected(result.taskId); await refresh()
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
  return <section className="hub-panel" data-testid="agent-hub">
    <div className="hub-row"><Button size="sm" onClick={onBack}>返回工具</Button><strong>多 Agent</strong><Button size="sm" active={view === 'list'} onClick={() => setView('list')}>任务列表</Button><Button size="sm" active={view === 'windows'} onClick={() => setView('windows')}>窗口{panels.length ? ` ${panels.length}` : ''}</Button><Button size="sm" disabled={busy} onClick={() => void window.yan.hub.detect().then(setSnapshot).catch((e) => setError(String(e)))}>检测 CLI</Button></div>
    {error ? <p role="alert">{error}</p> : null}
    <form className="hub-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <label>用户模板<Select value={templateId} onChange={(e) => {
        const id = e.target.value; setTemplateId(id); requestId.current = null
        const template = snapshot?.templates?.find((t) => t.id === id)
        if (!template) { setTemplateName(''); return }
        setTemplateName(template.name); setAgent(template.agent); setMode(template.mode); setPrompt(template.prompt); setModel(template.model || ''); setReasoningEffort(template.reasoningEffort || ''); setReviewOf('')
      }}><option value="">新模板</option>{snapshot?.templates?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
      <label>模板名称<Input maxLength={80} value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="例如：代码审查" /></label>
      <div className="hub-row"><Button size="sm" disabled={busy || !templateName.trim() || !prompt.trim()} onClick={() => { const id = templateId || crypto.randomUUID(); setTemplateId(id); void act({ action: 'save-template', template: { id, name: templateName, agent, mode, prompt, model: model || undefined, reasoningEffort: reasoningEffort || undefined } }) }}>保存模板</Button>{templateId && snapshot?.templates?.some((t) => t.id === templateId) ? <Button size="sm" disabled={busy} onClick={() => { void act({ action: 'delete-template', id: templateId }); setTemplateId(''); setTemplateName('') }}>删除模板</Button> : null}</div>
      <label>项目<Select value={projectId} onChange={(e) => { setProjectId(e.target.value); requestId.current = null }}><option value="">选择项目</option>{snapshot?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
      <label>Agent<Select value={agent} onChange={(e) => { const next = e.target.value as HubAgent; setAgent(next); setMode(snapshot?.adapters.find((a) => a.agent === next)?.modes[0] ?? 'terminal'); requestId.current = null }}>{snapshot?.adapters.map((a) => <option key={a.agent} value={a.agent} disabled={!a.available}>{a.agent} · {a.available ? a.version || '原生' : '未安装'}</option>)}</Select></label>
      <label>执行方式<Select value={mode} onChange={(e) => { setMode(e.target.value as HubMode); requestId.current = null }}>{availableModes.map((value) => <option key={value} value={value}>{value === 'managed' ? '受管执行' : '交互终端'}</option>)}</Select></label>
      <label>模型<Input value={model} placeholder="沿用此 Agent 当前模型" onChange={(e) => { setModel(e.target.value); requestId.current = null }} /></label>
      {agent === 'codex' && mode === 'managed' ? <label>思考强度<Select value={reasoningEffort} onChange={(e) => { setReasoningEffort(e.target.value as typeof reasoningEffort); requestId.current = null }}><option value="">沿用默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></Select></label> : null}
      <label>审查成果<Select value={reviewOf} onChange={(e) => { setReviewOf(e.target.value); requestId.current = null }}><option value="">新任务 · 从项目 HEAD 开始</option>{snapshot?.tasks.filter((t) => t.projectId === projectId && t.artifact && ['needs_review', 'completed'].includes(t.status)).map((t) => <option key={t.id} value={t.id}>{t.title} · {t.artifact!.sha256.slice(0, 8)}</option>)}</Select></label>
      <label>任务<Textarea value={prompt} rows={4} maxLength={32000} placeholder="说明任务范围、交付成果与预算" onChange={(e) => { setPrompt(e.target.value); requestId.current = null }} /></label>
      <p>{mode === 'managed' ? '使用各自登录与额度；共享工具走砚。原生 shell 不属于全局隔离保证。' : '终端使用原有 CLI 配置；共享工具未协调，状态需人工核对。'}</p>
      <Button type="submit" disabled={busy || !projectId || !prompt.trim()}>派活</Button>
    </form>
    {snapshot?.resources.filter((r) => r.owner || r.waiting || r.uncertain || r.paused).map((r) => <div key={r.resourceId}><p>{r.resourceId} · {r.uncertain ? '结果待核实，暂停转交' : r.paused ? '用户接管' : `${r.owner} 使用中`} · 等待 {r.waiting}</p>{r.uncertain ? <Button disabled={busy} onClick={() => { if (window.confirm('请先确认旧浏览器或桌面操作已停止，并核对实际页面与输入结果。已确认可以恢复共享工具？')) void act({ action: 'recover-resource', resourceId: r.resourceId, epoch: r.epoch }) }}>核对后恢复共享工具</Button> : null}</div>)}
    {view === 'windows' ? <AgentWindows snapshot={snapshot} panels={panels} setPanels={setPanels} onRefresh={refresh} onError={setError} /> : <>
    <div className="hub-row"><Button size="sm" active={!attentionOnly} onClick={() => setAttentionOnly(false)}>全部任务</Button><Button size="sm" active={attentionOnly} onClick={() => setAttentionOnly(true)}>待处理 · {snapshot?.tasks.filter((t) => ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).length ?? 0}</Button></div>
    <div className="hub-task-list">{snapshot?.tasks.filter((t) => !attentionOnly || ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).map((t) => <Button key={t.id} active={t.id === selected} onClick={() => setSelected(t.id)}>{t.title} · {t.agent} · {statusText[t.status]}</Button>)}</div>
    {task ? <div className="hub-detail">
      <strong>{task.title} · {statusText[task.status]}</strong>
      <p>{task.agent} · {task.mode === 'managed' ? '受管执行' : '交互终端'} · 基线 {task.baseline?.slice(0, 8) || '准备中'}{task.artifact ? ` · 成果 ${task.artifact.sha256.slice(0, 8)}` : ''}</p>
      {task.workspace ? <p className="hub-path">{task.workspace}</p> : null}
      {task.parentTaskId ? <p>派活来源：<Button size="sm" onClick={() => setSelected(task.parentTaskId!)}>{snapshot?.tasks.find((t) => t.id === task.parentTaskId)?.title || task.parentTaskId}</Button></p> : null}
      {snapshot?.tasks.filter((t) => t.parentTaskId === task.id).map((child) => <Button key={child.id} size="sm" onClick={() => setSelected(child.id)}>派活：{child.title} · {statusText[child.status]}</Button>)}
      {task.error ? <p role="alert">{task.error}</p> : null}
      <div className="hub-row">
        {['queued', 'preparing', 'running', 'waiting_input'].includes(task.status) ? <Button disabled={busy} onClick={() => void act({ action: 'cancel', taskId: task.id })}>停止任务</Button> : null}
        {task.status === 'needs_review' ? <Button disabled={busy} onClick={() => void act({ action: 'accept', taskId: task.id })}>验收成果</Button> : null}
        {['uncertain', 'failed', 'cancelled'].includes(task.status) ? <Button disabled={busy} onClick={() => { if (window.confirm('已核对旧运行与操作结果，并确认可以继续？恢复会启动新一次运行。')) void act({ action: 'resume', taskId: task.id }) }}>核对后恢复</Button> : null}
      </div>
      {snapshot?.approvals.filter((a) => a.taskId === task.id).map((approval) => <div key={approval.id} className="hub-approval"><strong>{approval.title}</strong><pre>{approval.detail}</pre>{approval.questions?.map((q) => <label key={q.id}>{q.question}{q.options?.length ? <p>{q.options.join(' / ')}</p> : null}<Input disabled={approval.status !== 'pending'} value={answers[approval.id]?.[q.id] ?? ''} onChange={(e) => setAnswers((old) => ({ ...old, [approval.id]: { ...old[approval.id], [q.id]: e.target.value } }))} /></label>)}<p>{approval.status === 'pending' ? `待答复 · ${new Date(approval.expiresAt).toLocaleTimeString()}` : approval.status === 'sent' ? '答复已发送，等待对端确认' : approval.status === 'resolved' ? '对端已确认处理' : '审批已失效或待核实'}</p>{approval.status === 'pending' ? <div className="hub-row"><Button disabled={busy} onClick={() => void act({ action: 'answer', approvalId: approval.id, answer: 'accept', answers: answers[approval.id] })}>{approval.kind === 'question' ? '发送答复' : '批准本次'}</Button><Button disabled={busy} onClick={() => void act({ action: 'answer', approvalId: approval.id, answer: 'decline' })}>拒绝</Button></div> : null}</div>)}
      {task.terminalId ? <HubTerminal task={task} onError={setError} onRefresh={refresh} /> : null}
      <div className="hub-messages">
        <strong>时间线</strong>
        {snapshot?.messages?.filter((m) => m.taskId === task.id).slice(-20).map((m) => <div key={m.id} className="hub-message">
          <p>{m.fromTaskId ? `来自 ${snapshot.tasks.find((t) => t.id === m.fromTaskId)?.title ?? m.fromTaskId}` : '用户'} · {new Date(m.createdAt).toLocaleTimeString()} · {m.delivery === 'injected' ? '已注入' : m.delivery === 'typed' ? '已写入终端' : m.delivery === 'queued' ? '排队中' : '投递失败'}</p>
          <pre>{m.packet ? `${m.packet.summary}${m.packet.request ? `\n请求：${m.packet.request}` : ''}${m.packet.context ? `\n上下文：${m.packet.context}` : ''}` : m.text}</pre>
        </div>)}
        <label>发送交接包给<Select value={packetTarget} onChange={(e) => setPacketTarget(e.target.value)}><option value="">选择运行中的任务</option>{snapshot?.tasks.filter((t) => t.id !== task.id && t.projectId === task.projectId && ['preparing', 'running', 'waiting_input'].includes(t.status) && (t.mode === 'terminal' || (snapshot?.adapters.find((a) => a.agent === t.agent)?.capabilities?.includes('handoff') ?? false))).map((t) => <option key={t.id} value={t.id}>{t.title} · {t.agent}{t.mode === 'terminal' ? ' · 终端' : ''}</option>)}</Select></label>
        <label>交接摘要<Input value={packetSummary} maxLength={4000} onChange={(e) => setPacketSummary(e.target.value)} placeholder="把哪些资料交给对方" /></label>
        <label>请求<Input value={packetRequest} maxLength={8000} onChange={(e) => setPacketRequest(e.target.value)} placeholder="希望对方做什么（可选）" /></label>
        <label>上下文<Input value={packetContext} maxLength={8000} onChange={(e) => setPacketContext(e.target.value)} placeholder="补充说明（可选）" /></label>
        <Button disabled={busy || !packetTarget || !packetSummary.trim()} onClick={() => void sendPacket()}>发送交接包</Button>
      </div>
      {task.report ? <pre className="hub-report">{task.report}</pre> : null}
      {snapshot?.runs?.some((r) => r.taskId === task.id) ? <div><strong>运行历史</strong>{snapshot.runs.filter((r) => r.taskId === task.id).map((r) => <details key={r.id}><summary>{new Date(r.startedAt).toLocaleString()} · {statusText[r.status]} · {r.model || r.agent}{r.artifact ? ` · ${r.artifact.sha256.slice(0, 8)}` : ''}</summary><p>运行 {r.id}{r.externalSessionId ? ` · 外部会话 ${r.externalSessionId}` : ''}</p>{r.error ? <p>{r.error}</p> : null}{r.report ? <pre className="hub-report">{r.report}</pre> : null}</details>)}</div> : null}
    </div> : null}
    </>}
  </section>
}

function AgentWindows({ snapshot, panels, setPanels, onRefresh, onError }: { snapshot: HubSnapshot | null; panels: string[]; setPanels: (next: string[]) => void; onRefresh: () => Promise<void>; onError: (error: string) => void }) {
  const tasks = snapshot?.tasks ?? []
  const opened = panels.map((id) => tasks.find((t) => t.id === id)).filter(Boolean) as HubTask[]
  const candidates = tasks.filter((t) => !panels.includes(t.id)).slice(0, 50)
  return <div className="hub-windows">
    <div className="hub-row">
      <Select value="" disabled={panels.length >= 4} onChange={(e) => { if (e.target.value && panels.length < 4) setPanels([...panels, e.target.value]) }}><option value="">＋ 增加 agent 窗口（最多 4 个）</option>{candidates.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.agent} · {statusText[t.status]}</option>)}</Select>
      <span>已开 {opened.length} 个窗口</span>
    </div>
    {opened.length ? <div className="hub-window-grid">{opened.map((task) => <AgentWindow key={task.id} task={task} onClose={() => setPanels(panels.filter((id) => id !== task.id))} onError={onError} onRefresh={onRefresh} />)}</div> : <p>还没有窗口。用上面的下拉把运行加入，就能在一个视图里同时看多个 agent。</p>}
  </div>
}

function AgentWindow({ task, onClose, onError, onRefresh }: { task: HubTask; onClose: () => void; onError: (error: string) => void; onRefresh: () => Promise<void> }) {
  return <div className="hub-window">
    <div className="hub-window-head">
      <span className="nm">{task.title}</span>
      <span className="sub">{task.agent} · {statusText[task.status]}</span>
      <span className="grow" />
      <Button size="sm" onClick={onClose}>关闭</Button>
    </div>
    {task.terminalId ? <HubTerminal task={task} onError={onError} onRefresh={onRefresh} /> : <div className="hub-window-note">
      {task.activity?.length ? task.activity.slice(-80).map((item) => item.kind === 'say'
        ? <p key={item.id} className="hub-act-say">{item.text}</p>
        : <details key={item.id} className="hub-act-tool"><summary>{(item.kind === 'patch' ? '✎ ' : '❯ ') + (item.title ?? '') + (item.status === 'done' ? ' ✓' : item.status === 'failed' ? ' ✗' : ' …')}</summary><pre>{item.text}{item.detail ? `\n${item.detail}` : ''}</pre></details>)
        : <p>受管执行没有终端画面；过程与成果在「任务列表」的详情里查看。</p>}
    </div>}
  </div>
}

function HubTerminal({ task, onError, onRefresh }: { task: HubTask; onError: (error: string) => void; onRefresh: () => Promise<void> }) {
  const element = useRef<HTMLDivElement>(null)
  const current = useRef(task); current.current = task
  useEffect(() => {
    if (!element.current || !task.terminalId) return
    const styles = getComputedStyle(document.documentElement)
    const term = new Terminal({ fontSize: 12, scrollback: 3000, theme: { background: styles.getPropertyValue('--bg-0').trim(), foreground: styles.getPropertyValue('--fg').trim() } })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(element.current)
    let alive = true; let seq: number | undefined; let reading = false
    const read = async () => {
      if (!alive || reading) return
      reading = true
      try {
        const result = await window.yan.hub.command({ action: 'inspect', taskId: task.id, sinceSeq: seq }) as { terminal: { kind: string; data: string; seq: number; cols: number; rows: number } | null }
        if (!alive || !result.terminal) return
        const update = result.terminal
        if (update.kind === 'snapshot') term.reset()
        term.resize(update.cols, update.rows)
        await new Promise<void>((done) => term.write(update.data, done))
        seq = update.seq
      } catch (error) { if (alive) onError(String(error)) }
      finally { reading = false }
    }
    void read(); const poll = setInterval(() => void read(), 150)
    let pending = Promise.resolve()
    const send = (command: HubCommand) => { pending = pending.then(async () => { if (alive) await window.yan.hub.command(command) }).catch((error) => onError(String(error))) }
    const sub = term.onData((data) => { const t = current.current; if (t.inputOwner === 'desktop') send({ action: 'input', taskId: t.id, epoch: t.inputEpoch ?? 0, data }) })
    const observer = new ResizeObserver(() => { fit.fit(); const t = current.current; if (t.inputOwner === 'desktop') send({ action: 'resize', taskId: t.id, epoch: t.inputEpoch ?? 0, cols: term.cols, rows: term.rows }) })
    observer.observe(element.current)
    const theme = new MutationObserver(() => {
      const next = getComputedStyle(document.documentElement)
      term.options.theme = { background: next.getPropertyValue('--bg-0').trim(), foreground: next.getPropertyValue('--fg').trim() }
    })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => { alive = false; clearInterval(poll); sub.dispose(); observer.disconnect(); theme.disconnect(); term.dispose() }
  }, [task.terminalId, onError])
  return <><div className="hub-row"><span>输入端：{task.inputOwner?.startsWith('phone:') ? '手机' : task.inputOwner === 'desktop' ? '电脑' : '只读'}</span>{task.status === 'running' && task.inputOwner !== 'desktop' ? <Button onClick={() => void window.yan.hub.command({ action: 'claim-input', taskId: task.id, epoch: task.inputEpoch ?? 0 }).then(onRefresh).catch((error) => onError(String(error)))}>电脑接管</Button> : null}</div><div ref={element} className="hub-terminal" /></>
}
