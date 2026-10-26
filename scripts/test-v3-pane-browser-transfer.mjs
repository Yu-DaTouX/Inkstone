import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let passed = 0
function check(name, fn) {
  try {
    fn()
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function checkAsync(name, fn) {
  try {
    await fn()
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
  passed += 1
  console.log(`  ✓ ${name}`)
}

const dir = await mkdtemp(join(tmpdir(), 'v3-pane-browser-transfer-'))

const electronMock = `
class FakeContentView {
  constructor() { this.children = [] }
  addChildView(view) { if (!this.children.includes(view)) this.children.push(view) }
  removeChildView(view) { const i = this.children.indexOf(view); if (i >= 0) this.children.splice(i, 1) }
  has(view) { return this.children.includes(view) }
}
function makeWebContents() {
  const wc = {
    id: (globalThis.__wcIdSeq = (globalThis.__wcIdSeq || 0) + 1),
    __destroyed: false,
    isDestroyed() { return this.__destroyed },
    close() { this.__destroyed = true },
    setZoomMode() {},
    setZoomFactor() {},
    getZoomFactor() { return 1 },
    on() {},
    setWindowOpenHandler() {},
    loadURL(url) { (globalThis.__loads ||= []).push(url); return Promise.resolve() },
    getURL() { return 'about:blank' },
    canGoBack() { return false },
    canGoForward() { return false },
    goBack() {},
    goForward() {},
    reload() {},
    insertCSS() { return Promise.resolve('') },
    send() {},
    debugger: {
      on() {}, isAttached: () => false, attach() {}, detach() {},
      sendCommand: async () => ({})
    },
    session: {
      on() {},
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} }
    }
  }
  return wc
}
export class BrowserWindow {
  constructor(options = {}) {
    this.__options = options
    this.__destroyed = false
    this.webContents = makeWebContents()
    this.contentView = new FakeContentView()
    ;(globalThis.__mockWindows ||= []).push(this)
  }
  isDestroyed() { return this.__destroyed }
  destroy() { this.__destroyed = true }
  static getAllWindows() { return globalThis.__mockWindows || [] }
}
export class View {
  constructor() { this.children = [] }
  setBounds() {}
  addChildView(view) { this.children.push(view) }
  removeChildView(view) { const i = this.children.indexOf(view); if (i >= 0) this.children.splice(i, 1) }
}
export class WebContentsView {
  constructor(options = {}) {
    this.__options = options
    this.__visible = true
    this.__bounds = null
    this.webContents = makeWebContents()
    ;(globalThis.__viewCreations = (globalThis.__viewCreations || 0) + 1)
  }
  setBackgroundColor() {}
  setVisible(value) { this.__visible = value }
  setBounds(bounds) { this.__bounds = bounds }
}
export const app = { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp' }
export const shell = { openExternal() {} }
globalThis.__MockBrowserWindow = BrowserWindow
globalThis.__MockWebContentsView = WebContentsView
`

const electronPlugin = {
  name: 'browser-electron-mock',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'browser-mock' }))
    buildApi.onLoad({ filter: /.*/, namespace: 'browser-mock' }, () => ({ contents: electronMock, loader: 'js' }))
  }
}

async function compile(entry, outfile, useElectronMock) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: useElectronMock ? [electronPlugin] : []
  })
  return import(pathToFileURL(outfile).href)
}

class FakeView {
  constructor(webContentsId) {
    this.webContents = {
      id: webContentsId,
      isDestroyed: () => this.destroyed === true,
      loadURL: (url) => {
        ;(globalThis.__fakeLoads ||= []).push(url)
        return Promise.resolve()
      }
    }
    this.visible = true
    this.bounds = null
    this.destroyed = false
    this.setVisibleCalls = 0
    ;(globalThis.__viewCreations = (globalThis.__viewCreations || 0) + 1)
  }
  setVisible(value) {
    this.visible = value
    this.setVisibleCalls += 1
  }
  setBounds(bounds) {
    this.bounds = bounds
  }
}

class FakeWindow {
  constructor(id) {
    this.webContents = { id }
    this.children = []
    this.destroyed = false
    const self = this
    this.contentView = {
      get children() {
        return self.children
      },
      addChildView(view) {
        if (!self.children.includes(view)) self.children.push(view)
      },
      removeChildView(view) {
        const i = self.children.indexOf(view)
        if (i >= 0) self.children.splice(i, 1)
      }
    }
  }
  isDestroyed() {
    return this.destroyed
  }
}

