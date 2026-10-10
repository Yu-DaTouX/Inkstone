/** Opt-in, small Claude subscription test. Never selects a fallback model. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises'
import { tmpdir,homedir } from 'node:os'
import { join,resolve } from 'node:path'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
if(!process.argv.includes('--real-haiku')) throw new Error('Real subscription calls require --real-haiku')
const root=await mkdtemp(join(tmpdir(),'inkstone-haiku55-')), pi=join(root,'pi'), cwd=join(root,'files')
await mkdir(pi);await mkdir(cwd)
const pluginRoot=process.env.YAN_CC_TEST_BRIDGE;if(!pluginRoot)throw new Error('Set YAN_CC_TEST_BRIDGE to installed bridge package root')
const plugin=join(pluginRoot,'src/index.ts')
const cli=join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js')
await writeFile(join(pi,'auth.json'),'{}')
await writeFile(join(pi,'settings.json'),JSON.stringify({packages:[],defaultProvider:'claude-bridge',defaultModel:'claude-haiku-5-5',defaultThinkingLevel:'low',compaction:{enabled:false}}))
await writeFile(join(pi,'claude-bridge.json'),JSON.stringify({startupNoticeShown:'2026-10-08',askClaude:{enabled:false},provider:{plan:'pro',longContextExtraUsage:false,strictMcpConfig:true,pathToClaudeCodeExecutable:process.env.YAN_CC_TEST_EXECUTABLE||join(homedir(),'.local/bin/claude.exe')}}))
await writeFile(join(cwd,'input.txt'),'INKSTONE-HAIKU55-LOW')
const env={...process.env,PI_CODING_AGENT_DIR:pi,YAN_PI_DIR:pi,YAN_DATA_DIR:join(root,'data'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'0',CLAUDE_BRIDGE_DEBUG:'1'}
for(const key of Object.keys(env))if(/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDECODE$|^ELECTRON_RUN_AS_NODE$/.test(key))delete env[key]
const launch = session => spawn(process.execPath,[cli,'--mode','rpc','--no-extensions','--extension',plugin,'--no-skills','--tools','read,write','--provider','claude-bridge','--model','claude-haiku-5-5','--thinking','low','--session-dir',join(root,'sessions'),...(session?['--session',session]:[])],{cwd,env,windowsHide:true,stdio:'pipe'})
let child=launch()
let buffer='',stderr='',sequence=0;const frames=[],pending=new Map()
function listen() {
child.stdout.on('data',part=>{buffer+=part;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;try{const f=JSON.parse(line);frames.push(f);if(f.type==='response'){pending.get(f.id)?.(f);pending.delete(f.id)}}catch{}}})
child.stderr.on('data',part=>stderr+=part)
}
listen()
async function command(type,params={}){const id=String(++sequence);return await new Promise((done,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+type+' '+stderr.slice(-500)))},30000);pending.set(id,f=>{clearTimeout(timer);done(f)});child.stdin.write(JSON.stringify({id,type,...params})+'\n')})}
async function waitFor(test,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await new Promise(r=>setTimeout(r,30))}throw new Error('Timeout; '+stderr.slice(-1500))}
try {
 const state=await command('get_state');assert.equal(state.data?.model?.id,'claude-haiku-5-5',JSON.stringify(state));assert.equal(state.data.thinkingLevel,'low')
 console.log('Preflight: pi 1.1.0; exact claude-bridge/claude-haiku-5-5; thinking low; tools read/write; no API credentials; root '+root)
 if(process.argv.includes('--preflight-only')){console.log('PASS preflight only; no inference');process.exitCode=0}
 else {
  const before=frames.length
  assert.equal((await command('prompt',{message:'Read input.txt using the read tool. Write its exact contents to output.txt using the write tool. Then reply exactly READY. Do nothing else.'})).success,true)
  await waitFor(()=>frames.slice(before).some(f=>f.type==='agent_settled'))
  await waitFor(()=>frames.slice(before).some(f=>f.type==='message_end'&&f.message?.role==='assistant'))
  const current=await command('get_state');const messages=await command('get_messages')
  assert.equal(await readFile(join(cwd,'output.txt'),'utf8'),'INKSTONE-HAIKU55-LOW')
  assert(JSON.stringify(messages).includes('READY'),JSON.stringify(messages).slice(-1800))
  assert(!JSON.stringify(messages).includes('"stopReason":"error"'),JSON.stringify(messages).slice(-1800))
  const tools=frames.filter(f=>f.type==='tool_execution_end').map(f=>({tool:f.toolName,isError:f.isError}))
  assert(tools.length>=2);assert(tools.every(t=>!t.isError))
  const debug=await readFile(join(pi,'claude-bridge.log'),'utf8');assert(debug.includes('model=claude-haiku-5-5'));assert(debug.includes('effort=low'))
  const receipt={model:current.data.model.id,provider:current.data.model.provider,thinking:current.data.thinkingLevel,tools,sessionFile:current.data.sessionFile,root,reply:'READY',messages:messages.data}
  await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2))
  console.log('PASS real subscription file task: '+JSON.stringify({model:receipt.model,thinking:receipt.thinking,tools,receipt:join(root,'receipt.json')}))
  if(process.argv.includes('--recovery')) {
   // Kill only this isolated RPC after its persisted turn; do not replay any prior tool.
   const exited = new Promise(done=>child.once('exit',done));child.kill();await exited
   buffer='';child=launch(current.data.sessionFile);listen()
   const restored=await command('get_state');assert.equal(restored.data.sessionId,current.data.sessionId)
   assert.equal(restored.data.model.id,'claude-haiku-5-5');assert.equal(restored.data.thinkingLevel,'low')
   assert(JSON.stringify(await command('get_messages')).includes('READY'))
   const afterRestart=frames.length
   await command('prompt',{message:'Without using tools, reply exactly RECOVERED followed by the exact text you previously read from input.txt.'})
   await waitFor(()=>frames.slice(afterRestart).some(f=>f.type==='agent_settled'))
   const recovered=await command('get_messages');const history=recovered.data.messages??recovered.data;const last=history.filter(m=>m.role==='assistant').at(-1);assert(JSON.stringify(last).includes('RECOVERED'));assert(JSON.stringify(last).includes('INKSTONE-HAIKU55-LOW'));assert.notEqual(last.stopReason,'error')
   assert.equal(frames.slice(afterRestart).filter(f=>f.type==='tool_execution_end').length,0,'recovery must not replay file tools')
   await writeFile(join(root,'recovery.json'),JSON.stringify({restored:restored.data,messages:recovered.data},null,2))
   console.log('PASS: isolated RPC killed, same persisted CC session/model/low restored; real follow-up recalls prior task without replaying tools')
  }
 }
}finally {child.stdin.end();child.kill();await writeFile(join(root,'rpc-frames.json'),JSON.stringify(frames,null,2));await writeFile(join(root,'stderr.log'),stderr)}
