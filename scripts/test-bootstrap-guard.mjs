#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const output = resolve('.tmp/bootstrap-guard')
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
const { useStore } = await import(pathToFileURL(resolve(output, 'store.mjs')).href + '?' + Date.now())
const get = useStore.getState
const initial = get()
const deferred = () => {
  let resolveFn
  let rejectFn
  const promise = new Promise((a, b) => { resolveFn = a; rejectFn = b })
  return { promise, resolve: resolveFn, reject: rejectFn }
}
const session = (id) => ({ sessionId: id, sessionFile: id, cwd: 'C:/fixture', isAgentRunning: false })
const fakeApi = (overrides) => ({
  getSettings: async () => ({}),
  getState: async () => session('A'),
  getMessages: async () => [],
  getStats: async () => null,
  refreshTodos: async () => [],
  cachedTitles: async () => ({}),
  manualTitles: async () => ({}),
  browser: { getState: async () => ({ open: false }) },
  piInfo: async () => null,
  pendingApprovals: async () => [],
  appUpdate: { status: async () => ({}) },
  resyncView: async () => undefined,
  pendingUiRequests: async () => [],
  ...overrides
})

const results = []
async function test(name, fn) {
  try {
    useStore.setState(initial, true)
    for (const key of ['refreshSessions', 'reloadModels', 'loadZoom', 'reloadCommands', 'loadSubagents', 'syncRunners']) useStore.setState({ [key]: async () => {} })
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) })
  }
}

await test('rejected critical request releases the boot gate', async () => {
  const wait = deferred()
  let resyncs = 0
  window.yan = fakeApi({ getMessages: () => wait.promise, resyncView: async () => { resyncs += 1 } })
  const pending = get().bootstrap()
  const caught = pending.then(() => null, (error) => error)
  await Promise.resolve()
  wait.reject(new Error('getMessages down'))
  const error = await caught
  assert.equal(String(error?.message), 'getMessages down')
  get().applyPush({ ch: 'tool', payload: { msgId: 'missing', call: { id: 'c1' } } })
  await new Promise((r) => setTimeout(r, 450))
  assert.equal(resyncs, 1, '闸门清除后缺失目标的推送可以触发视图重同步')
})

await test('rejection leaves no stale push flags for the next bootstrap', async () => {
  window.yan = fakeApi({ getState: async () => { throw new Error('down') } })
  await get().bootstrap().catch(() => undefined)
  get().applyPush({ ch: 'msg-add', payload: { id: 'x', role: 'assistant', text: 'x' } })
  window.yan = fakeApi({ getMessages: async () => [{ id: 'fresh', role: 'user', text: 'fresh' }] })
  useStore.setState({ messages: [] })
  await get().bootstrap()
  assert.deepEqual(get().messages.map((m) => m.id), ['fresh'])
})

await test('same-id fetched snapshot is kept over the earlier push, current-only messages are appended', async () => {
  const wait = deferred()
  window.yan = fakeApi({
    getSettings: () => wait.promise,
    getMessages: async () => [
      { id: 'm1', role: 'user', text: 'hi' },
      { id: 'm2', role: 'assistant', text: 'snapshot full text' }
    ]
  })
  const pending = get().bootstrap()
  await Promise.resolve()
  get().applyPush({ ch: 'msg-add', payload: { id: 'm2', role: 'assistant', text: 'older push' } })
  get().applyPush({ ch: 'msg-add', payload: { id: 'm3', role: 'assistant', text: 'extra' } })
  wait.resolve({})
  await pending
  assert.deepEqual(get().messages.map((m) => m.id), ['m1', 'm2', 'm3'])
  assert.equal(get().messages[1].text, 'snapshot full text')
})

await test('without a push the fetched list replaces current messages', async () => {
  window.yan = fakeApi({ getMessages: async () => [{ id: 'fresh', role: 'user', text: 'fresh' }] })
  useStore.setState({ messages: [{ id: 'stale', role: 'user', text: 'stale' }] })
  await get().bootstrap()
  assert.deepEqual(get().messages.map((m) => m.id), ['fresh'])
})

await test('an older bootstrap rejecting does not clear the gate of a newer bootstrap', async () => {
  const first = deferred()
  const second = deferred()
  window.yan = fakeApi({ getSettings: () => first.promise })
  const p1 = get().bootstrap().then(() => null, (error) => error)
  await Promise.resolve()
  window.yan = fakeApi({ getSettings: () => second.promise })
  const p2 = get().bootstrap()
  await Promise.resolve()
  first.reject(new Error('first down'))
  assert.equal(String((await p1)?.message), 'first down')
  get().applyPush({ ch: 'state', payload: { ...session('A'), isAgentRunning: true } })
  second.resolve({})
  await p2
  assert.equal(get().session.isAgentRunning, true, '较新 bootstrap 的闸门仍在，推送的状态不被请求结果覆盖')
})

console.log(JSON.stringify(results, null, 2))
const failed = results.filter((item) => !item.ok).length
console.log(`test-bootstrap-guard: ${results.length - failed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