class FakeHost {
  constructor() {
    this.tabs = new Map()
    this.revokes = new Map()
    this.begun = []
    this.ended = []
    this.navigations = []
    this.closed = []
  }
  addTab(tabId, webContentsId, sourceWindow) {
    const view = new FakeView(webContentsId)
    const entry = { view, sourceWindow, ownerKey: undefined }
    this.tabs.set(tabId, entry)
    sourceWindow.contentView.addChildView(view)
    return view
  }
  beginHostTransfer(request) {
    const entry = this.tabs.get(request.tabId)
    if (!entry) return { ok: false, code: 'not-found', message: '找不到标签页' }
    if (entry.view.webContents.isDestroyed()) return { ok: false, code: 'destroyed', message: '已销毁' }
    if (entry.ownerKey && entry.ownerKey !== request.ownerKey) {
      return { ok: false, code: 'owner-conflict', message: '已借给其它归属' }
    }
    entry.ownerKey = request.ownerKey
    this.revokes.set(request.tabId, request.onRevoke)
    this.begun.push({ tabId: request.tabId, ownerKey: request.ownerKey, generation: request.generation })
    const handle = {
      tabId: request.tabId,
      ownerKey: request.ownerKey,
      generation: request.generation,
      webContentsId: entry.view.webContents.id,
      view: entry.view,
      sourceWindow: entry.sourceWindow,
      navigate: async (url) => {
        this.navigations.push(url)
        entry.view.webContents.loadURL(url)
        return { ok: true }
      },
      closeTab: async () => {
        this.closed.push(request.tabId)
        this.tabs.delete(request.tabId)
        const revoke = this.revokes.get(request.tabId)
        this.revokes.delete(request.tabId)
        revoke?.('tab-closed')
      }
    }
    return { ok: true, code: 'ok', transfer: handle }
  }
  endHostTransfer(tabId, ownerKey) {
    const entry = this.tabs.get(tabId)
    if (!entry || entry.ownerKey !== ownerKey) return false
    entry.ownerKey = undefined
    this.ended.push({ tabId, ownerKey })
    return true
  }
}

const resetCounters = () => {
  globalThis.__viewCreations = 0
  globalThis.__fakeLoads = []
  globalThis.__loads = []
  globalThis.__mockWindows = []
}

