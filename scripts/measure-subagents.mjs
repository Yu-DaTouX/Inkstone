/** Formal subagent concurrency benchmark. Real CC is opt-in, exact Haiku 5.5 low. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises'
import { tmpdir,homedir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { sampleProcessTree, remainingProcessIds } from './lib/process-sample.mjs'
const real=process.argv.includes('--real-haiku'),plugin=process.env.YAN_CC_TEST_BRIDGE
if(real&&!plugin)throw Error('Set YAN_CC_TEST_BRIDGE to installed package; --real-haiku spends subscription quota')
const root=await mkdtemp(join(tmpdir(),'inkstone-subagent-perf-')),pi=join(root,'pi'),data=join(root,'data')
await mkdir(pi);await mkdir(data)
const evidence=resolve(process.env.YAN_MEASURE_OUT||`.local-docs/evidence/subagent-perf-${real?'cc':'local'}-${Date.now()}.json`)
Object.assign(process.env,{YAN_PI_DIR:pi,YAN_DATA_DIR:data,PI_CODING_AGENT_DIR:pi,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'0'})
for(const key of Object.keys(process.env))if(/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDECODE$/.test(key))delete process.env[key]
let ctrl;const held=[]
const server=createServer((req,res)=>{req.resume();req.on('end',()=>{held.push(res)})})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const wait=async test=>{const end=Date.now()+60000;while(Date.now()<end){if(test())return;await new Promise(r=>setTimeout(r,20))}throw Error('Benchmark timeout')}
try {
 await writeFile(join(pi,'auth.json'),'{}');await writeFile(join(data,'desktop.json'),'{"permissionMode":"danger"}')
 await writeFile(join(pi,'settings.json'),JSON.stringify({packages:real?[plugin]:[],defaultProvider:real?'claude-bridge':'fixture',defaultModel:real?'claude-haiku-5-5':'model',defaultThinkingLevel:'low',compaction:{enabled:false}}))
 if(real)await writeFile(join(pi,'claude-bridge.json'),JSON.stringify({startupNoticeShown:'2026-10-08',askClaude:{enabled:false},provider:{plan:'pro',strictMcpConfig:true,longContextExtraUsage:false,pathToClaudeCodeExecutable:process.env.YAN_CC_TEST_EXECUTABLE||join(homedir(),'.local/bin/claude.exe')}}))
 else await writeFile(join(pi,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'local',models:[{id:'model',name:'model',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048}]}}}))
 await writeFile(join(root,'input.txt'),'PERF-CC-LOW\n'+'measure subscription child process overhead. '.repeat(40))
 await build({entryPoints:['src/main/subagents.ts'],outfile:resolve('out/test/subagent-perf.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'})
 const {SubagentController}=await import(pathToFileURL(resolve('out/test/subagent-perf.mjs')))
 const rows=[]
 for(const concurrency of [1,2])for(let run=1;run<=(real?1:3);run++) {
  const finished=[];held.length=0
  ctrl=new SubagentController({cwd:root,piBin:join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js'),archiveDir:join(root,'archive'),parentSessionId:'perf-parent',parentRunId:'perf-run',projectId:'perf-project',extensions:[resolve('resources/pi-extensions/danger-guard.js')],onChange:()=>{},onFinished:r=>finished.push(r),confirmDanger:async()=>false})
  const before=sampleProcessTree(process.pid),started=performance.now()
  const launched=await Promise.all(Array.from({length:concurrency},()=>ctrl.start(real?'Read input.txt and return its exact full contents, with no additional text.':'Return LOCAL-CONCURRENCY-RESULT.',real?'claude-bridge/claude-haiku-5-5':'fixture/model','shared-cwd')))
  assert(launched.every(r=>r.ok),JSON.stringify(launched))
  if(!real)await wait(()=>held.length===concurrency)
  const readyMs=performance.now()-started,active=sampleProcessTree(process.pid)
  const samples=[active]
  if(!real)for(const res of held){res.writeHead(200,{'content-type':'text/event-stream'});const chunk=(delta,finish_reason=null)=>({id:'perf',object:'chat.completion.chunk',created:0,model:'model',choices:[{index:0,delta,finish_reason}]});res.end(`data: ${JSON.stringify(chunk({role:'assistant',content:'LOCAL-CONCURRENCY-RESULT'}))}\n\ndata: ${JSON.stringify(chunk({},'stop'))}\n\ndata: [DONE]\n\n`)}
  if(real) {
    const deadline=Date.now()+60000
    while(finished.length<concurrency) {
      if(Date.now()>deadline)throw Error('Real CC benchmark timeout')
      await new Promise(r=>setTimeout(r,100))
      if(finished.length<concurrency)samples.push(sampleProcessTree(process.pid))
    }
  } else await wait(()=>finished.length===concurrency)
  const totalMs=performance.now()-started
  assert(finished.every(r=>r.status==='done'&&r.thinkingLevel==='low'),JSON.stringify(finished))
  assert(finished.every(r=>JSON.stringify(r.transcript).includes(real?'PERF-CC-LOW':'LOCAL-CONCURRENCY-RESULT')))
  await ctrl.stopAll();await new Promise(r=>setTimeout(r,300))
  const after=sampleProcessTree(process.pid)
  const baselineIds=new Set(before.processSamples.map(p=>p.pid))
  const sampledChildIds=[...new Set(samples.flatMap(s=>s.processSamples.map(p=>p.pid)).filter(id=>!baselineIds.has(id)))]
  const remainingSampledChildren=remainingProcessIds(sampledChildIds)
  const sampledPeak=samples.reduce((a,b)=>b.workingSetMiB>a.workingSetMiB?b:a)
  const row={concurrency,run,launchReadyMs:readyMs,totalMs,before,active,after,samples,sampledPeak,remainingSampledChildren,incrementalWorkingSetMiB:sampledPeak.workingSetMiB-before.workingSetMiB,incrementalPrivateMiB:sampledPeak.privateMiB-before.privateMiB,completed:finished.length,models:finished.map(r=>r.model)}
  rows.push(row);console.log(JSON.stringify({concurrency,run,launchReadyMs:readyMs,totalMs,processes:active.count,workingSetDeltaMiB:row.incrementalWorkingSetMiB,remainingDescendants:after.count-before.count}))
  assert.equal(after.count,before.count,'subagent/CC descendants must exit after cleanup; excludes existing esbuild/sampler baseline')
  assert.deepEqual(remainingSampledChildren,[],'sampled children must exit even if reparented')
 }
 await mkdir(resolve(evidence,'..'),{recursive:true})
 await writeFile(evidence,JSON.stringify({platform:process.platform,scenario:real?'CC exact Haiku 5.5 low; one run each at concurrency 1 and 2; process-tree sampling until completion; sampled peak may miss short spikes':'real pi with barrier-controlled loopback model; 3 runs each at concurrency 1 and 2; excludes real inference latency',notes:'Host included in tree; deltas subtract idle host; sampler process and descendants excluded; shared pages may be counted more than once; model timings include synchronous process sampling overhead; no baseline speedup claim',rows},null,2))
 console.log('PASS '+evidence)
}finally{await ctrl?.stopAll();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
