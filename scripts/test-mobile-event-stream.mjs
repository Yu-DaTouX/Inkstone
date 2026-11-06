import assert from 'node:assert/strict'
import { build } from 'esbuild'

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
const stream = new M.RemoteEventStream(
  { baseUrl: 'http://pc:1', token: 't', deviceId: 'd' },
  { onEvent: (event) => events.push(event.seq), onResync() {}, onState: (state) => states.push(state), onUnauthorized() {} },
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
opened[1].reply(200)
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

stream.stop()
assert.ok(opened[3].aborted)
console.log('mobile-event-stream: 后台恢复与空闲重连通过')
