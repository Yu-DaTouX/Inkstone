#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const output = resolve('.tmp/pending-sends-keep')
await mkdir(output, { recursive: true })
const storage = new Map()
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) }
globalThis.document = { documentElement: { lang: 'zh-CN' }, addEventListener() {}, querySelector: () => null, hasFocus: () => true }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' }, yan: {} }
await build({
  entryPoints: ['src/renderer/src/state/store.ts'],
  outfile: resolve(output, 'store.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' }
})
const { useStore, pendingSendsForView } = await import(pathToFileURL(resolve(output, 'store.mjs')).href + '?' + Date.now())
const get = useStore.getState
const initial = get()

const session = (id) => ({ sessionId: id, sessionFile: `C:/fixture/${id}.jsonl`, cwd: 'C:/fixture', isAgentRunning: false })
const runner = (id) => ({ id: `run-${id}`, runId: `run-${id}`, sessionId: id, sessionFile: `C:/fixture/${id}.jsonl`, generation: 1, isActive: true })
const viewSession = (id) => useStore.setState({ session: session(id), peekedPath: null, peekedSessionId: null })
const image = { data: 'AAAA', mimeType: 'image/png' }

const results = []
async function test(name, fn) {
  try {
    useStore.setState(initial, true)
    viewSession('A')
    useStore.setState({
      runners: [runner('A')],
      activeRunnerId: 'run-A',
      ensureActivated: async () => true,
      syncRunners: async () => {},
      refreshSessions: async () => {},
      reloadModels: async () => {},
      reloadCommands: async () => {}
    })
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) })
  }
}

function holdInA() {
  get().holdSend('压缩期间的草稿', [image])
  get().holdSend('第二条', undefined)
  assert.equal(pendingSendsForView(get()).length, 2)
}

function assertStillInA() {
  viewSession('A')
  const kept = pendingSendsForView(get())
  assert.deepEqual(kept.map((item) => item.text), ['压缩期间的草稿', '第二条'])
  assert.deepEqual(kept[0].images, [image])
  assert.equal(kept[0].sessionId, 'A')
}

async function assertReleaseAndDiscardInA() {
  const sent = []
  useStore.setState({ send: async (text, images, mode) => { sent.push([text, images, mode]); return true } })
  const [first, second] = pendingSendsForView(get())
  await get().releaseSend(first.id, 'followUp')
  assert.deepEqual(sent, [['压缩期间的草稿', [image], 'followUp']])
  assert.deepEqual(pendingSendsForView(get()).map((item) => item.text), ['第二条'])
  get().discardSend(second.id)
  assert.equal(get().pendingSends.length, 0)
}

await test('newSession keeps pending sends of other sessions', async () => {
  window.yan = { newSession: async () => ({ ok: true, sessionId: 'N', runId: 'run-N', id: 'run-N' }) }
  holdInA()
  const res = await get().newSession({ scope: 'global' })
  assert.equal(res.ok, true)
  assert.equal(pendingSendsForView(get()).length, 0)
  assert.equal(get().pendingSends.length, 2)
  assertStillInA()
  await assertReleaseAndDiscardInA()
})

await test('fork keeps pending sends of the source session', async () => {
  window.yan = {
    fork: async () => ({ ok: true, text: '' }),
    getState: async () => session('B'),
    getMessages: async () => []
  }
  holdInA()
  const ok = await get().fork('entry-1')
  assert.equal(ok, true)
  assert.equal(get().session.sessionId, 'B')
  assert.equal(pendingSendsForView(get()).length, 0)
  assert.equal(get().pendingSends.length, 2)
  assertStillInA()
  await assertReleaseAndDiscardInA()
})

await test('clone keeps pending sends while the view really moves to B', async () => {
  window.yan = {
    clone: async () => {
      viewSession('B')
      return { ok: true }
    }
  }
  holdInA()
  await get().clone()
  assert.equal(get().session.sessionId, 'B')
  assert.equal(pendingSendsForView(get()).length, 0)
  assert.equal(get().pendingSends.length, 2)
  assertStillInA()
  await assertReleaseAndDiscardInA()
})

await test('failed newSession also keeps pending sends', async () => {
  window.yan = { newSession: async () => ({ ok: false, error: 'boom' }) }
  holdInA()
  await get().newSession({ scope: 'global' })
  assertStillInA()
})

await test('switching view does not release another session pending sends', async () => {
  let sent = 0
  useStore.setState({ send: async () => { sent += 1; return true } })
  holdInA()
  viewSession('B')
  get().applyPush({ ch: 'state', payload: { ...session('B'), compaction: null } })
  assert.equal(sent, 0)
  assert.equal(get().pendingSends.length, 2)
  await get().releaseSend(get().pendingSends[0].id, 'followUp')
  assert.equal(sent, 0, 'B 视图不能释放 A 的条目')
})

await test('release in flight survives a view switch and removes the original item only on success', async () => {
  let resolveSend
  useStore.setState({ send: () => new Promise((r) => { resolveSend = r }) })
  holdInA()
  const [first] = pendingSendsForView(get())
  const flying = get().releaseSend(first.id, 'followUp')
  viewSession('B')
  resolveSend(true)
  await flying
  assert.deepEqual(get().pendingSends.map((item) => item.text), ['第二条'])
})