try {
  const transferMod = await compile('src/main/windows/pane-browser-transfer.ts', join(dir, 'transfer.mjs'), false)
  const shared = await compile('src/shared/pane-popout.ts', join(dir, 'shared.mjs'), false)

  console.log('坐标规整')
  check('非有限值丢弃，负坐标归零，宽高至少 1px', () => {
    assert.equal(transferMod.normalizeTransferBounds(null), null)
    assert.equal(transferMod.normalizeTransferBounds({ x: 0, y: 0, width: Number.NaN, height: 10 }), null)
    assert.deepEqual(transferMod.normalizeTransferBounds({ x: -8, y: 3.4, width: 0, height: 5 }), {
      x: 0,
      y: 3,
      width: 1,
      height: 5
    })
  })

  console.log('适配器：借出与改挂')
  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(900)
    const target = new FakeWindow(901)
    const view = host.addTab('tab-1', 501, source)
    const viewCreationsBefore = globalThis.__viewCreations
    const transfer = transferMod.createPaneBrowserTransfer(host)
    const result = transfer.begin({ tabId: 'tab-1', ownerKey: 'sess-a', generation: 1, target })

    check('借出后同一视图挂到目标窗口，来源窗口摘除', () => {
      assert.equal(result.ok, true)
      assert.equal(source.contentView.children.includes(view), false)
      assert.equal(target.contentView.children.includes(view), true)
      assert.equal(view.visible, true)
    })
    check('webContentsId 与视图对象不变，未新建视图，未 loadURL', () => {
      assert.equal(result.lease.webContentsId, 501)
      assert.equal(view.webContents.id, 501)
      assert.equal(globalThis.__viewCreations, viewCreationsBefore)
      assert.deepEqual(globalThis.__fakeLoads, [])
      assert.equal(host.begun.length, 1)
    })
    check('租约绑定 tabId / owner / generation / 目标窗口', () => {
      const lease = transfer.leaseOfTab('tab-1')
      assert.equal(lease.tabId, 'tab-1')
      assert.equal(lease.ownerKey, 'sess-a')
      assert.equal(lease.generation, 1)
      assert.equal(lease.targetWebContentsId, target.webContents.id)
      assert.equal(transfer.leaseOfTarget(target.webContents.id).tabId, 'tab-1')
      assert.equal(transfer.isLeased('tab-1'), true)
    })
    check('相同归属 / 相同目标重复借出幂等，不重复改挂', () => {
      const again = transfer.begin({ tabId: 'tab-1', ownerKey: 'sess-a', generation: 1, target })
      assert.equal(again.ok, true)
      assert.equal(host.begun.length, 1)
      assert.equal(target.contentView.children.filter((item) => item === view).length, 1)
    })
    check('相同归属换代次只更新 generation', () => {
      const refreshed = transfer.begin({ tabId: 'tab-1', ownerKey: 'sess-a', generation: 2, target })
      assert.equal(refreshed.ok, true)
      assert.equal(refreshed.lease.generation, 2)
      assert.equal(host.begun.length, 1)
    })
    check('其它归属借同一页签被拒，视图留在原目标', () => {
      const other = new FakeWindow(902)
      const conflict = transfer.begin({ tabId: 'tab-1', ownerKey: 'sess-b', generation: 1, target: other })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.code, 'owner-conflict')
      assert.equal(other.contentView.children.length, 0)
      assert.equal(target.contentView.children.includes(view), true)
      assert.equal(transfer.leaseOfTab('tab-1').ownerKey, 'sess-a')
    })
  }

  console.log('适配器：换目标窗口')
  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(910)
    const first = new FakeWindow(911)
    const second = new FakeWindow(912)
    const view = host.addTab('tab-2', 502, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({ tabId: 'tab-2', ownerKey: 'sess-a', generation: 1, target: first })
    const moved = transfer.begin({ tabId: 'tab-2', ownerKey: 'sess-a', generation: 1, target: second })
    check('换目标：从旧窗口摘除、挂到新窗口，仍是同一视图', () => {
      assert.equal(moved.ok, true)
      assert.equal(first.contentView.children.includes(view), false)
      assert.equal(second.contentView.children.includes(view), true)
      assert.equal(globalThis.__viewCreations, 1)
      assert.equal(transfer.leaseOfTarget(first.webContents.id), null)
      assert.equal(transfer.leaseOfTarget(second.webContents.id).tabId, 'tab-2')
    })
  }

  console.log('适配器：受限端口')
  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(920)
    const target = new FakeWindow(921)
    const view = host.addTab('tab-3', 503, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({ tabId: 'tab-3', ownerKey: 'sess-a', generation: 4, target })
    const sender = { webContentsId: target.webContents.id, ownerKey: 'sess-a', generation: 4 }

    check('目标窗口 + 归属 + 代次齐全才更新 bounds', () => {
      const ok = transfer.updateBounds(sender, { x: 10, y: 20, width: 300, height: 200 })
      assert.equal(ok.ok, true)
      assert.deepEqual(view.bounds, { x: 10, y: 20, width: 300, height: 200 })
    })
    check('非目标窗口调用被拒，不动视图', () => {
      const stale = transfer.updateBounds({ webContentsId: 999 }, { x: 1, y: 1, width: 1, height: 1 })
      assert.equal(stale.ok, false)
      assert.equal(stale.code, 'stale')
      assert.deepEqual(view.bounds, { x: 10, y: 20, width: 300, height: 200 })
    })
    check('归属或代次不匹配被拒', () => {
      assert.equal(transfer.updateBounds({ ...sender, ownerKey: 'sess-b' }, { x: 1, y: 1, width: 1, height: 1 }).code, 'invalid-owner')
      assert.equal(transfer.updateBounds({ ...sender, generation: 99 }, { x: 1, y: 1, width: 1, height: 1 }).code, 'invalid-owner')
    })
    check('非法坐标被拒，不写坏视图', () => {
      const bad = transfer.updateBounds(sender, { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 5 })
      assert.equal(bad.ok, false)
      assert.deepEqual(view.bounds, { x: 10, y: 20, width: 300, height: 200 })
    })
    await checkAsync('navigate 经宿主只导航这一页签', async () => {
      const result = await transfer.navigate(sender, ' https://example.com ')
      assert.equal(result.ok, true)
      assert.deepEqual(host.navigations, ['https://example.com'])
    })
    await checkAsync('close 经宿主关闭页签并失效租约', async () => {
      const result = await transfer.close(sender)
      assert.equal(result.ok, true)
      assert.deepEqual(host.closed, ['tab-3'])
      assert.equal(transfer.isLeased('tab-3'), false)
      assert.equal(target.contentView.children.includes(view), false)
      assert.equal(host.revokes.size, 0)
    })
  }

  console.log('适配器：归还与失效')
  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(930)
    const target = new FakeWindow(931)
    const view = host.addTab('tab-4', 504, source)
    let invalidations = 0
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({
      tabId: 'tab-4',
      ownerKey: 'sess-a',
      generation: 1,
      target,
      onInvalidate: () => {
        invalidations += 1
      }
    })
    const sender = { webContentsId: target.webContents.id }
    const first = transfer.returnToHost(sender)
    const second = transfer.returnToHost(sender)

    check('主动归还将视图停回主窗口并隐藏', () => {
      assert.equal(first.ok, true)
      assert.equal(source.contentView.children.includes(view), true)
      assert.equal(target.contentView.children.includes(view), false)
      assert.equal(view.visible, false)
      assert.deepEqual(host.ended, [{ tabId: 'tab-4', ownerKey: 'sess-a' }])
    })
    check('归还失效重入幂等：第二次返回 stale，不重复挪动', () => {
      assert.equal(second.ok, false)
      assert.equal(second.code, 'stale')
      assert.equal(invalidations, 1)
      assert.equal(host.ended.length, 1)
    })
  }

  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(940)
    const target = new FakeWindow(941)
    const view = host.addTab('tab-5', 505, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({ tabId: 'tab-5', ownerKey: 'sess-a', generation: 1, target })
    const count = transfer.invalidateOwner('sess-a', 'owner-stale')
    check('owner 失效：归还视图、清租约、返回处理数量', () => {
      assert.equal(count, 1)
      assert.equal(transfer.isLeased('tab-5'), false)
      assert.equal(source.contentView.children.includes(view), true)
      assert.equal(target.contentView.children.includes(view), false)
      assert.equal(host.ended.length, 1)
    })
    check('再次失效同一 owner 无副作用', () => {
      assert.equal(transfer.invalidateOwner('sess-a', 'owner-stale'), 0)
      assert.equal(host.ended.length, 1)
    })
  }

  console.log('适配器：错误回滚与宿主回收')
  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(950)
    const deadTarget = new FakeWindow(951)
    deadTarget.destroyed = true
    const view = host.addTab('tab-6', 506, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    const result = transfer.begin({ tabId: 'tab-6', ownerKey: 'sess-a', generation: 1, target: deadTarget })
    check('目标窗口不可用：拒绝且视图留在来源窗口', () => {
      assert.equal(result.ok, false)
      assert.equal(result.code, 'target-closed')
      assert.equal(source.contentView.children.includes(view), true)
      assert.equal(transfer.isLeased('tab-6'), false)
      assert.equal(host.begun.length, 0)
    })
  }

  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(960)
    const target = new FakeWindow(961)
    const view = host.addTab('tab-7', 507, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({ tabId: 'tab-7', ownerKey: 'sess-a', generation: 1, target })
    host.tabs.delete('tab-7')
    host.revokes.get('tab-7')?.('tab-closed')
    host.revokes.delete('tab-7')
    check('宿主回收（页签关闭）：摘除视图、清租约，不调 endHostTransfer', () => {
      assert.equal(transfer.isLeased('tab-7'), false)
      assert.equal(target.contentView.children.includes(view), false)
      assert.equal(host.ended.length, 0)
    })
    check('宿主回收后重复 revoke 幂等', () => {
      host.revokes.get('tab-7')?.('tab-closed')
      assert.equal(transfer.isLeased('tab-7'), false)
    })
  }

  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(970)
    const target = new FakeWindow(971)
    const view = host.addTab('tab-8', 508, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({ tabId: 'tab-8', ownerKey: 'sess-a', generation: 1, target })
    source.destroyed = true
    const result = transfer.invalidateOwner('sess-a', 'owner-stale')
    check('主窗口已销毁：仍能摘除视图且不抛错', () => {
      assert.equal(result, 1)
      assert.equal(view.visible, false)
      assert.equal(target.contentView.children.includes(view), false)
      assert.equal(transfer.isLeased('tab-8'), false)
    })
  }

  console.log('适配器：多页签与多归属隔离')
  resetCounters()
  {
    const host = new FakeHost()
    const source = new FakeWindow(980)
    const targetA = new FakeWindow(981)
    const targetB = new FakeWindow(982)
    const viewA = host.addTab('tab-a', 601, source)
    const viewB = host.addTab('tab-b', 602, source)
    const transfer = transferMod.createPaneBrowserTransfer(host)
    transfer.begin({ tabId: 'tab-a', ownerKey: 'sess-a', generation: 1, target: targetA })
    transfer.begin({ tabId: 'tab-b', ownerKey: 'sess-b', generation: 1, target: targetB })
    check('两条租约各挂各的目标窗口，互不串', () => {
      assert.equal(targetA.contentView.children.includes(viewA), true)
      assert.equal(targetA.contentView.children.includes(viewB), false)
      assert.equal(targetB.contentView.children.includes(viewB), true)
      assert.equal(targetB.contentView.children.includes(viewA), false)
    })
    check('失效一个 owner 不影响另一个', () => {
      transfer.invalidateOwner('sess-a', 'owner-stale')
      assert.equal(transfer.isLeased('tab-a'), false)
      assert.equal(transfer.isLeased('tab-b'), true)
      assert.equal(targetB.contentView.children.includes(viewB), true)
      assert.equal(source.contentView.children.includes(viewA), true)
    })
    check('dispose 释放所有租约且幂等', () => {
      transfer.dispose()
      assert.equal(transfer.isLeased('tab-b'), false)
      assert.equal(targetB.contentView.children.includes(viewB), false)
      assert.equal(host.ended.length, 2)
      transfer.dispose()
      assert.equal(host.ended.length, 2)
    })
  }

  console.log('浏览器控制器：借出守卫')
  resetCounters()
  {
    const browserMod = await compile('src/main/browser.ts', join(dir, 'browser.mjs'), true)
    const BrowserWindowMock = globalThis.__MockBrowserWindow
    const mainWin = new BrowserWindowMock()
    const popupWin = new BrowserWindowMock()
    const pushes = []
    const controller = new browserMod.BrowserController(() => mainWin, (message) => pushes.push(message))

    await controller.newTab('about:blank')
    const state = controller.getState()
    const tabId = state.activeTabId
    const tab = controller.getState().tabs.find((item) => item.id === tabId)
    assert.ok(tab, 'newTab 应创建标签页')
    const originalView = mainWin.contentView.children.find((child) => child.webContents && child.webContents.id !== mainWin.webContents.id)
    assert.ok(originalView, '主窗口应挂上新建的原生视图')
    const webContentsId = originalView.webContents.id
    const viewCreationsAfterTab = globalThis.__viewCreations

    let revoked = null
    const begin = controller.beginHostTransfer({
      tabId,
      ownerKey: 'sess-a',
      generation: 1,
      onRevoke: (reason) => {
        revoked = reason
      }
    })
    check('beginHostTransfer 返回同一视图句柄与身份', () => {
      assert.equal(begin.ok, true)
      assert.equal(begin.transfer.tabId, tabId)
      assert.equal(begin.transfer.webContentsId, webContentsId)
      assert.equal(begin.transfer.view, originalView)
      assert.equal(begin.transfer.sourceWindow, mainWin)
    })
    mainWin.contentView.removeChildView(originalView)
    popupWin.contentView.addChildView(originalView)
    originalView.setVisible(true)

    check('主窗口旧 setBounds 不再移动已借出的视图', () => {
      controller.setBounds({ x: 11, y: 22, width: 333, height: 222 })
      assert.equal(originalView.__bounds, null)
    })
    check('主窗口旧 setViewVisible 不再隐藏/显示已借出的视图', () => {
      controller.setViewVisible(false)
      assert.equal(originalView.__visible, true)
      controller.setViewVisible(true)
      assert.equal(originalView.__visible, true)
    })
    check('借出期间未新建视图', () => {
      assert.equal(globalThis.__viewCreations, viewCreationsAfterTab)
    })
    check('不同归属不能借同一页签', () => {
      const conflict = controller.beginHostTransfer({ tabId, ownerKey: 'sess-b', generation: 1, onRevoke: () => {} })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.code, 'owner-conflict')
      assert.equal(popupWin.contentView.children.includes(originalView), true)
    })
    check('endHostTransfer 让视图停回主窗口并隐藏', () => {
      const ended = controller.endHostTransfer(tabId, 'sess-a')
      assert.equal(ended, true)
      assert.equal(mainWin.contentView.children.includes(originalView), true)
      assert.equal(popupWin.contentView.children.includes(originalView), false)
      assert.equal(originalView.__visible, false)
      assert.equal(controller.endHostTransfer(tabId, 'sess-a'), false)
    })
    check('归还后主窗口重新可协调该视图', () => {
      controller.setViewVisible(false)
      assert.equal(originalView.__visible, false)
      controller.setViewVisible(true)
      assert.equal(originalView.__visible, true)
    })

    const second = controller.beginHostTransfer({ tabId, ownerKey: 'sess-a', generation: 2, onRevoke: (reason) => { revoked = reason } })
    assert.equal(second.ok, true)
    await controller.closeTab(tabId)
    check('关闭借出中的页签会回调 revoke 且不抛错', () => {
      assert.equal(revoked, 'tab-closed')
      assert.equal(controller.getState().tabs.some((item) => item.id === tabId), false)
    })

    await controller.close()
  }

  console.log('适配器 × 控制器集成')
  resetCounters()
  {
    const browserMod = await compile('src/main/browser.ts', join(dir, 'browser-int.mjs'), true)
    const BrowserWindowMock = globalThis.__MockBrowserWindow
    const mainWin = new BrowserWindowMock()
    const popupWin = new BrowserWindowMock()
    const pushes = []
    const controller = new browserMod.BrowserController(() => mainWin, (message) => pushes.push(message))
    await controller.newTab('about:blank')
    const tabId = controller.getState().activeTabId
    const view = mainWin.contentView.children.find((child) => child.webContents && child.webContents.id !== mainWin.webContents.id)
    const webContentsId = view.webContents.id
    const creationsAfterTab = globalThis.__viewCreations

    const transfer = transferMod.createPaneBrowserTransfer({
      beginHostTransfer: (request) => controller.beginHostTransfer(request),
      endHostTransfer: (tabIdArg, ownerKey) => controller.endHostTransfer(tabIdArg, ownerKey)
    })
    const begun = transfer.begin({ tabId, ownerKey: 'sess-a', generation: 1, target: popupWin })
    check('适配器把控制器的真实视图改挂到弹窗，身份不变', () => {
      assert.equal(begun.ok, true)
      assert.equal(mainWin.contentView.children.includes(view), false)
      assert.equal(popupWin.contentView.children.includes(view), true)
      assert.equal(view.webContents.id, webContentsId)
      assert.equal(begun.lease.webContentsId, webContentsId)
      assert.equal(globalThis.__viewCreations, creationsAfterTab)
    })
    check('组合下主窗口旧显隐/坐标仍不碰借出视图', () => {
      transfer.updateBounds({ webContentsId: popupWin.webContents.id }, { x: 4, y: 5, width: 60, height: 70 })
      assert.deepEqual(view.__bounds, { x: 4, y: 5, width: 60, height: 70 })
      controller.setBounds({ x: 99, y: 99, width: 9, height: 9 })
      controller.setViewVisible(false)
      assert.deepEqual(view.__bounds, { x: 4, y: 5, width: 60, height: 70 })
      assert.equal(view.__visible, true)
    })
    check('组合下归还后视图停回主窗口且隐藏', () => {
      const returned = transfer.returnToHost({ webContentsId: popupWin.webContents.id })
      assert.equal(returned.ok, true)
      assert.equal(mainWin.contentView.children.includes(view), true)
      assert.equal(popupWin.contentView.children.includes(view), false)
      assert.equal(view.__visible, false)
      assert.equal(transfer.isLeased(tabId), false)
    })
    await controller.close()
  }

  console.log(`\nv3 浏览器页签原生视图转移：${passed} 项断言通过`)
} finally {
  delete globalThis.__MockBrowserWindow
  delete globalThis.__MockWebContentsView
  await rm(dir, { recursive: true, force: true })
}
