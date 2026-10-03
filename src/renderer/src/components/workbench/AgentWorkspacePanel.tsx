import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HubAgent, HubCommand, HubSnapshot } from '../../../../shared/agent-hub'
import { agentWorkspaceRuns } from '../../../../shared/agent-workspace'
import { useStore } from '../../state/store'
import { selectSubagentRuns } from '../../state/subagent-view'
import { AgentMessageStream } from '../chat/AgentMessageStream'
import { AgentHubPanel, HubTerminal } from './AgentHubPanel'
import { AgentHubHome, AGENT_STATUS, agentName } from './AgentHubHome'
import { AgentRunChat } from './AgentRunChat'
import { Badge, Button, EmptyState, IconButton, ListRow, Select, Tab, Textarea } from '../ui'

/** 磁贴标题只留 Agent 名；任务标题有信息量时再补一小段（默认的「xx 终端」不重复）。 */
function tileTitle(agent:string,title:string):string{
  const name=agentName(agent)
  const text=title.trim()
  if(!text||/^(codex|claude|gemini|grok|pi)\s*终端$/i.test(text))return name
  return `${name} · ${text.length>12?text.slice(0,12)+'…':text}`
}

function rememberedTabs(): {active:string;opened:string[]} {
  try { const saved=JSON.parse(sessionStorage.getItem('inkstone-agent-tabs')??'{}');return {active:typeof saved.active==='string'?saved.active:'',opened:Array.isArray(saved.opened)?saved.opened.filter((id:unknown)=>typeof id==='string'):[]} } catch {return {active:'',opened:[]}}
}

