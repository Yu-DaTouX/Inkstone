#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { runSuite } from './lib/test-suite.mjs'

const ENTRY = [
  "export { BrowserCommands } from './src/main/browser-commands.ts'",
  "export { userBrowser } from './src/main/user-browser/service.ts'",
  "export * from './src/main/user-browser/native-host.ts'",
  "export { BrowserBridgeServer, BridgeCallError, BRIDGE_REVISION } from './src/main/user-browser/bridge-server.ts'",
  "export { UserBrowserSession, parseUserTabId, userTabId } from './src/main/user-browser/session-host.ts'",
  "export { approvalSessionGrantable } from './src/shared/approval.ts'"
].join('\n')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeExtension(port, token, hello, handlers) {
  const calls = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/browser-bridge?token=${token}`)
  ws.on('open', () => ws.send(JSON.stringify({ event: 'hello', ...hello })))
  ws.on('message', async (data) => {
    const { id, cmd, args } = JSON.parse(String(data))
    calls.push({ cmd, args })
    const handler = handlers[cmd]
    try {
      if (!handler) throw Object.assign(new Error(`no handler ${cmd}`), { code: 'UNKNOWN_COMMAND' })
      ws.send(JSON.stringify({ id, ok: true, result: await handler(args) }))
    } catch (error) {
      ws.send(JSON.stringify({ id, ok: false, code: error.code ?? 'EXTENSION_ERROR', error: error.message }))
    }
  })
  return { ws, calls, closed: new Promise((r) => ws.on('close', r)) }
}

function pageHandlers(state) {
  const tab = (tabId, url = state.url) => ({ tabId, windowId: 1, url, title: `T ${url}`, status: 'complete', active: true })
  return {
    'tab.create': ({ url }) => { state.url = url; return tab(state.next++, url) },
    'tab.navigate': ({ tabId, url }) => { state.url = url; return tab(tabId, url) },
    'tab.wait': ({ tabId }) => tab(tabId),
    'tab.info': ({ tabId }) => {
      if (state.gone.has(tabId)) return null
      if (state.current && tabId === state.current.tabId) return state.current
      return tab(tabId)
    },
    'tab.current': () => state.current,
    'tab.close': ({ tabId }) => { state.closed.push(tabId); return true },
    'cdp.detach': () => true,
    'page.observe': () => ({ url: state.url, title: 'Page', text: 'hello text', elements: [{ ref: 'a1', role: 'button', name: 'Go', box: [10, 10, 40, 20] }, { ref: 'a2', role: 'textbox', name: 'Query', box: [10, 40, 100, 20], value: '' }, { ref: 'a9', role: 'button', name: 'Behind', box: [0, 0, 5, 5] }], viewport: { width: 800, height: 600 }, frameCount: 1, observedFrameCount: 1 }),
    'page.point': ({ ref }) => (ref === 'a9' ? { x: 1, y: 1, obscuredBy: 'div.modal' } : { x: 30, y: 20 }),
    'page.click': () => ({ ok: true }),
    'page.focus': () => ({ ok: true }),
    'page.type': ({ text }) => ({ ok: true, value: text }),
    'page.readValue': () => 'typed',
    'page.select': ({ value }) => (value === 'x' ? { error: 'option_not_found', options: ['a', 'b'] } : { ok: true, value, label: value.toUpperCase() }),
    'page.press': () => ({ ok: true }),
    'page.scroll': () => ({ x: 0, y: 300, maxY: 900 }),
    'page.text': () => ({ text: 'hello text', url: state.url, title: 'Page' }),
    'page.screenshot': () => ({ data: Buffer.from('png').toString('base64') }),
    'page.cursor': (args) => { state.cursor.push(args); return 0 },
    cdp: ({ method, params }) => { state.cdp.push({ method, params }); return {} }
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile(null, { stdin: { contents: ENTRY, resolveDir: resolve('.'), loader: 'ts' } })
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-user-browser-'))
  try {
    ok(mod.shouldRegisterBridge({}, 'win32', 'C:\\Users\\u\\.pi\\agent\\yan', 'c:/users/u/.pi/agent/yan') === true, '默认数据目录在 Windows 上注册')
    ok(mod.shouldRegisterBridge({}, 'win32', 'D:/iso', 'C:\\Users\\u\\.pi\\agent\\yan') === false, '隔离数据目录不注册，避免覆盖用户的注册表项')
    ok(mod.shouldRegisterBridge({ YAN_BROWSER_BRIDGE_REGISTER: '1' }, 'win32', 'D:/iso', 'C:\\Users\\u\\.pi\\agent\\yan') === true, '显式开关可在隔离目录注册')
    ok(mod.shouldRegisterBridge({ YAN_BROWSER_BRIDGE_REGISTER: '0' }, 'win32', 'C:\\Users\\u\\.pi\\agent\\yan', 'C:\\Users\\u\\.pi\\agent\\yan') === false, '显式关闭开关时不注册')
    ok(mod.shouldRegisterBridge({}, 'linux', '/u/.pi/agent/yan', '/u/.pi/agent/yan') === false, '非 Windows 不注册')
    ok(mod.shouldRegisterBridge({}, 'win32', '', 'C:\\Users\\u\\.pi\\agent\\yan') === false, '缺少数据目录时不注册')
    ok(mod.approvalSessionGrantable({ kind: 'consent', tool: 'browser', sessionGrant: false }) === false, 'sessionGrant:false 禁止本会话批量放行')

    const chromium = mod.hostManifest('chromium', 'C:/x/host.cmd')
    const firefox = mod.hostManifest('firefox', 'C:/x/host.cmd')
    ok(chromium.allowed_origins?.[0] === `chrome-extension://${mod.CHROMIUM_EXTENSION_ID}/` && !chromium.allowed_extensions, 'Chromium 清单只放行固定扩展 ID')
    ok(firefox.allowed_extensions?.[0] === mod.FIREFOX_EXTENSION_ID && !firefox.allowed_origins, '火狐清单只放行 gecko id')
    const manifest = JSON.parse(await readFile('resources/browser-cookie-bridge/manifest.json', 'utf8'))
    ok(manifest.browser_specific_settings.gecko.id === mod.FIREFOX_EXTENSION_ID, '扩展 gecko id 与宿主清单一致')
    ok(!/upgrade-insecure-requests/.test(manifest.content_security_policy.extension_pages), '扩展 CSP 不含 upgrade-insecure-requests（火狐否则连不上本机）')
    ok(manifest.optional_permissions.includes('debugger') && !manifest.permissions.includes('debugger'), 'debugger 只作可选权限')
    const background = await readFile('resources/browser-cookie-bridge/background.js', 'utf8')
    ok(background.includes(`'${mod.BRIDGE_HOST_NAME}'`), '扩展连接的宿主名与注册名一致')
    ok(background.includes(`const BRIDGE_REVISION = ${mod.BRIDGE_REVISION}\n`) && background.includes("case 'runtime.reload'"), '扩展脚本修订号与主进程一致，并支持自行重载')

    const writes = []
    const store = new Map()
    const registry = { read: async (key) => store.get(key) ?? null, write: async (key, value) => { writes.push(key); store.set(key, value) } }
    const hostDir = join(dir, 'host')
    const installed = await mod.installBridgeHost({ dir: hostDir, hostSource: 'resources/browser-bridge-host/host.mjs', execPath: 'C:\\Apps\\砚\\Inkstone.exe', register: true, registry })
    const launcher = await readFile(installed.files.launcher, 'utf8')
    ok(launcher.includes('ELECTRON_RUN_AS_NODE=1') && launcher.includes('Inkstone.exe') && launcher.includes('host.mjs') && launcher.includes('chcp 65001'), '启动器用 Electron 作 Node 运行转发程序，中文路径切 UTF-8')
    ok(existsSync(installed.files.script), '转发程序已复制到数据目录')
    ok(installed.registered.length === 3 && writes.length === 3, '注册 Chrome、Edge、火狐三项')
    ok(store.get(mod.REGISTRY_KEYS.firefox) === installed.files.firefoxManifest && store.get(mod.REGISTRY_KEYS.edge) === installed.files.chromiumManifest, '注册表指向对应清单')
    await mod.installBridgeHost({ dir: hostDir, hostSource: 'resources/browser-bridge-host/host.mjs', execPath: 'C:\\Apps\\砚\\Inkstone.exe', register: true, registry })
    ok(writes.length === 3, '值未变时不重复写注册表')

    const server = mod.userBrowser.server
    const bridgeDir = join(dir, 'bridge')
    await (await import('node:fs/promises')).mkdir(bridgeDir, { recursive: true })
    const { port } = await server.start(bridgeDir)
    const discovery = JSON.parse(await readFile(join(bridgeDir, 'discovery.json'), 'utf8'))
    ok(discovery.port === port && discovery.token.length === 64 && discovery.pid === process.pid, '端口文件写入端口、令牌与进程号')

    const rejected = await new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/browser-bridge?token=bad`); ws.on('open', () => r(false)); ws.on('error', () => r(true)) })
    ok(rejected, '令牌不对的连接被拒绝')
    const originRejected = await new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/browser-bridge?token=${discovery.token}`, { origin: 'https://evil.example' }); ws.on('open', () => r(false)); ws.on('error', () => r(true)) })
    ok(originRejected, '带网页 Origin 的连接被拒绝')

    const answers = []
    let onConsent = null
    const ctl = {
      browserHostOrNull: () => ({ getState: () => ({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, mode: 'embedded' }), openExternalChrome: async () => ({ ok: true }) }),
      capabilityOpts: () => ({ sessionId: 's1', runnerGeneration: 1 }),
      conversationId: () => 's1',
      cwd: () => dir,
      confirmToolConsent: async (request) => {
        answers.push(request)
        if (onConsent) {
          const hook = onConsent
          onConsent = null
          hook(request)
        }
        return answers.length === 1 ? { decision: 'deny' } : { decision: 'allow' }
      }
    }
    const commands = new mod.BrowserCommands(ctl)
    const expectCode = async (promise, code, label) => {
      try { await promise; ok(false, label, '没有报错') } catch (error) { ok(error.code === code, label, `${error.code}: ${error.message}`) }
    }

    await expectCode(commands.runBrowserCommand('connect-user', {}), 'user_browser_not_connected', '没有浏览器连接时 connect-user 给出安装指引')

    const state = { url: '', next: 10, gone: new Set(), closed: [], cdp: [], cursor: [], current: { tabId: 99, windowId: 1, url: 'https://mail.example/inbox', title: 'Inbox', status: 'complete', active: true } }
    let ext = fakeExtension(port, discovery.token, { browser: 'chrome', browserVersion: '158.0.1', version: '1.1.0', extensionId: mod.CHROMIUM_EXTENSION_ID, instanceId: 'inst-1', debugger: false }, pageHandlers(state))
    for (let i = 0; i < 50 && !server.connections().length; i++) await sleep(20)
    ok(server.connections().length === 1 && server.connections()[0].info.browser === 'chrome', '扩展打招呼后登记为连接')

    await expectCode(commands.runBrowserCommand('connect-user', { reason: '读邮件' }), 'user_browser_denied', '用户拒绝时不连接')
    ok(answers[0].parts.capability.includes('chrome 158') && answers[0].purpose === '读邮件' && answers[0].sessionGrant === false, '批准请求写明浏览器与用途且透传 sessionGrant:false')
    const connected = await commands.runBrowserCommand('connect-user', {})
    ok(connected.summary.mode === 'user' && connected.summary.browser === 'Chrome 158' && connected.summary.trustedInput === false, '批准后切到用户浏览器')
    ok(/重新加载/.test(connected.summary.extensionStale ?? ''), '扩展还在跑旧脚本时提示用户重新加载')
    await commands.runBrowserCommand('connect-user', {})
    ok(answers.length === 2, '同一连接再次 connect-user 不重复询问')

    await expectCode(commands.runBrowserCommand('observe', {}), 'browser_not_open', '还没有标签时 observe 提示先打开')
    await expectCode(commands.runBrowserCommand('navigate', { url: 'chrome://settings' }), 'unsupported_url', '浏览器内部页不在用户浏览器里打开')
    const nav = await commands.runBrowserCommand('navigate', { url: 'https://example.com/' })
    ok(nav.summary.url === 'https://example.com/' && nav.summary.tabs === 1 && ext.calls.some((c) => c.cmd === 'tab.create'), 'navigate 新开砚自己的标签')
    const seen = await commands.runBrowserCommand('observe', {})
    ok(seen.summary.items.some((line) => line.startsWith('a1 button "Go"')), 'observe 返回统一格式的元素行')
    const clicked = await commands.runBrowserCommand('click', { ref: 'a1' })
    ok(clicked.summary.ok && ext.calls.some((c) => c.cmd === 'page.click' && c.args.ref === 'a1') && !state.cdp.length, '无调试权限时走页面点击')
    const aimed = state.cursor.at(-1)
    ok(aimed?.label === '点击' && aimed.point?.x === 30 && aimed.point?.y === 20 && aimed.markup.includes('<svg') && aimed.style.includes('.cursor'), '点击前在用户页面画出代理光标')
    await expectCode(commands.runBrowserCommand('click', { ref: 'zz1' }), 'STALE_ELEMENT', '未观察到的 ref 被拦下')
    const typed = await commands.runBrowserCommand('type', { ref: 'a2', text: 'hi' })
    ok(typed.summary.value === 'hi' && state.cursor.at(-1)?.label === '输入', 'type 回执带写入后的值，光标先移到输入框')
    await expectCode(commands.runBrowserCommand('select', { ref: 'a2', value: 'x' }), 'OPTION_NOT_FOUND', 'select 找不到选项时列出可选值')
    const scrolled = await commands.runBrowserCommand('scroll', { 'delta-y': 300 })
    ok(scrolled.summary.scroll?.y === 300, 'scroll 回执带滚动位置')
    const shot = await commands.runBrowserCommand('screenshot', {})
    ok(shot.summary.bytes === 3 && existsSync(shot.summary.savedTo), '截图落盘')
    await expectCode(commands.runBrowserCommand('run', { code: '1' }), 'browser_script_unavailable', '用户浏览器不跑脚本')
    await expectCode(commands.runBrowserCommand('network', {}), 'user_browser_unsupported', '用户浏览器不给网络记录')
    await expectCode(commands.runBrowserCommand('connect-chrome', {}), 'user_browser_mode', '用户浏览器模式下不能再接外部 Chrome')

    const shared = await commands.runBrowserCommand('use-current-tab', { reason: '整理收件箱' })
    ok(answers.length === 3 && answers[2].parts.resource.includes('mail.example') && answers[2].sessionGrant === false && shared.summary.activeTabId === 'user:99', '接管当前标签逐次批准、写明地址且透传 sessionGrant:false')
    const createCountBeforeSharedNav = ext.calls.filter((c) => c.cmd === 'tab.create').length
    const navCallsBeforeSharedNav = ext.calls.filter((c) => c.cmd === 'tab.navigate').length
    const navOnShared = await commands.runBrowserCommand('navigate', { url: 'https://example.com/fresh' })
    ok(
      navOnShared.summary.url === 'https://example.com/fresh'
      && ext.calls.filter((c) => c.cmd === 'tab.create').length === createCountBeforeSharedNav + 1
      && ext.calls.filter((c) => c.cmd === 'tab.navigate').length === navCallsBeforeSharedNav
      && mod.userBrowser.hostFor('s1')?.getState().activeTabId === 'user:11',
      '当前为共享标签时 navigate 新开砚自己的标签而不覆盖共享标签'
    )
    await commands.runBrowserCommand('switch-tab', { id: 'user:99' })
    await commands.runBrowserCommand('close-tab', {})
    ok(!state.closed.includes(99), '放开共享标签不会关闭用户的标签')
    onConsent = () => { state.current = { ...state.current, url: 'https://bank.example/transfer' } }
    await expectCode(commands.runBrowserCommand('use-current-tab', { reason: '再看收件箱' }), 'tab_changed', '批准期间共享标签 URL 变化时拒绝接管')
    ok(!mod.userBrowser.hostFor('s1')?.ownsTab(99), 'URL 变化报错后未接管该标签')
    await commands.runBrowserCommand('switch-tab', { id: 'user:10' })
    await commands.runBrowserCommand('close-tab', {})
    ok(state.closed.includes(10), '关闭砚自己开的标签')

    await commands.runBrowserCommand('navigate', { url: 'https://example.com/a' })
    ext.ws.close()
    await ext.closed
    await sleep(50)
    await expectCode(commands.runBrowserCommand('observe', {}), 'user_browser_disconnected', '扩展断开后给出明确错误')

    const otherExt = fakeExtension(port, discovery.token, { browser: 'chrome', browserVersion: '158.0.1', version: '1.1.3', revision: mod.BRIDGE_REVISION, extensionId: mod.CHROMIUM_EXTENSION_ID, instanceId: 'inst-other', debugger: true }, pageHandlers(state))
    for (let i = 0; i < 50 && !server.connections().length; i++) await sleep(20)
    await sleep(50)
    await expectCode(commands.runBrowserCommand('observe', {}), 'user_browser_disconnected', 'instanceId 不同的重连不会自动接回')
    otherExt.ws.close()
    await otherExt.closed
    await sleep(50)

    state.cdp.length = 0
    ext = fakeExtension(port, discovery.token, { browser: 'chrome', browserVersion: '158.0.1', version: '1.1.3', revision: mod.BRIDGE_REVISION, extensionId: mod.CHROMIUM_EXTENSION_ID, instanceId: 'inst-1', debugger: true }, pageHandlers(state))
    for (let i = 0; i < 50 && !server.connections().length; i++) await sleep(20)
    await sleep(50)
    const again = await commands.runBrowserCommand('observe', {})
    ok(again.summary.ok && answers.length === 4, 'instanceId 相同的同一浏览器重连后自动接回，不重复询问')
    await commands.runBrowserCommand('click', { ref: 'a1' })
    ok(state.cdp.filter((c) => c.method === 'Input.dispatchMouseEvent').length === 3, '有调试权限时点击走真实鼠标事件')
    await commands.runBrowserCommand('press', { key: 'Enter' })
    ok(state.cdp.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Enter'), '有调试权限时按键走真实键盘事件')
    await commands.runBrowserCommand('observe', {})
    const mouseBefore = state.cdp.length
    await expectCode(commands.runBrowserCommand('click', { ref: 'a9' }), 'ELEMENT_OBSCURED', '被遮挡的元素不点击并写明遮挡者')
    ok(state.cdp.length === mouseBefore, '遮挡时不发出任何鼠标事件')

    ext.ws.send(JSON.stringify({ event: 'tabRemoved', tabId: 11 }))
    await sleep(50)
    const after = await commands.runBrowserCommand('state', {})
    ok(!after.data.tabs.some((t) => t.id === 'user:11'), '用户关掉的标签从列表移除')

    const current = await commands.runBrowserCommand('connect-user', {})
    ok(current.summary.extensionStale === undefined && answers.length === 4, '新脚本连接不再提示重新加载')
    const off = await commands.runBrowserCommand('disconnect-user', {})
    ok(off.summary.disconnected === true && mod.userBrowser.hostFor('s1') === undefined, 'disconnect-user 切回内置浏览器')

    await server.stop()
    ok(!existsSync(join(bridgeDir, 'discovery.json')), '停止时删除本进程写的端口文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
