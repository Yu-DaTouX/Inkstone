import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const local = new Map()
globalThis.localStorage = { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, v), removeItem: (k) => local.delete(k) }
globalThis.document = { documentElement: { lang: 'zh-CN' }, addEventListener() {}, querySelector: () => null, hasFocus: () => true }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' }, yan: {} }
const outfile = join(await mkdtemp(join(tmpdir(), 'yan-flow-')), 'fixture.mjs')
await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { useStore, pendingSendsForView } from './src/renderer/src/state/store'
  export { useTerminalJobs } from './src/renderer/src/state/terminal-jobs'
  export { answerStopConfirm, stopConfirmSummary } from './src/renderer/src/features/session/stop-with-background'
  export { materializeWorktreeIntent, setWorktreeIntent } from './src/renderer/src/features/composer/worktree-intent'
  export { useQueueAdapter } from './src/renderer/src/t3/adapters/composer-queue'
` }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', alias: { '@/state/store': './src/renderer/src/state/store' }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' }, plugins: [{ name: 'adapter-ports', setup(b) {
  b.onResolve({ filter: /^@\/state\/store$/ }, (a) => a.importer.endsWith('composer-queue.ts') ? { path: 'store-proxy', namespace: 'queue-port' } : undefined)
  b.onResolve({ filter: /^audit-real-store$/ }, () => ({ path: resolve('src/renderer/src/state/store.ts') }))
  b.onResolve({ filter: /^(react|\.\.\/\.\.\/i18n|\.\.\/\.\.\/ui)$/ }, (a) => a.importer.endsWith('composer-queue.ts') ? { path: a.path, namespace: 'queue-port' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'queue-port' }, (a) => ({ contents: a.path === 'store-proxy' ? `import { useStore as real } from 'audit-real-store'; export { pendingSendsForView } from 'audit-real-store'; export const useStore = Object.assign(fn => fn(real.getState()), { getState: real.getState, setState: real.setState })` : a.path === 'react' ? 'export const useCallback = f=>f, useMemo = f=>f()' : a.path.endsWith('i18n') ? 'export const useT = () => key => key' : 'export const showToast = (_, options) => { globalThis.undoClear = options.action.onAction }' }))
}}] })
const { useStore, pendingSendsForView, useTerminalJobs, answerStopConfirm, stopConfirmSummary, useQueueAdapter, materializeWorktreeIntent, setWorktreeIntent } = await import(pathToFileURL(outfile).href)
const get = useStore.getState
const baseline = get()
const runtime = (id) => ({ sessionId: id, runId: `run-${id}`, generation: 1 })
const runner = (id) => ({ ...runtime(id), id: `run-${id}`, cwd: 'C:/fixture', sessionFile: `${id}.jsonl`, isActive: true, running: true })
const session = (id, extra = {}) => ({ sessionId: id, sessionFile: `${id}.jsonl`, cwd: 'C:/fixture', isAgentRunning: true, ...extra })
const switchView = (id, extra = {}) => useStore.setState({ session: session(id, extra), activeRunnerId: `run-${id}`, peekedPath: null, peekedSessionId: null })
const reset = (extra = {}) => {
  useStore.setState(baseline, true)
  switchView('A')
  useStore.setState({ runners: [runner('A'), runner('B')], ...extra })
}
const tick = () => new Promise(r => setTimeout(r, 5))
const record = (name, data) => console.log(name, JSON.stringify(data))

{
  const file = { id: 'original-file', kind: 'file', path: 'C:/fixture/a.txt' }
  let created
  reset({ messages: [], session: session('A', { isAgentRunning: false }), attachments: [file], newSession: () => new Promise(resolve => { created = resolve }) })
  setWorktreeIntent('run-A')
  const move = materializeWorktreeIntent(key => key)
  switchView('B')
  useStore.setState({ attachments: [] })
  created({ ok: true, runId: 'run-new', sessionId: 'new' })
  assert.equal(await move, 'failed')
  assert.deepEqual(get().attachments, [])
  record('WORKTREE_RETAIN_OWNER', { selected: get().session.sessionId })
}

{
  let releaseB
  reset({ messages: [{ id: 'stable-A', role: 'user', text: 'stable' }], sessions: ['A', 'B', 'C'].map(id => ({ id, path: `${id}.jsonl`, cwd: 'C:/fixture' })) })
  window.yan = {
    peekSession: async path => ({ sessionId: path[0], messages: [{ id: path, role: 'user', text: path }], total: 1, truncated: 0 }),
    selectSession: async target => target.sessionId === 'B' ? new Promise(resolve => { releaseB = resolve }) : { ok: false, error: 'fixture failure' }
  }
  const b = get().switchSession('B.jsonl')
  for (let i = 0; !releaseB && i < 10; i++) await tick()
  assert.equal(typeof releaseB, 'function')
  await get().switchSession('C.jsonl')
  releaseB({ ok: true, deferred: true, sessionId: 'B' })
  await b
  assert.equal(get().session?.sessionId, 'A')
  assert.equal(get().messages[0]?.id, 'stable-A')
  record('NAV_ROLLBACK_STABLE', { selected: get().session.sessionId })
}

{
  reset()
  useTerminalJobs.setState({ loaded: true, jobs: [{ id: 'job-A', owners: ['A'], state: 'running', command: 'fixture', startedAt: 1 }] })
  const stopped = []
  window.yan = { terminal: { stopJob: async id => { stopped.push(id) } }, abort: async expected => { stopped.push(expected.sessionId); return { steering: [], followUp: [] } } }
  const stopping = get().abort()
  await tick()
  assert.deepEqual(stopConfirmSummary()?.ids, ['job-A'])
  switchView('B')
  answerStopConfirm('turn')
  await stopping
  assert.deepEqual(stopped, [])
  record('STOP_RETARGET', { confirmedFor: 'A', aborted: stopped[0] })
}

{
  reset()
  useTerminalJobs.setState({ loaded: false, jobs: [] })
  let finishJobs
  const stopped = []
  window.yan = { terminal: { jobs: () => new Promise(resolve => { finishJobs = resolve }) }, abort: async expected => { stopped.push(expected.sessionId); return { steering: [], followUp: [] } } }
  const stopping = get().abort()
  assert.equal(stopConfirmSummary(), null)
  switchView('B')
  finishJobs([{ id: 'job-A', owners: ['A'], state: 'running', command: 'fixture', startedAt: 1 }])
  await stopping
  assert.deepEqual(stopped, [])
  assert.equal(stopConfirmSummary(), null)
  record('STOP_RETARGET_BEFORE_DIALOG', { clickedIn: 'A', aborted: stopped[0], showedDialog: false })
}

{
  reset()
  const sent = []
  useStore.setState({ send: async text => { sent.push(text); return true } })
  const compacting = { id: 'fixture', status: 'running', reason: 'manual' }
  get().applyPush({ ch: 'state', runtime: runtime('A'), payload: session('A', { isCompacting: true, compaction: compacting }) })
  get().holdSend('fixture-held')
  switchView('B')
  get().applyPush({ ch: 'state', runtime: runtime('A'), payload: session('A', { isCompacting: false, lastCompaction: { ...compacting, status: 'completed' } }) })
  const a = get().sessionRuntimes.A.session
  assert.equal(a.isCompacting, false)
  useStore.setState({ session: a, activeRunnerId: 'run-A' })
  get().applyPush({ ch: 'state', runtime: runtime('A'), payload: a })
  await tick()
  assert.deepEqual(sent, ['fixture-held'])
  assert.equal(pendingSendsForView(get()).length, 0)
  record('BACKGROUND_COMPACTION', { autoReleased: sent.length, pendingAfterReturn: pendingSendsForView(get()).length })
}

{
  const row = { id: 'q1', text: 'fixture-queue', images: [{ data: 'AAAA', mimeType: 'image/png' }] }
  const sent = []
  reset({ queue: { steering: [], followUp: [row] }, applyQueueOp: async () => { useStore.setState({ queue: { steering: [], followUp: [] } }); return true }, send: async (text, images, mode) => { sent.push({ sid: get().session.sessionId, text, images: images.length, mode }); return true } })
  await useQueueAdapter().clearAll()
  assert.equal(get().queue.followUp.length, 0)
  switchView('B')
  globalThis.undoClear()
  await tick()
  assert.deepEqual(sent, [])
  assert.equal(get().sessionRuntimes.A.draft, row.text)
  assert.equal(get().sessionRuntimes.A.draftAttachments[0].data, 'AAAA')
  record('QUEUE_UNDO_ORIGINAL', { sent: sent.length, restoredTo: 'A' })
}

{
  const row = { id: 'q1', text: '', images: [{ data: 'AAAA', mimeType: 'image/png' }] }
  const sent = []
  reset({ queue: { steering: [], followUp: [row] }, applyQueueOp: async () => { useStore.setState({ queue: { steering: [], followUp: [] } }); return true }, send: async (...args) => { sent.push(args); return true } })
  await useQueueAdapter().clearAll()
  useStore.setState({ runners: [ { ...runner('A'), running: false } ] })
  globalThis.undoClear()
  await tick()
  assert.equal(sent.length, 0)
  assert.equal(get().attachments[0]?.data, 'AAAA')
  assert.equal(get().pendingSends.length, 0)
  assert.equal(get().queueRestore, null)
  record('QUEUE_UNDO_IDLE_IMAGE', { sent: sent.length, attachments: get().attachments.length, pending: get().pendingSends.length, draft: get().queueRestore })
}
