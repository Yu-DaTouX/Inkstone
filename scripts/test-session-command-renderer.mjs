import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve('.tmp/session-command-target/renderer')
await mkdir(output, { recursive: true })
const storage = new Map()
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) }
globalThis.document = { documentElement: { lang: 'zh-CN' }, addEventListener() {}, querySelector: () => null, hasFocus: () => true }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' }, yan: {} }
const copied = []
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { copied.push(text) } } }, configurable: true })

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
const results = []
async function test(name, fn) {
  try {
    useStore.setState(initial, true)
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: String(error) })
    console.log(`  ✗ ${name}：${error instanceof Error ? error.message : error}`)
  }
}
const deferred = () => {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolveFn, rejectFn) => { resolvePromise = resolveFn; rejectPromise = rejectFn })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
const runner = (id, sessionId, generation) => ({ id, runId: id, sessionId, sessionFile: sessionId, generation, cwd: 'C:/fixture' })
const view = (sessionId, runners, activeRunnerId) => {
  useStore.setState({
    session: { sessionId, sessionFile: sessionId, cwd: 'C:/fixture', isAgentRunning: true },
    peekedPath: null,
    peekedSessionId: null,
    runners,
    activeRunnerId,
    messages: [{ id: `${sessionId}-m`, role: 'assistant', text: `local-${sessionId}` }]
  })
}

const aborts = []
const texts = []
window.yan.abortBash = async (expected) => { aborts.push(expected) }
window.yan.lastAssistantText = async (expected) => { texts.push(expected); return `pi-${expected.runId}` }
useStore.setState({ syncRunners: async () => {} })

console.log('▌中止 bash 带上渲染端视图的 owner')
await test('活动实例与视图一致时传 runId + generation', async () => {
  view('A', [runner('r1', 'A', 5)], 'r1')
  await get().abortBash()
  assert.equal(aborts.length, 1)
  assert.equal(aborts[0].runId, 'r1')
  assert.equal(aborts[0].generation, 5)
})

await test('视图切到没有运行实例的会话时不回退到活动实例', async () => {
  aborts.length = 0
  view('B', [runner('r1', 'A', 5)], 'r1')
  await get().abortBash()
  assert.equal(aborts.length, 0, '不应调用活动实例的 abortBash')
})

await test('等待同步期间视图被切走则不发中止', async () => {
  aborts.length = 0
  const wait = deferred()
  view('A', [runner('r1', 'A', 5)], 'r1')
  useStore.setState({ syncRunners: () => wait.promise })
  const pending = get().abortBash()
  await Promise.resolve()
  view('B', [runner('r1', 'A', 5)], 'r1')
  wait.resolve()
  await pending
  assert.equal(aborts.length, 0)
})

console.log('▌复制末条回复只读视图 owner，拿不到时用本视图消息')
await test('有运行实例时把 owner 传给宿主', async () => {
  texts.length = 0
  copied.length = 0
  view('A', [runner('r1', 'A', 5)], 'r1')
  await get().copyLastReply()
  assert.equal(texts.length, 1)
  assert.equal(texts[0].runId, 'r1')
  assert.equal(texts[0].generation, 5)
  assert.deepEqual(copied, ['pi-r1'])
})

await test('没有该视图的运行实例时读本视图消息，不读活动实例', async () => {
  texts.length = 0
  copied.length = 0
  view('B', [runner('r1', 'A', 5)], 'r1')
  await get().copyLastReply()
  assert.equal(texts.length, 0, '不应读取活动实例')
  assert.deepEqual(copied, ['local-B'])
})

await test('runner 换代后按新代次取，不沿用旧代次', async () => {
  texts.length = 0
  copied.length = 0
  view('A', [runner('r1', 'A', 6)], 'r1')
  await get().copyLastReply()
  assert.equal(texts.length, 1)
  assert.equal(texts[0].generation, 6)
})

console.log('▌重试停止只作用于视图 owner')
await test('abortRetry 带视图 owner', async () => {
  const retries = []
  window.yan.abortRetry = async (expected) => { retries.push(expected); return { ok: true } }
  view('A', [runner('r1', 'A', 5)], 'r1')
  await get().abortRetry()
  assert.equal(retries.length, 1)
  assert.equal(retries[0].runId, 'r1')
  assert.equal(retries[0].generation, 5)
})

await test('视图没有运行实例时不停止活动实例的重试', async () => {
  const retries = []
  window.yan.abortRetry = async (expected) => { retries.push(expected); return { ok: true } }
  view('B', [runner('r1', 'A', 5)], 'r1')
  await get().abortRetry()
  assert.equal(retries.length, 0)
})

console.log(`会话命令渲染端 owner：${results.filter((item) => item.ok).length}/${results.length} 通过`)
if (results.some((item) => !item.ok)) process.exit(1)
