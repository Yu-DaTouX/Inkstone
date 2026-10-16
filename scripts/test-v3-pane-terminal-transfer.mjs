import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
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

const electronMock = `export class BrowserWindow {
  constructor() { this.webContents = { isDestroyed: () => true, setZoomFactor: () => {}, send: () => {} } }
  on() {}
  destroy() {}
}
export const ipcMain = {
  handle: (channel, fn) => { (globalThis.__termIpcHandlers ||= {})[channel] = fn },
  on: (channel, fn) => { (globalThis.__termIpcListeners ||= {})[channel] = fn }
}
`

const electronPlugin = {
  name: 'pane-terminal-electron-mock',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'term-mock' }))
    buildApi.onLoad({ filter: /.*/, namespace: 'term-mock' }, () => ({ contents: electronMock, loader: 'js' }))
  }
}

async function compile(entry, outfile, withElectron) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    ...(withElectron ? { plugins: [electronPlugin] } : {})
  })
  return import(pathToFileURL(outfile).href)
}

function fakeWindow() {
  const wc = { paneTerminal: true }
  const win = {
    wc,
    destroyed: false,
    visible: false,
    title: '',
    sent: [],
    onClosed: null,
    show() {
      this.visible = true
    },
    hide() {
      this.visible = false
    },
    isVisible() {
      return this.visible
    },
    browserWindow() {
      return null
    },
    webContents() {
      return this.destroyed ? null : this.wc
    },
    send(channel, payload) {
      if (!this.destroyed) this.sent.push([channel, payload])
    },
    setTitle(title) {
      this.title = title
    },
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.onClosed?.()
    }
  }
  return win
}

