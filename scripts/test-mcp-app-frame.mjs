import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

let checks = 0
function ok(condition, label) {
  assert.ok(condition, label)
  checks += 1
  console.log(`✓ ${label}`)
}
function eq(actual, expected, label) {
  assert.equal(actual, expected, `${label}（期望 ${expected}，实际 ${actual}）`)
  checks += 1
  console.log(`✓ ${label}`)
}
function deepEq(actual, expected, label) {
  assert.deepEqual(actual, expected, label)
  checks += 1
  console.log(`✓ ${label}`)
}

async function loadTs(relativePath) {
  const source = fileURLToPath(new URL(relativePath, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const model = await loadTs('../src/renderer/src/features/artifacts/mcp-app-frame-model.ts')
const channelModule = await loadTs('../src/renderer/src/features/artifacts/mcp-app-channel.ts')
const RateLimiter = (await loadTs('../src/renderer/src/features/artifacts/model.ts')).BridgeRateLimiter

function fakeWindow() {
  const listeners = new Set()
  return {
    listeners,
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn)
    },
    emit(event) {
      for (const fn of [...listeners]) fn(event)
    }
  }
}

function fakeFrame() {
  const posted = []
  return {
    posted,
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin })
    }
  }
}

function fakePort() {
  const posted = []
  const listeners = new Set()
  return {
    posted,
    closed: false,
    started: false,
    postMessage(message) {
      posted.push(message)
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn)
    },
    start() {
      this.started = true
    },
    close() {
      this.closed = true
    },
    emit(data) {
      for (const fn of [...listeners]) fn({ data })
    }
  }
}

function makeChannel(overrides = {}) {
  const win = fakeWindow()
  const frame = fakeFrame()
  const calls = []
  let resolveNext = null
  let lastMessage = null
  const api = {
    dispatch(instanceId, message) {
      calls.push({ instanceId, message })
      lastMessage = message
      return new Promise((resolve) => {
        resolveNext = resolve
      })
    }
  }
  const channel = new channelModule.McpAppChannel({
    instanceId: overrides.instanceId ?? 'inst-1',
    api: overrides.api ?? api,
    window: win,
    getFrame: () => frame,
    now: overrides.now ?? (() => 1000),
    ...(overrides.limiter ? { limiter: overrides.limiter } : {})
  })
  return {
    win,
    frame,
    calls,
    channel,
    settle(result) {
      const resolve = resolveNext
      resolveNext = null
      const envelope =
        result && typeof result === 'object' && result.jsonrpc === '2.0'
          ? result
          : { jsonrpc: '2.0', id: lastMessage?.id ?? null, result }
      resolve(envelope)
      return resolve
    },
    settleRaw(value) {
      const resolve = resolveNext
      resolveNext = null
      resolve(value)
      return resolve
    }
  }
}

const HASH = 'a'.repeat(32)
const INST = 'b'.repeat(32)
const VALID_URL = `inkstone-app://${HASH}/${INST}/index.html`

{
  ok(model.isMcpAppFrameUrl(VALID_URL), '合法 inkstone-app 地址通过')
  eq(model.isMcpAppFrameUrl('https://evil.example/app'), false, '普通 https 地址拒绝')
  eq(model.isMcpAppFrameUrl('inkstone-html://' + HASH + '/' + INST + '/index.html'), false, '其它协议拒绝')
  eq(model.isMcpAppFrameUrl(`inkstone-app://${HASH}/${INST}/../index.html`), false, '路径穿越拒绝')
  eq(model.isMcpAppFrameUrl(`inkstone-app://${HASH}/${INST}/index.html?x=1`), false, '查询串拒绝')
  const parsed = model.parseMcpAppFrameUrl(VALID_URL)
  ok(parsed && parsed.instanceId === INST, '解析出实例号用于绑定')
}

{
  eq(model.MCP_APP_FRAME_SANDBOX, 'allow-scripts', 'sandbox 只有 allow-scripts')
  ok(!model.MCP_APP_FRAME_SANDBOX.includes('allow-same-origin'), '静态 sandbox 绝不含 allow-same-origin')
  ok(model.isSafeMcpAppSandbox('allow-scripts'), '静态 sandbox 判定通过')
  eq(model.isSafeMcpAppSandbox('allow-scripts allow-same-origin'), false, '加 same-origin 判不安全')
  ok(model.MCP_APP_FRAME_ALLOW.includes("camera 'none'"), 'allow 权限全关（相机）')
  ok(model.MCP_APP_FRAME_ALLOW.includes("clipboard-write 'none'"), 'allow 权限全关（剪贴板写）')
  eq(model.MCP_APP_FRAME_REFERRER_POLICY, 'no-referrer', '不发 referrer')
  ok(model.isExpectedMcpAppOrigin('null'), 'opaque origin 是期望值')
}

