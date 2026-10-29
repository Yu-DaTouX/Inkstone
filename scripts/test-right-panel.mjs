import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function runRightPanelTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-right-panel-'))
  const memory = new Map()
  const hadStorage = 'localStorage' in globalThis
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key)
  }
  memory.set('inkstone.v3.tileLayouts', JSON.stringify({ version: 1, sessions: { home: { tileLayout: { root: { kind: 'tile', tileId: 'chat' } } } }, order: ['home'], lastPaneFlexByKind: {} }))
  try {
    const outfile = join(dir, 'right-panel.mjs')
    await build({ entryPoints: ['src/renderer/src/state/right-panel.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const rp = await import(pathToFileURL(outfile).href)
    const batchFile = join(dir, 'frame-batch.mjs')
    await build({ entryPoints: ['src/renderer/src/app/frame-batch.ts'], outfile: batchFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { createFrameBatch } = await import(pathToFileURL(batchFile).href)
    const frames = new Map()
    let nextFrame = 0
    const writes = []
    const batch = createFrameBatch((width) => writes.push(width), (callback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    }, (id) => frames.delete(id))
    batch.schedule(730)
    batch.schedule(780)
    batch.schedule(900)
    ok(frames.size === 1 && writes.length === 0, '拖宽：同帧只安排一次更新，事件路径不立即写宽')
    ;[...frames.values()][0]()
    ok(writes.join() === '900' && frames.size === 0, '拖宽：帧内只提交最新宽度')
    batch.schedule(880)
    batch.flush()
    ok(writes.join() === '900,880' && frames.size === 0, '拖宽：结束时保留最终宽度且撤销排队帧')
    batch.schedule(1000)
    batch.cancel()
    ok(frames.size === 0 && writes.join() === '900,880', '拖宽：重置前取消旧帧，避免旧值覆盖默认宽')
    batch.flush()
    ok(writes.length === 2, '拖宽：重复清理不会重复写入')
    let measurements = 0
    const measure = createFrameBatch(() => measurements++, (callback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    }, (id) => frames.delete(id))
    measure.schedule()
    measure.schedule()
    measure.schedule()
    ok(frames.size === 1, '布局测量：同帧多次通知只安排一次读取')
    ;[...frames.values()][0]()
    ok(measurements === 1 && frames.size === 0, '布局测量：无参数请求仍正确执行一次')
    const store = rp.useRightPanel

    ok(Object.keys(store.getState().byKey).length === 0, '右栏：旧分块布局存档不读入，初始为空')
    ok(rp.panelKeyFor('abc') === 's:abc' && rp.panelKeyFor(null) === 'home', '右栏：面板按会话分键')

    store.getState().open(rp.toolSurface('changes'))
    store.getState().open(rp.toolSurface('terminal'))
    store.getState().open(rp.toolSurface('preview'))
    let entry = rp.currentPanelEntry()
    ok(entry.open && entry.surfaces.map((s) => s.id).join() === 'changes,terminal,files' && entry.active === 'files', '右栏：打开标签追加并激活，preview 归入 files', entry)

    store.getState().open(rp.toolSurface('changes'))
    entry = rp.currentPanelEntry()
    ok(entry.surfaces.length === 3 && entry.active === 'changes', '右栏：重复打开只激活不重复')

    store.getState().close('changes')
    entry = rp.currentPanelEntry()
    ok(entry.active === 'terminal' && entry.surfaces.length === 2, '右栏：关闭当前标签后激活右侧邻居', entry)

    store.getState().step(1)
    ok(rp.currentPanelEntry().active === 'files', '右栏：键盘切到下一个标签')
    store.getState().step(1)
    ok(rp.currentPanelEntry().active === 'terminal', '右栏：切换循环回首个')

    store.getState().open(rp.pullRequestSurface(12, { title: 'Fix', state: 'open' }))
    store.getState().open(rp.pullRequestSurface(12, { tab: 'code' }))
    const pr = rp.currentPanelEntry().surfaces.find((s) => s.id === 'pr:12')
    ok(pr && pr.title === 'Fix' && pr.state === 'open' && pr.tab === 'code', 'PR 标签：更新分段保留标题与状态', pr)

    store.getState().move('pr:12', 0)
    ok(rp.currentPanelEntry().surfaces[0].id === 'pr:12', '右栏：标签可移动')

    store.getState().closeRight('pr:12')
    ok(rp.currentPanelEntry().surfaces.map((s) => s.id).join() === 'pr:12', '右栏：关闭右侧标签', rp.currentPanelEntry())

    store.getState().open(rp.subagentSurface('r1'))
    store.getState().replace('subagent:r1', rp.subagentSurface('r2'))
    ok(rp.currentPanelEntry().surfaces.map((s) => s.id).join() === 'pr:12,subagent:r2' && rp.currentPanelEntry().active === 'subagent:r2', '右栏：子代理标签原位替换')

    store.getState().setMaximized(true)
    store.getState().setOpen(false)
    ok(!rp.currentPanelEntry().open && !rp.currentPanelEntry().maximized, '右栏：收起面板同时取消最大化')

    store.getState().load('s1')
    ok(store.getState().key === 's:s1' && rp.currentPanelEntry().surfaces.length === 2, '右栏：首个会话继承首页面板')
    store.getState().closeAll()
    ok(rp.currentPanelEntry().surfaces.length === 0 && !rp.currentPanelEntry().open, '右栏：关闭全部后收起')
    store.getState().load('s2')
    ok(rp.currentPanelEntry().surfaces.length === 0, '右栏：其他会话不串用首页面板以外的状态')
    store.getState().open(rp.subagentSurface('gone'))
    store.getState().drop(['subagent:gone', 'subagent:r2'])
    ok(rp.currentPanelEntry().surfaces.length === 0 && (store.getState().byKey.home?.surfaces ?? []).every((s) => s.id !== 'subagent:r2'), '右栏：子代理消失后从所有会话的面板移除')

    store.getState().setWidth(900)
    store.getState().open(rp.toolSurface('files'))
    store.getState().open(rp.toolSurface('changes'))
    store.getState().setOpen(false)
    store.getState().setOpen(true)
    ok(store.getState().width === 900, '右栏：开关与切换标签不改宽度', store.getState().width)
    store.getState().setWidth(10)
    ok(store.getState().width === rp.PANEL_WIDTH_MIN, '右栏：宽度有下限')
    ok(rp.clampPanelWidth(900, 500) === 500, '右栏：宽度受可用空间限制')
    ok(rp.panelMaxWidth(1330) === 1330 && rp.panelRoom(2000, 1750, 420) === 1330 && rp.panelRoom(1000, 900, 420) === 480, '右栏：上限取视口 70% 与行宽减对话最小宽度中较小者')
    ok(rp.PANEL_WIDTH_DEFAULT === 720, '右栏：默认宽度 720', rp.PANEL_WIDTH_DEFAULT)
    ok(rp.sanitizeRightPanel({ version: 1, width: 0, byKey: {}, order: [] }).width === rp.PANEL_WIDTH_DEFAULT, '存档：异常宽度回到默认')

    const saved = rp.sanitizeRightPanel({
      version: 1,
      width: 512,
      byKey: {
        's:a': { open: true, active: 'nope', maximized: true, surfaces: [{ kind: 'changes' }, { kind: 'changes' }, { kind: 'pullRequest', number: -1 }, { kind: 'file', path: 'C:/x/a.md' }, { kind: 'subagent', runId: '../bad' }, { kind: 'mystery' }] },
        's:b': { open: false, surfaces: [] }
      },
      order: ['s:a', 's:b']
    })
    ok(saved.width === 512 && saved.order.join() === 's:a', '存档：空面板丢弃', saved)
    ok(saved.byKey['s:a'].surfaces.map((s) => s.id).join() === 'changes,file:C:/x/a.md' && saved.byKey['s:a'].active === 'file:C:/x/a.md', '存档：非法标签丢弃，活动标签回退到最后一个', saved.byKey['s:a'])
    ok(rp.sanitizeRightPanel({ version: 2, byKey: { home: {} } }).order.length === 0, '存档：版本不符整体丢弃')
    const many = { version: 1, width: 400, byKey: {}, order: [] }
    for (let i = 0; i < 130; i++) many.byKey[`s:${i}`] = { open: true, active: 'files', surfaces: [{ kind: 'files' }] }
    ok(rp.sanitizeRightPanel(many).order.length === rp.RIGHT_PANEL_MAX_SESSIONS, '存档：会话数量有上限')
  } finally {
    if (hadStorage) globalThis.localStorage = previousStorage
    else delete globalThis.localStorage
    await rm(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let pass = 0
  await runRightPanelTests((cond, label, detail) => {
    assert.ok(cond, `${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
    pass++
    console.log(`✓ ${label}`)
  })
  console.log(`\nright-panel: ${pass} checks passed`)
}
