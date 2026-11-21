import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const {
    createPendingQueueSelector, buildQueueRows, pendingSendsForView, selectComposerThinking, currentThinkingLevels,
    resolveCollapsedFolderDot, liveSubagentSignature, liveJobSignature, backgroundSinceOf, selectSidebarRuns,
    sameSidebarSessionRow, memoByReference, shallow
  } = await compile(null, {
    stdin: { resolveDir: process.cwd(), contents: `
      export { createPendingQueueSelector, buildQueueRows } from './src/renderer/src/t3/adapters/composer-queue'
      export { currentThinkingLevels, pendingSendsForView } from './src/renderer/src/state/store'
      export { selectComposerThinking } from './src/renderer/src/t3/adapters/composer-thinking'
      export { resolveCollapsedFolderDot } from './src/renderer/src/t3/adapters/sidebar/status'
      export { liveSubagentSignature, liveJobSignature, backgroundSinceOf, selectSidebarRuns } from './src/renderer/src/t3/adapters/sidebar/threads'
      export { sameSidebarSessionRow } from './src/renderer/src/t3/shell/SidebarSessionRow'
      export { memoByReference } from './src/renderer/src/t3/lib/memoByReference'
      export { shallow } from 'zustand/shallow'
    ` },
    tsconfig: 'tsconfig.web.json',
    loader: { '.css': 'empty' },
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' }
  })

  let subagentReads = 0
  let jobReads = 0
  const subagents = [{ parentSessionId: 'a', startedAt: 50, get status() { subagentReads++; return 'running' } }]
  const jobs = [{ startedAt: 20, owners: ['C:\\work\\b.jsonl'], get state() { jobReads++; return 'running' } }]
  const subagentSignature = liveSubagentSignature(subagents)
  const jobSignature = liveJobSignature(jobs)
  const initialReads = [subagentReads, jobReads]
  for (let i = 0; i < 500; i++) {
    liveSubagentSignature(subagents)
    liveJobSignature(jobs)
  }
  ok(initialReads.every((n) => n > 0) && subagentReads === initialReads[0] && jobReads === initialReads[1], '500 次无关推送不再扫描未变的子代理与终端任务')
  const combined = backgroundSinceOf([{ id: 'b', path: 'c:/work/b.jsonl' }], subagentSignature, jobSignature)
  ok(combined.get('a') === 50 && combined.get('b') === 20, '后台任务仍按会话及路径归属')
  ok(liveSubagentSignature([{ ...subagents[0], output: 'new' }]) === subagentSignature, '子代理输出不改变侧栏签名')
  ok(liveSubagentSignature([{ ...subagents[0], status: 'completed' }]) === '' && liveJobSignature([{ ...jobs[0], state: 'completed' }]) === '', '后台完成仍更新侧栏签名')
  const run = { kind: 'session', runId: 'r', sessionId: 'a', startedAt: 50, phase: { kind: 'running' } }
  const runs = selectSidebarRuns([run])
  ok(selectSidebarRuns([{ ...run, updatedAt: 200, phase: { kind: 'running', progress: 'new' } }]) === runs, '主运行进度推送维持侧栏运行引用')
  ok(selectSidebarRuns([{ ...run, phase: { kind: 'done', at: 220, seen: false } }]) !== runs, '主运行结束改变侧栏运行引用')

  let derivations = 0
  const deriveRow = memoByReference((thread) => { derivations++; return { title: thread.title } })
  const thread = { title: 'A' }
  const cached = deriveRow(thread)
  for (let i = 0; i < 500; i++) deriveRow(thread)
  ok(deriveRow(thread) === cached && derivations === 1, '同一会话行派生可跨拖拽、菜单和更名渲染复用')
  ok(deriveRow({ ...thread, title: 'B' }).title === 'B' && derivations === 2, '更换输入引用时重新派生会话行')
  const handler = () => {}
  const row = { id: 'a', archived: false, snoozedUntil: null, renameValue: null, view: { title: 'A', sessionPath: 'A.jsonl', project: { projectId: 'p', displayName: 'P' }, diff: null }, sortable: { setNodeRef: handler, listeners: { onPointerDown: handler }, transform: { x: 0, y: 0 } }, onMenu: handler }
  const nextRow = { ...row, view: { ...row.view, project: { ...row.view.project } }, sortable: { ...row.sortable, transform: { ...row.sortable.transform } } }
  ok(sameSidebarSessionRow(row, nextRow), '相同显示与拖拽字段的新对象不击穿行 memo')
  for (const [label, patch] of [
    ['选中行', { isActive: true }], ['重命名', { renameValue: 'B' }], ['归档', { archived: true }],
    ['休眠', { snoozedUntil: '2026-11-22T00:00:00.000Z' }], ['拖拽位置', { sortable: { ...row.sortable, transform: { x: 0, y: 20 } } }],
    ['拖拽绑定', { sortable: { ...row.sortable, listeners: undefined } }], ['菜单回调', { onMenu: () => {} }],
    ['标题', { view: { ...row.view, title: 'B' } }], ['会话路径', { view: { ...row.view, sessionPath: 'B.jsonl' } }],
    ['项目显示名', { view: { ...row.view, project: { ...row.view.project, displayName: 'Q' } } }]
  ]) ok(!sameSidebarSessionRow(row, { ...row, ...patch }), `${label}变化不会被行 memo 吞掉`)

  const working = { runtime: { status: 'running' }, snoozedUntil: null }
  const unread = { runtime: null, snoozedUntil: null, unread: true }
  const failed = { runtime: { status: 'failed' }, snoozedUntil: null }
  const waiting = { runtime: { status: 'waiting' }, snoozedUntil: null }
  ok(resolveCollapsedFolderDot([], 0) === null && resolveCollapsedFolderDot([working], 0) === 'working', '空项目无点、运行项目有点')
  ok(resolveCollapsedFolderDot([unread, working], 0) === 'unread' && resolveCollapsedFolderDot([unread, failed], 0) === 'failed', '未读优先于运行、失败优先于未读')
  ok(resolveCollapsedFolderDot([failed, waiting], 0) === 'attention', '待处理状态优先于失败')

  const a = { id: 'a', sessionId: 'a', text: 'A' }
  const b = { id: 'b', sessionId: 'b', text: 'B' }
  const blank = { id: 'blank', sessionId: null, ownerKey: 'run:r', text: 'blank' }
  const state = { pendingSends: [a, b, blank], peekedSessionId: null, peekedPath: null, session: { sessionId: 'a' }, activeRunnerId: 'r' }
  const selectQueue = createPendingQueueSelector()
  const pending = selectQueue(state)
  const queue = { steering: [], followUp: [] }
  let rowBuilds = 0
  const rowsOf = memoByReference((items) => { rowBuilds++; return buildQueueRows(queue, items) })
  for (let i = 0; i < 500; i++) rowsOf(selectQueue({ ...state, session: { ...state.session, messageCount: i } }))
  ok(pending[0] === a && rowBuilds === 1, '500 次会话快照变化不重建队列行')
  ok(selectQueue({ ...state, pendingSends: [a, { ...b, text: 'unrelated' }, blank] }) === pending, '其他会话改队列不改变当前队列引用')
  for (const [label, patch] of [
    ['当前会话', {}], ['预览其他会话', { peekedSessionId: 'b', peekedPath: 'B.jsonl' }],
    ['只知道预览路径', { peekedPath: 'unknown.jsonl' }], ['历史 conversationId', { session: { conversationId: 'b' } }],
    ['空会话运行实例', { session: null }], ['切换空会话运行实例', { session: null, activeRunnerId: 'other' }]
  ]) {
    const snapshot = { ...state, ...patch }
    ok(shallow(selectQueue(snapshot), pendingSendsForView(snapshot)), `${label}的队列作用域保持不变`)
  }
  ok(selectQueue({ ...state, pendingSends: [{ ...a, text: 'updated' }, b, blank] })[0]?.text === 'updated', '当前队列编辑仍即时更新')

  const thinking = { session: { sessionId: 'a', model: { provider: 'local' }, thinkingLevel: 'low' }, thinkingLevels: ['off', 'low'] }
  const thinkingSnapshot = selectComposerThinking(thinking)
  ok(shallow(thinkingSnapshot, selectComposerThinking({ session: { ...thinking.session, messageCount: 100, compaction: { id: 'queued' } } })), '消息计数与无关工具状态不影响思考控件投影')
  ok(!shallow(thinkingSnapshot, selectComposerThinking({ session: { ...thinking.session, isStreaming: true } })), '流式开始保留忙碌边界')
  ok(!shallow(thinkingSnapshot, selectComposerThinking({ session: { ...thinking.session, thinkingLevel: 'high' } })), '思考档变化仍更新控件')
  const acp = { session: { ...thinking.session, model: { provider: 'antigravity' }, isAgentRunning: true } }
  ok(selectComposerThinking(acp).busy && shallow(currentThinkingLevels(acp), currentThinkingLevels(acp)), 'Antigravity 工具运行仍禁用切换，未知档位按内容相等')
})
