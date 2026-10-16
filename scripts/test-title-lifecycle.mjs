import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-title-lifecycle-'))
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
try {
  const outfile = join(root, 'agent.mjs')
  await build({
    entryPoints: ['src/main/agent.ts'], outfile, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'isolated-title', setup(api) {
      api.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      api.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({ contents: 'export const app={getPath:()=>""}; export class BrowserWindow{}; export const session={};', loader: 'js' }))
      api.onResolve({ filter: /^\.\/title$/ }, () => ({ path: 'title', namespace: 'fixture' }))
      api.onLoad({ filter: /^title$/, namespace: 'fixture' }, () => ({ contents: 'export const generateTitle=()=>globalThis.__titleFixture.promise; export const manualTitleOf=async()=>undefined;', loader: 'js' }))
      api.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths', namespace: 'fixture' }))
      api.onLoad({ filter: /^paths$/, namespace: 'fixture' }, () => ({ contents: `export const YAN_DIR=${JSON.stringify(root)}; export const PI_AGENT_DIR=${JSON.stringify(root)}; export const PROJECT_KNOWLEDGE_ROOT=${JSON.stringify(join(root, 'knowledge'))}; export const projectKnowledgeDir=id=>PROJECT_KNOWLEDGE_ROOT+'/'+id;`, loader: 'js' }))
      api.onResolve({ filter: /^[^./]|^@/ }, args => {
        if (args.namespace === 'fixture' || args.path.startsWith('node:')) return
        return { path: import.meta.resolve(args.path), external: true }
      })
    } }]
  })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  const makeAgent = () => {
    const pushes = [], calls = []
    const agent = new AgentController({ cwd: root, push: event => pushes.push(event) })
    agent.state = { sessionId: 's1', sessionFile: join(root, 's1.jsonl') }
    agent.messages = [{ id: 'm0', role: 'user', text: '标题生命周期', timestamp: 1 }]
    agent.rpc = { command: async command => { calls.push(command); return { success: false } }, close: async () => {} }
    return { agent, pushes, calls }
  }
  {
    const { agent, pushes, calls } = makeAgent()
    const title = deferred(), closing = deferred()
    globalThis.__titleFixture = title
    agent.mcpManager = { close: () => closing.promise }
    const pendingTitle = agent.maybeGenerateTitle({ force: true })
    const pendingStop = agent.stop()
    assert.ok(agent.rpc, 'stop仍在等待资源关闭，不能只靠rpc是否为空守卫')
    title.resolve({ title: '迟到标题' })
    assert.equal(await pendingTitle, null)
    assert.deepEqual(calls, [], '停止开始后不得写session name')
    assert.equal(pushes.some(event => event.ch === 'session-title'), false)
    closing.resolve()
    await pendingStop
  }
  {
    const { agent, pushes, calls } = makeAgent()
    const title = deferred()
    globalThis.__titleFixture = title
    const pending = agent.maybeGenerateTitle({ force: true })
    agent.rpc = { command: async () => ({ success: true }), close: async () => {} }
    title.resolve({ title: '旧实例标题' })
    assert.equal(await pending, null)
    assert.deepEqual(calls, [])
    assert.equal(pushes.some(event => event.ch === 'session-title'), false)
  }
  {
    const { agent, pushes, calls } = makeAgent()
    globalThis.__titleFixture = { promise: Promise.resolve({ title: '正常标题' }) }
    assert.equal(await agent.maybeGenerateTitle({ force: true }), '正常标题')
    assert.deepEqual(calls, ['set_session_name'])
    assert.equal(pushes.find(event => event.ch === 'session-title').payload.title, '正常标题')
  }
  console.log('title-lifecycle: 10 assertions passed (stop等待期间、实例替换、正常返回)')
} finally {
  delete globalThis.__titleFixture
  await rm(root, { recursive: true, force: true })
}
