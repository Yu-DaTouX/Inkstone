import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

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
