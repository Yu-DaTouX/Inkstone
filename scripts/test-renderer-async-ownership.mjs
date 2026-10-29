import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve('.tmp/full-audit-fixes/renderer')
await mkdir(output, { recursive: true })
const storage = new Map()
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }
globalThis.document = { documentElement: { lang: 'zh-CN' }, addEventListener() {}, querySelector: () => null, hasFocus: () => true }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' }, yan: {} }
await build({ entryPoints: ['src/renderer/src/state/store.ts'], outfile: resolve(output, 'store.mjs'), bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent', define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' } })
const { useStore } = await import(pathToFileURL(resolve(output, 'store.mjs')).href + '?' + Date.now())
const get = useStore.getState
const initial = get()
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const session = id => ({ sessionId: id, sessionFile: id, cwd: 'C:/fixture', isAgentRunning: false })
const view = id => useStore.setState({ session: session(id), peekedPath: null, peekedSessionId: null, attachments: [], runners: [], activeRunnerId: null })
const reset = () => { useStore.setState(initial, true); view('A') }
const file = { id: 'f', name: 'note', kind: 'file', path: 'C:/fixture/note', data: '', preview: '', size: 1, mimeType: 'text/plain' }
const results = []
async function test(name, fn) { try { reset(); await fn(); results.push({ name, ok: true }) } catch (error) { results.push({ name, ok: false, error: String(error) }) } }
await test('describeFiles completes in original draft', async () => {
  const wait = deferred()
  window.yan.describeFiles = () => wait.promise
  const pending = get().addFileRefPaths([file.path])
  view('B')
  wait.resolve([{ ...file, ok: true }])
  await pending
  assert.equal(get().attachments.length, 0)
  assert.equal(get().sessionRuntimes.A.draftAttachments[0].path, file.path)
})
await test('image picker retains original session for source registration', async () => {
  const wait = deferred(); const owners = []
  window.yan.pickImages = () => wait.promise
  window.yan.sources = { addImage: async item => owners.push(item.sessionId) }
  const pending = get().pickImages(); view('B')
  wait.resolve([{ ...file, id: 'image', kind: 'image', path: undefined, data: 'AAAA' }])
  await pending
  assert.equal(get().attachments.length, 0)
  assert.deepEqual(owners, ['A'])
})
await test('pending success clears original object across view switch and blocks double release', async () => {
  const wait = deferred(); let calls = 0
  useStore.setState({ pendingSends: [{ id: 'p', sessionId: 'A', text: 'task' }], send: async () => { calls++; return wait.promise } })
  const first = get().releaseSend('p', 'followUp')
  const second = get().releaseSend('p', 'steer')
  view('B'); wait.resolve(true); await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(get().pendingSends.length, 0)
})
await test('bootstrap cannot replace a newer state or message push while settings wait', async () => {
  const wait = deferred()
  window.yan = { getSettings: () => wait.promise, getState: async () => session('A'), getMessages: async () => [{ id: 'old', role: 'user', text: 'old' }], getStats: async () => null, refreshTodos: async () => [], cachedTitles: async () => ({}), manualTitles: async () => ({}), browser: { getState: async () => ({ open: false }) }, piInfo: async () => null, pendingApprovals: async () => [], appUpdate: { status: async () => ({}) } }
  for (const name of ['refreshSessions', 'reloadModels', 'loadZoom', 'reloadCommands', 'loadSubagents', 'syncRunners']) useStore.setState({ [name]: async () => {} })
  const pending = get().bootstrap()
  await Promise.resolve()
  get().applyPush({ ch: 'state', payload: { ...session('A'), isAgentRunning: true } })
  get().applyPush({ ch: 'msg-add', payload: { id: 'new', role: 'assistant', text: 'new' } })
  wait.resolve({}); await pending
  assert.equal(get().session.isAgentRunning, true)
  assert.deepEqual(get().messages.map(m => m.id), ['old', 'new'])
})
const report = JSON.stringify(results, null, 2)
console.log(report)
await writeFile(resolve(output, process.env.RENDERER_BASELINE ? 'baseline.json' : 'regression.json'), report + '\n')
if (results.some(result => !result.ok)) process.exitCode = 1
