import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpUiInitializeResultSchema } from '@modelcontextprotocol/ext-apps/app-bridge'
import { connectOfficialApp, fakeWindow, LATEST_PROTOCOL_VERSION, waitFor } from './mcp-app-sdk-fixture.mjs'

export async function sdkSuite() {
  await mkdir('.tmp/mcp-apps', { recursive: true })
  const outfile = resolve('.tmp/mcp-apps/renderer-sdk.mjs')
  await build({ entryPoints: ['src/renderer/src/features/artifacts/mcp-app-channel.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
  const { McpAppChannel } = await import(pathToFileURL(outfile).href)
  const calls = []
  let theme = 'dark'
  let contextLoader = async () => ({ theme })
  const modes = []
  const sizes = []
  const rejected = []
  let teardown = false
  const api = { async dispatch(instanceId, message) {
    calls.push({ instanceId, ...message })
    let result = {}
    switch (message.method) {
      case 'inkstone/activate': result = { hostContext: { theme }, hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, downloadFile: {}, message: { text: {} }, sandbox: { permissions: {} } } }; break
      case 'inkstone/tool-data': result = { arguments: { input: 'original' }, result: { content: [{ type: 'text', text: 'initial result' }], _meta: { private: true } } }; break
      case 'tools/call': result = { content: [{ type: 'text', text: 'approved' }], structuredContent: { value: 42 }, _meta: { private: true } }; break
      case 'tools/list': result = { tools: [{ name: 'app-tool', inputSchema: { type: 'object' } }] }; break
      case 'resources/list': result = { resources: [{ uri: 'ui://fixture/app', name: 'app' }] }; break
      case 'resources/read': result = { contents: [{ uri: 'ui://fixture/app', text: 'resource' }] }; break
    }
    return { jsonrpc: '2.0', id: message.id, result }
  } }
  const env = await connectOfficialApp(McpAppChannel, { instanceId: 'instance', api, loadHostContext: () => contextLoader(), hooks: { onDisplayMode: (mode) => modes.push(mode), onSizeChanged: (height) => sizes.push(height), onRejected: (reason) => rejected.push(reason) } })
  const { app, channel, frame, win } = env
  assert.equal(channel.getPhase(), 'ready')
  const initialize = frame.posted.find((message) => message.result?.hostInfo)
  assert.ok(McpUiInitializeResultSchema.safeParse(initialize.result).success)
  assert.equal(initialize.result.protocolVersion, LATEST_PROTOCOL_VERSION)
  assert.equal(initialize.result.hostInfo.name, 'Inkstone')
  assert.deepEqual(initialize.result.hostContext.availableDisplayModes, ['inline', 'fullscreen', 'pip'])
  assert.deepEqual(initialize.result.hostCapabilities.sandbox.permissions, {})
  assert.ok(!initialize.result.hostCapabilities.sampling && !initialize.result.hostCapabilities.updateModelContext)
  await waitFor(() => frame.posted.some((message) => message.method === 'ui/notifications/tool-result'))
  assert.ok(frame.posted.some((message) => message.method === 'ui/notifications/tool-input' && message.params.arguments.input === 'original'))
  await env.transport.send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(frame.posted.filter((message) => message.method === 'ui/notifications/tool-input').length, 1)
  const result = await app.callServerTool({ name: 'app-tool', arguments: { n: 1 } })
  assert.equal(result.structuredContent.value, 42)
  assert.equal(result._meta.private, true)
  assert.equal((await app.readServerResource({ uri: 'ui://fixture/app' })).contents[0].text, 'resource')
  assert.equal((await app.listServerResources()).resources.length, 1)
  await env.transport.send({ jsonrpc: '2.0', id: 'templates', method: 'resources/templates/list', params: {} })
  await waitFor(() => frame.posted.some((message) => message.id === 'templates'))
  assert.deepEqual(frame.posted.find((message) => message.id === 'templates').result.resourceTemplates, [])
  for (const mode of ['fullscreen', 'pip', 'inline']) assert.equal((await app.requestDisplayMode({ mode })).mode, mode)
  assert.deepEqual(modes, ['fullscreen', 'pip', 'inline'])
  assert.deepEqual(await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] }), {})
  assert.deepEqual(await app.openLink({ url: 'https://example.com' }), {})
  assert.deepEqual(await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: 'file:///export.txt', text: 'hello' } }] }), {})
  theme = 'light'
  channel.requestHostContext()
  channel.setContainerDimensions(640, 480)
  await waitFor(() => frame.posted.some((message) => message.method === 'ui/notifications/host-context-changed' && message.params.theme === 'light'))
  assert.ok(frame.posted.some((message) => message.params?.containerDimensions?.width === 640))
  let staleContext
  contextLoader = () => new Promise((resolve) => { staleContext = resolve })
  channel.requestHostContext()
  contextLoader = async () => ({ theme: 'light', locale: 'zh-CN' })
  channel.requestHostContext()
  await waitFor(() => frame.posted.some((message) => message.params?.locale === 'zh-CN'))
  const contextCount = frame.posted.length
  staleContext({ theme: 'dark' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(frame.posted.length, contextCount)
  const notification = { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 240, width: 800 } }
  win.emit({ data: notification, origin: 'null', source: frame })
  await waitFor(() => sizes.length > 0)
  assert.equal(sizes[0], 240)
  const count = calls.length
  const attack = { jsonrpc: '2.0', method: 'tools/call', id: 'attack', params: { name: 'app-tool' } }
  win.emit({ data: attack, origin: 'https://evil.example', source: frame })
  win.emit({ data: attack, origin: 'null', source: {} })
  win.emit({ data: { ...attack, params: { huge: 'x'.repeat(1024 * 1024) } }, origin: 'null', source: frame })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, count)
  assert.ok(rejected.includes('origin') && rejected.includes('source') && rejected.includes('size'))
  win.emit({ data: attack, origin: 'null', source: frame })
  win.emit({ data: attack, origin: 'null', source: frame })
  await waitFor(() => calls.length === count + 1)
  assert.ok(rejected.includes('duplicate'))
  for (let i = 0; i < 1000; i++) win.emit({ data: notification, origin: 'null', source: frame })
  assert.ok(rejected.includes('limit'))
  app.onteardown = async () => { teardown = true; return {} }
  channel.dispose()
  await waitFor(() => teardown && win.listeners.size === 0)
  await app.close()
  assert.equal(channel.getPhase(), 'closed')

  let appTeardown = false
  const requested = await connectOfficialApp(McpAppChannel, { instanceId: 'request-teardown', api, hooks: { onTeardown: () => { appTeardown = true } } })
  requested.app.onteardown = async () => ({})
  await requested.app.requestTeardown()
  await waitFor(() => appTeardown && requested.win.listeners.size === 0)
  assert.equal(requested.channel.getPhase(), 'closed')
  await requested.app.close()

  const earlyWin = fakeWindow()
  const earlyFrame = { posted: [], postMessage(message) { this.posted.push(message) } }
  const earlyCalls = []
  const early = new McpAppChannel({ instanceId: 'early', api: { async dispatch(_id, message) { earlyCalls.push(message); return { jsonrpc: '2.0', id: message.id, result: { hostContext: {} } } } }, window: earlyWin, getFrame: () => earlyFrame })
  early.attach()
  await waitFor(() => early.getPhase() === 'initializing')
  earlyWin.emit({ origin: 'null', source: earlyFrame, data: attack })
  await waitFor(() => earlyFrame.posted.some((message) => message.error))
  assert.equal(earlyCalls.length, 1)
  earlyWin.emit({ origin: 'null', source: earlyFrame, data: { jsonrpc: '2.0', id: 'invalid-init', method: 'ui/initialize', params: {} } })
  await waitFor(() => earlyFrame.posted.some((message) => message.id === 'invalid-init' && message.error))
  assert.notEqual(early.getPhase(), 'ready')
  earlyWin.emit({ origin: 'null', source: earlyFrame, data: { jsonrpc: '2.0', id: 'valid-init', method: 'ui/initialize', params: { appInfo: { name: 'test', version: '1' }, appCapabilities: {}, protocolVersion: 'unknown-version' } } })
  await waitFor(() => earlyFrame.posted.some((message) => message.id === 'valid-init' && message.result))
  assert.equal(earlyFrame.posted.find((message) => message.id === 'valid-init').result.protocolVersion, LATEST_PROTOCOL_VERSION)
  assert.notEqual(early.getPhase(), 'ready')
  await early.dispose()
  const transportFile = resolve('.tmp/mcp-apps/guarded-transport.mjs')
  await build({ entryPoints: ['src/renderer/src/features/artifacts/mcp-app-transport.ts'], outfile: transportFile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
  const { McpAppTransport } = await import(pathToFileURL(transportFile).href)
  const transportWindow = fakeWindow()
  const firstFrame = { posted: [], postMessage(message) { this.posted.push(message) } }
  const replacementFrame = { posted: [], postMessage(message) { this.posted.push(message) } }
  let targetFrame = firstFrame
  let received = 0
  const guarded = new McpAppTransport(transportWindow, () => targetFrame, () => {})
  guarded.onmessage = () => { received++ }
  await guarded.start()
  targetFrame = replacementFrame
  transportWindow.emit({ data: notification, origin: 'null', source: replacementFrame })
  assert.equal(received, 0)
  await guarded.send({ jsonrpc: '2.0', id: 7, method: 'ui/resource-teardown', params: {} })
  assert.equal(firstFrame.posted.length, 1)
  assert.equal(replacementFrame.posted.length, 0)
  await guarded.close()

  const watcherFile = resolve('.tmp/mcp-apps/theme-watcher.mjs')
  await build({ entryPoints: ['src/renderer/src/features/artifacts/mcp-app-theme-update.ts'], outfile: watcherFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { createMcpAppThemeWatcher } = await import(pathToFileURL(watcherFile).href)
  let attr = 'dark'
  let mutation
  let disconnected = false
  let removed = false
  const changes = []
  const media = { matches: false, addEventListener(_type, fn) { this.listener = fn }, removeEventListener() { removed = true } }
  const watcher = createMcpAppThemeWatcher({
    documentElement: { getAttribute: () => attr },
    createObserver: (callback) => { mutation = callback; return { observe() {}, disconnect() { disconnected = true } } },
    matchMedia: () => media
  }, (value) => changes.push(value))
  assert.equal(watcher.current(), 'dark')
  mutation()
  assert.equal(changes.length, 0)
  attr = 'light'
  mutation()
  assert.deepEqual(changes, ['light'])
  attr = 'system'
  media.matches = true
  media.listener()
  assert.deepEqual(changes, ['light', 'dark'])
  watcher.dispose()
  attr = 'light'
  mutation()
  assert.ok(disconnected && removed)
  assert.equal(changes.length, 2)
  console.log('✓ 官方 App ↔ AppBridge：握手/能力、初始化顺序、工具与资源、消息/链接/下载、三种显示模式、主题/尺寸、teardown 和来源/重放/体积守卫')
}
