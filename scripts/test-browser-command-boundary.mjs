import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({
  entryPoints: ['src/main/browser-commands.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const { BrowserCommands } = mod

let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks++
}
const failure = async (work) => {
  try {
    await work
  } catch (error) {
    return error
  }
  return null
}

const pageState = () => ({ activeTabId: 'tab-1', tabs: [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }], userControl: false })
const observation = () => ({ url: 'https://example.com', title: 'Example', text: 'hello', elements: [{ ref: 'e1', role: 'button', name: 'Go' }], state: 'ready' })

const makeHost = (overrides = {}) => {
  const state = pageState()
  const calls = { owners: [], clicks: 0, observed: 0 }
  const host = {
    getState: () => ({ ...state }),
    forSession: () => host,
    setAutomationOwner: (owner) => { calls.owners.push(owner) },
    setAgentSession: () => undefined,
    observe: async () => { calls.observed++; return observation() },
    navigate: async (url) => { state.activeTabId = state.activeTabId ?? 'tab-1'; return { ok: true, url } },
    click: async () => { calls.clicks++; return { ok: true, observation: observation() } },
    type: async () => ({ ok: true, observation: observation() }),
    press: async () => ({ ok: true, observation: observation() }),
    scroll: async () => ({ ok: true, observation: observation() }),
    select: async () => ({ ok: true, observation: observation() }),
    back: async () => ({ ok: true }),
    forward: async () => ({ ok: true }),
    reload: async () => ({ ok: true }),
    newTab: async () => { state.activeTabId = 'tab-2'; return { ...state } },
    switchTab: async (id) => { state.activeTabId = id; return { ...state } },
    closeTab: async () => { state.activeTabId = 'tab-2'; return { ...state } },
    screenshot: async () => ({ mimeType: 'image/png', data: Buffer.from([1]) }),
    network: async () => ({ capturedAt: 1, entries: [], limit: 10 }),
    requestUserControl: async () => ({ ...state, userControl: true }),
    openExternalChrome: async () => ({ ok: true }),
    closeExternalChrome: async () => undefined,
    getOwnedDownload: (owner) => { calls.downloadOwner = owner; return null },
    pendingDownloads: () => [],
    ...overrides,
    state,
    calls
  }
  return host
}

{
  const commands = new BrowserCommands({ browserHostOrNull: () => null, capabilityOpts: () => undefined })
  const error = await failure(commands.runBrowserCommand('state', {}))
  ok(error && error.code === 'browser_unavailable', '宿主不可用时明确报浏览器不可用')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({
    browserHostOrNull: () => host,
    capabilityOpts: () => ({ sessionId: 'session-a', runnerGeneration: 3 }),
    isActive: () => false
  })
  const error = await failure(commands.runBrowserCommand('state', {}))
  ok(error && error.code === 'run_expired', '运行已改变时排队中的浏览器操作不执行')
}

{
  const host = makeHost()
  host.state.userControl = true
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's' }) })
  const blocked = await failure(commands.runBrowserCommand('navigate', { url: 'https://example.com/a' }))
  ok(blocked && blocked.code === 'USER_CONTROL_ACTIVE', '用户接管时拒绝模型改页面')
  const allowed = await failure(commands.runBrowserCommand('observe', {}))
  ok(allowed === null, '用户接管时仍允许只读观察')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 1 }) })
  const fresh = await failure(commands.runBrowserCommand('observe', {}))
  ok(fresh === null && host.calls.observed === 1, '观察成功')
  const stale = await failure(commands.runBrowserCommand('click', { ref: 'e-missing' }))
  ok(stale && stale.code === 'STALE_ELEMENT', '未观察过的元素引用被拒绝')
  const click = await failure(commands.runBrowserCommand('click', { ref: 'e1' }))
  ok(click === null && host.calls.clicks === 1, '观察过的元素引用可以点击')
  ok(host.calls.owners.some((owner) => typeof owner === 'string' && owner.startsWith('s:1:')), '点击时把自动化归属绑定到本次运行身份')
  ok(host.calls.owners.at(-1) === undefined, '动作结束后清除自动化归属')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 1 }) })
  await failure(commands.runBrowserCommand('observe', {}))
  host.state.activeTabId = 'tab-2'
  const error = await failure(commands.runBrowserCommand('click', { ref: 'e1' }))
  ok(error && error.code === 'STALE_TARGET', '目标标签变化后拒绝沿用旧 ref 操作')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 1 }) })
  await failure(commands.runBrowserCommand('observe', {}))
  await failure(commands.runBrowserCommand('new-tab', {}))
  const error = await failure(commands.runBrowserCommand('click', { ref: 'e1' }))
  ok(error && error.code === 'STALE_ELEMENT', '新标签后旧元素引用失效')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 1 }) })
  await failure(commands.runBrowserCommand('observe', {}))
  const other = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 'other', runnerGeneration: 2 }) })
  const error = await failure(other.runBrowserCommand('click', { ref: 'e1' }))
  ok(error && error.code === 'STALE_ELEMENT', '另一个运行身份不会复用前一个运行的元素引用')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 7 }) })
  await failure(commands.runBrowserCommand('download', {}))
  ok(typeof host.calls.downloadOwner === 'string' && host.calls.downloadOwner.startsWith('s:7:'), '下载回执按运行身份与实例归属')
}

{
  const host = makeHost()
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 1 }) })
  const missing = await failure(commands.runBrowserCommand('navigate', {}))
  ok(missing && missing.code === 'missing_url', '导航缺地址时明确报错')
  await failure(commands.runBrowserCommand('observe', {}))
  const badNumber = await failure(commands.runBrowserCommand('scroll', { 'delta-y': 'abc' }))
  ok(badNumber && badNumber.code === 'invalid_number', '滚动量必须是数字')
}

console.log(`browser-command-boundary: ${checks} assertions passed (fake host, no Electron)`)
