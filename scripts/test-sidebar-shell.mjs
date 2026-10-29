import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    const more = await compile('src/renderer/src/features/sidebar/side-more.ts', join(dir, 'more.mjs'))

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
    assert.equal(layout.clampSidebarWidth('150'), 240, '旧存储值过窄夹到下限')
    assert.equal(layout.clampSidebarWidth('900'), 420, '过宽夹到上限')
    assert.equal(layout.clampSidebarWidth(333.6), 334)
    assert.equal(layout.readSidebarWidth({ getItem: () => '180' }), 240)
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
    assert.equal(layout.SIDEBAR_DRAG_COLLAPSE, 120, '拖动原始宽小于最小宽一半时收起')
    assert.equal(layout.sidebarMaxForWindow(1324), 420)
    assert.equal(layout.sidebarMaxForWindow(650), 320, '停靠时给主区至少留 330')
    assert.equal(layout.sidebarMaxForWindow(400), 240)
    for (const width of [701, 760, 900]) {
      const max = layout.sidebarMaxForWindow(width)
      assert.equal(layout.shouldAutoCollapseSidebar(width, max), false, `拖到上限 ${max} 不会在 ${width} 宽时触发自动折叠`)
    }

    assert.equal(model.GROUP_PAGE_SIZE, 10, '分页阈值为 10')
    const runIndex = model.indexRuns(seenRuns)
    assert.equal(runIndex.latest({ id: 's-open' })?.runId, 'r4', '按会话取最新一次运行')
    assert.equal(runIndex.latest({ id: 's-other' })?.runId, 'r5')
    assert.equal(runIndex.latest({ path: 'E:/a.jsonl' })?.runId, 'r6', '只给会话文件也能对上')
    assert.equal(runIndex.latest({ id: 's-moved', path: 'E:/a.jsonl' })?.runId, 'r6', '会话与文件同时命中时取更晚的一次')
    assert.equal(runIndex.latest({}), null, '没有任何标识时没有运行')
    assert.equal(model.indexRuns([]).latest({ id: 's-open' }), null)
    const many = Array.from({ length: 45 }, (_, index) => ({ id: `s${index}`, path: `p${index}` }))
    const firstPage = model.groupPage(many)
    assert.equal(firstPage.rows.length, 10, '首屏只显示 10 条')
    assert.equal(firstPage.hidden, 35)
    assert.equal(firstPage.revealable, 10, '一次再放 10 条')
    assert.equal(firstPage.expanded, false)
    const secondPage = model.groupPage(many, 10)
    assert.equal(secondPage.rows.length, 20)
    assert.equal(secondPage.hidden, 25)
    assert.equal(secondPage.revealable, 10, '一次再放 10 条')
    assert.equal(secondPage.expanded, false)
    const lastPage = model.groupPage(many, 40)
    assert.equal(lastPage.rows.length, 45)
    assert.equal(lastPage.hidden, 0)
    assert.equal(lastPage.expanded, true, '放完变成收起')
    assert.equal(model.groupPage(many.slice(0, 10)).expanded, true, '正好 10 条不出现显示更多')
    const kept = model.groupPage(many, 0, many[30])
    assert.equal(kept.rows.length, 11, '分页外当前会话仍显示')
    assert.equal(kept.rows[10], many[30])
    assert.equal(kept.hidden, 35, '当前会话不计入已显示数量')
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

    const all = new Set(['schedule', 'collab', 'artifacts'])
    const signals = (extra = {}) => ({ available: all, schedulePendingApproval: false, pairInvitePending: false, runs: [], ...extra })
    const quiet = more.sideMoreEntries(signals())
    assert.deepEqual(quiet.map((entry) => entry.id), ['schedule', 'collab', 'artifacts'], '「更多」按固定顺序列出低频入口')
    assert.ok(quiet.every((entry) => entry.attention === null), '没有待处理时全部安静')
    const quietLayout = more.sideMoreLayout(quiet, 'chat')
    assert.equal(quietLayout.shown.length, 0, '安静时不单独露出任何入口')
    assert.equal(quietLayout.folded.length, 3)
    assert.equal(quietLayout.foldedCurrent, false)
    assert.equal(more.sideMoreLayout(quiet, 'schedule').foldedCurrent, true, '停在收起的页面时「更多」显示选中')
    const scheduledRun = { kind: 'scheduled', phase: phase('running', { since: 1 }) }
    const sessionRun = { kind: 'session', phase: phase('running', { since: 1 }) }
    assert.equal(more.sideMoreEntries(signals({ runs: [sessionRun] }))[0].attention, null, '普通会话在跑不算定时任务进行中')
    assert.equal(more.sideMoreEntries(signals({ runs: [scheduledRun] }))[0].attention, 'running', '定时运行进行中时定时任务有提示')
    assert.equal(more.sideMoreEntries(signals({ runs: [{ kind: 'scheduled', phase: phase('done', { at: 2, seen: false }) }] }))[0].attention, null, '定时运行结束后不再提示')
    assert.equal(more.sideMoreEntries(signals({ schedulePendingApproval: true, runs: [scheduledRun] }))[0].attention, 'awaiting', '待确认优先于进行中')
    const invite = more.sideMoreLayout(more.sideMoreEntries(signals({ pairInvitePending: true })), 'chat')
    assert.deepEqual(invite.shown.map((entry) => entry.id), ['collab'], '有待处理的配对邀请时多人协作临时露出')
    assert.deepEqual(invite.folded.map((entry) => entry.id), ['schedule', 'artifacts'])
    const twoLoud = more.sideMoreLayout(more.sideMoreEntries(signals({ pairInvitePending: true, schedulePendingApproval: true })), 'artifacts')
    assert.deepEqual(twoLoud.shown.map((entry) => entry.id), ['schedule', 'collab', 'artifacts'], '只剩一项可收时不再折成「更多」')
    assert.equal(twoLoud.folded.length, 0)
    assert.equal(twoLoud.foldedCurrent, false)
    const partial = more.sideMoreEntries(signals({ available: new Set(['artifacts']) }))
    assert.deepEqual(more.sideMoreLayout(partial, 'chat').shown.map((entry) => entry.id), ['artifacts'], '只有一个入口时直接显示')
    assert.equal(more.activeRunCount([scheduledRun, sessionRun, { phase: phase('needs-you') }, { phase: phase('stalled') }, { phase: phase('queued') }, { phase: phase('done') }, { phase: phase('failed') }]), 5, '排队、运行、等待与停滞都算进行中')

    const noon = new Date(2026, 9, 30, 12, 0, 0).getTime()
    const at = (day, hour) => new Date(2026, 9, day, hour, 0, 0).getTime()
    assert.equal(model.recencyBucket(at(30, 1), noon), 'today', '今天零点后算今天')
    assert.equal(model.recencyBucket(at(29, 23), noon), 'yesterday', '昨天按自然日，不按 24 小时')
    assert.equal(model.recencyBucket(at(24, 9), noon), 'week', '7 天内含今天往前 6 天')
    assert.equal(model.recencyBucket(at(23, 23), noon), 'older')
    assert.equal(model.recencyTier(noon - 30 * 60_000, noon), 'hot', '一小时内最醒目')
    assert.equal(model.recencyTier(at(30, 2), noon), 'warm')
    assert.equal(model.recencyTier(at(28, 2), noon), 'cool')
    assert.equal(model.recencyTier(at(1, 2), noon), 'cold', '一周以前退后')
    const runs = model.bucketByRecency([at(30, 11), at(30, 9), at(29, 9), at(20, 9), at(30, 10)], (value) => value, noon)
    assert.deepEqual(runs.map((run) => [run.bucket, run.entries.length]), [['today', 2], ['yesterday', 1], ['older', 2]], '按时间连续分段，分页外补回的当前会话并入末段不另起旧分组')

    const twins = model.titleTwins([{ id: 'a', title: '去阅读t3code的代码 我想要基于' }, { id: 'b', title: '去阅读t3code的代码  我想要基于…' }, { id: 'c', title: '侧栏' }, { id: 'd', title: '' }, { id: 'e', title: '' }])
    assert.deepEqual([...twins].sort(), ['a', 'b'], '空白与末尾省略号不影响同名判断，空标题不算同名')
    assert.equal(model.sessionNote({ lastReply: { id: 'r', at: 1, text: '\n## **结论**：保留 `Sidebar`\n更多' }, createdAt: 0 }, 'zh-CN'), '结论：保留 Sidebar', '同名会话用最后答复首行区分，去掉 Markdown 记号')
    assert.match(model.sessionNote({ createdAt: at(28, 14) }, 'zh-CN'), /10\/28/, '没有答复时用创建时间区分')
    const meta = model.sessionRowMeta({ id: 'x', path: 'x', cwd: '', title: '', named: false, createdAt: 0, updatedAt: noon - 5 * 60_000, messageCount: 1 }, { now: noon, lang: 'zh-CN', since: noon - 30_000, live: true })
    assert.equal(meta.elapsed, '<1m', '运行中显示本轮已运行时长')
    assert.equal(meta.age, 'hot', '运行或等待中的会话总在最醒目档')
    assert.equal(meta.ago, '5m')
    assert.equal(meta.note, undefined, '不同名时不显示辨识行')

    const grp = (key, label, cwd) => ({ key, slot: key, label, cwd, current: false, list: [] })
    const hints = model.segmentPathHints([
      grp('a', 'Inkstone', 'E:\\pi-desktop'),
      grp('b', 'Inkstone', 'E:\\pi-desktop-worktrees\\yan-auto-20261029-opus'),
      grp('c', 'worktree', 'C:\\Temp\\sub-1a2b\\worktree'),
      grp('d', 'worktree', 'C:\\Temp\\sub-9f8e\\worktree'),
      grp('e', 'Notes', 'D:\\notes\\reading'),
      grp('pinned', 'Inkstone', '')
    ])
    assert.equal(hints.get('a'), 'pi-desktop', '同名项目给出最短可区分的路径尾')
    assert.equal(hints.get('b'), 'yan-auto-20261029-opus')
    assert.equal(hints.get('c'), 'sub-1a2b', '路径尾与项目名相同时只显示能区分的上一级')
    assert.equal(hints.get('d'), 'sub-9f8e')
    assert.equal(hints.has('e'), false, '不同名且未改名时不加提示')
    assert.equal(model.segmentPathHints([grp('e', 'Notes', 'D:\\notes\\reading')], { renamed: true }).get('e'), 'D:\\notes\\reading', '改过名的项目可选显示路径')
    assert.equal(model.segmentPathHints([grp('a', 'X', 'E:\\a\\yan-subagent-sub-1a2b'), grp('b', 'X', 'E:\\b\\other')], { clip: true }).get('a'), '\u2026agent-sub-1a2b', '平铺行内的提示保留末尾、过长从前面截断')

    const tally = model.tallyAttention([
      { path: 'p1', status: 'running' },
      { path: 'p2', status: 'awaiting' },
      { path: 'p3', status: 'unread' },
      { path: 'p4', status: 'error' },
      { path: 'p1', status: 'running' },
      { path: 'p5', status: 'running' }
    ])
    assert.deepEqual(tally, { running: ['p1', 'p5'], awaiting: ['p2'], unread: ['p3'] }, '按显示顺序汇总，重复路径只算一次，失败不计入待处理')
    assert.equal(model.nextAttentionPath(tally.running, null), 'p1')
    assert.equal(model.nextAttentionPath(tally.running, 'p1'), 'p5')
    assert.equal(model.nextAttentionPath(tally.running, 'p5'), 'p1', '跳到最后一个后回到第一个')
    assert.equal(model.nextAttentionPath([], null), null)

    const shell = await readFile('src/renderer/src/app/ShellV3.tsx', 'utf8')
    assert.match(shell, /const drawerOpen = sidebarCompact && sidebarOpen/, '抽屉状态只在窄屏且左栏打开时成立')
    assert.match(shell, /<main className="v3-main" inert=\{drawerOpen\}>/, '抽屉打开时主界面退出交互')
    assert.match(shell, /<FocusScope contain=\{drawerOpen\}>\s*<Sidebar [^>]*\/>\s*<\/FocusScope>/, '抽屉打开时 Tab 约束在左栏内')
    assert.match(shell, /<div className="v3-scrim" onClick=\{\(\) => useUiV3\.getState\(\)\.setSidebarOpen\(false\)\}/, '点击遮罩仍关闭抽屉')
    assert.match(shell, /else if \(sidebarCompact && ui\.sidebarOpen\) ui\.setSidebarOpen\(false\)/, 'Esc 仍关闭抽屉')
    assert.match(shell, /if \(drawerOpen\) \{\s*document\.querySelector<HTMLElement>\('\.v3-side'\)/, '打开抽屉时焦点移进左栏')
    assert.match(shell, /\[data-testid="v3-rail-toggle"\]'\)\?\.focus/, '关闭抽屉后焦点回到顶栏左栏开关')

    console.log('sidebar-shell: 通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