await test('failed release keeps the item', async () => {
  useStore.setState({ send: async () => false })
  holdInA()
  const [first] = pendingSendsForView(get())
  await get().releaseSend(first.id, 'followUp')
  assert.equal(get().pendingSends.length, 2)
})

const blankView = (runner) => useStore.setState({ session: null, peekedPath: null, peekedSessionId: null, runners: [], activeRunnerId: runner })

await test('blank view items do not leak into the view created by newSession', async () => {
  window.yan = { newSession: async () => ({ ok: true, sessionId: 'N', runId: 'run-N', id: 'run-N' }) }
  blankView('run-0')
  get().holdSend('空白视图的草稿', [image])
  assert.equal(get().pendingSends[0].sessionId, null)
  assert.equal(pendingSendsForView(get()).length, 1)
  const res = await get().newSession({ scope: 'global' })
  assert.equal(res.ok, true)
  assert.equal(get().session, null, '新视图在 snapshot 未到时仍是空白')
  assert.equal(get().activeRunnerId, 'run-N')
  assert.equal(pendingSendsForView(get()).length, 0, '旧空白视图的暂存不出现在新视图')
  assert.equal(get().pendingSends.length, 1, '条目没有丢')
  viewSession('N')
  assert.equal(pendingSendsForView(get()).length, 0, '新会话拿到 sessionId 后也不认领')
  assert.equal(get().pendingSends[0].sessionId, null)
})

await test('blank view items never show in an unrelated blank view and cannot be sent from it', async () => {
  let sent = 0
  useStore.setState({ send: async () => { sent += 1; return true } })
  blankView('run-0')
  get().holdSend('空白视图的草稿')
  const id = get().pendingSends[0].id
  blankView('run-1')
  assert.equal(pendingSendsForView(get()).length, 0)
  await get().releaseSend(id, 'followUp')
  assert.equal(sent, 0)
  blankView(null)
  assert.equal(pendingSendsForView(get()).length, 0)
})

await test('blank view items migrate when the view naturally gets a session (no navigation)', async () => {
  const sent = []
  useStore.setState({ send: async (text, images, mode) => { sent.push([text, images, mode]); return true } })
  blankView('run-0')
  get().holdSend('空白视图的草稿', [image])
  blankView('run-N')
  useStore.setState({ session: session('S0'), activeRunnerId: 'run-0' })
  const kept = pendingSendsForView(get())
  assert.deepEqual(kept.map((item) => item.text), ['空白视图的草稿'])
  assert.equal(get().pendingSends[0].sessionId, 'S0', '归属迁移到新拿到的 sessionId')
  await get().releaseSend(kept[0].id, 'followUp')
  assert.deepEqual(sent, [['空白视图的草稿', [image], 'followUp']])
  assert.equal(get().pendingSends.length, 0)
})

await test('blank view items do not migrate into a reused-runner session after switchSession', async () => {
  window.yan = {
    peekSession: async () => null,
    selectSession: async () => {
      useStore.setState({ session: session('S'), peekedPath: null, peekedSessionId: null })
      return { ok: true, sessionId: 'S', runId: 'run-0', id: 'run-0' }
    }
  }
  blankView('run-0')
  get().holdSend('空白视图的草稿', [image])
  await get().switchSession('C:/fixture/S.jsonl')
  assert.equal(get().session.sessionId, 'S')
  assert.equal(get().activeRunnerId, 'run-0')
  assert.equal(pendingSendsForView(get()).length, 0, '草稿不出现在复用同一 runner 的会话 S')
  assert.equal(get().pendingSends.length, 1, '条目没有丢')
  assert.equal(get().pendingSends[0].sessionId, null)
  let sent = 0
  useStore.setState({ send: async () => { sent += 1; return true } })
  await get().releaseSend(get().pendingSends[0].id, 'followUp')
  assert.equal(sent, 0)
})

await test('blank view items do not migrate after fork/clone/newSession navigation either', async () => {
  window.yan = { clone: async () => ({ ok: true }) }
  blankView('run-0')
  get().holdSend('空白视图的草稿')
  await get().clone().catch(() => undefined)
  useStore.setState({ session: session('S1') })
  assert.equal(pendingSendsForView(get()).length, 0)
  assert.equal(get().pendingSends[0].sessionId, null)
})

await test('natural arrival of the session migrates the blank view item and it can be sent', async () => {
  const sent = []
  useStore.setState({ send: async (text, images, mode) => { sent.push([text, images, mode]); return true } })
  blankView('run-0')
  get().holdSend('首条', [image])
  assert.equal(typeof get().pendingSends[0].navSeq, 'number')
  get().applyPush({ ch: 'state', payload: session('S0') })
  assert.equal(get().pendingSends[0].sessionId, 'S0')
  const [item] = pendingSendsForView(get())
  await get().releaseSend(item.id, 'followUp')
  assert.deepEqual(sent, [['首条', [image], 'followUp']])
})

await test('blank view items can be restored or discarded from the original blank view', async () => {
  blankView('run-0')
  get().holdSend('甲')
  get().holdSend('乙')
  const [first, second] = pendingSendsForView(get())
  get().discardSend(first.id)
  get().restoreSend(second.id)
  assert.equal(get().pendingSends.length, 0)
  assert.equal(get().queueRestore, '乙')
})

console.log(JSON.stringify(results, null, 2))
const failed = results.filter((item) => !item.ok).length
console.log(`test-pending-sends-keep: ${results.length - failed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
