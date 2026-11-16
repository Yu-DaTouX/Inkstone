import './lib/test-isolate.mjs'
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

{
  const elements = [
    { ref: 'e1', role: 'button', name: 'Go', box: [0, 0, 1, 1] },
    { ref: 'e2', role: 'textbox', name: 'Query', value: '', box: [0, 0, 1, 1] },
    { ref: 'e3', role: 'link', name: 'Footer help', box: [0, 900, 1, 1], offscreen: true }
  ]
  let current = { url: 'https://example.com', title: 'Example', text: 'hello', elements, accessibilityNodeCount: 9, generationId: 'x'.repeat(38) }
  const seenOptions = []
  const host = makeHost({
    observe: async (options) => { seenOptions.push(options); return { ...current, ...(options?.scope ? { scopeRefs: ['e2'] } : {}) } },
    type: async () => {
      current = { ...current, text: 'hello\nResults for alpha', elements: [elements[0], { ...elements[1], value: 'alpha' }, elements[2], { ref: 'e7', role: 'link', name: 'Alpha result', box: [0, 0, 1, 1] }] }
      return { ok: true, observation: current, receipt: { value: 'alpha' } }
    },
    text: async () => ({ url: 'https://example.com', title: 'Example', text: 'abcdefghij'.repeat(1000) + ' needle tail' }),
    screenshot: async () => { throw new Error('panel hidden') },
    runScript: async (code) => ({ result: { code }, logs: ['one'], url: 'https://example.com', title: 'Example', runtime: 'kept' })
  })
  const commands = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 's', runnerGeneration: 1 }) })
  const observed = await commands.runBrowserCommand('observe', {})
  ok(JSON.stringify(observed.summary.items) === JSON.stringify(['e1 button "Go"', 'e2 textbox "Query"']), 'observe 清单用短 ref，默认只列视口内', JSON.stringify(observed.summary.items))
  ok(observed.summary.offscreen === 1 && /--all/.test(observed.summary.hint), 'observe 报视口外数量并提示 --all / --find')
  ok(!('generationId' in observed.summary) && !('accessibilityNodes' in observed.summary), 'stdout 不再带代次长编号')
  const found = await commands.runBrowserCommand('observe', { find: 'help' })
  ok(found.summary.items.length === 1 && found.summary.items[0].startsWith('e3 ') && seenOptions.at(-1)?.all === true, '--find 搜含视口外的全部元素')
  const staleScope = await failure(commands.runBrowserCommand('observe', { in: 'e99' }))
  ok(staleScope && staleScope.code === 'STALE_ELEMENT', '--in 的 ref 不在最新观察里时报 STALE_ELEMENT')
  const scoped = await commands.runBrowserCommand('observe', { in: 'e2' })
  ok(seenOptions.at(-1)?.scope === 'e2' && scoped.summary.items.join() === 'e2 textbox "Query"', '--in 把范围交给宿主并只列范围内元素')
  const typed = await commands.runBrowserCommand('type', { ref: 'e2', text: 'alpha' })
  const changes = typed.summary.changes
  ok(Array.isArray(changes) && changes.includes('~ e2 textbox "Query" ="alpha"') && changes.includes('+ e7 link "Alpha result"') && changes.includes('+ 文本 "Results for alpha"'), '动作回执带变化摘要（值变化、新元素、新文字）', JSON.stringify(changes))
  ok(!('items' in typed.summary), '动作回执不重复整份清单')
  const text = await commands.runBrowserCommand('text', { 'max-chars': 500 })
  ok(text.summary.text.length === 500 && text.summary.nextOffset === 500 && text.summary.totalChars === 10012, 'text 按段读正文并给出 nextOffset')
  const next = await commands.runBrowserCommand('text', { offset: 9990, 'max-chars': 500 })
  ok(next.summary.endOffset === 10012 && !('nextOffset' in next.summary), 'text 读到末尾时不再给 nextOffset')
  const needle = await commands.runBrowserCommand('text', { find: 'NEEDLE' })
  ok(needle.summary.count === 1 && needle.summary.matches[0].offset === 10001, 'text --find 返回命中位置')
  const shot = await failure(commands.runBrowserCommand('screenshot', {}))
  ok(shot && shot.code === 'browser_screenshot_failed' && /observe/.test(shot.message) && /text/.test(shot.message), '截图失败时给出 observe / text 替代')
  const inline = await commands.runBrowserCommand('run', { code: 'return 1' })
  ok(inline.summary.result === JSON.stringify({ code: 'return 1' }) && inline.summary.runtime === 'kept' && inline.summary.logTail[0] === 'one', 'run 接受内联代码，回执带 runtime 与日志')
  const empty = await failure(commands.runBrowserCommand('run', { code: '   ' }))
  ok(empty && empty.code === 'missing_code', 'run 没有代码时明确报错')
  const big = await failure(commands.runBrowserCommand('run', { code: 'x'.repeat(1024 * 1024 + 1) }))
  ok(big && big.code === 'script_too_large', '内联代码同样有 1 MiB 上限')
}

console.log(`browser-command-boundary: ${checks} assertions passed (fake host, no Electron)`)
