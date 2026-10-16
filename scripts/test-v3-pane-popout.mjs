/**
 * 页签弹出窗纯本地单测（v3 · WP-30 弹出）。
 *
 * 不启动 Electron、不开窗口、不起 pi、不写用户数据。用 esbuild 把 `electron`
 * 换成内存替身（BrowserWindow 记录实例、bounds、发送的消息），因此控制器的真实
 * 生命周期逻辑（owner 锁定、epoch 丢弃、失效释放、动作白名单、关闭回收）都在
 * 覆盖范围内；几何与共享契约是纯函数，直接编译后断言。
 *
 * 可独立执行：node scripts/test-v3-pane-popout.mjs
 */
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

/** 内存版 electron：只实现控制器用到的最小 BrowserWindow 面。 */
const electronMock = `export class BrowserWindow {
  constructor(options) {
    this.options = options
    this.destroyed = false
    this.visible = false
    this.title = ''
    this.bounds = null
    this.zoom = 1
    this.sent = []
    this.handlers = {}
    const self = this
    this.webContents = {
      id: (globalThis.__paneWcSeq = (globalThis.__paneWcSeq || 0) + 1),
      isDestroyed: () => self.destroyed,
      setZoomFactor: (f) => { self.zoom = f },
      send: (channel, payload) => { if (!self.destroyed) self.sent.push([channel, payload]) }
    }
    ;(globalThis.__paneMockWindows ||= []).push(this)
  }
  setBounds(bounds) { this.bounds = bounds }
  show() { this.visible = true }
  hide() { this.visible = false }
  focus() {}
  isVisible() { return this.visible }
  isDestroyed() { return this.destroyed }
  setTitle(title) { this.title = title }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed') }
  on(event, cb) { (this.handlers[event] ||= []).push(cb) }
  emit(event, ...args) { (this.handlers[event] || []).slice().forEach((cb) => cb(...args)) }
}
export const ipcMain = {
  handle: (channel, fn) => { (globalThis.__paneIpcHandlers ||= {})[channel] = fn },
  on: (channel, fn) => { (globalThis.__paneIpcListeners ||= {})[channel] = fn }
}
`

const electronPlugin = {
  name: 'pane-electron-mock',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'pane-mock' }))
    buildApi.onLoad({ filter: /.*/, namespace: 'pane-mock' }, () => ({ contents: electronMock, loader: 'js' }))
  }
}

async function compile(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [electronPlugin]
  })
  return import(pathToFileURL(outfile).href)
}

const mockWindows = () => (globalThis.__paneMockWindows || [])

