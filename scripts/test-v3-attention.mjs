/**
 * AttentionService 单测（v3 WP-12）。
 *
 * 现场用 esbuild 编译 `src/main/attention/index.ts`，在 node 里跑，**不启动
 * Electron、不起 pi、不写用户数据**。窗口 / 托盘都用假实现，只断言投影决策：
 *
 *   · `summarizeAttention`：等你确认 / 失败未读 / 完成未读 / 停滞 / 进行中的
 *     归类与排序；已读终态与用户停止不进入注意列表。
 *   · 任务栏：Windows 上有运行 → 不确定进度；有等待 → 覆盖图标 + 说明；
 *     非 Windows 不碰任务栏；主题切换强制重刷。
 *   · 托盘：提示随注意数变化；菜单沿用显示砚 / 新建会话 / 运行中的会话 / 退出，
 *     有注意项时子菜单顶部多一行「等你处理 N 项」；点击运行项回导航目标。
 *   · 宿主事实（终端 / Agent Hub / 批准）作为注册表之外的忙碌 / 等待兜底。
 *
 * 可独立执行：node scripts/test-v3-attention.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

/** 造一个运行快照；phase 直接给 `kind` 加上需要的字段。 */
function run(runId, phase, overrides = {}) {
  return {
    runId,
    code: overrides.code ?? 'S1',
    kind: overrides.kind ?? 'session',
    sessionId: overrides.sessionId ?? 's1',
    title: overrides.title ?? '任务',
    startedAt: 1_000,
    phase,
    counts: { tools: 0, edits: 0, errors: 0 },
    ...(overrides.sessionPath ? { sessionPath: overrides.sessionPath } : {}),
    ...(overrides.projectId ? { projectId: overrides.projectId } : {})
  }
}

function fakeWindow() {
  const calls = { progress: [], overlay: [], flash: 0 }
  return {
    calls,
    id: 7,
    isDestroyed: () => false,
    setProgressBar: (p, o) => calls.progress.push({ p, o }),
    setOverlayIcon: (icon, desc) => calls.overlay.push({ icon, desc }),
    flashFrame: () => {
      calls.flash += 1
    }
  }
}

function fakeTray() {
  const state = { image: null, tooltip: '', menu: null, title: '', destroyed: 0, listeners: {} }
  return {
    state,
    setImage: (i) => {
      state.image = i
    },
    setToolTip: (t) => {
      state.tooltip = t
    },
    setContextMenu: (m) => {
      state.menu = m
    },
    setTitle: (t) => {
      state.title = t
    },
    on: (e, l) => {
      state.listeners[e] = l
    },
    destroy: () => {
      state.destroyed += 1
    }
  }
}

/** 组装服务依赖；每个用例改自己关心的字段。 */
function harness(overrides = {}) {
  const win = fakeWindow()
  const tray = fakeTray()
  const log = { show: 0, newSession: 0, select: [], quit: 0 }
  const state = {
    revision: 1,
    runs: [],
    hostBusy: false,
    hostWaiting: false,
    language: 'zh-CN',
    themeListener: null
  }
  const deps = {
    platform: 'win32',
    snapshot: () => ({ revision: state.revision, runs: state.runs }),
    hostBusy: () => state.hostBusy,
    hostWaiting: () => state.hostWaiting,
    window: () => win,
    trayImage: () => 'icon',
    createTray: () => tray,
    language: () => state.language,
    statuses: () => [],
    showMainWindow: () => {
      log.show += 1
    },
    newSession: () => {
      log.newSession += 1
    },
    selectSession: (target) => {
      log.show += 1
      log.select.push(target)
    },
    quit: () => {
      log.quit += 1
    },
    onThemeChange: (listener) => {
      state.themeListener = listener
      return () => {
        state.themeListener = null
      }
    },
    ...overrides
  }
  return { deps, state, win, tray, log }
}

