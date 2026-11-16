import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'

const built = await build({
  stdin: {
    contents: [
      "export { BrowserCommands } from './src/main/browser-commands'",
      "export { BrowserSessionControl, browserResource } from './src/main/browser/session-control'",
      "export { BrowserLocks, browserLocks } from './src/main/browser/browser-locks'",
      "export { TabNotFoundError } from './src/main/browser/tab-quota'",
      "export { pick } from './src/shared/ui-lang'",
      "export { sharedResources, INTERACTIVE_RESOURCE, ResourceCoordinator, ResourceBusyError } from './src/main/interactive-resources'"
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const { BrowserCommands, BrowserSessionControl, browserResource, BrowserLocks, browserLocks, TabNotFoundError, pick, sharedResources, INTERACTIVE_RESOURCE, ResourceCoordinator, ResourceBusyError } = mod

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  checks++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (work) => {
  try { return { value: await work } } catch (error) { return { error } }
}

const control = new BrowserSessionControl(sharedResources)
const observation = (tag) => ({ url: `https://${tag}.example/`, title: tag, text: tag, elements: [{ ref: 'e1', role: 'button', name: 'Go' }] })

function makeBrowser({ holdMs = 150 } = {}) {
  const shared = { external: false, active: new Map(), max: new Map(), log: [], downloads: [] }
  const bump = (key, delta) => {
    const next = (shared.active.get(key) ?? 0) + delta
    shared.active.set(key, next)
    if (delta > 0) shared.max.set(key, Math.max(shared.max.get(key) ?? 0, next))
  }
  const hostFor = (sessionId) => {
    const host = {
      getState: () => ({
        sessionId,
        activeTabId: `tab-${sessionId}`,
        tabs: [{ id: `tab-${sessionId}` }],
        userControl: control.controlled(sessionId),
        ...(shared.external ? { mode: 'external', external: { url: '', title: '', loading: false, profileDir: '', debuggingPort: 1 } } : { mode: 'embedded' })
      }),
      forSession: (id) => hostFor(id),
      setAutomationOwner: (owner) => control.setOwner(sessionId, owner),
      setAgentSession: () => undefined,
      observe: async () => observation(sessionId),
      navigate: async () => {
        bump('all', 1); bump(sessionId, 1)
        shared.log.push(`${sessionId}:open:start`)
        await sleep(holdMs)
        shared.log.push(`${sessionId}:open:end`)
        bump('all', -1); bump(sessionId, -1)
        return { ok: true }
      },
      click: async () => {
        bump('all', 1); bump(sessionId, 1)
        shared.log.push(`${sessionId}:click:start`)
        const startedAt = Date.now()
        const owner = control.owner(sessionId)
        control.noteDownload(sessionId, `${sessionId}.bin`)
        shared.downloads.push({ sessionId, owner })
        await sleep(holdMs)
        shared.log.push(`${sessionId}:click:end`)
        bump('all', -1); bump(sessionId, -1)
        return { ok: true, observation: observation(sessionId), receipt: { downloadStarted: control.downloadSince(sessionId, startedAt) } }
      },
      openExternalChrome: async () => {
        shared.log.push(`${sessionId}:connect:start`)
        await sleep(20)
        shared.external = true
        shared.log.push(`${sessionId}:connect:end`)
        return { ok: true }
      },
      closeExternalChrome: async () => { shared.external = false },
      requestUserControl: (request) => {
        control.request(sessionId, { ...request, external: shared.external })
        control.syncPaused()
        return host.getState()
      },
      getOwnedDownload: () => null,
      pendingDownloads: () => []
    }
    return host
  }
  const commands = (sessionId, generation = 1) =>
    new BrowserCommands({ browserHostOrNull: () => hostFor('workspace'), capabilityOpts: () => ({ sessionId, runnerGeneration: generation }), conversationId: () => sessionId })
  return { shared, commands }
}

{
  const { shared, commands } = makeBrowser()
  const a = commands('A')
  const b = commands('B')
  await Promise.all([a.runBrowserCommand('open', { url: 'https://a.example/' }), b.runBrowserCommand('open', { url: 'https://b.example/' })])
  ok(shared.max.get('all') === 2, '两个会话的内置浏览器打开页面同时进行，不互相等待', shared.log)
  await a.runBrowserCommand('observe', {})
  await b.runBrowserCommand('observe', {})
  const [clickA, clickB] = await Promise.all([a.runBrowserCommand('click', { ref: 'e1' }), b.runBrowserCommand('click', { ref: 'e1' })])
  ok(shared.max.get('all') === 2, '两个会话的点击同时进行', shared.log)
  ok(clickA.summary.downloadStarted === 'A.bin' && clickB.summary.downloadStarted === 'B.bin', '并发点击各自的下载回执只带本会话的文件', [clickA.summary.downloadStarted, clickB.summary.downloadStarted])
  const owners = Object.fromEntries(shared.downloads.map((item) => [item.sessionId, item.owner]))
  ok(owners.A?.startsWith('A:1:') && owners.B?.startsWith('B:1:'), '下载开始时的自动化归属各是本会话的运行身份', owners)
  ok(control.owner('A') === undefined && control.owner('B') === undefined, '动作结束后各会话的自动化归属都清掉')
}

{
  const { shared, commands } = makeBrowser()
  const first = commands('S', 1)
  const second = commands('S', 2)
  await Promise.all([first.runBrowserCommand('open', { url: 'https://s.example/1' }), second.runBrowserCommand('open', { url: 'https://s.example/2' })])
  ok(shared.max.get('S') === 1, '同一会话内的两个操作仍然串行', shared.log)
  ok(shared.log.join() === 'S:open:start,S:open:end,S:open:start,S:open:end', '同一会话排队后按顺序执行', shared.log)
}

{
  const { shared, commands } = makeBrowser()
  shared.external = true
  await Promise.all([commands('A').runBrowserCommand('open', { url: 'https://a.example/' }), commands('B').runBrowserCommand('open', { url: 'https://b.example/' })])
  ok(shared.max.get('all') === 1, '外部 Chrome 模式下不同会话的操作全局串行', shared.log)
  const holder = sharedResources.acquire(INTERACTIVE_RESOURCE, 'mcp:windows')
  const release = await holder
  const blocked = await settle(commands('C').runBrowserCommand('open', { url: 'https://c.example/' }))
  release()
  ok(blocked.error?.code === 'waiting_resource', '外部 Chrome 模式与 windows-mcp 共用同一把全局锁', blocked.error?.code)
}

{
  const { shared, commands } = makeBrowser()
  const release = await sharedResources.acquire(INTERACTIVE_RESOURCE, 'mcp:windows')
  const result = await settle(commands('A').runBrowserCommand('open', { url: 'https://a.example/' }))
  release()
  ok(!result.error && shared.log.includes('A:open:end'), 'windows-mcp 占用全局锁时内置浏览器仍可操作', result.error?.message)
}

{
  const { shared, commands } = makeBrowser({ holdMs: 300 })
  const a = commands('A')
  const pendingA = a.runBrowserCommand('open', { url: 'https://a.example/' })
  await sleep(20)
  const connecting = commands('B').runBrowserCommand('connect-chrome', {})
  await sleep(20)
  const pendingC = commands('C').runBrowserCommand('open', { url: 'https://c.example/' })
  await Promise.all([pendingA, connecting, pendingC])
  const order = shared.log
  ok(order.indexOf('B:connect:start') > order.indexOf('A:open:end'), '接入外部 Chrome 要等其他会话进行中的内置浏览器操作结束', order)
  ok(order.indexOf('C:open:start') > order.indexOf('B:connect:end'), '接入期间新来的操作改走全局锁排在接入之后', order)
}

{
  const { shared, commands } = makeBrowser({ holdMs: 2500 })
  const pendingA = commands('A').runBrowserCommand('open', { url: 'https://a.example/' })
  await sleep(20)
  const connecting = await settle(commands('B').runBrowserCommand('connect-chrome', {}))
  await pendingA
  ok(connecting.error?.code === 'waiting_resource' && !shared.external, '其他会话的内置浏览器操作迟迟不结束时，接入外部 Chrome 报 waiting_resource 且不执行', connecting.error?.code)
}

{
  const { commands } = makeBrowser()
  const a = commands('A')
  const b = commands('B')
  const handoff = await a.runBrowserCommand('request-user-control', { reason: '登录' })
  ok(handoff.summary.userControl === true, 'A 会话交给用户')
  const snapshot = () => Object.fromEntries(sharedResources.snapshot().map((item) => [item.resourceId, item.paused]))
  ok(snapshot()[browserResource('A')] === true && !snapshot()[browserResource('B')], '只暂停 A 会话的浏览器锁', snapshot())
  ok(snapshot()[INTERACTIVE_RESOURCE] === true, '有人接管时真实桌面（windows-mcp）仍暂停', snapshot())
  const blockedA = await settle(a.runBrowserCommand('open', { url: 'https://a.example/2' }))
  ok(blockedA.error && ['waiting_resource', 'USER_CONTROL_ACTIVE'].includes(blockedA.error.code), 'A 会话在接管期间不能改页面', blockedA.error?.code)
  const freeB = await settle(b.runBrowserCommand('open', { url: 'https://b.example/2' }))
  ok(!freeB.error, '接管 A 不阻塞 B 会话的内置浏览器', freeB.error?.message)
  const stateA = control.handoff('A')
  ok(stateA?.reason === '登录' && control.handoff('B') === undefined, '接管记录只挂在 A 会话', { a: stateA, b: control.handoff('B') })
  ok(control.releaseFor('B') === false && control.controlled('A'), 'B 会话发消息不会交还 A 的接管')
  ok(control.releaseFor('A') === true, 'A 会话发消息交还 A 的接管')
  control.syncPaused()
  ok(!snapshot()[browserResource('A')] && !snapshot()[INTERACTIVE_RESOURCE], '交还后 A 会话与真实桌面锁都恢复', snapshot())
  const again = await settle(a.runBrowserCommand('open', { url: 'https://a.example/3' }))
  ok(!again.error, '交还后 A 会话可以继续操作', again.error?.message)
}

{
  const local = new BrowserSessionControl({ setPaused() {} })
  local.request('A', { sessionId: 'A', external: true })
  ok(local.controlled('A') && local.controlled('B'), '外部 Chrome 上的接管对所有会话生效（外部 Chrome 是全局的）')
  ok(local.releaseFor('B') === false && local.controlled('B'), '外部接管只能由发起会话或界面交还')
  local.releaseExternal()
  ok(!local.controlled('A') && !local.controlled('B'), '断开外部 Chrome 时清掉外部接管')
  local.request('A', { sessionId: 'A' })
  local.request('B', { sessionId: 'B', external: true })
  local.releaseVisible('C')
  ok(local.controlled('A') && !local.controlled('C'), '界面交还只清本会话与外部接管，不动别的会话的内置接管')
  local.noteDownload('A', 'a.zip', 100)
  ok(local.downloadSince('A', 100) === 'a.zip' && local.downloadSince('A', 101) === undefined && local.downloadSince('B', 0) === undefined, '下载开始记录按会话与时间点判定')
  local.markAgent('A')
  local.forget('A')
  ok(!local.isAgent('A') && local.downloadSince('A', 0) === undefined && local.handoff('A') === undefined, '关闭会话时清掉该会话的接管、归属与下载记录')
}

{
  const coordinator = new ResourceCoordinator()
  const locks = new BrowserLocks(coordinator, 200)
  locks.markUncertain(browserResource('A'))
  const blocked = await settle(locks.run({ sessionId: 'A', owner: 'a', external: () => false }, async () => 'x'))
  ok(blocked.error?.code === 'waiting_resource', '结果待核实只锁住出问题的会话')
  const other = await settle(locks.run({ sessionId: 'B', owner: 'b', external: () => false }, async () => 'y'))
  ok(other.value === 'y', '别的会话不受另一会话待核实影响')
  const desktop = await settle(coordinator.run(INTERACTIVE_RESOURCE, 'mcp:windows', async () => 'z'))
  ok(desktop.value === 'z', '内置浏览器待核实不再挡住 windows-mcp')
  const confirmed = await settle(locks.run({ sessionId: 'A', owner: 'a', external: () => false, confirming: true }, async () => 'ok'))
  ok(confirmed.value === 'ok', '核对类操作解除本会话的待核实')
}

{
  const coordinator = new ResourceCoordinator()
  const locks = new BrowserLocks(coordinator, 200)
  let calls = 0
  const flaky = () => { calls++; if (calls === 2) throw new Error('host gone'); return false }
  const failed = await settle(locks.run({ sessionId: 'A', owner: 'a', external: flaky }, async () => 'x'))
  ok(failed.error?.message === 'host gone', '拿到会话锁后复查外部状态抛错时把错误交给调用方')
  const after = await settle(coordinator.run(browserResource('A'), 'probe', async () => 'free'))
  ok(after.value === 'free' && coordinator.snapshot().find((item) => item.resourceId === browserResource('A'))?.owner === null, '复查抛错时会话锁已释放', coordinator.snapshot())
}

{
  const coordinator = new ResourceCoordinator()
  const locks = new BrowserLocks(coordinator, 200)
  locks.markUncertain(INTERACTIVE_RESOURCE)
  const stuck = await settle(coordinator.run(INTERACTIVE_RESOURCE, 'mcp:windows', async () => 'z'))
  ok(stuck.error?.code === 'waiting_resource', '外部 Chrome 动作待核实时全局锁被标记')
  locks.clearExternalUncertain()
  const freed = await settle(coordinator.run(INTERACTIVE_RESOURCE, 'mcp:windows', async () => 'z'))
  ok(freed.value === 'z', '断开外部 Chrome 时解除浏览器留下的全局待核实标记')
  coordinator.markUncertain(INTERACTIVE_RESOURCE)
  locks.clearExternalUncertain()
  ok(coordinator.snapshot().find((item) => item.resourceId === INTERACTIVE_RESOURCE)?.uncertain === true, '不是浏览器标的待核实（如 windows-mcp）不被断开 Chrome 清掉')
}

{
  const host = {
    getState: () => ({ sessionId: 'A', activeTabId: 'tab-A', tabs: [], userControl: false, mode: 'embedded' }),
    forSession: () => host,
    setAutomationOwner: () => undefined,
    setAgentSession: () => undefined,
    observe: async () => observation('A'),
    click: async () => ({ ok: true, observation: observation('A') }),
    closeTab: async () => { throw new TabNotFoundError() },
    switchTab: async () => { throw new TabNotFoundError() }
  }
  const cmd = new BrowserCommands({ browserHostOrNull: () => host, capabilityOpts: () => ({ sessionId: 'T', runnerGeneration: 1 }), conversationId: () => 'T' })
  const closed = await settle(cmd.runBrowserCommand('close-tab', { id: 'tab-other' }))
  const switched = await settle(cmd.runBrowserCommand('switch-tab', { id: 'tab-other' }))
  ok(closed.error?.code === 'tab_not_found' && switched.error?.code === 'tab_not_found', '别的会话的标签 id 在命令层报 tab_not_found', [closed.error?.code, switched.error?.code])
  await cmd.runBrowserCommand('observe', {})
  const next = await settle(cmd.runBrowserCommand('click', { ref: 'e1' }))
  ok(!next.error, '找不到标签不会把本会话标成待核实', next.error?.code)
}

const source = await readFile('src/main/browser.ts', 'utf8')
const ast = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true)
const methods = new Map()
for (const node of ast.statements) {
  if (!ts.isClassDeclaration(node)) continue
  for (const member of node.members) if (ts.isMethodDeclaration(member)) methods.set(member.name.getText(ast), member.getText(ast))
}
const selected = ['switchTab', 'closeTab', 'externalFromUser', 'externalBusyMessage', 'openExternalChromeFromUser', 'closeExternalChromeFromUser']
const js = ts.transpileModule(`class Harness { ${selected.map((name) => methods.get(name)).join('\n')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const deps = { TabNotFoundError, pick, sharedResources, INTERACTIVE_RESOURCE, ResourceBusyError, browserLocks, listTargets: async () => [], closeCdpTarget: async () => undefined }
const Harness = new Function(...Object.keys(deps), `${js}; return Harness`)(...Object.values(deps))

function controller(focus) {
  const view = () => ({ webContents: { isDestroyed: () => false, close() {} } })
  const tab = (id, sessionId) => ({ id, sessionId, view: view(), observer: { dispose() {} }, cdp: { detach: async () => undefined } })
  const host = new Harness()
  const log = { errors: [], opened: 0, closed: 0 }
  Object.assign(host, {
    focusSessionId: focus,
    external: null,
    tabs: new Map([['tab-a', tab('tab-a', 'A')], ['tab-b', tab('tab-b', 'B')]]),
    activeBySession: new Map([['A', 'tab-a'], ['B', 'tab-b']]),
    get activeTabId() { return this.activeBySession.get(this.focusSessionId) ?? null },
    externalTargetId: (id) => (id.startsWith('chrome:') ? id.slice(7) : null),
    detachViewFromAllWindows() {},
    showOnlyOwnedView() {},
    updateState() {},
    getState() { return { tabs: [...this.tabs.keys()], active: this.activeTabId } },
    pushError: (message) => log.errors.push(message),
    openExternalChrome: async () => { log.opened++; return { ok: true } },
    closeExternalChrome: async () => { log.closed++; return { closed: true } }
  })
  return { host, log }
}

{
  const { host } = controller('B')
  const switched = await settle(host.switchTab('tab-a'))
  const closed = await settle(host.closeTab('tab-a'))
  ok(switched.error instanceof TabNotFoundError && closed.error instanceof TabNotFoundError, 'B 用 A 的标签 id 切换或关闭都报找不到标签', [switched.error?.message, closed.error?.message])
  ok(host.tabs.has('tab-a') && host.activeBySession.get('A') === 'tab-a', 'A 的标签与当前标签都没变')
  const own = await settle(host.closeTab('tab-b'))
  ok(!own.error && !host.tabs.has('tab-b'), 'B 关自己的标签照常生效')
  const internal = await settle(host.closeTab('tab-a', { silent: true, anySession: true }))
  ok(!internal.error && !host.tabs.has('tab-a'), '关闭会话等内部路径仍可按 id 关任意会话的标签')
}

{
  const { host } = controller('A')
  const own = await settle(host.switchTab('tab-a'))
  ok(!own.error, 'A 切到自己的标签照常生效')
}

{
  const { shared, commands } = makeBrowser({ holdMs: 300 })
  const { host, log } = controller('U')
  const pendingA = commands('A').runBrowserCommand('open', { url: 'https://a.example/' })
  await sleep(20)
  const opened = await host.openExternalChromeFromUser('https://x.example/')
  await pendingA
  ok(opened.ok === true && log.opened === 1 && shared.log.includes('A:open:end'), '界面接入外部 Chrome 等进行中的内置操作结束后再执行', shared.log)
}

{
  const { commands } = makeBrowser({ holdMs: 5000 })
  const { host, log } = controller('U')
  const pendingA = commands('A').runBrowserCommand('open', { url: 'https://a.example/' })
  await sleep(20)
  const started = Date.now()
  const opened = await host.openExternalChromeFromUser('https://x.example/')
  const waited = Date.now() - started
  const closed = await host.closeExternalChromeFromUser()
  await pendingA
  ok(opened.ok === false && opened.code === 'waiting_resource' && /Chrome/.test(opened.error) && log.opened === 0, '界面接入等不到时返回明确提示且不执行', opened)
  ok(waited < 4000, '界面接入最多等几秒就给结果', waited)
  ok(log.closed === 0 && log.errors.length === 1 && /Chrome/.test(log.errors[0]) && Array.isArray(closed.tabs), '界面断开等不到时弹出明确提示并返回当前状态', log.errors)
}

{
  const { host, log } = controller('U')
  sharedResources.setPaused(INTERACTIVE_RESOURCE, true)
  const opened = await host.openExternalChromeFromUser('https://x.example/')
  sharedResources.setPaused(INTERACTIVE_RESOURCE, false)
  ok(opened.ok === true && log.opened === 1, '用户接管中（全局锁暂停）界面仍能接入外部 Chrome', opened)
}

console.log(`browser-session-locks: ${checks} assertions passed (fake host, no Electron)`)
