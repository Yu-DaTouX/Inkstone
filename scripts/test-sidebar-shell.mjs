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
    const terminal = await compile('src/renderer/src/features/terminal/terminal-running.ts', join(dir, 'terminal.mjs'))

    assert.equal(layout.SIDEBAR_WIDTH_DEFAULT, 288)

    const seenRuns = [
      { runId: 'r1', sessionId: 's-open', sessionPath: 'E:/a.jsonl', startedAt: 1, phase: { kind: 'done', at: 2, seen: false } },
      { runId: 'r2', sessionId: 's-open', startedAt: 3, phase: { kind: 'failed', at: 4, seen: false } },
      { runId: 'r3', sessionId: 's-open', startedAt: 5, phase: { kind: 'done', at: 6, seen: true } },
      { runId: 'r4', sessionId: 's-open', startedAt: 7, phase: { kind: 'running', since: 7 } },
      { runId: 'r5', sessionId: 's-other', startedAt: 8, phase: { kind: 'done', at: 9, seen: false } },
      { runId: 'r6', sessionId: 's-moved', sessionPath: 'E:/a.jsonl', startedAt: 10, phase: { kind: 'done', at: 11, seen: false } }
    ]
    assert.deepEqual(model.unreadRunIdsForSession(seenRuns, { id: 's-open' }), ['r1', 'r2'], '同一会话所有未读结束运行都标已读，不只最新一次')
    assert.deepEqual(model.unreadRunIdsForSession(seenRuns, { id: 's-open', path: 'E:/a.jsonl' }), ['r1', 'r2', 'r6'], '按会话文件也能对上')
    assert.deepEqual(model.unreadRunIdsForSession(seenRuns, { id: null, path: null }), [], '没有当前会话时不标')
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
