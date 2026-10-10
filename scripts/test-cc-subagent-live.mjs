/** Opt-in subscription child test: exact Haiku 5.5 low, no fallback. */
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises'
import { tmpdir,homedir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
if(!process.argv.includes('--real-haiku'))throw new Error('Requires --real-haiku')
const plugin=process.env.YAN_CC_TEST_BRIDGE;if(!plugin)throw new Error('Set YAN_CC_TEST_BRIDGE to installed pi-claude-bridge package root')
const root=await mkdtemp(join(tmpdir(),'inkstone-haiku55-child-')),pi=join(root,'pi'),cwd=join(root,'files'),data=join(root,'data')
for(const d of [pi,cwd,data])await mkdir(d)
Object.assign(process.env,{YAN_PI_DIR:pi,YAN_DATA_DIR:data,PI_CODING_AGENT_DIR:pi,CLAUDE_BRIDGE_DEBUG:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'})
for(const key of Object.keys(process.env))if(/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDECODE$|^ELECTRON_RUN_AS_NODE$/.test(key))delete process.env[key]
await writeFile(join(pi,'auth.json'),'{}');await writeFile(join(data,'desktop.json'),'{"permissionMode":"danger"}')
await writeFile(join(pi,'settings.json'),JSON.stringify({packages:[plugin],defaultProvider:'claude-bridge',defaultModel:'claude-haiku-5-5',defaultThinkingLevel:'low',compaction:{enabled:false}}))
await writeFile(join(pi,'claude-bridge.json'),JSON.stringify({startupNoticeShown:'2026-10-08',askClaude:{enabled:false},provider:{plan:'pro',strictMcpConfig:true,longContextExtraUsage:false,pathToClaudeCodeExecutable:process.env.YAN_CC_TEST_EXECUTABLE||join(homedir(),'.local/bin/claude.exe')}}))
await writeFile(join(cwd,'input.txt'),'CHILD-HAIKU55-LOW')
await build({entryPoints:['src/main/subagents.ts','src/main/subagent-notify.ts'],outdir:resolve('out/test/cc-subagent'),bundle:true,packages:'external',platform:'node',format:'esm',outExtension:{'.js':'.mjs'},logLevel:'silent'})
const {SubagentController}=await import(pathToFileURL(resolve('out/test/cc-subagent/subagents.mjs')))
const {createSubagentNotifier}=await import(pathToFileURL(resolve('out/test/cc-subagent/subagent-notify.mjs')))
let finished;const notices=[]
const notify=createSubagentNotifier({enabled:()=>true,find:run=>run.parentSessionId==='real-cc-parent'?{send:async(text,_images,mode)=>{notices.push({text,mode});return {ok:true}}}:null})
const ctrl=new SubagentController({cwd,piBin:join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js'),archiveDir:join(root,'archive'),parentSessionId:'real-cc-parent',parentRunId:'real-cc-parent-run',projectId:'real-cc-test',extensions:[resolve('resources/pi-extensions/danger-guard.js'),resolve('resources/pi-extensions/shell-fallback.js')],appendSystemPrompt:'You are a subagent working on one focused task. Keep to the task and return a concise result.',confirmDanger:async()=>false,onChange:()=>{},onFinished:run=>{finished=run;notify(run)}})
async function waitFor(test,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await new Promise(r=>setTimeout(r,40))}throw new Error('Timeout: '+JSON.stringify(ctrl.list()))}
try {
 console.log('Root '+root)
 const start=await ctrl.start('Read input.txt. Return its exact contents as your entire final answer. Do nothing else.','claude-bridge/claude-haiku-5-5','shared-cwd')
 assert(start.ok,start.error);assert.equal(start.run.thinkingLevel,'low')
 await waitFor(()=>finished);assert.equal(finished.status,'done',JSON.stringify(finished))
 assert(JSON.stringify(finished.transcript).includes('CHILD-HAIKU55-LOW'))
 await waitFor(()=>notices.length===1);assert(notices[0].text.includes('CHILD-HAIKU55-LOW'));assert.equal(notices[0].mode,'followUp')
 assert.equal(finished.parentSessionId,'real-cc-parent');assert(finished.model.includes('claude-haiku-5-5'))
 console.log('PASS: real CC subagent, exact Haiku 5.5 low, non-Git read, result and followUp delivered to correct parent')
 const cancelled=await ctrl.start('Reply exactly CANCEL-TEST.','claude-bridge/claude-haiku-5-5','shared-cwd');assert(cancelled.ok,cancelled.error)
 assert.equal((await ctrl.stop(cancelled.run.id)).ok,true)
 assert.equal(ctrl.get(cancelled.run.id).status,'cancelled');assert.equal(ctrl.get(cancelled.run.id).endReason,'stopped')
 await new Promise(r=>setTimeout(r,200));assert.equal(notices.length,1,'cancel does not wake parent with another model call')
 console.log('PASS: stop sends abort, closes child, records cancelled/stopped, no completion followUp for cancelled run')
 const debug=await readFile(join(pi,'claude-bridge.log'),'utf8');assert(debug.includes('model=claude-haiku-5-5'));assert(debug.includes('effort=low'))
 await writeFile(join(root,'receipt.json'),JSON.stringify({runs:ctrl.list(),notices},null,2));console.log('Receipt '+join(root,'receipt.json'))
}finally {await ctrl.stopAll()}