/** 子任务与外部 CLI 共用界面，后端仍是唯一事实源。 */
export function AgentWorkspacePanel({ onBack, initialRun, onExpand, expanded, onlyRun = false, managerOnly = false, onOpenRun, onTitleChange }: { onBack():void; initialRun?:string; onExpand?():void; expanded?:boolean; onlyRun?:boolean; managerOnly?:boolean; onOpenRun?(key:string):void; onTitleChange?(title:string):void }) {
  const session=useStore(s=>s.session)
  const sessionProject=useStore(s=>s.runners.find(r=>(r.runId??r.id)===s.activeRunnerId)?.projectId)
  const subagents=useStore(s=>s.subagents)
  const loadSubagents=useStore(s=>s.loadSubagents)
  const [snapshot,setSnapshot]=useState<HubSnapshot|null>(null)
  const remembered=useRef(rememberedTabs())
  const [active,setActive]=useState(initialRun ?? remembered.current.active)
  const [opened,setOpened]=useState<string[]>(initialRun?[...new Set([...remembered.current.opened,initialRun])]:remembered.current.opened)
  const restored=useRef(remembered.current.opened.length>0)
  const [error,setError]=useState('')
  const [creating,setCreating]=useState(false)
  const [list,setList]=useState(managerOnly)
  const [details,setDetails]=useState(false)
  const [busy,setBusy]=useState(false)
  const [agent,setAgent]=useState<HubAgent>('codex')
  const [projectId,setProjectId]=useState('')
  const [mode,setMode]=useState<'terminal'|'managed'|'readonly'>('terminal')
  const [prompt,setPrompt]=useState('')
  const [messages,setMessages]=useState(false)
  const createId=useRef<{id:string;signature:string}|undefined>(undefined)
  const sessionId=session?.sessionId
  const refresh=useCallback(async()=>{const next=await window.yan.hub.snapshot();setSnapshot(next);setProjectId(id=>id||sessionProject||next.projects[0]?.id||'')},[sessionProject])
  useEffect(()=>{let alive=true;const read=async()=>{try{if(alive)await refresh()}catch(e){if(alive)setError(String(e))}};void loadSubagents();void read();const timer=setInterval(()=>void read(),2000);return()=>{alive=false;clearInterval(timer)}},[refresh,loadSubagents])
  const owned=useMemo(()=>selectSubagentRuns(subagents,{sessionIds:[session?.sessionId,session?.conversationId].filter((id):id is string=>!!id)}).all,[subagents,session?.sessionId,session?.conversationId])
  const runs=useMemo(()=>agentWorkspaceRuns(snapshot?.tasks??[],owned),[snapshot,owned])
  const openRun=useCallback((key:string)=>{if(onOpenRun){onOpenRun(key);return}setOpened(ids=>ids.includes(key)?ids:[...ids,key]);setActive(key);setList(false);setDetails(false)},[onOpenRun])
  useEffect(()=>{if(!managerOnly&&!restored.current&&runs.length){restored.current=true;if(!initialRun)openRun(runs[0].key)}},[runs,initialRun,openRun,managerOnly])
  useEffect(()=>{if(initialRun)openRun(initialRun)},[initialRun,openRun])
  useEffect(()=>{if(onlyRun||managerOnly)return;try{sessionStorage.setItem('inkstone-agent-tabs',JSON.stringify({active,opened}))}catch{}},[active,opened,onlyRun,managerOnly])
  useEffect(()=>{if(onlyRun||managerOnly)return;const open=(event:Event)=>{const key=(event as CustomEvent<string>).detail;if(typeof key==='string'&&/^(hub|subagent):[A-Za-z0-9-]+$/.test(key))openRun(key)};window.addEventListener('inkstone-agent-open',open);return()=>window.removeEventListener('inkstone-agent-open',open)},[openRun,onlyRun,managerOnly])
  const selected=managerOnly?undefined:onlyRun?runs.find(run=>run.key===initialRun):runs.find(run=>run.key===active)??runs.find(run=>opened.includes(run.key))
  const task=selected?.source==='hub'?snapshot?.tasks.find(t=>t.id===selected.id):undefined
  const taskMessages=task?(snapshot?.messages??[]).filter(m=>m.taskId===task.id).slice(-20):[]
  const queuedMessages=taskMessages.filter(m=>m.delivery==='queued').length
  const legacy=selected?.source==='subagent'?owned.find(t=>t.id===selected.id):undefined
  useEffect(()=>{if(selected)onTitleChange?.(`${tileTitle(selected.agent,selected.title)} · ${AGENT_STATUS[selected.status]??selected.status}`)},[selected?.agent,selected?.title,selected?.status,onTitleChange])
  const act=async(command:HubCommand)=>{setBusy(true);setError('');try{await window.yan.hub.command(command);await refresh();return true}catch(e){setError(e instanceof Error?e.message:String(e));return false}finally{setBusy(false)}}
  const create=async()=>{setBusy(true);setError('');try{
    if(mode==='readonly'){
      const result=await window.yan.subagents.start(prompt,undefined,'controlled-cwd')
      if(!result.ok||!result.run)throw new Error(result.error||'无法启动只读任务')
      await loadSubagents();openRun(`subagent:${result.run.id}`)
    }else{
      const request={agent,projectId,mode,prompt,parentSessionId:sessionProject===projectId?sessionId:undefined}
      const signature=JSON.stringify(request)
      if(createId.current?.signature!==signature)createId.current={id:crypto.randomUUID(),signature}
      const result=await window.yan.hub.command({action:'create',request:{...request,requestId:createId.current!.id}}) as {taskId:string}
      createId.current=undefined
      await refresh();openRun(`hub:${result.taskId}`)
    }
    setCreating(false);setPrompt('')
  }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  if(details&&task)return <AgentHubPanel key={task.id} initialTaskId={task.id} onBack={()=>setDetails(false)}/>
  if(managerOnly)return <AgentHubHome snapshot={snapshot} runs={runs} sessionProject={sessionProject} onOpenRun={openRun} onRefresh={refresh}/>
  return <section className="agent-workspace" data-testid="agent-workspace">
    {!onlyRun ? <div className="agent-workspace-bar">
      <div className="ui-tabs agent-run-tabs" role="tablist" aria-label="Agent 运行">{runs.filter(run=>opened.includes(run.key)).map(run=><Tab key={run.key} selected={run.key===selected?.key} icon={run.terminal?'terminal':'agent'} title={`${run.title} · ${AGENT_STATUS[run.status]??run.status}`} onClick={()=>{setActive(run.key);setList(false);setMessages(false)}} onClose={()=>{setOpened(ids=>ids.filter(id=>id!==run.key));if(active===run.key)setActive('')}} closeLabel={`隐藏 ${run.title}`}><span>{run.agent}</span>{run.live?<span aria-label="运行中">·</span>:null}</Tab>)}</div>
      <IconButton size="sm" icon="plus" label="添加 Agent" onClick={()=>setCreating(!creating)}/>
      <IconButton size="sm" icon="checklist" label="运行列表" onClick={()=>setList(!list)}/>
      {selected?<IconButton size="sm" icon="menu" label="运行操作与协作记录" onClick={()=>setMessages(!messages)}/>:null}
      {onExpand?<IconButton size="sm" icon="maximize" label={expanded?'还原工作区':'展开工作区'} onClick={onExpand}/>:null}
      <IconButton size="sm" icon="close" label="隐藏 Agent 面板" onClick={onBack}/>
    </div> : null}
    {onlyRun && selected ? <div className="agent-message-caption" data-testid="agent-run-strip"><span className="spacer"/>{task&&!task.parentSessionId&&sessionId&&sessionProject===task.projectId&&selected.live?<Button size="sm" variant="ghost" disabled={busy} title="关联后，这个运行的结果会回报到当前主会话" onClick={()=>void act({action:'link-session',taskId:task.id,sessionId})}>关联主会话</Button>:null}{taskMessages.length?<IconButton size="sm" icon="message-dots" label={queuedMessages?`消息记录（${queuedMessages} 条待发送）`:'消息记录'} onClick={()=>setMessages(!messages)}/>:null}{selected.live?<IconButton size="sm" icon="stop" label="停止运行" disabled={busy} onClick={()=>task?void act({action:'cancel',taskId:task.id}):void useStore.getState().stopSubagent(selected.id)}/>:null}{task&&task.workspace&&!task.inPlace&&!task.workspaceRemoved&&!selected.live&&task.status!=='uncertain'?<Button size="sm" variant="ghost" disabled={busy} title="删除这次运行的独立工作区；冻结的补丁与报告保留" onClick={()=>void act({action:'remove-workspace',taskId:task.id})}>清理工作区</Button>:null}{task?<IconButton size="sm" icon="check-circle" label="审批与成果" onClick={()=>setDetails(true)}/>:null}</div> : null}
    {error?<p className="agent-workspace-error" role="alert">{error}</p>:null}
    {creating?<form className="agent-create" onSubmit={e=>{e.preventDefault();void create()}}>
      <div className="hub-row"><Select aria-label="项目" value={projectId} onChange={e=>setProjectId(e.target.value)}>{snapshot?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select><Select aria-label="Agent" value={agent} disabled={mode==='readonly'} onChange={e=>setAgent(e.target.value as HubAgent)}>{snapshot?.adapters.map(a=><option key={a.agent} value={a.agent} disabled={!a.available}>{a.agent}{a.available?'':' · 未安装'}</option>)}</Select></div>
      <Select aria-label="执行方式" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="terminal">打开原生终端</option><option value="managed">派出子任务</option><option value="readonly">pi 只读任务</option></Select>
      <Textarea aria-label="任务内容" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder={mode==='terminal'?'初始指令，可留空':'给 Agent 一个明确任务'}/>
      <div className="hub-row"><Button type="submit" variant="primary" disabled={busy||!projectId||(mode!=='terminal'&&!prompt.trim())||(mode==='readonly'&&projectId!==sessionProject)}>{mode==='terminal'?'打开终端':'派活'}</Button><Button onClick={()=>setCreating(false)}>取消</Button></div>
    </form>:null}
    {list?<div className="agent-run-list">{runs.map(run=><ListRow key={run.key} current={run.key===selected?.key} onClick={()=>openRun(run.key)}><span>{run.title}</span><Badge tone={run.attention?'warn':'neutral'}>{run.agent} · {AGENT_STATUS[run.status]??run.status}</Badge></ListRow>)}</div>:null}
    {messages&&selected&&task?<div className="agent-collaboration">
      <div className="agent-collab-head"><strong className="agent-collab-title">消息记录</strong>{task.parentSessionId?<span className="ui-badge accent">已关联主会话</span>:null}</div>
      {taskMessages.map(m=><div key={m.id} className="agent-message"><div className="agent-message-meta"><span>{m.parentSessionId?'回报主会话':m.fromTaskId?'Agent 消息':'你'}</span><span className={`ui-badge ${m.delivery==='failed'?'err':m.delivery==='queued'?'warn':''}`}>{m.delivery==='queued'?'等待发送':m.delivery==='typed'?'已写入终端':m.delivery==='injected'?'协议已接收':'投递失败'}</span></div><pre>{m.text}</pre>{m.delivery==='queued'&&m.packet&&task.mode==='terminal'?<Button size="sm" disabled={busy||task.inputOwner!=='desktop'||m.toRunId!==task.runId} onClick={()=>{if(window.confirm('请确认终端正等待输入且输入行没有未发送内容。现在粘贴此消息并回车？'))void act({action:'deliver-message',messageId:m.id,epoch:task.inputEpoch??0})}}>核对输入后发送</Button>:null}</div>)}
    </div>:null}
    {!managerOnly ? <div className="agent-run-surface">
      {task?.status==='uncertain'?<div className="agent-ended ui-card" role="status" data-testid="agent-uncertain">
        <strong>结果待核实</strong>
        <p className="agent-ended-text">{task.error||'没有收到正式的完成确认。'}</p>
        <p className="agent-ended-text">终端和受管进程退出时，砚无法判断任务是否做完。请先核对工作区或终端里的实际结果，再选择：</p>
        <div className="agent-ended-actions">
          <Button size="sm" variant="primary" icon="check-circle" disabled={busy} title="固定成果并转为待审阅；这不等于验收" onClick={()=>void act({action:'resolve',taskId:task.id,outcome:'executed'})}>确认执行已结束</Button>
          {task.mode==='terminal'
            ?<><Button size="sm" disabled={busy||!task.workspace||task.workspaceRemoved} title="在原工作区重新打开 CLI，并接着上次的对话" onClick={()=>void act({action:'resume',taskId:task.id})}>接着上次对话</Button>
              <Button size="sm" variant="ghost" disabled={busy||!task.workspace||task.workspaceRemoved} title="在原工作区用原指令重新开始一个对话" onClick={()=>void act({action:'resume',taskId:task.id,fresh:true})}>新开一个</Button></>
            :<Button size="sm" disabled={busy||!task.workspace||task.workspaceRemoved} title="用原外部会话重新打开" onClick={()=>void act({action:'resume',taskId:task.id})}>重新运行</Button>}
          <Button size="sm" variant="ghost" disabled={busy} title="只清除提醒，不表示任务完成" onClick={()=>void act({action:'resolve',taskId:task.id,outcome:'dismiss'})}>忽略</Button>
        </div>
      </div>:null}
      {task&&task.mode==='terminal'&&task.status!=='uncertain'&&!selected?.live&&['needs_review','cancelled','failed'].includes(task.status)&&task.workspace&&!task.workspaceRemoved?<div className="agent-ended-actions agent-resume-bar" data-testid="agent-resume">
        <span className="agent-ended-text">终端已结束</span>
        <Button size="sm" disabled={busy} onClick={()=>void act({action:'resume',taskId:task.id})}>接着上次对话</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void act({action:'resume',taskId:task.id,fresh:true})}>新开一个</Button>
      </div>:null}
      {task&&task.mode==='terminal'&&!task.terminalId&&['queued','preparing'].includes(task.status)?<div className="agent-launching" role="status" data-testid="agent-launching"><span className="ui-status live"><i className="ui-status-dot"/>正在启动 {agentName(task.agent)}…</span></div>:task?.terminalId?<HubTerminal task={task} onError={setError} onRefresh={refresh}/>:task?<AgentRunChat task={task} tasks={snapshot?.tasks??[]} messages={snapshot?.messages??[]} approvals={snapshot?.approvals??[]} busy={busy} act={act} onDetails={()=>setDetails(true)}/>:legacy?<AgentMessageStream run={legacy}/>:<EmptyState icon="agent" title="Agent 协作">添加 Agent，或从主对话打开派出的子任务。</EmptyState>}
    </div> : null}
  </section>
}