{
  const good = model.decodeMcpAppMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } })
  ok(good.ok && good.message.method === 'tools/call' && good.message.id === 7, '合法 JSON-RPC 解码')
  eq(model.decodeMcpAppMessage({ method: '' }).ok, false, '空方法拒绝')
  eq(model.decodeMcpAppMessage(null).ok, false, '非对象拒绝')
  eq(model.decodeMcpAppMessage({ jsonrpc: '1.0', method: 'ping' }).ok, false, 'jsonrpc 版本不符拒绝')
  eq(model.decodeMcpAppMessage({ method: 'ping', params: [1, 2] }).ok, false, '数组 params 拒绝')
  eq(model.decodeMcpAppMessage({ method: 'ping', id: {} }).ok, false, '对象 id 拒绝')
  const big = model.decodeMcpAppMessage({ method: 'ping', params: { blob: 'x'.repeat(1024 * 1024 + 4) } })
  eq(big.ok, false, '超 1 MiB 消息拒绝')
  eq(big.error, 'size', '超限错误分类为 size')

  const polluted = JSON.parse('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"__proto__":{"polluted":true},"keep":1}}')
  const decoded = model.decodeMcpAppMessage(polluted)
  ok(decoded.ok, '带 __proto__ 的 JSON 仍能解码')
  ok(!Object.prototype.hasOwnProperty.call(decoded.message.params, '__proto__'), 'params 已剔除 __proto__')
  eq({}.polluted, undefined, '原型没有被污染')
  const forwarded = model.toHostDispatchMessage(decoded.message)
  eq(Object.prototype.hasOwnProperty.call(forwarded.params, '__proto__'), false, '转发副本不含 __proto__')
}

{
  eq(model.classifyMcpAppMethod('ui/initialize'), 'initialize', 'initialize 分类')
  eq(model.classifyMcpAppMethod('tools/call'), 'sensitive', 'tools/call 敏感')
  eq(model.classifyMcpAppMethod('resources/read'), 'sensitive', 'resources/read 敏感')
  eq(model.classifyMcpAppMethod('ui/resource-teardown'), 'sensitive', 'teardown 敏感')
  eq(model.classifyMcpAppMethod('ui/notifications/size-changed'), 'size', 'size 分类')
  eq(model.classifyMcpAppMethod('vendor/unknown'), 'host', '未知方法交宿主')
  eq(model.nextMcpAppPhase('idle', 'initialize'), 'initializing', 'idle→initializing')
  eq(model.nextMcpAppPhase('initializing', 'initialize-ok'), 'ready', 'initializing→ready（仅凭证式合法应答）')
  eq(model.nextMcpAppPhase('idle', 'initialize-ok'), 'idle', 'idle 不能被应答直接点亮')
  eq(model.nextMcpAppPhase('ready', 'reset'), 'idle', 'ready→idle 重置')
  eq(model.nextMcpAppPhase('ready', 'close'), 'closed', 'ready→closed')
  eq(model.nextMcpAppPhase('closed', 'initialize'), 'closed', 'closed 不能复活')
  eq(model.clampMcpAppSize(999999), 20000, 'size 上限钳制')
  eq(model.clampMcpAppSize(1), 40, 'size 下限钳制')
  eq(model.clampMcpAppSize('x'), null, '非数字 size 忽略')
}

