#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'yan-session-reattach-'))
const bundle = async (entry, name) => {
  const outfile = join(temp, name)
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'error',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    }
  })
  return import(pathToFileURL(outfile).href)
}

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: () => null,
  length: 0
}
globalThis.requestAnimationFrame = (fn) => {
  fn(0)
  return 0
}
globalThis.cancelAnimationFrame = () => {}
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
  hasFocus: () => true,
  documentElement: { lang: 'zh-CN' },
  querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
}
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }
globalThis.window = {
  yan: new Proxy({}, { get: () => async () => undefined }),
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://localhost/' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await sleep(0)
}

let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

try {
  const runtime = await bundle('src/renderer/src/state/session-runtime.ts', 'runtime.mjs')
  const { useStore } = await bundle('src/renderer/src/state/store.ts', 'store.mjs')

  const runtimeA = { sessionId: 'sess-a', runId: 'r1', projectId: 'p', generation: 1 }
  const message = (id, role, text) => ({ id, role, text, timestamp: 1 })
  const persisted = [message('m0', 'user', '第一轮'), message('m1', 'assistant', '第一轮回复')]
  const statePayload = (sessionId, streaming) => ({
    sessionId,
    sessionFile: `C:/sessions/${sessionId}.jsonl`,
    cwd: 'C:/proj',
    isAgentRunning: streaming,
    isStreaming: streaming,
    isCompacting: false,
    availableThinkingLevels: []
  })

  process.stdout.write('\n## 会话缓存：消息历史是否已知\n')
  await check('state 推送建立的快照标记为「历史未知」', () => {
    const map = runtime.reduceSessionRuntime({}, runtimeA, { ch: 'state', payload: statePayload('sess-a', false) })
    assert.equal(map['sess-a'].messagesLoaded, false)
    assert.deepEqual(map['sess-a'].messages, [])
  })
  await check('sync 推送带回完整历史后标记为「历史已知」', () => {
    let map = runtime.reduceSessionRuntime({}, runtimeA, { ch: 'state', payload: statePayload('sess-a', true) })
    map = runtime.reduceSessionRuntime(map, runtimeA, { ch: 'sync', payload: persisted })
    assert.equal(map['sess-a'].messagesLoaded, true)
    assert.deepEqual(map['sess-a'].messages.map((m) => m.id), ['m0', 'm1'])
  })
  await check('空 sync 也是权威历史（清空视图）', () => {
    const map = runtime.reduceSessionRuntime({}, runtimeA, { ch: 'sync', payload: [] })
    assert.equal(map['sess-a'].messagesLoaded, true)
    assert.deepEqual(map['sess-a'].messages, [])
  })
  await check('msg-add 新建消息后缓存可信', () => {
    let map = runtime.reduceSessionRuntime({}, runtimeA, { ch: 'state', payload: statePayload('sess-a', true) })
    map = runtime.reduceSessionRuntime(map, runtimeA, { ch: 'msg-add', payload: message('m9', 'assistant', '') })
    assert.equal(map['sess-a'].messagesLoaded, true)
  })
  await check('规则：只有 sync 或 msg-add 能让缓存宣告历史已知', () => {
    let map = runtime.reduceSessionRuntime({}, runtimeA, { ch: 'state', payload: statePayload('sess-a', true) })
    map = runtime.reduceSessionRuntime(map, runtimeA, { ch: 'msg-update', payload: { id: 'm9', patch: { textDelta: '迟到增量' } } })
    map = runtime.reduceSessionRuntime(map, runtimeA, { ch: 'tool', payload: { msgId: 'm9', call: { id: 't1', name: 'read', args: {} } } })
    map = runtime.reduceSessionRuntime(map, runtimeA, { ch: 'stats', payload: { totalMessages: 3 } })
    assert.equal(map['sess-a'].messagesLoaded, false)
  })

  const reset = () => {
    useStore.setState({
      sessions: [{ path: 'C:/sessions/sess-a.jsonl', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' }],
      settings: { cwd: 'C:/proj', projects: [], lang: 'zh-CN' },
      session: statePayload('sess-a', false),
      messages: persisted,
      activeRunnerId: 'r1',
      runners: [{ id: 'r1', runId: 'r1', generation: 1, isActive: true, sessionId: 'sess-a', cwd: 'C:/proj' }],
      sessionRuntimes: {},
      peekedPath: null,
      peekedSessionId: null,
      peekNote: null,
      pendingActivation: null,
      queue: { steering: [], followUp: [] },
      todos: [],
      todoHistory: [],
      uiRequests: [],
      statuses: {},
      widgets: {},
      widgetPlacements: {},
      stats: null,
      notices: [],
      attachments: [],
      queueRestore: null,
      switchLoading: false
    })
  }

  process.stdout.write('\n## 重载重连：只有 state 时不得清空已恢复的消息\n')
  await check('渲染端重连收到 state 推送时保留从持久化记录恢复的消息', async () => {
    reset()
    useStore.getState().applyPush({ ch: 'state', runtime: runtimeA, payload: statePayload('sess-a', true) })
    await settle()
    assert.deepEqual(useStore.getState().messages.map((m) => m.id), ['m0', 'm1'])
  })
  await check('runners 推送投影同一会话时同样保留消息', async () => {
    reset()
    useStore.getState().applyPush({ ch: 'state', runtime: runtimeA, payload: statePayload('sess-a', true) })
    useStore.getState().applyPush({
      ch: 'runners',
      payload: [{ id: 'r1', runId: 'r1', generation: 1, isActive: true, sessionId: 'sess-a', cwd: 'C:/proj' }]
    })
    await settle()
    assert.deepEqual(useStore.getState().messages.map((m) => m.id), ['m0', 'm1'])
  })
  await check('重连后的 sync 用持久化记录覆盖视图', async () => {
    reset()
    useStore.getState().applyPush({ ch: 'state', runtime: runtimeA, payload: statePayload('sess-a', true) })
    useStore.getState().applyPush({
      ch: 'sync',
      runtime: runtimeA,
      payload: [...persisted, message('m2', 'user', '重载期间的提问'), message('m3', 'assistant', '半截回复')]
    })
    await settle()
    const state = useStore.getState()
    assert.deepEqual(state.messages.map((m) => m.id), ['m0', 'm1', 'm2', 'm3'])
    assert.equal(state.sessionRuntimes['sess-a'].messagesLoaded, true)
  })
  await check('重连后的流式增量继续落到当前视图', async () => {
    reset()
    useStore.getState().applyPush({ ch: 'state', runtime: runtimeA, payload: statePayload('sess-a', true) })
    useStore.getState().applyPush({
      ch: 'sync',
      runtime: runtimeA,
      payload: [...persisted, message('m2', 'user', '重载期间的提问'), message('m3', 'assistant', '半截')]
    })
    useStore.getState().applyPush({
      ch: 'msg-update',
      runtime: runtimeA,
      payload: { id: 'm3', patch: { textDelta: '回复继续说' } }
    })
    await settle()
    const last = useStore.getState().messages.at(-1)
    assert.equal(last.id, 'm3')
    assert.equal(last.text, '半截回复继续说')
  })
  await check('历史未知时，迟到的 msg-update 不会把视图改成残缺单条', async () => {
    reset()
    useStore.getState().applyPush({ ch: 'state', runtime: runtimeA, payload: statePayload('sess-a', true) })
    useStore.getState().applyPush({
      ch: 'msg-update',
      runtime: runtimeA,
      payload: { id: 'm9', patch: { textDelta: '未同步的增量' } }
    })
    await settle()
    assert.deepEqual(useStore.getState().messages.map((m) => m.id), ['m0', 'm1'])
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}

process.stdout.write(`\n${pass} passed\n`)
