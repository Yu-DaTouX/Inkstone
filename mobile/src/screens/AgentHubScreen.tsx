import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, ScrollView, Text, TextInput, View } from 'react-native'
import { WebView } from 'react-native-webview'
import type { HubActivity, HubAgent, HubCommand, HubMode, HubSnapshot, HubTask } from '../../../src/shared/agent-hub'
import { idempotencyKey } from '../api/client'
import { useRemote } from '../state'
import { Button, Header, IconButton, Meta } from '../ui'
import { font, mono, space, usePalette } from '../theme'

const states: Record<HubTask['status'], string> = { queued: '排队中', preparing: '准备工作区', running: '运行中', waiting_input: '等你答复', needs_review: '待审阅', completed: '已验收', failed: '失败', cancelled: '已停止', uncertain: '结果待核实' }

export function AgentHubScreen({ onBack }: { onBack: () => void }) {
  const p = usePalette()
  const { client } = useRemote()
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const scroll = useRef<ScrollView>(null)
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }) }, [selected])
  const [projectId, setProjectId] = useState('')
  const [agent, setAgent] = useState<HubAgent>('codex')
  const [mode, setMode] = useState<HubMode>('managed')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high' | ''>('')
  const [reviewOf, setReviewOf] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({})
  const [history, setHistory] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'windows'>('list')
  const [panels, setPanels] = useState<string[]>([])
  const [packetTarget, setPacketTarget] = useState('')
  const [packetSummary, setPacketSummary] = useState('')
  const packetKey = useRef<string | null>(null)
  const [error, setError] = useState('')
  const attempt = useRef<string | null>(null)
  const refresh = useCallback(async () => {
    const next = await client.hubSnapshot(); setSnapshot(next)
    setProjectId((current) => current || next.projects[0]?.id || '')
  }, [client])
  useEffect(() => {
    let active = true; let fetching = false
    const read = async () => {
      if (!active || fetching) return
      fetching = true
      try { await refresh() } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : String(failure)) }
      finally { fetching = false }
    }
    void read(); const timer = setInterval(() => void read(), 2000)
    return () => { active = false; clearInterval(timer) }
  }, [refresh])
  const act = async (command: HubCommand) => {
    setBusy(true); setError('')
    try { await client.hubCommand(command); await refresh() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const create = async () => {
    const key = attempt.current ?? idempotencyKey(); attempt.current = key
    setBusy(true); setError('')
    try {
      const result = await client.hubCommand({ action: 'create', request: { agent, mode, projectId, prompt, model: model || undefined, reasoningEffort: agent === 'codex' ? reasoningEffort || undefined : undefined, reviewOf: reviewOf || undefined, requestId: key } }, key) as { taskId: string }
      attempt.current = null; setPrompt(''); setSelected(result.taskId); await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const sendPacket = async () => {
    const key = packetKey.current ?? idempotencyKey(); packetKey.current = key
    setBusy(true); setError('')
    try {
      await client.hubCommand({ action: 'send-packet', requestId: key, toTaskId: packetTarget, summary: packetSummary })
      packetKey.current = null; setPacketSummary(''); await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const task = snapshot?.tasks.find((t) => t.id === selected)
  const gap = { gap: space[2] }
  const row = { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: space[2] }
  const text = { color: p.fg, fontSize: font.body }
  const input = { color: p.fg, borderColor: p.borderSoft, borderWidth: 1, borderRadius: 6, padding: space[2], fontSize: font.body }
  return <View style={{ flex: 1, backgroundColor: p.bg0 }}>
    <Header title="多 Agent" left={<IconButton name="back" label="返回工作台" onPress={onBack} />} />
    <ScrollView ref={scroll} contentContainerStyle={{ padding: space[4], gap: space[4] }} keyboardShouldPersistTaps="handled">
      {error ? <Text accessibilityRole="alert" style={{ color: p.err }}>{error}</Text> : null}
      <View style={row}><Button compact label="任务" variant={view === 'list' ? 'primary' : 'secondary'} onPress={() => setView('list')} /><Button compact label={`窗口${panels.length ? ` ${panels.length}` : ''}`} variant={view === 'windows' ? 'primary' : 'secondary'} onPress={() => setView('windows')} /></View>
      {selected ? <Button label="新派活" compact onPress={() => setSelected('')} /> : <View style={gap}>
        <Text style={text}>用户模板</Text><View style={row}><Button compact label="新模板" onPress={() => { setTemplateId(''); setTemplateName('') }} />{snapshot?.templates?.map((template) => <Button key={template.id} compact label={template.name} variant={templateId === template.id ? 'primary' : 'secondary'} onPress={() => {
          setTemplateId(template.id); setTemplateName(template.name); setAgent(template.agent); setMode(template.mode); setPrompt(template.prompt); setModel(template.model || ''); setReasoningEffort(template.reasoningEffort || ''); setReviewOf(''); attempt.current = null
        }} />)}</View>
        <TextInput accessibilityLabel="模板名称" maxLength={80} value={templateName} onChangeText={setTemplateName} placeholder="例如：代码审查" placeholderTextColor={p.fgMute} style={input} />
        <View style={row}><Button compact label="保存模板" disabled={busy || !templateName.trim() || !prompt.trim()} onPress={() => { const id = templateId || idempotencyKey(); setTemplateId(id); void act({ action: 'save-template', template: { id, name: templateName, agent, mode, prompt, model: model || undefined, reasoningEffort: reasoningEffort || undefined } }) }} />{templateId && snapshot?.templates?.some((t) => t.id === templateId) ? <Button compact label="删除模板" disabled={busy} onPress={() => { void act({ action: 'delete-template', id: templateId }); setTemplateId(''); setTemplateName('') }} /> : null}</View>
        <Text style={text}>项目</Text><View style={row}>{snapshot?.projects.map((project) => <Button key={project.id} label={project.name} variant={project.id === projectId ? 'primary' : 'secondary'} compact onPress={() => { setProjectId(project.id); attempt.current = null }} />)}</View>
        <Text style={text}>Agent</Text><View style={row}>{snapshot?.adapters.map((adapter) => <Button key={adapter.agent} label={`${adapter.agent}${adapter.available ? '' : ' · 未安装'}`} disabled={!adapter.available} variant={adapter.agent === agent ? 'primary' : 'secondary'} compact onPress={() => { setAgent(adapter.agent); setMode(adapter.modes[0]); attempt.current = null }} />)}</View>
        <View style={row}>{snapshot?.adapters.find((a) => a.agent === agent)?.modes.map((value) => <Button key={value} label={value === 'managed' ? '受管执行' : '交互终端'} variant={value === mode ? 'primary' : 'secondary'} compact onPress={() => { setMode(value); attempt.current = null }} />)}</View>
        <TextInput accessibilityLabel="模型" value={model} placeholder="沿用 Agent 当前模型" placeholderTextColor={p.fgMute} style={input} onChangeText={(value) => { setModel(value); attempt.current = null }} />
        {agent === 'codex' && mode === 'managed' ? <View style={row}>{([['', '默认思考'], ['low', '低'], ['medium', '中'], ['high', '高']] as const).map(([value, label]) => <Button key={value} compact label={label} variant={value === reasoningEffort ? 'primary' : 'secondary'} onPress={() => { setReasoningEffort(value); attempt.current = null }} />)}</View> : null}
        <View style={row}><Button compact label="新任务 · HEAD 基线" onPress={() => { setReviewOf(''); attempt.current = null }} />{snapshot?.tasks.filter((t) => t.projectId === projectId && t.artifact && ['needs_review', 'completed'].includes(t.status)).map((t) => <Button key={t.id} compact label={`审查：${t.title}`} variant={reviewOf === t.id ? 'primary' : 'secondary'} onPress={() => { setReviewOf(t.id); attempt.current = null }} />)}</View>
        <TextInput accessibilityLabel="任务内容" value={prompt} onChangeText={(value) => { setPrompt(value); attempt.current = null }} multiline maxLength={32000} placeholder="任务范围、交付成果与预算" placeholderTextColor={p.fgMute} style={[input, { minHeight: 100, textAlignVertical: 'top' }]} />
        <Meta>使用该 Agent 自己的登录与额度。交互终端原有共享工具未协调。</Meta>
        <Button label="派活" disabled={busy || !projectId || !prompt.trim()} onPress={() => void create()} />
      </View>}
      {snapshot?.resources.filter((r) => r.owner || r.waiting || r.uncertain).map((r) => <Meta key={r.resourceId}>{r.resourceId} · {r.uncertain ? '结果待核实' : '使用中'} · 等待 {r.waiting}</Meta>)}
      {view === 'windows' ? <>
        <Text style={text}>窗口 · {panels.length}/3</Text>
        <View style={row}>{snapshot?.tasks.filter((t) => !panels.includes(t.id)).map((t) => <Button key={t.id} compact disabled={panels.length >= 3} label={`＋ ${t.title}`} onPress={() => setPanels([...panels, t.id])} />)}</View>
        {panels.length === 0 ? <Meta>还没有窗口。点上面的按钮把运行加进来，就能在一个页面里同时看多个 agent。</Meta> : null}
        {panels.map((id) => { const t = snapshot?.tasks.find((x) => x.id === id); if (!t) return null; return <View key={id} style={{ borderWidth: 1, borderColor: p.borderSoft, borderRadius: 8, padding: space[2], gap: space[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}><Text style={text}>{t.title} · {t.agent} · {states[t.status]}</Text><View style={{ flex: 1 }} /><Button compact label="关闭" onPress={() => setPanels(panels.filter((x) => x !== id))} /></View>
          {t.terminalId ? <PhoneTerminal task={t} onRefresh={refresh} onError={setError} /> : <><Meta>受管执行没有终端画面；过程与成果在「任务」列表的详情里查看。</Meta>{t.report ? <Text selectable style={[text, { fontFamily: mono }]}>{t.report}</Text> : <Meta>完成后这里显示报告。</Meta>}</>}
        </View> })}
      </> : <>
      <View style={row}><Button compact label="全部任务" variant={!attentionOnly ? 'primary' : 'secondary'} onPress={() => setAttentionOnly(false)} /><Button compact label={`待处理 · ${snapshot?.tasks.filter((t) => ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).length ?? 0}`} variant={attentionOnly ? 'primary' : 'secondary'} onPress={() => setAttentionOnly(true)} /></View>
      <View style={gap}>{snapshot?.tasks.filter((t) => !attentionOnly || ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).map((t) => <Button key={t.id} label={`${t.title} · ${t.agent} · ${states[t.status]}`} variant={t.id === selected ? 'primary' : 'secondary'} onPress={() => setSelected(t.id)} />)}</View>
      {task ? <View style={gap}>
        <Text style={text}>{task.title} · {states[task.status]}</Text>
        {task.parentTaskId ? <Button compact label={`派活来源：${snapshot?.tasks.find((t) => t.id === task.parentTaskId)?.title || task.parentTaskId}`} onPress={() => setSelected(task.parentTaskId!)} /> : null}
        {snapshot?.tasks.filter((t) => t.parentTaskId === task.id).map((child) => <Button key={child.id} compact label={`派活：${child.title} · ${states[child.status]}`} onPress={() => setSelected(child.id)} />)}
        <Meta>基线 {task.baseline?.slice(0, 8) || '准备中'}{task.artifact ? ` · 成果 ${task.artifact.sha256.slice(0, 8)}` : ''}</Meta>
        {task.error ? <Text style={{ color: p.err }}>{task.error}</Text> : null}
        <View style={row}>
          {['queued', 'preparing', 'running', 'waiting_input'].includes(task.status) ? <Button label="停止任务" disabled={busy} onPress={() => void act({ action: 'cancel', taskId: task.id })} /> : null}
          {task.status === 'needs_review' ? <Button label="验收成果" disabled={busy} onPress={() => void act({ action: 'accept', taskId: task.id })} /> : null}
          {['uncertain', 'failed', 'cancelled'].includes(task.status) ? <Button label="核对后恢复" disabled={busy} onPress={() => Alert.alert('核对旧运行', '已确认旧运行停止，并核对操作结果，可以继续？', [{ text: '取消' }, { text: '继续', onPress: () => void act({ action: 'resume', taskId: task.id }) }])} /> : null}
        </View>
        {snapshot?.approvals.filter((a) => a.taskId === task.id).map((approval) => <View key={approval.id} style={gap}><Text style={text}>{approval.title}</Text><Text selectable style={[text, { fontFamily: mono }]}>{approval.detail}</Text>{approval.questions?.map((q) => <View key={q.id}><Text style={text}>{q.question}</Text>{q.options?.length ? <Meta>{q.options.join(' / ')}</Meta> : null}<TextInput accessibilityLabel={q.question} editable={approval.status === 'pending'} style={input} value={answers[approval.id]?.[q.id] ?? ''} onChangeText={(value) => setAnswers((old) => ({ ...old, [approval.id]: { ...old[approval.id], [q.id]: value } }))} /></View>)}<Meta>{approval.status === 'pending' ? '待答复' : approval.status === 'sent' ? '答复已发送，等待对端确认' : '已处理或失效'}</Meta>{approval.status === 'pending' ? <View style={row}><Button label={approval.kind === 'question' ? '发送答复' : '批准本次'} disabled={busy} onPress={() => void act({ action: 'answer', approvalId: approval.id, answer: 'accept', answers: answers[approval.id] })} /><Button label="拒绝" disabled={busy} onPress={() => void act({ action: 'answer', approvalId: approval.id, answer: 'decline' })} /></View> : null}</View>)}
        {task.terminalId ? <PhoneTerminal key={task.terminalId} task={task} onRefresh={refresh} onError={setError} /> : null}
        <Text style={text}>时间线</Text>
        {snapshot?.messages?.filter((m) => m.taskId === task.id).slice(-10).map((m) => <View key={m.id} style={gap}><Meta>{m.fromTaskId ? `来自 ${snapshot.tasks.find((t) => t.id === m.fromTaskId)?.title ?? m.fromTaskId}` : '用户'} · {new Date(m.createdAt).toLocaleTimeString()} · {m.delivery === 'injected' ? '已注入' : m.delivery === 'typed' ? '已写入终端' : m.delivery === 'queued' ? '排队中' : '投递失败'}</Meta><Text style={text}>{m.packet?.summary ?? m.text}</Text></View>)}
        <Text style={text}>发送交接包给</Text>
        <View style={row}>{snapshot?.tasks.filter((t) => t.id !== task.id && t.projectId === task.projectId && ['preparing', 'running', 'waiting_input'].includes(t.status) && (t.mode === 'terminal' || (snapshot?.adapters.find((a) => a.agent === t.agent)?.capabilities?.includes('handoff') ?? false))).map((t) => <Button key={t.id} compact label={`${t.title}${t.mode === 'terminal' ? ' · 终端' : ''}`} variant={packetTarget === t.id ? 'primary' : 'secondary'} onPress={() => setPacketTarget(t.id)} />)}</View>
        <TextInput accessibilityLabel="交接摘要" value={packetSummary} onChangeText={setPacketSummary} placeholder="交接摘要" placeholderTextColor={p.fgMute} style={input} />
        <Button label="发送交接包" disabled={busy || !packetTarget || !packetSummary.trim()} onPress={() => void sendPacket()} />
        <ChatView activity={task.activity} />
        {task.report && !task.activity?.length ? <Text selectable style={[text, { fontFamily: mono }]}>{task.report}</Text> : null}
        {snapshot?.runs?.some((run) => run.taskId === task.id) ? <View style={gap}><Text style={text}>运行历史</Text>{snapshot.runs.filter((run) => run.taskId === task.id).map((run) => <View key={run.id} style={gap}><Button compact label={`${new Date(run.startedAt).toLocaleString()} · ${states[run.status]} · ${run.model || run.agent}${run.artifact ? ` · ${run.artifact.sha256.slice(0, 8)}` : ''}`} onPress={() => setHistory((old) => old === run.id ? null : run.id)} />{history === run.id ? <><Meta>运行 {run.id}{run.externalSessionId ? ` · 外部会话 ${run.externalSessionId}` : ''}</Meta>{run.error ? <Text style={{ color: p.err }}>{run.error}</Text> : null}{run.report ? <Text selectable style={[text, { fontFamily: mono }]}>{run.report}</Text> : null}</> : null}</View>)}</View> : null}
      </View> : null}
      </>}
    </ScrollView>
  </View>
}

function ChatView({ activity }: { activity?: HubActivity[] }) {
  const p = usePalette()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (!activity?.length) return null
  return <View style={{ gap: space[2] }}>
    <Text style={{ color: p.fgMute, fontSize: font.sm }}>过程</Text>
    {activity.map((item) => item.kind === 'say'
      ? <Text key={item.id} selectable style={{ color: p.fg, fontFamily: mono, fontSize: font.sm, lineHeight: 21 }}>{item.text}</Text>
      : <View key={item.id} style={{ borderWidth: 1, borderColor: p.borderSoft, borderRadius: 8, padding: space[2], gap: space[2] }}>
          <Text style={{ color: item.status === 'failed' ? p.err : p.fgMute, fontFamily: mono, fontSize: font.xs }}>{(item.kind === 'patch' ? '✎ ' : '❯ ') + (item.title ?? '') + (item.status === 'done' ? ' ✓' : item.status === 'failed' ? ' ✗' : ' …')}</Text>
          {item.text ? <Text selectable style={{ color: p.fg, fontFamily: mono, fontSize: font.xs }}>{item.text}</Text> : null}
          {item.detail ? (open[item.id] ? <Text selectable style={{ color: p.fgDim, fontFamily: mono, fontSize: font.xs }}>{item.detail}</Text> : <Button compact label="展开输出" onPress={() => setOpen((old) => ({ ...old, [item.id]: true }))} />) : null}
        </View>)}
  </View>
}

function PhoneTerminal({ task, onRefresh, onError }: { task: HubTask; onRefresh: () => Promise<void>; onError: (error: string) => void }) {
  const { client } = useRemote()
  const web = useRef<WebView<unknown>>(null)
  const current = useRef(task); current.current = task
  const [ready, setReady] = useState(false)
  const owner = `phone:${client.connection.deviceId}`
  const mine = task.inputOwner === owner
  const [entry, setEntry] = useState('')
  const [sending, setSending] = useState(false)
  const submitting = useRef(false)
  const p = usePalette()
  const inputQueue = useRef(Promise.resolve())
  const size = useRef({ cols: 80, rows: 24 })
  const resize = () => {
    const t = current.current
    if (t.inputOwner !== owner) return
    const dimensions = { ...size.current }
    inputQueue.current = inputQueue.current.then(async () => { await client.hubCommand({ action: 'resize', taskId: t.id, epoch: t.inputEpoch ?? 0, ...dimensions }) }).catch((error) => onError(String(error)))
  }
  const send = async (data: string) => {
    const t = current.current
    if (t.inputOwner !== owner) return false
    let accepted = true
    try {
      inputQueue.current = inputQueue.current.then(async () => {
        const result = await client.hubCommand({ action: 'input', taskId: t.id, epoch: t.inputEpoch ?? 0, data }) as { accepted: boolean }
        if (!result.accepted) throw new Error('终端未接收输入，请核对运行状态')
      }).catch((error) => { accepted = false; onError(String(error)) })
      await inputQueue.current
      return accepted
    }
    catch (error) { onError(String(error)); await onRefresh(); return false }
  }
  const submit = async () => {
    if (submitting.current) return
    submitting.current = true; setSending(true)
    const submitted = entry
    try { if (await send(`${submitted}\r`)) setEntry((value) => value === submitted ? '' : value) }
    finally { submitting.current = false; setSending(false) }
  }
  useEffect(() => {
    if (!ready) return
    let active = true; let fetching = false; let seq: number | undefined
    const poll = async () => {
      if (!active || fetching) return
      fetching = true
      try {
        const update = await client.hubCommand({ action: 'inspect', taskId: task.id, sinceSeq: seq }) as { terminal: { kind: string; data: string; seq: number } | null }
        if (active && update.terminal) { web.current?.postMessage(JSON.stringify(update.terminal)); seq = update.terminal.seq }
      } catch (error) { if (active) onError(String(error)) }
      finally { fetching = false }
    }
    void poll(); const timer = setInterval(() => void poll(), 1000)
    return () => { active = false; clearInterval(timer) }
  }, [client, task.id, ready, onError])
  useEffect(() => {
    if (ready) web.current?.postMessage(JSON.stringify({ kind: 'theme', background: p.bg0, foreground: p.fg }))
  }, [ready, p.bg0, p.fg])
  useEffect(() => { if (ready && mine) resize() }, [ready, mine, task.inputEpoch])
  return <View style={{ gap: space[2] }}>
    <Meta>输入端：{mine ? '这台手机' : task.inputOwner === 'desktop' ? '电脑' : task.inputOwner ? '其他手机' : '只读'}</Meta>
    {!mine && task.status === 'running' ? <Button label="手机接管输入" onPress={() => void client.hubCommand({ action: 'claim-input', taskId: task.id, epoch: task.inputEpoch ?? 0 }).then(onRefresh).catch((error) => onError(String(error)))} /> : null}
    <WebView<unknown> ref={web} source={{ uri: 'file:///android_asset/inkstone-terminal/index.html' }} style={{ height: 360 }} javaScriptEnabled allowFileAccess originWhitelist={['file://*']} onShouldStartLoadWithRequest={(request) => request.url.startsWith('file:///android_asset/inkstone-terminal/')} onMessage={(event) => {
      try {
        const message = JSON.parse(event.nativeEvent.data)
        if (message.kind === 'ready') setReady(true)
        if (message.kind === 'size' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 2 && message.rows <= 1000) { size.current = { cols: message.cols, rows: message.rows }; resize() }
        if (message.kind === 'input' && typeof message.data === 'string') void send(message.data)
      } catch { /* 只接受本地终端协议 */ }
    }} />
    {mine ? <>
      <TextInput accessibilityLabel="终端输入" value={entry} onChangeText={setEntry} placeholder="发送到终端" placeholderTextColor={p.fgMute} style={{ color: p.fg, borderWidth: 1, borderColor: p.borderSoft, padding: space[2] }} onSubmitEditing={() => { void submit() }} />
      <Button label="发送" disabled={!entry || sending} onPress={() => { void submit() }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{[['Enter', '\r'], ['Ctrl+C', '\u0003'], ['Esc', '\u001b'], ['Tab', '\t'], ['↑', '\u001b[A'], ['↓', '\u001b[B']].map(([label, data]) => <Button key={label} label={label} compact onPress={() => void send(data)} />)}</View>
    </> : null}
  </View>
}