const dir = await mkdtemp(join(tmpdir(), 'v3-pane-terminal-'))
try {
  const shared = await compile('src/shared/pane-terminal.ts', join(dir, 'shared.mjs'), false)
  const adapterMod = await compile('src/main/windows/pane-terminal-transfer.ts', join(dir, 'adapter.mjs'), true)

  console.log('shared 契约')
  check('owner 形状校验：只认有 key/cwd/active 的对象', () => {
    assert.equal(shared.isPaneTerminalOwner({ key: 's', cwd: '/x', active: true }), true)
    assert.equal(shared.isPaneTerminalOwner({ key: '', cwd: '/x', active: true }), false)
    assert.equal(shared.isPaneTerminalOwner({ key: 's', cwd: '/x' }), false)
    assert.equal(shared.isPaneTerminalOwner(null), false)
  })
  check('行列 clamp 与宿主同一量级', () => {
    assert.equal(shared.clampPaneTerminalDimension(120, 80), 120)
    assert.equal(shared.clampPaneTerminalDimension(1, 80), 2)
    assert.equal(shared.clampPaneTerminalDimension(99999, 80), 1000)
    assert.equal(shared.clampPaneTerminalDimension(Number.NaN, 80), 80)
  })
  check('快照折叠去掉 shell 细节、保留 status/exitCode', () => {
    const snap = shared.toPaneTerminalSnapshot({
      id: 't1',
      title: 'pwsh · proj',
      cwd: '/proj',
      cols: 80,
      rows: 24,
      alive: true,
      exitCode: null,
      status: { state: 'working', progress: 30 },
      buffer: 'B',
      seq: 5,
      shell: '/bin/bash'
    })
    assert.equal(snap.terminalId, 't1')
    assert.equal(snap.shell, undefined)
    assert.equal(snap.seq, 5)
    assert.equal(snap.status.progress, 30)
  })
  check('通道名固定', () => {
    assert.equal(shared.PANE_TERMINAL_CHANNELS.open, 'yan:pane-terminal:open')
    assert.equal(shared.PANE_TERMINAL_CHANNELS.push, 'yan:pane-terminal:push')
    assert.equal(shared.PANE_TERMINAL_CHANNELS.lease, 'yan:pane-terminal:lease')
  })

  console.log('推送流 PaneTerminalStream')
  check('lease / epoch / terminalId 任一不匹配都丢弃', () => {
    const stream = new shared.PaneTerminalStream({ leaseId: 'L1', epoch: 1, terminalId: 't1' })
    assert.equal(stream.push({ leaseId: 'L2', epoch: 1, terminalId: 't1', kind: 'data', data: 'x', seq: 1 }), null)
    assert.equal(stream.push({ leaseId: 'L1', epoch: 2, terminalId: 't1', kind: 'data', data: 'x', seq: 1 }), null)
    assert.equal(stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't2', kind: 'data', data: 'x', seq: 1 }), null)
  })
  check('attach 前排队、快照后按 seq 去重', () => {
    const stream = new shared.PaneTerminalStream({ leaseId: 'L1', epoch: 1, terminalId: 't1' })
    stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'data', data: 'live4', seq: 4 })
    stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'data', data: 'dup2', seq: 2 })
    const merged = stream.attachSnapshot(3)
    assert.equal(merged.data, 'live4')
    assert.equal(stream.currentSeq, 4)
    assert.equal(stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'data', data: 'old3', seq: 3 }), null)
    assert.equal(stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'data', data: 'new5', seq: 5 }).data, 'new5')
  })
  check('attach 后乱序块被丢弃，status / exit / invalidated 透传', () => {
    const stream = new shared.PaneTerminalStream({ leaseId: 'L1', epoch: 1, terminalId: 't1' })
    stream.attachSnapshot(10)
    assert.equal(stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'data', data: 'late', seq: 9 }), null)
    const st = stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'status', status: { state: 'blocked', kind: 'question' } })
    assert.equal(st.status.state, 'blocked')
    const ex = stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'exit', exitCode: 0 })
    assert.equal(ex.exit, true)
    assert.equal(ex.exitCode, 0)
    const inv = stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'invalidated', reason: '切会话' })
    assert.equal(inv.invalidated, true)
    assert.equal(inv.invalidReason, '切会话')
  })
  check('reset 换 lease 后旧代次不再影响新流', () => {
    const stream = new shared.PaneTerminalStream({ leaseId: 'L1', epoch: 1, terminalId: 't1' })
    stream.attachSnapshot(5)
    stream.reset({ leaseId: 'L2', epoch: 9, terminalId: 't2' })
    assert.equal(stream.isAttached, false)
    assert.equal(stream.push({ leaseId: 'L1', epoch: 1, terminalId: 't1', kind: 'data', data: 'ghost', seq: 6 }), null)
    stream.attachSnapshot(0)
    assert.equal(stream.push({ leaseId: 'L2', epoch: 9, terminalId: 't2', kind: 'data', data: 'ok', seq: 1 }).data, 'ok')
  })

  const ownerA = { key: 'sess-a', sessionId: 'a', cwd: '/proj-a', active: true }
  const ownerB = { key: 'sess-b', sessionId: 'b', cwd: '/proj-b', active: true }
  const ownerInactive = { key: 'sess-a', sessionId: 'a', cwd: '/proj-a', active: false }

  const makeHarness = (overrides = {}) => {
    const windows = []
    const writes = []
    const resizes = []
    const leaseChanges = []
    const snapshots = new Map()
    snapshots.set('t1', {
      terminalId: 't1',
      title: 'pwsh · proj-a',
      cwd: '/proj-a',
      cols: 80,
      rows: 24,
      alive: true,
      exitCode: null,
      buffer: 'B0',
      seq: 3
    })
    const host = {
      preloadPath: () => '/preload/index.cjs',
      loadEntry: () => {},
      anchorBounds: () => undefined,
      workArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      zoomFactor: () => 1,
      locale: () => 'zh-CN',
      read: (id) => snapshots.get(id) ?? null,
      write: (id, data) => {
        const snap = snapshots.get(id)
        writes.push([id, data])
        return !!snap && snap.alive
      },
      resize: (id, cols, rows) => {
        const snap = snapshots.get(id)
        resizes.push([id, cols, rows])
        return !!snap && snap.alive
      },
      authorize: (owner) => owner.active === true && (owner.key === 'sess-a' || owner.key === 'sess-b'),
      ...overrides
    }
    const transfer = adapterMod.createPaneTerminalTransfer(host, {
      createWindow: () => {
        const win = fakeWindow()
        windows.push(win)
        return win
      },
      onLeaseChange: (event) => leaseChanges.push(event)
    })
    return { transfer, host, windows, writes, resizes, leaseChanges, snapshots }
  }

  console.log('适配器：open / 同 id / 不 startkill')
  check('canTransfer 只认 terminal 页签、存在的 PTY 与通过校验的 owner', () => {
    const h = makeHarness()
    assert.equal(h.transfer.canTransfer({ tab: 'terminal', owner: ownerA, terminalId: 't1' }), true)
    assert.equal(h.transfer.canTransfer({ tab: 'browser', owner: ownerA, terminalId: 't1' }), false)
    assert.equal(h.transfer.canTransfer({ tab: 'terminal', owner: ownerA, terminalId: 'nope' }), false)
    assert.equal(h.transfer.canTransfer({ tab: 'terminal', owner: ownerInactive, terminalId: 't1' }), false)
  })
  check('未知终端 / 未授权 owner：不创建窗口', () => {
    const h = makeHarness()
    const missing = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'no-terminal')
    const denied = h.transfer.openFromMainWindow({ owner: ownerInactive, terminalId: 't1' })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'not-owner')
    assert.equal(h.windows.length, 0)
  })
  check('打开有效终端：建立 lease、显示窗口、通知 attached', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'ok')
    assert.ok(res.leaseId)
    assert.equal(typeof res.epoch, 'number')
    assert.equal(h.windows.length, 1)
    assert.equal(h.windows[0].visible, true)
    assert.equal(h.windows[0].title, 'pwsh · proj-a')
    assert.equal(h.leaseChanges.at(-1).kind, 'attached')
    assert.equal(h.transfer.owns(h.windows[0].wc), true)
  })
  check('同一 owner 重复打开复用窗口与 lease，不重挂、epoch 不变', () => {
    const h = makeHarness()
    const first = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const again = h.transfer.openFromMainWindow({ owner: { ...ownerA, cwd: '/proj-a' }, terminalId: 't1' })
    assert.equal(again.ok, true)
    assert.equal(again.leaseId, first.leaseId)
    assert.equal(again.epoch, first.epoch)
    assert.equal(h.windows.length, 1)
  })
  check('适配器结构上没有 start / kill', async () => {
    assert.equal('start' in makeHarness().host, false)
    assert.equal('kill' in makeHarness().host, false)
    const src = await readFile('src/main/windows/pane-terminal-transfer.ts', 'utf8')
    assert.equal(/startTerminal|killTerminal/.test(src), false)
  })

  console.log('适配器：state / input / resize 只限 lease 与来源')
  check('stateFor：attached 后返回快照与 writable', () => {
    const h = makeHarness()
    h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    const view = h.transfer.stateFor(wc)
    assert.equal(view.leaseId, h.transfer.stateFor(wc).leaseId)
    assert.equal(view.terminalId, 't1')
    assert.equal(view.ownerKey, 'sess-a')
    assert.equal(view.writable, true)
    assert.equal(view.snapshot.buffer, 'B0')
    assert.equal(h.transfer.stateFor({ foreign: true }), null)
  })
  check('input：只接受本 lease 与本弹窗来源，写到同一 terminalId', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    assert.equal(h.transfer.input(wc, res.leaseId, 'echo hi'), true)
    assert.deepEqual(h.writes, [['t1', 'echo hi']])
    assert.equal(h.transfer.input(wc, 'wrong-lease', 'x'), false)
    assert.equal(h.transfer.input({ foreign: true }, res.leaseId, 'x'), false)
    assert.deepEqual(h.writes, [['t1', 'echo hi']])
  })
  check('resize：按 lease 解析并 clamp，不动别的终端', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    assert.equal(h.transfer.resize(wc, res.leaseId, 120, 40), true)
    assert.deepEqual(h.resizes, [['t1', 120, 40]])
    h.transfer.resize(wc, res.leaseId, 1, 99999)
    assert.deepEqual(h.resizes.at(-1), ['t1', 2, 1000])
    assert.equal(h.transfer.resize(wc, 'wrong-lease', 100, 30), false)
    assert.equal(h.resizes.length, 2)
  })
  check('PTY 退出后 input / resize 拒绝，但 state 仍可读', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    h.transfer.stateFor(wc)
    h.snapshots.get('t1').alive = false
    assert.equal(h.transfer.input(wc, res.leaseId, 'x'), false)
    assert.equal(h.transfer.resize(wc, res.leaseId, 100, 30), false)
    assert.equal(h.transfer.stateFor(wc).writable, false)
  })

  console.log('适配器：relay / 乱序 / 失效 / 清理')
  check('forward：未 attach 前不转发，attach 后按 leaseId+epoch 转发', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    assert.equal(h.transfer.forward({ kind: 'data', id: 't1', data: 'x', seq: 4 }), false)
    assert.equal(h.transfer.stateFor(wc).leaseId, res.leaseId)
    assert.equal(h.transfer.forward({ kind: 'data', id: 't1', data: 'x', seq: 4 }), true)
    const push = h.windows[0].sent.find(([ch]) => ch === 'yan:pane-terminal:push')
    assert.equal(push[1].leaseId, res.leaseId)
    assert.equal(push[1].epoch, res.epoch)
    assert.equal(push[1].seq, 4)
    assert.equal(h.transfer.forward({ kind: 'data', id: 'other', data: 'y', seq: 1 }), false)
  })
  check('forward 只投给对应 terminalId 的窗口（多窗不串）', () => {
    const h = makeHarness()
    h.snapshots.set('t2', { terminalId: 't2', title: 't2', cwd: '/proj-b', cols: 80, rows: 24, alive: true, exitCode: null, buffer: '', seq: 0 })
    const a = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const b = h.transfer.openFromMainWindow({ owner: ownerB, terminalId: 't2' })
    h.transfer.stateFor(h.windows[0].wc)
    h.transfer.stateFor(h.windows[1].wc)
    assert.equal(h.transfer.forward({ kind: 'data', id: 't2', data: 'only-b', seq: 1 }), true)
    const sentA = h.windows[0].sent.filter(([ch]) => ch === 'yan:pane-terminal:push')
    const sentB = h.windows[1].sent.filter(([ch]) => ch === 'yan:pane-terminal:push')
    assert.equal(sentA.length, 0)
    assert.equal(sentB.length, 1)
    assert.equal(sentB[0][1].leaseId, b.leaseId)
    assert.notEqual(a.leaseId, b.leaseId)
  })
  check('失效：停止写入与转发，窗口保留 invalidated 视图', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    h.transfer.stateFor(wc)
    h.transfer.invalidate('sess-a', '会话已切换')
    const view = h.transfer.stateFor(wc)
    assert.equal(view.invalidated, true)
    assert.equal(view.invalidReason, '会话已切换')
    assert.equal(view.writable, false)
    assert.equal(view.snapshot, null)
    assert.equal(h.transfer.input(wc, res.leaseId, 'x'), false)
    assert.equal(h.transfer.forward({ kind: 'data', id: 't1', data: 'x', seq: 9 }), false)
    assert.equal(h.windows[0].destroyed, false)
    assert.equal(h.leaseChanges.at(-1).kind, 'invalidated')
  })
  check('换 owner 打开：旧 lease 失效并关窗，新 lease 新 epoch', () => {
    const h = makeHarness()
    const first = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const second = h.transfer.openFromMainWindow({ owner: ownerB, terminalId: 't1' })
    assert.equal(second.ok, true)
    assert.notEqual(second.leaseId, first.leaseId)
    assert.notEqual(second.epoch, first.epoch)
    assert.equal(h.windows[0].destroyed, true)
    assert.equal(h.windows.length, 2)
    assert.ok(h.leaseChanges.some((e) => e.kind === 'detached' && e.leaseId === first.leaseId))
  })
  check('closeByContents / detach：释放 lease 恰好一次，不 kill', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    assert.equal(h.transfer.closeByContents(wc), true)
    assert.equal(h.windows[0].destroyed, true)
    assert.equal(h.transfer.owns(wc), false)
    assert.equal(h.transfer.closeByContents(wc), false)
    assert.equal(h.transfer.input(wc, res.leaseId, 'x'), false)
    const detached = h.leaseChanges.filter((e) => e.kind === 'detached')
    assert.equal(detached.length, 1)
    assert.equal('kill' in h.host, false)
    assert.equal(h.snapshots.get('t1').alive, true, 'PTY 未受影响')
  })
  check('detach 主动归还：leaseId 不匹配不动', () => {
    const h = makeHarness()
    const res = h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    const wc = h.windows[0].wc
    assert.equal(h.transfer.detach(wc, 'wrong'), false)
    assert.equal(h.windows[0].destroyed, false)
    assert.equal(h.transfer.detach(wc, res.leaseId), true)
    assert.equal(h.windows[0].destroyed, true)
  })
  check('dispose：回收全部 lease，PTY 保留', () => {
    const h = makeHarness()
    h.snapshots.set('t2', { terminalId: 't2', title: 't2', cwd: '/proj-b', cols: 80, rows: 24, alive: true, exitCode: null, buffer: '', seq: 0 })
    h.transfer.openFromMainWindow({ owner: ownerA, terminalId: 't1' })
    h.transfer.openFromMainWindow({ owner: ownerB, terminalId: 't2' })
    h.transfer.dispose()
    assert.ok(h.windows.every((w) => w.destroyed))
    assert.equal(h.transfer.owns(h.windows[0].wc), false)
    assert.equal(h.snapshots.get('t1').alive, true)
    assert.equal(h.snapshots.get('t2').alive, true)
  })

  console.log('IPC 来源分流')
  check('open 只接受主窗口；state/input 只接受弹窗自身', () => {
    const h = makeHarness()
    globalThis.__termIpcHandlers = {}
    globalThis.__termIpcListeners = {}
    const mainContents = { id: 'main' }
    adapterMod.registerPaneTerminalIpc(h.transfer, { isMainWindow: (contents) => contents === mainContents })
    const open = globalThis.__termIpcHandlers['yan:pane-terminal:open']
    const rejected = open({ sender: { id: 'other' } }, { owner: ownerA, terminalId: 't1' })
    assert.equal(rejected.ok, false)
    const opened = open({ sender: mainContents }, { owner: ownerA, terminalId: 't1' })
    assert.equal(opened.ok, true)
    const wc = h.windows[0].wc
    const state = globalThis.__termIpcHandlers['yan:pane-terminal:state']
    assert.equal(state({ sender: { id: 'other' } }), null)
    assert.equal(state({ sender: wc }).terminalId, 't1')
    const input = globalThis.__termIpcHandlers['yan:pane-terminal:input']
    assert.equal(input({ sender: { id: 'other' } }, opened.leaseId, 'x'), false)
    assert.equal(input({ sender: wc }, opened.leaseId, 'x'), true)
    const resize = globalThis.__termIpcHandlers['yan:pane-terminal:resize']
    assert.equal(resize({ sender: wc }, opened.leaseId, 100, 30), true)
    globalThis.__termIpcListeners['yan:pane-terminal:close-self']({ sender: wc })
    assert.equal(h.windows[0].destroyed, true)
  })

  console.log(`\nv3 终端弹出适配：${passed} 项断言通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
