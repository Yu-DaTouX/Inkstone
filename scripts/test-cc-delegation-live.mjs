/** Exact-model opt-in test: a real Haiku parent invokes a real Haiku child through yan. */
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises'
import { tmpdir,homedir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
if(!process.argv.includes('--real-haiku'))throw new Error('Requires --real-haiku')
const plugin=process.env.YAN_CC_TEST_BRIDGE;if(!plugin)throw new Error('Set YAN_CC_TEST_BRIDGE to installed bridge package root')
const root=await mkdtemp(join(tmpdir(),'inkstone-haiku55-delegate-')),pi=join(root,'pi'),cwd=join(root,'files'),data=join(root,'data')
for(const d of [pi,cwd,data])await mkdir(d)
Object.assign(process.env,{YAN_PI_DIR:pi,YAN_DATA_DIR:data,PI_CODING_AGENT_DIR:pi,CLAUDE_BRIDGE_DEBUG:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'})
for(const key of Object.keys(process.env))if(/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDECODE$|^ELECTRON_RUN_AS_NODE$/.test(key))delete process.env[key]
const cli=join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js')
await writeFile(join(data,'desktop.json'),JSON.stringify({cwd,piBin:cli,permissionMode:'danger',codemodeEnabled:false}))
await writeFile(join(pi,'auth.json'),'{}')
await writeFile(join(pi,'settings.json'),JSON.stringify({packages:[plugin],defaultProvider:'claude-bridge',defaultModel:'claude-haiku-5-5',defaultThinkingLevel:'low',compaction:{enabled:false}}))
await writeFile(join(pi,'claude-bridge.json'),JSON.stringify({startupNoticeShown:'2026-10-08',askClaude:{enabled:false},provider:{plan:'pro',strictMcpConfig:true,longContextExtraUsage:false,pathToClaudeCodeExecutable:process.env.YAN_CC_TEST_EXECUTABLE||join(homedir(),'.local/bin/claude.exe')}}))
await writeFile(join(cwd,'input.txt'),'CHILD-HAIKU55-LOW')
await build({stdin:{contents:`export { AgentController } from './src/main/agent'; export { SubagentService } from './src/main/subagent-service'; export { createSubagentNotifier } from './src/main/subagent-notify';`,resolveDir:resolve('.')},outfile:resolve('out/test/cc-delegation.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'unused-electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{constructor(){throw new Error('not in this test')}};export const session={fromPartition(){throw new Error('not in this test')}};`,loader:'js'}))}}]})
const {AgentController,SubagentService,createSubagentNotifier}=await import(pathToFileURL(resolve('out/test/cc-delegation.mjs')))
let parent,finished,delivered=0;const frames=[]
const notify=createSubagentNotifier({enabled:()=>true,find:run=>run.parentRunId==='haiku-parent'?{send:async(...args)=>{delivered++;return parent.send(...args)}}:null})
const service=new SubagentService({guardExtension:()=>resolve('resources/pi-extensions/danger-guard.js'),shellExtension:()=>resolve('resources/pi-extensions/shell-fallback.js'),confirmDanger:async()=>false,onChange:()=>{},onRemove:()=>{},resolveAgentProfile:async()=>({profile:'auto',activity:'answer',revision:0}),onFinished:run=>{finished=run;notify(run)}})
parent=new AgentController({cwd,piBin:cli,push:event=>frames.push(event),subagentHost:service.capabilityHost,dangerGuardExtension:resolve('resources/pi-extensions/danger-guard.js'),shellFallbackExtension:resolve('resources/pi-extensions/shell-fallback.js'),getPermissionMode:async()=> 'danger',confirmDanger:async()=>null,capability:{sessionId:'haiku-parent',projectId:'haiku-project',opsDir:join(root,'ops'),binDir:join(root,'bin'),artifactDir:join(root,'artifacts'),devResourcesDir:resolve('resources')}})
parent.maybeGenerateTitle=async()=>null
async function waitFor(test,ms=90000){const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timeout: '+JSON.stringify({children:service.current()?.list(),parent:parent.getState()}))}
try {
 console.log('Root '+root)
 assert.equal((await parent.start()).ok,true)
 assert.equal(parent.getState().model.id,'claude-haiku-5-5');assert.equal(parent.getState().thinkingLevel,'low')
 const task="Read input.txt using read. Return its exact contents as your entire final answer. Do nothing else."
 const command=`yan subagent start --task '${task}' --model 'claude-bridge/claude-haiku-5-5'`
 assert.equal((await parent.send(`Use the powershell tool to run this exact command once: ${command}\nDo not do the child's task yourself. After launching reply WAITING. The host will send the child result automatically; do not poll or sleep. When the child result arrives, reply exactly PARENT-RECEIVED- followed by the child's answer.`)).ok,true)
 await waitFor(()=>finished)
 assert.equal(finished.status,'done',JSON.stringify(finished));assert.equal(finished.thinkingLevel,'low');assert(finished.model.includes('claude-haiku-5-5'));assert.equal(delivered,1)
 let messages
 await waitFor(async()=>{messages=(await parent.rpc.command('get_messages')).data;return JSON.stringify((messages?.messages??messages??[]).filter(m=>m.role==='assistant')).includes('PARENT-RECEIVED-CHILD-HAIKU55-LOW')})
 assert.equal(service.current().list().length,1)
 await writeFile(join(root,'receipt.json'),JSON.stringify({parentModel:parent.getState().model,thinking:parent.getState().thinkingLevel,child:finished,delivered,messages},null,2))
 console.log('PASS: real parent Haiku 5.5 low calls yan, SubagentService starts selected Haiku 5.5 low, real child reads file, correct parent receives notice and produces PARENT-RECEIVED-CHILD-HAIKU55-LOW')
 console.log('Receipt '+join(root,'receipt.json'))
}finally {await parent.stop();await service.current()?.stopAll();await writeFile(join(root,'events.json'),JSON.stringify(frames,null,2))}