export async function runV3AttentionTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-attention-'))
  const outfile = join(dir, 'attention.mjs')
  try {
    await compile('src/main/attention/index.ts', outfile)
    const mod = await import(pathToFileURL(outfile).href)
    runSummaryTests(mod)
    runTaskbarTests(mod)
    runTrayTests(mod)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ───────────────────────── 汇总 ───────────────────────── */

function runSummaryTests(mod) {
  const { summarizeAttention } = mod

  const empty = summarizeAttention([])
  assert.equal(empty.busy, false)
  assert.equal(empty.waiting, false)
  assert.equal(empty.attentionCount, 0)
  assert.equal(empty.total, 0)

  const runs = [
    run('a', { kind: 'running', since: 100, activity: 'streaming' }),
    run('b', { kind: 'needs-you', since: 200, request: { id: 'r1', type: 'confirm', summary: '推送前确认' } }),
    run('c', { kind: 'failed', at: 300, cause: 'model-error', message: '崩了', seen: false }),
    run('d', { kind: 'failed', at: 400, cause: 'pi-exit', message: '退了', seen: true }),
    run('e', { kind: 'done', at: 500, seen: false }, { code: 'S2' }),
    run('f', { kind: 'done', at: 600, seen: true }),
    run('g', { kind: 'stopped', at: 700, by: 'user' }),
    run('h', { kind: 'stalled', since: 150, cause: 'no-output' }),
    run('i', { kind: 'queued', since: 120, reason: 'followup' })
  ]
  const s = summarizeAttention(runs)
  assert.deepEqual(s.needsYou.map((r) => r.runId), ['b'])
  assert.deepEqual(s.failed.map((r) => r.runId), ['c'], '已读失败不进注意列表')
  assert.deepEqual(s.doneUnread.map((r) => r.runId), ['e'], '已读完成不进注意列表')
  assert.deepEqual(s.stalled.map((r) => r.runId), ['h'])
  /* 进行中按 since 升序；needs-you / stalled / queued / running 都算。 */
  assert.deepEqual(s.active.map((r) => r.runId), ['a', 'i', 'h', 'b'])
  assert.equal(s.waiting, true)
  assert.equal(s.busy, true)
  assert.equal(s.attentionCount, 3, 'needs-you + 失败未读 + 完成未读')
  assert.equal(s.total, 9)

  /* 失败 / 完成未读按时间从新到旧。 */
  const two = summarizeAttention([
    run('x', { kind: 'done', at: 10, seen: false }),
    run('y', { kind: 'done', at: 20, seen: false })
  ])
  assert.deepEqual(two.doneUnread.map((r) => r.runId), ['y', 'x'])

  /* 全已读终态：不忙、不等待、无注意。 */
  const quiet = summarizeAttention([run('q', { kind: 'done', at: 1, seen: true }), run('r', { kind: 'stopped', at: 2, by: 'host' })])
  assert.equal(quiet.busy, false)
  assert.equal(quiet.attentionCount, 0)
}

/* ───────────────────────── 任务栏 ───────────────────────── */

function runTaskbarTests(mod) {
  const { createAttentionService } = mod

  /* 注意项驱动覆盖图标与任务栏进度。 */
  {
    const h = harness()
    h.state.runs = [run('a', { kind: 'needs-you', since: 1, request: { id: 'r', type: 'danger', summary: '删库' } })]
    const svc = createAttentionService(h.deps)
    svc.ensureTray()
    assert.equal(svc.hasTray(), true)
    assert.equal(h.tray.state.tooltip, '砚 · Yan · 1 项待处理')
    /* 创建托盘时 refreshTaskbar(true) 已应用一次。 */
    assert.equal(h.win.calls.progress.at(-1).p, 2)
    assert.deepEqual(h.win.calls.progress.at(-1).o, { mode: 'indeterminate' })
    assert.equal(h.win.calls.overlay.at(-1).icon, 'icon')
    assert.equal(h.win.calls.overlay.at(-1).desc, '有任务等待你的处理')

    /* 解决后只留完成未读：不再覆盖，但仍有注意提示。 */
    h.state.runs = [run('a', { kind: 'done', at: 2, seen: false })]
    svc.refreshTaskbar()
    assert.equal(h.win.calls.progress.at(-1).p, -1)
    assert.equal(h.win.calls.overlay.at(-1).icon, null)
    assert.equal(h.win.calls.overlay.at(-1).desc, '')
    assert.equal(h.tray.state.tooltip, '砚 · Yan · 1 项待处理')

    /* 全部已读：回到默认提示。 */
    h.state.runs = [run('a', { kind: 'done', at: 3, seen: true })]
    svc.refreshTaskbar()
    assert.equal(h.tray.state.tooltip, '砚 · Yan')
  }

  /* 宿主事实兜底：注册表为空但有终端在跑 / 在等。 */
  {
    const h = harness()
    const svc = createAttentionService(h.deps)
    h.state.hostBusy = true
    svc.refreshTaskbar()
    assert.equal(h.win.calls.progress.at(-1).p, 2)
    assert.equal(h.tray.state.tooltip, '', '未创建托盘不碰托盘')
    h.state.hostBusy = false
    h.state.hostWaiting = true
    svc.refreshTaskbar()
    assert.equal(h.win.calls.progress.at(-1).p, -1)
    assert.equal(h.win.calls.overlay.at(-1).icon, 'icon')
  }

  /* 非 Windows：不调用任务栏 API。 */
  {
    const h = harness({ platform: 'linux' })
    h.state.runs = [run('a', { kind: 'running', since: 1, activity: 'thinking' })]
    const svc = createAttentionService(h.deps)
    svc.refreshTaskbar()
    assert.equal(h.win.calls.progress.length, 0)
    assert.equal(h.win.calls.overlay.length, 0)
  }

  /* 主题切换：换字形并强制重刷任务栏。 */
  {
    const h = harness()
    h.state.runs = [run('a', { kind: 'running', since: 1, activity: 'thinking' })]
    const svc = createAttentionService(h.deps)
    svc.ensureTray()
    const before = h.win.calls.progress.length
    h.tray.state.image = null
    assert.equal(typeof h.state.themeListener, 'function')
    h.state.themeListener()
    assert.equal(h.tray.state.image, 'icon')
    assert.ok(h.win.calls.progress.length > before, '主题切换强制重刷进度')
  }

  /* 闪烁与释放。 */
  {
    const h = harness()
    const svc = createAttentionService(h.deps)
    svc.ensureTray()
    svc.flash()
    assert.equal(h.win.calls.flash, 1)
    svc.dispose()
    assert.equal(h.tray.state.destroyed, 1)
    assert.equal(svc.hasTray(), false)
    assert.equal(h.state.themeListener, null, '释放后不再监听主题')
  }
}

/* ───────────────────────── 托盘 ───────────────────────── */

function runTrayTests(mod) {
  const { createAttentionService, buildAttentionMenu } = mod

  const statuses = [
    {
      id: 'r1',
      sessionId: 's1',
      sessionFile: 'C:/x/日志改造.jsonl',
      projectId: 'p1',
      cwd: 'C:/x',
      running: true,
      waiting: false,
      conn: 'ready',
      isActive: true
    },
    {
      id: 'r2',
      cwd: 'C:/y',
      running: false,
      waiting: false,
      conn: 'starting',
      isActive: false
    }
  ]

  const h = harness({ statuses: () => statuses })
  h.state.runs = [
    run('a', { kind: 'needs-you', since: 1, request: { id: 'r', type: 'confirm', summary: '确认' } }),
    run('b', { kind: 'failed', at: 2, cause: 'model-error', message: '崩', seen: false })
  ]
  const svc = createAttentionService(h.deps)
  svc.ensureTray()
  const menu = h.tray.state.menu
  assert.deepEqual(menu.filter((n) => n.type !== 'separator').map((n) => n.label), ['显示砚', '新建会话', '运行中的会话', '退出砚'])
  const submenu = menu.find((n) => n.type === 'submenu')
  assert.equal(submenu.items[0].label, '等你处理 2 项')
  assert.equal(submenu.items[0].enabled, false)
  assert.equal(submenu.items[1].type, 'separator')
  const live = submenu.items.filter((n) => n.type === 'item' && n.enabled !== false)
  assert.equal(live.length, 2)
  assert.equal(live[0].label, '● 日志改造.jsonl · 运行中')
  assert.equal(live[1].label, 'r2 · 启动中')

  /* 点击运行项 → 回到主窗口并带上稳定会话身份，不执行任何东西。 */
  live[0].click()
  assert.equal(h.log.show, 1)
  assert.deepEqual(h.log.select, [{ sessionFile: 'C:/x/日志改造.jsonl', sessionId: 's1', projectId: 'p1', cwd: 'C:/x' }])

  /* 新建 / 退出回调只转发。 */
  menu[1].click()
  assert.equal(h.log.newSession, 1)
  menu[4].click()
  assert.equal(h.log.quit, 1)

  /* 无运行：沿用迁移前的占位文案，且不出现注意行。 */
  const plain = buildAttentionMenu({
    zh: true,
    statuses: [],
    summary: mod.summarizeAttention([]),
    callbacks: { show() {}, newSession() {}, selectSession() {}, quit() {} }
  })
  assert.deepEqual(plain.find((n) => n.type === 'submenu').items, [
    { type: 'item', label: '暂无运行中的会话', enabled: false }
  ])

  /* 英文文案来自同一份菜单模型。 */
  const en = buildAttentionMenu({
    zh: false,
    statuses,
    summary: mod.summarizeAttention([run('a', { kind: 'done', at: 1, seen: false })]),
    callbacks: { show() {}, newSession() {}, selectSession() {}, quit() {} }
  })
  assert.equal(en[0].label, 'Show Yan')
  assert.equal(en.find((n) => n.type === 'submenu').items[0].label, '1 need attention')
  assert.equal(en.find((n) => n.type === 'submenu').items[2].label, '● 日志改造.jsonl · Running')

  /* macOS 在托盘图标旁显示注意数；Windows 不设 title。 */
  const mac = harness({ platform: 'darwin' })
  mac.state.runs = [run('a', { kind: 'done', at: 1, seen: false })]
  const macSvc = createAttentionService(mac.deps)
  macSvc.ensureTray()
  assert.equal(mac.tray.state.title, '1')
  mac.state.runs = [run('a', { kind: 'done', at: 2, seen: true })]
  macSvc.refreshTaskbar()
  assert.equal(mac.tray.state.title, '')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runV3AttentionTests()
  console.log('v3-attention: 全部通过')
}
