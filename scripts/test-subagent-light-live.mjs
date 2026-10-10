/** Real pi RPC child + loopback model; no account, credentials or user files. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
const root=await mkdtemp(join(tmpdir(),'inkstone-subagent-light-')), pi=join(root,'pi'), cwd=join(root,'files')
await mkdir(pi); await mkdir(cwd)
Object.assign(process.env,{YAN_PI_DIR:pi,YAN_DATA_DIR:join(root,'data'),PI_CODING_AGENT_DIR:pi})
for(const key of Object.keys(process.env)) if(/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete process.env[key]
let ctrl, count=0, approvals=0; const requests=[]
const server=createServer((req,res)=>{let body='';req.on('data',v=>body+=v);req.on('end',()=>{
 const payload=JSON.parse(body);requests.push(payload);count++
 const chunk=(delta,finish_reason=null)=>({id:'fixture',object:'chat.completion.chunk',created:0,model:'child',choices:[{index:0,delta,finish_reason}]})
 res.writeHead(200,{'content-type':'text/event-stream'})
 if(count===1){
  assert.equal(payload.model,'child');assert(payload.tools.some(t=>t.function.name==='write'))
  res.write(`data: ${JSON.stringify(chunk({role:'assistant',tool_calls:[{index:0,id:'write-result',type:'function',function:{name:'write',arguments:JSON.stringify({path:'result.txt',content:'LOCAL-CHILD-RESULT'})}}]}))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({},'tool_calls'))}\n\n`)
 } else if(count===2) {
  res.write(`data: ${JSON.stringify(chunk({role:'assistant',tool_calls:[{index:0,id:'danger-attempt',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'git reset --hard HEAD'})}}]}))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({},'tool_calls'))}\n\n`)
 } else {
  res.write(`data: ${JSON.stringify(chunk({role:'assistant',content:'Child completed the file task.'}))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({},'stop'))}\n\n`)
 }
 res.end('data: [DONE]\n\n')
})})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
try {
 const model=id=>({id,name:id,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048})
 await writeFile(join(pi,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'local-fixture',models:[model('parent'),model('child')]}}}))
 await writeFile(join(pi,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'parent',packages:[]}));await writeFile(join(pi,'auth.json'),'{}')
 await mkdir(join(root,'data'));await writeFile(join(root,'data','desktop.json'),'{"permissionMode":"danger"}')
 const bundle=resolve('out/test/subagent-light-controller.mjs')
 await build({entryPoints:['src/main/subagents.ts'],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'})
 const {SubagentController}=await import(pathToFileURL(bundle))
 let finished
 ctrl=new SubagentController({cwd,onChange:()=>{},piBin:join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js'),archiveDir:join(root,'archive'),parentSessionId:'parent-session',parentRunId:'parent-run',projectId:'fixture-project',extensions:[resolve('resources/pi-extensions/danger-guard.js')],confirmDanger:async()=>{approvals++;return false},onFinished:run=>{finished=run}})
 const started=await ctrl.start('Write the result file and report back.','fixture/child','shared-cwd')
 assert(started.ok,started.error)
 const end=Date.now()+25000
 while(!finished&&Date.now()<end)await new Promise(done=>setTimeout(done,25))
 assert(finished,'child did not finish: '+JSON.stringify(ctrl.list()))
 assert.equal(finished.status,'done',JSON.stringify(finished));assert.equal(finished.model,'fixture/child')
 assert.equal(finished.parentSessionId,'parent-session');assert.equal(finished.parentRunId,'parent-run')
 assert.equal(await readFile(join(cwd,'result.txt'),'utf8'),'LOCAL-CHILD-RESULT')
 assert(JSON.stringify(finished.transcript).includes('Child completed'));assert.equal(finished.isolation,'shared-cwd')
 assert.equal(approvals,1,'child danger guard reached its own approval server');assert(JSON.stringify(requests[2]).includes('拒绝'),'denied tool result returns to child');assert.equal(requests.length,3);assert(requests.every(r=>r.model==='child'))
 await ctrl.stopAll();assert.equal(await readFile(join(cwd,'result.txt'),'utf8'),'LOCAL-CHILD-RESULT')
 console.log('PASS: actual pi RPC child uses explicitly selected model, writes in non-Git folder, returns transcript and parent identity, closes and preserves output; dangerous tool reaches child approval and is denied; three loopback requests, no account')
} finally {await ctrl?.stopAll();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true})}

