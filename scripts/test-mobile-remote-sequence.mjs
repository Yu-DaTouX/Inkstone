import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { startFakeDesktop } from './mobile-render/fake-desktop.mjs'
import { reportSkip } from './lib/test-skip.mjs'

const load = async (contents) => {
  const built = await build({ stdin: { contents, resolveDir: '.', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}
const { RemoteClient, RemoteHttpError, pair } = await load(`export { RemoteClient, RemoteHttpError, pair } from './mobile/src/api/client'`).catch((error) => {
  const errors = error?.errors ?? []
  const missing = errors.map((item) => /^Could not resolve "([^./][^"]*)"/.exec(item.text)?.[1]).filter(Boolean)
  if (!errors.length || missing.length !== errors.length) throw error
  const message = `手机端远程调用序列：mobile/ 的依赖没有安装（${[...new Set(missing)].join('、')}），先在 mobile/ 运行 npm ci`
  if (process.env.CI) throw new Error(message)
  reportSkip(`${message}，跳过`)
  process.exit(0)
})
const { capabilityAllowed } = await load(`export { capabilityAllowed } from './src/shared/capability-negotiation'`)

const calls = []
const state = { running: false, branch: 'main', sessions: [
  { id: 's-1', title: '第一个会话', cwdName: 'repo', updatedAt: 1, messageCount: 2 },
  { id: 's-2', title: '要删除的会话', cwdName: 'repo', updatedAt: 2, messageCount: 1 }
] }
const models = [{ id: 'm-a', provider: 'p', name: 'Model A' }, { id: 'm-b', provider: 'p', name: 'Model B' }]
let currentModel = models[0]
let pending = false
const fail = (status, error) => ({ ok: false, status, error })

const handlers = {
  async snapshot() { return { sessions: state.sessions, projects: [] } },
  async history(sessionId, limit) { return { ok: true, data: { sessionId, messages: [{ id: 'm1', role: 'user', text: '你好' }], total: 1 } } },
  async models() { return { ok: true, data: { models, current: currentModel, thinking: { level: 'low', levels: ['off', 'low', 'high'] }, pending } } },
  async insight(sessionId) {
    calls.push(['insight', sessionId])
    return { ok: true, data: { stats: { tokens: 1234, cost: 0.5, toolCalls: 3, messages: 2, context: { percent: 40, tokens: 40000, window: 100000 } }, changes: { branch: state.branch, added: 3, removed: 1, total: 1, files: [{ path: 'a.ts', status: 'M', added: 3, removed: 1 }], truncated: false } } }
  },
  async compact(sessionId) { calls.push(['compact', sessionId]); return state.running ? fail(409, '运行中不能压缩') : { ok: true, data: { sessionId } } },
  async sessionFlags(sessionId, flags) { calls.push(['flags', sessionId, flags]); return { ok: true, data: flags } },
  async branches(sessionId) { calls.push(['branches', sessionId]); return { ok: true, data: { repo: true, current: state.branch, branches: [{ name: 'main', current: state.branch === 'main' }, { name: 'dev', current: state.branch === 'dev' }, { name: 'wt', current: false, busy: true }] } } },
  async switchBranch(sessionId, branch) {
    calls.push(['switchBranch', sessionId, branch])
    if (state.running) return fail(409, '会话运行中，不能切换分支')
    if (branch === 'conflict') return fail(409, '有未提交的改动会被覆盖')
    state.branch = branch
    return { ok: true, data: { branch } }
  },
  async search(query) { calls.push(['search', query]); return { ok: true, data: { hits: query === '无' ? [] : [{ sessionId: 's-1', snippet: `…${query}…`, matches: 2 }] } } },
  async deleteSession(sessionId) {
    calls.push(['delete', sessionId])
    if (sessionId === 's-1') return fail(409, '当前使用中的会话不能删除')
    state.sessions = state.sessions.filter((s) => s.id !== sessionId)
    return { ok: true, data: { sessionId } }
  },
  async command(command) {
    calls.push(['command', command.action])
    if (command.action === 'model') {
      currentModel = models.find((m) => m.id === command.modelId)
      pending = state.running
      return { ok: true, data: { current: currentModel, pending } }
    }
    return { ok: true, data: {} }
  }
}

const desk = await startFakeDesktop({ tweak: (served) => {
  for (const key of Object.keys(served)) delete served[key]
  Object.assign(served, handlers)
} })
const baseUrl = desk.baseUrl

await assert.rejects(pair(baseUrl, desk.startPairing(), '测试手机'), (err) => err instanceof RemoteHttpError && err.code === 'identity_confirm_required', '手输地址配对不带身份核对回调时拒绝')
await assert.rejects(pair(baseUrl, desk.startPairing(), '测试手机', async () => false), (err) => err instanceof RemoteHttpError && err.code === 'identity_not_confirmed', '没确认电脑身份就不配对')
assert.equal((await desk.devices.list()).length, 0, '没确认身份时不登记设备')
let confirmed = null
const connection = await pair(baseUrl, desk.startPairing(), '测试手机', async (identity) => {
  confirmed = identity
  return true
})
assert.ok(confirmed?.fingerprint, '配对前拿到电脑身份指纹给用户核对')
assert.match(connection.baseUrl, /^relay:\/\//, '手输地址配对改走加密通道')
const client = new RemoteClient(connection)

const caps = await client.info()
for (const name of ['insight', 'compact', 'branches', 'search', 'session-flags', 'session-delete', 'models']) {
  assert.ok(capabilityAllowed(caps, name), `能力 ${name} 对手机可用`)
}
assert.equal((await client.sessions()).length, 2, '取会话列表')
assert.equal((await client.history('s-1')).messages[0].text, '你好')

const insight = await client.insight('s-1')
assert.equal(insight.stats.context.window, 100000)
assert.equal(insight.changes.files[0].path, 'a.ts')

let listed = await client.models('s-1')
assert.equal(listed.current.id, 'm-a')
assert.equal(listed.pending, false)
state.running = true
assert.equal((await client.setModel('s-1', models[1])).id, 'm-b', '运行中可以切模型')
listed = await client.models('s-1')
assert.equal(listed.current.id, 'm-b')
assert.equal(listed.pending, true, '运行中切换后 pending 标记为真')
state.running = false

const delays = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest) }
await client.compact('s-1')
await client.switchBranch('s-1', 'main')
await client.insight('s-1')
globalThis.setTimeout = realSetTimeout
assert.ok(delays.includes(180_000), '压缩请求的超时放宽到 180 秒（压缩要等模型写摘要）')
assert.ok(delays.includes(60_000), '切分支请求的超时放宽到 60 秒')
assert.ok(delays.includes(20_000), '经加密通道的普通请求保持默认 20 秒')
state.running = true
await assert.rejects(client.compact('s-1'), (err) => err instanceof RemoteHttpError && err.status === 409 && /运行中/.test(err.message), '运行中压缩返回 409 与原文')
await assert.rejects(client.switchBranch('s-1', 'dev'), (err) => err.status === 409)
state.running = false

const before = await client.branches('s-1')
assert.deepEqual(before.branches.map((b) => b.name), ['main', 'dev', 'wt'])
assert.equal(before.branches[2].busy, true)
await assert.rejects(client.switchBranch('s-1', 'conflict'), (err) => err.status === 409 && /未提交/.test(err.message))
await client.switchBranch('s-1', 'dev')
assert.equal((await client.branches('s-1')).current, 'dev')
assert.equal((await client.insight('s-1')).changes.branch, 'dev', '切换后 insight 里的分支同步')

assert.equal((await client.search('关键词'))[0].snippet, '…关键词…')
assert.deepEqual(await client.search('无'), [])
assert.deepEqual(await client.search('a&b=c 空 格'), [{ sessionId: 's-1', snippet: '…a&b=c 空 格…', matches: 2 }], '查询里的特殊字符被转义')
assert.equal(calls.at(-1)[1], 'a&b=c 空 格')

await client.setSessionFlags('s-1', { pinned: true })
await client.setSessionFlags('s-1', { archived: true, pinned: false })
assert.deepEqual(calls.filter((c) => c[0] === 'flags').map((c) => c[2]), [{ pinned: true }, { archived: true, pinned: false }])

await assert.rejects(client.deleteSession('s-1'), (err) => err.status === 409 && /使用中/.test(err.message), '删除当前使用中的会话返回 409')
await client.deleteSession('s-2')
assert.deepEqual((await client.sessions()).map((s) => s.id), ['s-1'])

const raw = await fetch(`${baseUrl}/remote/v1/sessions/s-2/delete`, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: '{}' })
assert.equal(raw.status, 400, '没有 confirm 的删除被拒')
assert.equal(calls.filter((c) => c[0] === 'delete').length, 2, '被拒的删除没有到达处理器')

await client.revokeSelf()
for (const attempt of [() => client.sessions(), () => client.insight('s-1'), () => client.compact('s-1'), () => client.deleteSession('s-2'), () => client.search('x')]) {
  await assert.rejects(attempt(), (err) => err instanceof RemoteHttpError && err.status === 401, '撤销后的请求被拒')
}
const sideEffects = calls.length
await assert.rejects(client.setSessionFlags('s-1', { pinned: true }), (err) => err.status === 401)
assert.equal(calls.length, sideEffects, '撤销后的请求没有到达处理器')

await desk.stop()
console.log('test-mobile-remote-sequence ok')
