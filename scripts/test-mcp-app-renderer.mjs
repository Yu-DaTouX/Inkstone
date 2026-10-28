import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

async function isolated(run) {
  const savedEnv = { ...process.env }
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  }
}

async function frameSuite() {
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
}

async function renderSuite() {
const outdir = await mkdtemp(join(tmpdir(), 'yan-mcp-app-render-'))
let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}
const eq = (actual, expected, label) => ok(actual === expected, `${label}（期望 ${expected}，实际 ${actual}）`)

async function main() {
  await build({
    entryPoints: ['src/shared/mcp-app-preview.ts', 'src/main/mcp/app-resource-store.ts'],
    outdir,
    outbase: 'src',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const shared = await import(pathToFileURL(join(outdir, 'shared/mcp-app-preview.js')).href)
  const { McpAppResourceStore, appServerHash } = await import(pathToFileURL(join(outdir, 'main/mcp/app-resource-store.js')).href)

  const hash = 'a'.repeat(32)
  const inst = 'b'.repeat(32)
  eq(shared.buildMcpAppUrl(hash, inst), `inkstone-app://${hash}/${inst}/index.html`, '受控地址由固定哈希 host + 随机实例路径组成')
  const parsed = shared.parseMcpAppUrl(shared.buildMcpAppUrl(hash, inst))
  ok(parsed && parsed.serverHash === hash && parsed.instanceId === inst, '合法地址解析出 serverHash 与 instanceId')
  ok(shared.parseMcpAppUrl(shared.buildMcpAppUrl(hash, inst) + '#frag') !== null, 'fragment 不影响实例身份')
  eq(shared.parseMcpAppUrl('inkstone-html://' + hash + '/' + inst + '/index.html'), null, '其它协议不认')
  eq(shared.parseMcpAppUrl(`inkstone-app://${'Z'.repeat(32)}/${inst}/index.html`), null, '非十六进制 serverHash 拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/index.html`), null, '缺随机实例目录拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/${inst}/other.html`), null, '只有 index.html 是唯一文档名')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/${inst}/../index.html`), null, '路径穿越拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/${inst}/index.html?path=/etc/passwd`), null, '查询串不能改变资源')
  eq(shared.parseMcpAppUrl(`inkstone-app://user:pass@${hash}/${inst}/index.html`), null, '用户名/口令拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}:8443/${inst}/index.html`), null, '显式端口拒绝')
  eq(shared.parseMcpAppUrl('not a url'), null, '非 URL 拒绝')

  ok(/^[a-f0-9]{32}$/.test(appServerHash('srv-a')), 'serverHash 是 32 位十六进制')
  eq(appServerHash('srv-a'), appServerHash('srv-a'), '同一服务哈希固定')
  ok(appServerHash('srv-a') !== appServerHash('srv-b'), '不同服务来源不同')

  const strictCsp = shared.buildMcpAppCsp()
  ok(strictCsp.includes("default-src 'none'"), '默认档 default-src none')
  ok(strictCsp.includes("script-src 'unsafe-inline'"), '默认档只允许内联脚本')
  ok(strictCsp.includes("connect-src 'none'"), '默认档 connect-src none')
  ok(strictCsp.includes("frame-src 'none'") && strictCsp.includes("object-src 'none'"), '默认档关闭 frame/object')
  ok(strictCsp.includes("base-uri 'none'") && strictCsp.includes("form-action 'none'"), '默认档关闭 base/form')
  ok(strictCsp.includes('sandbox allow-scripts'), '默认档 sandbox 只给脚本')
  ok(!strictCsp.includes('allow-same-origin'), '默认档不含 allow-same-origin')
  ok(!strictCsp.includes('https://') && !strictCsp.includes('unsafe-eval'), '默认档不放宽任何外部来源或 eval')
  eq(shared.MCP_APP_SANDBOX, 'allow-scripts', '首版 sandbox 常量只有 allow-scripts')

  const reject = (value, reason, label) => {
    const decision = shared.classifyMcpAppDomain(value)
    ok(!decision.allowed && decision.reason === reason, `${label}（${value} -> ${decision.reason}）`)
  }
  reject('http://cdn.example.com', 'not-https', '非 HTTPS 拒绝')
  reject('https://user:pass@cdn.example.com', 'credentials', '用户名口令拒绝')
  reject('https://cdn.example.com:8443', 'port', '端口伪装拒绝')
  reject('https://*.example.com', 'wildcard', '泛通配拒绝')
  reject('https://cdn.example.com/path/to.js', 'path', '带路径的声明拒绝（避免放宽范围）')
  reject('https://127.0.0.1', 'ip-literal', 'IPv4 回环字面量拒绝')
  reject('https://10.0.0.1', 'ip-literal', '私网 IPv4 拒绝')
  reject('https://169.254.169.254', 'ip-literal', '链路本地/云 metadata 拒绝')
  reject('https://[::1]', 'ip-literal', 'IPv6 回环拒绝')
  reject('https://[::ffff:127.0.0.1]', 'ip-literal', 'IPv4 映射 IPv6 拒绝')
  reject('https://localhost', 'private-host', 'localhost 拒绝')
  reject('https://foo.local', 'private-host', '.local 拒绝')
  reject('https://foo.internal', 'private-host', '.internal 拒绝')
  reject('https://example.com.', 'invalid-host', '尾点 FQDN 拒绝')
  reject('file:///etc/passwd', 'not-https', 'file 协议拒绝')
  reject('javascript:alert(1)', 'not-https', '自定义/危险 scheme 拒绝')
  reject('   ', 'empty', '空声明拒绝')
  const good = shared.classifyMcpAppDomain('https://cdn.example.com')
  ok(good.allowed && good.value === 'https://cdn.example.com', '严格 HTTPS 域名通过字面校验')

  const noValidator = await shared.resolveDomainList(['https://cdn.example.com', 'https://api.example.com'], 'network', undefined)
  ok(noValidator.every((item) => !item.allowed && item.reason === 'no-validator'), '没有公网判定器时所有网络声明被拒（no-validator）')
  const forbidden = await shared.resolveDomainList(['https://frame.example.com'], 'forbidden', async () => false)
  ok(forbidden.every((item) => !item.allowed && item.reason === 'forbidden'), 'frame/base-uri 声明一律拒绝')
  const publicOk = await shared.resolveDomainList(['https://cdn.example.com'], 'network', async () => false)
  ok(publicOk.length === 1 && publicOk[0].allowed, '注入判定器且判定公网时域名通过')
  const privateNo = await shared.resolveDomainList(['https://cdn.example.com'], 'network', async () => true)
  ok(privateNo[0].reason === 'resolves-private', '注入判定器判定私网时拒绝')
  const unresolvedNo = await shared.resolveDomainList(['https://cdn.example.com'], 'network', async () => {
    throw new Error('dns down')
  })
  ok(unresolvedNo[0].reason === 'unresolved', 'DNS 解析失败按拒绝处理')

  const granted = shared.buildMcpAppCsp({ resource: ['https://cdn.example.com'], connect: ['https://api.example.com'] })
  ok(granted.includes('https://cdn.example.com') && granted.includes('https://api.example.com'), '显式授权的域名进入 CSP')
  ok(/script-src 'unsafe-inline'(;|$)/.test(granted), '外部脚本永不进入 script-src（脚本外联遵守离线默认）')
  ok(granted.includes("frame-src 'none'") && granted.includes("object-src 'none'"), '即使有声明也关闭 frame/object')
  ok(granted.includes("base-uri 'none'") && granted.includes("form-action 'none'"), '即使有声明也关闭 base/form')
  ok(!granted.includes('allow-same-origin'), '授权后仍无 allow-same-origin')
  const headers = shared.mcpAppResponseHeaders(`default-src 'none'; connect-src 'none'`)
  eq(headers['Content-Security-Policy'], "default-src 'none'; connect-src 'none'", '响应头原样下发推导出的 CSP')
  eq(headers['Cache-Control'], 'no-store', '响应头 no-store')
  eq(headers['Referrer-Policy'], 'no-referrer', '响应头 no-referrer')
  eq(headers['X-Content-Type-Options'], 'nosniff', '响应头 nosniff')
  ok(headers['Permissions-Policy'].includes('camera=()') && headers['Permissions-Policy'].includes('payment=()'), 'Permissions-Policy 全关')
  const errorHeaders = shared.mcpAppErrorHeaders()
  ok(errorHeaders['Content-Security-Policy'].includes("default-src 'none'") && errorHeaders['Content-Security-Policy'].includes('sandbox allow-scripts'), '错误回退页也带最严 CSP')

  const metaTried = shared.buildMcpAppCsp()
  ok(!metaTried.includes('https://evil.example.com') && metaTried.includes("connect-src 'none'"), '资源内 meta 无法把未授权来源加回头部策略')

  const ownerA = { serverId: 'srv-a', sessionId: 'sess-1', sessionFile: 'sess-1.jsonl', projectId: 'proj-1', runnerId: 'run-1', generation: 1, toolCallId: 'call-1' }
  ok(shared.isCompleteMcpAppOwner(ownerA), '完整 owner 通过校验')
  ok(!shared.isCompleteMcpAppOwner({ ...ownerA, runnerId: '' }), '缺字段 owner 拒绝')
  ok(!shared.isCompleteMcpAppOwner({ ...ownerA, generation: -1 }), '非法 generation 拒绝')
  ok(shared.sameMcpAppOwner(ownerA, { ...ownerA }), '同 owner 比较相等')
  ok(!shared.sameMcpAppOwner(ownerA, { ...ownerA, toolCallId: 'call-2' }), '不同 toolCall 不相等')

  const HTML = '<html><head></head><body>app view</body></html>'
  const BYTES = Buffer.byteLength(HTML, 'utf8')
  const GOOD = { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: BYTES, csp: 'derived-csp' }
  let clock = 1000
  let active = true
  let fetchCount = 0
  const fetchArgs = []
  let fetchImpl = async (request) => {
    fetchCount++
    fetchArgs.push(request)
    return GOOD
  }
  const guard = { isActive: () => active }
  const store = new McpAppResourceStore({
    fetchResource: (request) => fetchImpl(request),
    ownerGuard: guard,
    now: () => clock,
    cacheTtlMs: 5000,
    maxInstances: 8
  })

  const first = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA })
  ok(first.ok, '首次 prepare 成功')
  ok(first.ok && first.instanceId.length === 32, '实例号随机且定长')
  const read = store.read(first.url)
  ok(read.ok && read.html === HTML && read.csp === 'derived-csp', '读取返回快照正文与推导 CSP')
  eq(fetchCount, 1, '重放不触发任何新的资源抓取（也不触发 tools/call）')
  const readOwner = store.read(first.url, { owner: ownerA })
  ok(readOwner.ok, '同 owner 读取通过')
  const wrongOwner = store.read(first.url, { owner: { ...ownerA, sessionId: 'sess-2' } })
  eq(wrongOwner.error, 'owner', '跨 owner 读取拒绝')
  const forged = store.read(first.url.replace(first.serverHash, 'c'.repeat(32)))
  eq(forged.error, 'unknown', '伪造 serverHash 拒绝')
  eq(store.read(`inkstone-app://${first.serverHash}/${'d'.repeat(32)}/index.html`).error, 'unknown', '未知实例拒绝')
  eq(store.read(first.url, { method: 'POST' }).error, 'method', '非 GET 方法拒绝')
  eq(store.read(first.url.replace('index.html', 'index.html?x=1')).error, 'unknown', '带查询串的资源请求拒绝')

  const second = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA })
  ok(second.ok && second.cached, '同服务同 URI 命中缓存')
  eq(fetchCount, 1, '缓存命中不再抓取')

  clock += 6000
  const third = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA })
  ok(third.ok && !third.cached, 'TTL 过期后重新抓取')
  eq(fetchCount, 2, 'TTL 过期后确实再抓一次')

  const versioned = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA, version: 'v2' })
  ok(versioned.ok && !versioned.cached, '带版本号的资源单独缓存')
  eq(fetchCount, 3, '版本变化会重新抓取')

  store.release(first.url)
  eq(store.read(first.url).error, 'unknown', '释放后实例不再可用')
  ok(!store.release(first.url), '重复释放返回 false')
  ok(store.release(third.url, { ...ownerA, sessionId: 'sess-9' }) === false, '跨 owner 不能卸载别人的实例')
  ok(store.has(third.url), '跨 owner 卸载失败后实例仍在')

  const pathUri = '../../../../etc/passwd'
  const pathResult = await store.prepare({ serverId: 'srv-a', resourceUri: pathUri, owner: ownerA })
  ok(pathResult.ok && /^[a-f0-9]{32}$/.test(pathResult.instanceId), '资源 URI 不会被当成磁盘路径（实例仍为随机号）')
  eq(fetchArgs[fetchArgs.length - 1].resourceUri, pathUri, '资源 URI 原样交给宿主读取')

  fetchImpl = async () => ({ ...GOOD, mimeType: 'text/plain' })
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://bad/mime', owner: ownerA })).error, 'mime', '非 App MIME 拒绝')
  fetchImpl = async () => ({ ...GOOD, bytes: 2 * 1024 * 1024 + 1 })
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://bad/size', owner: ownerA })).error, 'size', '超过 2 MiB 拒绝')
  fetchImpl = async () => {
    throw new Error('host read failed')
  }
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://bad/fetch', owner: ownerA })).error, 'fetch', '宿主读取失败如实返回 fetch')
  fetchImpl = async (request) => {
    fetchCount++
    fetchArgs.push(request)
    return GOOD
  }

  active = false
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://revoked', owner: ownerA })).error, 'revoked', 'owner 失效后 prepare 拒绝')
  eq(store.read(third.url).error, 'revoked', 'owner 失效后读取立即拒绝')

  active = true
  const again = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/again', owner: ownerA })
  ok(again.ok, '恢复后可以再建实例')
  eq(store.invalidateSession('sess-1') >= 1, true, '切会话失效该会话实例')
  eq(store.read(again.url).error, 'unknown', '切会话后旧实例读取失败')

  let releaseFetch
  const gate = new Promise((resolve) => {
    releaseFetch = resolve
  })
  fetchImpl = async () => {
    await gate
    return GOOD
  }
  const late = store.prepare({ serverId: 'srv-b', resourceUri: 'ui://late', owner: { ...ownerA, serverId: 'srv-b' } })
  active = false
  releaseFetch()
  eq((await late).error, 'stale', '异步读取返回时 owner 已失效 => stale，不登记实例')
  active = true

  store.clear()
  eq(store.size, 0, 'clear 清空实例')
  eq(store.cacheSize, 0, 'clear 清空缓存')

  const mismatch = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://x', owner: { ...ownerA, serverId: 'other' } })
  eq(mismatch.error, 'owner', 'owner.serverId 与请求不一致拒绝')

  const shape = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://shape', owner: ownerA })
  const shapeRead = store.read(shape.url)
  ok(shapeRead.ok && !('structuredContent' in shapeRead) && !('credentials' in shapeRead) && !('bearer' in shapeRead), '读取结果只含界面快照，不含凭据/模型字段')

  const tightOwner = { ...ownerA, serverId: 'srv-t' }
  const tight = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => true },
    maxInstances: 1
  })
  const tightFirst = await tight.prepare({ serverId: 'srv-t', resourceUri: 'ui://a', owner: tightOwner })
  ok(tightFirst.ok, '上限内可建实例')
  eq((await tight.prepare({ serverId: 'srv-t', resourceUri: 'ui://b', owner: tightOwner })).error, 'busy', '超过实例上限返回 busy')

  eq(store.invalidateRunner('srv-a', 'run-1') >= 1, true, 'runner 失效清掉该 runner 的实例')
  const ownerB = { ...ownerA, toolCallId: 'call-b' }
  const forOwner = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://owner-b', owner: ownerB })
  eq(store.invalidateOwner(ownerB), 1, '精确 owner 失效只删该实例')
  eq(store.read(forOwner.url).error, 'unknown', '精确失效后实例不可读')

  let unauthorizedFetch = 0
  const countingFetch = async () => {
    unauthorizedFetch++
    return GOOD
  }
  assert.throws(
    () => new McpAppResourceStore({ fetchResource: countingFetch }),
    /ownerGuard/,
    '缺 ownerGuard 构造直接失败'
  )
  checks++
  console.log('✓ 缺 ownerGuard 构造直接失败（不产生放行 store）')
  assert.throws(
    () => new McpAppResourceStore({ fetchResource: countingFetch, ownerGuard: { isActive: 'nope' } }),
    /ownerGuard/,
    '坏类型 ownerGuard 构造直接失败'
  )
  checks++
  console.log('✓ 坏类型 ownerGuard 构造直接失败')

  const throwingGuardStore = new McpAppResourceStore({
    fetchResource: countingFetch,
    ownerGuard: {
      isActive: () => {
        throw new Error('guard exploded')
      }
    }
  })
  eq(
    (await throwingGuardStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://guard-throw', owner: ownerA })).error,
    'revoked',
    'guard 抛异常 => 按不活跃 revoke'
  )
  const truthyGuardStore = new McpAppResourceStore({
    fetchResource: countingFetch,
    ownerGuard: { isActive: () => 'yes' }
  })
  eq(
    (await truthyGuardStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://guard-bad-return', owner: ownerA })).error,
    'revoked',
    'guard 返回非布尔真值也按不活跃 revoke'
  )
  eq(unauthorizedFetch, 0, '缺/坏/异常 guard 全程未触发任何资源抓取')
  eq(throwingGuardStore.size, 0, 'guard 异常不登记实例')
  eq(truthyGuardStore.size, 0, 'guard 坏返回值不登记实例')

  let protocolActive = true
  const protocolStore = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => protocolActive },
    now: () => clock
  })
  const protocolPrepared = await protocolStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://protocol', owner: ownerA })
  ok(protocolPrepared.ok, '协议路径 store 先建实例')
  ok(protocolStore.read(protocolPrepared.url).ok, '守卫活跃且不传 owner 时读取通过')
  protocolActive = false
  eq(protocolStore.read(protocolPrepared.url).error, 'revoked', '守卫失效后不传 owner 的协议读取被拒绝')

  const mutableOwner = { ...ownerA, toolCallId: 'call-owned' }
  const ownedStore = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const owned = await ownedStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://owned', owner: mutableOwner })
  ok(owned.ok, '可变 owner 建实例')
  mutableOwner.toolCallId = 'call-hijacked'
  const ownedRead = ownedStore.read(owned.url, { owner: { ...ownerA, toolCallId: 'call-owned' } })
  ok(ownedRead.ok, '调用者事后改自己 owner 对象，不影响实例归属')
  eq(ownedStore.read(owned.url, { owner: mutableOwner }).error, 'owner', '被改写后的 owner 不能读原实例')
  const returnedOwner = ownedRead.owner
  returnedOwner.toolCallId = 'call-mutated-return'
  ok(ownedStore.read(owned.url, { owner: { ...ownerA, toolCallId: 'call-owned' } }).ok, '读取返回的 owner 是副本，改写它不影响实例')
  eq(ownedStore.read(owned.url, { owner: returnedOwner }).error, 'owner', '被改写的返回 owner 不能读实例')

  let abortFetch = 0
  const abortStore = new McpAppResourceStore({
    fetchResource: async () => {
      abortFetch++
      return GOOD
    },
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const preAbort = new AbortController()
  preAbort.abort()
  eq(
    (await abortStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://pre-abort', owner: ownerA, signal: preAbort.signal })).error,
    'aborted',
    '请求进入前已 abort => aborted'
  )
  eq(abortFetch, 0, '预先 abort 不触发抓取')
  eq(abortStore.size, 0, '预先 abort 不登记实例')
  ok((await abortStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://cache-abort', owner: ownerA })).ok, '先预热缓存')
  const beforeCacheAbort = abortStore.size
  eq(
    (await abortStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://cache-abort', owner: ownerA, signal: preAbort.signal })).error,
    'aborted',
    '缓存命中但请求已 abort => aborted'
  )
  eq(abortStore.size, beforeCacheAbort, '缓存路径 abort 不登记新实例')

  const runRevocationCase = async (label, revoke) => {
    let resolveFetch
    const gate = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const caseStore = new McpAppResourceStore({
      fetchResource: async () => {
        await gate
        return GOOD
      },
      ownerGuard: { isActive: () => true },
      now: () => clock
    })
    const pending = caseStore.prepare({ serverId: 'srv-a', resourceUri: `ui://invalidate/${label}`, owner: ownerA })
    revoke(caseStore)
    resolveFetch()
    eq((await pending).error, 'stale', `${label}：抓取期间撤销（guard 仍 true）=> stale`)
    eq(caseStore.size, 0, `${label}：迟到资源不登记实例`)
    const fresh = await caseStore.prepare({ serverId: 'srv-a', resourceUri: `ui://invalidate/${label}/new`, owner: ownerA })
    ok(fresh.ok, `${label}：明确的新 epoch 后可以再建实例`)
  }
  await runRevocationCase('invalidateSession', (s) => s.invalidateSession('sess-1'))
  await runRevocationCase('invalidateRunner', (s) => s.invalidateRunner('srv-a', 'run-1'))
  await runRevocationCase('invalidateOwner', (s) => s.invalidateOwner(ownerA))
  await runRevocationCase('clear', (s) => s.clear())

  let releaseCaseFetches = 0
  let releaseCaseGateResolve
  const releaseCaseGate = new Promise((resolve) => {
    releaseCaseGateResolve = resolve
  })
  const releaseCaseStore = new McpAppResourceStore({
    fetchResource: async () => {
      releaseCaseFetches++
      if (releaseCaseFetches > 1) await releaseCaseGate
      return GOOD
    },
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const seeded = await releaseCaseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://release/seed', owner: ownerA })
  ok(seeded.ok, 'release 用例先建旧实例')
  const pendingAfterRelease = releaseCaseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://release/pending', owner: ownerA })
  ok(releaseCaseStore.release(seeded.url), '抓取中释放旧实例')
  releaseCaseGateResolve()
  eq((await pendingAfterRelease).error, 'stale', 'release 后迟到资源不登记')
  eq(releaseCaseStore.size, 0, 'release 后没有新增实例（旧实例已释放）')

  let sharedFetches = 0
  const sharedStore = new McpAppResourceStore({
    fetchResource: async () => {
      sharedFetches++
      return GOOD
    },
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const ownerB2 = { ...ownerA, toolCallId: 'call-b2' }
  const a1 = await sharedStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://shared-cache', owner: ownerA })
  const b1 = await sharedStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://shared-cache', owner: ownerB2 })
  ok(a1.ok && b1.ok && b1.cached, '同资源缓存可被不同 owner 复用')
  eq(sharedFetches, 1, '跨 owner 复用命中缓存不再抓取')
  eq(sharedStore.read(a1.url, { owner: ownerB2 }).error, 'owner', 'ownerB 不能读 ownerA 的实例')
  eq(sharedStore.read(b1.url, { owner: ownerA }).error, 'owner', 'ownerA 不能读 ownerB 的实例')
  ok(sharedStore.read(a1.url, { owner: ownerA }).ok && sharedStore.read(b1.url, { owner: ownerB2 }).ok, '各自 owner 可读各自实例')

  let reusableActive = true
  const reuseStore = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => reusableActive },
    now: () => clock
  })
  ok((await reuseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://reuse', owner: ownerA })).ok, '缓存预热')
  reusableActive = false
  eq(
    (await reuseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://reuse', owner: ownerA })).error,
    'revoked',
    '守卫失效后即使缓存命中也不得越权复用'
  )

  await rm(outdir, { recursive: true, force: true })
  console.log(`MCP App render: ${checks} checks passed`)
}

await main()
}

async function themeSuite() {
let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

let mod
try {
  const bundled = await build({
    stdin: {
      contents:
        "export * from './src/main/mcp/app-theme';" + "export * from './src/main/mcp/app-view-service';",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
} catch (error) {
  console.error(`无法加载被测模块：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const {
  McpAppViewService,
  resolveMcpAppThemeValue,
  resolveMcpAppThemeVariables,
  buildMcpAppHostContext,
  MCP_APP_DEFAULT_THEME
} = mod
ok(typeof McpAppViewService === 'function', '加载 McpAppViewService')
ok(typeof resolveMcpAppThemeValue === 'function', '加载 resolveMcpAppThemeValue')
ok(typeof buildMcpAppHostContext === 'function', '加载 buildMcpAppHostContext')

ok(resolveMcpAppThemeValue('light-dark(#FFFFFF, #272725)', 'light') === '#FFFFFF', '浅色取 light-dark 左侧')
ok(resolveMcpAppThemeValue('light-dark(#FFFFFF, #272725)', 'dark') === '#272725', '深色取 light-dark 右侧')
ok(
  resolveMcpAppThemeValue('light-dark(rgba(64,87,214,.10), rgba(142,161,245,.14))', 'light') ===
    'rgba(64,87,214,.10)',
  '嵌套 rgba 的逗号不误拆（浅色）'
)
ok(
  resolveMcpAppThemeValue('light-dark(rgba(64,87,214,.10), rgba(142,161,245,.14))', 'dark') ===
    'rgba(142,161,245,.14)',
  '嵌套 rgba 的逗号不误拆（深色）'
)
ok(
  resolveMcpAppThemeValue('0 0 0 1px light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))', 'light') ===
    '0 0 0 1px rgba(29,29,27,.08)',
  'box-shadow 内嵌 light-dark 解析成浅色描边'
)
ok(
  resolveMcpAppThemeValue('0 0 0 1px light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))', 'dark') ===
    '0 0 0 1px rgba(255,255,255,.08)',
  'box-shadow 内嵌 light-dark 解析成深色描边'
)
ok(resolveMcpAppThemeValue('transparent', 'dark') === 'transparent', '不含 light-dark 的值原样保留')
ok(
  resolveMcpAppThemeValue('light-dark(#FFF', 'light') === 'light-dark(#FFF',
  '形状不合法时原样返回，不猜测'
)

const lightVars = resolveMcpAppThemeVariables('light')
const darkVars = resolveMcpAppThemeVariables('dark')
ok(lightVars['--color-background-primary'] === '#FFFFFF', '浅色主背景是具体值')
ok(darkVars['--color-background-primary'] === '#1C1C1B', '深色主背景是具体值')
ok(lightVars['--color-text-primary'] === '#20211F' && darkVars['--color-text-primary'] === '#E8E7E3', '文字主色按主题取值')
ok(
  lightVars['--shadow-hairline'] === '0 0 0 1px rgba(11,11,11,.1)' &&
    darkVars['--shadow-hairline'] === '0 0 0 1px rgba(255,255,255,.1)',
  '细线阴影按主题取值，不是 light-dark'
)
ok(
  typeof lightVars['--shadow-md'] === 'string' &&
    typeof darkVars['--shadow-md'] === 'string' &&
    lightVars['--shadow-md'] !== darkVars['--shadow-md'],
  '阴影 md 按主题单独取值'
)
ok(
  Object.values(lightVars).every((value) => !value.includes('light-dark(')) &&
    Object.values(darkVars).every((value) => !value.includes('light-dark(')),
  '两套解析结果都不含 light-dark('
)
ok(
  Object.keys(lightVars).length > 40 && Object.keys(lightVars).length === Object.keys(darkVars).length,
  '两套变量键集合一致且数量合理',
  String(Object.keys(lightVars).length)
)

const providerWithExtra = {
  platform: 'desktop',
  displayMode: 'fullscreen',
  availableDisplayModes: ['inline', 'fullscreen', 'pip'],
  locale: 'zh-CN',
  timeZone: 'Asia/Shanghai',
  deviceCapabilities: { hover: true },
  styles: {
    variables: { '--brand': '#123456', '--color-text-primary': 'provider-should-lose' },
    css: { fonts: 'body { color: red }' }
  }
}
const built = buildMcpAppHostContext({ theme: 'light', provider: providerWithExtra })
ok(built.theme === 'light', '合成后 theme 为宿主明确主题')
ok(built.platform === 'desktop' && built.displayMode === 'fullscreen', '不覆盖 provider 的 platform / displayMode')
ok(built.locale === 'zh-CN' && built.timeZone === 'Asia/Shanghai', '保留 provider 的 locale / timeZone')
ok(built.deviceCapabilities?.hover === true, '保留 provider 的 deviceCapabilities')
ok(built.styles?.variables?.['--brand'] === '#123456', '合并 provider 自定义变量')
ok(built.styles?.variables?.['--color-text-primary'] === '#20211F', '标准主题变量覆盖 provider 同名值')
ok(!('css' in (built.styles ?? {})), '不透传 provider 的 styles.css（不放任任意样式注入）')

const defaults = buildMcpAppHostContext({ theme: 'dark' })
ok(defaults.platform === 'desktop' && defaults.displayMode === 'inline', 'provider 缺省时补桌面默认值')
ok(Array.isArray(defaults.availableDisplayModes) && defaults.availableDisplayModes.join(',') === 'inline', '只声明 inline 显示模式')

const badProvider = {
  platform: 'mobile',
  displayMode: 'pip',
  theme: 'light',
  styles: {
    variables: {
      '--ok': 'value',
      color: 'not-a-custom-property',
      '--semi': 'a;b',
      '--newline': 'a\nb',
      '--number': 5
    }
  }
}
const sanitized = buildMcpAppHostContext({ theme: 'dark', provider: badProvider })
ok(sanitized.theme === 'dark', 'provider 的 theme 不能顶掉宿主明确主题')
ok(sanitized.styles.variables['--ok'] === 'value', '合法自定义变量保留')
ok(
  !('color' in sanitized.styles.variables) &&
    !('--semi' in sanitized.styles.variables) &&
    !('--newline' in sanitized.styles.variables) &&
    !('--number' in sanitized.styles.variables),
  '坏键 / 带分号 / 带换行 / 非字符串变量被过滤'
)

const SERVER = 'srv'
const SERVER_CONFIG = {
  id: SERVER,
  transport: 'stdio',
  command: 'node',
  args: ['x.mjs'],
  enabled: true,
  ownedBy: 'inkstone'
}
const FACTS = {
  sessionId: 's1',
  sessionFile: '/sessions/s1.jsonl',
  projectId: 'p1',
  runnerId: 'r1',
  generation: 1,
  cwd: 'C:/proj',
  title: 'Demo App'
}
const RECORD = {
  callId: 'call-1',
  owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 1 },
  serverId: SERVER,
  toolName: 'read',
  text: '',
  resourceUri: 'ui://srv/app.html'
}

function makeService(extra = {}) {
  const options = {
    proxy: {
      getCallResult: () => RECORD,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: () => [],
      refresh: async () => ({ ok: true, toolCount: 0 })
    },
    host: {
      listToolsWithMeta: async () => [],
      callToolWithMeta: async () => ({
        result: { content: [] },
        meta: {},
        structuredContent: null,
        resourceUri: null,
        uiCsp: null,
        isError: false,
        text: ''
      }),
      readResource: async (serverId, uri) => ({
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: '<html></html>',
        bytes: 13,
        meta: null,
        uiCsp: null
      })
    },
    ownerGuard: { isActive: () => true },
    runtime: { resolve: async () => FACTS, currentProject: async () => 'p1' },
    ask: () => 'deny',
    audit: { record: async () => ({}), read: async () => [], clearSession() {} },
    serverConfigOf: (id) => (id === SERVER ? SERVER_CONFIG : null),
    fetchResource: async () => ({ html: '<html></html>', mimeType: 'text/html;profile=mcp-app', bytes: 13, csp: "default-src 'none'" })
  }
  Object.assign(options, extra)
  return new McpAppViewService(options)
}

const rpc = (method, params, id) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

async function initializeContext(service) {
  const prepared = await service.prepare('call-1')
  if (prepared.kind !== 'ready') throw new Error(`prepare 失败：${prepared.kind}`)
  const response = await service.dispatch(prepared.instanceId, rpc('ui/initialize', {}, 1))
  return response?.result?.hostContext
}

await (async () => {
  const context = await initializeContext(makeService())
  ok(context?.theme === MCP_APP_DEFAULT_THEME, '缺省主题回退到宿主默认（非浅色）', String(context?.theme))
  ok(context?.platform === 'desktop' && context?.displayMode === 'inline', '缺省仍有 platform / displayMode')
  ok(
    context?.styles?.variables?.['--color-text-primary'] === '#E8E7E3',
    '首次 initialize 带 hostContext.styles.variables（深色具体值）',
    JSON.stringify(context?.styles?.variables?.['--color-text-primary'])
  )
  ok(
    Object.values(context?.styles?.variables ?? {}).every((value) => !String(value).includes('light-dark(')),
    'initialize 响应里没有 light-dark'
  )

  const lightContext = await initializeContext(makeService({ theme: async () => 'light' }))
  ok(lightContext?.theme === 'light', 'theme provider 生效')
  ok(lightContext?.styles?.variables?.['--color-background-primary'] === '#FFFFFF', '浅色 provider 给出浅色值')

  const providerContext = await initializeContext(
    makeService({
      hostContext: () => ({
        platform: 'desktop',
        displayMode: 'pip',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        locale: 'zh-CN',
        styles: { variables: { '--brand': '#123456', '--color-text-primary': 'provider' }, css: { fonts: 'x' } }
      })
    })
  )
  ok(providerContext?.displayMode === 'pip', '保留 provider 的 displayMode，不被主题覆盖')
  ok(providerContext?.locale === 'zh-CN', '保留 provider 的 locale')
  ok(providerContext?.styles?.variables?.['--brand'] === '#123456', '合并 provider 自定义变量')
  ok(
    providerContext?.styles?.variables?.['--color-text-primary'] === '#E8E7E3',
    '标准主题变量覆盖 provider 同名值'
  )
  ok(!('css' in (providerContext?.styles ?? {})), 'provider 的 styles.css 不透传')

  const throwing = await initializeContext(
    makeService({
      hostContext: () => {
        throw new Error('provider boom')
      },
      theme: () => {
        throw new Error('theme boom')
      }
    })
  )
  ok(throwing?.platform === 'desktop' && throwing?.theme === MCP_APP_DEFAULT_THEME, 'provider / theme 抛错时仍返回可用宿主上下文')
  ok(typeof throwing?.styles?.variables?.['--color-text-primary'] === 'string', '抛错回退也带主题变量')

  const providerTheme = await initializeContext(makeService({ hostContext: () => ({ theme: 'light' }) }))
  ok(providerTheme?.theme === 'light', '无显式 provider 时 theme 字段可作为主题线索')
})()

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
}

async function themeUpdateSuite() {
let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
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

const themeUpdate = await loadTs('../src/renderer/src/features/artifacts/mcp-app-theme-update.ts')
const channelModule = await loadTs('../src/renderer/src/features/artifacts/mcp-app-channel.ts')

let serviceModule
try {
  const bundled = await build({
    stdin: {
      contents:
        "export * from './src/main/mcp/app-view-service';" + "export * from './src/main/mcp/app-theme';",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  serviceModule = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
} catch (error) {
  console.error(`无法加载主进程模块：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { McpAppViewService, resolveMcpAppThemePreference, MCP_APP_DEFAULT_THEME } = serviceModule
ok(typeof McpAppViewService === 'function', '加载 McpAppViewService')
ok(typeof resolveMcpAppThemePreference === 'function', '加载 resolveMcpAppThemePreference')

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

function makeLoader() {
  const pending = []
  const call = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  return {
    call,
    pending,
    count: () => pending.length,
    resolveAt(index, value) {
      pending[index].resolve(value)
    },
    rejectAt(index, error) {
      pending[index].reject(error)
    }
  }
}

function makeChannel(overrides = {}) {
  const win = fakeWindow()
  const frame = fakeFrame()
  const calls = []
  const loader = overrides.loader ?? makeLoader()
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
    api,
    window: win,
    getFrame: () => frame,
    now: () => 1000,
    loadHostContext: 'loadHostContext' in overrides ? overrides.loadHostContext : loader.call,
    ...(overrides.expectedOrigin ? { expectedOrigin: overrides.expectedOrigin } : {})
  })
  return {
    win,
    frame,
    calls,
    channel,
    loader,
    settle(result) {
      const resolve = resolveNext
      resolveNext = null
      resolve({ jsonrpc: '2.0', id: lastMessage?.id ?? null, result })
    },
    async ready() {
      this.win.emit({
        data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} },
        origin: 'null',
        source: this.frame
      })
      this.settle({ hostContext: { theme: 'dark' } })
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

{
  const doc = (value) => ({ getAttribute: (name) => (name === 'data-theme' ? value : null) })
  ok(themeUpdate.readMcpAppResolvedTheme(doc('light')) === 'light', 'data-theme=light 读到浅色')
  ok(themeUpdate.readMcpAppResolvedTheme(doc('dark')) === 'dark', 'data-theme=dark 读到深色')
  ok(
    themeUpdate.readMcpAppResolvedTheme(doc(null), true) === 'dark',
    '没有 data-theme 时按系统偏好深色'
  )
  ok(
    themeUpdate.readMcpAppResolvedTheme(doc(null), false) === 'light',
    '没有 data-theme 且系统浅色时读浅色'
  )
  ok(themeUpdate.MCP_APP_DARK_QUERY === '(prefers-color-scheme: dark)', '深色查询串固定')
}

{
  let attr = 'dark'
  let observerCallback = null
  let observedOptions = null
  let disconnected = false
  const mediaListeners = new Set()
  const media = {
    matches: false,
    addEventListener(type, fn) {
      if (type === 'change') mediaListeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'change') mediaListeners.delete(fn)
    }
  }
  const docEl = { getAttribute: (name) => (name === 'data-theme' ? attr : null) }
  const fired = []
  const watcher = themeUpdate.createMcpAppThemeWatcher(
    {
      documentElement: docEl,
      createObserver: (callback) => {
        observerCallback = callback
        return {
          observe(target, options) {
            observedOptions = options
          },
          disconnect() {
            disconnected = true
          }
        }
      },
      matchMedia: (query) => (query === themeUpdate.MCP_APP_DARK_QUERY ? media : null)
    },
    (theme) => fired.push(theme)
  )
  ok(fired.length === 0, 'watcher 建立时不回调（初值不算变化）')
  ok(observedOptions?.attributeFilter?.includes('data-theme') === true, '只观察 data-theme 属性')
  ok(watcher.current() === 'dark', 'current() 读到初值')

  attr = 'light'
  observerCallback()
  ok(fired.length === 1 && fired[0] === 'light', '属性变化回调一次，值为新主题')
  observerCallback()
  ok(fired.length === 1, '同值重复触发不回调')

  attr = null
  media.matches = true
  for (const fn of [...mediaListeners]) fn()
  ok(fired.length === 2 && fired[1] === 'dark', '无 data-theme 时系统偏好变化回调深色')

  watcher.dispose()
  ok(disconnected && mediaListeners.size === 0, 'dispose 断开 observer 并移除 matchMedia 监听')
  attr = 'light'
  observerCallback?.()
  ok(fired.length === 2, 'dispose 后属性变化不再回调')
}

{
  const env = makeChannel()
  env.channel.attach()
  await env.ready()
  ok(env.channel.getPhase() === 'ready', 'init 合法结果后进入 ready')
  const postedBefore = env.frame.posted.length
  const dispatchBefore = env.calls.length

  env.channel.requestHostContext()
  ok(env.loader.count() === 1, 'ready 时请求会真正读一次宿主上下文')
  env.loader.resolveAt(0, { theme: 'light', styles: { variables: { '--brand': '#fff' } } })
  await tick()

  const pushed = env.frame.posted.at(-1).message
  ok(env.frame.posted.length === postedBefore + 1, '恰好推送一条通知')
  ok(pushed.method === 'ui/notifications/host-context-changed', '推送方法名正确', pushed.method)
  ok(pushed.params?.theme === 'light' && pushed.params?.styles?.variables?.['--brand'] === '#fff', '原样携带宿主上下文')
  ok(!('id' in pushed), '通知不带 id（不是请求）')
  ok(env.calls.length === dispatchBefore, '主题通知不产生任何工具调用 / dispatch')
}

{
  const env = makeChannel()
  env.channel.attach()
  const port = fakePort()
  env.win.emit({
    data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} },
    origin: 'null',
    source: env.frame,
    ports: [port]
  })
  env.settle({ hostContext: {} })
  await tick()
  ok(port.started && port.posted.length === 1 && env.frame.posted.length === 0, '初始化采纳 MessagePort，应答经端口回投')

  env.channel.requestHostContext()
  env.loader.resolveAt(0, { theme: 'dark' })
  await tick()
  ok(port.posted.at(-1)?.method === 'ui/notifications/host-context-changed', '就绪后主题通知经 MessagePort')
  ok(env.frame.posted.length === 0, '不再走 frame.postMessage（端口已接管）')
}

{
  const env = makeChannel()
  env.channel.attach()
  env.channel.requestHostContext()
  ok(env.loader.count() === 0, '未 ready 时不读宿主上下文（只记待发）')
  env.win.emit({ data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }, origin: 'null', source: env.frame })
  env.settle({ hostContext: {} })
  await tick()
  ok(env.loader.count() === 1, '握手完成后补读一次宿主上下文')
  env.loader.resolveAt(0, { theme: 'light' })
  await tick()
  ok(env.frame.posted.at(-1).message.method === 'ui/notifications/host-context-changed', '补发 host-context-changed')
}

{
  const env = makeChannel()
  env.channel.attach()
  await env.ready()
  const postedBefore = env.frame.posted.length
  env.channel.requestHostContext()
  env.channel.requestHostContext()
  ok(env.loader.count() === 2, '两次请求各读一次')
  env.loader.resolveAt(0, { theme: 'light' })
  await tick()
  ok(env.frame.posted.length === postedBefore, '被新请求覆盖的旧回包不投递')
  env.loader.resolveAt(1, { theme: 'dark' })
  await tick()
  ok(env.frame.posted.length === postedBefore + 1, '只投递最新一次结果')
  ok(env.frame.posted.at(-1).message.params.theme === 'dark', '投递的是最新主题')
}

{
  const env = makeChannel()
  env.channel.attach()
  await env.ready()
  const postedBefore = env.frame.posted.length
  env.channel.requestHostContext()
  env.channel.nextGeneration()
  ok(env.channel.getPhase() === 'idle', '换代把手握重置为 idle')
  env.loader.resolveAt(0, { theme: 'light' })
  await tick()
  ok(env.frame.posted.length === postedBefore, '换代后旧代主题回包不投递')
}

{
  const env = makeChannel()
  env.channel.attach()
  const port = fakePort()
  env.win.emit({
    data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} },
    origin: 'null',
    source: env.frame,
    ports: [port]
  })
  env.settle({ hostContext: {} })
  await tick()
  env.channel.requestHostContext()
  const postedBefore = port.posted.length
  env.channel.dispose()
  env.loader.resolveAt(0, { theme: 'light' })
  await tick()
  ok(port.posted.length === postedBefore, 'dispose 后迟到的主题回包不投递')
  ok(port.closed && env.win.listeners.size === 0, 'dispose 关闭 MessagePort 并移除 window 监听')
}

{
  const env = makeChannel()
  env.channel.attach()
  await env.ready()
  const postedBefore = env.frame.posted.length
  env.channel.requestHostContext()
  env.loader.resolveAt(0, null)
  await tick()
  ok(env.frame.posted.length === postedBefore, '宿主返回 null（实例不存在 / 归属失效）时不推通知')

  const env2 = makeChannel()
  env2.channel.attach()
  await env2.ready()
  const posted2 = env2.frame.posted.length
  env2.channel.requestHostContext()
  env2.loader.rejectAt(0, new Error('boom'))
  await tick()
  ok(env2.frame.posted.length === posted2, '读取失败不推通知')
}

{
  const env = makeChannel()
  env.channel.attach()
  await env.ready()
  const dispatchBefore = env.calls.length
  env.win.emit({ data: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} }, origin: 'https://evil', source: env.frame })
  ok(env.calls.length === dispatchBefore, '非期望 origin 的消息不派发（主题链路不放宽来源判定）')
}

{
  ok(resolveMcpAppThemePreference('system', true) === 'dark', 'system + 系统深色 → dark')
  ok(resolveMcpAppThemePreference('system', false) === 'light', 'system + 系统浅色 → light')
  ok(resolveMcpAppThemePreference('light', true) === 'light', '显式浅色不被系统偏好覆盖')
  ok(resolveMcpAppThemePreference('dark', false) === 'dark', '显式深色不被系统偏好覆盖')
  ok(resolveMcpAppThemePreference('weird', true) === 'dark', '未知偏好回退默认')
  ok(MCP_APP_DEFAULT_THEME === 'dark', '默认仍是深色')
}

const SERVER = 'srv'
const SERVER_CONFIG = { id: SERVER, transport: 'stdio', command: 'node', args: ['x.mjs'], enabled: true, ownedBy: 'inkstone' }
const FACTS = {
  sessionId: 's1',
  sessionFile: '/sessions/s1.jsonl',
  projectId: 'p1',
  runnerId: 'r1',
  generation: 1,
  cwd: 'C:/proj',
  title: 'Demo App'
}
const RECORD = {
  callId: 'call-1',
  owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 1 },
  serverId: SERVER,
  toolName: 'read',
  text: '',
  resourceUri: 'ui://srv/app.html'
}

function makeService(extra = {}) {
  const options = {
    proxy: {
      getCallResult: () => RECORD,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: () => [],
      refresh: async () => ({ ok: true, toolCount: 0 })
    },
    host: {
      listToolsWithMeta: async () => [],
      callToolWithMeta: async () => ({
        result: { content: [] },
        meta: {},
        structuredContent: null,
        resourceUri: null,
        uiCsp: null,
        isError: false,
        text: ''
      }),
      readResource: async (serverId, uri) => ({
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: '<html></html>',
        bytes: 13,
        meta: null,
        uiCsp: null
      })
    },
    ownerGuard: { isActive: () => true },
    runtime: { resolve: async () => FACTS, currentProject: async () => 'p1' },
    ask: () => 'deny',
    audit: { record: async () => ({}), read: async () => [], clearSession() {} },
    serverConfigOf: (id) => (id === SERVER ? SERVER_CONFIG : null),
    fetchResource: async () => ({
      html: '<html></html>',
      mimeType: 'text/html;profile=mcp-app',
      bytes: 13,
      csp: "default-src 'none'"
    })
  }
  Object.assign(options, extra)
  return new McpAppViewService(options)
}

const rpc = (method, params, id) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

await (async () => {
  const dark = makeService({ theme: async () => 'system', systemPrefersDark: () => true })
  const darkPrepared = await dark.prepare('call-1')
  const darkInit = await dark.dispatch(darkPrepared.instanceId, rpc('ui/initialize', {}, 1))
  ok(darkInit?.result?.hostContext?.theme === 'dark', 'system + 系统深色：initialize 下发 dark（不是兜底）')
  ok(
    darkInit?.result?.hostContext?.styles?.variables?.['--color-text-primary'] === '#E8E7E3',
    'system 深色初始化仍带明确主题变量'
  )

  const light = makeService({ theme: async () => 'system', systemPrefersDark: () => false })
  const lightPrepared = await light.prepare('call-1')
  const lightInit = await light.dispatch(lightPrepared.instanceId, rpc('ui/initialize', {}, 1))
  ok(lightInit?.result?.hostContext?.theme === 'light', 'system + 系统浅色：initialize 下发 light')
  ok(
    lightInit?.result?.hostContext?.styles?.variables?.['--color-background-primary'] === '#FFFFFF',
    'system 浅色初始化带浅色变量'
  )

  const svc = makeService({ theme: async () => 'light' })
  const prepared = await svc.prepare('call-1')
  const init = await svc.dispatch(prepared.instanceId, rpc('ui/initialize', {}, 1))
  const live = await svc.hostContext(prepared.instanceId)
  ok(live?.theme === 'light', 'hostContext() 读到明确主题')
  assert.deepEqual(live, init.result.hostContext)
  ok(true, 'hostContext() 与 ui/initialize 返回同一份宿主上下文')
  ok(
    live?.styles?.variables?.['--color-text-primary'] === '#20211F',
    'hostContext() 复用 M1 同源主题变量'
  )

  ok((await svc.hostContext('missing-instance')) === null, '未知实例返回 null')
  ok((await svc.hostContext('')) === null, '空实例号返回 null')

  let active = true
  const guarded = makeService({ ownerGuard: { isActive: () => active }, theme: async () => 'light' })
  const guardedPrepared = await guarded.prepare('call-1')
  ok((await guarded.hostContext(guardedPrepared.instanceId))?.theme === 'light', '归属活跃时可读')
  active = false
  ok((await guarded.hostContext(guardedPrepared.instanceId)) === null, '归属失效后 hostContext() 返回 null')
  ok(
    (await guarded.dispatch(guardedPrepared.instanceId, rpc('ui/initialize', {}, 2)))?.result === undefined,
    '归属失效后 initialize 仍被拒（不放宽 owner）'
  )

  ok((await svc.hostContext(prepared.instanceId)) !== null, 'release 前可读')
  await svc.release(prepared.instanceId)
  ok((await svc.hostContext(prepared.instanceId)) === null, 'release 后 hostContext() 返回 null')

  const closed = makeService({ theme: async () => 'light' })
  const closedPrepared = await closed.prepare('call-1')
  ok((await closed.hostContext(closedPrepared.instanceId)) !== null, 'close 前可读')
  closed.close()
  ok((await closed.hostContext(closedPrepared.instanceId)) === null, 'close 后 hostContext() 返回 null')
})()

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
}

console.log('\n=====mcp-app-frame =====')
await isolated(frameSuite)
console.log('\n=====mcp-app-render =====')
await isolated(renderSuite)
console.log('\n=====v3-mcp-app-theme =====')
await isolated(themeSuite)
console.log('\n=====v3-mcp-app-theme-update =====')
await isolated(themeUpdateSuite)

process.exit(0)
