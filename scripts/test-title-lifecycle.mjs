import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      api.onLoad({ filter: /^title$/, namespace: 'fixture' }, () => ({ contents: 'export const generateTitle=(o)=>{(globalThis.__titleCalls ??= []).push(o); return globalThis.__titleFixture.promise}; export const fallbackTitle=async(id,text)=>{(globalThis.__fallbackCalls ??= []).push([id,text]); return text ? { title: "截断:"+text } : null}; export const manualTitleOf=async()=>undefined; export const cachedTitles=async()=>({}); export const setManualTitle=async()=>({ok:true});', loader: 'js' }))
      api.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths', namespace: 'fixture' }))
      api.onLoad({ filter: /^paths$/, namespace: 'fixture' }, () => ({ contents: `export const YAN_DIR=${JSON.stringify(root)}; export const PI_AGENT_DIR=${JSON.stringify(root)}; `, loader: 'js' }))
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
  {
    const { agent, calls } = makeAgent()
    agent.state.sessionName = '外部改过的名字'
    globalThis.__titleFixture = { promise: Promise.resolve({ title: '不该写入' }) }
    assert.equal(await agent.maybeGenerateTitle(), null)
    assert.deepEqual(calls, [], '已有名字的会话不再自动生成标题')
  }
  {
    const { agent, pushes } = makeAgent()
    const calls = []
    agent.rpc = {
      command: async command => {
        calls.push(command)
        return command === 'get_state' ? { success: true, data: { sessionName: '生成期间被改名' } } : { success: true }
      },
      close: async () => {}
    }
    globalThis.__titleFixture = { promise: Promise.resolve({ title: '迟到的自动标题' }) }
    assert.equal(await agent.maybeGenerateTitle(), null)
    assert.deepEqual(calls, ['get_state'], '写入前重读到外部名字时放弃写入')
    assert.equal(pushes.some(event => event.ch === 'session-title'), false)
  }
  const firstSend = () => {
    const { agent, pushes, calls } = makeAgent()
    agent.messages = []
    agent.queueRun = work => work()
    agent.claimExecutionAdmission = () => ({ ok: true })
    agent.settleExecutionAdmission = () => {}
    agent.releaseExecutionAdmission = () => {}
    agent.submitQueueCommand = async () => { calls.push('prompt'); return { success: true } }
    agent.refreshState = async () => {}
    agent.rpc.command = async command => { calls.push(command); return command === 'get_state' ? { success: true, data: {} } : { success: true } }
    globalThis.__titleCalls = []
    globalThis.__fallbackCalls = []
    return { agent, pushes, calls }
  }
  {
    const { agent, pushes, calls } = firstSend()
    const title = deferred()
    globalThis.__titleFixture = title
    assert.deepEqual(await agent.send('修复登录页的空指针'), { ok: true }, '标题请求未返回时首条消息照常发出')
    assert.deepEqual(calls, ['prompt'], '发送不等标题')
    assert.deepEqual(globalThis.__titleCalls.map(call => call.samples), [['修复登录页的空指针']], '首条消息发出时就用它并行请求标题')
    title.resolve({ title: '修复登录空指针' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['prompt', 'get_state', 'set_session_name'], '标题返回后写入前仍重读会话名')
    assert.equal(pushes.find(event => event.ch === 'session-title')?.payload.title, '修复登录空指针')
    agent.state.sessionName = '修复登录空指针'
    assert.equal(await agent.maybeGenerateTitle(), null)
    assert.equal(globalThis.__titleCalls.length, 1, '回合结束时标题已生成，不再发第二次标题请求')
  }
  {
    const { agent, pushes } = firstSend()
    globalThis.__titleFixture = { promise: Promise.resolve(null) }
    const result = await agent.maybeGenerateTitle({ prompt: { text: '请把导出改成 CSV 格式并补测试' } })
    assert.equal(result, '截断:请把导出改成 CSV 格式并补测试', '标题请求失败时回退到首条消息截断')
    assert.deepEqual(globalThis.__fallbackCalls, [['s1', '请把导出改成 CSV 格式并补测试']])
    assert.equal(pushes.find(event => event.ch === 'session-title')?.payload.title, result)
  }
  {
    const { agent } = firstSend()
    agent.messages = [{ id: 'm0', role: 'user', text: '已有消息', timestamp: 1 }]
    globalThis.__titleFixture = { promise: Promise.resolve(null) }
    assert.equal(await agent.maybeGenerateTitle(), null, '回合结束时的自动标题失败不截断回退')
    assert.deepEqual(globalThis.__fallbackCalls, [])
    globalThis.__titleCalls = []
    await agent.send('第二条消息')
    assert.deepEqual(globalThis.__titleCalls, [], '已有用户消息时发送不触发标题请求')
  }
  {
    const { agent } = firstSend()
    agent.state.sessionName = '用户手动起的名字'
    globalThis.__titleFixture = { promise: Promise.resolve({ title: '不该写入' }) }
    await agent.send('首条消息')
    assert.deepEqual(globalThis.__titleCalls, [], '已有会话名时首条消息不触发标题请求')
  }
  {
    const { agent, pushes } = firstSend()
    agent.rpc.command = async command => command === 'get_state' ? { success: true, data: { sessionName: '生成期间手动改名' } } : { success: true }
    globalThis.__titleFixture = { promise: Promise.resolve(null) }
    assert.equal(await agent.maybeGenerateTitle({ prompt: { text: '首条消息' } }), null, '回退标题同样不覆盖生成期间的手动改名')
    assert.equal(pushes.some(event => event.ch === 'session-title'), false)
  }
  const titleSource = await readFile(new URL('../src/main/title.ts', import.meta.url), 'utf8')
  assert.match(titleSource, /'--no-extensions',[\s\S]*'--no-tools',/, '标题请求不带默认工具定义')
  console.log('title-lifecycle: 31 assertions passed (stop等待期间、实例替换、正常返回、外部名字不覆盖、首条消息并行生成、失败截断回退、无工具定义)')
} finally {
  delete globalThis.__titleFixture
  await rm(root, { recursive: true, force: true })
}
