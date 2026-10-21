#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const report = { pass: 0, fail: 0 }
function ok(cond, label, detail) {
  if (cond) {
    report.pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    report.fail += 1
    console.error(`  ✗ ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
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
if (!('navigator' in globalThis)) globalThis.navigator = { userAgent: 'node' }
globalThis.window = {
  yan: new Proxy({}, { get: () => async () => undefined }),
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://localhost/' }
}

const temp = await mkdtemp(join(tmpdir(), 'yan-queue-reclaim-'))
const outfile = join(temp, 'store.mjs')
await build({
  entryPoints: ['src/renderer/src/state/store.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    requestAnimationFrame: 'globalThis.requestAnimationFrame',
    cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
  }
})
const { useStore } = await import(pathToFileURL(outfile).href)

const runtimeSnapshot = (sessionId, runId, generation, draft, sessionFile, draftAttachments = []) => ({
  runtime: { sessionId, runId, generation },
  session: { sessionId, sessionFile, cwd: 'C:/p' },
  messages: [],
  stats: null,
  queue: { steering: [{ id: 'q1', text: '旧队列' }], followUp: [] },
  todos: [],
  todoHistory: [],
  uiRequests: [],
  statuses: {},
  widgets: {},
  widgetPlacements: {},
  draft,
  draftAttachments,
  goal: null,
  models: [],
  thinkingLevels: [],
  commands: [],
  touchedAt: 1
})

const image = (id) => ({ id, kind: 'image', name: `${id}.png`, mimeType: 'image/png', size: 4, data: 'AAAA', preview: 'data:image/png;base64,AAAA' })

const coldStart = () =>
  useStore.setState({
    session: null,
    peekedSessionId: null,
    peekedPath: null,
    activeRunnerId: null,
    runners: [],
    sessionRuntimes: {},
    attachments: [],
    queueRestore: null,
    notices: [],
    queue: { steering: [], followUp: [] }
  })

const view = (sessionId, extra = {}) =>
  useStore.setState({
    session: { sessionId, sessionFile: `C:/s/${sessionId}.jsonl`, cwd: 'C:/p' },
    peekedSessionId: sessionId,
    peekedPath: `C:/s/${sessionId}.jsonl`,
    activeRunnerId: `r-${sessionId}`,
    runners: [{ id: `r-${sessionId}`, runId: `r-${sessionId}`, sessionId, sessionFile: `C:/s/${sessionId}.jsonl`, generation: 1 }],
    ...extra
  })

const reclaim = (sessionId, payload = {}) =>
  useStore.getState().applyPush({
    ch: 'queue-reclaimed',
    payload: {
      sessionId,
      steering: ['R3-RECOVER-A：被打断前排队的第一条。'],
      followUp: ['R3-RECOVER-B：被打断前排队的第二条。'],
      ...payload
    }
  })

const noticesText = () => (useStore.getState().notices ?? []).map((n) => n.text)
const reclaimNoticed = (count = 2) => noticesText().some((text) => text.includes(String(count)) && text.includes('排队'))

console.log('\n## 冷启动：会话还没就绪时先留住回填文本，提示照常送达')
{
  coldStart()
  useStore.setState({ sessionRuntimes: { S1: runtimeSnapshot('S1', 'r-S1', 1, '', 'C:/s/S1.jsonl') } })
  reclaim('S1')
  const after = useStore.getState()
  ok(after.queueRestore === null, '当前没有会话时不写进输入框', JSON.stringify(after.queueRestore))
  ok(reclaimNoticed(), '提示一定送达', JSON.stringify(noticesText()))
  ok(!after.sessionRuntimes.S1?.draft, '不写后台会话的草稿缓存（composer 不会读它）', JSON.stringify(after.sessionRuntimes.S1?.draft))

  view('S1')
  const ready = useStore.getState()
  ok(ready.queueRestore === 'R3-RECOVER-A：被打断前排队的第一条。\nR3-RECOVER-B：被打断前排队的第二条。', '会话就绪后文本进输入框', JSON.stringify(ready.queueRestore))
  ok(ready.sessionRuntimes.S1?.queue?.steering?.length === 0, '该会话缓存的旧队列被清掉', JSON.stringify(ready.sessionRuntimes.S1?.queue))
  useStore.getState().consumeQueueRestore()
  useStore.setState({ session: null, peekedSessionId: null, sessionRuntimes: {} })
  ok(useStore.getState().queueRestore === null, '消费后不再重复回填')
}

console.log('\n## 后台会话回填：不覆盖当前会话的输入框')
{
  coldStart()
  useStore.setState({
    session: { sessionId: 'B', sessionFile: 'C:/s/B.jsonl', cwd: 'C:/p' },
    peekedSessionId: 'B',
    peekedPath: 'C:/s/B.jsonl',
    activeRunnerId: 'r-B',
    runners: [{ id: 'r-B', runId: 'r-B', sessionId: 'B', sessionFile: 'C:/s/B.jsonl', generation: 1 }],
    sessionRuntimes: { B: runtimeSnapshot('B', 'r-B', 1, 'B 正在写', 'C:/s/B.jsonl', [image('b1')]) },
    attachments: [image('b1')]
  })
  reclaim('S2', {
    steering: ['S2 的排队'],
    followUp: [],
    items: { steering: [], followUp: [{ id: 'q', text: 'S2 的排队', images: [{ data: 'AAAA', mimeType: 'image/png' }] }] }
  })
  const after = useStore.getState()
  ok(after.queueRestore === null, '当前会话 B 的输入框没被塞东西', JSON.stringify(after.queueRestore))
  ok(after.sessionRuntimes.B?.draft === 'B 正在写', 'B 的草稿缓存没被改写', JSON.stringify(after.sessionRuntimes.B?.draft))
  ok(after.attachments.length === 1 && after.attachments[0].id === 'b1', 'B 的附件没被 S2 的图片污染', JSON.stringify(after.attachments.map((a) => a.id)))
  ok(!(after.sessionRuntimes.S2?.draft ?? '').includes('S2 的排队'), '不写后台会话草稿（留给待激活队列）')
  ok(reclaimNoticed(1), '后台回填仍提示用户', JSON.stringify(noticesText()))

  view('S2')
  const switched = useStore.getState()
  ok(switched.queueRestore === 'S2 的排队', '切到 S2 后回填到输入框', JSON.stringify(switched.queueRestore))
  ok(switched.attachments.some((a) => a.kind === 'image' && a.data === 'AAAA'), 'S2 的排队图片一并回到输入框', JSON.stringify(switched.attachments.map((a) => a.id)))
}

console.log('\n## 当前会话收到回填：直接进输入框，不需要待激活')
{
  coldStart()
  view('S3', { sessionRuntimes: { S3: runtimeSnapshot('S3', 'r-S3', 1, '', 'C:/s/S3.jsonl') } })
  reclaim('S3')
  const after = useStore.getState()
  ok(after.queueRestore === 'R3-RECOVER-A：被打断前排队的第一条。\nR3-RECOVER-B：被打断前排队的第二条。', '同会话直接进 queueRestore', JSON.stringify(after.queueRestore))
  ok(after.queue.steering.length === 0 && after.queue.followUp.length === 0, '当前队列快照清零', JSON.stringify(after.queue))
  ok(reclaimNoticed(), '同会话也提示', JSON.stringify(noticesText()))
}

console.log('\n## 多次推送同一会话：合并且只回填一次')
{
  coldStart()
  reclaim('S4', { steering: ['第一条'], followUp: [] })
  reclaim('S4', { steering: [], followUp: ['第二条'] })
  ok(useStore.getState().queueRestore === null, '会话就绪前仍不写输入框')
  view('S4')
  const after = useStore.getState()
  ok(after.queueRestore === '第一条\n第二条', '顺序与内容都保留', JSON.stringify(after.queueRestore))
  useStore.getState().consumeQueueRestore()
  view('S5')
  view('S4')
  ok(useStore.getState().queueRestore === null, '来回切换不重复回填', JSON.stringify(useStore.getState().queueRestore))
}

console.log('\n## 空回填不打扰：没有排队内容不提示也不写状态')
{
  coldStart()
  useStore.getState().applyPush({ ch: 'queue-reclaimed', payload: { sessionId: 'S6', steering: [], followUp: [] } })
  const after = useStore.getState()
  ok(after.notices.length === 0, '没有内容时不提示', JSON.stringify(noticesText()))
  ok(after.queueRestore === null, '没有内容时不写 queueRestore')
  view('S6')
  ok(useStore.getState().queueRestore === null, '切到该会话也没有假回填')
}

console.log(`\n${report.fail === 0 ? 'PASS' : 'FAIL'}: ${report.pass} passed, ${report.fail} failed`)
if (report.fail > 0) process.exitCode = 1
