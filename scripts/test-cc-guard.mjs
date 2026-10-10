/** Actual extension hook, local approval HTTP server; no model or user settings. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import guard from '../resources/pi-extensions/danger-guard.js'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const root = await mkdtemp(join(tmpdir(), 'inkstone-cc-guard-'))
const saved = { ...process.env }; let hook, allowed = false; const requests = []
const server = createServer((req, res) => { let body = ''; req.on('data', p => body += p); req.on('end', () => {
  requests.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok:true,summary:{allowed}}))
}) })
await new Promise(done => server.listen(0, '127.0.0.1', done))
try {
  Object.assign(process.env, {YAN_DATA_DIR:root,PI_CODING_AGENT_DIR:root,YAN_CLI_URL:`http://127.0.0.1:${server.address().port}`,YAN_CLI_TOKEN:'fixture',YAN_SESSION_ID:'cc-session',YAN_PROJECT_ID:'cc-project'})
  delete process.env.YAN_DANGER_GUARD
  await writeFile(join(root,'desktop.json'),'{"permissionMode":"danger"}')
  guard({on:(name, callback) => { if (name === 'tool_call') hook = callback }})
  const call = (toolName, input) => hook({toolName,input},{cwd:root})
  assert.equal((await call('AskClaude',{prompt:'Opaque delegated task',mode:'full'})).block,true)
  assert.deepEqual(JSON.parse(requests[0].params.detail),{prompt:'Opaque delegated task',mode:'full'}); assert(requests[0].params.reasons[0].includes('完整任务'))
  assert.equal((await call('AskClaude',{prompt:'x'.repeat(21000)})).block,true); assert.equal(requests.length,1,'oversized task is not approved with truncated content')
  await call('AskClaude',{prompt:'x'.repeat(3000),model:'haiku'});assert.equal(JSON.parse(requests.at(-1).params.detail).prompt.length,3000)
  allowed = true; assert.equal(await call('AskClaude',{prompt:'Approved task',mode:'read'}),undefined)
  await writeFile(join(root,'claude-bridge.json'),JSON.stringify({askClaude:{name:'MyClaude',defaultMode:'full'}}))
  allowed = false; assert.equal((await call('MyClaude',{prompt:'Custom tool'})).block,true)
  await mkdir(join(root,'.pi')); await writeFile(join(root,'.pi','claude-bridge.json'),JSON.stringify({askClaude:{name:'ProjectClaude'}}))
  assert.equal((await call('ProjectClaude',{prompt:'Project tool'})).block,true)
  const before = requests.length
  await writeFile(join(root,'desktop.json'),'{"permissionMode":"all"}')
  assert.equal(await call('ProjectClaude',{prompt:'Native mode'}),undefined); assert.equal(requests.length,before)
  await writeFile(join(root,'desktop.json'),'{"permissionMode":"danger"}')
  assert.equal(await call('read',{path:'a.txt'}),undefined); assert.equal(requests.length,before)
  delete process.env.YAN_CLI_URL
  assert.equal((await call('ProjectClaude',{prompt:'No host'})).block,true)
  await build({entryPoints:['src/main/agent.ts'],outfile:resolve('out/test/cc-guard-host.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'unused-electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`,loader:'js'}))}}]})
  const {AgentController}=await import(pathToFileURL(resolve('out/test/cc-guard-host.mjs')))
  const reviewed=[];const host=new AgentController({cwd:root,push:()=>{},getPermissionMode:async()=> 'danger',confirmDanger:async input=>{reviewed.push(input);return 'allow'}})
  const detail=JSON.stringify({prompt:'x'.repeat(3000),model:'haiku',mode:'full'})
  assert.equal((await host.runDangerConfirmCommand({tool:'AskClaude',detail,reasons:['Opaque delegation']})).summary.allowed,true)
  assert.equal(reviewed[0].detail,detail,'host preserves the entire delegation, including model and mode')
  assert.equal((await host.runDangerConfirmCommand({tool:'AskClaude',detail:'x'.repeat(21000)})).summary.allowed,false)
  assert.equal(reviewed.length,1,'host must not ask for approval of truncated content')
  console.log('PASS: CC native delegation denied/allowed, full prompt and scope shown, global/project aliases, native bypass, ordinary read, missing host fails closed')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env,saved); await new Promise(done=>server.close(done)); await rm(root,{recursive:true,force:true})
}
