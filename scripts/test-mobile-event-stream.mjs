import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

if (!existsSync(join('mobile', 'node_modules', '@noble', 'curves'))) {
  console.log('- test-mobile-event-stream（跳过：worktree 未安装 mobile 依赖）')
  process.exit(0)
}

const built = await build({
  stdin: { contents: `export { RemoteEventStream, EVENT_IDLE_MS, EVENT_WAKE_STALE_MS } from './src/api/client'`, resolveDir: 'mobile', loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})

const opened = []
class FakeXhr {
  static HEADERS_RECEIVED = 2
  static LOADING = 3
  static DONE = 4
  readyState = 0
  status = 0
  responseText = ''
  aborted = false
  constructor() { opened.push(this) }
  open(method, url) { this.url = url }
  setRequestHeader() {}
  send() {}
  abort() { this.aborted = true; this.readyState = 4; this.onreadystatechange?.() }
  reply(status, text = '') {
    this.status = status
    this.readyState = 2
    this.onreadystatechange?.()
    this.responseText += text
    this.readyState = 3
    this.onreadystatechange?.()
  }
}
globalThis.XMLHttpRequest = FakeXhr
const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const now = { value: 1_000_000, now() { return this.value } }
const states = []
const events = []
const resyncs = []
const frame = (seq) => `id: ${seq}\nevent: state\ndata: ${JSON.stringify({ seq, channel: 'state', payload: {} })}\n\n`
const stream = new M.RemoteEventStream(
  { baseUrl: 'http://pc:1', token: 't', deviceId: 'd' },
  { onEvent: (event) => events.push(event.seq), onResync: (event) => resyncs.push(event), onState: (state) => states.push(state), onUnauthorized() {} },
  now
)
stream.start()
assert.equal(opened.length, 1)
opened[0].reply(200, 'id: 1\nevent: state\ndata: {"seq":1,"channel":"state","payload":{}}\n\n')
assert.deepEqual(events, [1])
assert.equal(states.at(-1), 'open')

now.value += 5_000
stream.wake()
assert.equal(opened.length, 1, '刚有数据时回到前台不重连')

now.value += M.EVENT_WAKE_STALE_MS + 1000
stream.wake()
assert.equal(opened.length, 2, '后台挂起很久后回到前台立即重连')
assert.ok(opened[0].aborted, '旧连接被中止')
assert.ok(opened[1].url.endsWith('since=1'), '从上次的序号继续')
opened[1].reply(200, frame(1) + frame(2) + frame(2) + frame(3))
assert.deepEqual(events, [1, 2, 3], '短断线的重复事件只处理一次')
assert.equal(states.at(-1), 'open')
assert.equal(opened.length, 2, '被中止的旧连接不会再触发第二次重连')

now.value += M.EVENT_IDLE_MS + 1000
stream.checkIdle()
assert.equal(opened.length, 3, '空闲超过心跳上限视为半开连接并重连')

opened[2].reply(200)
opened[2].readyState = 4
opened[2].onreadystatechange()
assert.equal(opened.length, 3, '断线后先等退避，不立刻重连')
stream.wake()
assert.equal(opened.length, 4, '回到前台跳过退避立即重连')

assert.ok(opened[3].url.endsWith('since=3'), '重连以最后接收的序号为准')
opened[3].reply(200, 'event: resync\ndata: {"reason":"server_restarted","latestSeq":0}\n\n' + frame(1))
assert.deepEqual(resyncs, [{ reason: 'server_restarted', latestSeq: 0 }])
assert.deepEqual(events, [1, 2, 3, 1], '明确收到服务器重启回执后才接受新的序号')
stream.stop()
assert.ok(opened[3].aborted)
console.log('mobile-event-stream: 后台恢复、回放去重与重启游标通过')