{
  const good = model.parseMcpAppHostEnvelope({ jsonrpc: '2.0', id: 5, result: { ok: 1 } }, { hasId: true, id: 5 })
  ok(good.ok && good.kind === 'result' && good.result.ok === 1, '规范 result 信封通过')
  const err = model.parseMcpAppHostEnvelope({ jsonrpc: '2.0', id: 5, error: { code: -1, message: 'x' } }, { hasId: true, id: 5 })
  ok(err.ok && err.kind === 'error', '规范 error 信封通过且保留顶层 error')
  eq(model.parseMcpAppHostEnvelope({ ok: 1 }, { hasId: true, id: 5 }).ok, false, '裸对象不是合法信封')
  eq(model.parseMcpAppHostEnvelope({ jsonrpc: '1.0', id: 5, result: {} }, { hasId: true, id: 5 }).ok, false, '版本不符拒绝')
  eq(model.parseMcpAppHostEnvelope({ jsonrpc: '2.0', id: 6, result: {} }, { hasId: true, id: 5 }).ok, false, '请求 id 不匹配拒绝')
  eq(
    model.parseMcpAppHostEnvelope({ jsonrpc: '2.0', id: 5, result: {}, error: {} }, { hasId: true, id: 5 }).ok,
    false,
    'result/error 同时存在拒绝'
  )
  eq(model.parseMcpAppHostEnvelope({ jsonrpc: '2.0', id: 5 }, { hasId: true, id: 5 }).ok, false, 'result/error 都缺拒绝')
}

{
  eq(model.describeMcpAppView({ kind: 'ready', url: VALID_URL, instanceId: INST, title: 't', callId: 'c' }).mode, 'frame', 'ready + 受控地址 → frame')
  eq(model.describeMcpAppView({ kind: 'ready', url: 'https://evil', instanceId: INST }).mode, 'invalid', 'ready + 非法地址 → 安全拒绝')
  const text = model.describeMcpAppView({ kind: 'text', text: '结果文本', reason: 'no-resource' })
  eq(text.mode, 'text', 'text → 文本回退')
  eq(text.text, '结果文本', '文本回退带原文')
  eq(model.describeMcpAppView({ kind: 'error', error: 'boom' }).mode, 'error', 'error → 错误回退')
}

