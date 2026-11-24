import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-session-watch-'))
const electronNames = ['app', 'nativeImage', 'BrowserWindow', 'session', 'shell', 'ipcMain', 'safeStorage', 'dialog', 'clipboard', 'Notification', 'webContents', 'screen', 'Menu', 'Tray', 'net', 'protocol', 'powerMonitor', 'nativeTheme', 'WebContentsView', 'utilityProcess', 'MessageChannelMain']
const electronStub = {
  name: 'session-watch-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'session-watch-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'session-watch-electron' }, () => ({
      contents: electronNames.map((name) => `export const ${name} = new Proxy(function () {}, { get: (_t, key) => key === 'getPath' ? () => ${JSON.stringify(root)} : key === 'getLocale' ? () => 'zh-CN' : key === 'isEncryptionAvailable' ? () => false : undefined })`).join('\n')
    }))
  }
}
await build({
  stdin: {
    contents: `export { RemoteAccess } from './src/main/remote-access'; export { WatchClient } from './src/main/watch-client'; export { WatchTunnel } from './src/main/watch-tunnel'; export { RemoteServer } from './src/main/remote-server'; export { RemoteDeviceStore } from './src/main/remote-devices'; export * from './src/shared/session-watch'; export { watchProjection } from './src/main/session-watch-host'`,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile: join(root, 'watch.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [electronStub],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
})
const M = await import(pathToFileURL(join(root, 'watch.mjs')).href)

const waitFor = async (check, label, ms = 8000) => {
  const start = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - start > ms) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const historyCalls = []
const commands = []
const handlers = {
  async snapshot() { return { sessions: [{ id: 'sess-1' }, { id: 'sess-2' }] } },
  async history(sessionId, limit) {
    historyCalls.push([sessionId, limit])
    return {
      ok: true,
      data: {
        session: { id: sessionId, title: '共享测试会话' },
        messages: [
          { id: 'u1', role: 'user', text: '你好', sourceCwd: 'C:/secret/project', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
          { id: 'a1', role: 'assistant', text: '你好呀', artifacts: [{ id: 'x', path: 'C:/secret/out.png' }], toolCalls: [{ id: 't1', name: 'bash', args: { command: 'x'.repeat(3000) }, status: 'ok', output: 'y'.repeat(9000), details: { token: 'secret' }, approval: { id: 'ap' } }] }
        ],
        state: { sessionId, isStreaming: false, isAgentRunning: true, isCompacting: false, cwd: 'C:/secret', model: { id: 'm0', name: '模型零' } },
        hasMore: false
      }
    }
  },
  async command(command) { commands.push(command); return { ok: true } }
}

let passed = 0
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`) }

{
  const invite = M.encodeWatchInvite({ hostKey: 'k'.repeat(43), host: '主机', direct: ['ws://100.64.0.1:37892/remote/v1/tunnel'], code: 'c'.repeat(32), fingerprint: 'AB-CD', title: '标题', sessionId: 's1' })
  const parsed = M.parseWatchInvite(`  ${invite.slice(0, 20)}\n${invite.slice(20)}  `)
  assert.equal(parsed?.sessionId, 's1')
  assert.equal(parsed?.title, '标题')
  assert.equal(M.parseWatchInvite('inkstone-watch:abc'), null)
  assert.equal(M.parseWatchInvite(M.encodeWatchInvite({ hostKey: 'k'.repeat(43), host: 'h', direct: ['http://evil/x'], code: 'c'.repeat(32), fingerprint: '', title: '', sessionId: 's1' })), null)
  ok('邀请编解码：换行与空白可容忍，地址和字段不合规时拒绝')
}

{
  const shared = (id) => id === 'sess-1'
  const runtime = (sessionId) => ({ sessionId, runId: 'r1', generation: 1 })
  assert.equal(M.watchProjection({ ch: 'msg-add', payload: { id: 'm', role: 'user', text: 'x' }, runtime: runtime('sess-2') }, shared), null)
  assert.equal(M.watchProjection({ ch: 'queue', payload: {}, runtime: runtime('sess-1') }, shared), null)
  const tool = M.watchProjection({ ch: 'tool', payload: { msgId: 'm', call: { id: 't', name: 'read', args: {}, status: 'running', details: { a: 1 }, images: [{ data: 'z' }] }, outputDelta: 'o'.repeat(9000) }, runtime: runtime('sess-1') }, shared)
  assert.equal(tool.channel, 'tool')
  assert.equal(tool.payload.call.details, undefined)
  assert.equal(tool.payload.call.images, undefined)
  assert.ok(tool.payload.outputDelta.length <= 4001)
  const pending = M.watchProjection({ ch: 'ui-request', payload: { id: 'q1', method: 'select', title: '密码？' }, runtime: runtime('sess-1') }, shared)
  assert.deepEqual(pending.payload, { id: 'q1', open: true })
  ok('事件投影：只放行被共享会话的消息流，工具细节、图片截断或去掉，提问只透出编号')
}

process.env.YAN_REMOTE_ENABLE = '1'
process.env.YAN_REMOTE_HOST = '127.0.0.1'
process.env.YAN_REMOTE_PORT = '0'
const dataDir = join(root, 'host')
const access = new M.RemoteAccess(dataDir, handlers)
const pushes = []
const client = new M.WatchClient({ push: (update) => pushes.push(update), deviceName: () => '旁观电脑' })
const second = new M.WatchClient({ push: () => undefined, deviceName: () => '第二台' })
try {
  await access.apply(undefined)
  const status = await access.status()
  assert.ok(status.running, '远程服务已启动')

  const share = await access.startShare('sess-1', '共享测试会话')
  assert.ok(share.ok, share.error)
  const again = await access.startShare('sess-1', '共享测试会话')
  assert.equal(again.share.invite, share.share.invite, '重复共享返回同一个邀请')
  ok('开始共享：生成邀请，重复点击不换码')

  const joined = await client.join(share.share.invite)
  assert.ok(joined.ok, joined.error)
  assert.equal(joined.watch.status, 'live')
  const reset = await waitFor(() => pushes.find((item) => item.kind === 'reset'), '首屏历史')
  assert.equal(reset.messages.length, 2)
  assert.equal(reset.messages[0].images, undefined, '用户图片不下发')
  assert.equal(reset.messages[0].sourceCwd, undefined, '本机路径不下发')
  assert.equal(reset.messages[1].artifacts, undefined, '产物路径不下发')
  assert.equal(reset.messages[1].toolCalls[0].details, undefined)
  assert.equal(reset.messages[1].toolCalls[0].approval, undefined)
  assert.ok(reset.messages[1].toolCalls[0].output.length <= 4001, '工具输出截断')
  assert.equal(reset.view.title, '共享测试会话')
  assert.deepEqual(reset.view.state, { isStreaming: false, isAgentRunning: true, isCompacting: false, model: '模型零' }, '中途加入时首屏就知道主机正在运行')
  assert.deepEqual(historyCalls.at(-1), ['sess-1', 300])
  ok('加入旁观：经加密通道配对并拉到脱敏后的历史')

  const view = access.shareView('sess-1')
  assert.equal(view.viewers.length, 1)
  assert.equal(view.viewers[0].name, '旁观电脑')
  const disk = JSON.parse(await readFile(join(dataDir, 'remote-devices.json'), 'utf8').catch(() => '{"devices":[]}'))
  assert.ok(!disk.devices.some((device) => device.kind === 'viewer'), '旁观者不写入设备表')
  assert.ok(!(await access.status()).relay.clients.some((item) => item.kind === 'viewer'), '旁观者不出现在中继设备列表')
  ok('主机能看到旁观者，旁观身份只在内存里')

  const runtime = (sessionId) => ({ sessionId, runId: 'r1', generation: 1 })
  access.publish({ ch: 'msg-add', payload: { id: 'other', role: 'user', text: '别的会话' }, runtime: runtime('sess-2') })
  access.publish({ ch: 'state', payload: { sessionId: 'sess-1', isStreaming: true, isAgentRunning: true, isCompacting: false, cwd: 'C:/secret', model: { id: 'm', name: '模型甲' } }, runtime: runtime('sess-1') })
  access.publish({ ch: 'msg-add', payload: { id: 'a2', role: 'assistant', text: '' }, runtime: runtime('sess-1') })
  access.publish({ ch: 'msg-update', payload: { id: 'a2', patch: { textDelta: '正在' } }, runtime: runtime('sess-1') })
  access.publish({ ch: 'msg-update', payload: { id: 'a2', patch: { textDelta: '回答' } }, runtime: runtime('sess-1') })
  access.publish({ ch: 'ui-request', payload: { id: 'q1', method: 'confirm', title: '要删吗' }, runtime: runtime('sess-1') })
  const events = () => pushes.filter((item) => item.kind === 'event')
  await waitFor(() => events().length >= 3, '流式事件')
  assert.deepEqual(events().map((item) => item.event.channel), ['msg-add', 'msg-update', 'msg-update'])
  assert.ok(!events().some((item) => item.event.payload?.id === 'other'), '别的会话不下发')
  assert.equal(events()[1].event.payload.patch.textDelta, '正在')
  const live = await waitFor(() => pushes.filter((item) => item.kind === 'view').map((item) => item.view).findLast((item) => item.pending === 1), '待处理提问')
  assert.equal(live.state.isStreaming, true)
  assert.equal(live.state.model, '模型甲')
  ok('事件流：按顺序收到本会话的流式增量、状态和待处理数，别的会话收不到')

  const peer = new M.WatchTunnel({ url: M.parseWatchInvite(share.share.invite).direct[0], hostKey: M.parseWatchInvite(share.share.invite).hostKey, deviceName: '探测', pairingCode: M.parseWatchInvite(share.share.invite).code })
  await peer.connect()
  const pair = await peer.request('POST', '/remote/v1/pair', { body: { code: M.parseWatchInvite(share.share.invite).code, kind: 'phone', deviceName: '冒充手机' } })
  const token = JSON.parse(pair.text).token
  assert.equal(JSON.parse(pair.text).device.kind, 'viewer', '经旁观通道配对只能得到旁观身份')
  for (const [method, path, body] of [['GET', '/remote/v1/sessions'], ['GET', '/remote/v1/status'], ['GET', '/remote/v1/events'], ['GET', '/remote/v1/sessions/sess-1'], ['POST', '/remote/v1/sessions/sess-1/messages', { text: 'hi' }], ['POST', '/remote/v1/runs/abort', { runId: 'r1' }]]) {
    const reply = await peer.request(method, path, { token, body })
    assert.equal(reply.status, 403, `${method} ${path}`)
  }
  assert.equal(commands.length, 0, '旁观者没能触发任何操作')
  assert.equal(access.shareView('sess-1').viewers.length, 2)
  const left = await peer.request('POST', '/remote/v1/devices/self/revoke', { token, body: {} })
  assert.equal(left.status, 200)
  assert.equal(access.shareView('sess-1').viewers.length, 1, '自我退出后从主机名单消失')
  assert.equal((await peer.request('GET', '/remote/v1/watch', { token })).status, 401, '退出后令牌失效')
  peer.close()
  ok('权限：旁观通道只能读共享会话，发消息、停止、读其他会话都被拒绝')

  const watchServer = new M.RemoteServer({ host: '127.0.0.1', port: 0, devices: new M.RemoteDeviceStore(join(root, 'scope')), handlers, relayToken: 'relay-token-for-test-0001' })
  const plainServer = new M.RemoteServer({ host: '127.0.0.1', port: 0, devices: new M.RemoteDeviceStore(join(root, 'plain')), handlers })
  try {
    const scoped = await watchServer.start()
    const plain = await plainServer.start()
    const code = 'v'.repeat(32)
    watchServer.options.devices.allowShare(code, 'sess-1')
    plainServer.options.devices.allowShare(code, 'sess-1')
    const call = async (port, method, path, { token: bearer, body, relay = true } = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(relay ? { 'x-yan-relay': 'relay-token-for-test-0001' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'idempotency-key': 'watch-scope-0001' },
        body: body ? JSON.stringify(body) : undefined
      })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    const plainPair = await call(plain.port, 'POST', '/remote/v1/pair', { body: { kind: 'viewer', code }, relay: false })
    assert.equal(plainPair.status, 426, '不经加密通道不能以旁观者配对')
    const paired = await call(scoped.port, 'POST', '/remote/v1/pair', { body: { kind: 'viewer', code, deviceName: '直连' } })
    assert.equal(paired.status, 200)
    const bad = await call(scoped.port, 'POST', '/remote/v1/pair', { body: { kind: 'viewer', code: 'w'.repeat(32) } })
    assert.equal(bad.status, 403)
    for (const [method, path, body] of [['GET', '/remote/v1/sessions'], ['GET', '/remote/v1/status'], ['GET', '/remote/v1/questions'], ['POST', '/remote/v1/sessions/sess-1/messages', { text: 'hi' }], ['POST', '/remote/v1/new', {}]]) {
      const reply = await call(scoped.port, method, path, { token: paired.body.token, body })
      assert.equal(reply.status, 403, `${method} ${path}`)
      assert.equal(reply.body.code, 'viewer_scope', `${method} ${path}`)
    }
    const info = await call(scoped.port, 'GET', '/remote/v1/info', { token: paired.body.token })
    assert.deepEqual(info.body.capabilities, ['watch'])
    assert.equal(commands.length, 0)
  } finally {
    await watchServer.stop()
    await plainServer.stop()
  }
  ok('服务端白名单：旁观令牌只认 info、watch、事件流和自我退出')

  const joinedSecond = await second.join(share.share.invite)
  assert.ok(joinedSecond.ok, joinedSecond.error)
  assert.equal(access.shareView('sess-1').viewers.length, 2)
  const removedId = access.shareView('sess-1').viewers.find((item) => item.name === '第二台').id
  assert.ok(access.removeViewer('sess-1', removedId))
  const kicked = await waitFor(() => second.list().find((item) => item.status === 'ended'), '被移出的旁观者结束', 12000)
  assert.match(kicked.error, /移出|ended|removed/)
  assert.equal(client.list()[0].status, 'live', '其他旁观者不受影响')
  ok('移出旁观者：被移出的一方显示结束，其他人继续')

  assert.ok(access.stopShare('sess-1'))
  const ended = await waitFor(() => client.list().find((item) => item.status === 'ended'), '停止共享后旁观结束')
  assert.match(ended.error, /停止共享|stopped/)
  const rejoin = await new M.WatchClient({ push: () => undefined }).join(share.share.invite)
  assert.equal(rejoin.ok, false, '停止共享后旧邀请失效')
  access.publish({ ch: 'msg-add', payload: { id: 'late', role: 'user', text: 'x' }, runtime: runtime('sess-1') })
  ok('停止共享：旁观端收到结束，旧邀请再也连不上')

  await client.leave(client.list()[0].id)
  assert.equal(client.list().length, 0)
  assert.equal(pushes.at(-1).kind, 'removed')
  ok('退出旁观：清掉本地记录')
} finally {
  client.stopAll()
  second.stopAll()
  await access.stop()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
console.log(`\n会话旁观：${passed} 项通过`)
