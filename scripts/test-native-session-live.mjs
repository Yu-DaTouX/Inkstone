import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-native-live-'))
const compiledDir = await mkdtemp(resolve('node_modules/.inkstone-native-live-'))
const before = { ...process.env }
let agent, checks = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ }
try {
  const pi = join(root, 'pi'), data = join(root, 'data'), sessions = join(root, 'sessions')
  for (const path of [pi, data, sessions, join(root, '.pi')]) await mkdir(path)
  await writeFile(join(root, '.pi', 'settings.json'), '{}')
  Object.assign(process.env, { YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_SESSIONS_DIR: sessions })
  for (const key of Object.keys(process.env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete process.env[key]
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: 'one', compaction: { enabled: false } }))
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(pi, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'local-never-used',
    models: ['one','two'].map(id => ({ id, name: id, reasoning: false, input: ['text'], cost: { input:0,output:0,cacheRead:0,cacheWrite:0 }, contextWindow:32000,maxTokens:2048 }))
  } } }))
  const outfile = join(compiledDir, 'agent.mjs')
  await build({ entryPoints:['src/main/agent.ts'], outfile, bundle:true, packages:'external', platform:'node', format:'esm', logLevel:'silent', plugins:[{ name:'unused-electron', setup(b) {
    b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`,loader:'js'}))
  }}] })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  const { exportSessionJsonl, importSessionJsonl } = await import('../out/test/native-session-io.mjs')
  const create = () => new AgentController({ cwd:root, piBin:join(selectedPiRuntime(resolve('resources/pi-runtime')),'dist/bundle/cli.js'), nativeSessionExtension:resolve('resources/pi-extensions/native-session-bridge.js'), push:()=>{} })
  agent = create()
  check((await agent.start()).ok, 'real bundled pi starts with thin bridge')
  const timestamp = new Date().toISOString()
  const user = text => ({ role:'user',content:[{type:'text',text}],timestamp:Date.now() })
  const assistant = text => ({ role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'fixture',model:'one',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now() })
  const header = {type:'session',version:3,id:'native-fixture-session',timestamp,cwd:root}
  const records = [header,...[
    ['u1',null,user('ROOT')], ['a1','u1',assistant('ROOT-ANSWER')],
    ['u2','a1',user('ABANDONED')], ['a2','u2',assistant('ABANDONED-ANSWER')],
    ['u3','a1',user('TAIL-BRANCH')]
  ].map(([id,parentId,message])=>({type:'message',id,parentId,timestamp,message}))]
  const file = join(sessions,'seed.jsonl')
  await writeFile(file,records.map(x=>JSON.stringify(x)).join('\n')+'\n')
  check((await agent.switchSession(file)).ok,'fixture session loads without any model request')
  const tree = await agent.sessionTree()
  const initialSnapshot = await agent.sessionEntries()
  const initialLeaf = initialSnapshot.entries.find(entry => entry.id === tree.leafId)
  check(tree.leafId === 'u3' || initialLeaf?.parentId === 'u3', 'native leaf includes pi metadata appended during restore')
  check((tree.tree ?? []).length>0,'get_tree returns real nodes')
  const navigated = await agent.nativeNavigate('a1')
  check(navigated.ok && !navigated.cancelled,'native navigation succeeds without a summary call')
  equal((await agent.sessionTree()).leafId,'a1','real native leaf changed in memory')
  equal((await agent.getMessages()).filter(m=>m.role==='user').map(m=>m.text),['ROOT'],'desktop chat projects only selected branch')
  const delta = await agent.sessionEntries('u2')
  equal(delta.entries.filter(e=>e.type === 'message').map(e=>e.id),['a2','u3'],'get_entries cursor preserves append order')
  const exported = await exportSessionJsonl({sourcePath:file,outputPath:join(root,'branch.jsonl'),leafId:'a1'})
  check(exported.ok,'live-leaf JSONL export succeeds')
  const exportedText = await readFile(join(root,'branch.jsonl'),'utf8')
  check(!exportedText.includes('ABANDONED')&&!exportedText.includes('TAIL-BRANCH'),'JSONL excludes other branches')
  const imported = await importSessionJsonl({sourcePath:file,sessionDir:sessions,freshSessionId:true})
  check(imported.ok && imported.sessionId !== header.id,'imported copy receives unique desktop identity')
  equal(JSON.parse((await readFile(imported.destinationPath,'utf8')).split('\n')[0]).id,imported.sessionId,'fresh identity persists in copied header')
  await agent.nativeReload()
  check((await agent.nativeScopedModels()).scopedModels.length===0,'native reload completes and fresh bridge still answers')
  await agent.nativeSetScopedModels(['fixture/two'])
  equal(JSON.parse(await readFile(join(pi,'settings.json'),'utf8')).enabledModels,['fixture/two'],'native model scope persisted')
  await agent.nativeSetProjectTrust(true)
  check(Object.values(JSON.parse(await readFile(join(pi,'trust.json'),'utf8'))).includes(true),'canonical trust decision persisted')
  const blocked = await agent.send('/__inkstone_native bad')
  check(!blocked.ok,'internal command rejected by ordinary prompt entry')
  await agent.stop()
  agent = create()
  check((await agent.start()).ok,'new isolated runtime applies saved native settings')
  equal((await agent.nativeScopedModels()).scopedModels.map(m=>m.key),['fixture/two'],'scope becomes effective after runtime recreation')
  check((await agent.nativeProjectTrust()).effectiveTrusted,'new runtime recognizes saved trust')
  console.log(`native-session-live: ${checks} checks passed (real pi, no model/network)`)
} catch (error) {
  console.error(error)
  throw error
} finally {
  await agent?.stop().catch(()=>{})
  for(const key of Object.keys(process.env)) if(!(key in before)) delete process.env[key]
  Object.assign(process.env,before)
  await rm(compiledDir,{recursive:true,force:true})
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(error=>console.warn('fixture cleanup:',error.message))
}