const dir = await mkdtemp(join(tmpdir(), 'v3-pane-popout-'))
try {
  const shared = await compile('src/shared/pane-popout.ts', join(dir, 'shared.mjs'))
  const geometry = await compile('src/main/windows/pane-popout-geometry.ts', join(dir, 'geometry.mjs'))
  const controllerMod = await compile('src/main/windows/pane-popout-controller.ts', join(dir, 'controller.mjs'))
  const ipcMod = await compile('src/main/windows/pane-popout-ipc.ts', join(dir, 'ipc.mjs'))
  const clientMod = await compile('src/renderer/src/features/workbench/pane-popout-client.ts', join(dir, 'client.mjs'))

  const host = {
    preloadPath: () => '/preload/index.cjs',
    loadEntry: () => {},
    anchorBounds: () => ({ x: 100, y: 100, width: 1000, height: 800 }),
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    zoomFactor: () => 1.25,
    locale: () => 'zh-CN'
  }
  const ownerA = { key: 'sess-a', sessionId: 'a', cwd: 'C:/proj-a', active: true }
  const ownerB = { key: 'sess-b', sessionId: 'b', cwd: 'C:/proj-b', active: false }
  const filesProjection = { kind: 'files', root: 'C:/proj-a', rows: [{ path: 'a.ts', name: 'a.ts', dir: false, depth: 0 }] }
  const reset = () => {
    globalThis.__paneMockWindows = []
  }

  console.log('shared 契约')
  check('支持矩阵：DOM-only 与 browser 支持；terminal / preview 仍不支持', () => {
    assert.equal(shared.isPopoutSupported('files'), true)
    assert.equal(shared.isPopoutSupported('changes'), true)
    assert.equal(shared.isPopoutSupported('context'), true)
    assert.equal(shared.isPopoutSupported('branch'), true)
    assert.equal(shared.isPopoutSupported('browser'), true)
    assert.equal(shared.isPopoutSupported('terminal'), false)
    assert.equal(shared.isPopoutSupported('preview'), false)
    assert.equal(shared.PANE_TRANSFER_MATRIX.browser.kind, 'native-view')
    assert.equal(shared.PANE_TRANSFER_MATRIX.terminal.kind, 'terminal-attach')
    assert.equal(shared.PANE_TRANSFER_MATRIX.preview.kind, 'iframe')
    assert.ok(shared.PANE_NATIVE_TRANSFER_FOLLOW_UP.length >= 3)
  })
  check('页签与动作白名单', () => {
    assert.equal(shared.isPanePopoutTab('files'), true)
    assert.equal(shared.isPanePopoutTab('preview'), false)
    assert.equal(shared.isPaneNativeTab('preview'), true)
    assert.equal(shared.isPaneActionAllowed('files', 'files.preview'), true)
    assert.equal(shared.isPaneActionAllowed('files', 'files.attach'), true)
    assert.equal(shared.isPaneActionAllowed('context', 'files.preview'), false)
    assert.equal(shared.isPaneActionAllowed('branch', 'refresh'), true)
  })
  check('通道名固定', () => {
    assert.equal(shared.PANE_POPOUT_CHANNELS.push, 'yan:pane-popout:push')
    assert.equal(shared.PANE_POPOUT_CHANNELS.actionEvent, 'yan:pane-popout:action-event')
  })

  console.log('geometry')
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  check('贴主窗口右侧', () => {
    const b = geometry.computePanePopoutBounds({
      anchor: { x: 100, y: 100, width: 1000, height: 800 },
      area,
      size: { width: 460, height: 620 }
    })
    assert.deepEqual(b, { x: 1112, y: 100, width: 460, height: 620 })
  })
  check('右侧放不下改贴左侧', () => {
    const b = geometry.computePanePopoutBounds({
      anchor: { x: 1500, y: 0, width: 420, height: 600 },
      area,
      size: { width: 460, height: 620 }
    })
    assert.equal(b.x, 1028)
  })
  check('无主窗口时贴工作区左上', () => {
    const b = geometry.computePanePopoutBounds({ area, size: { width: 460, height: 620 } })
    assert.deepEqual(b, { x: 12, y: 12, width: 460, height: 620 })
  })
  check('多窗纵向错位且裁回工作区', () => {
    const b = geometry.computePanePopoutBounds({
      anchor: { x: 100, y: 100, width: 1000, height: 900 },
      area,
      size: { width: 460, height: 620 },
      index: 2
    })
    assert.equal(b.y, 156)
    assert.ok(b.y + b.height <= area.height)
  })

  console.log('controller 生命周期')
  reset()
  const controller = controllerMod.createPanePopoutController(host)
  const openA = controller.open({ tab: 'files', owner: ownerA })
  const winA = mockWindows()[0]
  check('打开 DOM-only 页签：创建窗口、锁定 owner/epoch、跟随缩放与位置', () => {
    assert.equal(openA.ok, true)
    assert.equal(openA.epoch, 1)
    assert.equal(mockWindows().length, 1)
    assert.equal(winA.options.show, false)
    assert.equal(winA.options.webPreferences.sandbox, true)
    assert.equal(winA.options.webPreferences.nodeIntegration, false)
    assert.equal(winA.title, '文件 · 独立窗口')
    assert.equal(winA.bounds.x, 1112)
    assert.equal(winA.zoom, 1.25)
    assert.equal(controller.owns(winA.webContents), true)
    assert.equal(controller.owns({}), false)
  })
  check('初次状态：无投影、动作按页签白名单', () => {
    const state = controller.stateFor(winA.webContents)
    assert.equal(state.tab, 'files')
    assert.equal(state.owner.key, 'sess-a')
    assert.equal(state.epoch, 1)
    assert.equal(state.invalidated, false)
    assert.equal(state.projection, null)
    assert.deepEqual(state.actions, ['files.preview', 'files.attach', 'refresh'])
  })
  check('投影：owner / epoch 不匹配一律丢弃', () => {
    assert.equal(controller.updateProjection({ tab: 'files', ownerKey: 'other', epoch: 1, projection: filesProjection }), false)
    assert.equal(controller.updateProjection({ tab: 'files', ownerKey: 'sess-a', epoch: 99, projection: filesProjection }), false)
    assert.equal(controller.stateFor(winA.webContents).projection, null)
    assert.equal(controller.updateProjection({ tab: 'files', ownerKey: 'sess-a', epoch: 1, projection: filesProjection }), true)
    const state = controller.stateFor(winA.webContents)
    assert.equal(state.projection.kind, 'files')
    const lastPush = winA.sent.at(-1)
    assert.equal(lastPush[0], 'yan:pane-popout:push')
    assert.equal(lastPush[1].projection.root, 'C:/proj-a')
  })
  check('重复打开同归属复用窗口，不重挂', () => {
    const again = controller.open({ tab: 'files', owner: ownerA })
    assert.equal(again.ok, true)
    assert.equal(again.epoch, 1)
    assert.equal(mockWindows().length, 1)
  })
  check('切换归属：新 epoch、清空旧投影、旧代次迟到丢弃', () => {
    const rebind = controller.open({ tab: 'files', owner: ownerB })
    assert.equal(rebind.ok, true)
    assert.equal(rebind.epoch, 2)
    assert.equal(mockWindows().length, 1)
    const state = controller.stateFor(winA.webContents)
    assert.equal(state.owner.key, 'sess-b')
    assert.equal(state.projection, null)
    assert.equal(controller.updateProjection({ tab: 'files', ownerKey: 'sess-a', epoch: 1, projection: filesProjection }), false)
    assert.equal(controller.updateProjection({ tab: 'files', ownerKey: 'sess-b', epoch: 2, projection: filesProjection }), true)
  })
  check('owner 失效：进入不可操作态并释放数据', () => {
    controller.invalidate('sess-b', '会话已切换')
    const state = controller.stateFor(winA.webContents)
    assert.equal(state.invalidated, true)
    assert.equal(state.invalidReason, '会话已切换')
    assert.equal(state.projection, null)
    assert.deepEqual(state.actions, [])
    assert.equal(state.readOnly, true)
    assert.equal(controller.updateProjection({ tab: 'files', ownerKey: 'sess-b', epoch: 2, projection: filesProjection }), false)
  })
  check('closeByContents 关闭并回收', () => {
    assert.equal(controller.closeByContents(winA.webContents), true)
    assert.equal(winA.destroyed, true)
    assert.equal(controller.owns(winA.webContents), false)
    assert.equal(controller.closeByContents(winA.webContents), false)
  })

  console.log('controller 动作与原生拒绝')
  reset()
  const received = []
  const controller2 = controllerMod.createPanePopoutController(host, { onAction: (event) => received.push(event) })
  controller2.open({ tab: 'changes', owner: ownerA })
  const winC = mockWindows()[0]
  check('changes 只允许 refresh', () => {
    assert.equal(controller2.handleAction(winC.webContents, { type: 'files.preview', path: 'x' }).ok, false)
    assert.equal(controller2.handleAction(winC.webContents, { type: 'refresh' }).ok, true)
    assert.deepEqual(received, [
      { tab: 'changes', ownerKey: 'sess-a', epoch: controller2.epochOf('changes'), action: { type: 'refresh' } }
    ])
  })
  check('非弹出窗来源拒绝动作', () => {
    assert.equal(controller2.handleAction({}, { type: 'refresh' }).ok, false)
  })
  reset()
  const controller3 = controllerMod.createPanePopoutController(host, { onAction: () => {} })
  controller3.open({ tab: 'files', owner: ownerA })
  const winF = mockWindows()[0]
  check('files.preview 必须带路径；authorize 可再收紧', () => {
    assert.equal(controller3.handleAction(winF.webContents, { type: 'files.preview' }).ok, false)
    assert.equal(controller3.handleAction(winF.webContents, { type: 'files.preview', path: 'a.ts' }).ok, true)
    const strict = controllerMod.createPanePopoutController(host, { authorize: () => false })
    strict.open({ tab: 'files', owner: ownerA })
    const winS = mockWindows().at(-1)
    assert.equal(strict.handleAction(winS.webContents, { type: 'files.preview', path: 'a.ts' }).ok, false)
  })
  reset()
  const controller4 = controllerMod.createPanePopoutController(host)
  check('原生页签缺适配器时不创建窗口，返回最小后续清单', () => {
    for (const tab of ['browser', 'terminal', 'preview']) {
      const before = mockWindows().length
      const res = controller4.open({ tab, owner: ownerA })
      assert.equal(res.ok, false)
      assert.equal(res.code, 'unsupported')
      assert.equal(mockWindows().length, before)
      assert.ok((res.followUp || []).length >= 3)
      assert.equal(controller4.isOpen(tab), false)
    }
  })
  check('browser / terminal 走注入的 transfer adapter，preview 仍拒绝', () => {
    reset()
    const terminalCalls = []
    const fakeBrowser = {
      kind: 'native-view',
      begin: () => ({ ok: true, code: 'ok' }),
      updateBounds: () => ({ ok: true, code: 'ok' }),
      navigate: async () => ({ ok: true, code: 'ok' }),
      goBack: () => ({ ok: true, code: 'ok' }),
      goForward: () => ({ ok: true, code: 'ok' }),
      reload: () => ({ ok: true, code: 'ok' }),
      navigationState: () => ({ url: 'https://example.test/', canGoBack: true, canGoForward: false }),
      close: async () => ({ ok: true, code: 'ok' }),
      returnToHost: () => ({ ok: true, code: 'ok' }),
      invalidateOwner: () => 1,
      invalidateTab: () => true,
      invalidateAll: () => {},
      leaseOfTab: () => null,
      leaseOfTarget: () => null,
      isLeased: () => false,
      owns: () => true,
      dispose: () => {}
    }
    const fakeTerminal = {
      kind: 'terminal-attach',
      canTransfer: (request) => request.tab === 'terminal' && request.terminalId === 'term-1',
      transfer: (request) => {
        terminalCalls.push(request)
        return { ok: true }
      },
      invalidate: (ownerKey) => terminalCalls.push(['invalidate', ownerKey]),
      invalidateAll: () => terminalCalls.push(['invalidate-all'])
    }
    const controllerNative = controllerMod.createPanePopoutController(host, {
      browserTransfer: fakeBrowser,
      terminalTransfer: fakeTerminal
    })
    const browser = controllerNative.open({ tab: 'browser', owner: ownerA, viewId: 'tab-7' })
    assert.equal(browser.ok, true)
    const browserWin = mockWindows().at(-1)
    assert.equal(controllerNative.ownsBrowser(browserWin.webContents), true)
    const browserState = controllerNative.browserStateFor(browserWin.webContents)
    assert.equal(browserState.tabId, 'tab-7')
    assert.equal(browserState.url, 'https://example.test/')
    assert.equal(browserState.canGoBack, true)
    assert.equal(browserState.canGoForward, false)
    assert.equal(typeof browserState.zoomFactor, 'number')

    const term = controllerNative.open({ tab: 'terminal', owner: ownerA, terminalId: 'term-1' })
    assert.equal(term.ok, true)
    assert.equal(terminalCalls.at(-1).tab, 'terminal')
    assert.equal(terminalCalls.at(-1).terminalId, 'term-1')
    assert.equal(controllerNative.isOpen('terminal'), false)

    const missing = controllerNative.open({ tab: 'terminal', owner: ownerA, terminalId: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'unsupported')
    const preview = controllerNative.open({ tab: 'preview', owner: ownerA })
    assert.equal(preview.ok, false)
    assert.equal(preview.code, 'unsupported')

    controllerNative.invalidate('sess-a', '会话已切换')
    assert.equal(terminalCalls.at(-1)[0], 'invalidate')
    controllerNative.closeByContents(browserWin.webContents)
    assert.equal(controllerNative.ownsBrowser(browserWin.webContents), false)
  })
  check('多页签并存与 closeAll 回收', () => {
    reset()
    controller4.open({ tab: 'files', owner: ownerA })
    controller4.open({ tab: 'context', owner: ownerA })
    assert.deepEqual(controller4.openTabs().sort(), ['context', 'files'])
    assert.equal(mockWindows().length, 2)
    controller4.closeAll()
    assert.deepEqual(controller4.openTabs(), [])
    assert.ok(mockWindows().every((w) => w.destroyed))
  })
  check('用户关闭窗口后控制器不再持有', () => {
    reset()
    const controller5 = controllerMod.createPanePopoutController(host)
    controller5.open({ tab: 'branch', owner: ownerA })
    const win = mockWindows()[0]
    win.destroy()
    assert.equal(controller5.isOpen('branch'), false)
    assert.equal(controller5.owns(win.webContents), false)
  })

  console.log('IPC 来源分流')
  reset()
  globalThis.__paneIpcHandlers = {}
  globalThis.__paneIpcListeners = {}
  const ipcController = controllerMod.createPanePopoutController(host, { onAction: () => {} })
  const mainContents = { id: 'main' }
  ipcMod.registerPanePopoutIpc(ipcController, { isMainWindow: (contents) => contents === mainContents })
  check('open 只接受主窗口来源', () => {
    const handler = globalThis.__paneIpcHandlers['yan:pane-popout:open']
    assert.throws(() => handler({ sender: {} }, { tab: 'files', owner: ownerA }), /非主窗口/)
    const ok = handler({ sender: mainContents }, { tab: 'files', owner: ownerA })
    assert.equal(ok.ok, true)
  })
  check('state / action 只接受弹出窗自身来源', () => {
    const popup = mockWindows()[0].webContents
    const stateHandler = globalThis.__paneIpcHandlers['yan:pane-popout:state']
    assert.throws(() => stateHandler({ sender: {} }), /非弹出窗/)
    assert.equal(stateHandler({ sender: popup }).tab, 'files')
    const actionHandler = globalThis.__paneIpcHandlers['yan:pane-popout:action']
    assert.equal(actionHandler({ sender: {} }, { type: 'refresh' }).ok, false)
    assert.equal(actionHandler({ sender: popup }, { type: 'refresh' }).ok, true)
  })
  check('update / close 忽略非主窗口来源', () => {
    const update = globalThis.__paneIpcListeners['yan:pane-popout:update']
    const close = globalThis.__paneIpcListeners['yan:pane-popout:close']
    update({ sender: {} }, { tab: 'files', ownerKey: 'sess-a', epoch: 1, projection: filesProjection })
    assert.equal(ipcController.stateFor(mockWindows()[0].webContents).projection, null)
    update({ sender: mainContents }, { tab: 'files', ownerKey: 'sess-a', epoch: ipcController.epochOf('files'), projection: filesProjection })
    assert.equal(ipcController.stateFor(mockWindows()[0].webContents).projection.kind, 'files')
    close({ sender: {} }, 'files')
    assert.equal(ipcController.isOpen('files'), true)
    close({ sender: mainContents }, 'files')
    assert.equal(ipcController.isOpen('files'), false)
  })

  console.log('主窗口客户端')
  const sent = []
  let actionCb = null
  const bridge = {
    open: async (req) => {
      sent.push(['open', req])
      return { ok: true, code: 'ok', epoch: 7 }
    },
    update: (envelope) => sent.push(['update', envelope]),
    close: (tab) => sent.push(['close', tab]),
    onAction: (cb) => {
      actionCb = cb
      return () => {
        actionCb = null
      }
    }
  }
  const forwarded = []
  const source = {
    snapshot: () => ({
      locale: 'zh-CN',
      files: { root: 'C:/proj-a', rows: [{ path: 'a.ts', name: 'a.ts', dir: false, depth: 0 }] }
    }),
    onAction: (event) => forwarded.push(event)
  }
  const client = clientMod.createPanePopoutClient({ bridge, source })
  const wsOwner = { key: 'sess-a', sessionId: 'a', cwd: 'C:/proj-a', active: true, generation: 3 }

  await checkAsync('打开后立即推送受限投影（带 epoch）', async () => {
    const res = await client.open('files', wsOwner)
    assert.equal(res.ok, true)
    assert.equal(client.isOpen('files'), true)
    assert.equal(sent[0][0], 'open')
    assert.equal(sent[0][1].owner.key, 'sess-a')
    assert.equal(sent[0][1].owner.generation, 3)
    const update = sent.find(([kind]) => kind === 'update')
    assert.equal(update[1].ownerKey, 'sess-a')
    assert.equal(update[1].epoch, 7)
    assert.equal(update[1].projection.kind, 'files')
  })
  await checkAsync('browser 打开时带 viewId；terminal 未注入终端桥时在客户端即被拒', async () => {
    const before = sent.filter(([kind]) => kind === 'open').length
    const browser = await client.open('browser', wsOwner, { viewId: 'tab-7' })
    assert.equal(browser.ok, true)
    const browserOpen = sent.filter(([kind]) => kind === 'open').at(-1)
    assert.equal(browserOpen[1].tab, 'browser')
    assert.equal(browserOpen[1].viewId, 'tab-7')
    assert.equal(sent.filter(([kind]) => kind === 'open').length, before + 1)
    const res = await client.open('terminal', wsOwner, { terminalId: 'term-1' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'unsupported')
    assert.equal(client.canPopout('terminal'), false)
    assert.equal(client.canPopoutTerminal(), false)
  })
  await checkAsync('注入终端桥后：openTerminal 交 owner + terminalId，不请求 DOM 打开', async () => {
    const terminalSent = []
    /* 单独一份桥，避免重订阅影响上一个客户端订阅的 onAction。 */
    const terminalBridge = {
      open: async () => ({ ok: true, code: 'ok', epoch: 1 }),
      update: () => {},
      close: () => {},
      onAction: () => () => {}
    }
    const terminalClient = clientMod.createPanePopoutClient({
      bridge: terminalBridge,
      source,
      terminalBridge: {
        open: async (req) => {
          terminalSent.push(req)
          return { ok: true, code: 'ok', leaseId: 'L1', epoch: 3 }
        },
        state: async () => null,
        input: async () => true,
        resize: async () => true,
        detach: async () => true,
        closeSelf: () => {},
        onPush: () => () => {}
      }
    })
    assert.equal(terminalClient.canPopout('terminal'), true)
    assert.equal(terminalClient.canPopoutTerminal(), true)
    const openedBefore = sent.filter(([kind]) => kind === 'open').length
    const res = await terminalClient.openTerminal(wsOwner, 'term-9')
    assert.equal(res.ok, true)
    assert.equal(terminalSent[0].owner.key, 'sess-a')
    assert.equal(terminalSent[0].terminalId, 'term-9')
    assert.equal(sent.filter(([kind]) => kind === 'open').length, openedBefore)
  })
  check('动作：epoch 匹配才转交，过期动作丢弃', () => {
    actionCb({ tab: 'files', ownerKey: 'sess-a', epoch: 7, action: { type: 'refresh' } })
    assert.equal(forwarded.length, 1)
    actionCb({ tab: 'files', ownerKey: 'sess-a', epoch: 8, action: { type: 'refresh' } })
    actionCb({ tab: 'files', ownerKey: 'sess-x', epoch: 7, action: { type: 'refresh' } })
    assert.equal(forwarded.length, 1)
  })
  check('投影快照：缺数据返回 null，不伪造空列表', () => {
    assert.equal(clientMod.projectionFromSnapshot('changes', {}), null)
    assert.equal(clientMod.projectionFromSnapshot('files', {}), null)
    assert.equal(clientMod.projectionFromSnapshot('files', source.snapshot()).kind, 'files')
    assert.equal(clientMod.ownerToPanePopout(wsOwner).generation, 3)
  })
  check('关闭后清空客户端记录', () => {
    client.close('files')
    assert.equal(client.isOpen('files'), false)
    assert.ok(sent.some(([kind, tab]) => kind === 'close' && tab === 'files'))
  })

  console.log(`\nv3 页签弹出窗：${passed} 项断言通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
