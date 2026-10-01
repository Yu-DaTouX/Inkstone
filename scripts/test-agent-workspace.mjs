import assert from 'node:assert/strict'
import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const root=await mkdtemp(join(tmpdir(),'inkstone-agent-workspace-'))
await symlink(resolve('node_modules'),join(root,'node_modules'),'junction')
process.env.YAN_DATA_DIR=root;process.env.YAN_PI_DIR=join(root,'pi')
async function module(path,name){const outfile=join(root,name+'.mjs');await build({entryPoints:[path],outfile,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(outfile))}
const {subagentPiArgs}=await module('src/shared/subagent-pi-launch.ts','pi-launch')
const native=subagentPiArgs({sessionDir:join(root,'sessions'),native:true,readOnly:false})
assert(!native.includes('--no-session')&&!native.includes('--no-skills')&&!native.includes('--no-extensions'))
const readOnly=subagentPiArgs({sessionDir:join(root,'read-only'),native:true,readOnly:true})
assert(readOnly.includes('--no-extensions')&&readOnly.includes('--no-skills'))
assert.equal(readOnly[readOnly.indexOf('--tools')+1],'read,grep,find,ls')
const {agentWorkspaceRuns}=await module('src/shared/agent-workspace.ts','view')
const view=agentWorkspaceRuns([{id:'same',title:'terminal',agent:'codex',mode:'terminal',status:'running',createdAt:1}],[{id:'same',task:'pi task',status:'done',review:'pending',startedAt:2},{id:'discarded',review:'discarded'}])
assert.deepEqual(view.map(r=>r.key),['hub:same','subagent:same']);assert.equal(view[1].attention,true)
const {AgentHubService}=await module('src/main/agent-hub/service.ts','service')
const reports=[]
const hub=new AgentHubService({dataDir:join(root,'hub'),piDir:join(root,'pi'),resourcesDir:resolve('resources'),browser:()=>null,projects:async()=>[{id:'project',name:'project',cwd:root}],piBin:async()=>undefined,sessionProject:id=>id==='main-session'?'project':null,sendToSession:async(id,text)=>{reports.push({id,text});return {ok:true}},notifyEnabled:async()=>true})
hub.adapters=[{agent:'codex',available:true,modes:['managed','terminal']}]
hub.launch=async task=>{task.status='running'}
const request=(id,mode='managed')=>({requestId:id,projectId:'project',agent:'codex',mode,prompt:mode==='terminal'?'':'fixture',parentSessionId:'main-session'})
const first=await hub.command({action:'create',request:request('workspace-managed')})
const task=hub.tasks.get(first.taskId),run=hub.live.get(first.taskId)
const reply=await hub.replyToParent(task,run,'result from external','workspace-reply')
const duplicate=await hub.replyToParent(task,run,'result from external','workspace-reply')
assert.equal(reply.messageId,duplicate.messageId);assert.equal(reports.length,1);assert.equal(reports[0].id,'main-session')
const mainContext={cwd:root,parentSessionId:'main-session',parentRunId:'parent-runtime',projectId:'project'}
const owned=await hub.capabilityHost.run('hub.list',{},mainContext)
assert(owned.data.some(t=>t.id===task.id),'UI-linked task is visible to its main agent')
await assert.rejects(hub.capabilityHost.run('hub.send',{toTaskId:task.id,summary:'cross-session',requestId:'workspace-cross'}, {...mainContext,parentSessionId:'other-session'}),/协作范围/)
await assert.rejects(hub.command({action:'link-session',taskId:task.id,sessionId:'other-session'}),/有效主会话/)
const terminalId=(await hub.command({action:'create',request:request('workspace-terminal','terminal')})).taskId
const terminal=hub.tasks.get(terminalId);terminal.terminalId='fixture-pty';terminal.inputOwner='desktop';terminal.inputEpoch=4
const queued=await hub.command({action:'send-packet',toTaskId:terminalId,summary:'do not overwrite input',requestId:'workspace-packet'})
assert.equal(queued.delivery,'queued','terminal input is not injected automatically')
const queuedAgain=await hub.command({action:'send-packet',toTaskId:terminalId,summary:'do not overwrite input',requestId:'workspace-packet'})
assert.equal(queuedAgain.messageId,queued.messageId)
await assert.rejects(hub.command({action:'deliver-message',messageId:queued.messageId,epoch:3}),/输入权/)
await assert.rejects(hub.command({action:'deliver-message',messageId:queued.messageId,epoch:4},'phone:other'),/输入权/)
const original=terminal.runId;terminal.runId='new-attempt'
await assert.rejects(hub.command({action:'deliver-message',messageId:queued.messageId,epoch:4}),/运行已改变/)
terminal.runId=original;delete terminal.terminalId
const protocolId=(await hub.command({action:'create',request:request('workspace-protocol')})).taskId
const protocol=hub.tasks.get(protocolId),protocolRun=hub.live.get(protocolId)
protocol.agent='pi';let calls=0;protocolRun.pi={command:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {success:true}},close:async()=>{}}
await Promise.all([hub.command({action:'send-packet',toTaskId:protocolId,summary:'one turn',requestId:'workspace-once'}),hub.command({action:'send-packet',toTaskId:protocolId,summary:'one turn',requestId:'workspace-once'})])
assert.equal(calls,1,'duplicate concurrent sends must not create two turns')
task.status='needs_review';task.report='finished report'
await hub.notifyFinished(task,run);await hub.notifyFinished(task,run)
assert.equal(reports.length,2,'completion notice is delivered once')
run.stopping=true
await assert.rejects(hub.replyToParent(task,run,'late report','workspace-late'),/失效/)
await hub.shutdown()
const restored=new AgentHubService({dataDir:join(root,'hub'),piDir:join(root,'pi'),resourcesDir:resolve('resources'),browser:()=>null,projects:async()=>[],piBin:async()=>undefined})
assert.equal(restored.tasks.get(task.id).parentSessionId,'main-session')
assert(restored.messages.has(queued.messageId))
console.log('Agent workspace checks passed: native pi/read-only boundary, backend identity projection, main-session association, scoped reply, duplicate delivery, terminal input protection, stale runs, completion notice and persisted records.')
