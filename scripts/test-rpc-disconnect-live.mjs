/** Actual pi stream interrupted, then formal RunnerRegistry reload; local model only. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
const root=await mkdtemp(join(tmpdir(),'inkstone-rpc-disconnect-')),pi=join(root,'pi'),data=join(root,'data')
await mkdir(pi);await mkdir(data)
Object.assign(process.env,{YAN_PI_DIR:pi,YAN_DATA_DIR:data,PI_CODING_AGENT_DIR:pi})
for(const key of Object.keys(process.env))if(/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key))delete process.env[key]
let calls=0,registry
const server=createServer((req,res)=>{let body='';req.on('data',p=>body+=p);req.on('end',()=>{
 calls++;res.writeHead(200,{'content-type':'text/event-stream'})
 const chunk=(delta,finish_reason=null)=>({id:'fixture',object:'chat.completion.chunk',created:0,model:'model',choices:[{index:0,delta,finish_reason}]})
 res.write(`data: ${JSON.stringify(chunk({role:'assistant',content:calls===1?'Interrupted text':'RECOVERED'}))}\n\n`)
 if(calls>1){res.write(`data: ${JSON.stringify(chunk({},'stop'))}\n\ndata: [DONE]\n\n`);res.end()}
})})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const wait=async(test)=>{const end=Date.now()+20000;while(Date.now()<end){if(test())return;await new Promise(r=>setTimeout(r,30))}throw Error('Timeout')}
try {
 await writeFile(join(pi,'settings.json'),JSON.stringify({packages:[],defaultProvider:'fixture',defaultModel:'model',compaction:{enabled:false}}));await writeFile(join(pi,'auth.json'),'{}')
 await writeFile(join(pi,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'local',models:[{id:'model',name:'model',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048}]}}}))
 await build({stdin:{contents:`export {AgentController} from './src/main/agent';export {RunnerRegistry} from './src/main/runners'`,resolveDir:resolve('.')},outfile:resolve('out/test/rpc-disconnect.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'unused-electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`,loader:'js'}))}}]})
 const {AgentController,RunnerRegistry}=await import(pathToFileURL(resolve('out/test/rpc-disconnect.mjs')))
 registry=new RunnerRegistry({createAgent:()=>{const a=new AgentController({cwd:root,piBin:join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js'),push:()=>{}});a.maybeGenerateTitle=async()=>null;return a}})
 const selected=await registry.select({cwd:root,projectId:'fixture'});assert(selected.ok,selected.error)
 const old=registry.active();await old.send('Start interrupted task');await wait(()=>old.getState()?.isStreaming)
 const sessionId=old.getState().sessionId,sessionFile=old.getState().sessionFile
 old.rpc.child.kill();await wait(()=>old.getConn().state==='exited')
 assert.equal(old.getState().isAgentRunning,false);assert.equal(old.getState().isStreaming,false);assert.equal(registry.hasBusy(),false)
 const restarted=await registry.restartOne(selected.id);assert(restarted.ok,restarted.error)
 const current=registry.active();assert.notEqual(current,old);assert.equal(current.getState().sessionId,sessionId);assert.equal(current.getState().sessionFile,sessionFile)
 assert.equal(calls,1,'reload does not replay the interrupted request')
 await current.send('Continue explicitly');await wait(()=>calls===2&&!current.getState().isAgentRunning)
 assert(JSON.stringify(await current.getMessages()).includes('RECOVERED'))
 console.log('PASS: actual pi killed mid-stream releases busy flags; formal reload preserves session, does not replay, explicit next turn succeeds')
}finally{await registry?.stopAll();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
