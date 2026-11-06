import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const load = async (contents) => {
  const built = await build({ stdin: { contents, resolveDir: '.', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}
const { RemoteServer, RemoteDeviceStore } = await load(`export { RemoteServer } from './src/main/remote-server'; export { RemoteDeviceStore } from './src/main/remote-devices'`)
const { RemoteClient, RemoteHttpError, pair } = await load(`export { RemoteClient, RemoteHttpError, pair } from './mobile/src/api/client'`)
const { capabilityAllowed } = await load(`export { capabilityAllowed } from './src/shared/capability-negotiation'`)

const dir = await mkdtemp(join(tmpdir(), 'yan-mobile-seq-'))
const devices = new RemoteDeviceStore(dir)
const calls = []
const state = { running: false, branch: 'main', sessions: [
  { id: 's-1', title: '第一个会话', cwdName: 'repo', updatedAt: 1, messageCount: 2 },
  { id: 's-2', title: '要删除的会话', cwdName: 'repo', updatedAt: 2, messageCount: 1 }
] }
const models = [{ id: 'm-a', provider: 'p', name: 'Model A' }, { id: 'm-b', provider: 'p', name: 'Model B' }]
let currentModel = models[0]
let pending = false
const fail = (status, error) => ({ ok: false, status, error })

const server = new RemoteServer({
  host: '127.0.0.1',
  port: 0,
  devices,
  handlers: {
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
})

const info = await server.start()
const baseUrl = `http://127.0.0.1:${info.port}`
const pairing = devices.startPairing()
const connection = await pair(baseUrl, pairing.code, '测试手机')
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

await client.compact('s-1')
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

await server.stop()
await rm(dir, { recursive: true, force: true })
console.log('test-mobile-remote-sequence ok')
