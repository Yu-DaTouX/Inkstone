import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-sidebar-shell-'))
  try {
    const layout = await compile('src/renderer/src/features/sidebar/sidebar-layout.ts', join(dir, 'layout.mjs'))
    const model = await compile('src/renderer/src/features/sidebar/sidebar-model.ts', join(dir, 'model.mjs'))
    const status = await compile('src/renderer/src/features/sidebar/session-status.ts', join(dir, 'status.mjs'))
    const terminal = await compile('src/renderer/src/features/terminal/terminal-running.ts', join(dir, 'terminal.mjs'))

    assert.equal(layout.SIDEBAR_WIDTH_DEFAULT, 288)
    assert.equal(layout.clampSidebarWidth(null), 288, '没有存储值用默认宽')
    assert.equal(layout.clampSidebarWidth(''), 288)
    assert.equal(layout.clampSidebarWidth('abc'), 288)
    assert.equal(layout.clampSidebarWidth('0'), 288)
    assert.equal(layout.clampSidebarWidth('264'), 264, '旧默认宽仍在范围内')
    assert.equal(layout.clampSidebarWidth('150'), 200, '旧存储值过窄夹到下限')
    assert.equal(layout.clampSidebarWidth('900'), 420, '过宽夹到上限')
    assert.equal(layout.clampSidebarWidth(333.6), 334)
    assert.equal(layout.readSidebarWidth({ getItem: () => '180' }), 200)
    assert.equal(layout.readSidebarWidth({ getItem: () => { throw new Error('denied') } }), 288, '读取存储失败时用默认宽')
    assert.equal(layout.readSidebarWidth(null), 288)

    assert.equal(layout.sidebarCollapseWidth(288), 700, '默认宽时阈值为 700')
    assert.equal(layout.sidebarCollapseWidth(420), 749, '宽侧栏时阈值为侧栏宽 + 329')
    assert.equal(layout.shouldAutoCollapseSidebar(700, 288), true, '等于阈值也折叠')
    assert.equal(layout.shouldAutoCollapseSidebar(701, 288), false)
    assert.equal(layout.shouldAutoCollapseSidebar(740, 420), true)
    assert.equal(layout.shouldAutoCollapseSidebar(1324, 420), false)
    assert.equal(layout.SIDEBAR_WIDTH_STEP, 8, '键盘普通步进 8')
    assert.equal(layout.SIDEBAR_WIDTH_STEP_LARGE, 32, 'Shift 步进 32')
    assert.equal(layout.SIDEBAR_DRAG_COLLAPSE, 100, '拖动原始宽小于最小宽一半时收起')
    assert.equal(layout.sidebarMaxForWindow(1324), 420)
    assert.equal(layout.sidebarMaxForWindow(650), 320, '停靠时给主区至少留 330')
    assert.equal(layout.sidebarMaxForWindow(400), 200)
    for (const width of [701, 760, 900]) {
      const max = layout.sidebarMaxForWindow(width)
      assert.equal(layout.shouldAutoCollapseSidebar(width, max), false, `拖到上限 ${max} 不会在 ${width} 宽时触发自动折叠`)
    }

    assert.equal(model.GROUP_PAGE_SIZE, 20, '分页阈值照参考为 20')
    const many = Array.from({ length: 45 }, (_, index) => ({ id: `s${index}`, path: `p${index}` }))
    const firstPage = model.groupPage(many)
    assert.equal(firstPage.rows.length, 20, '首屏只显示 20 条')
    assert.equal(firstPage.hidden, 25)
    assert.equal(firstPage.revealable, 20, '一次再放 20 条')
    assert.equal(firstPage.expanded, false)
    const secondPage = model.groupPage(many, 20)
    assert.equal(secondPage.rows.length, 40)
    assert.equal(secondPage.hidden, 5)
    assert.equal(secondPage.revealable, 5, '最后一页按剩余条数报数')
    assert.equal(secondPage.expanded, false)
    const lastPage = model.groupPage(many, 40)
    assert.equal(lastPage.rows.length, 45)
    assert.equal(lastPage.hidden, 0)
    assert.equal(lastPage.expanded, true, '放完变成收起')
    assert.equal(model.groupPage(many.slice(0, 20)).expanded, true, '正好 20 条不出现显示更多')
    const kept = model.groupPage(many, 0, many[30])
    assert.equal(kept.rows.length, 21, '分页外当前会话仍显示')
    assert.equal(kept.rows[20], many[30])
    assert.equal(kept.hidden, 25, '当前会话不计入已显示数量')
    assert.equal(model.groupPage([], 0).expanded, true)

    const phase = (kind, extra = {}) => ({ kind, ...extra })
    const kind = (input) => status.sessionStatusKind({ phase: null, unread: false, archived: false, ...input })
    assert.equal(kind({}), 'idle', '没有运行记录是空闲')
    assert.equal(kind({ phase: phase('running') }), 'running')
    assert.equal(kind({ phase: phase('queued') }), 'running')
    assert.equal(kind({ phase: phase('needs-you') }), 'awaiting')
    assert.equal(kind({ phase: phase('stalled') }), 'awaiting')
    assert.equal(kind({ phase: phase('failed'), unread: true }), 'error')
    assert.equal(kind({ phase: phase('failed') }), 'error', '最近一轮失败持续显示出错')
    assert.equal(kind({ phase: phase('done'), unread: true }), 'unread')
    assert.equal(kind({ phase: phase('done') }), 'idle', '已读的完成回到空闲')
    assert.equal(kind({ phase: phase('stopped') }), 'idle')
    assert.equal(kind({ phase: phase('running'), archived: true }), 'archived', '归档优先')
    assert.equal(status.sessionStatusLabel('awaiting', 'zh-CN'), '等待输入')
    assert.equal(status.sessionStatusLabel('unread', 'en-US'), 'Unread response')

    const pane = (sessionId, path) => ({ sessionId, path })
    const wideSplit = {
      tiles: [
        pane('a', 'C:\\x\\a.jsonl'),
        pane('tool:terminal'),
        pane('subagent:r1'),
        pane('b', 'C:\\x\\b.jsonl')
      ],
      live: 3
    }
    assert.deepEqual(status.visiblePaneSessions(null, false), [], '没有分屏时没有额外可见窗格')
    assert.deepEqual(status.visiblePaneSessions({ tiles: [pane('a')], live: 0 }, false), [], '单窗格不算分屏')
    assert.deepEqual(
      status.visiblePaneSessions(wideSplit, false).map((tile) => tile.sessionId),
      ['a', 'b'],
      '宽屏分屏里每个会话窗格都算可见，工具和子代理窗格不算会话'
    )
    assert.deepEqual(status.visiblePaneSessions(wideSplit, true).map((tile) => tile.sessionId), ['b'], '窄屏只显示当前窗格')
    assert.equal(status.paneShowsSession(status.visiblePaneSessions(wideSplit, false), { id: 'a', path: 'C:\\x\\a.jsonl' }), true)
    assert.equal(status.paneShowsSession(status.visiblePaneSessions(wideSplit, false), { path: 'c:/X/A.jsonl' }), true, '路径大小写与分隔符不敏感')
    assert.equal(status.paneShowsSession(status.visiblePaneSessions(wideSplit, false), { id: 'c' }), false)
    assert.equal(status.paneShowsSession(wideSplit.tiles, { id: 'tool:terminal' }), false, '工具窗格不匹配会话')
    assert.equal(status.paneShowsSession([], { id: 'a' }), false)
    assert.equal(status.paneShowsSession(status.visiblePaneSessions(wideSplit, false), {}), false, '没有 id 和路径不匹配')
    assert.equal(status.sessionUnread({ unread: true, paneSelected: false }), true)
    assert.equal(status.sessionUnread({ unread: true, paneSelected: true }), false, '当前窗格显示的会话不算未读')
    assert.equal(status.sessionUnread({ unread: false, paneSelected: false }), false)
    assert.equal(
      kind({ phase: phase('done'), unread: status.sessionUnread({ unread: true, paneSelected: true }) }),
      'idle',
      '正在显示的会话完成后不显示未读点'
    )
    assert.equal(kind({ phase: phase('done'), unread: status.sessionUnread({ unread: true, paneSelected: false }) }), 'unread')

    const owners = { 'terminal:t2': 'owner-a' }
    const ownerOf = (id) => owners[id]
    const entries = [
      { id: 't1', owner: 'owner-a', alive: true, status: { state: 'idle' } },
      { id: 't2', alive: true, status: { state: 'working' } },
      { id: 't3', owner: 'owner-b', alive: true, status: { state: 'blocked' } },
      { id: 't4', owner: 'owner-c', alive: false, status: { state: 'working' } }
    ]
    assert.equal(terminal.ownerTerminalRunning(entries, 'owner-a', ownerOf), true, '按资源归属表找到正在跑命令的终端')
    assert.equal(terminal.ownerTerminalRunning(entries, 'owner-b', ownerOf), true, '等待输入的命令也算在跑')
    assert.equal(terminal.ownerTerminalRunning(entries, 'owner-c', ownerOf), false, '已退出的终端不算')
    assert.equal(terminal.ownerTerminalRunning(entries, 'owner-d', ownerOf), false)
    assert.equal(terminal.isTerminalCommandRunning({ id: 'x', alive: true }), false, '没有状态上报不算在跑')

    console.log('sidebar-shell: 通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
