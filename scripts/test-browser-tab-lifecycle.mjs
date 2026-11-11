import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  checks++
}

const base = resolve('.tmp/browser-tab-lifecycle')
await mkdir(base, { recursive: true })
const dir = await mkdtemp(join(base, 'run-'))
const cleanupFile = join(dir, 'cleanup.mjs')
await build({ entryPoints: ['src/main/session-browser-cleanup.ts'], outfile: cleanupFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { closeBrowserForSessions, setSessionBrowserCloser } = await import(pathToFileURL(cleanupFile).href)

const quotaFile = join(dir, 'quota.mjs')
await build({ entryPoints: ['src/main/browser/tab-quota.ts'], outfile: quotaFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const quota = await import(pathToFileURL(quotaFile).href)

const source = await readFile('src/main/browser.ts', 'utf8')
const ast = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true)
const methods = new Map()
for (const node of ast.statements) {
  if (!ts.isClassDeclaration(node)) continue
  for (const member of node.members) if (ts.isMethodDeclaration(member)) methods.set(member.name.getText(ast), member.getText(ast))
}
ok(quota.MAX_TABS_PER_SESSION === 12, '每会话标签上限常量为 12')
const selected = ['assertTabQuota', 'handleWindowOpen', 'closeSession', 'ensureNetworkGuard', 'sessionEpoch', 'assertSessionEpoch', 'reportBackgroundTabFailure', 'openBackgroundTab']
const js = ts.transpileModule(`class Harness { ${selected.map((name) => methods.get(name)).join('\n')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function harness(options = {}) {
  const log = { errors: [], popups: [], closed: [], guardCalls: 0, externalClosed: 0, updates: 0 }
  const attach = options.attach ?? (async () => ({ status: 'attached', port: 1 }))
  const deps = {
    pick: (zh) => zh,
    safeUrl: (value) => (/^https?:/.test(value) ? value : null),
    MAX_TABS_PER_SESSION: quota.MAX_TABS_PER_SESSION,
    POPUP_NOTICE_INTERVAL_MS: quota.POPUP_NOTICE_INTERVAL_MS,
    TabQuotaError: quota.TabQuotaError,
    SessionClosedError: quota.SessionClosedError,
    session: { fromPartition: () => ({}) },
    attachPinnedNetworkGuard: async (...args) => { log.guardCalls += 1; return attach(log.guardCalls, ...args) }
  }
  const Harness = new Function(...Object.keys(deps), `${js}; return Harness`)(...Object.values(deps))
  const host = new Harness()
  Object.assign(host, {
    tabs: new Map(),
    popupNoticeAt: new Map(),
    sessionEpochs: new Map(),
    external: null,
    guardGate: options.guardGate ?? null,
    getWindow: () => null,
    syncTabNavigation() {},
    activeBySession: new Map(),
    focusSessionId: 'focus',
    networkGuard: null,
    pushError: (message) => log.errors.push(message),
    ...(options.realOpen ? {} : { openBackgroundTab: async (url, _opener, sessionId) => { log.popups.push([url, sessionId]) } }),
    ...(options.realOpen ? { ensureNetworkGuard: async () => { if (host.guardGate) await host.guardGate } } : {}),
    createTab: (sessionId) => {
      host.assertTabQuota(sessionId)
      const id = `${sessionId}-created-${host.tabs.size}`
      const tab = { id, sessionId, state: {}, view: { setVisible() {}, webContents: { loadURL: async () => {}, isDestroyed: () => false } } }
      host.tabs.set(id, tab)
      log.created = (log.created ?? 0) + 1
      return tab
    },
    closeTab: async (id) => { log.closed.push(id); host.tabs.delete(id) },
    closeExternalChrome: async () => { log.externalClosed += 1 },
    updateState: () => { log.updates += 1 },
    getState: () => ({})
  })
  const addTabs = (sessionId, count) => {
    for (let i = 0; i < count; i++) host.tabs.set(`${sessionId}-${i}`, { id: `${sessionId}-${i}`, sessionId, committedUrl: '', openerUrl: '' })
  }
  return { host, log, addTabs }
}

{
  const { host, log, addTabs } = harness()
  addTabs('A', 11)
  const tab = host.tabs.get('A-0')
  ok(host.handleWindowOpen(tab, 'https://example.com/pop').action === 'deny', '未超限时 window.open 仍由我们接管（原窗口 deny）')
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(log.popups.length === 1 && log.popups[0][1] === 'A', '第 12 个标签允许以后台标签打开', log.popups)
  addTabs('A2', 0)
  host.tabs.set('A-extra', { id: 'A-extra', sessionId: 'A' })
  const denied = host.handleWindowOpen(tab, 'https://example.com/pop2')
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(denied.action === 'deny' && log.popups.length === 1, '达到 12 个后弹窗被拒绝，没有创建标签', log.popups)
  ok(log.errors.length === 1 && /上限/.test(log.errors[0]), '拒绝时给出明确提示', log.errors)
  host.handleWindowOpen(tab, 'https://example.com/pop3')
  host.handleWindowOpen(tab, 'https://example.com/pop4')
  ok(log.errors.length === 1, '同一会话 5 秒内的重复拒绝只提示一次', log.errors)
  host.popupNoticeAt.set('A', Date.now() - 5001)
  host.handleWindowOpen(tab, 'https://example.com/pop5')
  ok(log.errors.length === 2, '超过 5 秒后再次拒绝会重新提示', log.errors)
  host.popupNoticeAt.delete('A')
  ok(host.tabs.size === 12 && log.closed.length === 0, '不静默关闭已有标签', host.tabs.size)
  addTabs('B', 3)
  host.handleWindowOpen(host.tabs.get('B-0'), 'https://example.com/b')
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(log.popups.at(-1)[1] === 'B', '别的会话不受该会话配额影响')
  let thrown
  try { host.assertTabQuota('A') } catch (error) { thrown = error }
  ok(thrown instanceof Error && /上限/.test(thrown.message), 'agent 新开标签超限返回明确错误')
  ok((() => { try { host.assertTabQuota('B'); return true } catch { return false } })(), '未超限的会话可以继续新开标签')
}

{
  const { host, log, addTabs } = harness()
  addTabs('A', 3)
  addTabs('B', 2)
  host.activeBySession.set('A', 'A-0')
  host.activeBySession.set('B', 'B-0')
  host.focusSessionId = 'B'
  await host.closeSession('A')
  ok([...host.tabs.keys()].sort().join() === 'B-0,B-1', '关闭会话只移除该会话的标签，他会话标签保留', [...host.tabs.keys()])
  ok(!host.activeBySession.has('A') && host.activeBySession.get('B') === 'B-0', '别的会话的活动标签记录不变')
  ok(log.externalClosed === 0, '关闭非焦点会话不影响当前正在看的会话的外接 Chrome')
}

{
  const { host } = harness({ attach: async (call) => (call === 1 ? { status: 'failed', message: 'boom' } : { status: 'attached', port: 1 }) })
  const { log } = { log: host }
  const errors = []
  host.pushError = (message) => errors.push(message)
  await host.ensureNetworkGuard()
  ok(errors.length === 1 && /boom/.test(errors[0]), '防护附着失败上报可见错误', errors)
  ok(host.networkGuard === null, '失败结果不被永久缓存')
  await host.ensureNetworkGuard()
  ok(errors.length === 1 && host.networkGuard !== null, '下一次调用重试并成功后缓存生效', errors)
  void log
}

{
  const { host, log, addTabs } = harness({ realOpen: true })
  addTabs('A', 11)
  const opener = host.tabs.get('A-0')
  let release
  host.guardGate = new Promise((resolve) => { release = resolve })
  for (let i = 0; i < 5; i++) host.handleWindowOpen(opener, `https://example.com/p${i}`)
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  ok(host.tabs.size === 12, '并发弹窗只放进剩余的一个名额', host.tabs.size)
  ok(log.errors.length === 1, '并发弹窗在 createTab 阶段被拒绝时同样走 5 秒节流，只提示一次', log.errors)
}

{
  const { host, log, addTabs } = harness({ realOpen: true })
  addTabs('A', 2)
  addTabs('B', 2)
  let release
  host.guardGate = new Promise((resolve) => { release = resolve })
  host.handleWindowOpen(host.tabs.get('A-0'), 'https://example.com/late-a')
  host.handleWindowOpen(host.tabs.get('B-0'), 'https://example.com/late-b')
  await host.closeSession('A')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  ok([...host.tabs.values()].filter((tab) => tab.sessionId === 'A').length === 0, '关闭会话时仍在等待 guard 的弹窗请求失效，关闭后不再长出标签', [...host.tabs.keys()])
  ok([...host.tabs.values()].some((tab) => tab.id.startsWith('B-created')), '别的会话的等待中弹窗不受影响')
  ok(log.errors.length === 0, '失效的请求静默丢弃，不弹错误', log.errors)
  host.guardGate = null
  host.handleWindowOpen(host.tabs.get('B-0'), 'https://example.com/after')
  await new Promise((resolve) => setTimeout(resolve, 10))
  ok(log.created >= 2, '关闭之后新发起的请求不受旧代次影响')
}

{
  const { host, log, addTabs } = harness()
  addTabs('A', 1)
  host.external = { id: 'external-chrome' }
  host.focusSessionId = 'A'
  await host.closeSession('A', { keepExternal: true })
  ok(log.externalClosed === 0, '删除/归档路径（keepExternal）不关闭没有会话归属的外接 Chrome，即使它恰好是焦点会话')
  host.focusSessionId = 'B'
  await host.closeSession('A', { keepExternal: true })
  ok(log.externalClosed === 0, '焦点是别的会话时更不会误关')
  host.focusSessionId = 'A'
  await host.closeSession('A')
  ok(log.externalClosed === 1, '用户主动关闭浏览器（不带 keepExternal）保留原有“随焦点会话关闭”语义')
}

{
  const closed = []
  setSessionBrowserCloser(async (id) => { closed.push(id); if (id === 'bad') throw new Error('x') })
  const failed = await closeBrowserForSessions(['s1', 's1', '', undefined, null, 'workspace', 'bad', 's2'])
  ok(closed.join() === 's1,bad,s2', '清理按去重后的会话 id 逐个关闭，并跳过共享的 workspace', closed)
  ok(failed.join() === 'bad', '单个会话关闭失败不影响其余并返回失败列表', failed)
  closed.length = 0
  const skipped = await closeBrowserForSessions(['busy', 'idle'], { skip: (id) => id === 'busy' })
  ok(closed.join() === 'idle' && skipped.length === 0, '归档时运行中的会话（skip 命中）不关标签，空闲的照关', closed)
  setSessionBrowserCloser(null)
  ok((await closeBrowserForSessions(['s9'])).length === 0, '未注册关闭器时安静跳过')
}

{
  const sessionIpc = await readFile('src/main/ipc/session-ipc.ts', 'utf8')
  const remoteHost = await readFile('src/main/remote-host.ts', 'utf8')
  const indexSource = await readFile('src/main/index.ts', 'utf8')
  ok(/flags\.archived === true\) await closeBrowserForSessions\(\[sessionId\], \{ skip: sessionBusy \}\)/.test(sessionIpc), '本地手动归档接了浏览器清理')
  ok(/await archiveSessionsBatch\(ids\)[\s\S]{0,80}closeBrowserForSessions\(ids, \{ skip: sessionBusy \}\)/.test(sessionIpc), '自动归档接了浏览器清理')
  ok(/flags\.archived === true\) await closeBrowserForSessions\(\[summary\.id\], \{ skip: \(id\) => host\.runners\(\)\?\.sessionHasPendingWork\(id\)/.test(remoteHost), '远程归档接了浏览器清理')
  ok(/sessionBusy = \(sessionId: string\): boolean => host\.runners\(\)\?\.sessionHasPendingWork\(sessionId\)/.test(sessionIpc), '本地归档的“运行中”判据取自 RunnerRegistry.sessionHasPendingWork')
  ok(/browser\?\.closeSession\(sessionId, \{ keepExternal: true \}\)/.test(indexSource), '主进程把清理接到 BrowserController.closeSession')
}

console.log(`browser tab lifecycle: ${checks} checks passed`)