{
  const { win, frame, calls, channel } = makeChannel()
  channel.attach()
  eq(win.listeners.size, 1, 'attach 后只挂一个 message 监听')
  const otherFrame = fakeFrame()
  win.emit({ data: { jsonrpc: '2.0', id: 1, method: 'tools/call' }, origin: 'null', source: otherFrame })
  eq(calls.length, 0, '非本框 source 的消息不派发')
  win.emit({ data: { jsonrpc: '2.0', id: 2, method: 'tools/call' }, origin: 'https://evil', source: frame })
  eq(calls.length, 0, '错误 origin 的消息不派发')
  channel.dispose()
  eq(win.listeners.size, 0, 'dispose 移除 message 监听')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()

  win.emit({ data: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'write' } }, origin: 'null', source: frame })
  eq(calls.length, 0, '未初始化时 tools/call 不派发')
  eq(frame.posted.at(-1).message.error.code, -32002, '未初始化返回明确错误码')
  eq(channel.getPhase(), 'idle', '未初始化仍是 idle')

  win.emit({ data: { jsonrpc: '2.0', id: 11, method: 'ui/initialize', params: {} }, origin: 'null', source: frame })
  eq(calls.length, 1, 'initialize 派发一次')
  eq(calls[0].message.method, 'ui/initialize', '派发消息是 initialize')
  settle({ hostContext: { theme: 'dark' } })
  await Promise.resolve()
  eq(channel.getPhase(), 'ready', 'initialize 结果返回后进入 ready')
  eq(frame.posted.at(-1).message.result.hostContext.theme, 'dark', '宿主 hostContext 原样回投')

  const before = calls.length
  win.emit({ data: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'write' } }, origin: 'null', source: frame })
  eq(calls.length, before + 1, 'ready 后 tools/call 派发给宿主（审批在宿主）')
  eq(calls.at(-1).message.method, 'tools/call', '工具调用只走宿主 dispatch')
  settle({ content: [{ type: 'text', text: 'ok' }] })
  await Promise.resolve()
  eq(frame.posted.at(-1).message.result.content[0].text, 'ok', '工具结果回投给 App')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()
  win.emit({ data: { jsonrpc: '2.0', id: 30, method: 'ui/initialize', params: {} }, origin: 'null', source: frame })
  eq(calls.length, 1, 'initialize 已派发给宿主')
  settle({ jsonrpc: '2.0', id: 30, error: { code: -32001, message: '归属已失效' } })
  await Promise.resolve()
  eq(channel.getPhase() === 'ready', false, 'host 拒绝 initialize：握手不得进 ready')
  const posted = frame.posted.at(-1).message
  eq(posted.error?.code, -32001, 'host error 保留在顶层 error')
  eq(Object.prototype.hasOwnProperty.call(posted, 'result'), false, 'host 拒绝不会转成 result')

  const bare = makeChannel()
  bare.channel.attach()
  bare.win.emit({ data: { jsonrpc: '2.0', id: 31, method: 'ui/initialize', params: {} }, origin: 'null', source: bare.frame })
  bare.settleRaw({ hostContext: {} })
  await Promise.resolve()
  eq(bare.channel.getPhase() === 'ready', false, '裸对象（非法信封）不放行 ready')
  eq(bare.frame.posted.at(-1).message.error?.code, -32603, '畸形宿主应回明确错误，不进 ready')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()
  win.emit({ data: { jsonrpc: '2.0', id: 20, method: 'ui/initialize' }, origin: 'null', source: frame })
  settle({})
  await Promise.resolve()
  eq(calls.length, 1, '初始化只产生一次派发')
  win.emit({ data: { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 300 } }, origin: 'null', source: frame })
  eq(calls.length, 1, 'size 通知不产生工具调用')
  eq(channel.getPhase(), 'ready', 'size 通知不改握手状态')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()
  win.emit({ data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, origin: 'null', source: frame })
  settle({})
  await Promise.resolve()
  const base = calls.length
  const call = { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'x' } }
  win.emit({ data: call, origin: 'null', source: frame })
  win.emit({ data: call, origin: 'null', source: frame })
  eq(calls.length, base + 1, '重复 id 只派发一次')

  const limited = makeChannel({ limiter: new RateLimiter(3, 1000), now: () => 5000 })
  limited.channel.attach()
  for (let i = 0; i < 6; i += 1) {
    limited.win.emit({ data: { jsonrpc: '2.0', id: i, method: 'ui/initialize' }, origin: 'null', source: limited.frame })
  }
  eq(limited.calls.length, 3, '超过 3 条/秒被限速丢弃')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()
  win.emit({ data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, origin: 'null', source: frame })
  settle({})
  await Promise.resolve()
  win.emit({ data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }, origin: 'null', source: frame })
  const postedBefore = frame.posted.length
  channel.dispose()
  settle({ content: [] })
  await Promise.resolve()
  eq(frame.posted.length, postedBefore, 'dispose 后迟到的宿主结果不再回投')
  eq(channel.getPhase(), 'closed', 'dispose 后状态关闭')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()
  win.emit({ data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, origin: 'null', source: frame })
  settle({})
  await Promise.resolve()
  win.emit({ data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }, origin: 'null', source: frame })
  eq(calls.length, 2, '工具调用已派出')
  const postedBefore = frame.posted.length
  channel.nextGeneration()
  eq(channel.getPhase(), 'idle', '换代把握手重置为 idle')
  settle({ content: [] })
  await Promise.resolve()
  eq(frame.posted.length, postedBefore, '换代后旧 dispatch 结果不回投')
}

{
  const { win, frame, calls, channel, settle } = makeChannel()
  channel.attach()
  const rogue = fakePort()
  win.emit({ data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, origin: 'null', source: fakeFrame(), ports: [rogue] })
  eq(channel.port === null || rogue.started === false, true, '非本框 source 不能抢初始化，也不采纳端口')
  eq(calls.length, 0, '抢初始化的消息被丢弃')

  const port = fakePort()
  win.emit({ data: { jsonrpc: '2.0', id: 2, method: 'ui/initialize' }, origin: 'null', source: frame, ports: [port] })
  ok(port.started, '本框初始化时采纳 MessagePort 并 start')
  settle({})
  await Promise.resolve()
  eq(port.posted.length, 1, '后续应答经端口而不是 window 回投')
  channel.nextGeneration()
  ok(port.closed, '换代关闭旧端口')
}

{
  eq(model.auditPhaseTone('completed'), 'ok', '完成是正向色')
  eq(model.auditPhaseTone('denied'), 'err', '拒绝是错误色')
  eq(model.auditPhaseTone('approved'), 'ask', '已批准是提醒色')
  eq(model.auditPhaseTone('requested'), 'neutral', '请求中是中性色')
}

console.log(`\n全部通过：${checks} 项`)
